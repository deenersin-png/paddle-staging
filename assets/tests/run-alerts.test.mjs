// Phone alerts for a run: planning only (no Firebase).
//
//   node --test assets/tests/run-alerts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { planRunAlerts, upcomingRuns, runDepartures, syncRunAlerts, testAlert, TEST_DELAY_MIN, DEFAULTS } from '../pa-run-alerts.js';
import { minToMs, normalizeRun } from '../pa-schedule.js';

const NOW = minToMs('2026-10-27', 600);          // Tue 10:00 AM
const day = (date, reportMin, extra = {}) => ({ date, runNo: '209', reportMin, routeLabel: '21-42', ...extra });
const REPORTS_ONLY = { depOn: false };

test('defaults: report 30 and 1 min before, every departure on time', () => {
  assert.deepEqual(DEFAULTS, { report1On: true, report1Lead: 30, report2On: true, report2Lead: 1, depOn: true, depLead: 0 });
  const a = planRunAlerts([day('2026-10-28', 330, { departures: [{ min: 345, what: 'pull-out', where: '21-42 · block 9101' }] })], {}, NOW);
  assert.deepEqual(a.map(x => [x.key, x.sendAtMs]), [
    ['rep1', minToMs('2026-10-28', 300)],
    ['rep2', minToMs('2026-10-28', 329)],
    ['d' + (345 + 1440), minToMs('2026-10-28', 345)]
  ]);
  assert.equal(a[0].title, 'Run 209 · report in 30 min');
  assert.equal(a[0].body, 'Report 5:30 AM · 21-42 · Wed 10/28');
  assert.equal(a[1].title, 'Run 209 · report in 1 min');
  assert.equal(a[2].title, 'Run 209 · pull-out now');
  assert.equal(a[2].body, '5:45 AM · 21-42 · block 9101');
});

test('each alert has its own lead time and its own switch', () => {
  const d = [day('2026-10-28', 330, { departures: [{ min: 400, what: 'departure', where: 'from Olney · 21-42' }] })];
  const a = planRunAlerts(d, { report1Lead: 45, report2On: false, depLead: 2 }, NOW);
  assert.deepEqual(a.map(x => x.title), ['Run 209 · report in 45 min', 'Run 209 · departure in 2 min']);
  assert.equal(a[1].sendAtMs, minToMs('2026-10-28', 398));
  assert.equal(planRunAlerts(d, { report1On: false, report2On: false, depOn: false }, NOW).length, 0);
});

test('two alerts due at the same moment are sent once', () => {
  const a = planRunAlerts([day('2026-10-28', 330)], { report1Lead: 5, report2Lead: 5, depOn: false }, NOW);
  assert.equal(a.length, 1);
});

test('past and too-soon alerts are left out', () => {
  const a = planRunAlerts([
    day('2026-10-27', 540),   // earlier today
    day('2026-10-27', 630),   // 30-min alert at 10:00, now
    day('2026-10-27', 700)    // 30-min alert at 11:10
  ], { report2On: false, depOn: false }, NOW);
  assert.deepEqual(a.map(x => x.sendAtMs), [minToMs('2026-10-27', 670)]);
});

test('a night liner filed under tomorrow alerts the evening before', () => {
  // Run 51 Callowhill as the weekday CSV has it: start filed the day before.
  const row = { runno: '51', start: '2023-10-10 11:54 PM', finish: '2023-10-11 9:13 AM', pay: '9.7',
                r1: 'L1 OWL', b1: '9901', potype1: 'O', pot1: '12:08 AM', pitype1: 'CG', pit1: '05:30 AM', _dayOffset: -1 };
  const run = normalizeRun(row, 'weekday');
  assert.equal(run.reportMin, -6);
  assert.equal(run.pullOutMin, 8);
  const [a] = planRunAlerts([day('2026-10-29', run.reportMin)], REPORTS_ONLY, NOW);
  assert.equal(a.sendAtMs, minToMs('2026-10-28', 1434 - 30));   // Wed 11:24 PM for Thursday's run
  assert.equal(new Date(a.sendAtMs).getDate(), 28);
  assert.equal(a.body, 'Report 11:54 PM · 21-42 · Thu 10/29');
});

test('a just-after-midnight report alerts the evening before', () => {
  const [a] = planRunAlerts([day('2026-10-29', 29)], { report1Lead: 60, report2On: false }, NOW);
  assert.equal(a.sendAtMs, minToMs('2026-10-28', 1409));     // 11:29 PM Wednesday
});

test('a lead that is not a number falls back to the default', () => {
  const [a] = planRunAlerts([day('2026-10-28', 600)], { report1Lead: 'x', report2On: false, depOn: false }, NOW);
  assert.match(a.title, new RegExp('in ' + DEFAULTS.report1Lead + ' min'));
});

test('departures: pull-out, each trip inside a piece, the next piece, one per minute', async () => {
  const run = { dayType: 'weekday', pieces: [
    { routeLabel: '21', block: '9101', startMin: 345, endMin: 600 },
    { routeLabel: '42', block: '9202', startMin: 900, endMin: 1100 }
  ] };
  const trips = { 9101: [{ s: 360, first: 'Olney' }, { s: 360, first: 'Olney' }, { s: 450, first: '63rd' }, { s: 610, first: 'late' }], 9202: [] };
  const d = await runDepartures(run, p => trips[p.block]);
  assert.deepEqual(d.map(x => [x.min, x.what]), [[345, 'pull-out'], [360, 'departure'], [450, 'departure'], [900, 'next piece']]);
  assert.equal(d[1].where, 'from Olney · 21');
});

test('upcomingRuns skips days off, uses the run\'s report time, departures only for the first days', async () => {
  const days = await upcomingRuns({
    from: '2026-10-27', n: 4, depDays: 2,
    resolve: d => (d === '2026-10-28' ? { off: true } : { runNo: '209', reportMin: null }),
    runFor: async () => ({ dayType: 'weekday', reportMin: 330, pieces: [{ routeLabel: '21-42', block: '9101', startMin: 345, endMin: 600 }] }),
    tripsOf: async () => [{ s: 400, first: 'Olney' }]
  });
  assert.deepEqual(days.map(d => d.date), ['2026-10-27', '2026-10-29', '2026-10-30']);
  assert.equal(days[0].routeLabel, '21-42');
  assert.equal(days[0].reportMin, 330);
  assert.equal(days[0].departures.length, 2);
  assert.equal(days[1].departures, undefined);       // day 3 of the window: no departures planned yet
});

test('titles and bodies fit the database rules', () => {
  const long = 'x'.repeat(300);
  const [a] = planRunAlerts([day('2026-10-28', 330, { departures: [{ min: 400, what: 'departure', where: long }] })], { report1On: false, report2On: false }, NOW);
  assert.ok(a.title.length <= 80 && a.body.length <= 200);
});

test('the test alert is due a couple of minutes out and never looks like a run', () => {
  const a = testAlert(NOW);
  assert.equal(a.date, 'test');
  assert.equal(a.sendAtMs, NOW + TEST_DELAY_MIN * 60000);
  assert.ok(a.sendAtMs - NOW <= 600000, 'the rules only allow ten minutes out');
  assert.ok(!/^Run /.test(a.title));
  assert.ok(a.title.length <= 80 && a.body.length <= 200);
});

// ---- syncRunAlerts against a stand-in Firestore ------------------------------

// Just enough of the Firestore web SDK: docs by path, batches, one where().
function fakeFirestore() {
  const store = new Map();
  const pathOf = (base, ...seg) => [base && base.path, ...seg].filter(Boolean).join('/');
  const F = {
    store,
    collection: (_db, name) => ({ path: name }),
    doc: (base, ...seg) => ({ path: base && base.path ? pathOf(base, ...seg) : seg.join('/') }),
    where: (field, _op, value) => ({ field, value }),
    query: (col, w) => ({ col, w }),
    serverTimestamp: () => 'TS',
    async getDoc(ref) { const v = store.get(ref.path); return { exists: () => v !== undefined, data: () => v }; },
    async getDocs(q) {
      const hits = [...store].filter(([k, v]) => k.startsWith(q.col.path + '/') && v[q.w.field] === q.w.value);
      return { forEach: f => hits.forEach(([k, v]) => f({ id: k.slice(q.col.path.length + 1), data: () => v })) };
    },
    writeBatch() {
      const ops = [];
      return { set: (r, v) => ops.push(() => store.set(r.path, v)), delete: r => ops.push(() => store.delete(r.path)),
               async commit() { ops.forEach(f => f()); } };
    }
  };
  return F;
}
// Each "device" has its own localStorage.
function device() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const alertIds = F => [...F.store.keys()].filter(k => k.startsWith('runAlerts/')).sort();
const DAYS = [day('2026-10-28', 330, { departures: [{ min: 345, what: 'pull-out', where: 'block 9101' }, { min: 400, what: 'departure', where: '21' }] })];

test('a phone puts back alerts another device deleted behind its back', async () => {
  const F = fakeFirestore(), phone = device(), laptop = device();
  const sync = (ls, args) => { globalThis.localStorage = ls; return syncRunAlerts({ db: {}, uid: 'deen', settings: {}, now: NOW, firestore: F, ...args }); };
  await sync(phone, { enabled: true, days: DAYS });
  const full = alertIds(F);
  assert.equal(full.length, 4);
  // The laptop planned with no departures (its trips failed before this fix) and deleted them.
  await sync(laptop, { enabled: true, days: [day('2026-10-28', 330)] });
  assert.equal(alertIds(F).length, 2);
  // Before: the phone's copy said all four were saved and it wrote nothing.
  const r = await sync(phone, { enabled: true, days: DAYS });
  assert.deepEqual(alertIds(F), full);
  assert.equal(r.writes, 3);                       // two departures + the rev stamp
  // Nothing changed since: one read, no writes.
  assert.equal((await sync(phone, { enabled: true, days: DAYS })).writes, 0);
});

test('a day whose trips did not load keeps the departure alerts already saved', async () => {
  const F = fakeFirestore(); globalThis.localStorage = device();
  const sync = days => syncRunAlerts({ db: {}, uid: 'deen', enabled: true, settings: {}, days, now: NOW, firestore: F });
  await sync(DAYS);
  assert.equal(alertIds(F).length, 4);
  await sync([day('2026-10-28', 330, { partial: true, departures: [{ min: 345, what: 'pull-out', where: 'block 9101' }] })]);
  assert.equal(alertIds(F).length, 4, 'the 6:40 departure is still there');
  // A different run that day is a real change: its old departures go.
  await sync([{ ...day('2026-10-28', 330, { partial: true }), runNo: '310' }]);
  assert.ok(alertIds(F).every(k => !k.includes('_d')));
});

test('upcomingRuns marks a day partial when the trips or the paddle did not load', async () => {
  const days = await upcomingRuns({
    from: '2026-10-27', n: 2,
    resolve: () => ({ runNo: '209', reportMin: 330 }),
    runFor: async (_r, d) => (d === '2026-10-27' ? { dayType: 'weekday', reportMin: 330, pieces: [{ routeLabel: '21', block: '9101', startMin: 345, endMin: 600 }] } : null),
    tripsOf: async () => { throw new Error('trips not loaded: 21'); }
  });
  assert.equal(days[0].partial, true);
  assert.deepEqual(days[0].departures.map(x => x.what), ['pull-out']);
  assert.equal(days[1].partial, true);
  const ok = await upcomingRuns({ from: '2026-10-27', n: 1, resolve: () => ({ runNo: '209', reportMin: 330 }),
    runFor: async () => ({ dayType: 'weekday', reportMin: 330, pieces: [{ routeLabel: '21', block: '9101', startMin: 345, endMin: 600 }] }),
    tripsOf: async () => [] });
  assert.equal(ok[0].partial, undefined);
});

test('times are wall-clock times on the days the clocks change', () => {
  const at = (iso, min) => { const d = new Date(minToMs(iso, min)); return [d.getDate(), d.getHours(), d.getMinutes()]; };
  assert.deepEqual(at('2026-11-01', 330), [1, 5, 30]);        // fall back: 5:30 AM, not 4:30
  assert.deepEqual(at('2026-11-01', 1425), [1, 23, 45]);
  assert.deepEqual(at('2026-03-08', 330), [8, 5, 30]);         // spring forward
  assert.deepEqual(at('2026-11-02', -6), [1, 23, 54]);         // night liner, the evening before
  assert.deepEqual(at('2026-10-31', 1450), [1, 0, 10]);        // past midnight on the run's clock
});
