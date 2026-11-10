// ==========================================================================
// Paddle App — live direction map for the Block Tracker's EB / WB pages.
// Every bus on the page as a small bus icon, labelled "#11-9652" (its trip
// number in that direction, then its block), in the same colour as its tag
// on the cards: green / red / yellow by leader-follower order, purple on
// layover, gray for a bus that should be out but isn't on the live feed.
//
// Public page: no account needed. Informational only, like the cards.
//
//   const m = createLiveMap();          // m.el is the map's own element
//   m.attach(slotEl);                   // (re)place it after the page redraws
//   m.update({ route, dir, items });    // items: see markerOf() below
// ==========================================================================

import { loadLeaflet, TILES, TILES_ATTR } from './pa-lf-view.js';
import { loadShapes } from './pa-lf-feed.js';
import { dirOf } from './pa-lf.js';

const DOT = { green: '#1f8a4c', red: '#c8102e', yellow: '#f2b705', lay: '#6a3fc1', gray: '#8a909f' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normName = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const BUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>';

// A point `d` miles along a prepared line.
function pointAt(line, d) {
  const { pts, cum } = line;
  if (!pts.length) return null;
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= d) {
      const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    }
  }
  return pts[pts.length - 1];
}

// A stop by name in any direction of the route ("Dock St & Front St").
function stopNamed(shapes, name) {
  const n = normName(name);
  if (!shapes || !n) return null;
  for (const d of Object.values(shapes.dirs)) {
    const s = d.stops.find(x => normName(x.name) === n);
    if (s) return [s.lat, s.lng];
  }
  return null;
}

/**
 * Where an item goes and how it looks, or null if it can't be placed.
 * item: { nth, blk, cls: 'green'|'red'|'yellow'|'gray'|'lay', lat, lng,
 *         layStop (layover: stop name), s, e (ghost: scheduled minutes),
 *         nowMin, vid, title }
 */
function markerOf(it, line, shapes) {
  let ll = null, est = false;
  const lat = parseFloat(it.lat), lng = parseFloat(it.lng);
  if (isFinite(lat) && isFinite(lng) && lat && lng) ll = [lat, lng];
  else if (it.cls === 'lay') { ll = stopNamed(shapes, it.layStop) || (line && line.pts[0]); est = true; }
  else if (it.cls === 'gray' && line && it.s != null && it.e != null && it.e > it.s) {
    // Not on the feed: where the timetable says it should be.
    const f = Math.max(0, Math.min(1, (it.nowMin - it.s) / (it.e - it.s)));
    ll = pointAt(line, f * line.len); est = true;
  }
  if (!ll) return null;
  return { ll, est, label: '#' + (it.nth || '?') + '-' + it.blk, cls: it.cls || 'green', title: it.title || '' };
}

export function createLiveMap() {
  const el = document.createElement('div');
  el.className = 'lm';
  el.innerHTML = '<div class="lm-map"></div><div class="lm-note"></div>';
  const mapEl = el.querySelector('.lm-map'), noteEl = el.querySelector('.lm-note');
  let map = null, lineLayer = null, busLayer = null, fitKey = '', touched = false, last = null, seq = 0, marks = [];

  async function ensureMap() {
    if (map) return map;
    const Lf = await loadLeaflet();
    if (map) return map;
    // Half-level zoom steps so a pinch or a +/- tap doesn't jump too far.
    map = Lf.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, zoomSnap: 0.5, zoomDelta: 0.5 });
    Lf.tileLayer(TILES, { maxZoom: 19, attribution: TILES_ATTR }).addTo(map);
    lineLayer = Lf.layerGroup().addTo(map);
    busLayer = Lf.layerGroup().addTo(map);
    map.on('dragstart zoomstart', e => { if (!e.hard) touched = true; });
    map.on('zoomend', layout);
    return map;
  }

  // Place the icons for the current zoom: each label is a box from its bus
  // to the right; one that overlaps an earlier box goes up 20 px until free.
  function layout() {
    if (!map || !busLayer) return;
    const Lf = window.L;
    busLayer.clearLayers();
    const boxes = [];
    for (const m of marks) {
      const p = map.latLngToContainerPoint(m.ll);
      const w = 26 + m.label.length * 6.4;
      let k = 0;
      const hit = y => boxes.some(b => p.x + 5 < b.x + b.w && b.x < p.x + 5 + w && Math.abs(b.y - y) < 19);
      while (k < 12 && hit(p.y - 13 - k * 20)) k++;
      boxes.push({ x: p.x + 5, y: p.y - 13 - k * 20, w });
      const html = '<div class="lm-bus lm-' + m.cls + (m.est ? ' lm-est' : '') + '">' + (k ? '<i class="lm-stem" style="height:' + (k * 20 + 4) + 'px"></i>' : '') + BUS_SVG + '<b>' + esc(m.label) + '</b></div>';
      // The bus's real spot, so a label pushed up still points home.
      Lf.circleMarker(m.ll, { radius: 4, weight: 1.5, color: '#fff', fillColor: DOT[m.cls] || DOT.green, fillOpacity: 1, interactive: false }).addTo(busLayer);
      Lf.marker(m.ll, {
        icon: Lf.divIcon({ className: 'lm-wrap', html, iconSize: null, iconAnchor: [-5, 22 + k * 20] }),
        keyboard: false, title: m.title, zIndexOffset: 1000 - boxes.length,
      }).addTo(busLayer);
    }
  }

  async function draw() {
    const my = ++seq;
    const { route, dir, items, nowMin } = last;
    let shapes = null;
    try { shapes = await loadShapes(route); } catch (_) { shapes = null; }
    let Lf;
    try { await ensureMap(); Lf = window.L; } catch (_) { noteEl.textContent = 'Map could not load (no connection to the map server).'; return; }
    if (my !== seq || !el.isConnected) return;
    map.invalidateSize();
    const ds = dirOf(shapes, dir);
    const line = ds ? ds.main : null;

    // Route line, only when the direction changes.
    const key = route + '|' + dir;
    if (key !== fitKey) {
      lineLayer.clearLayers();
      if (ds) for (const l of Object.values(ds.lines)) Lf.polyline(l.pts, { className: 'lm-route', weight: 4, opacity: 0.75, interactive: false }).addTo(lineLayer);
    }

    // Buses: live ones first so they sit on their real spot; a label that
    // would cover another moves up a row (layover buses at one terminal stack).
    marks = [];
    let missing = 0;
    for (const it of items) {
      const m = markerOf({ ...it, nowMin }, line, shapes);
      if (m) marks.push(m); else missing++;
    }
    marks.sort((a, b) => a.est - b.est);
    const placed = marks.map(m => m.ll);
    if (key !== fitKey || (!touched && placed.length && !line)) {
      const pts = line ? line.pts : placed;
      if (pts.length) map.fitBounds(Lf.latLngBounds(pts), { padding: [18, 18] });
      fitKey = key; touched = false;
    }
    layout();
    const nGray = items.filter(x => x.cls === 'gray').length;
    noteEl.textContent = (nGray ? 'Gray = not on the live feed, shown where the timetable puts it. ' : '') +
      'Purple = layover at the terminal.' + (missing ? ' ' + missing + ' bus' + (missing > 1 ? 'es' : '') + ' without a position not shown.' : '');
  }

  return {
    el,
    attach(slot) {
      if (!slot) return;
      if (el.parentNode !== slot) slot.appendChild(el);
      if (map) map.invalidateSize();
    },
    update(state) {
      last = state;
      draw().catch(e => console.error('[live map]', e));
    },
  };
}
