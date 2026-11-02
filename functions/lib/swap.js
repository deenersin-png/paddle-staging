// ==========================================================================
// Swap board: notifications, report counting and cleanup.
//
// index.js is only wiring (the Firestore triggers and the daily schedule).
// Every decision lives here, with the database, the push sender and the
// clock passed in, so test/swap.test.mjs can run all of it without Google.
//
// Who hears what:
//   someone says "I'm interested"     -> the poster
//   the poster picks someone          -> the person picked
//   either side marks it arranged     -> the other side, with the reminder
//                                        that the dispatcher must approve it
//   the poster cancels after a pick   -> the person who was picked
//
// Push goes out through lib/push.js, to every phone the person registered.
// ==========================================================================

import { notify } from './push.js';

/** Reports from different operators that take an offer off the board. */
export const HIDE_AT_REPORTS = 3;

export const DISPATCH_REMINDER = 'The dispatcher must still approve it.';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/** "Sat run 300" */
export const runLabel = give => (give && give.date ? DAY[dow(give.date)] + ' ' : '') + 'run ' + ((give && give.runNo) || '?');

// ---- messages (pure) --------------------------------------------------------

export function interestMessage(offer, interest) {
  const who = (interest && interest.name) || 'An operator';
  const theirs = interest && interest.run ? ' (they give ' + runLabel(interest.run) + ')' : '';
  return { title: 'Swap: someone is interested', body: who + ' wants your ' + runLabel(offer.give) + theirs + '. Open the Swap tab to pick.', tag: 'swap-int-' + offer.id };
}

/** The message for an offer's status change, or null when nobody needs one. */
export function statusMessage(before, after) {
  if (!before || !after || before.status === after.status) return null;
  const run = runLabel(after.give);
  if (after.status === 'matched' && after.matchedUid) {
    return { to: [after.matchedUid], title: 'Swap: you were picked',
             body: (after.posterName || 'The poster') + ' picked you for ' + run + '. Their contact is in the Swap tab.', tag: 'swap-' + after.id };
  }
  if (after.status === 'arranged') {
    const other = after.arrangedBy === after.posterUid ? after.matchedUid : after.posterUid;
    if (!other) return null;
    return { to: [other], title: 'Swap marked arranged',
             body: run + ' was marked arranged. ' + DISPATCH_REMINDER, tag: 'swap-' + after.id };
  }
  if (after.status === 'cancelled' && before.status === 'matched' && before.matchedUid) {
    return { to: [before.matchedUid], title: 'Swap cancelled',
             body: (after.posterName || 'The poster') + ' cancelled ' + run + '.', tag: 'swap-' + after.id };
  }
  return null;
}

// ---- triggers -----------------------------------------------------------------

export async function onInterestCreated(deps, offerId, interest) {
  const snap = await deps.db.collection('swapOffers').doc(offerId).get();
  if (!snap.exists) return 0;
  const offer = { id: offerId, ...snap.data() };
  if (offer.status !== 'open' || !offer.posterUid || offer.posterUid === (interest && interest.uid)) return 0;
  return notify(deps, [offer.posterUid], interestMessage(offer, interest));
}

export async function onOfferUpdated(deps, offerId, before, after) {
  const m = statusMessage(before, { id: offerId, ...after });
  return m ? notify(deps, m.to, m) : 0;
}

/**
 * Count a report. At HIDE_AT_REPORTS distinct reporters (a report's id is
 * offerId_uid, so one person counts once) the offer is hidden from the board.
 */
export async function onReportCreated(deps, report) {
  const { db } = deps;
  if (!report || !report.offerId) return null;
  const ref = db.collection('swapOffers').doc(report.offerId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const all = await db.collection('swapReports').where('offerId', '==', report.offerId).get();
  const count = all.docs.length;
  const patch = { reportCount: count };
  if (count >= HIDE_AT_REPORTS && snap.data().status === 'open') patch.status = 'hidden';
  await ref.set(patch, { merge: true });
  return patch;
}

/**
 * Daily: delete offers whose last useful day is gone, with everything under
 * them. An arranged swap is kept a week longer so both sides can still read
 * each other's contact on the day. deps.deleteTree(ref) removes a document
 * and its subcollections (Admin SDK recursiveDelete).
 */
export async function cleanupExpired(deps, today) {
  const { db, deleteTree } = deps;
  const snap = await db.collection('swapOffers').where('expiresOn', '<', today).get();
  const cutoffArranged = addDaysIso(today, -7);
  let n = 0;
  for (const d of snap.docs) {
    const o = d.data();
    if (o.status === 'arranged' && o.expiresOn >= cutoffArranged) continue;
    await deleteTree(d.ref);
    n++;
  }
  return n;
}

/** No swap within this many minutes of a run's start (assets/pa-swap.js CUTOFF_MIN). */
export const CUTOFF_MIN = 120;

/**
 * Every minute: an offer whose run starts within CUTOFF_MIN (startsAtMs, the
 * real clock time, a night liner's the evening before its date) is over
 * unless the swap was arranged, and is deleted with everything under it. An arranged one is
 * left for cleanupExpired and its startsAtMs cleared so it is not read again.
 */
export async function expireStarted(deps, nowMs) {
  const { db, deleteTree } = deps;
  const snap = await db.collection('swapOffers').where('startsAtMs', '<=', nowMs + CUTOFF_MIN * 60000).get();
  let n = 0;
  for (const d of snap.docs) {
    const o = d.data();
    if (typeof o.startsAtMs !== 'number') continue;
    if (o.status === 'arranged') { await d.ref.set({ startsAtMs: null }, { merge: true }); continue; }
    await deleteTree(d.ref);
    n++;
  }
  return n;
}

export function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
