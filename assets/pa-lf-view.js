// ==========================================================================
// Paddle App — Leader / Follower view (DOM). Three stacked cards (leader,
// you, follower), a plain-language summary, a mini map with only those three
// buses, and a "last updated" line. Refreshes every 15 s; data older than
// 60 s turns gray with a warning.
//
// The logic lives in pa-lf.js and the data access in pa-lf-feed.js; this
// file only draws. The host page supplies the operator's context and draws
// the (scheduled, fixed) countdown itself - nothing here touches it.
//
//   const v = mountLF(el, { getContext, mock });   // v.refresh(), v.destroy()
//   getContext() -> { block, routes, trips, myTrip, pullIns, knownBus, label }
//                   or { message } when there is nothing to show yet
// ==========================================================================

import * as LF from './pa-lf.js';
import { createFeed, loadShapes, SCENARIOS } from './pa-lf-feed.js';

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
// OpenStreetMap's standard tiles, grayed in pa-lf.css (CARTO's now need a key).
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILES_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

let leafletP = null;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (!leafletP) {
    leafletP = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET_JS; s.async = true;
      s.onload = () => (window.L ? resolve(window.L) : reject(new Error('leaflet')));
      s.onerror = () => { leafletP = null; reject(new Error('leaflet')); };
      document.head.appendChild(s);
    });
  }
  return leafletP;
}

const ROLE = {
  leader:   { title: 'Leader',   sub: 'ahead',  mark: 'L' },
  you:      { title: 'You',      sub: '',       mark: 'Y' },
  follower: { title: 'Follower', sub: 'behind', mark: 'F' }
};

function cardHtml(c, role, m) {
  const R = ROLE[role];
  if (!c) {
    return '<div class="lf-card lf-' + role + ' lf-empty"><div class="lf-top"><span class="lf-role">' + R.title
      + (R.sub ? ' <i>· ' + R.sub + '</i>' : '') + '</span></div>'
      + '<div class="lf-loc">' + (role === 'leader' ? 'No bus ahead of you on this trip.' : 'No bus behind you on this trip.') + '</div></div>';
  }
  const badge = '<span class="lf-badge k-' + c.status.kind + '">' + esc(c.status.kind === 'none' ? 'No live data' : c.status.text) + '</span>';
  const id = '<div class="lf-id">Block <b>' + esc(c.block || '—') + '</b> · Bus <b>' + esc(c.vehicleId || '—') + '</b></div>';
  let loc;
  if (c.live) {
    loc = esc(c.location || 'position known');
    if (!c.sameDirection && c.direction) loc = 'finishing a ' + esc(c.direction) + ' trip · ' + loc;
    if (c.reportAgeMin != null && c.reportAgeMin >= 2) loc += ' <span class="lf-age">· position ' + Math.round(c.reportAgeMin) + ' min old</span>';
    if (role === 'you' && m.mode === 'schedule') loc += m.atTerminal ? ' · at the terminal — leader and follower by timetable order' : ' · off the route line — leader and follower by timetable order';
  } else if (role === 'you') {
    loc = m.outage ? 'No live data (feed down) — leader and follower by timetable order'
                   : 'Not in service yet — leader and follower by timetable order';
  } else {
    loc = 'No live data' + (c.trip ? ' · scheduled ' + esc(fmtMin(c.trip.s)) + ' from ' + esc(c.trip.first) : '');
  }
  let gap = '';
  if (role !== 'you') {
    const g = m.gaps[role];
    const line = LF.gapLine(role, g, m.mode === 'schedule');
    const bunch = m.bunching[role] ? ' <span class="lf-bunch">Bunching</span>' : '';
    if (line || bunch) gap = '<div class="lf-gap">' + esc(line) + bunch + '</div>';
  }
  return '<div class="lf-card lf-' + role + (m.bunching[role] ? ' lf-bunching' : '') + '">'
    + '<div class="lf-top"><span class="lf-role"><span class="lf-dot">' + R.mark + '</span>' + R.title
    + (R.sub ? ' <i>· ' + R.sub + '</i>' : '') + '</span>' + badge + '</div>'
    + id + '<div class="lf-loc">' + loc + '</div>' + gap + '</div>';
}

function fmtMin(min) {
  min = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60); const mm = String(min % 60).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return h + ':' + mm + ' ' + ap;
}

function othersHtml(buses, m) {
  const shown = new Set([m.leader, m.you, m.follower].filter(Boolean).map(c => c.block));
  const rest = (buses || []).filter(b => b.block && !shown.has(b.block));
  if (!rest.length) return '';
  const rows = rest.map(b => {
    const st = LF.classify(b.notTracking ? null : b.late);
    return '<li>Block ' + esc(b.block) + ' · Bus ' + esc(b.vehicleId || '—') + ' · ' + esc(b.direction || '—')
      + ' <span class="lf-badge sm k-' + st.kind + '">' + esc(st.kind === 'none' ? 'No live data' : st.text) + '</span></li>';
  }).join('');
  return '<details class="lf-others"><summary>Other buses on the route (' + rest.length + ')</summary><ul>' + rows + '</ul></details>';
}

export function mountLF(root, { getContext, mock = null } = {}) {
  const feed = createFeed({ mock });
  const st = { model: null, buses: null, fetchedAt: 0, ok: true, ctx: null, map: null, layers: null, userMoved: false,
               timer: null, ticker: null, token: 0, busy: false, dead: false };

  root.classList.add('lf');
  root.innerHTML =
      (mock ? '<div class="lf-mock">TEST DATA · ' + esc(mock) + ' — ' + esc(SCENARIOS[mock]) + '</div>' : '')
    + '<div class="lf-info">Info only — your countdown follows the schedule, not these buses.</div>'
    + '<div class="lf-summary" data-lf="summary">Looking up the buses around you…</div>'
    + '<div class="lf-warn" data-lf="warn" hidden></div>'
    + '<div class="lf-cards" data-lf="cards"></div>'
    + '<div class="lf-mapwrap"><div class="lf-map" data-lf="map"></div><div class="lf-map-note" data-lf="mapnote" hidden></div></div>'
    + '<div class="lf-foot" data-lf="foot"></div>'
    + '<div data-lf="others"></div>';
  const q = k => root.querySelector('[data-lf="' + k + '"]');

  function renderFresh() {
    const f = LF.freshness(st.fetchedAt, Date.now());
    // Gray = live data we HAD has gone old. Timetable-only cards stay as they are.
    root.classList.toggle('lf-stale', !!st.model && !!st.fetchedAt && f.stale);
    const warn = q('warn');
    let msg = '';
    if (!st.ok && !st.fetchedAt) msg = 'SEPTA live feed not answering. Leader and follower below are from the timetable, with no live positions.';
    else if (!st.ok) msg = 'SEPTA live feed not answering. Showing the last data, from ' + clock(st.fetchedAt) + '.';
    if (st.fetchedAt && f.stale) msg = (msg ? msg + ' ' : '') + 'Live data is ' + (f.ageSec >= 120 ? Math.round(f.ageSec / 60) + ' min' : f.ageSec + ' s') + ' old — don’t rely on it.';
    warn.hidden = !msg; warn.textContent = msg;
    const foot = q('foot');
    if (!st.model) { foot.textContent = ''; return; }
    foot.innerHTML = (st.fetchedAt ? 'Last updated <b>' + clock(st.fetchedAt) + '</b>' + (f.ageSec != null ? ' (' + f.ageSec + ' s ago)' : '') : 'No live data yet')
      + ' · refreshes every ' + LF.REFRESH_MS / 1000 + ' s'
      + (st.model.direction ? ' · ' + esc(st.model.direction) : '')
      + ' · ' + (st.model.mode === 'live' ? 'live order on the route' : 'timetable order');
  }

  async function drawMap(m) {
    const pts = [['leader', m.leader], ['you', m.you], ['follower', m.follower]].filter(([, c]) => c && c.lat != null);
    const note = q('mapnote');
    let Lf;
    try { Lf = await loadLeaflet(); } catch (_) { note.hidden = false; note.textContent = 'Map unavailable (no connection to the map library).'; return; }
    if (st.dead) return;
    note.hidden = true;
    if (!st.map) {
      st.map = Lf.map(q('map'), { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
      Lf.tileLayer(TILES, { maxZoom: 19, attribution: TILES_ATTR }).addTo(st.map);
      st.layers = Lf.layerGroup().addTo(st.map);
      st.map.on('dragstart', () => { st.userMoved = true; });
      st.map.setView([39.9526, -75.1652], 12);
    }
    st.layers.clearLayers();
    let lineLayer = null;
    if (m.line && m.line.length > 1) lineLayer = Lf.polyline(m.line, { className: 'lf-route', weight: 4, opacity: 0.8 }).addTo(st.layers);
    for (const [role, c] of pts) {
      const rot = c.heading != null ? c.heading - 90 : null;            // ➜ points east (90°)
      const html = '<div class="lf-mk lf-mk-' + role + (c.status ? ' k-' + c.status.kind : '') + '">'
        + (rot != null ? '<span class="lf-mk-arrow" style="transform:rotate(' + Math.round(rot) + 'deg)">➜</span>' : '')
        + '<b>' + ROLE[role].mark + '</b></div>';
      Lf.marker([c.lat, c.lng], { icon: Lf.divIcon({ className: 'lf-mk-wrap', html, iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false,
        title: ROLE[role].title + ' · Block ' + c.block }).addTo(st.layers);
    }
    if (!st.userMoved) {
      if (pts.length > 1) st.map.fitBounds(pts.map(([, c]) => [c.lat, c.lng]), { padding: [36, 36], maxZoom: 16 });
      else if (pts.length === 1) st.map.setView([pts[0][1].lat, pts[0][1].lng], 15);
      else if (lineLayer) st.map.fitBounds(lineLayer.getBounds(), { padding: [16, 16] });
    }
    setTimeout(() => st.map && st.map.invalidateSize(), 0);
  }

  function render() {
    const m = st.model;
    if (!m) return;
    q('summary').textContent = m.summary;
    q('summary').className = 'lf-summary' + (m.bunching.leader || m.bunching.follower ? ' lf-sum-bunch' : '');
    q('cards').innerHTML = cardHtml(m.leader, 'leader', m) + cardHtml(m.you, 'you', m) + cardHtml(m.follower, 'follower', m);
    q('others').innerHTML = othersHtml(st.buses, m);
    renderFresh();
    drawMap(m);
  }

  async function refresh() {
    if (st.busy || st.dead) return;
    st.busy = true;
    const token = ++st.token;
    try {
      const ctx = await getContext();
      if (st.dead || token !== st.token) return;
      if (!ctx || ctx.message) {
        q('summary').textContent = (ctx && ctx.message) || 'Nothing to show right now.';
        q('cards').innerHTML = ''; q('foot').textContent = '';
        return;
      }
      st.ctx = ctx;
      const shapes = await loadShapes((ctx.myTrip && ctx.myTrip.route) || ctx.routes[0]);
      const r = await feed.read(ctx, shapes);
      if (st.dead || token !== st.token) return;
      st.buses = r.buses; st.ok = r.ok; st.fetchedAt = r.fetchedAt;
      st.model = LF.buildLF({ myBlock: ctx.block, buses: r.buses, shapes, trips: ctx.trips || [], myTrip: ctx.myTrip,
                              pullIns: ctx.pullIns || null, knownBus: mock ? null : ctx.knownBus || null, outage: !r.ok });
      if (!shapes) st.model.summary += ' (Route line not available — order is from the timetable.)';
      render();
    } catch (e) {
      console.error('[leader/follower]', e);
      if (!st.dead) q('summary').textContent = 'Live lookup failed — no leader / follower data right now.';
    } finally { st.busy = false; }
  }

  refresh();
  st.timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, LF.REFRESH_MS);
  st.ticker = setInterval(renderFresh, 1000);
  const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
  document.addEventListener('visibilitychange', onVis);

  return {
    refresh,
    destroy() {
      st.dead = true;
      clearInterval(st.timer); clearInterval(st.ticker);
      document.removeEventListener('visibilitychange', onVis);
      if (st.map) { try { st.map.remove(); } catch (_) {} st.map = null; }
      root.innerHTML = '';
    }
  };
}
