// Leader / Follower view: assets/pa-lf.js fed with mocked TransitView
// answers (assets/pa-lf-mock.js) on route 21's real line (data/shapes/21.json).
//
//   node --test assets/tests/lf.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as LF from '../pa-lf.js';
import { mockTransitView } from '../pa-lf-mock.js';

const shapesJson = JSON.parse(readFileSync(new URL('../../data/shapes/21.json', import.meta.url), 'utf8'));
const shapes = LF.prepShapes(shapesJson);

const WEST = '69th St Transit Center South Terminal', EAST = 'Dock St & Front St';
const trip = (block, s, dir = 0) => ({ tripId: 'T' + block + '-' + s, block, route: '21', dir, s, e: s + 45,
  first: dir === 0 ? WEST : EAST, last: dir === 0 ? EAST : WEST });
// Eastbound every 10 min: 9104 at 5:00, mine (9105) at 5:10, 9106 at 5:20.
// 9106 first comes in westbound (4:30-5:15).
const TRIPS = [trip('9104', 300), trip('9105', 310), trip('9106', 320), trip('9106', 270, 1), trip('9107', 330)];
const MY_TRIP = TRIPS[1];

/** What the page does with one TransitView answer: parse, normalise, build. */
function run(scenario, call = 0) {
  let buses;
  try { buses = mockTransitView(scenario, { shapes, myBlock: '9105', myTrip: MY_TRIP, trips: TRIPS, call }).bus.map(b => LF.normalizeBus(b, '21')); }
  catch (_) { buses = null; }                                  // the feed layer's "no answer"
  return LF.buildLF({ myBlock: '9105', buses, shapes, trips: TRIPS, myTrip: MY_TRIP });
}

test('route 21 line is loaded and buses project onto it', () => {
  const east = LF.dirOf(shapes, 'EastBound');
  assert.equal(east.name, 'Eastbound');
  assert.ok(east.main.len > 6 && east.main.len < 10, 'eastbound line ' + east.main.len + ' mi');
  const p = LF.project(east.main, ...east.main.pts[5]);
  assert.ok(p.off < 0.01);
  assert.equal(LF.dirOf(shapes, 1).name, 'Westbound');
});

test('classify: thresholds are early < -1, on time -1..5, late > 5', () => {
  assert.equal(LF.classify(-2).text, 'EARLY 2 min');
  assert.equal(LF.classify(-1).kind, 'ontime');
  assert.equal(LF.classify(5).text, 'ON TIME');
  assert.equal(LF.classify(6).text, 'LATE 6 min');
  assert.equal(LF.classify(null).text, 'NO LIVE DATA');
  assert.equal(LF.normalizeBus({ BlockID: '1', late: 999 }).late, null, 'not tracking is not 999 min late');
});

test('leader late: live order on the line, late badge, gap from headway and lateness', () => {
  const m = run('leader-late');
  assert.equal(m.mode, 'live');
  assert.equal(m.leader.block, '9104');
  assert.equal(m.follower.block, '9106');
  assert.equal(m.leader.status.text, 'LATE 8 min');
  assert.equal(m.you.status.kind, 'ontime');                // 3 min late is on time
  assert.equal(m.gaps.leader.min, 5);                       // 10 min headway + 3 - 8
  assert.ok(m.gaps.leader.mi > 0);
  assert.match(m.summary, /^Leader 8 min late/);
  assert.match(LF.gapLine('leader', m.gaps.leader), /^Leader about 5 min \/ \d\.\d mi ahead$/);
  assert.ok(m.leader.location.startsWith('near '), m.leader.location);
});

test('follower early: early badge, smaller gap behind', () => {
  const m = run('follower-early');
  assert.equal(m.follower.status.text, 'EARLY 3 min');
  assert.equal(m.gaps.follower.min, 7);                     // 10 - 3
  assert.equal(m.bunching.follower, false);
  assert.match(m.summary, /Follower 3 min early/);
});

test('bunching: follower under 2 min behind is flagged', () => {
  const m = run('bunching');
  assert.equal(m.gaps.follower.min, 1);
  assert.equal(m.bunching.follower, true);
  assert.match(m.summary, /Follower .*1 min behind you, bunching risk/);
});

test('no live data for leader and follower: timetable neighbours, "No live data", not an error', () => {
  const m = run('no-live');
  assert.equal(m.mode, 'live');
  assert.equal(m.leader.block, '9104');
  assert.equal(m.leader.live, false);
  assert.equal(m.leader.status.text, 'NO LIVE DATA');
  assert.equal(m.follower.status.text, 'NO LIVE DATA');
  assert.equal(m.gaps.leader.min, 11);                      // 10 min headway + my 1 min late
  assert.match(m.summary, /Leader no live data/);
});

test('my bus not in service: order from the timetable, live positions where known', () => {
  const m = run('not-in-service');
  assert.equal(m.mode, 'schedule');
  assert.equal(m.you.live, false);
  assert.equal(m.leader.block, '9104');
  assert.equal(m.leader.status.kind, 'ontime');             // 3 min late
  assert.ok(m.leader.d != null && m.gaps.leader.mi != null);
  assert.equal(m.follower.block, '9106');
  assert.equal(m.follower.live, true);
  assert.equal(m.follower.sameDirection, false);            // still coming in westbound
  assert.equal(m.gaps.follower.mi, null);                   // no distance across directions
  assert.equal(m.gaps.follower.min, 10);                    // headway, its westbound lateness ignored
  assert.equal(m.gaps.follower.source, 'schedule');
});

test('a bus at the terminal is not in service yet', () => {
  const east = LF.dirOf(shapes, 0).main;
  const [lat, lng] = east.pts[0];
  const buses = [LF.normalizeBus({ BlockID: '9105', VehicleID: '8001', Direction: 'EastBound', lat, lng, late: 0, trip: MY_TRIP.tripId }, '21')];
  const m = LF.buildLF({ myBlock: '9105', buses, shapes, trips: TRIPS, myTrip: MY_TRIP });
  assert.equal(m.mode, 'schedule');
  assert.equal(m.atTerminal, true);
  assert.equal(m.you.live, true);
});

test('API outage: no crash, outage flagged, timetable neighbours shown without live data', () => {
  const m = run('outage');
  assert.equal(m.outage, true);
  assert.equal(m.mode, 'schedule');
  assert.equal(m.leader.status.kind, 'none');
  assert.match(m.summary, /Live feed not answering/);
});

test('stale: first answer works, later ones fail; data turns stale after 60 s', () => {
  assert.equal(run('stale', 0).outage, false);
  assert.equal(run('stale', 1).outage, true);
  const t0 = 1_000_000;
  assert.equal(LF.freshness(t0, t0 + 59_000).stale, false);
  assert.equal(LF.freshness(t0, t0 + 61_000).stale, true);
  assert.equal(LF.freshness(0, t0).stale, true);
});

test('the countdown never depends on live data', () => {
  const src = readFileSync(new URL('../pa-countdown.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import .*pa-(live|lf)/m, 'pa-countdown.js must not import live modules');
  const lf = readFileSync(new URL('../pa-lf.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lf, /^import .*pa-countdown/m, 'pa-lf.js must not touch the countdown');
});
