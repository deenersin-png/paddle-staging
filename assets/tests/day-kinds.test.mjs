// The day editor's kinds and the hours they count: Actual (workMin, real
// time worked) and Paid (paidMin). Pure (no Firebase, no network).
//
//   node --test assets/tests/day-kinds.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePure, dayHours, weekTotals, KIND_LABELS, reportPayMin, lateAfterEdit,
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

test('held late on paid-extra days: late minutes are worked AND paid x1.5; the extras are paid only', () => {
  const late30 = { kind: 'late', min: 30, note: '' };
  // The user's example: holiday premium on a 10 h run, held 30 min late.
  // Pay = 10 + 8 + 4 + 0.75 = 22.75 h; Actual = start to finish + 0.5 h.
  const prem = hours({ kind: 'holiday-worked', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 720 }, late30] });
  assert.equal(prem.paidMin, 1365);                     // 22.75 h
  assert.equal(prem.workMin, 630 + 30);                 // 10.5 h on the clock + 0.5 h = 11.00 h
  const wh = hours({ kind: 'worked-holiday', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 480 }, late30] });
  assert.equal(wh.paidMin, 600 + 480 + 45);             // 18.75 h
  assert.equal(wh.workMin, 660);
  const ot = hours({ kind: 'overtime', runNo: '209', status: 'scheduled', extras: [{ kind: 'ot', min: 240, note: 'paid' }, late30] });
  assert.equal(ot.paidMin, 600 + 240 + 45);             // 14.75 h
  assert.equal(ot.workMin, 660);
  // Week totals carry the same numbers.
  const t = weekTotals([{ r: day({ kind: 'holiday-worked', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 720 }, late30] }), run: RUN }]
    .map(d => ({ ...d, hours: dayHours(d.r, d.run, TODAY) })), TODAY);
  assert.equal(t.paidMin, 1365); assert.equal(t.workMin, 660);
});

// A Slate day: report 9:00, dispatch gives the run at 10:00, the run starts
// at 12:00 and finishes 8:30 PM, paying 8.5 h. runFor() hands dayHours the
// paddle run with the typed report time as its start (paddleStartMin keeps
// the paddle's).
const SLATE_RUN = { payHours: 8.5, reportMin: 540, paddleStartMin: 720, finishMin: 1230, overridden: true, pieces: [] };

test('slate: report pay stops when the run is given; the wait still counts as time at work', () => {
  assert.equal(reportPayMin(540, 720, 600), 60);           // 9:00 -> 10:00
  assert.equal(reportPayMin(540, 720, null), 180);         // no "given at": up to the start, as before
  assert.equal(reportPayMin(540, 720, 780), 180);          // given after the start: never more than to the start
  assert.equal(reportPayMin(1425, 15, 1435), 10);          // 11:45 PM report, given 11:55 PM, 12:15 AM start
  const h = hours({ kind: 'normal', runNo: '209', status: 'scheduled', reportMin: 540, assignedMin: 600, extras: [] }, SLATE_RUN);
  assert.equal(h.earlyReportMin, 60);
  assert.equal(h.paidMin, 510 + 60);                       // 1 h report + 8.5 h run = 9.5 h
  assert.equal(h.workMin, 1230 - 540);                     // 9:00 to 8:30 PM = 11.5 h at work
  const old = hours({ kind: 'normal', runNo: '209', status: 'scheduled', reportMin: 540, extras: [] }, SLATE_RUN);
  assert.equal(old.paidMin, 510 + 180);                    // a day without "given at" reads as before
  assert.equal(old.workMin, 690);
});

test('pay set by hand replaces the pay, never the time worked, on any kind', () => {
  const h = hours({ kind: 'normal', runNo: '209', status: 'scheduled', reportMin: 540, assignedMin: 600, payOverrideMin: 600, extras: [] }, SLATE_RUN);
  assert.equal(h.paidMin, 600); assert.equal(h.actualMin, 600);
  assert.equal(h.workMin, 690);
  assert.equal(h.payOverridden, true); assert.equal(h.flagged, true);
  const prem = hours({ kind: 'holiday-worked', runNo: '209', status: 'scheduled', payOverrideMin: 1300, extras: [{ kind: 'holiday', min: 720 }] });
  assert.equal(prem.paidMin, 1300); assert.equal(prem.workMin, 630);
  const off = hours({ kind: 'unpaid-off', runNo: null, status: 'off', payOverrideMin: 120, extras: [] }, null);
  assert.equal(off.paidMin, 120); assert.equal(off.workMin, 0);
  const none = hours({ kind: 'normal', runNo: '209', status: 'scheduled', extras: [] });
  assert.equal(none.payOverridden, false); assert.equal(none.paidMin, 600);
  const t = weekTotals([
    { r: day({ kind: 'normal', runNo: '209', status: 'scheduled', reportMin: 540, assignedMin: 600, extras: [] }), run: SLATE_RUN },
    { r: day({ kind: 'unpaid-off', runNo: null, status: 'off', payOverrideMin: 120, extras: [] }), run: null }
  ].map(d => ({ ...d, hours: dayHours(d.r, d.run, TODAY) })), TODAY);
  assert.equal(t.paidMin, 570 + 120); assert.equal(t.workMin, 690);
});

test('late minutes can be removed: 0 or empty clears them, a Late allowance day turns normal', () => {
  assert.deepEqual(lateAfterEdit('late', '30'), { kind: 'late', lateMin: 30 });
  assert.deepEqual(lateAfterEdit('late', '0'), { kind: 'normal', lateMin: null });
  assert.deepEqual(lateAfterEdit('late', ''), { kind: 'normal', lateMin: null });
  assert.deepEqual(lateAfterEdit('late', '  '), { kind: 'normal', lateMin: null });
  for (const k of ['overtime', 'holiday-worked', 'worked-holiday']) {
    assert.deepEqual(lateAfterEdit(k, '0'), { kind: k, lateMin: null });
    assert.deepEqual(lateAfterEdit(k, ''), { kind: k, lateMin: null });
    assert.deepEqual(lateAfterEdit(k, '15'), { kind: k, lateMin: 15 });
  }
  // What the editor saves after removing them: the whole extras list without
  // the late entry, and the new kind. The day then reads with no late pay.
  const before = hours({ kind: 'late', runNo: '209', status: 'scheduled', extras: [{ kind: 'late', min: 30 }] });
  assert.equal(before.paidMin, 645); assert.equal(before.workMin, 660);
  const after = hours({ kind: 'normal', runNo: '209', status: 'scheduled', extras: [] });
  assert.equal(after.paidMin, 600); assert.equal(after.workMin, 630);
  const prem = hours({ kind: 'holiday-worked', runNo: '209', status: 'scheduled', extras: [{ kind: 'holiday', min: 720 }] });
  assert.equal(prem.paidMin, 1320); assert.equal(prem.workMin, 630);
});
