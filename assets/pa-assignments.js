// ==========================================================================
// Paddle App — the operator's own schedule: patterns + assignments.
//
// Two collections under users/{uid}:
//
//   patterns/{id}      A repeating weekly template with an effective date
//                      range. Regular drivers get one from their pick; a
//                      holdowner's week repeats until dispatch changes it.
//                      Versions are immutable once effective — "change my
//                      pattern" always creates a new version, so yesterday
//                      keeps resolving against the version that was active
//                      yesterday.
//
//   assignments/{date} An explicit day. Manual entries (slate / holdowner
//                      weeks), edits to a pattern day, overtime on an off
//                      day, holiday marks. Explicit ALWAYS wins over the
//                      pattern. Nothing is ever materialised: an untouched
//                      pattern day is computed on demand by resolvePure().
//
// resolvePure() is deliberately a pure function over plain data so it can be
// unit-tested in the browser and ported to Dart against the same test cases.
// ==========================================================================

import {
  doc, setDoc, deleteDoc, collection, query, where, onSnapshot, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';

import { initFirebase } from './pa-firebase.js';
import { dayTypeFor, isHoliday, dowOf, daysBetween, addDays, todayIso } from './pa-schedule.js';

// Holiday pay, per the operator rule: every employee gets 8 hours for a
// holiday; working it earns the run's hours plus a further 4. Both are
// editable per day so payroll quirks can be entered by hand.
export const HOLIDAY_PAY_HOURS = 8;
export const HOLIDAY_WORKED_BONUS_HOURS = 4;

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
 * once patterns have been delivered (from cache or server), so the caller
 * can render immediately.
 */
export async function attach(userId, opts = {}) {
  const fb = initFirebase();
  if (!fb) return;
  db = fb.db; uid = userId;
  stopListeners();
  const today = todayIso();
  const from = opts.from || addDays(today, -42);
  const to   = opts.to   || addDays(today,  42);

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
 * Save a new pattern version starting at p.effectiveFrom. Any existing
 * version still open on that date is closed the day before; any version
 * that would start on or after it is superseded and removed.
 *
 * p = { periodDays:7, days:{ "1":{}, "2":{runNo:'454'} }, runByDayType:{...},
 *       depotKey, effectiveFrom, preset, label }
 */
export async function savePattern(p) {
  if (!db) throw new Error('not signed in');
  const from = p.effectiveFrom;
  if (!from) throw new Error('effectiveFrom required');
  const batch = writeBatch(db);
  for (const ex of state.patterns) {
    if (ex.effectiveFrom >= from) { batch.delete(patRef(ex.id)); continue; }
    if (!ex.effectiveTo || ex.effectiveTo >= from) {
      batch.set(patRef(ex.id), { effectiveTo: addDays(from, -1), updatedAt: serverTimestamp() }, { merge: true });
    }
  }
  const id = 'p' + from.replace(/-/g, '') + '_' + Math.random().toString(36).slice(2, 6);
  batch.set(patRef(id), {
    periodDays: p.periodDays || 7,
    anchor: p.anchor || from,
    days: p.days || {},
    runByDayType: p.runByDayType || {},
    depotKey: p.depotKey || '',
    effectiveFrom: from,
    effectiveTo: null,
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

export function activePattern(patterns, date) {
  return patterns
    .filter(p => p.effectiveFrom <= date && (!p.effectiveTo || date <= p.effectiveTo))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
}

// ---- assignments ----------------------------------------------------------

/** Write (merge) one explicit day. */
export async function saveAssignment(date, data) {
  if (!db) throw new Error('not signed in');
  await setDoc(asgRef(date), { ...data, date, updatedAt: serverTimestamp(), schemaVersion: 1 }, { merge: true });
}

/** Remove an explicit day so the date falls back to the pattern. */
export async function clearAssignment(date) {
  if (!db) throw new Error('not signed in');
  await deleteDoc(asgRef(date));
}

/** Write several days at once (a holdowner / slate week). Empty runNo with
 *  no status is treated as "leave the pattern alone" and is skipped. */
export async function saveDays(entries) {
  if (!db) throw new Error('not signed in');
  const batch = writeBatch(db);
  let n = 0;
  for (const e of entries) {
    if (!e.date) continue;
    if (e.remove) { batch.delete(asgRef(e.date)); n++; continue; }
    batch.set(asgRef(e.date), { ...e, updatedAt: serverTimestamp(), schemaVersion: 1 }, { merge: true });
    n++;
  }
  if (n) await batch.commit();
  return n;
}

// ---- resolver -------------------------------------------------------------

/**
 * What is this operator doing on `date`?
 *
 * Returns a plain object; `off` true means no run. `source` is 'assignment'
 * (explicit day), 'pattern' (computed), or null (nothing registered).
 *
 * Holiday rule (from the operator): a holiday runs the Sunday schedule. You
 * are off with holiday pay unless you hold a Sunday run, in which case you
 * work it. A holdowner / slate day with an explicit run keeps that run but
 * is flagged so the operator can confirm it operates.
 */
export function resolvePure(st, date, overrides) {
  const base = { date, dayType: dayTypeFor(date, overrides), holidayDate: isHoliday(date, overrides) };

  const a = st.assignments.get(date);
  if (a) {
    const status = a.status || (a.runNo ? 'scheduled' : 'off');
    return {
      ...base,
      source: a.source || 'manual',
      assignment: a,
      runNo: a.runNo || null,
      depotKey: a.depotKey || null,
      dayType: a.dayType || base.dayType,
      reportMin: a.reportMin != null ? a.reportMin : null,
      status,
      off: status !== 'scheduled' || !a.runNo,
      flags: a.flags || {},
      holiday: a.holiday || null,
      note: a.note || ''
    };
  }

  const p = activePattern(st.patterns, date);
  if (!p) return { ...base, source: null, off: true, unregistered: true, status: 'off', flags: {}, holiday: null };

  const period = p.periodDays || 7;
  const idx = period === 7
    ? dowOf(date)
    : ((daysBetween(p.anchor || p.effectiveFrom, date) % period) + period) % period;
  const slot = p.days ? p.days[String(idx)] : null;
  const out = { ...base, source: 'pattern', patternId: p.id, depotKey: p.depotKey || null,
                flags: {}, holiday: null, status: 'scheduled', off: false, reportMin: null };

  if (base.holidayDate) {
    if (slot && slot.runNo) {
      return { ...out, runNo: slot.runNo, holiday: { isHoliday: true, worked: true },
               holidayNote: 'Holiday — Sunday schedule. Confirm this run operates.' };
    }
    const sunRun = p.runByDayType && p.runByDayType.sunday;
    if (slot && sunRun) {
      return { ...out, runNo: sunRun, dayType: 'sunday', holiday: { isHoliday: true, worked: true } };
    }
    return { ...out, runNo: null, off: true, status: 'holiday', holiday: { isHoliday: true, worked: false } };
  }

  if (!slot) return { ...out, runNo: null, off: true, status: 'off' };
  const runNo = slot.runNo || (p.runByDayType && p.runByDayType[base.dayType]) || null;
  if (!runNo) return { ...out, runNo: null, off: true, status: 'off', reason: 'no-run-for-daytype' };
  return { ...out, runNo: String(runNo) };
}

export function resolve(date, overrides) { return resolvePure(state, date, overrides); }

export function resolveRange(from, to, overrides) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(resolvePure(state, d, overrides));
  return out;
}

/** Pay hours for a resolved day, given its run (may be null). */
export function payHoursFor(resolved, run) {
  const h = resolved && resolved.holiday;
  if (h && h.isHoliday) {
    const base = h.payHours != null ? h.payHours : HOLIDAY_PAY_HOURS;
    if (!h.worked) return { total: base, parts: [['Holiday', base]] };
    const bonus = h.workedBonusHours != null ? h.workedBonusHours : HOLIDAY_WORKED_BONUS_HOURS;
    const runH = run ? run.payHours : 0;
    return { total: runH + base + bonus, parts: [['Run', runH], ['Holiday', base], ['Worked holiday', bonus]] };
  }
  if (!resolved || resolved.off) return { total: 0, parts: [] };
  const runH = run ? run.payHours : 0;
  return { total: runH, parts: run ? [['Run', runH]] : [] };
}
