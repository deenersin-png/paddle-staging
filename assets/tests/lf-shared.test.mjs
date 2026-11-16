// Leader / Follower on shared lines: short turns and full-length trips on one
// line (42: 61st & Pine / Wycombe Loop; 45: Broad & Oregon / Navy Yard), from
// the real route lines in data/shapes and timetables shaped like the real
// weekday ones. Nothing in pa-lf.js names a route; these only pick examples.
//
//   node --test assets/tests/lf-shared.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as LF from '../pa-lf.js';

const load = r => LF.prepShapes(JSON.parse(readFileSync(new URL('../../data/shapes/' + r + '.json', import.meta.url), 'utf8')));
const s42 = load('42'), s45 = load('45'), s21 = load('21');
const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// ---- route 42 -----------------------------------------------------------------
const WY = 'Wycombe Loop', P61 = '61st St & Pine St Loop', DOCK = '38th Parallel Pl & Dock St - FS';
const t42 = (block, dir, first, last, s, e) => ({ tripId: block + '-' + dir + '-' + s, block, route: '42', dir, s: hm(s), e: hm(e), first, last });
const T42 = [
  // Eastbound, as on weekdays around 7:30: short trips from 61st & Pine
  // between full-length ones from Wycombe Loop.
  t42('9123', 0, P61, DOCK, '7:14', '8:01'),
  t42('9106', 0, WY,  DOCK, '7:17', '8:10'),
  t42('9107', 0, P61, DOCK, '7:32', '8:20'),
  t42('9103', 0, WY,  DOCK, '7:34', '8:30'),
  t42('9109', 0, P61, DOCK, '7:49', '8:39'),
  t42('9116', 0, WY,  DOCK, '7:52', '8:48'),
  // Westbound: short trips end at 61st & Pine, full-length ones go on.
  t42('9112', 1, DOCK, WY,  '7:19', '8:08'),
  t42('9114', 1, DOCK, P61, '7:28', '8:12'),
  t42('9101', 1, DOCK, WY,  '7:37', '8:26'),
  t42('9102', 1, DOCK, P61, '7:45', '8:29'),
  t42('9117', 1, DOCK, WY,  '7:53', '8:42'),
  // 9107 comes in westbound before its 7:32 short trip out of 61st & Pine.
  t42('9107', 1, DOCK, P61, '6:44', '7:28')
];
const trip42 = (block, dir) => T42.find(t => t.block === block && t.dir === dir && !(block === '9107' && dir === 1));

test('42: the ruler is the full line; trips are short turn or full length', () => {
  const east = LF.dirOf(s42, 0);
  const cor = LF.corridorFor(east, T42, '42', east.dir);
  assert.equal(cor.mixed, true);
  const full = LF.patternOf(cor, trip42('9103', 0)), short = LF.patternOf(cor, trip42('9107', 0));
  assert.equal(full.kind, 'full');
  assert.equal(short.kind, 'short');
  assert.ok(short.shortStart && !short.shortEnd, 'the 61st & Pine trips are short at their start');
  assert.ok(short.a > 1 && short.a < 2, '61st & Pine is ' + short.a.toFixed(2) + ' mi along');
  assert.equal(LF.patternInfo(cor, trip42('9107', 0)).text, 'Short turn');
  assert.equal(LF.patternInfo(cor, trip42('9103', 0)).text, 'Full length');
  // A full-length trip reaches 61st & Pine its end time minus a short trip's running time.
  const pr = LF.profileOf(cor, trip42('9103', 0));
  assert.equal(LF.timeOn(pr, short.a), hm('8:30') - 50);   // 9109's 50 min, nearest by end
});

test('42 eastbound, full length from Wycombe: the short turn out of 61st & Pine is the NEXT leader, shown before it pulls out', () => {
  const my = trip42('9103', 0);
  const m = LF.buildLF({ myBlock: '9103', buses: [], shapes: s42, trips: T42, myTrip: my, nowMin: hm('7:25') });
  assert.equal(m.mode, 'schedule');
  assert.equal(m.leader.block, '9106');                    // full length, serves my stops from Wycombe
  assert.equal(m.leader.pattern.text, 'Full length');
  assert.equal(m.you.pattern.text, 'Full length');
  const n = m.next.leader;
  assert.ok(n, 'a next leader');
  assert.equal(n.reason, 'joins');
  assert.equal(n.card.block, '9107');
  assert.equal(n.card.pattern.text, 'Short turn');
  assert.equal(n.at, P61);
  assert.equal(n.whenMin, hm('7:32'));                     // when it pulls out, before I get there
  assert.equal(n.youAtMin, hm('7:40'));
  assert.equal(n.gapMin, 8);
  // Behind me: the 7:49 short turn pulls out after I pass 61st & Pine.
  assert.equal(m.follower.block, '9116');
  assert.equal(m.next.follower.card.block, '9109');
  assert.equal(m.next.follower.reason, 'joins');
  assert.match(m.summary, /next leader pulls out of 61st St & Pine St Loop 7:32 AM/);
});

test('42 eastbound, short turn from 61st & Pine: leader is the full-length bus that passed there before me, not the earlier short turn', () => {
  const my = trip42('9107', 0);
  const m = LF.buildLF({ myBlock: '9107', buses: [], shapes: s42, trips: T42, myTrip: my, nowMin: hm('7:25') });
  assert.equal(m.leader.block, '9106');
  assert.equal(m.leader.pattern.text, 'Full length');
  assert.equal(m.follower.block, '9103');                  // the 7:34 from Wycombe passes 61st & Pine at 7:40
  assert.equal(m.you.pattern.text, 'Short turn');
  assert.equal(m.gaps.leader.min, hm('7:32') - (hm('8:10') - 47));
  assert.equal(m.next.leader, null);                        // the same line to the end
});

test('42 westbound, full length: a short-turn leader ends at 61st & Pine, then the full-length one ahead leads', () => {
  const my = trip42('9101', 1);
  const m = LF.buildLF({ myBlock: '9101', buses: [], shapes: s42, trips: T42, myTrip: my, nowMin: hm('7:30') });
  assert.equal(m.leader.block, '9114');
  assert.equal(m.leader.pattern.text, 'Short turn');
  const n = m.next.leader;
  assert.equal(n.reason, 'ends');
  assert.equal(n.endedBlock, '9114');
  assert.equal(n.card.block, '9112');
  assert.equal(n.card.pattern.text, 'Full length');
  assert.equal(n.at, P61);
  assert.equal(n.whenMin, hm('8:12'));
  assert.equal(n.gapMin, 18);
  assert.equal(m.next.follower.reason, 'ends');            // 9102 behind me ends at 61st & Pine too
  assert.equal(m.next.follower.card.block, '9117');
  assert.match(m.summary, /leader’s trip ends at 61st St & Pine St Loop/);
});

test('42: a short turn whose bus comes in late pulls out behind me instead - it becomes my next follower', () => {
  const west = LF.dirOf(s42, 1).main;
  const [lat, lng] = west.pts[Math.floor(west.pts.length * 0.6)];
  // 9107 still on its westbound trip (due in 7:28), 15 min late: it can't
  // leave 61st & Pine before 7:43, after I pass at 7:40.
  const buses = [LF.normalizeBus({ BlockID: '9107', VehicleID: '3101', Direction: 'WestBound', lat, lng, late: 15 }, '42')];
  const m = LF.buildLF({ myBlock: '9103', buses, shapes: s42, trips: T42, myTrip: trip42('9103', 0), nowMin: hm('7:30') });
  assert.equal(m.leader.block, '9106');
  assert.equal(m.next.leader, null);
  assert.equal(m.next.follower.card.block, '9107');
  assert.equal(m.next.follower.reason, 'joins');
  assert.equal(m.next.follower.whenMin, hm('7:43'));
  assert.equal(m.next.follower.card.live, true);
  assert.equal(m.next.follower.card.sameDirection, false);  // still finishing the westbound trip
});

test('42: my bus live on the line before 61st & Pine still shows the next leader', () => {
  const east = LF.dirOf(s42, 0).main;
  const [lat, lng] = east.pts.find((p, i) => east.cum[i] > 0.5 && east.cum[i] < 1.2);
  const buses = [LF.normalizeBus({ BlockID: '9103', VehicleID: '3102', Direction: 'EastBound', lat, lng, late: 0, trip: '9103-0-' + hm('7:34') }, '42')];
  const m = LF.buildLF({ myBlock: '9103', buses, shapes: s42, trips: T42, myTrip: trip42('9103', 0), nowMin: hm('7:37') });
  assert.equal(m.mode, 'live');
  assert.equal(m.next.leader.card.block, '9107');
  assert.equal(m.next.leader.reason, 'joins');
});

// ---- route 45 -----------------------------------------------------------------
const NAVY = 'Normandy Pl & 11th St', OREGON = 'Broad St & Oregon Av', VINE = '12th St & Vine St';
const t45 = (block, dir, first, last, s, e) => ({ tripId: block + '-' + dir + '-' + s, block, route: '45', dir, s: hm(s), e: hm(e), first, last });
const T45 = [
  t45('7057', 1, NAVY,   VINE, '7:16', '7:55'),
  t45('7058', 1, NAVY,   VINE, '7:35', '8:14'),
  t45('7056', 1, OREGON, VINE, '7:37', '8:04'),
  t45('7053', 1, NAVY,   VINE, '7:54', '8:33'),
  t45('7054', 1, OREGON, VINE, '7:56', '8:23'),
  t45('7059', 0, VINE, OREGON, '7:27', '7:56'),
  t45('7051', 0, VINE, NAVY,   '7:37', '8:17'),
  t45('7060', 0, VINE, NAVY,   '7:17', '7:57')
];

test('45: the ruler reaches the Navy Yard although most trips stop at Broad & Oregon', () => {
  const north = LF.dirOf(s45, 1);
  assert.notEqual(north.rulerId, north.mainId);
  assert.ok(north.main.len > 5, 'line ' + north.main.len.toFixed(1) + ' mi');
  const cor = LF.corridorFor(north, T45, '45', north.dir);
  assert.equal(LF.patternOf(cor, T45[2]).kind, 'short');
  assert.equal(LF.patternOf(cor, T45[1]).kind, 'full');
});

test('45 northbound, full length: the Broad & Oregon short turn is the next leader', () => {
  const m = LF.buildLF({ myBlock: '7058', buses: [], shapes: s45, trips: T45, myTrip: T45[1], nowMin: hm('7:30') });
  assert.equal(m.leader.block, '7057');
  assert.equal(m.next.leader.card.block, '7056');
  assert.equal(m.next.leader.reason, 'joins');
  assert.equal(m.next.leader.at, OREGON);
  assert.equal(m.next.follower.card.block, '7054');
});

test('45 southbound, full length: the short-turn leader ends at Broad & Oregon', () => {
  const m = LF.buildLF({ myBlock: '7051', buses: [], shapes: s45, trips: T45, myTrip: T45[6], nowMin: hm('7:30') });
  assert.equal(m.leader.block, '7059');
  assert.equal(m.next.leader.reason, 'ends');
  assert.equal(m.next.leader.card.block, '7060');
});

// ---- a plain route --------------------------------------------------------------
test('a route with one pattern (21): no tags, no next leader or follower', () => {
  const W = '69th St Transit Center South Terminal', E = 'Dock St & Front St';
  const T = ['9104', '9105', '9106'].map((b, i) => ({ tripId: 'x' + b, block: b, route: '21', dir: 0, s: 300 + 10 * i, e: 345 + 10 * i, first: W, last: E }));
  const m = LF.buildLF({ myBlock: '9105', buses: [], shapes: s21, trips: T, myTrip: T[1], nowMin: 295 });
  assert.equal(m.mixed, false);
  assert.equal(m.leader.block, '9104');
  assert.equal(m.follower.block, '9106');
  assert.equal(m.leader.pattern, null);
  assert.equal(m.next.leader, null);
  assert.equal(m.next.follower, null);
});
