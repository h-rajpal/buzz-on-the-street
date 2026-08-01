/* ═══════════════════════════════════════════════════════════════════════
   Buzz on the Street — one page, no build step.
   Reads data/photos.json + data/boroughs.geojson and renders everything.
   ═══════════════════════════════════════════════════════════════════ */

import { draftsAsPhotos } from './store.js';

const LONDON = [51.5074, -0.1278];
const SEQ = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'];
const TOP_N = 8;        // rows shown before "Show all"
const GALLERY_N = 16;   // the scatter; each is placed by hand in style.css
                        // (mobile shows the first 8 — see the media query)

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const state = { photos: [], boroughs: null, map: null };

// ───────────────────────────────────────────────────────────── boot

(async function init() {
  const [photos, boroughs] = await Promise.all([
    fetch('data/photos.json').then(r => r.json()),
    fetch('data/boroughs.geojson').then(r => r.json()),
  ]);

  // Sightings saved in the submit app but not yet pushed to GitHub. They live
  // in IndexedDB on this device, so you can see a real photo on the map
  // seconds after taking it — no repo, no deploy, no wait.
  const drafts = await draftsAsPhotos();

  state.photos = [...drafts, ...photos].sort(
    (a, b) => new Date(b.spottedAt) - new Date(a.spottedAt));
  state.boroughs = boroughs;

  if (drafts.length) {
    const note = $('#draftNote');
    note.textContent = `${drafts.length} saved on this device only`;
    note.hidden = false;
  }

  renderStats();
  // Never repeat a photo to pad the grid out — the same image tiled five times
  // reads as a bug, not a collage. Fewer, distinct tiles until there are 16.
  renderGallery($('#openingGallery'), state.photos, Math.min(GALLERY_N, state.photos.length));
  renderBoards();
  renderMap();
  initLightbox();
})();

// ────────────────────────────────────────────────────── opening gallery

function renderGallery(el, photos, count) {
  if (!photos.length) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const p = photos[i % photos.length];
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = p.thumb;
    img.alt = `${p.flavour || 'Buzzball'} in ${p.borough || 'London'}`;
    img.loading = i < 5 ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.addEventListener('click', () => openLightbox(p));
    fig.appendChild(img);
    frag.appendChild(fig);
  }
  // Insert before the title, which lives in the same grid — this keeps the
  // figures as children 1..N so the :nth-child placements stay correct.
  $('#openingTitle').before(frag);
}

// ─────────────────────────────────────────────────────────────── stats

function renderStats() {
  const p = state.photos;
  $('#statTotal').textContent = p.length;
  $('#statBoroughs').textContent = new Set(p.map(x => x.borough).filter(Boolean)).size;
}

// ────────────────────────────────────────────────────────── leaderboards

function tally(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function renderBoards() {
  buildBoard('#boardBoroughs', tally(state.photos, p => p.borough));
  buildBoard('#boardFlavours', tally(state.photos, p => p.flavour));
  buildBoard('#boardSpotters', tally(state.photos, p => p.spotter));

  $$('.board__more').forEach(btn => {
    btn.addEventListener('click', () => {
      const open = btn.closest('.board').classList.toggle('is-open');
      btn.textContent = open ? 'Show fewer' : 'Show all';
    });
  });
}

function buildBoard(sel, items) {
  const list = $(sel);
  const max = items.length ? items[0].count : 1;
  const frag = document.createDocumentFragment();

  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'row' + (i >= TOP_N ? ' is-extra' : '');
    li.innerHTML = `
      <span class="row__rank">${i + 1}</span>
      <span class="row__name" title="${esc(it.name)}">${esc(it.name)}</span>
      <span class="row__val">${it.count}</span>
      <span class="row__track"><span class="row__bar" style="width:${(it.count / max) * 100}%"></span></span>`;
    frag.appendChild(li);
  });

  list.replaceChildren(frag);
  list.parentElement.querySelector('.board__more').hidden = items.length <= TOP_N;
}

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─────────────────────────────────────────────────────────────────── map

function renderMap() {
  const map = L.map('map', {
    center: LONDON,
    zoom: 11,
    scrollWheelZoom: false,        // don't hijack the page scroll
    zoomControl: true,
  });
  state.map = map;

  // click to enable wheel zoom, leaving re-locks it
  map.on('click', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // choropleth — sequential blue by sighting count
  const counts = new Map();
  for (const p of state.photos) {
    if (p.borough) counts.set(p.borough, (counts.get(p.borough) || 0) + 1);
  }
  const maxCount = Math.max(1, ...counts.values());

  L.geoJSON(state.boroughs, {
    style: f => {
      const n = counts.get(f.properties.name) || 0;
      return {
        color: 'rgba(43,42,40,.22)',
        weight: 0.7,
        fillColor: n ? css(SEQ[bucket(n, maxCount)]) : '#2b2a28',
        fillOpacity: n ? 0.55 : 0.03,
      };
    },
    onEachFeature: (f, layer) => {
      const n = counts.get(f.properties.name) || 0;
      layer.bindTooltip(
        `<b>${esc(f.properties.name)}</b><br>${n} spotted`,
        { sticky: true, className: 'pin-card', direction: 'top' });
    },
  }).addTo(map);

  // pins
  const group = L.featureGroup().addTo(map);
  for (const p of state.photos) {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;

    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ html: '<div class="pin"></div>', className: '', iconSize: [13, 13] }),
      riseOnHover: true,
      keyboard: false,
    });

    marker.bindTooltip(pinCard(p), {
      direction: 'top',
      offset: [0, -10],
      className: 'pin-card',
      opacity: 1,
    });

    // Leaflet clips tooltips to the map, so a card on a pin near the top edge
    // gets cut off. Flip it below the pin when there isn't room above.
    marker.on('tooltipopen', e => {
      const y = map.latLngToContainerPoint(marker.getLatLng()).y;
      const dir = y < 210 ? 'bottom' : 'top';
      if (e.tooltip.options.direction !== dir) {
        e.tooltip.options.direction = dir;
        e.tooltip.options.offset = L.point(0, dir === 'bottom' ? 14 : -10);
        e.tooltip.update();
      }
    });

    marker.on('click', () => openLightbox(p));
    marker.addTo(group);
  }

  if (group.getLayers().length) {
    map.fitBounds(group.getBounds(), {
      paddingTopLeft: [30, 40], paddingBottomRight: [30, 30], maxZoom: 13,
    });
  }
}

// Spread counts across the whole ramp, so 1..max always uses both ends of the
// legend rather than bunching in the middle when max is small.
function bucket(n, max) {
  if (max <= 1) return SEQ.length - 1;
  const i = Math.round(((n - 1) / (max - 1)) * (SEQ.length - 1));
  return Math.min(SEQ.length - 1, Math.max(0, i));
}

function pinCard(p) {
  const when = new Date(p.spottedAt).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
  return `
    <img src="${esc(p.thumb)}" alt="">
    <div class="pin-card__meta">
      <div class="pin-card__flavour">${esc(p.flavour || 'Unknown')}</div>
      <div class="pin-card__where">${esc(p.borough || 'London')} · ${when}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────── lightbox

function initLightbox() {
  const box = $('#lightbox');
  $('#lightboxClose').addEventListener('click', closeLightbox);
  box.addEventListener('click', e => { if (e.target === box) closeLightbox(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
}

function openLightbox(p) {
  const when = new Date(p.spottedAt).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric' });
  $('#lightboxImg').src = p.file;
  $('#lightboxImg').alt = `${p.flavour || 'Buzzball'} in ${p.borough || 'London'}`;
  $('#lightboxCap').textContent =
    [p.flavour, p.borough, p.caption, when].filter(Boolean).join(' · ');
  $('#lightbox').hidden = false;
}

function closeLightbox() { $('#lightbox').hidden = true; }
