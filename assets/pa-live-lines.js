// ==========================================================================
// Paddle App — Live "both directions" page: two vertical lines next to each
// other, one per direction, with every bus tag of the EB / WB pages placed
// along its line (same tags, same colours: green / red / yellow by leader-
// follower order, gray for a bus that should be out but isn't on the feed,
// purple on layover with the countdown to its next trip).
//
// Both lines share ONE ruler, so the same street sits at the same height in
// both columns: west / north at the top, east / south at the bottom.
//   WB / NB buses travel UP their line   (label on top only);
//   EB / SB buses travel DOWN their line (label at the bottom only).
// A bus's height = where it is on the route: its live position, else (gray)
// where the timetable says it should be, else (layover) the stop it waits at.
// No shapes file for the route → the buses keep the cards' order, evenly
// spaced.
//
//   bothLinesHtml({ shapes, cols: [left, right], nowMin, anim })
//   col: { dir, label, up, items: [{ cls, nth, bus, tip, dueMs, dueTxt,
//          lat, lng, s, e, layStop, layover }] }   (items in the cards' order)
// ==========================================================================

import { dirOf, project } from './pa-lf.js';
export { loadShapes } from './pa-lf-feed.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normName = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const DOT = { green: '#1f8a4c', red: '#c8102e', yellow: '#f2b705', lay: '#6a3fc1', gray: '#8a909f' };
const clamp01 = x => Math.max(0, Math.min(1, x));

const GAP = 30;      // px between two tags' tops (a tag is ~24 px tall)
const PAD = 16;      // px kept free at both ends of a line
const TRACK = 30;    // px width of the line strip (line + dots + stems)

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

// Wanted heights → heights where no two tags overlap, kept inside the line.
function spread(ys, H) {
  const idx = ys.map((y, i) => i).sort((a, b) => ys[a] - ys[b]);
  const out = ys.slice();
  let prev = -Infinity;
  for (const i of idx) { out[i] = Math.max(out[i], prev + GAP, PAD - 12); prev = out[i]; }
  let next = Infinity;
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; out[i] = Math.min(out[i], next - GAP, H - PAD - 12); next = out[i]; }
  return out;
}

function columnHtml(col, ruler, shapes, nowMin, H, side) {
  const n = col.items.length;
  // Wanted centre of each tag on the line.
  let fr = ruler ? col.items.map(it => fracOf(it, col, ruler, shapes, nowMin)) : col.items.map(() => null);
  // Unplaced buses (and every bus without a shapes file) keep the cards'
  // order: top → bottom for an up line, bottom → top for a down line.
  if (fr.some(f => f == null)) {
    const even = i => (col.up ? i + 0.5 : n - i - 0.5) / n;
    fr = fr.map((f, i) => f == null ? even(i) : f);
  }
  const want = fr.map(f => PAD + f * (H - 2 * PAD));
  const tops = spread(want.map(y => y - 12), H);
  const x = side === 'left' ? TRACK - 10 : 10;     // the line, toward the middle
  const edge = side === 'left' ? 0 : TRACK;        // where the tags start
  let svg = '<svg class="bl-svg" width="' + TRACK + '" height="' + H + '" viewBox="0 0 ' + TRACK + ' ' + H + '" aria-hidden="true">';
  svg += '<line class="bl-line" x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '"/>';
  // Arrows on the line: which way its buses go.
  for (let y = 60; y < H - 30; y += 120) {
    svg += col.up ? '<path class="bl-chev" d="M' + (x - 4) + ' ' + (y + 3) + ' L' + x + ' ' + (y - 2) + ' L' + (x + 4) + ' ' + (y + 3) + '"/>'
                  : '<path class="bl-chev" d="M' + (x - 4) + ' ' + (y - 3) + ' L' + x + ' ' + (y + 2) + ' L' + (x + 4) + ' ' + (y - 3) + '"/>';
  }
  let pills = '';
  col.items.forEach((it, i) => {
    const c = DOT[it.cls] || DOT.green, yDot = want[i], yTag = tops[i] + 12;
    svg += '<line class="bl-stem" stroke="' + c + '" x1="' + x + '" y1="' + yDot.toFixed(1) + '" x2="' + edge + '" y2="' + yTag.toFixed(1) + '"/>';
    svg += '<circle class="bl-dot" fill="' + c + '" cx="' + x + '" cy="' + yDot.toFixed(1) + '" r="5"/>';
    const tag = '<span class="at-nth ' + esc(it.cls) + '">#' + esc(it.nth || '?') + '</span>';
    const extra = it.layover
      ? '<span class="bl-due">⚓ <span data-due-ms="' + esc(it.dueMs) + '">' + esc(it.dueTxt) + '</span></span>'
      : '<span class="bl-bus' + (it.bus ? '' : ' none') + '">' + esc(it.bus || '—') + '</span>';
    pills += '<button type="button" class="bl-pill bl-' + esc(it.cls) + '" style="top:' + tops[i].toFixed(1) + 'px" tabindex="0" data-tip="' + esc(it.tip) + '">' +
      (side === 'left' ? extra + tag : tag + extra) + '</button>';
  });
  svg += '</svg>';
  const tags = '<div class="bl-tags">' + pills + '</div>';
  return '<div class="bl-col bl-' + side + '" style="height:' + H + 'px">' + (side === 'left' ? tags + svg : svg + tags) + '</div>';
}

export function bothLinesHtml({ shapes, cols, nowMin }) {
  const ruler = rulerOf(shapes, cols);
  const H = Math.max(520, Math.max(...cols.map(c => c.items.length)) * GAP + 2 * PAD + 20);
  // The two ends of the route (the ruler's first and last stop).
  let topStop = '', botStop = '';
  if (ruler) {
    const st = ruler.dir.stops.filter(s => s.d != null).sort((a, b) => a.d - b.d);
    if (st.length) { topStop = st[0].name; botStop = st[st.length - 1].name; }
    if (ruler.flip) [topStop, botStop] = [botStop, topStop];
  }
  const lbl = (col, where) => {
    const show = where === 'top' ? col.up : !col.up;
    return '<div class="bl-lbl' + (show ? '' : ' off') + '">' + (show ? (col.up ? '▲ ' : '') + esc(col.label) + (col.up ? '' : ' ▼') : '') + '</div>';
  };
  const [L, R] = cols;
  let h = '<div class="bl">';
  h += '<div class="bl-row top">' + lbl(L, 'top') + '<div class="bl-end">' + esc(topStop) + '</div>' + lbl(R, 'top') + '</div>';
  h += '<div class="bl-cols">' + columnHtml(L, ruler, shapes, nowMin, H, 'left') + columnHtml(R, ruler, shapes, nowMin, H, 'right') + '</div>';
  h += '<div class="bl-row bot">' + lbl(L, 'bot') + '<div class="bl-end">' + esc(botStop) + '</div>' + lbl(R, 'bot') + '</div>';
  return h + '</div>';
}
