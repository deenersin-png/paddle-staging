// ==========================================================================
// Paddle App — the operator's own schedule: patterns + assignments.
//
// Two collections under users/{uid}:
//
//   patterns/{id}      A repeating weekly template with an effective date
//                      range. A Regular driver gets one from their pick (one
//                      run per working day); a holdowner's week repeats until
//                      dispatch changes it. Versions are immutable once
//                      effective — "change my pattern" always creates a new
//                      version, so yesterday keeps resolving against the
//                      version that was active yesterday.
//
//   assignments/{date} An explicit day. Manual entries (slate / holdowner
//                      weeks), edits to a pattern day, an extra shift on an
//                      off day, sick / vacation / holiday marks, and EXTRAS —
//                      overtime, holiday bonus, anything on top of the run's
//                      own hours. Explicit ALWAYS wins over the pattern.
//                      Nothing is ever materialised: an untouched pattern day
//                      is computed on demand by resolvePure().
//
// Hours are never stored. A day's scheduled hours come from the paddle's pay
// column for the resolved run; actual hours are scheduled + extras. Both are
// derived at read time by dayHours(), the one formula Flutter reimplements.
// Every duration here is integer MINUTES (45 min of OT is 45, a 4 h holiday
// bonus is 240, a 9.1 h run is 546), so the arithmetic is exact.
// ==========================================================================

import {
  doc, setDoc, deleteDoc, collection, query, where, onSnapshot, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';

import { initFirebase } from './pa-firebase.js';
import { dayTypeFor, isHoliday, dowOf, daysBetween, addDays, todayIso } from './pa-schedule.js';

// Holiday pay, per the operator rule: 8 hours for a holiday not worked;
// 12 hours on top of the hours actually worked for a holiday worked.
export const HOLIDAY_PAY_MIN = 480;
export const HOLIDAY_WORKED_PAY_MIN = 720;

// Late allowance: minutes held late are paid at time and a half, on top of
// the day's worked hours (30 min late adds 45 min = 0.75 h).
export const LATE_ALLOWANCE_RATE = 1.5;

export const EXTRA_KINDS = { ot: 'Overtime', holiday: 'Holiday', late: 'Late allowance', other: 'Other' };

/** Labels for the day kinds the edit sheet writes (assignment.kind). The last
 *  three are no longer offered; they stay so days saved with them still read. */
export const KIND_LABELS = {
  'normal': 'Worked', 'late': 'Late allowance', 'holiday-off': 'Holiday', 'holiday-worked': 'Holiday worked',
  'paid-off': 'Paid day off', 'unpaid-off': 'Unpaid day off',
  'called-out': 'Called out', 'sick': 'Sick', 'unpaid-excused': 'Unpaid excused'
};
export const STATUSES = ['scheduled', 'off', 'sick', 'vacation', 'holiday'];

// Work-day presets. Day indexes are 0 = Sunday .. 6 = Saturday.
export const PRESETS = {
  '5-day': { label: '5-day',  days: [1, 2, 3, 4, 5] },
  '4+1':   { label: '4 + 1',  days: [1, 2, 3, 4, 6] },
  '3+2':   { label: '3 + 2',  days: [0, 1, 2, 3, 6] }
};

let db = null, uid = null;
const state = { patterns: [], assignments: new Map(), ready: false };
const subs = new Set();
const unsubs = [];

function emit() { subs.forEach(f => { try { f(state); } catch (_) {} }); }
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function getState() { return state; }
export function isAttached() { return !!(db && uid); }

const patRef = id   => doc(db, 'users', uid, 'patterns', id);
const asgRef = date => doc(db, 'users', uid, 'assignments', date);

function stopListeners() { unsubs.splice(0).forEach(u => { try { u(); } catch (_) {} }); }

/**
 * Subscribe to this user's patterns and a window of assignments. Resolves
 * once patterns have been delivered (from cache or server).
 */
export async function attach(userId, opts = {}) {
  const fb = initFirebase();
  if (!fb) return;
  db = fb.db; uid = userId;
  stopListeners();
  const today = todayIso();
  const from = opts.from || addDays(today, -120);   // wide enough for a whole pick
  const to   = opts.to   || addDays(today,  60);

  await new Promise(res => {
    let first = true;
    unsubs.push(onSnapshot(collection(db, 'users', uid, 'patterns'), snap => {
      state.patterns = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.effectiveFrom)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      state.ready = true;
      emit();
      if (first) { first = false; res(); }
    }, err => {
      console.warn('[pa] patterns listener', err.code || err.message);
      if (first) { first = false; res(); }
    }));
  });

  const q = query(collection(db, 'users', uid, 'assignments'),
                  where('date', '>=', from), where('date', '<=', to));
  unsubs.push(onSnapshot(q, snap => {
    const m = new Map();
    snap.docs.forEach(d => m.set(d.id, { id: d.id, ...d.data() }));
    state.assignments = m;
    emit();
  }, err => console.warn('[pa] assignments listener', err.code || err.message)));
}

export function detach() {
  stopListeners();
  db = null; uid = null;
  state.patterns = []; state.assignments = new Map(); state.ready = false;
  emit();
}

// ---- patterns -------------------------------------------------------------

/**
 * Pure: what saving a window [from, to] does to the existing versions.
 * Neighbouring windows are left alone; only overlap is resolved:
 *   - a version that starts before `from` is closed the day before it
 *   - a version that starts inside the window and ends after it is moved to
 *     start the day after `to`
 *   - a version wholly inside the window is removed
 * `to` null means open-ended, which supersedes everything at/after `from`.
 */
export function windowOps(existing, from, to) {
  const hi = to || '9999-12-31';
  const ops = [];
  for (const ex of existing) {
    const exFrom = ex.effectiveFrom, exTo = ex.effectiveTo || '9999-12-31';
    if (exFrom > hi || exTo < from) continue;                       // no overlap
    if (exFrom < from) { ops.push({ op: 'update', id: ex.id, effectiveTo: addDays(from, -1) }); continue; }
    if (to && exTo > hi) { ops.push({ op: 'update', id: ex.id, effectiveFrom: addDays(to, 1) }); continue; }
    ops.push({ op: 'delete', id: ex.id });
  }
  return ops;
}

/**
 * Save a pattern version covering [p.effectiveFrom, p.effectiveTo]. Other
 * windows before and after are untouched (see windowOps).
 *
 * p = { periodDays:7, days:{ "1":{runNo:'209'}, "2":{runNo:'214'} },
 *       runByDayType:{weekday:'209'}, depotKey, effectiveFrom, effectiveTo, preset, label }
 */
export async function savePattern(p) {
  if (!db) throw new Error('not signed in');
  const from = p.effectiveFrom, to = p.effectiveTo || null;
  if (!from) throw new Error('effectiveFrom required');
  if (to && to < from) throw new Error('end before start');
  const batch = writeBatch(db);
  for (const o of windowOps(state.patterns, from, to)) {
    if (o.op === 'delete') batch.delete(patRef(o.id));
    else batch.set(patRef(o.id), { ...(o.effectiveTo ? { effectiveTo: o.effectiveTo } : {}),
                                   ...(o.effectiveFrom ? { effectiveFrom: o.effectiveFrom } : {}),
                                   updatedAt: serverTimestamp() }, { merge: true });
  }
  const id = 'p' + from.replace(/-/g, '') + '_' + Math.random().toString(36).slice(2, 6);
  batch.set(patRef(id), {
    periodDays: p.periodDays || 7,
    anchor: p.anchor || from,
    days: p.days || {},
    runByDayType: p.runByDayType || {},
    depotKey: p.depotKey || '',
    effectiveFrom: from,
    effectiveTo: to,
    preset: p.preset || '',
    label: p.label || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    schemaVersion: 1
  });
  await batch.commit();
  return id;
}

/** Close the current pattern so nothing is registered after `lastDate`. */
export async function endPattern(id, lastDate) {
  if (!db) throw new Error('not signed in');
  await setDoc(patRef(id), { effectiveTo: lastDate, updatedAt: serverTimestamp() }, { merge: true });
}

/** Remove a saved block. Explicit days inside it are kept; the weeks it
 *  covered simply become unregistered again. */
export async function deletePattern(id) {
  if (!db) throw new Error('not signed in');
  await deleteDoc(patRef(id));
}

export function activePattern(patterns, date) {
  return patterns
    .filter(p => p.effectiveFrom <= date && (!p.effectiveTo || date <= p.effectiveTo))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
}

// ---- assignments ----------------------------------------------------------

/** Write (merge) one explicit day. */
export async function saveAssignment(date, data) {
  if (!db) throw new Error('not signed in');
  await setDoc(asgRef(date), { ...data, date, updatedAt: serverTimestamp(), schemaVersion: 2 }, { merge: true });
}

/** Remove an explicit day so the date falls back to the pattern. */
export async function clearAssignment(date) {
  if (!db) throw new Error('not signed in');
  await deleteDoc(asgRef(date));
}

/** Write several days at once (a holdowner / slate week). */
export async function saveDays(entries) {
  if (!db) throw new Error('not signed in');
  const batch = writeBatch(db);
  let n = 0;
  for (const e of entries) {
    if (!e.date) continue;
    if (e.remove) { batch.delete(asgRef(e.date)); n++; continue; }
    batch.set(asgRef(e.date), { ...e, updatedAt: serverTimestamp(), schemaVersion: 2 }, { merge: true });
    n++;
  }
  if (n) await batch.commit();
  return n;
}

// ---- extras ---------------------------------------------------------------

/**
 * A day's extras as [{kind, min, note}]. Reads the current `extras` array,
 * and synthesises one from the schema-1 fields (boolean `flags.overtime`,
 * `holiday{}`) so nothing written before this version needs migrating.
 */
export function normalizeExtras(a) {
  if (!a) return [];
  let out;
  if (Array.isArray(a.extras)) {
    out = a.extras
      .filter(x => x && Number.isFinite(+x.min))
      .map(x => ({ kind: EXTRA_KINDS[x.kind] ? x.kind : 'other', min: Math.round(+x.min), note: x.note || '' }));
  } else {
    out = [];
    if (a.holiday && a.holiday.isHoliday) {
      out.push({ kind: 'holiday', min: Math.round((a.holiday.payHours != null ? a.holiday.payHours : 8) * 60), note: '' });
      if (a.holiday.worked) {
        out.push({ kind: 'holiday', min: Math.round((a.holiday.workedBonusHours != null ? a.holiday.workedBonusHours : 4) * 60), note: 'worked' });
      }
    }
    if (a.flags && a.flags.overtime) out.push({ kind: 'ot', min: 0, note: 'amount not recorded' });
  }
  // The day's kind decides the holiday amount, so a day saved under an older
  // rule (holiday worked = 8 h) reads with the current one.
  if (a.kind === 'holiday-worked' || a.kind === 'holiday-off') {
    out = out.filter(x => x.kind !== 'holiday');
    out.unshift({ kind: 'holiday', min: a.kind === 'holiday-worked' ? HOLIDAY_WORKED_PAY_MIN : HOLIDAY_PAY_MIN, note: '' });
  }
  return out;
}

/** Pay minutes one extra adds. A late allowance is stored as the minutes held
 *  late and paid at LATE_ALLOWANCE_RATE; every other extra is paid as stored.
 *  Stored values are whole minutes, but a late allowance can pay a half
 *  minute (45 min -> 67.5); it is NOT rounded, so weekly totals stay exact. */
export function extraPayMin(x) {
  if (!x) return 0;
  if (x.kind === 'late') return Math.abs(+x.min || 0) * LATE_ALLOWANCE_RATE;
  return Math.round(+x.min || 0);
}

export const extrasMin = extras => (extras || []).reduce((s, x) => s + extraPayMin(x), 0);

/**
 * Slate report time: minutes between reporting and the run's scheduled
 * start, paid on top of the day. Reporting at 10:00 AM for an 11:00 AM start
 * adds 60. Wraps midnight (11:45 PM for a 12:29 AM start adds 44). A report
 * time at or after the start adds nothing.
 */
export function earlyReportMin(reportMin, startMin) {
  if (reportMin == null || startMin == null) return 0;
  const d = (((startMin - reportMin) % 1440) + 1440) % 1440;
  return d > 0 && d <= 720 ? d : 0;
}
export const hasExtra = (r, kind) => !!(r && r.extras && r.extras.some(x => x.kind === kind));

// ---- resolver -------------------------------------------------------------

function fromPattern(patterns, date, base) {
  const p = activePattern(patterns, date);
  if (!p) return { ...base, source: null, off: true, unregistered: true, status: 'off', runNo: null,
                   flags: {}, holiday: null, extras: [], reportMin: null, payMin: null };
  const period = p.periodDays || 7;
  const idx = period === 7
    ? dowOf(date)
    : ((daysBetween(p.anchor || p.effectiveFrom, date) % period) + period) % period;
  const slot = p.days ? p.days[String(idx)] : null;
  const out = { ...base, source: 'pattern', patternId: p.id, depotKey: p.depotKey || null,
                flags: {}, holiday: null, extras: [], status: 'scheduled', off: false,
                reportMin: null, payMin: null, runNo: null };

  // Holiday rule (from the operator): a holiday runs the Sunday schedule. Off
  // with holiday pay unless you hold a Sunday run, in which case you work it
  // and earn the run plus the holiday plus the worked bonus. A holdowner /
  // slate day with an explicit run keeps that run but is flagged.
  if (base.holidayDate) {
    // A Regular driver's pick stores one run per day too, but the holiday
    // rule for them is "Sunday schedule" — only a dispatch-assigned week
    // (holdowner / slate) keeps its explicit run on a holiday.
    const isPick = p.preset === 'pick' || !!PRESETS[p.preset];
    if (!isPick && slot && slot.runNo) {
      return { ...out, runNo: String(slot.runNo), holiday: { isHoliday: true, worked: true },
               extras: [{ kind: 'holiday', min: HOLIDAY_WORKED_PAY_MIN, note: '' }],
               holidayNote: 'Holiday: Sunday schedule. Confirm this run operates.' };
    }
    const sunRun = p.runByDayType && p.runByDayType.sunday;
    if (slot && sunRun) {
      return { ...out, runNo: String(sunRun), dayType: 'sunday', holiday: { isHoliday: true, worked: true },
               extras: [{ kind: 'holiday', min: HOLIDAY_WORKED_PAY_MIN, note: '' }] };
    }
    return { ...out, off: true, status: 'holiday', holiday: { isHoliday: true, worked: false },
             extras: [{ kind: 'holiday', min: HOLIDAY_PAY_MIN, note: '' }] };
  }

  if (!slot) return { ...out, off: true, status: 'off' };
  const runNo = slot.runNo || (p.runByDayType && p.runByDayType[base.dayType]) || null;
  if (!runNo) return { ...out, off: true, status: 'off', reason: 'no-run-for-daytype' };
  return { ...out, runNo: String(runNo) };
}

/**
 * What is this operator doing on `date`?
 *
 * `off` true means no run. `source` is 'assignment' (explicit day),
 * 'pattern' (computed), or null (nothing registered). `patternRunNo` says
 * what the pattern alone would have given, so an explicit day can be shown
 * as an override / extra shift.
 */
export function resolvePure(st, date, overrides) {
  const base = { date, dayType: dayTypeFor(date, overrides), holidayDate: isHoliday(date, overrides) };
  const pat = fromPattern(st.patterns, date, base);
  const a = st.assignments.get(date);
  if (!a) return pat;

  const status = a.status || (a.runNo ? 'scheduled' : 'off');
  const working = status === 'scheduled' && !!a.runNo;
  return {
    ...base,
    source: 'assignment',
    assignment: a,
    runNo: a.runNo ? String(a.runNo) : null,
    runDayType: a.runDayType || null,           // paddle the swapped-in run belongs to
    kind: a.kind || null,
    depotKey: a.depotKey || pat.depotKey || null,
    dayType: a.dayType || base.dayType,
    reportMin: a.reportMin != null ? a.reportMin : null,
    payMin: a.payMin != null ? a.payMin : null,
    status,
    off: !working,
    flags: a.flags || {},
    holiday: (status === 'holiday' || (a.holiday && a.holiday.isHoliday))
      ? { isHoliday: true, worked: working } : null,
    extras: normalizeExtras(a),
    note: a.note || '',
    patternRunNo: pat.runNo || null,
    patternOff: !!pat.off,
    extraShift: working && !pat.runNo
  };
}

export function resolve(date, overrides) { return resolvePure(state, date, overrides); }

export function resolveRange(from, to, overrides) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(resolvePure(state, d, overrides));
  return out;
}

// ---- hours (derived, never stored) ---------------------------------------

/** Pay minutes for the resolved run: paddle pay hours, else the day's manual payMin. */
export function runMinutes(run, resolved) {
  if (run && run.payHours) return Math.round(run.payHours * 60);
  if (resolved && resolved.payMin != null) return Math.round(resolved.payMin);
  return 0;
}

/**
 * The one formula. Scheduled = the run's hours when the day is a working
 * day; actual = scheduled + extras, but only once the day has arrived.
 * `flagged` marks anything that is not a plain pattern working day.
 */
export function dayHours(resolved, run, today) {
  const r = resolved, t = today || todayIso();
  // Scheduled = the paddle's hours for the run. Worked = the same unless the
  // operator typed a different amount (payMin), e.g. a short day or a run
  // the paddle does not know.
  const paddleMin = run && run.payHours ? Math.round(run.payHours * 60) : 0;
  const working = !r.off && r.status === 'scheduled' && !!r.runNo;
  const workedMin = r.payMin != null ? Math.round(r.payMin) : paddleMin;
  const runMin = paddleMin || workedMin;
  const scheduledMin = working ? runMin : 0;
  // The run's scheduled start is the paddle's; runFor() keeps it as
  // paddleStartMin when the day's report time replaces run.reportMin.
  const startMin = !run ? null
    : run.paddleStartMin != null ? run.paddleStartMin
    : (run.overridden || run.synthetic) ? null : run.reportMin;
  const early = working ? earlyReportMin(r.reportMin, startMin) : 0;
  const ex = extrasMin(r.extras) + early;
  const past = r.date <= t;
  const changedFromPattern = r.source === 'assignment' &&
    (r.extraShift || (!working && !!r.patternRunNo) || (working && r.patternRunNo && r.runNo !== r.patternRunNo));
  return {
    runMin, scheduledMin, extrasMin: ex, workedMin: working ? workedMin : 0, earlyReportMin: early,
    actualMin: past ? (working ? workedMin : 0) + ex : null,
    working, past,
    flagged: ex > 0 || (r.extras && r.extras.length > 0) || (!r.unregistered && !['scheduled', 'off'].includes(r.status)) || !!changedFromPattern,
    unknownRun: working && !run && r.payMin == null
  };
}

export function weekTotals(days) {
  let scheduledMin = 0, actualMin = 0, daysWorked = 0;
  for (const d of days) {
    scheduledMin += d.hours.scheduledMin;
    if (d.hours.past) {
      actualMin += d.hours.actualMin || 0;
      if (d.hours.scheduledMin > 0) daysWorked++;
    }
  }
  return { scheduledMin, actualMin, daysWorked };
}

export const fmtHours = min => ((+min || 0) / 60).toFixed(2);

/** Pay summary for one day: [[label, hours], ...] and a total. */
export function payHoursFor(resolved, run) {
  const h = dayHours(resolved, run, '9999-12-31');
  const parts = [];
  if (h.working) parts.push(['Worked', h.workedMin / 60]);
  (resolved.extras || []).forEach(x => parts.push([EXTRA_KINDS[x.kind] || 'Extra', extraPayMin(x) / 60]));
  if (h.earlyReportMin) parts.push(['Early report', h.earlyReportMin / 60]);
  return { total: (h.workedMin + h.extrasMin) / 60, parts };
}
