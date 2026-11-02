// ==========================================================================
// Paddle App — swap board storage.
//
// Every Firestore read and write the Swap board makes, and nothing else. The
// rules in assets/pa-swap.js decide; this module only moves documents. The
// public board (swap.html) uses the read half signed out: firestore.rules
// lets anyone read an open offer.
//
// Paths and fields: the model comment at the top of assets/pa-swap.js.
// ==========================================================================

import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, collectionGroup,
  query, where, serverTimestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';

import { initFirebase } from './pa-firebase.js';
import { pastCutoff } from './pa-swap.js';


const db = () => { const fb = initFirebase(); if (!fb) throw new Error('Firebase is not configured'); return fb.db; };
const offersCol = () => collection(db(), 'swapOffers');
const offerRef = id => doc(db(), 'swapOffers', id);
const withId = s => ({ id: s.id, ...s.data() });

// ---- the board ------------------------------------------------------------

/** Open offers for one district that have not expired, soonest first. An
 *  offer whose run starts within two hours is over even before the server deletes it. */
export async function listBoard(depotKey, today) {
  const snap = await getDocs(query(offersCol(),
    where('depotKey', '==', depotKey), where('status', '==', 'open'), where('expiresOn', '>=', today)));
  const now = Date.now();
  return snap.docs.map(withId).filter(o => !pastCutoff(o, now)).sort((a, b) => a.give.date.localeCompare(b.give.date)
    || (a.give.reportMin || 0) - (b.give.reportMin || 0));
}

export async function getOffer(id) {
  const s = await getDoc(offerRef(id));
  return s.exists() ? withId(s) : null;
}

// ---- my offers ------------------------------------------------------------

/** The operator's own offers. One whose run starts within two hours without a swap is
 *  deleted here too, in case the server has not got to it yet. */
export async function myOffers(uid) {
  const snap = await getDocs(query(offersCol(), where('posterUid', '==', uid)));
  const now = Date.now();
  const all = snap.docs.map(withId);
  all.filter(o => pastCutoff(o, now)).forEach(o => { deleteOffer(o.id).catch(() => {}); });
  return all.filter(o => !pastCutoff(o, now)).sort((a, b) => a.give.date.localeCompare(b.give.date));
}

export async function createOffer(fields) {
  const ref = await addDoc(offersCol(), { ...fields, status: 'open', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return ref.id;
}

/** Edit an open offer's content (never its owner, status or report count). */
export async function editOffer(id, fields) {
  await updateDoc(offerRef(id), { ...fields, updatedAt: serverTimestamp() });
}

export async function cancelOffer(id) {
  await updateDoc(offerRef(id), { status: 'cancelled', updatedAt: serverTimestamp() });
}

/** Remove an offer for good. Its interest rows go first (the poster may
 *  delete those); functions/ sweeps anything left under it. */
export async function deleteOffer(id) {
  const rows = await getDocs(collection(db(), 'swapOffers', id, 'interest')).catch(() => ({ docs: [] }));
  await Promise.all(rows.docs.map(d => deleteDoc(d.ref).catch(() => {})));
  await deleteDoc(offerRef(id));
}

/** The poster picks one interested operator; that opens contact between them. */
export async function pickInterested(id, who) {
  await updateDoc(offerRef(id), { status: 'matched', matchedUid: who.uid, matchedName: who.name, matchedAt: serverTimestamp(), updatedAt: serverTimestamp() });
}

/** Back to the board, e.g. the talk went nowhere. */
export async function unpick(id) {
  await updateDoc(offerRef(id), { status: 'open', matchedUid: deleteField(), matchedName: deleteField(), matchedAt: deleteField(), updatedAt: serverTimestamp() });
}

/** Either side, once they have agreed. The dispatcher still has to approve. */
export async function markArranged(id, uid) {
  await updateDoc(offerRef(id), { status: 'arranged', arrangedBy: uid, updatedAt: serverTimestamp() });
}

// ---- interest -------------------------------------------------------------

const interestRef = (offerId, uid) => doc(db(), 'swapOffers', offerId, 'interest', uid);

export async function listInterest(offerId) {
  const snap = await getDocs(collection(db(), 'swapOffers', offerId, 'interest'));
  return snap.docs.map(withId);
}

export async function myInterest(offerId, uid) {
  const s = await getDoc(interestRef(offerId, uid));
  return s.exists() ? withId(s) : null;
}

export async function expressInterest(offerId, uid, data) {
  await setDoc(interestRef(offerId, uid), { ...data, uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}

export async function withdrawInterest(offerId, uid) { await deleteDoc(interestRef(offerId, uid)); }
/** The poster removes someone's interest from their offer. */
export async function dismissInterest(offerId, uid) { await deleteDoc(interestRef(offerId, uid)); }

/** Offers this operator said "I'm interested" in, each with its interest row.
 *  An offer the reader can no longer see (hidden, deleted) is left out. */
export async function interestedOffers(uid) {
  const snap = await getDocs(query(collectionGroup(db(), 'interest'), where('uid', '==', uid)));
  const rows = await Promise.all(snap.docs.map(async d => {
    const offerId = d.ref.parent.parent.id;
    try { const o = await getOffer(offerId); return o ? { offer: o, interest: withId(d) } : null; }
    catch (_) { return null; }
  }));
  const now = Date.now();
  return rows.filter(r => r && !pastCutoff(r.offer, now)).sort((a, b) => a.offer.give.date.localeCompare(b.offer.give.date));
}

// ---- contact (shared only after a pick) -----------------------------------

const contactRef = (offerId, uid) => doc(db(), 'swapOffers', offerId, 'contact', uid);

export async function saveContact(offerId, uid, c) {
  await setDoc(contactRef(offerId, uid), {
    name: String(c.name || '').slice(0, 60), phone: String(c.phone || '').slice(0, 30),
    email: String(c.email || '').slice(0, 120), updatedAt: serverTimestamp()
  });
}

/** The other person's contact, or null before the pick / when none was left. */
export async function readContact(offerId, uid) {
  try { const s = await getDoc(contactRef(offerId, uid)); return s.exists() ? s.data() : null; }
  catch (_) { return null; }
}

// The contact an operator typed last time, offered again next time.
const CONTACT_KEY = 'pa_swap_contact';
export function lastContact() { try { return JSON.parse(localStorage.getItem(CONTACT_KEY) || 'null') || {}; } catch (_) { return {}; } }
export function rememberContact(c) { try { localStorage.setItem(CONTACT_KEY, JSON.stringify({ phone: c.phone || '', email: c.email || '' })); } catch (_) {} }

// ---- report and block -------------------------------------------------------

export async function reportOffer(offerId, uid, reason, note) {
  await setDoc(doc(db(), 'swapReports', offerId + '_' + uid), {
    offerId, reporterUid: uid, reason, note: String(note || '').slice(0, 280), createdAt: serverTimestamp()
  });
}

export async function listBlocks(uid) {
  const snap = await getDocs(collection(db(), 'users', uid, 'swapBlocks'));
  return new Map(snap.docs.map(d => [d.id, d.data().name || '']));
}
export async function block(uid, otherUid, name) {
  await setDoc(doc(db(), 'users', uid, 'swapBlocks', otherUid), { name: name || '', createdAt: serverTimestamp() });
}
export async function unblock(uid, otherUid) { await deleteDoc(doc(db(), 'users', uid, 'swapBlocks', otherUid)); }

