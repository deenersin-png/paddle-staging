// The additional short run: district rules, the day check, the resolver and
// the hours. Pure (no Firebase, no network).
//
//   node --test assets/tests/short-runs.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shortRunRules, isShortPay, checkDayRuns, resolvePure, dayHours, payHoursFor, SHORT_RUN_MAX_PAY_HOURS } from '../pa-resolve.js';

const SETTINGS = {
  defaults: { allowsShortRuns: false, shortRunMaxPayHours: 4 },
  districts: { callowhillb: { allowsShortRuns: true }, comly: { allowsShortRuns: true, shortRunMaxPayHours: 3.5 }, victory: { allowsShortRuns: false } }
};
const ON = shortRunRules(SETTINGS, 'callowhillb');
const OFF = shortRunRules(SETTINGS, 'victory');

test('settings: off by default, limit 4, per-district override, key forms', () => {
  assert.equal(SHORT_RUN_MAX_PAY_HOURS, 4);
  assert.deepEqual(shortRunRules(null, 'callowhillb'), { allowsShortRuns: false, shortRunMaxPayHours: 4 });
  assert.deepEqual(shortRunRules(SETTINGS, 'midvale'), { allowsShortRuns: false, shortRunMaxPayHours: 4 });
  assert.deepEqual(ON, { allowsShortRuns: true, shortRunMaxPayHours: 4 });
  assert.deepEqual(shortRunRules(SETTINGS, 'callowhill'), ON);              // spring-era key
  assert.deepEqual(shortRunRules(SETTINGS, 'callowhillb-fall-2026'), ON);   // season slug
  assert.deepEqual(shortRunRules(SETTINGS, 'comly'), { allowsShortRuns: true, shortRunMaxPayHours: 3.5 });
  assert.equal(shortRunRules({ districts: { x: { allowsShortRuns: 'yes' } } }, 'x').allowsShortRuns, false); // only true turns it on
});

test('the shipped settings file: off unless a district says true, limit 4', () => {
  const j = JSON.parse(readFileSync(new URL('../../data/district-settings.json', import.meta.url), 'utf8'));
  assert.equal(j.defaults.allowsShortRuns, false);
  assert.equal(j.defaults.shortRunMaxPayHours, 4);
  assert.equal(shortRunRules(j, 'no-such-district').allowsShortRuns, false);
  for (const [k, v] of Object.entries(j.districts)) assert.equal(shortRunRules(j, k).allowsShortRuns, v.allowsShortRuns === true, k);
});

test('short = pay hours below the limit; unknown pay is not short', () => {
  assert.equal(isShortPay(3.99, ON), true);
  assert.equal(isShortPay(4, ON), false);
  assert.equal(isShortPay(8.2, ON), false);
  assert.equal(isShortPay(0, ON), false);
  assert.equal(isShortPay(null, ON), false);
  assert.equal(isShortPay(3.6, shortRunRules(SETTINGS, 'comly')), false);
});

test('allowed: one regular run, or one regular + one short', () => {
  assert.equal(checkDayRuns({ runNo: '209', payHours: 8.5 }, ON), '');
  assert.equal(checkDayRuns({ runNo: '209', payHours: 8.5, shortRun: { runNo: '512', payHours: 2.35 } }, ON), '');
  assert.equal(checkDayRuns({ runNo: null }, ON), '');                                  // day off
  assert.equal(checkDayRuns({ runNo: '209', payHours: null }, ON), '');                 // unknown run alone: as before
});

test('refused: short alone, two shorts, second regular, same run, unknown pay', () => {
  assert.match(checkDayRuns({ runNo: '512', payHours: 2.35 }, ON), /can’t be the only run/);
  assert.match(checkDayRuns({ runNo: null, shortRun: { runNo: '512', payHours: 2.35 } }, ON), /can’t be the only run/);
  assert.match(checkDayRuns({ runNo: '512', payHours: 2.35, shortRun: { runNo: '513', payHours: 3 } }, ON), /Two short runs/);
  assert.match(checkDayRuns({ runNo: '512', payHours: 2.35, shortRun: { runNo: '209', payHours: 8.5 } }, ON), /Enter the regular run first/);
  assert.match(checkDayRuns({ runNo: '209', payHours: 8.5, shortRun: { runNo: '214', payHours: 8 } }, ON), /must be a short run/);
  assert.match(checkDayRuns({ runNo: '209', payHours: 8.5, shortRun: { runNo: '209', payHours: 8.5 } }, ON), /different run/);
  assert.match(checkDayRuns({ runNo: '209', payHours: null, shortRun: { runNo: '512', payHours: 2 } }, ON), /not in the paddle/);
  assert.match(checkDayRuns({ runNo: '209', payHours: 8.5, shortRun: { runNo: '512', payHours: null } }, ON), /not in the paddle/);
});

test('districts without the setting keep one run per day', () => {
  assert.equal(checkDayRuns({ runNo: '209', payHours: 8.5 }, OFF), '');
  assert.equal(checkDayRuns({ runNo: '512', payHours: 2.35 }, OFF), '');               // a short run alone is just a run there
  assert.match(checkDayRuns({ runNo: '209', payHours: 8.5, shortRun: { runNo: '512', payHours: 2.35 } }, OFF), /one run per day/);
});

const st = assignments => ({ patterns: [], vacations: new Map(), assignments: new Map(Object.entries(assignments)) });

test('resolver carries the short run on a working day only', () => {
  const r = resolvePure(st({ '2026-11-17': { date: '2026-11-17', runNo: '209', status: 'scheduled', shortRun: { runNo: '512', runDayType: 'weekday' } } }), '2026-11-17', {});
  assert.deepEqual(r.shortRun, { runNo: '512', runDayType: 'weekday' });
  const off = resolvePure(st({ '2026-11-17': { date: '2026-11-17', runNo: null, status: 'off', shortRun: { runNo: '512' } } }), '2026-11-17', {});
  assert.equal(off.shortRun, null);
  const plain = resolvePure(st({ '2026-11-17': { date: '2026-11-17', runNo: '209', status: 'scheduled' } }), '2026-11-17', {});
  assert.equal(plain.shortRun, null);
});

test('hours: the short run adds its pay and its time worked', () => {
  const r = resolvePure(st({ '2026-11-17': { date: '2026-11-17', runNo: '209', status: 'scheduled', shortRun: { runNo: '512' } } }), '2026-11-17', {});
  const run = { payHours: 8.5, reportMin: 300, finishMin: 810,                      // 5:00 AM - 1:30 PM
                shortRun: { runNo: '512', payHours: 2.25, reportMin: 900, finishMin: 1020 } };   // 3:00 - 5:00 PM
  const h = dayHours(r, run, '2026-11-20');
  assert.equal(h.runMin, 510);
  assert.equal(h.shortRunMin, 135);
  assert.equal(h.scheduledMin, 645);
  assert.equal(h.workedMin, 645);
  assert.equal(h.paidMin, 645);
  assert.equal(h.workMin, 510 + 120);
  assert.deepEqual(payHoursFor(r, run).parts, [['Worked', 8.5], ['Short run', 2.25]]);
  // Without the short run's paddle data nothing is added (and nothing breaks).
  assert.equal(dayHours(r, { ...run, shortRun: null }, '2026-11-20').scheduledMin, 510);
  // A day without a short run reads exactly as before.
  const p = resolvePure(st({ '2026-11-17': { date: '2026-11-17', runNo: '209', status: 'scheduled' } }), '2026-11-17', {});
  const hp = dayHours(p, run, '2026-11-20');
  assert.equal(hp.scheduledMin, 510); assert.equal(hp.workMin, 510); assert.equal(hp.shortRunMin, 0);
});

test('paddle finish with AM/PM flipped (12 h after the last pull-in) is taken back 12 h', async () => {
  const { normalizeRun, fmtClock } = await import('../pa-schedule.js');
  const row = { runno: '711', start: '2023-10-11 06:20 AM', finish: '2023-10-11 8:42 PM', pay: '3.3',
                r1: '43', b1: '9405', pot1: '06:34 AM', pit1: '08:39 AM' };
  const r = normalizeRun(row, 'weekday');
  assert.equal(fmtClock(r.finishMin), '8:42 AM');
  // An ordinary run keeps its finish.
  const ok = normalizeRun({ ...row, runno: '101', finish: '2023-10-11 08:42 AM', pay: '8' }, 'weekday');
  assert.equal(fmtClock(ok.finishMin), '8:42 AM');
});
