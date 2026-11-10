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
  for (const [dir, d] of Object.entries(json.dirs)) {
    const lines = {};
    for (const [id, pts] of Object.entries(d.shapes || {})) lines[id] = prepLine(pts);
    const main = lines[d.main] || Object.values(lines)[0] || null;
    const stops = (d.stops || []).map(([id, name, lat, lng]) => {
      const p = main ? project(main, lat, lng) : null;
      return { id: String(id), name, lat, lng, d: p ? p.d : null };
    });
    dirs[dir] = { dir, name: d.name || '', mainId: d.main, main, lines, stops };
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
 */
export function buildLF({ myBlock, buses, shapes, trips = [], myTrip = null, pullIns = null, knownBus = null, outage = null }) {
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
  const atTerminal = !!myPlace && !!line && (myPlace.d <= TERMINAL_MI || myPlace.d >= line.len - TERMINAL_MI);
  const inService = !!myPlace && myPlace.onRoute && !atTerminal;

  const you = card('you', { block: blk, bus: mine, trip: myLiveTrip || myTrip, dirShape, place: myPlace, knownVehicle: known(blk) });

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
  const schedLeader = () => neighbour('leader', ref ? leaderForTrip(trips, blk, ref, pullIns) : null);
  const schedFollower = () => neighbour('follower', ref ? followerForTrip(trips, blk, ref, pullIns) : null);

  let leader = null, follower = null, mode;
  if (inService) {
    // Live order along the line, same route and direction.
    mode = 'live';
    const sameRoute = b => !mine.route || !b.route || b.route === mine.route;
    const cands = list
      .filter(b => b.block !== blk && !b.notTracking && b.lat != null && sameRoute(b) && dirOf(shapes, b.direction) === dirShape)
      .map(b => ({ b, p: placeOn(b, dirShape, shapes) }))
      .filter(x => x.p && x.p.onRoute);
    let ahead = null, behind = null;
    for (const x of cands) {
      if (x.p.d > myPlace.d && (!ahead || x.p.d < ahead.p.d)) ahead = x;
      if (x.p.d < myPlace.d && (!behind || x.p.d > behind.p.d)) behind = x;
    }
    leader = ahead ? card('leader', { bus: ahead.b, trip: tripById(ahead.b.trip), dirShape, place: ahead.p })
                   : schedLeader();          // nothing live ahead: the timetable's leader, "No live data"
    follower = behind ? card('follower', { bus: behind.b, trip: tripById(behind.b.trip), dirShape, place: behind.p })
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

  const model = { mode, outage, direction, inService, atTerminal, you, leader, follower, gaps, bunching, longGap,
                  line: line ? line.pts : null };
  model.summary = summarize(model);
  return model;
}

// ---- words ----------------------------------------------------------------------------

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
  if (!L) parts.push('No bus ahead of you');
  else if (m.bunching.leader) parts.push('Leader ' + close(L, gL, 'ahead of'));
  else parts.push('Leader ' + statusWords(L) + (m.longGap ? ', long gap ahead' : ''));
  if (!F) parts.push('no bus behind you');
  else if (m.bunching.follower) parts.push('Follower ' + close(F, gF, 'behind'));
  else parts.push('Follower ' + statusWords(F));
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
