// ==========================================================================
// Paddle App — Leader / Follower logic. Pure: no DOM, no fetching, no clock
// reads (the caller passes nowMs / nowMin), so it can be unit-tested in Node
// and ported to Dart line for line.
//
// INFORMATIONAL ONLY. Nothing here may feed a countdown. The operator's
// countdown is driven by the scheduled time alone (pa-countdown.js), never by
// how late the leader or follower is: operators holding back to match a late
// leader is a known problem, and this view must not encourage it.
//
// Inputs:
//   - live buses, normalised by normalizeBus() from SEPTA TransitView rows
//   - the route line for each direction (data/shapes/<route>.json, built by
//     tools/build-shapes.mjs from GTFS shapes.txt), prepared by prepShapes()
//   - the scheduled trips on the route (pa-schedule loadRouteTrips shape:
//     { tripId, block, route, dir, s, e, first, last } on the GTFS clock)
// Output: buildLF() -> the three cards (leader, you, follower), the gaps,
// bunching flags and one plain-language summary line.
// ==========================================================================

import { leaderForTrip } from './pa-live-cards.js';
import { isPhantomTrip } from './pa-schedule.js';

// ---- thresholds (minutes / miles) -------------------------------------------
export const EARLY_MIN     = 1;      // more than 1 min ahead of schedule -> EARLY
export const LATE_MIN      = 5;      // more than 5 min behind schedule  -> LATE
export const BUNCH_MIN     = 2;      // gap to leader or follower under this -> bunching risk
export const LONG_GAP_MIN  = 5;      // gap this much longer than the scheduled headway -> long gap
export const REFRESH_MS    = 15000;  // live refresh
export const STALE_MS      = 60000;  // data older than this turns gray, with a warning
export const OFF_ROUTE_MI  = 0.5;    // further than this from the line: not on this direction's route
export const TERMINAL_MI   = 0.1;    // this close to either end of the line: at the terminal
export const NEAR_STOP_MI  = 0.4;    // nearest stop further than this: say "next stop" instead
export const DEFAULT_MPH   = 10;     // when the schedule can't give a speed
export const MAX_HEADWAY_MIN = 90;   // a "headway" longer than this is not one

// ---- geometry -----------------------------------------------------------------

const R_MI = 3958.8;
const rad = d => d * Math.PI / 180;

export function haversineMi(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(aLat, aLng, bLat, bLng) {
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** A polyline [[lat,lng],…] with cumulative miles. */
export function prepLine(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineMi(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return { pts, cum, len: cum[cum.length - 1] || 0 };
}

/**
 * Closest point on the line: { d: miles along, off: miles from the line,
 * bearing: the line's direction there }. Flat-earth per segment, which is
 * plenty at city scale.
 */
export function project(line, lat, lng) {
  if (!line || line.pts.length < 2 || !isFinite(lat) || !isFinite(lng)) return null;
  const kx = Math.cos(rad(lat)) * 69.172, ky = 69.0;          // miles per degree
  let best = null;
  for (let i = 0; i < line.pts.length - 1; i++) {
    const [aLat, aLng] = line.pts[i], [bLat, bLng] = line.pts[i + 1];
    const ax = aLng * kx, ay = aLat * ky, bx = bLng * kx, by = bLat * ky, px = lng * kx, py = lat * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || off < best.off) {
      best = { off, d: line.cum[i] + t * (line.cum[i + 1] - line.cum[i]), bearing: bearingDeg(aLat, aLng, bLat, bLng) };
    }
  }
  return best;
}

/**
 * The parsed shapes file, made ready: per direction its main line, every
 * variant line, the stops (each with its distance along the main line), and
 * which trips use a variant.
 */
export function prepShapes(json) {
  if (!json || !json.dirs) return null;
  const dirs = {};
  const altCount = {};
  for (const id of Object.values(json.alt || {})) altCount[id] = (altCount[id] || 0) + 1;
  for (const [dir, d] of Object.entries(json.dirs)) {
    const lines = {};
    for (const [id, pts] of Object.entries(d.shapes || {})) lines[id] = prepLine(pts);
    // The ruler every bus in the direction is measured on: the LONGEST line
    // that real service uses. The most-used line can be the short turn (45:
    // Broad & Oregon, not Navy Yard), and a full-length bus beyond its end
    // would fall off it. Rare lines (garage trips, odd patterns) don't count.
    const maxAlt = Math.max(0, ...Object.keys(lines).map(id => altCount[id] || 0));
    const usable = Object.keys(lines).filter(id => id === d.main || (altCount[id] || 0) >= Math.max(5, 0.15 * maxAlt));
    const rulerId = usable.sort((a, b) => lines[b].len - lines[a].len)[0];
    const main = lines[rulerId] || lines[d.main] || Object.values(lines)[0] || null;
    const stops = (d.stops || []).map(([id, name, lat, lng]) => {
      const p = main ? project(main, lat, lng) : null;
      return { id: String(id), name, lat, lng, d: p ? p.d : null };
    });
    // mostUsed: the line most trips run (what `main` was before the ruler);
    // the Live map keeps drawing estimates on it.
    dirs[dir] = { dir, name: d.name || '', mainId: d.main, rulerId: rulerId || d.main, main, mostUsed: lines[d.main] || main, lines, stops };
  }
  return { v: json.v || '', dirs, alt: json.alt || {} };
}

const normDir = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '').replace(/bound$/, '');

/** The shapes direction for a TransitView name ("EastBound") or a GTFS direction id. */
export function dirOf(shapes, nameOrId) {
  if (!shapes) return null;
  if (shapes.dirs[String(nameOrId)]) return shapes.dirs[String(nameOrId)];
  const n = normDir(nameOrId);
  if (!n) return null;
  return Object.values(shapes.dirs).find(d => normDir(d.name) === n)
      || Object.values(shapes.dirs).find(d => normDir(d.name).startsWith(n) || n.startsWith(normDir(d.name)))
      || null;
}

// ---- TransitView rows -------------------------------------------------------------

/**
 * One TransitView row -> the shape this module works with. `late` is
 * TransitView's minutes behind schedule (negative = early); `Offset` is how
 * many minutes ago the bus last reported its position.
 */
export function normalizeBus(b, routeFallback = '') {
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const lateRaw = num(b.late);
  const notTracking = !!b._notTracking || (lateRaw != null && Math.abs(lateRaw) >= 500) || (num(b.Offset) != null && Math.abs(num(b.Offset)) >= 500);
  return {
    vehicleId: String(b.VehicleID || b.label || '').trim(),
    block: String(b.BlockID || '').trim(),
    route: String(b.route_id || routeFallback || ''),
    direction: String(b.Direction || ''),
    destination: String(b.destination || ''),
    late: notTracking ? null : (lateRaw == null ? null : Math.round(lateRaw)),
    lat: num(b.lat), lng: num(b.lng),
    heading: num(b.heading),
    trip: b.trip != null && b.trip !== '' ? String(b.trip) : '',
    nextStopId: b.next_stop_id != null ? String(b.next_stop_id) : '',
    nextStopName: b.next_stop_name ? String(b.next_stop_name) : '',
    reportAgeMin: num(b.Offset),
    notTracking
  };
}

// ---- status --------------------------------------------------------------------

/** EARLY / ON TIME / LATE from TransitView's minutes-late. */
export function classify(late) {
  if (late == null || !isFinite(late)) return { kind: 'none', min: null, text: 'NO LIVE DATA' };
  if (late < -EARLY_MIN) return { kind: 'early', min: -late, text: 'EARLY ' + (-late) + ' min' };
  if (late > LATE_MIN)   return { kind: 'late',  min: late,  text: 'LATE ' + late + ' min' };
  return { kind: 'ontime', min: late, text: 'ON TIME' };
}

/** "Chestnut St & 52nd St" for a bus: the nearest stop, else its next stop. */
export function locationOf(bus, dirShape) {
  if (!bus) return '';
  const stops = (dirShape && dirShape.stops) || [];
  if (bus.lat != null && bus.lng != null && stops.length) {
    let best = null, bd = Infinity;
    for (const s of stops) {
      const d = haversineMi(bus.lat, bus.lng, s.lat, s.lng);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && bd <= NEAR_STOP_MI) return 'near ' + best.name;
  }
  const next = bus.nextStopName || (stops.find(s => s.id === bus.nextStopId) || {}).name;
  if (next) return 'next stop ' + next;
  return bus.destination ? 'toward ' + bus.destination : '';
}

/** How old the last good live data is. */
export function freshness(fetchedAt, nowMs) {
  if (!fetchedAt) return { ageSec: null, stale: true };
  const ageSec = Math.max(0, Math.round((nowMs - fetchedAt) / 1000));
  return { ageSec, stale: nowMs - fetchedAt > STALE_MS };
}

// ---- schedule order ---------------------------------------------------------------

/**
 * The scheduled follower of a trip: same route and direction, the earliest
 * start after mine — the bus that left MY first stop after me wins, any trip
 * in my direction only when none did. Mirror of leaderForTrip.
 */
export function followerForTrip(allTrips, block, trip, pullIns) {
  let best = null, sameStop = null;
  for (const t of allTrips) {
    if (t.block === String(block) || t.route !== trip.route || t.dir !== trip.dir) continue;
    if (isPhantomTrip(t, pullIns)) continue;
    if (t.s <= trip.s) continue;
    if (!best || t.s < best.s) best = t;
    if (trip.first && t.first === trip.first && (!sameStop || t.s < sameStop.s)) sameStop = t;
  }
  return sameStop || best;
}

// ---- shared lines: short turns, full-length trips, branches ------------------------
//
// Some routes run trips of different lengths on one line: the 42's short
// trips start or end at 61st & Pine while the full-length ones go on to
// Wycombe Loop; the 45's short ones stop at Broad & Oregon; the 23's at
// Germantown & Rising Sun. Nothing below names a route. Every trip PATTERN
// (first stop -> last stop) is placed on the direction's ruler from the route
// data, each trip gets the time it passes every point where a pattern starts
// or ends, and the bus directly ahead of / behind me at a point is the trip
// that passes it last before / first after me.

export const SAME_POINT_MI = 0.15;   // two terminals this close are one point of the line
const ON_LINE_MI     = 0.06;          // a variant line this close to the ruler runs on it
const MAJOR_SHARE    = 0.1;           // patterns with fewer trips than this share don't set "full length"
const REF_WINDOW_MIN = 120;           // a reference trip further off in time than this says nothing
const SAMPLE_MI      = 0.03;

/** "61st St & Pine St Loop" for "61st St & Pine St Loop - FS". */
export const stopLabel = s => String(s || '').replace(/\s*-\s*(FS|NS|MBFS|MBNS|MB)\s*$/i, '').trim();

function stopByName(dirShape, name) {
  const n = stopLabel(name).toLowerCase();
  return dirShape.stops.find(s => s.name === name) || dirShape.stops.find(s => stopLabel(s.name).toLowerCase() === n) || null;
}

function pointOn(line, d) {
  let i = 1;
  while (i < line.cum.length - 1 && line.cum[i] < d) i++;
  const [aLat, aLng] = line.pts[i - 1], [bLat, bLng] = line.pts[i];
  const t = Math.max(0, Math.min(1, (d - line.cum[i - 1]) / ((line.cum[i] - line.cum[i - 1]) || 1)));
  return [aLat + t * (bLat - aLat), aLng + t * (bLng - aLng)];
}

/** Where a variant line meets the ruler, walking in from its start (or its end). */
function meetPoint(ruler, ln, fromEnd) {
  const n = Math.max(1, Math.ceil(ln.len / SAMPLE_MI));
  for (let k = 0; k <= n; k++) {
    const d = fromEnd ? ln.len - k * SAMPLE_MI : k * SAMPLE_MI;
    if (d < 0 || d > ln.len) break;
    const [lat, lng] = pointOn(ln, d);
    const p = project(ruler, lat, lng);
    if (p && p.off <= ON_LINE_MI) return p.d;
  }
  return null;
}

/** A trip's first or last stop on the ruler: { d, onLine } (onLine false = a branch). */
function terminalOn(dirShape, name, end) {
  const ruler = dirShape.main, st = stopByName(dirShape, name);
  if (!ruler || !st) return null;
  const p = project(ruler, st.lat, st.lng);
  if (!p) return null;
  if (p.off <= OFF_ROUTE_MI) return { d: p.d, onLine: true };
  // Off this line: a branch. It shares the line up to where its own line leaves it.
  for (const ln of Object.values(dirShape.lines)) {
    if (ln === ruler || ln.pts.length < 2) continue;
    const tip = end === 'last' ? ln.pts[ln.pts.length - 1] : ln.pts[0];
    if (haversineMi(tip[0], tip[1], st.lat, st.lng) > 2 * SAME_POINT_MI) continue;
    const d = meetPoint(ruler, ln, end === 'last');
    if (d != null) return { d, onLine: false };
  }
  return { d: p.d, onLine: false };
}

function buildCorridor(dirShape, trips, route, dir) {
  const own = trips.filter(t => t.route === route && String(t.dir) === dir);
  const len = dirShape.main.len;
  const patterns = new Map();
  for (const t of own) {
    const k = t.first + '|' + t.last;
    if (!patterns.has(k)) patterns.set(k, { key: k, first: t.first, last: t.last, trips: [] });
    patterns.get(k).trips.push(t);
  }
  for (const p of patterns.values()) {
    const A = terminalOn(dirShape, p.first, 'first'), B = terminalOn(dirShape, p.last, 'last');
    p.a = A ? A.d : 0; p.b = B ? B.d : len;
    p.unknown = !A || !B || p.b <= p.a;                  // can't place it: treat it as the whole line
    if (p.unknown) { p.a = 0; p.b = len; }
    p.branch = !p.unknown && ((A && !A.onLine) || (B && !B.onLine));
    p.trips.sort((x, y) => x.s - y.s);
  }
  const all = [...patterns.values()];
  let major = all.filter(p => !p.unknown && p.trips.length >= MAJOR_SHARE * own.length);
  if (!major.length) major = all;
  const lo = major.length ? Math.min(...major.map(p => p.a)) : 0;
  const hi = major.length ? Math.max(...major.map(p => p.b)) : len;
  for (const p of all) {
    p.shortStart = p.a > lo + SAME_POINT_MI;
    p.shortEnd = p.b < hi - SAME_POINT_MI;
    p.kind = p.branch ? 'branch' : p.shortStart || p.shortEnd ? 'short' : 'full';
  }
  // Every point where a pattern starts or ends, terminals this close merged.
  const points = [];
  for (const p of all) {
    for (const [d, name] of [[p.a, p.first], [p.b, p.last]]) {
      let pt = points.find(q => Math.abs(q.d - d) <= SAME_POINT_MI);
      if (!pt) points.push(pt = { d, name, names: new Set() });
      pt.names.add(name);
    }
  }
  points.sort((x, y) => x.d - y.d);
  return { route, dir, dirShape, patterns, points, lo, hi, profiles: new Map(),
           mixed: all.some(p => p.kind !== 'full') };
}

const corridorMem = new WeakMap();
/**
 * The trip patterns of one route and direction on its ruler, with the points
 * where trips start or end. Cached per trips list (the pages keep one list
 * per service day).
 */
export function corridorFor(dirShape, trips, route, dir) {
  if (!dirShape || !dirShape.main || !Array.isArray(trips) || !trips.length) return null;
  let m = corridorMem.get(trips);
  if (!m) corridorMem.set(trips, m = new Map());
  const key = String(route) + '|' + String(dir);
  let c = m.get(key);
  if (!c || c.dirShape !== dirShape) m.set(key, c = buildCorridor(dirShape, trips, String(route), String(dir)));
  return c;
}

export function patternOf(cor, t) {
  return cor && t ? cor.patterns.get(t.first + '|' + t.last) || null : null;
}

function nearestRef(p, time, field) {
  if (!p) return null;
  let best = null;
  for (const r of p.trips) {
    if (!(r.e > r.s) || Math.abs(r[field] - time) > REF_WINDOW_MIN) continue;
    if (!best || Math.abs(r[field] - time) < Math.abs(best[field] - time)) best = r;
  }
  return best;
}

/**
 * When a trip passes each point of its pattern, timetable only: its start and
 * end, and at a shared point the running time of a trip of the shorter
 * pattern that starts or ends there (a full-length 42 reaches 61st & Pine its
 * end time minus a 61st & Pine short trip's running time). Between known
 * points, in proportion to distance.
 */
export function profileOf(cor, t) {
  if (!cor || !t) return null;
  let pr = cor.profiles.get(t.tripId);
  if (pr) return pr;
  const p = patternOf(cor, t);
  if (!p) return null;
  const anchors = [[p.a, t.s]];
  for (const pt of cor.points) {
    if (pt.d <= p.a + SAME_POINT_MI || pt.d >= p.b - SAME_POINT_MI) continue;
    const vals = [];
    for (const name of pt.names) {
      const r1 = nearestRef(cor.patterns.get(t.first + '|' + name), t.s, 's');
      if (r1) vals.push(t.s + (r1.e - r1.s));
      const r2 = nearestRef(cor.patterns.get(name + '|' + t.last), t.e, 'e');
      if (r2) vals.push(t.e - (r2.e - r2.s));
    }
    if (vals.length) anchors.push([pt.d, vals.reduce((x, y) => x + y, 0) / vals.length]);
  }
  anchors.push([p.b, t.e]);
  anchors.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < anchors.length; i++) anchors[i][1] = Math.min(t.e, Math.max(anchors[i][1], anchors[i - 1][1]));
  pr = { trip: t, pattern: p, a: p.a, b: p.b, anchors };
  cor.profiles.set(t.tripId, pr);
  return pr;
}

/** Scheduled minute the trip passes `d` on the ruler (clamped to its pattern). */
export function timeOn(pr, d) {
  if (!pr) return null;
  const A = pr.anchors;
  d = Math.max(pr.a, Math.min(pr.b, d));
  for (let i = 1; i < A.length; i++) {
    if (d <= A[i][0]) {
      const span = A[i][0] - A[i - 1][0];
      return span > 0 ? A[i - 1][1] + (d - A[i - 1][0]) / span * (A[i][1] - A[i - 1][1]) : A[i][1];
    }
  }
  return A[A.length - 1][1];
}

const KIND_TEXT = { full: 'Full length', short: 'Short turn', branch: 'Branch' };

/** { kind, text, from, to } for a trip on a route with mixed patterns, else null. */
export function patternInfo(cor, t) {
  const p = patternOf(cor, t);
  if (!cor || !cor.mixed || !p) return null;
  return { kind: p.kind, text: KIND_TEXT[p.kind], from: stopLabel(p.first), to: stopLabel(p.last) };
}

// ---- the view model -------------------------------------------------------------

const round1 = n => Math.round(n * 10) / 10;

/** Scheduled speed of a trip along the line, miles per minute. */
function tripSpeed(trip, line) {
  if (trip && line && line.len > 0 && trip.e > trip.s) return line.len / (trip.e - trip.s);
  return DEFAULT_MPH / 60;
}

function placeOn(bus, dirShape, shapes) {
  if (!bus || bus.lat == null || bus.lng == null || !dirShape) return null;
  // A trip on a variant line (short turn, branch) is measured on the main
  // line all the same, so every bus in the direction shares one ruler.
  const p = project(dirShape.main, bus.lat, bus.lng);
  if (!p) return null;
  return { ...p, onRoute: p.off <= OFF_ROUTE_MI, variant: !!(bus.trip && shapes.alt[bus.trip]) };
}

function card(role, { block = '', bus = null, trip = null, dirShape = null, place = null, knownVehicle = '' } = {}) {
  const live = !!bus && !bus.notTracking && bus.lat != null;
  return {
    role, block: block || (bus && bus.block) || '',
    vehicleId: (bus && bus.vehicleId) || knownVehicle || '',
    live,
    late: live ? bus.late : null,
    status: classify(live ? bus.late : null),
    location: live ? locationOf(bus, dirShape) : '',
    lat: live ? bus.lat : null, lng: live ? bus.lng : null,
    heading: live ? (bus.heading != null ? bus.heading : place ? place.bearing : null) : null,
    reportAgeMin: live ? bus.reportAgeMin : null,
    d: place ? place.d : null,
    direction: bus ? bus.direction : '',
    sameDirection: true,
    trip
  };
}

/**
 * Time gap between two buses at the same point of the line. With both trips
 * known it is the scheduled headway corrected by both buses' lateness —
 * leader passes a point at sL + x + lateL, I pass it at sM + x + lateM. Else
 * distance over the scheduled speed. Either way it is an estimate ("about").
 */
function gapBetween(ahead, behind, { line, trips, speed }) {
  const byId = id => id ? trips.find(t => t.tripId === id) : null;
  const ta = ahead.trip || null, tb = behind.trip || null;
  const mi = ahead.d != null && behind.d != null ? round1(Math.max(0, ahead.d - behind.d)) : null;
  let min = null, source = null;
  if (ta && tb && ta.first && ta.first === tb.first) {
    const headway = tb.s - ta.s;
    if (headway > 0 && headway <= MAX_HEADWAY_MIN) {
      // A bus still finishing a trip the other way: its lateness is about
      // that trip, so the scheduled headway stands.
      const lateOf = c => (c.live && c.sameDirection && c.late != null ? c.late : 0);
      const g = headway + lateOf(behind) - lateOf(ahead);
      if (g >= 0) { min = Math.round(g); source = (ahead.live && ahead.sameDirection) || (behind.live && behind.sameDirection) ? 'live' : 'schedule'; }
      return { min, mi, source, headway };
    }
  }
  if (mi != null) { min = Math.round(mi / speed); source = 'distance'; }
  return { min, mi, source, headway: null };
}

/**
 * Everything the view shows, from one round of data.
 *
 * @param o.myBlock   the operator's block (string)
 * @param o.buses     normalised live buses on the operator's route(s), all
 *                    directions; null when the live feed could not be read
 * @param o.shapes    prepShapes() of the current route, or null
 * @param o.trips     scheduled trips on the route(s), GTFS clock
 * @param o.myTrip    the operator's trip in progress or next (GTFS clock)
 * @param o.pullIns   pa-schedule pullInMap (optional)
 * @param o.knownBus  (block, route) -> today's vehicle id from the pairing (optional)
 * @param o.outage    true when the feed is down and `buses` is the last good answer
 * @param o.nowMin    now on the GTFS clock (optional): lets live lateness move
 *                    the shared-line order; without it the order is the timetable's
 */
export function buildLF({ myBlock, buses, shapes, trips = [], myTrip = null, pullIns = null, knownBus = null, outage = null, nowMin = null }) {
  const blk = String(myBlock || '');
  // `outage` may be passed in when `buses` is the LAST good answer, kept
  // while the feed is down.
  if (outage == null) outage = buses == null;
  const list = (buses || []).filter(b => b.block);
  const mine = list.find(b => b.block === blk && !b.notTracking && b.lat != null) || null;
  const known = b => (knownBus ? knownBus(b, (myTrip && myTrip.route) || '') : '') || '';
  const tripById = id => id ? trips.find(t => t.tripId === id) : null;

  // My direction: my bus's, else my scheduled trip's.
  const dirShape = (mine && dirOf(shapes, mine.direction)) || (myTrip && dirOf(shapes, myTrip.dir)) || null;
  const direction = (dirShape && dirShape.name) || (mine && mine.direction) || '';
  const myPlace = mine ? placeOn(mine, dirShape, shapes) : null;
  const myLiveTrip = (mine && tripById(mine.trip)) || null;
  const line = dirShape && dirShape.main;
  const myRef = myLiveTrip || myTrip;
  // Live lateness only counts around my trip (not for a trip hours away).
  const hasNow = nowMin != null && isFinite(nowMin) && (!myRef || (nowMin >= myRef.s - 120 && nowMin <= myRef.e + 30));

  // The trip patterns sharing my direction's line (short turns, full length).
  const route = (myRef && myRef.route) || (mine && mine.route) || '';
  const cor = dirShape && route ? corridorFor(dirShape, trips, route, dirShape.dir) : null;
  const sameLine = t => t && t.route === route && dirShape && String(t.dir) === dirShape.dir;
  const myPr = cor && sameLine(myRef) ? profileOf(cor, myRef) : null;

  // At a terminal: either end of the line, or either end of MY trip (a short
  // turn lays over in the middle of the line).
  const nearEnd = d => d <= TERMINAL_MI || d >= line.len - TERMINAL_MI
    || (!!myPr && (Math.abs(d - myPr.a) <= TERMINAL_MI || Math.abs(d - myPr.b) <= TERMINAL_MI));
  const atTerminal = !!myPlace && !!line && nearEnd(myPlace.d);
  const inService = !!myPlace && myPlace.onRoute && !atTerminal;

  // The trip a live bus is on: its trip id, else its block's trip on this
  // line around now (the feed's trip ids can be from another GTFS version).
  const tripOfBus = b => tripById(b.trip) || (hasNow ? trips
    .filter(t => t.block === b.block && sameLine(t) && t.s - 20 <= nowMin && nowMin <= t.e + 15)
    .sort((x, y) => Math.abs((x.s + x.e) / 2 - nowMin) - Math.abs((y.s + y.e) / 2 - nowMin))[0] || null : null);

  // How far off the timetable a trip runs, in minutes (+ = later), from its
  // bus's place on the line; a bus still finishing an earlier trip pulls out
  // once it gets in. 0 without live data. Informational only.
  const shiftMem = new Map();
  const shiftFor = t => {
    if (!t || !hasNow || !cor) return 0;
    if (shiftMem.has(t.tripId)) return shiftMem.get(t.tripId);
    let v = 0;
    const bus = list.find(b => b.block === t.block && !b.notTracking && b.lat != null);
    const pr = profileOf(cor, t);
    if (bus && pr) {
      const onThis = dirOf(shapes, bus.direction) === dirShape && (!bus.trip || bus.trip === t.tripId || !tripById(bus.trip));
      const p = onThis ? placeOn(bus, dirShape, shapes) : null;
      if (p && p.onRoute) {
        if (p.d <= pr.a + SAME_POINT_MI) v = Math.max(0, nowMin - t.s);          // waiting to pull out
        else v = nowMin - timeOn(pr, p.d);
      } else if (!onThis && bus.late != null) {
        const prev = trips.filter(x => x.block === t.block && x.tripId !== t.tripId && x.e <= t.s + 1)
          .reduce((m, x) => (!m || x.e > m.e ? x : m), null);
        if (prev && t.s - prev.e <= 60) v = Math.max(0, prev.e + bus.late - t.s);
      }
    }
    v = Math.max(-15, Math.min(60, Math.round(v)));
    shiftMem.set(t.tripId, v);
    return v;
  };

  // The other trips on my line that could lead or follow me.
  const cands = !myPr ? [] : trips
    .filter(t => t.block !== blk && sameLine(t) && !isPhantomTrip(t, pullIns) && Math.abs(t.s - myRef.s) <= 180)
    .map(t => ({ trip: t, pr: profileOf(cor, t) }))
    .filter(c => c.pr);
  const myShift = myPr ? shiftFor(myRef) : 0;
  const myTimeAt = d => timeOn(myPr, d) + myShift;
  /** Who passes the point `d` (just past it) last before me / first after me. */
  const neighbourAt = (d, role) => {
    if (!myPr) return null;
    const tm = myTimeAt(d);
    let best = null;
    for (const c of cands) {
      if (!(c.pr.a <= d + SAME_POINT_MI && c.pr.b > d + SAME_POINT_MI)) continue;
      const T = timeOn(c.pr, d) + shiftFor(c.trip);
      const ok = role === 'leader' ? T < tm && tm - T <= MAX_HEADWAY_MIN && (!best || T > best.T)
                                   : T > tm && T - tm <= MAX_HEADWAY_MIN && (!best || T < best.T);
      if (ok) best = { ...c, T, tm };
    }
    return best;
  };

  const you = card('you', { block: blk, bus: mine, trip: myRef, dirShape, place: myPlace, knownVehicle: known(blk) });

  // A timetable neighbour (trip `t`), with its live position when the feed
  // has its block. Its bus may still be finishing a trip the other way.
  const neighbour = (role, t) => {
    if (!t) return null;
    const bus = list.find(b => b.block === t.block) || null;
    const busDir = bus ? dirOf(shapes, bus.direction) : null;
    const place = bus && busDir === dirShape ? placeOn(bus, dirShape, shapes) : null;
    // Its TIMETABLE trip is the one that leads / follows mine (the headway
    // is measured on it), whatever trip its bus is finishing now.
    const c = card(role, { block: t.block, bus, trip: t, dirShape: busDir || dirShape,
                           place: place && place.onRoute ? place : null, knownVehicle: known(t.block) });
    c.sameDirection = !bus || !bus.direction || busDir === dirShape;
    return c;
  };
  const ref = you.trip;
  // Where I am on my trip: my bus on the line, else my first stop.
  const x0 = myPr ? (inService ? Math.max(myPr.a, Math.min(myPr.b, myPlace.d)) : myPr.a) : null;
  // Timetable leader / follower: on a line with several patterns, who passes
  // my point last before / first after me (a full-length 42 that passes 61st
  // & Pine before my short trip leaves it leads me); else the classic rule.
  const schedTrip = role => {
    if (!ref) return null;
    if (myPr) { const n = neighbourAt(x0, role); if (n) return n.trip; }
    return role === 'leader' ? leaderForTrip(trips, blk, ref, pullIns) : followerForTrip(trips, blk, ref, pullIns);
  };
  const schedLeader = () => neighbour('leader', schedTrip('leader'));
  const schedFollower = () => neighbour('follower', schedTrip('follower'));

  let leader = null, follower = null, mode;
  if (inService) {
    // Live order along the line, same route and direction.
    mode = 'live';
    const sameRoute = b => !mine.route || !b.route || b.route === mine.route;
    const live = list
      .filter(b => b.block !== blk && !b.notTracking && b.lat != null && sameRoute(b) && dirOf(shapes, b.direction) === dirShape)
      .map(b => ({ b, p: placeOn(b, dirShape, shapes) }))
      .filter(x => x.p && x.p.onRoute);
    let ahead = null, behind = null;
    for (const x of live) {
      if (x.p.d > myPlace.d && (!ahead || x.p.d < ahead.p.d)) ahead = x;
      if (x.p.d < myPlace.d && (!behind || x.p.d > behind.p.d)) behind = x;
    }
    leader = ahead ? card('leader', { bus: ahead.b, trip: tripOfBus(ahead.b), dirShape, place: ahead.p })
                   : schedLeader();          // nothing live ahead: the timetable's leader, "No live data"
    follower = behind ? card('follower', { bus: behind.b, trip: tripOfBus(behind.b), dirShape, place: behind.p })
                      : schedFollower();
  } else {
    // Not in service yet (layover, terminal, not out, no live data): who
    // leads and follows me by the timetable, with live positions when the
    // feed has those blocks.
    mode = 'schedule';
    leader = schedLeader();
    follower = schedFollower();
    // Where I stand on the line: my bus if it reports, else my first stop.
    if (you.d == null && dirShape && you.trip) {
      const st = dirShape.stops.find(s => s.name === you.trip.first);
      you.d = st && st.d != null ? st.d : 0;
    }
  }

  const speed = tripSpeed(you.trip, line);
  const gaps = {
    leader:   leader   ? gapBetween(leader, you, { line, trips, speed }) : null,
    follower: follower ? gapBetween(you, follower, { line, trips, speed }) : null
  };
  // A gap measured to a bus that isn't on my direction's line yet is not a
  // distance; leave it out rather than mislead.
  if (gaps.leader && !leader.sameDirection) gaps.leader.mi = null;
  if (gaps.follower && !follower.sameDirection) gaps.follower.mi = null;
  const bunching = {
    leader:   !!gaps.leader && gaps.leader.min != null && gaps.leader.min < BUNCH_MIN,
    follower: !!gaps.follower && gaps.follower.min != null && gaps.follower.min < BUNCH_MIN
  };
  const longGap = !!gaps.leader && gaps.leader.min != null && gaps.leader.headway != null
    && gaps.leader.min >= gaps.leader.headway + LONG_GAP_MIN;

  // ---- the next leader / follower on a shared line ----
  // Walk my trip ahead from where I am. At each point where a pattern starts
  // or ends, who leads (follows) me from there on? The first change that is
  // a short turn pulling out ahead of (behind) me, or my leader (follower)
  // ending its trip, is the NEXT one - shown before it happens.
  const upcoming = (role, current) => {
    if (!myPr || !cor.mixed) return null;
    const blockOf = n => (n ? n.trip.block : null);
    const curBlock = current ? current.block : null;
    let prev = neighbourAt(x0, role);
    // A follower that ends its trip before it gets to me leaves the line behind me.
    if (role === 'follower' && current && current.trip) {
      const cp = profileOf(cor, current.trip);
      if (cp && cp.b < x0 - SAME_POINT_MI && prev && prev.trip.block !== curBlock) {
        return nextOf(role, prev, { reason: 'ends', at: current.trip.last, ended: current.trip, endT: timeOn(cp, cp.b) + shiftFor(current.trip) });
      }
    }
    for (const pt of cor.points) {
      if (pt.d <= x0 + SAME_POINT_MI || pt.d >= myPr.b - SAME_POINT_MI) continue;
      const nx = neighbourAt(pt.d, role);
      if (blockOf(nx) !== blockOf(prev) && blockOf(nx) !== curBlock) {
        const joins = !!nx && Math.abs(nx.pr.a - pt.d) <= SAME_POINT_MI;
        const ends = !!prev && Math.abs(prev.pr.b - pt.d) <= SAME_POINT_MI;
        if (joins || ends) {
          return nextOf(role, nx, joins
            ? { reason: 'joins', at: nx.trip.first, d: pt.d }
            : { reason: 'ends', at: prev.trip.last, d: pt.d, ended: prev.trip, endT: timeOn(prev.pr, prev.pr.b) + shiftFor(prev.trip) });
        }
      }
      prev = nx;
    }
    return null;
  };
  const nextOf = (role, n, ev) => {
    const c = n ? neighbour(role, n.trip) : null;
    if (c) c.pattern = patternInfo(cor, c.trip);
    const youAt = ev.d != null ? myTimeAt(ev.d) : null;
    return {
      role, card: c, reason: ev.reason, at: stopLabel(ev.at),
      // joins: when it pulls out there; ends: when the old one gets to its end
      whenMin: ev.reason === 'joins' ? n.T : ev.endT != null ? ev.endT : null,
      youAtMin: youAt,
      // the gap from that point on, by the timetable (+ live lateness)
      gapMin: n && youAt != null ? Math.round(Math.abs(youAt - (timeOn(n.pr, ev.d) + shiftFor(n.trip)))) : n ? Math.round(Math.abs(n.tm - n.T)) : null,
      endedBlock: ev.ended ? ev.ended.block : null,
      endedPattern: ev.ended ? patternInfo(cor, ev.ended) : null
    };
  };
  const next = { leader: upcoming('leader', leader), follower: upcoming('follower', follower) };

  // Short turn / full length on every card, when the line has both.
  for (const c of [you, leader, follower]) if (c) c.pattern = patternInfo(cor, c.trip);

  // Different patterns don't share a first stop, so their headway can't come
  // from start times: measure it at the point where the bus behind is.
  for (const [role, ahead, behind] of [['leader', leader, you], ['follower', you, follower]]) {
    const g = gaps[role];
    if (!g || g.headway != null || !cor || !ahead || !behind || !ahead.trip || !behind.trip || ahead.trip.first === behind.trip.first) continue;
    const pa = profileOf(cor, ahead.trip), pb = profileOf(cor, behind.trip);
    if (!pa || !pb) continue;
    const lo = Math.max(pa.a, pb.a), hi = Math.min(pa.b, pb.b);
    if (lo >= hi) continue;
    const at = Math.max(lo, Math.min(hi, behind.d != null ? behind.d : pb.a));
    const sh = c => (c === you ? myShift : shiftFor(c.trip));
    const v = timeOn(pb, at) + sh(behind) - (timeOn(pa, at) + sh(ahead));
    if (v >= 0 && v <= MAX_HEADWAY_MIN) {
      g.min = Math.round(v);
      g.source = (ahead.live && ahead.sameDirection) || (behind.live && behind.sameDirection) ? 'live' : 'schedule';
      bunching[role] = g.min < BUNCH_MIN;
    }
  }

  const model = { mode, outage, direction, inService, atTerminal, you, leader, follower, gaps, bunching, longGap,
                  next, mixed: !!(cor && cor.mixed), line: line ? line.pts : null };
  model.summary = summarize(model);
  return model;
}

// ---- words ----------------------------------------------------------------------------

/** "5:06 AM" for a GTFS-clock minute (24:xx wraps). */
export function clockText(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return h + ':' + mm + ' ' + ap;
}

/** "about 6 min / 1.2 mi" */
export function gapText(g) {
  if (!g) return '';
  const parts = [];
  if (g.min != null) parts.push(g.min + ' min');
  if (g.mi != null) parts.push(g.mi.toFixed(1) + ' mi');
  return parts.length ? 'about ' + parts.join(' / ') : '';
}

/** "Leader about 6 min / 1.2 mi ahead" / "Follower about 3 min / 0.5 mi behind" */
export function gapLine(role, g, sched) {
  const t = gapText(g);
  const who = role === 'leader' ? 'Leader' : 'Follower';
  const where = role === 'leader' ? 'ahead' : 'behind';
  if (!t) return sched ? who + ' ' + where + ' by the timetable' : '';
  return who + ' ' + t + ' ' + where + (g.source === 'schedule' ? ' (scheduled)' : '');
}

function statusWords(c) {
  const s = c.status;
  if (s.kind === 'late') return s.min + ' min late';
  if (s.kind === 'early') return s.min + ' min early';
  if (s.kind === 'ontime') return 'on time';
  return 'no live data';
}

/** One plain-language line, e.g. "Leader 8 min late, long gap ahead". */
export function summarize(m) {
  const parts = m.outage ? ['Live feed not answering'] : [];
  const L = m.leader, F = m.follower, gL = m.gaps.leader, gF = m.gaps.follower;
  // "Leader 8 min late, 2 min ahead of you, bunching risk" - the status is
  // left out of a bunching warning when it is plain "on time".
  const close = (c, g, where) => (c.status.kind === 'ontime' || c.status.kind === 'none' ? '' : statusWords(c) + ', ')
    + (g.min <= 0 ? 'right ' + where + ' you' : g.min + ' min ' + where + ' you') + ', bunching risk';
  // "next leader pulls out of 61st St & Pine St Loop 5:06 AM" / "leader's trip ends at …"
  const nextWords = (n, who) => {
    if (!n) return '';
    if (n.reason === 'joins') return ', next ' + who + ' pulls out of ' + n.at + (n.whenMin != null ? ' ' + clockText(n.whenMin) : '');
    return ', ' + who + '’s trip ends at ' + n.at;
  };
  const nx = m.next || {};
  if (!L) parts.push('No bus ahead of you' + nextWords(nx.leader, 'leader'));
  else if (m.bunching.leader) parts.push('Leader ' + close(L, gL, 'ahead of') + nextWords(nx.leader, 'leader'));
  else parts.push('Leader ' + statusWords(L) + (m.longGap ? ', long gap ahead' : '') + nextWords(nx.leader, 'leader'));
  if (!F) parts.push('no bus behind you' + nextWords(nx.follower, 'follower'));
  else if (m.bunching.follower) parts.push('Follower ' + close(F, gF, 'behind') + nextWords(nx.follower, 'follower'));
  else parts.push('Follower ' + statusWords(F) + nextWords(nx.follower, 'follower'));
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
