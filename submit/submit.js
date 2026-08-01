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
  const [boroughs, flavours] = await Promise.all([
    fetch('../data/boroughs.geojson').then(r => r.json()),
    fetch('../data/flavours.json').then(r => r.json()).catch(() => []),
  ]);
  state.boroughs = boroughs;
  state.flavours = flavours;

  fillBoroughSelect();
  fillFlavourSelect();
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

function fillFlavourSelect(selected) {
  const list = state.flavours.slice();
  $('#flavour').innerHTML =
    list.map(f => `<option${f === selected ? ' selected' : ''}>${f}</option>`).join('') +
    `<option value="__new">+ Add a new flavour…</option>`;
  toggleNewFlavour();
}

const toggleNewFlavour = () => {
  const isNew = $('#flavour').value === '__new';
  $('#newFlavourWrap').hidden = !isNew;
  if (isNew) $('#newFlavour').focus();
};

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
  chip.textContent = { exif: 'from photo', device: 'your location', manual: 'pin placed' }[source] || '—';
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
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    state.full = await resize(bitmap, MAX_EDGE, QUALITY);
    state.thumb = await resize(bitmap, THUMB_EDGE, THUMB_QUALITY);
    bitmap.close?.();
  } catch (e) {
    toast('Could not read that image: ' + e.message, 'bad');
    return;
  }

  const url = URL.createObjectURL(state.full);
  $('#preview').src = url;
  $('#preview').hidden = false;
  $('#pickerInner').hidden = true;
  $('#btnClearPhoto').hidden = false;
  $('#form').hidden = false;

  toast(`Ready — ${(state.full.size / 1024).toFixed(0)} KB`);
}

/** Draw to a canvas at the target long edge and re-encode as JPEG.
 *  Side effect worth knowing: this strips every scrap of metadata, so the
 *  published file carries no GPS. We keep the coordinates in the JSON. */
function resize(bitmap, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((res, rej) =>
    canvas.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', quality));
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
}

// ──────────────────────────────────────────────────────────── save draft

async function saveDraft() {
  if (!state.full) return toast('Choose a photo first', 'bad');
  if (state.lat == null) return toast('Place the pin where you found it', 'bad');

  let flavour = $('#flavour').value;
  if (flavour === '__new') {
    flavour = $('#newFlavour').value.trim();
    if (!flavour) return toast('Name the new flavour', 'bad');
    if (!state.flavours.includes(flavour)) state.flavours.push(flavour);
  }

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
    flavour,
    caption: $('#caption').value.trim(),
    spottedAt: when.toISOString(),
    spotter,
    addedAt: new Date().toISOString(),
    publishToInstagram: false,
    instagramPostId: null,
  };

  await putDraft({ id, meta, full: state.full, thumb: state.thumb, newFlavour: flavour });
  await refreshQueueCount();
  clearPhoto();
  fillFlavourSelect();
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
        <div class="qitem__flavour">${esc(d.meta.flavour)}</div>
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

  const ready = settings.token && settings.owner && settings.repo;
  $('#queueActions').hidden = false;
  $('#btnPublish').disabled = !ready;
  $('#publishHint').textContent = ready
    ? `Commits everything to ${settings.owner}/${settings.repo} in one go.`
    : 'Add your GitHub details in settings to publish.';
}

async function refreshQueueCount() {
  const n = await countDrafts();
  const el = $('#queueCount');
  el.textContent = n;
  el.dataset.zero = n === 0 ? '1' : '0';
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─────────────────────────────────────────────────────── GitHub publish

const api = (path, opts = {}) => fetch(`https://api.github.com${path}`, {
  ...opts,
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${settings.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...opts.headers,
  },
}).then(async r => {
  if (!r.ok) {
    const body = await r.text();
    const err = new Error(`GitHub ${r.status}: ${body.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
});

const blobToBase64 = blob => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

/** Read a text file from the repo, or null if it isn't there yet. */
async function readRepoText(path) {
  const { owner, repo, branch } = settings;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch || 'main'}`;
  const r = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      Authorization: `Bearer ${settings.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} reading ${path}`);
  return r.text();
}

/**
 * Everything queued goes up as ONE commit: photos, thumbnails, the updated
 * photos.json and flavours.json together. Either the whole batch lands or
 * none of it does, so the site never references an image that isn't pushed.
 * If someone else pushed in the meantime the ref update is rejected and we
 * rebuild the commit on the new head rather than clobbering it.
 */
async function publishAll() {
  const drafts = await allDrafts();
  if (!drafts.length) return;

  const { owner, repo } = settings;
  const branch = settings.branch || 'main';
  const base = `/repos/${owner}/${repo}`;

  $('#btnPublish').disabled = true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      $('#publishHint').textContent = `Publishing ${drafts.length}…`;

      const ref = await api(`${base}/git/ref/heads/${branch}`);
      const headSha = ref.object.sha;
      const headCommit = await api(`${base}/git/commits/${headSha}`);

      const existing = JSON.parse((await readRepoText('data/photos.json')) || '[]');
      const knownFlavours = JSON.parse((await readRepoText('data/flavours.json')) || '[]');

      const tree = [];
      for (const d of drafts) {
        const [fullB64, thumbB64] = await Promise.all([
          blobToBase64(d.full), blobToBase64(d.thumb),
        ]);
        const [fullBlob, thumbBlob] = await Promise.all([
          api(`${base}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: fullB64, encoding: 'base64' }) }),
          api(`${base}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: thumbB64, encoding: 'base64' }) }),
        ]);
        tree.push({ path: d.meta.file, mode: '100644', type: 'blob', sha: fullBlob.sha });
        tree.push({ path: d.meta.thumb, mode: '100644', type: 'blob', sha: thumbBlob.sha });
      }

      // drop any ids already present, so a retry can't double-add
      const ids = new Set(drafts.map(d => d.id));
      const merged = [...drafts.map(d => d.meta), ...existing.filter(p => !ids.has(p.id))]
        .sort((a, b) => new Date(b.spottedAt) - new Date(a.spottedAt));
      tree.push({
        path: 'data/photos.json', mode: '100644', type: 'blob',
        content: JSON.stringify(merged, null, 2) + '\n',
      });

      const allFlavours = [...new Set([...knownFlavours, ...drafts.map(d => d.meta.flavour)])];
      if (allFlavours.length !== knownFlavours.length) {
        tree.push({
          path: 'data/flavours.json', mode: '100644', type: 'blob',
          content: JSON.stringify(allFlavours, null, 2) + '\n',
        });
      }

      const newTree = await api(`${base}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
      });

      const msg = drafts.length === 1
        ? `Add sighting: ${drafts[0].meta.flavour} in ${drafts[0].meta.borough || 'London'}`
        : `Add ${drafts.length} sightings`;

      const commit = await api(`${base}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: msg, tree: newTree.sha, parents: [headSha] }),
      });

      // no force: if head moved, this 422s and we rebuild on the new head
      await api(`${base}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });

      for (const d of drafts) await deleteDraft(d.id);
      await refreshQueueCount();
      renderQueue();
      toast(`Published ${drafts.length}. Live in about a minute.`);
      return;

    } catch (e) {
      const raced = e.status === 422 || e.status === 409;
      if (raced && attempt < 3) {
        $('#publishHint').textContent = 'Someone else pushed — retrying…';
        continue;
      }
      $('#btnPublish').disabled = false;
      $('#publishHint').textContent = e.message;
      toast('Publish failed — see the queue for why', 'bad');
      return;
    }
  }
}

async function testConnection() {
  readSettingsFromForm();
  const out = $('#testResult');
  if (!settings.token || !settings.owner || !settings.repo) {
    out.textContent = 'Fill in user, repository and token first.';
    return;
  }
  out.textContent = 'Checking…';
  try {
    const branch = settings.branch || 'main';
    const repo = await api(`/repos/${settings.owner}/${settings.repo}`);
    await api(`/repos/${settings.owner}/${settings.repo}/git/ref/heads/${branch}`);
    out.textContent = `✓ ${repo.full_name}, branch ${branch}${repo.permissions?.push === false ? ' — but the token cannot write' : ' — token can write'}`;
  } catch (e) {
    out.textContent = '✗ ' + e.message;
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
  $('#ghOwner').value = settings.owner || '';
  $('#ghRepo').value = settings.repo || '';
  $('#ghBranch').value = settings.branch || '';
  $('#ghToken').value = settings.token || '';
}

function readSettingsFromForm() {
  settings = {
    spotter: $('#spotter').value.trim(),
    owner: $('#ghOwner').value.trim(),
    repo: $('#ghRepo').value.trim(),
    branch: $('#ghBranch').value.trim() || 'main',
    token: $('#ghToken').value.trim(),
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

function bindUI() {
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
  $('#flavour').addEventListener('change', toggleNewFlavour);
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
