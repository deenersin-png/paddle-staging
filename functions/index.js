// ==========================================================================
// Paddle App — the pre-run email.
//
// Every minute this asks one question: is anybody due to report in the next
// couple of minutes? For each operator who is, it works out their run exactly
// as the app does, fetches the bus ahead of them and the detours on their
// routes, and sends one email.
//
// Three things keep it honest:
//
//  * The send time comes from the SCHEDULE. A late leader never moves it.
//  * The claim is written to Firestore BEFORE the email goes out, with a
//    create-only write, so two instances of this function cannot both send.
//    If the send then fails the claim is dropped and the next minute retries.
//  * Nothing here reimplements the schedule rules. vendor/ holds the site's
//    own modules (see lib/plan.js).
//
// Deploying, and what it costs: functions/README.md.
// ==========================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

import * as S from './vendor/pa-schedule.js';
import { runOnDate, liveContext, loadOverrides, isDue } from './lib/plan.js';
import { buildEmail } from './lib/email.js';

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

const APP_URL = 'https://deenersin-png.github.io/septa-scheduler/home.html';
const ZONE = 'America/New_York';

/**
 * The date and the minute-of-day in PHILADELPHIA, whatever the container's
 * clock is set to. A paddle's "2:29 PM" is 2:29 PM in Philadelphia, and a
 * server that thinks in UTC would send every email four or five hours out —
 * so the timezone is asked for explicitly rather than inherited.
 */
function philadelphiaNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const at = t => parts.find(p => p.type === t).value;
  const hour = at('hour') === '24' ? '00' : at('hour');        // midnight, some ICU builds
  return {
    date: at('year') + '-' + at('month') + '-' + at('day'),
    nowMin: parseInt(hour, 10) * 60 + parseInt(at('minute'), 10)
  };
}

// How many minutes before the report time an operator is asked for by
// default, and the limits the settings screen offers.
export const DEFAULT_LEAD_MIN = 2;
// If a minute is missed (a cold start, a wobble at SEPTA), the email still
// goes — but only for this long, so nobody gets a "you start in 2 minutes"
// note twenty minutes after pulling out.
const CATCH_UP_MIN = 3;

initializeApp();
const db = getFirestore();

export const preRunEmail = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: ZONE,
  region: 'us-east1',
  memory: '512MiB',
  timeoutSeconds: 120,
  secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  retryCount: 0
}, async () => {
  // A heartbeat the app reads, so the ALERTS screen can say whether anything
  // is actually sending rather than leaving an operator waiting on a switch
  // that nothing is behind. config/* is world-readable by the rules.
  await db.collection('config').doc('emailSender')
    .set({ lastRunAt: FieldValue.serverTimestamp(), region: 'us-east1' }, { merge: true })
    .catch(() => {});

  const subs = await subscribers();
  if (!subs.length) return;

  const { date: today, nowMin } = philadelphiaNow();
  const overrides = await loadOverrides();
  let sent = 0;

  for (const sub of subs) {
    try {
      if (await handle(sub, today, nowMin, overrides)) sent++;
    } catch (err) {
      logger.error('pre-run email failed', { uid: sub.uid, error: err.message });
    }
  }
  if (sent) logger.info('pre-run emails sent', { sent, of: subs.length });
});

/** Everyone who has asked for the email, in one query. */
async function subscribers() {
  const snap = await db.collectionGroup('settings').where('emailEnabled', '==', true).get();
  return snap.docs
    .filter(d => d.id === 'notifications' && d.ref.parent.parent)
    .map(d => ({ uid: d.ref.parent.parent.id, settings: d.data() }));
}

// One operator's day, kept between invocations. A job that runs every minute
// keeps its instance warm, so this saves reading the same four documents
// sixty times an hour. It is only ever a shortcut to deciding "nothing is due
// yet": once a send is close the plan is re-read, so an edit made during the
// day is always reflected in the email that goes out.
const planCache = new Map();
const PLAN_TTL_MS = 10 * 60000;
const FRESH_WITHIN_MIN = 8;

async function planFor(uid, profile, date, nowMin, overrides, lead) {
  const key = uid + '|' + date;
  const hit = planCache.get(key);
  const closeToSend = hit && hit.plan && Math.abs(hit.plan.reportMin - lead - nowMin) <= FRESH_WITHIN_MIN;
  if (hit && !closeToSend && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;
  const plan = await runOnDate(db, uid, profile, date, overrides);
  planCache.set(key, { at: Date.now(), plan });
  if (planCache.size > 200) planCache.clear();
  return plan;
}

/** One operator. Returns true when an email went out. */
async function handle(sub, today, nowMin, overrides) {
  const { uid, settings } = sub;
  const lead = clampLead(settings.emailLeadMin);

  const profSnap = await db.collection('users').doc(uid).get();
  const profile = profSnap.exists ? profSnap.data() : null;
  if (!profile || !profile.depotKey) return false;

  const to = (settings.emailTo || profile.email || '').trim();
  if (!to) return false;

  let date = today;
  let plan = await planFor(uid, profile, date, nowMin, overrides, lead);
  let when = plan ? isDue({ reportMin: plan.reportMin, nowMin, lead, catchUp: CATCH_UP_MIN }) : null;

  // A run reporting just after midnight is due before its own day begins:
  // 12:05 AM minus 10 minutes is 11:55 PM the night before. Close to
  // midnight, tomorrow's run is the one to check.
  if ((!when || !when.due) && 1440 - nowMin <= lead + CATCH_UP_MIN) {
    const tomorrow = S.addDays(today, 1);
    const next = await planFor(uid, profile, tomorrow, nowMin, overrides, lead);
    if (next) {
      const w = isDue({ reportMin: next.reportMin, nowMin, lead, dayOffsetMin: 1440, catchUp: CATCH_UP_MIN });
      if (w.due) { date = tomorrow; plan = next; when = w; }
    }
  }

  if (!plan || !when || !when.due) return false;

  const claimId = date + '-' + plan.resolved.runNo;
  const claim = db.collection('users').doc(uid).collection('alerts').doc(claimId);
  try {
    await claim.create({ kind: 'pre-run-email', to, reportMin: plan.reportMin, claimedAt: FieldValue.serverTimestamp() });
  } catch (_) {
    return false;                       // already claimed: sent, or sending
  }

  try {
    const live = await liveContext(profile, date, plan.run, plan.reportMin);
    const mail = buildEmail({
      resolved: plan.resolved,
      run: plan.run,
      reportMin: plan.reportMin,
      minutesAway: when.minutesAway,
      live, profile, appUrl: APP_URL
    });
    await send(to, mail);
    await claim.set({ sentAt: FieldValue.serverTimestamp(), subject: mail.subject }, { merge: true });
    return true;
  } catch (err) {
    // Let the next minute try again rather than swallowing the run.
    await claim.delete().catch(() => {});
    throw err;
  }
}

function clampLead(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : DEFAULT_LEAD_MIN;
}

let transport = null;
async function send(to, mail) {
  if (!transport) {
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER.value(), pass: GMAIL_APP_PASSWORD.value() }
    });
  }
  await transport.sendMail({
    from: 'Paddle App <' + GMAIL_USER.value() + '>',
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  });
}
