/* ═══════════════════════════════════════════════════════════════════════
   Submit app.

   Flow: pick a photo → read EXIF → place a pin → resize on-device → save to
   the local queue. Publishing to GitHub is a separate, optional step, so the
   whole thing is usable before the repo exists.
   ═══════════════════════════════════════════════════════════════════ */

import { putDraft, allDrafts, deleteDraft, countDrafts } from '../assets/store.js';

const MAX_EDGE = 1600;        // long edge of the published photo
const THUMB_EDGE = 400;
const QUALITY = 0.82;
const THUMB_QUALITY = 0.78;
const LONDON = [51.5074, -0.1278];

const $ = s => document.querySelector(s);

const state = {
  file: null,
  full: null,        // resized Blob
  thumb: null,       // Blob
  lat: null,
  lng: null,
  locSource: null,   // 'exif' | 'device' | 'manual'
  boroughs: null,
  flavours: [],
  map: null,
  marker: null,
};

// ─────────────────────────────────────────────────────────────── settings

const SETTINGS_KEY = 'buzz.settings';

const loadSettings = () => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
};
const saveSettings = s => localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

let settings = loadSettings();

// ────────────────────────────────────────────────────────────────── boot

(async function init() {
  const [boroughs, flavours, config] = await Promise.all([
    fetch('../data/boroughs.geojson').then(r => r.json()),
    fetch('../data/flavours.json').then(r => r.json()).catch(() => []),
    fetch('config.json').then(r => r.json()).catch(() => ({})),
  ]);
  state.boroughs = boroughs;
  state.flavours = flavours;
  // Shipped with the site so a new submitter only ever types a name and a
  // passcode — they never need to know the endpoint exists.
  state.defaultEndpoint = config.endpoint || '';

  fillBoroughSelect();
  resetFlavourRows();
  initSearch();
  bindUI();
  hydrateSettings();
  await refreshQueueCount();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

// ───────────────────────────────────────────────────────────── geometry
// Same ray-casting used to seed the data, so a pin resolves to the same
// borough here as it does anywhere else in the project.

function* rings(geom) {
  if (geom.type === 'Polygon') yield geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') for (const p of geom.coordinates) yield p[0];
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function boroughAt(lng, lat) {
  for (const f of state.boroughs.features) {
    for (const ring of rings(f.geometry)) {
      if (pointInRing(lng, lat, ring)) return f.properties.name;
    }
  }
  return '';
}

// ────────────────────────────────────────────────────────────── selects

function fillBoroughSelect() {
  const names = state.boroughs.features.map(f => f.properties.name).sort();
  $('#borough').innerHTML =
    `<option value="">— outside London / unknown —</option>` +
    names.map(n => `<option>${n}</option>`).join('');
}

/* One row per buzzball in the photo. Rows are built in JS because the count
   is dynamic; each holds a select plus a text box that appears only when
   "add a new flavour" is chosen. */

function optionsHtml() {
  return state.flavours.map(f => `<option>${esc(f)}</option>`).join('') +
         `<option value="__new">+ Add a new flavour…</option>`;
}

function addFlavourRow(value) {
  const row = document.createElement('div');
  row.className = 'frow';
  row.innerHTML = `
    <div class="frow__main">
      <select class="frow__select">${optionsHtml()}</select>
      <button class="frow__del" type="button" aria-label="Remove this buzzball">✕</button>
    </div>
    <input class="frow__new" type="text" placeholder="Name the new flavour"
           autocapitalize="words" hidden>`;

  const select = row.querySelector('.frow__select');
  const newInput = row.querySelector('.frow__new');
  if (value && state.flavours.includes(value)) select.value = value;

  select.addEventListener('change', () => {
    const isNew = select.value === '__new';
    newInput.hidden = !isNew;
    if (isNew) newInput.focus();
  });
  row.querySelector('.frow__del').addEventListener('click', () => {
    row.remove();
    syncFlavourRows();
  });

  $('#flavourList').appendChild(row);
  syncFlavourRows();
  return row;
}

/** Hide the remove button when only one row is left — you always need one. */
function syncFlavourRows() {
  const rows = [...$('#flavourList').children];
  rows.forEach(r => r.classList.toggle('frow--single', rows.length === 1));
}

function resetFlavourRows() {
  $('#flavourList').replaceChildren();
  addFlavourRow();
}

/** Read every row, resolving "add new" boxes. Returns null on a bad row. */
function readFlavours() {
  const out = [];
  for (const row of $('#flavourList').children) {
    const select = row.querySelector('.frow__select');
    let v = select.value;
    if (v === '__new') {
      v = row.querySelector('.frow__new').value.trim();
      if (!v) return null;
      if (!state.flavours.includes(v)) state.flavours.push(v);
    }
    out.push(v);
  }
  return out;
}

// ────────────────────────────────────────────────────────── place search
//
// Photon, not Nominatim. Nominatim's usage policy explicitly forbids
// client-side autocomplete ("you must not implement such a service on the
// client side using the API"); Photon is built for typeahead and only asks
// that you be fair. So: debounced, minimum 3 characters, one in-flight
// request at a time, and results confined to a Greater London box.

const PHOTON = 'https://photon.komoot.io/api/';
const LONDON_BBOX = '-0.51,51.28,0.33,51.70';   // minLon,minLat,maxLon,maxLat
const SEARCH_DEBOUNCE = 450;

let searchTimer, searchAbort;

function initSearch() {
  const input = $('#placeSearch');

  input.addEventListener('input', () => {
    $('#searchClear').hidden = !input.value;
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { hideResults(); return; }
    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE);
  });

  // Enter picks the first result rather than submitting anything
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('#searchResults').querySelector('button')?.click();
  });

  $('#searchClear').addEventListener('click', () => {
    input.value = '';
    $('#searchClear').hidden = true;
    hideResults();
    input.focus();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search')) hideResults();
  });
}

function hideResults() {
  $('#searchResults').hidden = true;
  $('#searchStatus').hidden = true;
  $('#placeSearch').setAttribute('aria-expanded', 'false');
}

const status = msg => {
  $('#searchStatus').textContent = msg;
  $('#searchStatus').hidden = false;
};

async function runSearch(q) {
  searchAbort?.abort();                       // drop any stale request
  searchAbort = new AbortController();

  status('Searching…');
  try {
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=6&lang=en` +
                `&bbox=${LONDON_BBOX}&lat=51.5074&lon=-0.1278`;
    const r = await fetch(url, { signal: searchAbort.signal });
    if (!r.ok) throw new Error(`search returned ${r.status}`);
    const data = await r.json();
    renderResults(data.features || []);
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#searchResults').hidden = true;
    status('Search is unavailable — drag the pin instead.');
  }
}

/** Photon splits an address across properties; assemble something readable
 *  without repeating the name in the subtitle. */
function describe(props) {
  const main = props.name
    || [props.housenumber, props.street].filter(Boolean).join(' ')
    || props.city
    || 'Unnamed place';
  const sub = [...new Set([
    props.name ? [props.housenumber, props.street].filter(Boolean).join(' ') : null,
    props.district, props.city, props.postcode,
  ].filter(Boolean))].filter(s => s !== main).join(', ');
  return { main, sub };
}

function renderResults(features) {
  const list = $('#searchResults');
  if (!features.length) {
    list.hidden = true;
    status('Nothing found. Try a postcode, or drag the pin.');
    return;
  }

  $('#searchStatus').hidden = true;
  list.replaceChildren(...features.map(f => {
    const [lng, lat] = f.geometry.coordinates;
    const { main, sub } = describe(f.properties);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `<span class="search__main">${esc(main)}</span>` +
                    (sub ? `<span class="search__sub">${esc(sub)}</span>` : '');
    btn.addEventListener('click', () => {
      setLocation(lat, lng, 'search', true);
      $('#placeSearch').value = main;
      $('#searchClear').hidden = false;
      hideResults();
      $('#locHint').textContent = 'Pinned from search. Drag the pin to fine-tune it.';
    });
    li.appendChild(btn);
    return li;
  }));
  list.hidden = false;
  $('#placeSearch').setAttribute('aria-expanded', 'true');
}

// ───────────────────────────────────────────────────────────────── map

function ensureMap() {
  if (state.map) { state.map.invalidateSize(); return; }

  const map = L.map('map', { center: LONDON, zoom: 11, zoomControl: true });
  state.map = map;

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(map);

  state.marker = L.marker(LONDON, {
    draggable: true,
    icon: L.divIcon({ html: '<div class="pin-drop"></div>', className: '', iconSize: [18, 18] }),
  }).addTo(map);

  state.marker.on('dragend', () => {
    const { lat, lng } = state.marker.getLatLng();
    setLocation(lat, lng, 'manual');
  });
  map.on('click', e => {
    state.marker.setLatLng(e.latlng);
    setLocation(e.latlng.lat, e.latlng.lng, 'manual');
  });

  // Leaflet measures its container once, at construction. The form is still
  // display:none at that point, so the map would render into a zero-height box
  // and only paint a strip of tiles. Re-measure whenever the box changes size.
  new ResizeObserver(() => map.invalidateSize()).observe($('#map'));
}

function setLocation(lat, lng, source, recentre = false) {
  state.lat = +lat.toFixed(6);
  state.lng = +lng.toFixed(6);
  state.locSource = source;

  if (state.marker) state.marker.setLatLng([lat, lng]);
  if (recentre && state.map) state.map.setView([lat, lng], 16);

  const chip = $('#locSource');
  chip.textContent = {
    exif: 'from photo', device: 'your location',
    search: 'from search', manual: 'pin placed',
  }[source] || '—';
  chip.dataset.kind = source;

  $('#borough').value = boroughAt(state.lng, state.lat);
}

// ───────────────────────────────────────────────────────── photo + EXIF

async function onFile(file) {
  if (!file) return;
  state.file = file;
  toast('Reading photo…');

  // EXIF must be read from the original — the canvas resize below drops it.
  let exif = null, gps = null;
  try { exif = await exifr.parse(file, { tiff: true, exif: true }); } catch {}
  try { gps = await exifr.gps(file); } catch {}

  // date
  const dt = exif?.DateTimeOriginal || exif?.CreateDate || new Date(file.lastModified);
  $('#spottedAt').value = toLocalInput(dt);
  $('#dateHint').textContent = exif?.DateTimeOriginal
    ? 'Taken from the photo.'
    : 'The photo had no date — this is the file date. Correct it if needed.';

  // Reveal the form before building the map so the container has a real size.
  $('#form').hidden = false;
  ensureMap();

  // location
  if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
    setLocation(gps.latitude, gps.longitude, 'exif', true);
    $('#locHint').textContent = 'Read from the photo. Drag the pin if it is off.';
  } else {
    $('#locHint').textContent =
      'This photo has no location — iPhones strip it when you pick from Safari. ' +
      'Drag the pin to where you found it, or use your current location.';
    navigator.geolocation?.getCurrentPosition(
      p => { if (!state.locSource) setLocation(p.coords.latitude, p.coords.longitude, 'device', true); },
      () => {}, { enableHighAccuracy: true, timeout: 8000 });
  }

  // resize
  photoState('Preparing photo…');
  let decoded;
  try {
    decoded = await decode(file);
    state.full = await resize(decoded, MAX_EDGE, QUALITY);
    state.thumb = await resize(decoded, THUMB_EDGE, THUMB_QUALITY);
  } catch (e) {
    photoState(`Couldn't process this photo — ${e.message}. Try a different one, ` +
               `or on iPhone use Settings ▸ Camera ▸ Formats ▸ Most Compatible.`, 'bad');
    return;
  } finally {
    decoded?.release();
  }

  $('#preview').src = URL.createObjectURL(state.full);
  $('#preview').hidden = false;
  $('#pickerInner').hidden = true;
  $('#btnClearPhoto').hidden = false;
  setPhotoReady(true);
  photoState(`Ready — ${(state.full.size / 1024).toFixed(0)} KB`);
}

/** Save is only live once there is actually a resized image to save. */
function setPhotoReady(ready) {
  $('#btnSave').disabled = !ready;
}

function photoState(msg, kind) {
  const el = $('#photoState');
  el.textContent = msg;
  el.dataset.kind = kind || '';
  el.hidden = !msg;
}

/**
 * Decode to something drawImage accepts.
 *
 * createImageBitmap is preferred because it applies EXIF orientation, but
 * Safari has shipped builds that reject the options bag, and iPhones hand over
 * HEIC when the library isn't set to Most Compatible. An <img> decodes anything
 * the OS can — including HEIC — and Safari orients it automatically, so it is
 * the fallback rather than a hard failure.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    for (const opts of [{ imageOrientation: 'from-image' }, undefined]) {
      try {
        const bm = await createImageBitmap(file, opts);
        return { src: bm, width: bm.width, height: bm.height, release: () => bm.close?.() };
      } catch { /* try the next strategy */ }
    }
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('this format is not supported'));
      img.src = url;
    });
    if (!img.naturalWidth) throw new Error('the image had no dimensions');
    return {
      src: img, width: img.naturalWidth, height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Draw to a canvas at the target long edge and re-encode as JPEG.
 *  Side effect worth knowing: this strips every scrap of metadata, so the
 *  published file carries no GPS. We keep the coordinates in the JSON. */
function resize(decoded, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
  const w = Math.max(1, Math.round(decoded.width * scale));
  const h = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(decoded.src, 0, 0, w, h);
  return canvasToJpeg(canvas, quality);
}

/**
 * iOS Safari has shipped versions where canvas.toBlob() never invokes its
 * callback. A bare `new Promise(... toBlob ...)` then hangs forever with no
 * error at all — the form sits open and Save does nothing, which is exactly
 * the symptom this was reported with. So: race it against a timeout and fall
 * back to the synchronous toDataURL path.
 *
 * The timeout is short on purpose. Encoding a <=1600px canvas is a few tens of
 * milliseconds even on an old phone, so a second is already generous — and two
 * resizes run per photo, so every extra second here is two seconds of the user
 * staring at "Preparing photo…".
 */
const ENCODE_TIMEOUT_MS = 1200;

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = v => { if (!settled) { settled = true; resolve(v); } };
    const no = e => { if (!settled) { settled = true; reject(e); } };

    const fallback = setTimeout(() => {
      try {
        const data = canvas.toDataURL('image/jpeg', quality);
        const bin = atob(data.slice(data.indexOf(',') + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        ok(new Blob([bytes], { type: 'image/jpeg' }));
      } catch {
        no(new Error('the browser could not encode it'));
      }
    }, ENCODE_TIMEOUT_MS);

    try {
      canvas.toBlob(blob => {
        clearTimeout(fallback);
        blob ? ok(blob) : no(new Error('the encoder returned nothing'));
      }, 'image/jpeg', quality);
    } catch (e) {
      clearTimeout(fallback);
      no(e);
    }
  });
}

const pad = n => String(n).padStart(2, '0');
const toLocalInput = d => {
  const t = new Date(d);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

function clearPhoto() {
  state.file = state.full = state.thumb = null;
  state.lat = state.lng = state.locSource = null;
  $('#file').value = '';
  $('#preview').hidden = true;
  $('#preview').removeAttribute('src');
  $('#pickerInner').hidden = false;
  $('#btnClearPhoto').hidden = true;
  $('#form').hidden = true;
  $('#caption').value = '';
  setPhotoReady(false);
  photoState('');
  resetFlavourRows();
}

// ──────────────────────────────────────────────────────────── save draft

/** A thrown value is not necessarily an Error. IndexedDB in particular rejects
 *  with null in some failure modes, and reading `.name` off that throws a
 *  second error that hides the first — which is exactly what happened on iOS. */
function describeError(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e == null) return 'unknown error (no detail from the browser)';
  if (typeof e === 'object') return e.message || e.name || JSON.stringify(e).slice(0, 120);
  return String(e);
}

async function saveDraft() {
  try {
    await doSave();
  } catch (e) {
    // Without this the promise rejected silently and the button appeared dead:
    // no toast, no queue entry, no reset. Never fail invisibly again.
    console.error('save failed', e);
    const what = describeError(e);
    photoState(`Couldn't save — ${what}`, 'bad');
    toast(`Save failed: ${what}`, 'bad');
  }
}

async function doSave() {
  if (!state.full) return toast('The photo is still being prepared — one moment', 'bad');
  if (state.lat == null) return toast('Place the pin where you found it', 'bad');

  const flavours = readFlavours();
  if (!flavours) return toast('Name the new flavour', 'bad');
  if (!flavours.length) return toast('Add at least one buzzball', 'bad');

  const spotter = (settings.spotter || '').trim();
  if (!spotter) {
    showPanel('settings');
    return toast('Add your name in settings first', 'bad');
  }

  const when = $('#spottedAt').value ? new Date($('#spottedAt').value) : new Date();
  const id = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-` +
             Math.random().toString(36).slice(2, 6);

  const meta = {
    id,
    file: `photos/${id}.jpg`,
    thumb: `photos/thumbs/${id}.jpg`,
    lat: state.lat,
    lng: state.lng,
    locationSource: state.locSource,
    borough: $('#borough').value,
    flavours,
    caption: $('#caption').value.trim(),
    spottedAt: when.toISOString(),
    spotter,
    addedAt: new Date().toISOString(),
    publishToInstagram: false,
    instagramPostId: null,
  };

  await putDraft({ id, meta, full: state.full, thumb: state.thumb });
  await refreshQueueCount();
  clearPhoto();
  resetFlavourRows();
  toast('Saved. It will show on the site on this phone.');
}

// ──────────────────────────────────────────────────────────────── queue

async function renderQueue() {
  const rows = await allDrafts();
  const list = $('#queueList');

  if (!rows.length) {
    list.innerHTML = '';
    $('#queueIntro').textContent = 'Nothing waiting. Sightings you save appear here.';
    $('#queueActions').hidden = true;
    return;
  }

  $('#queueIntro').textContent =
    `${rows.length} sighting${rows.length > 1 ? 's' : ''} saved on this phone. ` +
    `They already show on the site here; publishing makes them live for everyone.`;

  list.innerHTML = rows.map(d => `
    <li class="qitem" data-id="${d.id}">
      <img src="${URL.createObjectURL(d.thumb)}" alt="">
      <div class="qitem__main">
        <div class="qitem__flavour">${esc((d.meta.flavours || [d.meta.flavour]).join(' + '))}</div>
        <div class="qitem__where">${esc(d.meta.borough || 'Unknown')} · ${
          new Date(d.meta.spottedAt).toLocaleDateString('en-GB',
            { day: 'numeric', month: 'short' })}</div>
        <div class="qitem__state" data-id="${d.id}"></div>
      </div>
      <button class="qdel" type="button" data-del="${d.id}" aria-label="Delete">✕</button>
    </li>`).join('');

  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    await deleteDraft(b.dataset.del);
    await refreshQueueCount();
    renderQueue();
  }));

  const ready = canPublish();
  $('#queueActions').hidden = false;
  $('#btnPublish').disabled = !ready;
  $('#publishHint').textContent = ready
    ? 'Publishes everything above in one go.'
    : endpoint()
      ? 'Add the passcode in settings to publish.'
      : 'No submission endpoint configured yet.';
}

async function refreshQueueCount() {
  const n = await countDrafts();
  const el = $('#queueCount');
  el.textContent = n;
  el.dataset.zero = n === 0 ? '1' : '0';
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─────────────────────────────────────────────────────────────── publish
//
// The client no longer talks to GitHub. It POSTs to a small Cloudflare Worker
// that holds the GitHub token server-side, so nothing on any phone can do more
// than add a sighting. The passcode is the only credential a submitter needs,
// and rotating it is one command — no reinstalling anything.

const blobToBase64 = blob => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

const endpoint = () => (settings.endpoint || state.defaultEndpoint || '').trim();
const canPublish = () => Boolean(settings.passcode && endpoint());

async function postSightings(sightings) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: settings.passcode, sightings }),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(data.error || `Endpoint returned ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

/** The whole queue goes up in one request, which the Worker turns into a
 *  single commit — so the site never references an image that isn't pushed. */
async function publishAll() {
  const drafts = await allDrafts();
  if (!drafts.length) return;

  $('#btnPublish').disabled = true;
  $('#publishHint').textContent = `Publishing ${drafts.length}…`;

  try {
    // Explicit payload rather than spreading meta: meta.file/meta.thumb are
    // repo *paths* while the wire fields are base64 *images*, and relying on
    // one to silently overwrite the other is asking for trouble. The Worker
    // rebuilds the paths from the id anyway, so they're not worth sending.
    const sightings = [];
    for (const d of drafts) {
      const [full, thumb] = await Promise.all([blobToBase64(d.full), blobToBase64(d.thumb)]);
      const m = d.meta;
      sightings.push({
        id: m.id,
        lat: m.lat, lng: m.lng, locationSource: m.locationSource,
        borough: m.borough, flavours: m.flavours, caption: m.caption,
        spottedAt: m.spottedAt, spotter: m.spotter,
        full, thumb,
      });
    }

    const res = await postSightings(sightings);

    for (const d of drafts) await deleteDraft(d.id);
    await refreshQueueCount();
    renderQueue();
    toast(`Published ${res.published ?? drafts.length}. Live in about a minute.`);

  } catch (e) {
    $('#btnPublish').disabled = false;
    $('#publishHint').textContent = e.status === 401
      ? 'That passcode was rejected. Check it in settings.'
      : e.message;
    toast('Publish failed — see the queue for why', 'bad');
  }
}

/** Sends the passcode with an empty batch. The Worker checks the passcode
 *  before it looks at the payload, so 400 "nothing to publish" means the
 *  passcode was accepted and 401 means it wasn't. */
async function testConnection() {
  readSettingsFromForm();
  const out = $('#testResult');

  if (!endpoint()) { out.textContent = 'No endpoint set yet.'; return; }
  if (!settings.passcode) { out.textContent = 'Enter the passcode first.'; return; }

  out.textContent = 'Checking…';
  try {
    await postSightings([]);
    out.textContent = '✓ Connected.';
  } catch (e) {
    if (e.status === 400) out.textContent = '✓ Passcode accepted — ready to publish.';
    else if (e.status === 401) out.textContent = '✗ Wrong passcode.';
    else out.textContent = '✗ ' + e.message;
  }
}

// ───────────────────────────────────────────────────────────────── panels

function showPanel(which) {
  $('#panelCompose').hidden = which !== 'compose';
  $('#panelQueue').hidden = which !== 'queue';
  $('#panelSettings').hidden = which !== 'settings';
  if (which === 'queue') renderQueue();
  window.scrollTo(0, 0);
}

function hydrateSettings() {
  $('#spotter').value = settings.spotter || '';
  $('#passcode').value = settings.passcode || '';
  $('#endpoint').value = settings.endpoint || '';
  $('#endpoint').placeholder = state.defaultEndpoint || 'not configured yet';
}

function readSettingsFromForm() {
  settings = {
    spotter: $('#spotter').value.trim(),
    passcode: $('#passcode').value.trim(),
    endpoint: $('#endpoint').value.trim(),
  };
  saveSettings(settings);
}

let toastTimer;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind || 'ok';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 5000 : 2600);
}

// ───────────────────────────────────────────────────────────── diagnostics
//
// Exists because "nothing happens" is impossible to debug remotely. Each step
// of the pipeline is exercised for real and reported. Deliberately contains no
// photo data and no passcode.

async function runDiagnostics() {
  const out = $('#diagOut');
  out.hidden = false;
  out.textContent = 'Running…';
  const L = [];
  const line = (k, v) => L.push(`${k.padEnd(22)} ${v}`);

  line('user agent', navigator.userAgent);
  line('secure context', String(window.isSecureContext));
  line('screen', `${innerWidth}x${innerHeight} @${devicePixelRatio}`);

  // a real 2x2 JPEG to test the encode path end to end
  let testBlob = null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2);
    const t0 = Date.now();
    testBlob = await canvasToJpeg(c, 0.8);
    line('canvas -> jpeg', `ok, ${testBlob.size} bytes in ${Date.now() - t0}ms`);
  } catch (e) {
    line('canvas -> jpeg', `FAIL ${e.message}`);
  }

  line('createImageBitmap', typeof createImageBitmap === 'function' ? 'present' : 'MISSING');
  if (testBlob && typeof createImageBitmap === 'function') {
    for (const [label, opts] of [['with orientation', { imageOrientation: 'from-image' }], ['plain', undefined]]) {
      try {
        const bm = await createImageBitmap(testBlob, opts);
        line(`  ${label}`, `ok ${bm.width}x${bm.height}`);
        bm.close?.();
      } catch (e) { line(`  ${label}`, `FAIL ${e.name}: ${e.message}`); }
    }
  }

  // IndexedDB: open, write a Blob, read it back, delete
  try {
    const id = '__diag-' + Math.random().toString(36).slice(2, 8);
    const blob = testBlob || new Blob(['x']);
    await putDraft({ id, meta: { id, spottedAt: new Date().toISOString(), flavours: [], diag: true }, full: blob, thumb: blob });
    const rows = await allDrafts();
    const found = rows.find(r => r.id === id);
    line('indexeddb write', found
      ? `ok, ${found.full.size} bytes back as ${found.full.constructor.name}/${found.full.type}`
      : 'FAIL not found after write');
    await deleteDraft(id);
    line('indexeddb delete', 'ok');
  } catch (e) {
    line('indexeddb', `FAIL ${e.name}: ${e.message}`);
  }

  try {
    const est = await navigator.storage?.estimate?.();
    line('storage', est ? `${(est.usage / 1048576).toFixed(1)} / ${(est.quota / 1048576).toFixed(0)} MB` : 'estimate unavailable');
  } catch { line('storage', 'estimate failed'); }

  line('geolocation', navigator.geolocation ? 'present' : 'MISSING');
  line('service worker', 'serviceWorker' in navigator
    ? ((await navigator.serviceWorker.getRegistration()) ? 'registered' : 'not registered')
    : 'unsupported');
  line('spotter set', settings.spotter ? 'yes' : 'NO');
  line('passcode set', settings.passcode ? 'yes' : 'no');
  line('endpoint', endpoint() ? 'configured' : 'MISSING');
  line('photo in memory', state.full ? `${(state.full.size / 1024).toFixed(0)} KB` : 'none');
  line('queued drafts', String(await countDrafts()));

  out.textContent = L.join('\n');
}

function bindUI() {
  // Nothing should ever fail invisibly on a phone with no console.
  addEventListener('unhandledrejection', e => {
    console.error('unhandled rejection', e.reason);
    toast('Something failed: ' + describeError(e.reason), 'bad');
  });
  addEventListener('error', e => {
    if (e.message) toast('Error: ' + e.message, 'bad');
  });
  $('#btnDiag').addEventListener('click', () => runDiagnostics().catch(e =>
    { $('#diagOut').textContent = 'diagnostics crashed: ' + e.message; }));

  $('#file').addEventListener('change', e => onFile(e.target.files[0]));
  $('#btnClearPhoto').addEventListener('click', clearPhoto);
  $('#btnLocate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('This browser has no location access', 'bad');
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition(
      p => setLocation(p.coords.latitude, p.coords.longitude, 'device', true),
      err => toast('Could not get your location: ' + err.message, 'bad'),
      { enableHighAccuracy: true, timeout: 10000 });
  });
  $('#btnAddFlavour').addEventListener('click', () => addFlavourRow());
  $('#btnSave').addEventListener('click', saveDraft);
  $('#btnQueue').addEventListener('click', () => showPanel('queue'));
  $('#btnSettings').addEventListener('click', () => showPanel('settings'));
  $('#btnSaveSettings').addEventListener('click', () => {
    readSettingsFromForm();
    toast('Settings saved');
    showPanel('compose');
  });
  $('#btnTest').addEventListener('click', testConnection);
  $('#btnPublish').addEventListener('click', publishAll);
}
