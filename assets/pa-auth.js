// ==========================================================================
// Paddle App — authentication.
//
// Auth only. Everything that touches Firestore lives in pa-store.js, so this
// module never pulls in firebase-firestore.js (the heaviest of the three).
//
// Contract with the rest of the app:
//   - dispatches window 'pa:auth' with detail { user } on every state change
//   - keeps localStorage 'pa_signed_in' in sync so the UI can decide whether
//     to boot Firebase eagerly on the next page load
// ==========================================================================

import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
  sendPasswordResetEmail,
  signOut as fbSignOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  deleteUser
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js';

import { initFirebase, isConfigured } from './pa-firebase.js';

export const SIGNED_IN_FLAG = 'pa_signed_in';

let auth = null;
let currentUser = null;
let started = false;

/** Idempotent. Starts the auth listener; resolves on the first state report. */
export function startAuth() {
  if (!isConfigured) return Promise.resolve(null);
  const fb = initFirebase();
  if (!fb) return Promise.resolve(null);
  auth = fb.auth;

  if (started) return Promise.resolve(currentUser);
  started = true;

  return new Promise(resolve => {
    let first = true;
    onAuthStateChanged(auth, user => {
      currentUser = user;
      try {
        if (user) localStorage.setItem(SIGNED_IN_FLAG, '1');
        else localStorage.removeItem(SIGNED_IN_FLAG);
      } catch (_) { /* storage blocked; not fatal */ }

      window.dispatchEvent(new CustomEvent('pa:auth', { detail: { user } }));
      if (first) { first = false; resolve(user); }
    });
  });
}

export function getUser() { return currentUser; }

// ---- flows ----------------------------------------------------------------

export async function signUp({ email, password, displayName }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(cred.user, { displayName });
  }
  return cred.user;
}

export async function signIn({ email, password }) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

// Popup, never signInWithRedirect.
//
// Redirect sign-in needs Firebase's /__/auth/handler served same-origin. This
// site is on GitHub Pages, which is a pure static file server: no rewrites, no
// proxying, no custom headers. It cannot host that path, and the cross-origin
// fallback is broken by third-party storage partitioning in current browsers.
// So redirect would work in some browsers and fail confusingly in others.
//
// Popup has its own failure mode worth knowing about: QR codes routinely open
// in in-app browsers (iOS Camera, Instagram, Facebook), which block popups and
// which Google OAuth often refuses outright. That is why the email/password
// form stays visible behind this button rather than being hidden behind a tab.
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function signOut() {
  await fbSignOut(auth);
}

// ---- account deletion -------------------------------------------------------
//
// Firebase only deletes an account that signed in within the last few minutes
// (auth/requires-recent-login). So the delete screen proves who it is FIRST —
// password, or the Google window — and only then wipes data and the login.
// Doing it in that order means a wrong password never leaves someone with
// their data gone but their login still there.

/** True when the account signs in with email + password (it needs the password to delete). */
export function usesPassword() {
  return !!currentUser?.providerData?.some(p => p.providerId === 'password');
}

export async function reauthenticate(password) {
  const u = auth.currentUser;
  if (!u) throw Object.assign(new Error('Not signed in.'), { code: 'auth/no-current-user' });
  if (usesPassword()) {
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, password || ''));
  } else {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await reauthenticateWithPopup(u, provider);
  }
}

/** Deletes the login itself. Call reauthenticate() first. */
export async function deleteLogin() {
  await deleteUser(auth.currentUser);
}

// ---- error copy -----------------------------------------------------------
//
// Email-enumeration protection is ON by default in Firebase Auth, which
// deliberately collapses user-not-found and wrong-password into the single
// code auth/invalid-credential. Do not try to tell them apart — that is the
// point of the feature.

const ERRS = {
  'auth/invalid-credential':      'Email or password is incorrect.',
  'auth/invalid-email':           'That does not look like an email address.',
  'auth/missing-password':        'Enter your password.',
  'auth/email-already-in-use':    'An account already exists for that email.',
  'auth/weak-password':           'Password must be at least 6 characters.',
  'auth/too-many-requests':       'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed':  'No connection. Your settings are still saved on this phone.',
  'auth/popup-blocked':           'Your browser blocked the Google window. Use email and password below.',
  'auth/popup-closed-by-user':    'Google sign-in was cancelled.',
  'auth/cancelled-popup-request': 'Google sign-in was cancelled.',
  'auth/operation-not-allowed':   'That sign-in method is not enabled for this project yet.',
  'auth/unauthorized-domain':     'This site is not in the Firebase authorized-domains list.',
  'auth/wrong-password':          'That password is not right.',
  'auth/user-mismatch':           'That is a different Google account. Pick the one you signed in with.',
  'auth/requires-recent-login':   'For safety, enter your password again and retry.'
};

export function errText(e) {
  if (!e) return 'Something went wrong.';
  return ERRS[e.code] || e.message || 'Something went wrong.';
}
