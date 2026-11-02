// ==========================================================================
// Paddle App — Cloud Functions: the wiring.
//
//   runAlerts   every minute: send the phone alerts for runs that are due
//               (decisions in lib/run-alerts.js), and delete swap offers
//               whose run has started without a swap (lib/swap.js)
//   swap*       the Swap board's alerts, report counting and cleanup
//               (decisions in lib/swap.js)
//
// All push goes through Firebase Cloud Messaging, which is free. Nothing here
// reads an operator's schedule; phones plan their own alerts. What it costs,
// and deploying: functions/README.md.
// ==========================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { sendDue } from './lib/run-alerts.js';
import * as SWAP from './lib/swap.js';

const ZONE = 'America/New_York';
const REGION = 'us-east1';                 // the database's region; Firestore triggers require it
const SITE = 'https://deenersin-png.github.io/septa-scheduler/';
const SWAP_URL = SITE + 'home.html?view=swap';

initializeApp();
const db = getFirestore();

/** Today's date in Philadelphia, YYYY-MM-DD. */
const philadelphiaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

// Data-only web push: sw.js shows it, so the page needs no second worker.
// Every data value must be a string. TTL: how long the push service holds it
// for a phone that is offline; a run alert sets its own (lib/run-alerts.js).
async function sendPush(token, p) {
  await getMessaging().send({
    token,
    data: { title: p.title, body: p.body, url: p.url, tag: p.tag },
    webpush: { headers: { Urgency: 'high', TTL: String(p.ttlSec || 1800) } }
  });
}

const deps = appUrl => ({ db, sendPush, appUrl, log: logger,
                          serverTimestamp: () => FieldValue.serverTimestamp(),
                          deleteTree: ref => db.recursiveDelete(ref) });

// ---- the phone alert before a run ------------------------------------------

export const runAlerts = onSchedule({
  schedule: '* * * * *',            // every minute
  timeZone: ZONE, region: REGION, memory: '256MiB', timeoutSeconds: 60, retryCount: 0
}, async () => {
  const now = Date.now();
  const r = await sendDue(deps(SITE + 'home.html'), now);
  if (r.due) logger.info('run alerts', r);
  // The same minute job, so swap expiry needs no scheduler job of its own.
  const gone = await SWAP.expireStarted(deps(SWAP_URL), now).catch(e => { logger.error('swap expiry', String(e)); return 0; });
  if (gone) logger.info('swap expired 2 h before run start', { deleted: gone });
});

// ---- swap board -------------------------------------------------------------

export const swapInterest = onDocumentCreated({ document: 'swapOffers/{offerId}/interest/{uid}', region: REGION },
  async e => { await SWAP.onInterestCreated(deps(SWAP_URL), e.params.offerId, e.data && e.data.data()); });

export const swapStatus = onDocumentUpdated({ document: 'swapOffers/{offerId}', region: REGION },
  async e => { await SWAP.onOfferUpdated(deps(SWAP_URL), e.params.offerId, e.data.before.data(), e.data.after.data()); });

export const swapReport = onDocumentCreated({ document: 'swapReports/{reportId}', region: REGION },
  async e => { await SWAP.onReportCreated(deps(SWAP_URL), e.data && e.data.data()); });

// An offer deleted from the app leaves its interest/contact rows behind
// (the poster may not delete the other person's contact); sweep them.
export const swapDeleted = onDocumentDeleted({ document: 'swapOffers/{offerId}', region: REGION },
  async e => { await db.recursiveDelete(db.collection('swapOffers').doc(e.params.offerId)); });

export const swapCleanup = onSchedule({ schedule: '15 3 * * *', timeZone: ZONE, region: REGION, retryCount: 0 },
  async () => {
    const n = await SWAP.cleanupExpired(deps(SWAP_URL), philadelphiaDate());
    logger.info('swap cleanup', { deleted: n });
  });
