// ==========================================================================
// Paddle App — wipe one operator's data before their login is deleted.
//
// Loaded only when someone opens "Delete account", so nobody else downloads it.
//
// Everything here runs in the browser under firestore.rules as they are: each
// delete is one the owner was already allowed to make. No Cloud Function and no
// rules deploy is needed.
//
// What goes:
//   users/{uid} and its subcollections (settings, schedule, hours, vacation,
//     devices, alert state, swap blocks, favourites)
//   runAlerts the operator queued for their phone
//   swap-board offers they posted (functions/ removes those offers' interest
//     and contact docs when an offer is deleted)
//   their "I'm interested" on other people's offers
//   the phone / email they shared on other people's offers. The rules allow
//     the owner to WRITE that doc but not delete it, so it is blanked instead.
//   this phone's per-account copies in localStorage
//
// What stays: swapReports they filed (not readable by them; they carry only
// their uid, which stops meaning anything once the login is gone), and the
// tool settings everyone uses signed out (depot, route, picking) — those
// belong to the phone, not the account.
// ==========================================================================

import {
  collection, collectionGroup, doc, getDoc, getDocs, query, where,
  setDoc, deleteDoc, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';

import { initFirebase } from './pa-firebase.js';

// Every subcollection the app writes under users/{uid}. A client cannot list a
// document's subcollections, so a new one must be added here as well.
const USER_SUBCOLLECTIONS = [
  'settings', 'favorites', 'timesheets', 'devices', 'patterns',
  'assignments', 'vacations', 'alertSync', 'swapBlocks'
];

// Keys that hold this account's copy on the phone. {uid} is filled in.
const LOCAL_PER_UID = [
  'pa_profile_v1_', 'pa_schedule_v1_', 'pa_run_alerts_v3_', 'pa_setup_v1_', 'pa_swap_manual_v1_'
];
const LOCAL_ACCOUNT = [
  'pa_push_device', 'pa_notify', 'pa_swap_contact', 'pa_swap_pending', 'pa_swap_name',
  'pa_migrated_v1', 'pa_localUpdatedAt'
];

async function deleteAll(db, refs) {
  // 500 writes is a batch's ceiling; stay well under it.
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach(r => b.delete(r));
    await b.commit();
  }
}

async function wipeSwap(db, uid) {
  // Offers they posted. Deleting one makes functions/ clear its subcollections.
  const mine = await getDocs(query(collection(db, 'swapOffers'), where('posterUid', '==', uid)));
  await deleteAll(db, mine.docs.map(d => d.ref));

  // Offers someone else posted that they took part in.
  const others = new Set();
  // Tolerant: a missing collection-group index must not block deleting an account.
  const interest = await getDocs(query(collectionGroup(db, 'interest'), where('uid', '==', uid)))
    .catch(err => { console.warn('[pa] interest lookup', err.code || err.message); return { docs: [] }; });
  interest.docs.forEach(d => others.add(d.ref.parent.parent.id));
  const matched = await getDocs(query(collection(db, 'swapOffers'), where('matchedUid', '==', uid)))
    .catch(() => ({ docs: [] }));
  matched.docs.forEach(d => others.add(d.id));
  await deleteAll(db, interest.docs.map(d => d.ref));

  for (const offerId of others) {
    const ref = doc(db, 'swapOffers', offerId, 'contact', uid);
    const snap = await getDoc(ref).catch(() => null);
    if (snap && snap.exists()) {
      await setDoc(ref, { name: '', phone: '', email: '', updatedAt: serverTimestamp() });
    }
  }
}

async function wipeUserDocs(db, uid) {
  for (const sub of USER_SUBCOLLECTIONS) {
    const snap = await getDocs(collection(db, 'users', uid, sub));
    const refs = [];
    for (const d of snap.docs) {
      if (sub === 'timesheets') {
        const days = await getDocs(collection(d.ref, 'days'));
        days.docs.forEach(x => refs.push(x.ref));
      }
      refs.push(d.ref);
    }
    await deleteAll(db, refs);
  }
  await deleteDoc(doc(db, 'users', uid));
}

/**
 * Deletes every document the account owns. Throws on the first part that
 * fails, so the caller keeps the login and the operator can simply retry.
 * `onStep` gets a short line to show while it works.
 */
export async function wipeAccountData(uid, onStep = () => {}) {
  const fb = initFirebase();
  if (!fb || !uid) throw new Error('Not signed in.');
  const db = fb.db;

  onStep('Removing swap board posts…');
  await wipeSwap(db, uid);

  onStep('Removing phone alerts…');
  const alerts = await getDocs(query(collection(db, 'runAlerts'), where('uid', '==', uid)));
  await deleteAll(db, alerts.docs.map(d => d.ref));

  onStep('Removing your schedule and settings…');
  await wipeUserDocs(db, uid);
}

/** Forget this account on this phone. Tool settings everyone uses stay. */
export function forgetOnDevice(uid) {
  try {
    LOCAL_PER_UID.forEach(p => localStorage.removeItem(p + uid));
    LOCAL_ACCOUNT.forEach(k => localStorage.removeItem(k));
  } catch (_) { /* storage blocked */ }
}

/** Stop this phone's push registration. Best effort: the device doc is already gone. */
export async function dropPush() {
  try {
    const fb = initFirebase();
    const M = await import('https://www.gstatic.com/firebasejs/12.17.0/firebase-messaging.js');
    if (!(await M.isSupported())) return;
    await M.deleteToken(M.getMessaging(fb.app));
  } catch (_) { /* never registered, or offline */ }
}
