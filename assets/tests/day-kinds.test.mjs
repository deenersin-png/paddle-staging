// The day editor's kinds and the hours they count: Actual (workMin, real
// time worked) and Paid (paidMin). Pure (no Firebase, no network).
//
//   node --test assets/tests/day-kinds.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePure, dayHours, weekTotals, KIND_LABELS,
         OVERTIME_PAY_MIN, HOLIDAY_WORKED_PAY_MIN, WORKED_HOLIDAY_PAY_MIN, HOLIDAY_PAY_MIN } from '../pa-resolve.js';

const st = assignments => ({ patterns: [], vacations: new Map(), assignments: new Map(Object.entries(assignments)) });
const D = '2026-11-17';                                  // a Tuesday
const TODAY = '2026-11-20';
// A 10-hour run: pays 10 h, 5:00 AM - 3:30 PM (10.5 h on the clock).
const RUN = { payHours: 10, reportMin: 300, finishMin: 930, pieces: [] };
const day = a => resolvePure(st({ [D]: { date: D, source: 'edit', ...a } }), D, {});
const hours = (a, run = RUN) => dayHours(day(a), run, TODAY);

test('overtime: run pay + 4 paid hours; the 4 hours are not worked', () => {
  assert.equal(OVERTIME_PAY_MIN, 240);
  const h = hours({ kind: 'overtime', runNo: '209', status: 'scheduled', extras: [{ kind: 'ot', min: 240, note: 'paid' }] });
  assert.equal(h.working, true);
  assert.equal(h.paidMin, 600 + 240);
  assert.equal(h.workMin, 630);                          // start to finish only
  assert.equal(h.actualMin, 840);                        // Weekly Hours: pay, as before
  // The 4 hours come from the kind, whatever was stored with it.
  assert.equal(hours({ kind: 'overtime', runNo: '209', status: 'scheduled', extras: [] }).paidMin, 840);
});

test('holiday premium (stored as holiday-worked): run pay + 12 paid hours', () => {
  const h = hours({ kind: 'holiday-worked', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 720 }] });
  assert.equal(h.paidMin, 600 + HOLIDAY_WORKED_PAY_MIN);
  assert.equal(h.workMin, 630);
  // A day saved under the old 8 h rule still reads as 12.
  assert.equal(hours({ kind: 'holiday-worked', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 480 }] }).paidMin, 1320);
  assert.equal(KIND_LABELS['holiday-worked'], 'Holiday premium');
});

test('worked holiday: run pay + 8 paid hours', () => {
  assert.equal(WORKED_HOLIDAY_PAY_MIN, 480);
  const h = hours({ kind: 'worked-holiday', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 480 }] });
  assert.equal(h.paidMin, 600 + 480);
  assert.equal(h.workMin, 630);
});

test('personal holiday: not worked, paid the run’s regular hours', () => {
  const h = hours({ kind: 'personal-holiday', runNo: null, status: 'off', paidRun: { runNo: '209', runDayType: 'weekday' },
                    extras: [{ kind: 'other', min: 600, note: 'personal holiday' }] }, null);
  assert.equal(h.working, false);
  assert.equal(h.workMin, 0);
  assert.equal(h.paidMin, 600);
  assert.equal(h.scheduledMin, 0);
  const r = day({ kind: 'personal-holiday', runNo: null, status: 'off', paidRun: { runNo: '209' }, extras: [] });
  assert.equal(r.off, true);
  assert.equal(r.assignment.paidRun.runNo, '209');      // the editor reopens on the same run
});

test('renamed day-off kinds keep their ids and their pay', () => {
  assert.equal(KIND_LABELS['paid-off'], 'Earned paid off day');
  assert.equal(KIND_LABELS['unpaid-off'], 'Earned excused off');
  const paid = hours({ kind: 'paid-off', runNo: null, status: 'vacation', extras: [{ kind: 'other', min: 480, note: 'paid day off' }] }, null);
  assert.equal(paid.paidMin, 480); assert.equal(paid.workMin, 0);
  const unpaid = hours({ kind: 'unpaid-off', runNo: null, status: 'off', extras: [] }, null);
  assert.equal(unpaid.paidMin, 0); assert.equal(unpaid.workMin, 0);
  const hol = hours({ kind: 'holiday-off', runNo: null, status: 'holiday', extras: [] }, null);
  assert.equal(hol.paidMin, HOLIDAY_PAY_MIN);
});

test('week totals: paid extras count in Paid, never in Actual', () => {
  const days = [
    { r: day({ kind: 'overtime', runNo: '209', status: 'scheduled', extras: [] }), run: RUN },
    { r: day({ kind: 'personal-holiday', runNo: null, status: 'off', extras: [{ kind: 'other', min: 600, note: 'personal holiday' }] }), run: null }
  ].map(d => ({ ...d, hours: dayHours(d.r, d.run, TODAY) }));
  const t = weekTotals(days, TODAY);
  assert.equal(t.paidMin, 840 + 600);
  assert.equal(t.workMin, 630);
  assert.equal(t.daysWorked, 1);
});

test('a day not yet done shows nothing', () => {
  const h = dayHours(day({ kind: 'overtime', runNo: '209', status: 'scheduled', extras: [] }), RUN, '2026-11-16');
  assert.equal(h.paidMin, null); assert.equal(h.workMin, null);
});
