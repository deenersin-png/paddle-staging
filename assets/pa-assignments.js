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
//   vacations/{sunday} One vacation WEEK, id = the Sunday it starts. Vacation
//                      is picked by the week and paid by the week (44 hours),
//                      so it is held as a week rather than seven days: the
//                      resolver turns every untouched day in it into a
//                      vacation day, and the 44 hours land once, in
//                      weekTotals. The document `allowance` in the same
//                      collection is not a week; it holds how many vacation
//                      days the operator has this year, which is theirs to
//                      plan with and never enters an hours total.
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
import { addDays, dowOf, todayIso } from './pa-schedule.js';
import { resolvePure, vacationWeekOf, windowOps } from './pa-resolve.js';

// The rules themselves live in pa-resolve.js so the email sender can run the
// very same code. Everything they export stays importable from here, which is
// the only module the pages know about.
export * from './pa-resolve.js';

let db = null, uid = null;

// sync.status says where the schedule on screen came from:
//   'saved'      this device's copy, server not reached yet
//   'live'       confirmed by the server
//   'offline'    was live, connection since dropped (still showing that data)
//   'connecting' nothing on this device yet, waiting for the server
//   'error'      the server refused or failed (code in sync.error); retrying
// `version` changes only when the schedule itself changes, so pages can
// skip redrawing on connection-only updates.
const state = {
  patterns: [], assignments: new Map(), vacations: new Map(), vacationDays: null,
  ready: false, version: 0,
  sync: { status: 'idle', savedAt: null, lastServerAt: null, error: null }
};
const subs = new Set();
const unsubs = [];
const live = { patterns: null, assignments: null, vacations: null };
let listenRange = null, retryTimer = null, retryDelay = 3000, lastSig = '';

// How long a first visit on a device waits for the server before rendering
// anyway. A device with a saved copy never waits.
export const FIRST_LOAD_WAIT_MS = 6000;

function emit() { subs.forEach(f => { try { f(state); } catch (_) {} }); }
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function getState() { return state; }
export function isAttached() { return !!(db && uid); }

const patRef = id   => doc(db, 'users', uid, 'patterns', id);
const asgRef = date => doc(db, 'users', uid, 'assignments', date);
const vacRef = id   => doc(db, 'users', uid, 'vacations', id);

function stopListeners() {
  unsubs.splice(0).forEach(u => { try { u(); } catch (_) {} });
  clearTimeout(retryTimer); retryTimer = null;
}

const sortPatterns = list => list.filter(p => p && p.effectiveFrom)
  .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

// ---- this device's copy ---------------------------------------------------
// The operator's own schedule is small (a few patterns, a few months of
// edited days), so a copy lives in localStorage. It is what the screen shows
// the instant the page opens, with or without signal, and it is replaced by
// the server's version as soon as that arrives.

const COPY_PREFIX = 'pa_schedule_v1_';
const plain = o => { const c = { ...o }; delete c.createdAt; delete c.updatedAt; return c; };

function saveCopy() {
  if (!uid) return;
  try {
    const savedAt = Date.now();
    localStorage.setItem(COPY_PREFIX + uid, JSON.stringify({
      savedAt,
      patterns: state.patterns.map(plain),
      assignments: [...state.assignments.values()].map(plain),
      vacations: [...state.vacations.values()].map(plain),
      vacationDays: state.vacationDays
    }));
    state.sync.savedAt = savedAt;
  } catch (_) { /* storage full or blocked: live data still works */ }
}

function loadCopy(userId) {
  try {
    const j = JSON.parse(localStorage.getItem(COPY_PREFIX + userId) || 'null');
    if (!j || !Array.isArray(j.patterns)) return false;
    state.patterns = sortPatterns(j.patterns);
    state.assignments = new Map((j.assignments || []).map(a => [a.id || a.date, a]));
    state.vacations = new Map((j.vacations || []).map(v => [v.id || v.weekStart, v]));
    state.vacationDays = j.vacationDays != null ? j.vacationDays : null;
    state.sync.savedAt = j.savedAt || null;
    state.ready = true;
    return true;
  } catch (_) { return false; }
}

function markVersion() {
  let sig = '';
  try {
    sig = JSON.stringify([state.patterns.map(plain), [...state.assignments.values()].map(plain),
                          [...state.vacations.keys()].sort(), state.vacationDays]);
  } catch (_) {}
  if (sig !== lastSig) { lastSig = sig; state.version++; }
}

function updateStatus() {
  const s = state.sync, ls = [live.patterns, live.assignments, live.vacations];
  if (s.error) s.status = 'error';
  else if (ls.every(l => l && l.synced && !l.fromCache)) s.status = 'live';
  else if (ls.some(l => l && l.synced)) s.status = 'offline';
  else s.status = s.savedAt ? 'saved' : 'connecting';
}

// ---- listeners ------------------------------------------------------------

function listen(key, ref, apply) {
  const l = { synced: false, fromCache: true };
  live[key] = l;
  unsubs.push(onSnapshot(ref, { includeMetadataChanges: true }, snap => {
    l.fromCache = snap.metadata.fromCache;
    if (!snap.metadata.fromCache) {
      l.synced = true;
      state.sync.lastServerAt = Date.now();
      state.sync.error = null;
      retryDelay = 3000;
    }
    if (l.synced) {
      // Confirmed by the server at least once, so this listener's view is the
      // whole truth - including blocks or days deleted on another device.
      apply.replace(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } else {
      // Not confirmed yet (still connecting, or no signal). The client holds
      // nothing but this session's own edits, so fold those into the saved
      // copy instead of replacing the operator's schedule with an empty list.
      snap.docChanges().forEach(ch => apply.merge(ch.type, { id: ch.doc.id, ...ch.doc.data() }));
    }
    state.ready = true;
    markVersion();
    updateStatus();
    if (l.synced) saveCopy();
    emit();
  }, err => {
    // Firestore ends a listener after an error; it does not retry by itself.
    console.warn('[pa] ' + key + ' listener', err.code || err.message);
    state.sync.error = err.code || err.message || 'error';
    updateStatus();
    emit();
    scheduleRetry();
  }));
}

function startListeners() {
  unsubs.splice(0).forEach(u => { try { u(); } catch (_) {} });
  listen('patterns', collection(db, 'users', uid, 'patterns'), {
    replace: docs => { state.patterns = sortPatterns(docs); },
    merge: (type, d) => {
      const rest = state.patterns.filter(p => p.id !== d.id);
      state.patterns = sortPatterns(type === 'removed' ? rest : rest.concat(d));
    }
  });
  listen('assignments', query(collection(db, 'users', uid, 'assignments'),
                              where('date', '>=', listenRange.from), where('date', '<=', listenRange.to)), {
    replace: docs => { state.assignments = new Map(docs.map(d => [d.id, d])); },
    merge: (type, d) => {
      const m = new Map(state.assignments);
      if (type === 'removed') m.delete(d.id); else m.set(d.id, d);
      state.assignments = m;
    }
  });
  // Every vacation week, unbounded: there are a handful a year, and a week
  // outside the assignments window still belongs on next year's calendar.
  listen('vacations', collection(db, 'users', uid, 'vacations'), {
    replace: docs => {
      state.vacations = new Map(docs.filter(isWeekDoc).map(d => [d.id, d]));
      const a = docs.find(d => d.id === VACATION_ALLOWANCE_ID);
      state.vacationDays = a && Number.isFinite(+a.days) ? +a.days : null;
    },
    merge: (type, d) => {
      if (d.id === VACATION_ALLOWANCE_ID) {
        state.vacationDays = type === 'removed' || !Number.isFinite(+d.days) ? null : +d.days;
        return;
      }
      if (!isWeekDoc(d)) return;
      const m = new Map(state.vacations);
      if (type === 'removed') m.delete(d.id); else m.set(d.id, d);
      state.vacations = m;
    }
  });
}

/** A vacations/{id} document that is a week (id = the Sunday), not the allowance. */
const isWeekDoc = d => /^\d{4}-\d{2}-\d{2}$/.test(d.id || '');

function scheduleRetry() {
  if (retryTimer || !uid) return;
  retryTimer = setTimeout(() => { retryTimer = null; if (uid) { state.sync.error = null; startListeners(); } }, retryDelay);
  retryDelay = Math.min(retryDelay * 3, 60000);
}

/** Reconnect now (a Retry button, the phone regaining signal). */
export function retryNow() {
  if (!uid || !db) return;
  clearTimeout(retryTimer); retryTimer = null; retryDelay = 3000;
  state.sync.error = null;
  startListeners();
  updateStatus();
  emit();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (uid && state.sync.status !== 'live') retryNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && uid && state.sync.status === 'error') retryNow();
  });
}

/**
 * Subscribe to this user's patterns and a window of assignments.
 *
 * Returns immediately when this device has a saved copy (it is shown at
 * once, live data follows). On a first visit it waits for the server for at
 * most FIRST_LOAD_WAIT_MS, then returns anyway - it never hangs the page.
 */
export async function attach(userId, opts = {}) {
  const fb = initFirebase();
  if (!fb) return;
  if (uid === userId && unsubs.length) return;          // already attached
  if (uid && uid !== userId) detach({ keepCopy: true });
  db = fb.db; uid = userId;
  const today = todayIso();
  listenRange = { from: opts.from || addDays(today, -120), to: opts.to || addDays(today, 60) };
  const hadCopy = loadCopy(userId);
  markVersion();
  updateStatus();
  emit();
  startListeners();
  if (hadCopy) return;
  await new Promise(res => {
    let off = () => {};
    const done = () => { clearTimeout(t); off(); res(); };
    const t = setTimeout(done, FIRST_LOAD_WAIT_MS);
    off = onChange(() => { if (['live', 'error'].includes(state.sync.status)) done(); });
  });
}

/** Stop listening. On sign-out the device's copy is removed too. */
export function detach(opts = {}) {
  stopListeners();
  if (uid && !opts.keepCopy) { try { localStorage.removeItem(COPY_PREFIX + uid); } catch (_) {} }
  db = null; uid = null; listenRange = null; lastSig = '';
  live.patterns = null; live.assignments = null; live.vacations = null;
  state.patterns = []; state.assignments = new Map();
  state.vacations = new Map(); state.vacationDays = null;
  state.ready = false; state.version++;
  state.sync = { status: 'idle', savedAt: null, lastServerAt: null, error: null };
  emit();
}

// ---- patterns -------------------------------------------------------------

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
  await confirmed(batch.commit(), 'patterns');
  return id;
}

/**
 * A rejected write must not leave its change on screen. While a listener is
 * live, Firestore delivers the rollback itself. When it isn't (no signal, or
 * the listener already failed), restore that collection from this device's
 * copy, which only ever holds server-confirmed data.
 */
function rollbackUnconfirmed(key) {
  const l = live[key];
  if (!uid || (l && l.synced)) return;
  let copy = null;
  try { copy = JSON.parse(localStorage.getItem(COPY_PREFIX + uid) || 'null'); } catch (_) {}
  if (key === 'patterns') state.patterns = sortPatterns((copy && copy.patterns) || []);
  else if (key === 'vacations') {
    state.vacations = new Map(((copy && copy.vacations) || []).map(v => [v.id || v.weekStart, v]));
    state.vacationDays = copy && copy.vacationDays != null ? copy.vacationDays : null;
  } else state.assignments = new Map(((copy && copy.assignments) || []).map(a => [a.id || a.date, a]));
  markVersion();
  emit();
}

async function confirmed(promise, key) {
  try { return await promise; }
  catch (e) { rollbackUnconfirmed(key); throw e; }
}

/** Close the current pattern so nothing is registered after `lastDate`. */
export async function endPattern(id, lastDate) {
  if (!db) throw new Error('not signed in');
  await confirmed(setDoc(patRef(id), { effectiveTo: lastDate, updatedAt: serverTimestamp() }, { merge: true }), 'patterns');
}

/** Remove a saved block. Explicit days inside it are kept; the weeks it
 *  covered simply become unregistered again. */
export async function deletePattern(id) {
  if (!db) throw new Error('not signed in');
  await confirmed(deleteDoc(patRef(id)), 'patterns');
}

// ---- assignments ----------------------------------------------------------

/** Write (merge) one explicit day. */
export async function saveAssignment(date, data) {
  if (!db) throw new Error('not signed in');
  await confirmed(setDoc(asgRef(date), { ...data, date, updatedAt: serverTimestamp(), schemaVersion: 2 }, { merge: true }), 'assignments');
}

/** Remove an explicit day so the date falls back to the pattern. */
export async function clearAssignment(date) {
  if (!db) throw new Error('not signed in');
  await confirmed(deleteDoc(asgRef(date)), 'assignments');
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
  if (n) await confirmed(batch.commit(), 'assignments');
  return n;
}

// ---- vacation weeks -------------------------------------------------------

export const isVacationWeek = date => !!vacationWeekOf(state, date);
/** Every vacation week on record, earliest first. */
export const vacationWeeks = () => [...state.vacations.keys()].sort();

/**
 * Replace the set of vacation weeks, and record how many vacation days the
 * operator has. `weeks` are week-start Sundays; anything on record and not in
 * the list is removed. `days` null leaves the allowance alone.
 */
export async function saveVacation(weeks, days) {
  if (!db) throw new Error('not signed in');
  const want = new Set((weeks || []).map(w => addDays(w, -dowOf(w))));
  const batch = writeBatch(db);
  let n = 0;
  for (const w of want) {
    if (state.vacations.has(w)) continue;
    batch.set(vacRef(w), { weekStart: w, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), schemaVersion: 1 });
    n++;
  }
  for (const w of state.vacations.keys()) {
    if (!want.has(w)) { batch.delete(vacRef(w)); n++; }
  }
  if (days != null) {
    batch.set(vacRef(VACATION_ALLOWANCE_ID), { days: Math.max(0, Math.round(+days) || 0), updatedAt: serverTimestamp() }, { merge: true });
    n++;
  }
  if (n) await confirmed(batch.commit(), 'vacations');
  return n;
}

/** Add or remove one vacation week. */
export async function setVacationWeek(weekStart, on) {
  if (!db) throw new Error('not signed in');
  const w = addDays(weekStart, -dowOf(weekStart));
  await confirmed(on
    ? setDoc(vacRef(w), { weekStart: w, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), schemaVersion: 1 })
    : deleteDoc(vacRef(w)), 'vacations');
}

export function resolve(date, overrides) { return resolvePure(state, date, overrides); }

export function resolveRange(from, to, overrides) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(resolvePure(state, d, overrides));
  return out;
}

