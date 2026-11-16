// ==========================================================================
// Paddle App — Live "both directions" page: two vertical lines next to each
// other, one per direction, with every bus tag of the EB / WB pages placed
// along its line (same tags, same colours: green / red / yellow by leader-
// follower order, gray for a bus that should be out but isn't on the feed,
// purple on layover with the countdown to its next trip), each with its bus
// number. Between the two lines: the route's major stops at their height,
// so a bus's place on the street can be read off the line.
//
// Both lines share ONE ruler, so the same street sits at the same height in
// both columns: west / north at the top, east / south at the bottom.
//   WB / NB buses travel UP their line   (label on top only);
//   EB / SB buses travel DOWN their line (label at the bottom only).
// A bus's height = where it is on the route: its live position, else (gray)
// where the timetable says it should be, else (layover) the stop it waits at.
// No shapes file for the route → the buses keep the cards' order, evenly
// spaced, and no stops are shown.
//
//   bothLinesHtml({ shapes, cols: [left, right], nowMin })
//   col: { dir, label, up, items: [{ cls, nth, bus, tip, dueMs, dueTxt,
//          lat, lng, s, e, layStop, layover }] }   (items in the cards' order)
// ==========================================================================

import { dirOf, project } from './pa-lf.js';
export { loadShapes } from './pa-lf-feed.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normName = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const DOT = { green: '#1f8a4c', red: '#c8102e', yellow: '#f2b705', lay: '#6a3fc1', gray: '#8a909f' };
const clamp01 = x => Math.max(0, Math.min(1, x));
// The app's own bus (the picture next to the menu button) - the one bus icon.
const BUS_IMG = '<img class="bus-ico" src="' + new URL('./icon-192.png', import.meta.url).href + '" alt="" width="12" height="12">';

const PILL_H = 24;   // px, one row of a tag
const LAY_H = 44;    // px, a layover tag (second row: countdown)
const SEP = 6;       // px between two tags
const PAD = 16;      // px kept free at both ends of a line
const TRACK = 22;    // px width of the line strip (line + dots + stems)
const STOP_SP = 54;  // px at least between two stop names

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

function stopNamed(shapes, name) {
  const n = normName(name);
  if (!shapes || !n) return null;
  for (const d of Object.values(shapes.dirs)) {
    const s = d.stops.find(x => normName(x.name) === n);
    if (s) return [s.lat, s.lng];
  }
  return null;
}

// The shared ruler: the down direction's line top → bottom, else the up
// direction's line read backwards.
function rulerOf(shapes, cols) {
  if (!shapes) return null;
  const down = cols.find(c => !c.up), up = cols.find(c => c.up);
  const dd = down && dirOf(shapes, down.dir), du = up && dirOf(shapes, up.dir);
  if (dd && dd.main && dd.main.len) return { line: dd.main, flip: false, dir: dd };
  if (du && du.main && du.main.len) return { line: du.main, flip: true, dir: du };
  return null;
}

// 0 = top of the lines, 1 = bottom; null = can't place it.
function fracOf(it, col, ruler, shapes, nowMin) {
  const onRuler = ll => {
    if (!ll) return null;
    const p = project(ruler.line, ll[0], ll[1]);
    if (!p) return null;
    const f = clamp01(p.d / ruler.line.len);
    return ruler.flip ? 1 - f : f;
  };
  const lat = parseFloat(it.lat), lng = parseFloat(it.lng);
  if (isFinite(lat) && isFinite(lng) && lat && lng) return onRuler([lat, lng]);
  const own = dirOf(shapes, col.dir);
  const line = own && own.main;
  if (it.layover) {
    const at = onRuler(stopNamed(shapes, it.layStop));
    if (at != null) return at;
    return col.up ? 1 : 0;   // the start of its next trip
  }
  if (line && it.s != null && it.e != null && it.e > it.s) {
    const f = clamp01((nowMin - it.s) / (it.e - it.s));
    return onRuler(pointAt(line, f * line.len));
  }
  return null;
}

// Wanted tops → tops where no two tags overlap, kept inside the line.
function spread(want, hs, H) {
  const idx = want.map((y, i) => i).sort((a, b) => want[a] - want[b]);
  const out = want.slice();
  let prevEnd = -Infinity;
  for (const i of idx) { out[i] = Math.max(out[i], prevEnd + SEP, 4); prevEnd = out[i] + hs[i]; }
  let nextTop = Infinity;
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; out[i] = Math.min(out[i], nextTop - SEP - hs[i], H - 4 - hs[i]); nextTop = out[i]; }
  return out;
}

// ── Stops ────────────────────────────────────────────────────
// "Chestnut St & 55th St" on a Chestnut St route reads "55th St"; a name
// without a cross street ("69th St Transit Center") stays whole.
function shortNames(stops) {
  const clean = n => String(n || '').replace(/\s+-\s+.*$/, '').trim();
  const count = {};
  stops.forEach(s => clean(s.name).split(/\s*&\s*/).forEach(p => { if (p) count[p] = (count[p] || 0) + 1; }));
  return stops.map(s => {
    const n = clean(s.name), parts = n.split(/\s*&\s*/);
    if (parts.length !== 2) return n;
    const [a, b] = parts, ca = count[a] || 0, cb = count[b] || 0;
    if (ca >= 3 && ca > cb) return b;
    if (cb >= 3 && cb > ca) return a;
    return n;
  });
}
// How "major" a stop is: transit centers, stations, loops, Broad St, City
// Hall, then the round-numbered streets (40th, 30th…), then the 5s.
function stopScore(name) {
  if (/transit|station|terminal|loop|plaza|city hall|center|ctr|mall|hospital|broad st|airport|bridge/i.test(name)) return 3;
  const m = name.match(/\b(\d+)(st|nd|rd|th)\b/i);
  if (m) { const n = +m[1]; if (n % 10 === 0) return 2; if (n % 5 === 0) return 1; }
  return 0;
}
// The stops worth a name between the lines: major ones first, each at least
// STOP_SP from the next, none on top of the end terminals' names.
function majorStops(ruler, H) {
  const st = ruler.dir.stops.filter(s => s.d != null);
  const names = shortNames(st);
  const cand = st.map((s, i) => {
    const f = clamp01(s.d / ruler.line.len);
    return { name: names[i], y: PAD + (ruler.flip ? 1 - f : f) * (H - 2 * PAD), score: stopScore(s.name) };
  }).filter(c => c.y > PAD + 30 && c.y < H - PAD - 30);
  cand.sort((a, b) => b.score - a.score || a.y - b.y);
  const out = [], seen = new Set();
  for (const c of cand) {
    if (seen.has(c.name)) continue;
    if (out.some(o => Math.abs(o.y - c.y) < STOP_SP)) continue;
    out.push(c); seen.add(c.name);
  }
  return out.sort((a, b) => a.y - b.y);
}

// ── One direction's line ─────────────────────────────────────
function columnHtml(col, ruler, shapes, nowMin, H, side, stops) {
  const n = col.items.length;
  // Wanted centre of each tag's dot on the line.
  let fr = ruler ? col.items.map(it => fracOf(it, col, ruler, shapes, nowMin)) : col.items.map(() => null);
  // Unplaced buses (and every bus without a shapes file) keep the cards'
  // order: top → bottom for an up line, bottom → top for a down line.
  if (fr.some(f => f == null)) {
    const even = i => (col.up ? i + 0.5 : n - i - 0.5) / n;
    fr = fr.map((f, i) => f == null ? even(i) : f);
  }
  const want = fr.map(f => PAD + f * (H - 2 * PAD));
  const hs = col.items.map(it => it.layover ? LAY_H : PILL_H);
  const tops = spread(want.map(y => y - PILL_H / 2), hs, H);
  const x = side === 'left' ? TRACK - 8 : 8;       // the line, toward the middle
  const edge = side === 'left' ? 0 : TRACK;        // where the tags start
  let svg = '<svg class="bl-svg" width="' + TRACK + '" height="' + H + '" viewBox="0 0 ' + TRACK + ' ' + H + '" aria-hidden="true">';
  svg += '<line class="bl-line" x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '"/>';
  // A tick on the line at each named stop.
  for (const s of stops) svg += '<line class="bl-tick" x1="' + (x - 5) + '" y1="' + s.y.toFixed(1) + '" x2="' + (x + 5) + '" y2="' + s.y.toFixed(1) + '"/>';
  // Arrows on the line: which way its buses go (between the stop ticks).
  for (let y = 40; y < H - 30; y += 110) {
    if (stops.some(s => Math.abs(s.y - y) < 12)) continue;
    svg += col.up ? '<path class="bl-chev" d="M' + (x - 4) + ' ' + (y + 3) + ' L' + x + ' ' + (y - 2) + ' L' + (x + 4) + ' ' + (y + 3) + '"/>'
                  : '<path class="bl-chev" d="M' + (x - 4) + ' ' + (y - 3) + ' L' + x + ' ' + (y + 2) + ' L' + (x + 4) + ' ' + (y - 3) + '"/>';
  }
  let pills = '';
  col.items.forEach((it, i) => {
    const c = DOT[it.cls] || DOT.green, yDot = want[i], yTag = tops[i] + PILL_H / 2;
    svg += '<line class="bl-stem" stroke="' + c + '" x1="' + x + '" y1="' + yDot.toFixed(1) + '" x2="' + edge + '" y2="' + yTag.toFixed(1) + '"/>';
    svg += '<circle class="bl-dot" fill="' + c + '" cx="' + x + '" cy="' + yDot.toFixed(1) + '" r="5"/>';
    const tag = '<span class="at-nth ' + esc(it.cls) + '">#' + esc(it.nth || '?') + '</span>';
    const bus = '<span class="bl-bus' + (it.bus ? '' : ' none') + '">' + BUS_IMG + '<b>' + esc(it.bus || '—') + '</b></span>';
    const row = '<span class="bl-row1">' + (side === 'left' ? bus + tag : tag + bus) + '</span>';
    const due = it.layover ? '<span class="bl-due">⚓ <span data-due-ms="' + esc(it.dueMs) + '">' + esc(it.dueTxt) + '</span></span>' : '';
    pills += '<button type="button" class="bl-pill bl-' + esc(it.cls) + '" style="top:' + tops[i].toFixed(1) + 'px" data-tip="' + esc(it.tip) + '">' + row + due + '</button>';
  });
  svg += '</svg>';
  const tags = '<div class="bl-tags">' + pills + '</div>';
  return '<div class="bl-col bl-' + side + '" style="height:' + H + 'px">' + (side === 'left' ? tags + svg : svg + tags) + '</div>';
}

export function bothLinesHtml({ shapes, cols, nowMin }) {
  const ruler = rulerOf(shapes, cols);
  const need = c => c.items.reduce((s, it) => s + (it.layover ? LAY_H : PILL_H) + SEP, 0);
  const H = Math.max(640, Math.max(...cols.map(need)) + 2 * PAD + 20);
  // The two ends of the route (the ruler's first and last stop).
  let topStop = '', botStop = '';
  const stops = ruler ? majorStops(ruler, H) : [];
  if (ruler) {
    const st = ruler.dir.stops.filter(s => s.d != null).sort((a, b) => a.d - b.d);
    if (st.length) { topStop = st[0].name; botStop = st[st.length - 1].name; }
    if (ruler.flip) [topStop, botStop] = [botStop, topStop];
  }
  const lbl = (col, where) => {
    const show = where === 'top' ? col.up : !col.up;
    return '<div class="bl-lbl' + (show ? '' : ' off') + '">' + (show ? (col.up ? '▲ ' : '') + esc(col.label) + (col.up ? '' : ' ▼') : '') + '</div>';
  };
  const mid = '<div class="bl-mid" style="height:' + H + 'px">' +
    stops.map(s => '<span class="bl-stop" style="top:' + s.y.toFixed(1) + 'px">' + esc(s.name) + '</span>').join('') + '</div>';
  const [L, R] = cols;
  let h = '<div class="bl">';
  h += '<div class="bl-ends top">' + lbl(L, 'top') + '<div class="bl-end">' + esc(topStop) + '</div>' + lbl(R, 'top') + '</div>';
  h += '<div class="bl-cols">' + columnHtml(L, ruler, shapes, nowMin, H, 'left', stops) + mid + columnHtml(R, ruler, shapes, nowMin, H, 'right', stops) + '</div>';
  h += '<div class="bl-ends bot">' + lbl(L, 'bot') + '<div class="bl-end">' + esc(botStop) + '</div>' + lbl(R, 'bot') + '</div>';
  return h + '</div>';
}
