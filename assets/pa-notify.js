// ==========================================================================
// Paddle App — departure alerts (Tier 1: while the app is open).
//
// Fires browser notifications a few minutes before the next SCHEDULED
// moment — report time, pull-out, each trip departure, the next piece of a
// swing. Runs entirely in the page: a single setTimeout for the next alert,
// re-planned every time the home screen recomputes. No server.
//
// What that buys and what it does not:
//   - Desktop / Android Chrome: works with the tab open or in the background.
//   - iPhone: only inside an app added to the Home Screen, and iOS suspends
//     timers when the app is backgrounded, so it is reliable while the app
//     is on screen (a layover) and best-effort otherwise.
//   - App fully closed: nothing fires. That needs real push (Tier 2, later).
//
// Times come from pa-schedule / pa-countdown only. The scheduled-time rule
// applies here exactly as it does to the countdown.
// ==========================================================================

import { doc, getDoc, setDoc, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';
import { initFirebase } from './pa-firebase.js';
import * as S from './pa-schedule.js';

export const DEFAULTS = {
  enabled: false,
  departureLeadMin: 5,
  shiftLeadMin: 30,
  quietEnabled: false,
  quietStart: '22:00',
  quietEnd: '05:00',
  // Tier 2, and the only alert that survives the app being closed: an email
  // sent from the server (functions/) a couple of minutes before reporting,
  // carrying the bus ahead and the detours. These three fields are read by
  // that function; nothing in this module acts on them.
  emailEnabled: false,
  emailLeadMin: 2,
  emailTo: ''
};
const LS_SETTINGS = 'pa_notify';
const LS_FIRED    = 'pa_notify_fired';
const MAX_DELAY   = 12 * 3600000;      // re-plan rather than sleep for days

let db = null, uid = null;
let settings = { ...DEFAULTS };
let timer = null, swReg = null, lastInput = null;
const listeners = new Set();

function loadLocal() {
  try { const j = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null'); if (j) settings = { ...DEFAULTS, ...j }; } catch (_) {}
}
function saveLocal() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (_) {} }
loadLocal();

export function getSettings() { return { ...settings }; }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(f => { try { f(getSettings()); } catch (_) {} }); }

/** Load the user's saved preferences (local mirror first, then Firestore). */
export async function attach(userId) {
  const fb = initFirebase();
  if (!fb) return;
  db = fb.db; uid = userId;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'settings', 'notifications'));
    if (snap.exists()) {
      const d = snap.data(); delete d.updatedAt;
      settings = { ...DEFAULTS, ...d };
      saveLocal(); emit();
      if (lastInput) schedule(lastInput);
    }
  } catch (e) { console.warn('[pa] notify settings', e.code || e.message); }
}

export function detach() {
  db = null; uid = null;
  clearTimeout(timer); timer = null; lastInput = null;
}

export async function save(patch) {
  settings = { ...settings, ...patch };
  saveLocal(); emit();
  if (db && uid) {
    try {
      await setDoc(doc(db, 'users', uid, 'settings', 'notifications'),
                   { ...settings, updatedAt: serverTimestamp() }, { merge: true });
    } catch (e) { console.warn('[pa] notify save', e.code || e.message); }
  }
  if (lastInput) schedule(lastInput);
}

/**
 * When the email sender last ran, from the heartbeat it writes each minute.
 * Resolves { lastRunAt, ok } — ok false means it has not run in a while, and
 * null means it has never run, so the screen can say so rather than leave an
 * operator waiting for an email that nothing is sending.
 */
export async function senderStatus() {
  const fb = initFirebase();
  if (!fb) return null;
  try {
    const snap = await getDoc(doc(fb.db, 'config', 'emailSender'));
    if (!snap.exists()) return null;
    const d = snap.data();
    const ms = t => (t && t.toMillis ? t.toMillis() : 0);
    const last = ms(d.lastRunAt);
    return {
      lastRunAt: last,
      ok: last > 0 && Date.now() - last < 10 * 60000,
      problem: d.problem || null,               // why the last sweep could not find anyone
      sendProblem: d.sendProblem || null,       // why the last email could not be sent
      sendProblemAt: ms(d.sendProblemAt)
    };
  } catch (_) { return null; }
}

/**
 * What the ALERTS screen says about the sender: { kind, text }, kind being
 * 'ok' | 'warn' | 'err'. Pure, so it can be checked without a database.
 * `st` is senderStatus()'s answer (null = the sender has never run).
 */
export function senderMessage(st) {
  const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!st) return { kind: 'err', text: 'No emails yet: the sender is not switched on for this app. Nothing else on this screen is affected.' };
  if (!st.ok) return { kind: 'err', text: 'The sender has not run since ' + clock(st.lastRunAt) + ' — emails may be delayed.' };
  if (st.problem === 'INDEX_BUILDING') {
    return { kind: 'warn', text: 'The sender is running, but the database index it searches with is still being built. That takes a few minutes after a deploy; emails start on their own once it is ready.' };
  }
  if (st.problem) return { kind: 'err', text: 'The sender is running but hit a database error, so it cannot find who to email. It tries again every minute.' };
  if (st.sendProblem === 'EAUTH') {
    return { kind: 'err', text: 'The last email could not be sent (' + clock(st.sendProblemAt) + '): Gmail refused the sender’s login. The Gmail address or app password stored for the sender needs checking.' };
  }
  if (st.sendProblem) {
    return { kind: 'err', text: 'The last email could not be sent (' + clock(st.sendProblemAt) + '). The sender tries again the next minute while the run is still due.' };
  }
  return { kind: 'ok', text: 'Sender is running · last checked ' + clock(st.lastRunAt) };
}

// ---- capability -----------------------------------------------------------

export function support() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                  || navigator.standalone === true;
  const api = 'Notification' in window;
  return {
    api,
    sw: 'serviceWorker' in navigator,
    permission: api ? Notification.permission : 'unsupported',
    ios, standalone
  };
}

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href);
    return swReg;
  } catch (e) { console.warn('[pa] service worker', e.message); return null; }
}

/** Must be called from a user gesture (a tap on the toggle). */
export async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  try { return await Notification.requestPermission(); } catch (_) { return Notification.permission; }
}

export async function show(title, body, tag, url) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = {
    body, tag: tag || 'pa', renotify: true,
    icon: new URL('assets/icon-192.png', document.baseURI).href,
    badge: new URL('assets/icon-192.png', document.baseURI).href,
    data: { url: new URL(url || 'home.html', document.baseURI).href }
  };
  // Through the service worker when we can (survives the tab being in the
  // background), plain Notification otherwise.
  try {
    const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
    if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
  } catch (_) {}
  try { new Notification(title, opts); return true; } catch (_) { return false; }
}

// ---- planning -------------------------------------------------------------

function firedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_FIRED) || '[]')); } catch (_) { return new Set(); }
}
function markFired(key) {
  const s = firedSet(); s.add(key);
  const today = S.todayIso(), y = S.addDays(today, -1);
  const keep = [...s].filter(k => k.startsWith(today) || k.startsWith(y));   // keys begin with the date
  try { localStorage.setItem(LS_FIRED, JSON.stringify(keep)); } catch (_) {}
}

function inQuiet(ms) {
  if (!settings.quietEnabled) return false;
  const d = new Date(ms); const m = d.getHours() * 60 + d.getMinutes();
  const p = t => { const x = String(t || '').split(':'); return (parseInt(x[0], 10) || 0) * 60 + (parseInt(x[1], 10) || 0); };
  const a = p(settings.quietStart), b = p(settings.quietEnd);
  return a <= b ? (m >= a && m < b) : (m >= a || m < b);
}

/**
 * Every alert this run could still produce, soonest first, minus the ones
 * already fired. `current` is the home screen's chosen context; tripsByBlock
 * is its loaded GTFS trips (may be empty — then pull-out / piece / report
 * alerts still work).
 */
export function plan(input) {
  const current = input && input.current, tripsByBlock = input && input.tripsByBlock;
  if (!current || !current.run || !current.r) return [];
  const run = current.run, date = current.date, rn = current.r.runNo, now = Date.now();
  const lead = settings.departureLeadMin, slead = settings.shiftLeadMin;
  const items = [];
  const add = (min, l, kind, title, body) => {
    if (min == null) return;
    const eventAt = S.minToMs(date, min);
    if (eventAt <= now) return;
    items.push({ at: eventAt - l * 60000, eventAt, key: date + '|' + kind + '|' + min, title, body });
  };
  add(run.reportMin, slead, 'report', 'Run ' + rn + ' · report in ' + slead + ' min', 'Report ' + S.fmtClock(run.reportMin));
  run.pieces.forEach((p, i) => {
    add(p.startMin, lead, 'piece' + p.index,
        'Run ' + rn + (i === 0 ? ' · pull-out in ' : ' · next piece in ') + lead + ' min',
        p.routeLabel + ' · block ' + p.block + ' · ' + S.fmtClock(p.startMin));
    const trips = (tripsByBlock && tripsByBlock.get(p.block)) || [];
    trips.forEach(t => {
      if (t.s > p.startMin && t.s < p.endMin) {
        add(t.s, lead, 'dep' + t.tripId, 'Run ' + rn + ' · departure in ' + lead + ' min', S.fmtClock(t.s) + ' from ' + t.first);
      }
    });
  });
  items.sort((a, b) => a.at - b.at);
  const fired = firedSet();
  return items.filter(i => !fired.has(i.key));
}

/** Arm the single timer for the next alert. Idempotent; call freely. */
export function schedule(input) {
  lastInput = input;
  clearTimeout(timer); timer = null;
  if (!settings.enabled) return null;
  if (!('Notification' in window) || Notification.permission !== 'granted') return null;
  const next = plan(input)[0];
  if (!next) return null;
  const delay = next.at - Date.now();
  if (delay > MAX_DELAY) { timer = setTimeout(() => schedule(lastInput), MAX_DELAY); return next; }
  timer = setTimeout(async () => {
    timer = null;
    // Woke up long after the moment passed (backgrounded tab) — skip silently.
    if (Date.now() > next.eventAt + 120000) { markFired(next.key); schedule(lastInput); return; }
    if (!inQuiet(Date.now())) await show(next.title, next.body, next.key);
    markFired(next.key);
    schedule(lastInput);
  }, Math.max(0, delay));
  return next;
}

export function nextPlanned() {
  if (!settings.enabled || !lastInput) return null;
  return plan(lastInput)[0] || null;
}
