// The email itself: what it says, what it escapes, and how it degrades.
//
//   npm --prefix functions test

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmail, subjectFor, lateText } from '../lib/email.js';

const RUN = { pullOutMin: 883, finishMin: 1342, payHours: 9.1, routes: ['44'], pieces: [{ routeLabel: '44', block: '9663', startMin: 883, endMin: 1339 }] };
const LEADER = { block: '9659', vehicleId: '3651', late: 4, nextStop: 'City Ave', destination: 'Ardmore' };
const live = (over = {}) => ({ routes: ['44'], leader: LEADER, leaderTrip: { s: 875 }, detours: [], detoursFailed: [], ...over });
const base = (over = {}) => ({
  resolved: { date: '2026-09-23', runNo: '209', dayType: 'weekday' },
  run: RUN, reportMin: 869, minutesAway: 2, live: live(),
  profile: { depotLabel: 'Callowhill Bus', depotKey: 'callowhillb' },
  appUrl: 'https://example.test/home.html',
  ...over
});

test('lateText says late, early or on time', () => {
  assert.equal(lateText(4), '4 min late');
  assert.equal(lateText(-3), '3 min early');
  assert.equal(lateText(0), 'on time');
  assert.equal(lateText(null), null);
});

test('the subject carries the three things worth seeing on a lock screen', () => {
  assert.equal(subjectFor(base()), 'Run 209 · report 2:29 PM · in 2 min · leader 4 min late');
  assert.equal(subjectFor(base({ live: live({ leader: { ...LEADER, late: 0 }, detours: [{}, {}] }) })), 'Run 209 · report 2:29 PM · in 2 min · 2 detours');
  assert.equal(subjectFor(base({ live: live({ leader: null }), minutesAway: 0 })), 'Run 209 · report 2:29 PM · now');
});

test('a run number cannot start a new email header', () => {
  const s = subjectFor(base({ resolved: { date: '2026-09-23', runNo: '209\r\nBcc: evil@x.com', dayType: 'weekday' } }));
  assert.doesNotMatch(s, /[\r\n]/);
  assert.match(s, /^Run 209/);
});

test('everything SEPTA or the operator wrote is escaped', () => {
  const m = buildEmail(base({
    resolved: { date: '2026-09-23', runNo: '<b>9</b>', dayType: 'weekday' },
    live: live({ detours: [{ routeId: '44', direction: 'EB', reason: '<script>alert(1)</script>', message: 'a & b "c"', startLocation: '<i>x</i>' }] })
  }));
  assert.match(m.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(m.html, /a &amp; b &quot;c&quot;/);
  assert.doesNotMatch(m.html, /<script>/);
  assert.doesNotMatch(m.html, /<b>9<\/b>/);
});

test('with everything available it names the bus ahead and the detours', () => {
  const m = buildEmail(base({ live: live({ detours: [{ routeId: '44', direction: 'WB', reason: 'Construction', message: 'Until further notice' }] }) }));
  assert.match(m.html, /9659/);
  assert.match(m.html, /bus 3651/);
  assert.match(m.html, /4 min late/);
  assert.match(m.html, /Construction/);
  assert.match(m.text, /Block 9659 · bus 3651 · 4 min late/);
  assert.match(m.text, /Route 44 · WB — Construction/);
});

test('it says so plainly when something could not be looked up', () => {
  assert.match(buildEmail(base({ live: live({ leader: null }) })).html, /No bus is scheduled ahead of you/);
  assert.match(buildEmail(base({ live: live({ leader: null, leaderUnavailable: true }) })).html, /Could not load the bus ahead/);
  assert.match(buildEmail(base({ live: live({ detoursFailed: ['44'] }) })).html, /Could not reach SEPTA/);
  assert.match(buildEmail(base({ live: live() })).html, /No detours on your routes/);
  assert.match(buildEmail(base({ live: live({ leader: { ...LEADER, offline: true, late: null } }) })).html, /Not sending live data right now/);
  assert.match(buildEmail(base({ run: null, live: live({ routes: [], leader: null }) })).html, /not in the Callowhill Bus weekday paddle/);
});

test('it always carries a plain-text copy and a way back into the app', () => {
  const m = buildEmail(base());
  assert.match(m.text, /^RUN 209/);
  assert.match(m.text, /Report 2:29 PM \(in 2 min\)/);
  assert.match(m.html, /href="https:\/\/example\.test\/home\.html"/);
});
