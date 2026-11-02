// ==========================================================================
// Paddle App — phone alerts for a run, which arrive even with the app closed.
// They are the ONLY alerts: there is no in-app timer.
//
//   report alert 1   report1Lead min before report time   (default 30)
//   report alert 2   report2Lead min before report time   (default 1)
//   departure        depLead min before the pull-out, each trip departure
//                    and the start of each later piece    (default 0: on time)
// Each can be switched off on its own (pa-notify.js keeps the settings).
//
// Built to stay free with thousands of operators. The PHONE works out its
// own alert times from its own schedule and leaves them in runAlerts/, one
// small document per alert, rewriting only what changed. Report alerts are
// kept PLAN_DAYS ahead; departures about a week (DEP_DAYS), as there are a
// dozen or more a day and each needs the day's GTFS trips. The server
// (functions/lib/run-alerts.js) does one query a minute for what is due,
// sends it through Cloud Messaging (free) and deletes it. It never reads
// anyone's schedule.
//
// Every time is a SCHEDULED time. A late bus ahead never moves it. Times are
// minutes from midnight of the run's schedule day, so a night liner filed
// under tomorrow alerts the evening before (pa-schedule normalizeRun).
//
// runAlerts/{uid}_{date}_{key}   owner only (firestore.rules)
//   uid, date, key, sendAtMs, title, body, updatedAt
//   key: rep1 | rep2 | d<minute + 1440>
// runAlerts/{uid}_test           one test alert, minutes out (no key)
//
// The planning half is pure (no Firebase) so assets/tests/run-alerts.test.mjs
// can pin it; Firestore is loaded only when syncRunAlerts runs.
// ==========================================================================

import { addDays, minToMs, fmtClock, DAY_SHORT, dowOf } from './pa-schedule.js';

/** How far ahead report alerts are kept on the server. Opening the app tops it up. */
export const PLAN_DAYS = 14;
/** How many days get departure alerts, counting from the first day planned
 *  (yesterday, for a run still going past midnight): yesterday through 6 days ahead. */
export const DEP_DAYS = 8;
export const DEFAULTS = { report1On: true, report1Lead: 30, report2On: true, report2Lead: 1, depOn: true, depLead: 0 };

const LS_PREFIX = 'pa_run_alerts_v3_';   // v3: { rev, a }; v2 copies are dropped and re-read once
const FIRESTORE = 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';
const BATCH_MAX = 400;

const dayLabel = iso => DAY_SHORT[dowOf(iso)] + ' ' + Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const lead = (v, d) => (v !== '' && v != null && Number.isFinite(+v) && +v >= 0 ? Math.round(+v) : d);

/**
 * The scheduled departures of one run: the pull-out, each later piece's
 * start, and every GTFS trip departure inside a piece. tripsOf(piece) gives
 * the piece's trips on the run's clock (pa-schedule pieceTrips); without it
 * only the piece starts are known.
 */
export async function runDepartures(run, tripsOf) {
  const out = new Map();
  const pieces = (run && run.pieces) || [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.startMin == null) continue;
    out.set(p.startMin, { min: p.startMin, what: i === 0 ? 'pull-out' : 'next piece',
                          where: p.routeLabel + ' · block ' + p.block });
    let trips = [];
    if (tripsOf) { try { trips = (await tripsOf(p)) || []; } catch (_) {} }
    for (const t of trips) {
      // GTFS lists some trips twice (service variants): one alert per minute.
      if (t.s > p.startMin && (p.endMin == null || t.s < p.endMin) && !out.has(t.s)) {
        out.set(t.s, { min: t.s, what: 'departure', where: (t.first ? 'from ' + t.first + ' · ' : '') + p.routeLabel });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.min - b.min);
}

/**
 * The operator's working days from `from` for `n` days, as
 * [{ date, runNo, reportMin, routeLabel, departures?, partial? }]. resolve(date)
 * and runFor(resolved, date) are pa-assignments / pa-edit-sheet's;
 * tripsOf(piece, dayType) is pa-schedule pieceTrips. Departures are looked up
 * for the first `depDays` days only. partial: the paddle or the trips did not
 * load (weak signal), so the departures are not known - syncRunAlerts then
 * keeps the ones already saved instead of deleting them.
 */
export async function upcomingRuns({ resolve, runFor, tripsOf, from, n = PLAN_DAYS, depDays = DEP_DAYS }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(from, i);
    const r = resolve(date);
    if (!r || r.off || !r.runNo) continue;
    let run = null;
    try { run = await runFor(r, date); } catch (_) {}
    const reportMin = run && run.reportMin != null ? run.reportMin : r.reportMin;
    if (reportMin == null) continue;
    const labels = run && run.pieces ? [...new Set(run.pieces.map(p => p.routeLabel).filter(Boolean))] : [];
    const day = { date, runNo: String(r.runNo), reportMin, routeLabel: labels.join(' / ') };
    if (i < depDays && run && run.pieces && run.pieces.length) {
      let missed = false;
      const tf = tripsOf ? p => Promise.resolve().then(() => tripsOf(p, run.dayType)).catch(e => { missed = true; throw e; }) : null;
      day.departures = await runDepartures(run, tf);
      if (missed) day.partial = true;
    } else if (i < depDays && !run) {
      day.partial = true;
    }
    out.push(day);
  }
  return out;
}

/**
 * Pure: every alert still in the future, soonest first. `settings` is
 * pa-notify's (report1On, report1Lead, report2On, report2Lead, depOn,
 * depLead); missing fields take DEFAULTS. Two alerts due at the same moment
 * for one run are sent once.
 */
export function planRunAlerts(days, settings, nowMs) {
  const s = { ...DEFAULTS, ...(settings || {}) };
  const out = [];
  for (const d of days || []) {
    const when = new Set();
    const add = (key, atMin, title, body) => {
      const sendAtMs = minToMs(d.date, atMin);
      if (sendAtMs <= nowMs + 60000 || when.has(sendAtMs)) return;
      when.add(sendAtMs);
      out.push({ date: d.date, key, sendAtMs, title: cut(title, 80), body: cut(body, 200) });
    };
    const inMin = (what, m) => 'Run ' + d.runNo + ' · ' + what + (m ? ' in ' + m + ' min' : ' now');
    const repBody = 'Report ' + fmtClock(d.reportMin) + (d.routeLabel ? ' · ' + d.routeLabel : '') + ' · ' + dayLabel(d.date);
    if (s.report1On) { const m = lead(s.report1Lead, DEFAULTS.report1Lead); add('rep1', d.reportMin - m, inMin('report', m), repBody); }
    if (s.report2On) { const m = lead(s.report2Lead, DEFAULTS.report2Lead); add('rep2', d.reportMin - m, inMin('report', m), repBody); }
    if (s.depOn) {
      const m = lead(s.depLead, DEFAULTS.depLead);
      for (const x of d.departures || []) {
        add('d' + (x.min + 1440), x.min - m, inMin(x.what, m), fmtClock(x.min) + ' · ' + x.where);
      }
    }
  }
  return out.sort((a, b) => a.sendAtMs - b.sendAtMs);
}

const sigOf = a => a.sendAtMs + '|' + a.title + '|' + a.body;

function readKnown(uid) {
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + uid) || 'null'); } catch (_) { return null; }
}
function writeKnown(uid, m) { try { localStorage.setItem(LS_PREFIX + uid, JSON.stringify(m)); } catch (_) {} }

/**
 * Make runAlerts/ match this operator's schedule. Writes only what changed,
 * so an unchanged week costs nothing. enabled false clears them all.
 * Resolves { count, next, through, writes, reports, departures }.
 *
 * Each phone keeps a copy of what the server holds, so it can skip unchanged
 * alerts. Another phone or computer on the same account can change the server
 * behind its back, and the copy then said "saved" for alerts that were gone.
 * So every write also stamps users/{uid}/alertSync/state with a new rev; a
 * phone that sees a rev it did not write reads the server again (one read
 * per sync otherwise).
 */
export async function syncRunAlerts({ db, uid, enabled, settings, days, now = Date.now(), firestore }) {
  const F = firestore || await import(FIRESTORE);      // firestore: a stand-in, for the tests
  const col = F.collection(db, 'runAlerts');
  const stateRef = F.doc(db, 'users', uid, 'alertSync', 'state');
  const serverRev = await F.getDoc(stateRef).then(s => (s.exists() && s.data().rev) || null);
  // known: { id: { s: signature, at: sendAtMs } } of what the server holds.
  const local = readKnown(uid);
  let known = local && local.rev === serverRev ? local.a : null;
  if (!known) {
    // First sync on this phone, or another device changed them: learn what is
    // there (also the older app's one alert a day under {uid}_{date}).
    known = {};
    const snap = await F.getDocs(F.query(col, F.where('uid', '==', uid)));
    snap.forEach(d => { const x = d.data(); if (x.date !== 'test') known[d.id] = { s: sigOf(x), at: x.sendAtMs }; });
  }
  // The server deletes an alert once it is sent; forget those here too.
  Object.keys(known).forEach(id => { if (known[id].at <= now) delete known[id]; });

  const want = enabled ? planRunAlerts(days || [], settings, now) : [];
  // Days whose departures could not be worked out: keep what was saved for the same run.
  const partial = new Map((enabled ? days || [] : []).filter(d => d.partial).map(d => [d.date, '|Run ' + d.runNo + ' · ']));
  const ops = [];
  const ids = new Set();
  for (const a of want) {
    const id = uid + '_' + a.date + '_' + a.key;
    ids.add(id);
    if (known[id] && known[id].s === sigOf(a)) continue;
    ops.push(['set', id, { uid, date: a.date, key: a.key, sendAtMs: a.sendAtMs, title: a.title, body: a.body }]);
    known[id] = { s: sigOf(a), at: a.sendAtMs };
  }
  for (const id of Object.keys(known)) {
    if (ids.has(id)) continue;
    const date = id.slice(uid.length + 1, uid.length + 11), key = id.slice(uid.length + 12);
    if (key.startsWith('d') && partial.has(date) && known[id].s.includes(partial.get(date))) continue;
    ops.push(['delete', id]);
    delete known[id];
  }
  let rev = serverRev;
  if (ops.length) {
    rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    ops.push(['state']);
  }
  for (let i = 0; i < ops.length; i += BATCH_MAX) {
    const batch = F.writeBatch(db);
    for (const [op, id, data] of ops.slice(i, i + BATCH_MAX)) {
      if (op === 'set') batch.set(F.doc(col, id), { ...data, updatedAt: F.serverTimestamp() });
      else if (op === 'state') batch.set(stateRef, { rev, updatedAt: F.serverTimestamp() });
      else batch.delete(F.doc(col, id));
    }
    await batch.commit();
  }
  writeKnown(uid, { rev, a: known });
  return {
    count: want.length, next: want[0] || null, through: want.length ? want[want.length - 1].date : null, writes: ops.length,
    reports: want.filter(a => a.key.startsWith('rep')).length, departures: want.filter(a => a.key.startsWith('d')).length
  };
}

export const TEST_DELAY_MIN = 2;

/** Pure: the test alert, sent by the same server path as a real one. */
export function testAlert(nowMs, delayMin = TEST_DELAY_MIN) {
  const sendAtMs = nowMs + delayMin * 60000;
  const at = new Date(sendAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return { date: 'test', sendAtMs, title: 'Test alert · Paddle App',
           body: 'Phone alerts work, even with the app closed. Set for ' + at + '.' };
}

/**
 * Leave a test alert for the server to send in TEST_DELAY_MIN minutes, so
 * the operator can close the app and see a real push arrive. Its own doc,
 * runAlerts/{uid}_test, so it never replaces a real alert.
 * Resolves the alert written.
 */
export async function sendTestAlert({ db, uid, now = Date.now() }) {
  const F = await import(FIRESTORE);
  const a = testAlert(now);
  await F.setDoc(F.doc(db, 'runAlerts', uid + '_test'),
                 { uid, date: a.date, sendAtMs: a.sendAtMs, title: a.title, body: a.body, updatedAt: F.serverTimestamp() });
  return a;
}

/**
 * The alerts this phone last saved that came due in (fromMs, toMs], soonest
 * first, as [{ at, title, body }]: what the operator may have missed while
 * the phone was offline. Read it BEFORE the next syncRunAlerts, which forgets
 * alerts once their time has passed.
 */
export function dueBetween(uid, fromMs, toMs) {
  const local = readKnown(uid);
  const out = [];
  for (const x of Object.values((local && local.a) || {})) {
    if (!(x.at > fromMs && x.at <= toMs)) continue;
    const [, title = '', ...body] = String(x.s).split('|');   // signature: sendAtMs|title|body
    out.push({ at: x.at, title, body: body.join('|') });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Whether this phone has synced alerts for `uid` before. When it has not and
 *  alerts are off, there is nothing to clear and no reason to ask the server. */
export const hasLocal = uid => readKnown(uid) !== null;

/** Forget this phone's copy, e.g. on sign-out. */
export function forget(uid) { try { localStorage.removeItem(LS_PREFIX + uid); } catch (_) {} }
