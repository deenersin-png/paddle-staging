// ==========================================================================
// Paddle App — mocked SEPTA TransitView answers for the Leader / Follower
// view. Pure (no DOM, no fetching), used by the Node tests and by the
// staging pages' ?lfmock=<scenario> switch, so every scenario runs through
// the same parsing and logic as real data.
//
// Buses are laid on the operator's real route line and named after the real
// timetable neighbours (leader / follower blocks and trip ids), so the
// headway-based gaps come out the way they would on the road.
// ==========================================================================

import { dirOf, followerForTrip } from './pa-lf.js';
import { leaderForTrip } from './pa-live-cards.js';

export const SCENARIOS = {
  'leader-late':    'Leader 8 min late, you 3 min late, follower on time',
  'follower-early': 'Follower 3 min early, leader on time',
  'bunching':       'Follower closing in on you (bunching)',
  'no-live':        'Only your bus reports — leader and follower have no live data',
  'not-in-service': 'Your bus is not out yet — order from the timetable',
  'outage':         'TransitView not answering at all',
  'stale':          'Live data once, then the feed stops (turns gray after 60 s)'
};

const DEFAULT_HEADWAY = 10;

function pointAt(line, d) {
  d = Math.max(0, Math.min(line.len, d));
  let i = 1;
  while (i < line.cum.length - 1 && line.cum[i] < d) i++;
  const [aLat, aLng] = line.pts[i - 1], [bLat, bLng] = line.pts[i];
  const seg = line.cum[i] - line.cum[i - 1] || 1;
  const t = (d - line.cum[i - 1]) / seg;
  const lat = aLat + t * (bLat - aLat), lng = aLng + t * (bLng - aLng);
  const y = Math.sin((bLng - aLng) * Math.PI / 180) * Math.cos(bLat * Math.PI / 180);
  const x = Math.cos(aLat * Math.PI / 180) * Math.sin(bLat * Math.PI / 180) - Math.sin(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.cos((bLng - aLng) * Math.PI / 180);
  return { lat, lng, heading: Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360) };
}

/**
 * The raw TransitView JSON ({ bus: [...] }) for a scenario, or a thrown
 * error for the outage cases — exactly what the JSONP callback would hand
 * pa-live.js.
 *
 * @param scenario  a key of SCENARIOS
 * @param o.shapes  prepShapes() of the route
 * @param o.myBlock, o.myTrip (GTFS clock), o.trips (route's scheduled trips), o.pullIns
 * @param o.call    0 for the first request of the page, 1, 2, … after
 */
export function mockTransitView(scenario, { shapes, myBlock, myTrip, trips = [], pullIns = null, call = 0 }) {
  if (scenario === 'outage' || (scenario === 'stale' && call > 0)) throw new Error('mock: TransitView not answering');
  const sc = scenario === 'stale' ? 'leader-late' : scenario;
  const dirShape = myTrip ? dirOf(shapes, myTrip.dir) : null;
  if (!dirShape || !dirShape.main || !myTrip) return { bus: [] };
  const line = dirShape.main;
  const other = Object.values(shapes.dirs).find(d => d !== dirShape && d.main) || null;
  const route = String(myTrip.route || '');
  const speed = line.len > 0 && myTrip.e > myTrip.s ? line.len / (myTrip.e - myTrip.s) : 10 / 60;

  const lt = leaderForTrip(trips, myBlock, myTrip, pullIns);
  const ft = followerForTrip(trips, myBlock, myTrip, pullIns);
  const hw = (a, b) => (a && b && a.first === b.first && b.s - a.s > 0 && b.s - a.s <= 90 ? b.s - a.s : DEFAULT_HEADWAY);
  const hL = hw(lt, myTrip), hF = hw(myTrip, ft);

  let vid = 8800;
  const row = (block, trip, d, late, dir = dirShape, ln = line) => {
    const p = pointAt(ln, d);
    return {
      lat: p.lat.toFixed(6), lng: p.lng.toFixed(6), label: String(++vid), route_id: route,
      trip: trip ? trip.tripId : '', VehicleID: String(vid), BlockID: String(block),
      Direction: dir.name, destination: (trip && trip.last) || '', heading: p.heading, late,
      next_stop_id: null, next_stop_name: null, next_stop_sequence: 10,
      estimated_seat_availability: 'NOT_AVAILABLE', Offset: 1, Offset_sec: '40', timestamp: 1794306000
    };
  };
  const leaderBlock = lt ? lt.block : '9990', followerBlock = ft ? ft.block : '9991';
  const myD = line.len * 0.45;
  // Time gap at a point = headway + lateness behind - lateness ahead; lay the
  // buses out at that gap times the scheduled speed so both measures agree.
  const ahead = (late, myLate) => myD + Math.max(0.3, hL + myLate - late) * speed;
  const behind = (late, myLate) => myD - Math.max(0.3, hF + late - myLate) * speed;

  const bus = [];
  if (sc === 'leader-late') {
    bus.push(row(myBlock, myTrip, myD, 3), row(leaderBlock, lt, ahead(8, 3), 8), row(followerBlock, ft, behind(0, 3), 0));
  } else if (sc === 'follower-early') {
    bus.push(row(myBlock, myTrip, myD, 0), row(leaderBlock, lt, ahead(0, 0), 0), row(followerBlock, ft, behind(-3, 0), -3));
  } else if (sc === 'bunching') {
    const fLate = 4 - hF + 1;                       // 1 min behind me
    bus.push(row(myBlock, myTrip, myD, 4), row(leaderBlock, lt, ahead(1, 4), 1), row(followerBlock, ft, behind(fLate, 4), fLate));
  } else if (sc === 'no-live') {
    bus.push(row(myBlock, myTrip, myD, 1));
  } else if (sc === 'not-in-service') {
    // Leader already out on its trip; follower still finishing a trip the
    // other way (its lateness belongs to that trip).
    bus.push(row(leaderBlock, lt, Math.min(line.len * 0.3, hL * speed), 3));
    if (other) {
      const prev = trips.filter(t => t.block === followerBlock && t.dir !== myTrip.dir && ft && t.s < ft.s).pop() || null;
      bus.push(row(followerBlock, prev, other.main.len * 0.7, 2, other, other.main));
    }
  }
  return { bus };
}
