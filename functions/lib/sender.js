// ==========================================================================
// One pass of the every-minute job.
//
// index.js is only wiring: the schedule, the secrets, the real mail transport.
// Every DECISION lives here — who is due, whether an email already went out,
// what happens when sending fails — with the database, the clock, the mailer
// and the live-data lookup all passed in, so all of it can be run without
// Google, Gmail or SEPTA. test/sender.test.mjs does exactly that.
//
// The properties it is built to keep:
//
//  * One email per run, ever. The claim is written before the mail goes out,
//    create-only, so two copies of the job cannot both send; and once mail
//    HAS gone out the claim is never removed, whatever else goes wrong.
//  * A failed send frees the claim, so the next minute tries again — inside
//    the catch-up window and no longer.
//  * The email is never held up by live data. Whatever SEPTA has not answered
//    by the budget is left out, and the email says so.
//  * One operator's problem is never another operator's problem.
//  * The send time is the SCHEDULE's. A late leader never moves it.
// ==========================================================================

import * as S from '../vendor/pa-schedule.js';
import { runOnDate, liveContext, loadOverrides, isDue, cleanAddress } from './plan.js';
import { buildEmail } from './email.js';

/** Minutes before report time when an operator has not chosen. */
export const DEFAULT_LEAD_MIN = 2;

// If a minute is missed (a cold start, a wobble at SEPTA) the email still
// goes — but only for this long, so nobody gets "you start in 2 minutes"
// twenty minutes after pulling out.
export const CATCH_UP_MIN = 3;

// Live data is the garnish and the email on time is the meal. Whatever SEPTA
// has not answered by then is left out, and the email says so. Without a cap
// a SEPTA outage — exactly when a detour matters most — could stall the whole
// job past its timeout with the "already sent" claim written and nothing sent.
export const LIVE_BUDGET_MS = 20000;

// Several operators often report in the same minute (a shift change), and one
// slow email must not hold up the rest.
export const CONCURRENCY = 5;

// This server instance stays warm for days. Everything fetched from the
// schedule data is forgotten this often, so a new pick, a new GTFS feed or a
// holiday added late is never more than this out of date.
export const CACHE_MAX_AGE_MS = 10 * 60000;
let cachesClearedAt = Date.now();

const NO_LOG = { info() {}, error() {} };

// ---- small pure helpers ---------------------------------------------------

/** Minutes before report time, from the operator's setting, kept sane. */
export function clampLead(v) {
  if (v == null || v === '') return DEFAULT_LEAD_MIN;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : DEFAULT_LEAD_MIN;
}

/**
 * The document id for "the email for this run on this day". Run numbers are
 * typed by operators and a document id cannot contain a slash, so anything
 * that is not a plain character is replaced.
 */
export function claimIdFor(date, runNo) {
  return date + '-' + String(runNo).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
}

/**
 * A short code for a sweep that failed, for the status screen. Never the raw
 * message: the status document is world-readable.
 */
export function problemCode(err) {
  const msg = String((err && err.message) || '');
  const code = err && err.code;
  const precondition = code === 9 || code === 'failed-precondition' || /FAILED_PRECONDITION|requires .*index/i.test(msg);
  return precondition ? 'INDEX_BUILDING' : 'QUERY_FAILED';
}

/** `promise`, or `fallback` if it fails or is still pending after `ms`. */
function withBudget(promise, ms, fallback) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const item = items[next++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** What the email says when live data did not arrive in time. */
function unavailableLive(run) {
  const routes = run && run.routes ? run.routes : [];
  return { leader: null, leaderTrip: null, myTrip: null, detours: [], detoursFailed: routes, routes, leaderUnavailable: true };
}

// ---- who ------------------------------------------------------------------

/** Everyone who has asked for the email, in one query. */
export async function subscribers(db) {
  const snap = await db.collectionGroup('settings').where('emailEnabled', '==', true).get();
  return snap.docs
    .filter(d => d.id === 'notifications' && d.ref.parent && d.ref.parent.parent)
    .map(d => ({ uid: d.ref.parent.parent.id, settings: d.data() }));
}

// ---- one operator ---------------------------------------------------------

/**
 * Decide, and if it is time, send. Resolves to a word for what happened:
 * 'sent', 'not-due', 'no-run', 'no-profile', 'no-address', 'already-sent'.
 * Throws when the send fails (after freeing the claim).
 *
 * deps: { db, now:{date,nowMin}, overrides, send(to, mail), appUrl,
 *         serverTimestamp(), getPlan?, getLive?, liveBudgetMs? }
 */
export async function handle(deps, sub) {
  const { db, now, overrides, send, appUrl, serverTimestamp } = deps;
  const getPlan = deps.getPlan || runOnDate;
  const getLive = deps.getLive || liveContext;
  const budget = deps.liveBudgetMs != null ? deps.liveBudgetMs : LIVE_BUDGET_MS;
  const { uid, settings } = sub;
  const { date: today, nowMin } = now;
  const lead = clampLead(settings.emailLeadMin);

  const profSnap = await db.collection('users').doc(uid).get();
  const profile = profSnap.exists ? profSnap.data() : null;
  if (!profile || !profile.depotKey) return 'no-profile';

  // The address the operator chose, else the account's own. Both are checked:
  // this is text from documents the operator can write.
  const to = cleanAddress(settings.emailTo) || cleanAddress(profile.email);
  if (!to) return 'no-address';

  // Read fresh every minute, never remembered between minutes. An operator can
  // be given a run — or change one — a few minutes before reporting, and a
  // remembered "you are off today" would miss the email.
  let date = today;
  let plan = await getPlan(db, uid, profile, date, overrides);
  let when = plan ? isDue({ reportMin: plan.reportMin, nowMin, lead, catchUp: CATCH_UP_MIN }) : null;

  // A run reporting just after midnight is due before its own day begins:
  // 12:05 AM minus 10 minutes is 11:55 PM the night before. Close to
  // midnight, tomorrow's run is the one to check.
  if ((!when || !when.due) && 1440 - nowMin <= lead + CATCH_UP_MIN) {
    const tomorrow = S.addDays(today, 1);
    const next = await getPlan(db, uid, profile, tomorrow, overrides);
    if (next) {
      const w = isDue({ reportMin: next.reportMin, nowMin, lead, dayOffsetMin: 1440, catchUp: CATCH_UP_MIN });
      if (w.due) { date = tomorrow; plan = next; when = w; }
    }
  }

  if (!plan) return 'no-run';
  if (!when || !when.due) return 'not-due';

  // Claim it first. `create` fails if the document exists, which is how two
  // copies of this job — or two minutes inside the catch-up window — agree
  // that only one of them sends.
  const claim = db.collection('users').doc(uid).collection('alerts').doc(claimIdFor(date, plan.resolved.runNo));
  try {
    await claim.create({ kind: 'pre-run-email', to, reportMin: plan.reportMin, claimedAt: serverTimestamp() });
  } catch (err) {
    if (err && (err.code === 6 || /already exists/i.test(String(err.message || '')))) return 'already-sent';
    throw err;                      // a real database problem: say so, don't pretend it was sent
  }

  let mail;
  try {
    const live = await withBudget(getLive(profile, date, plan.run, plan.reportMin), budget, unavailableLive(plan.run));
    mail = buildEmail({
      resolved: plan.resolved, run: plan.run, reportMin: plan.reportMin,
      minutesAway: when.minutesAway, live, profile, appUrl
    });
    await send(to, mail);
  } catch (err) {
    // Nothing went out: free the claim so the next minute can try again.
    await Promise.resolve(claim.delete()).catch(() => {});
    if (err && typeof err === 'object') err.stage = 'send';
    throw err;
  }

  // The mail HAS gone out. Recording that is best-effort, and the claim stays
  // whatever happens: releasing it here would send the same email twice.
  await Promise.resolve(claim.set({ sentAt: serverTimestamp(), subject: mail.subject }, { merge: true })).catch(() => {});
  return 'sent';
}

// ---- everyone -------------------------------------------------------------

/**
 * One minute's pass over every subscriber. Resolves to
 * { subscribers, sent, failed, sendErrorCode, results }.
 * Throws only if the subscriber query itself fails.
 */
export async function sweep(deps) {
  const log = deps.log || NO_LOG;
  if (Date.now() - cachesClearedAt > CACHE_MAX_AGE_MS) { S.clearCaches(); cachesClearedAt = Date.now(); }

  const subs = await subscribers(deps.db);
  const out = { subscribers: subs.length, sent: 0, failed: 0, sendErrorCode: null, results: {} };
  if (!subs.length) return out;

  const overrides = deps.overrides || await loadOverrides();
  await mapLimit(subs, deps.concurrency || CONCURRENCY, async sub => {
    try {
      const r = await handle({ ...deps, overrides }, sub);
      out.results[sub.uid] = r;
      if (r === 'sent') out.sent++;
    } catch (err) {
      out.results[sub.uid] = 'error';
      out.failed++;
      if (err && err.stage === 'send') out.sendErrorCode = err.code === 'EAUTH' ? 'EAUTH' : 'SEND_FAILED';
      log.error('pre-run email failed', { uid: sub.uid, stage: err && err.stage, code: err && err.code, error: err && err.message });
    }
  });
  return out;
}

/**
 * The whole job: the sweep, then the heartbeat the ALERTS screen reads.
 * Never throws — a failed sweep is logged and shown, not raised, so the
 * scheduler does not pile retries on top of the next minute's run.
 *
 * config/emailSender holds only short CODES, because it is world-readable:
 *   problem      why the last sweep could not find anyone (cleared each good sweep)
 *   sendProblem  why the last email could not be sent (kept until one succeeds)
 */
export async function runJob(deps) {
  const log = deps.log || NO_LOG;
  let out = null, problem = null;
  try {
    out = await sweep({ ...deps, log });
  } catch (err) {
    problem = problemCode(err);
    log.error('pre-run sweep failed', { code: err && err.code, error: err && err.message });
  }

  const beat = { lastRunAt: deps.serverTimestamp(), problem };
  if (out && out.sent > 0) { beat.sendProblem = null; beat.sendProblemAt = null; }
  if (out && out.sendErrorCode) { beat.sendProblem = out.sendErrorCode; beat.sendProblemAt = deps.serverTimestamp(); }
  await Promise.resolve(deps.db.collection('config').doc('emailSender').set(beat, { merge: true })).catch(() => {});

  if (out && out.sent) log.info('pre-run emails sent', { sent: out.sent, of: out.subscribers });
  return { ...(out || { subscribers: 0, sent: 0, failed: 0, sendErrorCode: null, results: {} }), problem };
}
