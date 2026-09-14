// ==========================================================================
// Paddle App — Firebase initialisation.
//
// This module is imported lazily (see pa-account-ui.js), so a signed-out
// visitor arriving from a QR flyer downloads none of the Firebase SDK.
//
// The version below is PINNED on purpose. Never point at a floating version
// in a CDN URL — a silent SDK upgrade on a page you did not redeploy is a
// debugging nightmare.
// ==========================================================================

import { initializeApp, getApps }
  from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js';
import { getAuth, setPersistence, browserLocalPersistence }
  from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js';
import { initializeFirestore, getFirestore, memoryLocalCache }
  from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';

// ==========================================================================
// >>> PASTE YOUR CONFIG HERE <<<
//
// Firebase console -> Project settings -> General -> Your apps -> Web app
// -> "SDK setup and configuration" -> Config.
//
// This block is PUBLIC and belongs in the repo. The apiKey is an identifier,
// not a secret; it authorizes nothing on its own. What actually protects user
// data is firestore.rules at the repo root, which is enforced server-side on
// every read and write. Every Firebase web app ships these values.
// ==========================================================================
export const firebaseConfig = {
  apiKey:            'AIzaSyA8lHpm2LTC7zP0hPoMrnxaMNz4bx15JgI',
  authDomain:        'paddle-app-3e565.firebaseapp.com',
  projectId:         'paddle-app-3e565',
  storageBucket:     'paddle-app-3e565.firebasestorage.app',
  messagingSenderId: '564800408224',
  appId:             '1:564800408224:web:550e2cdf077855bff797c5'
};

/** True once real values are pasted in above. */
export const isConfigured = !Object.values(firebaseConfig).some(
  v => typeof v === 'string' && v.includes('REPLACE_ME')
);

let _app = null, _auth = null, _db = null;

/**
 * Idempotent init. Returns null when the config is still a placeholder, so
 * the account UI can show a helpful message instead of throwing and taking
 * the rest of the page down with it.
 */
export function initFirebase() {
  if (!isConfigured) return null;
  if (_app) return { app: _app, auth: _auth, db: _db };

  _app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  _auth = getAuth(_app);

  // Survive a tab close. This is the default, but state it — operators check
  // the app across a whole shift and being logged out mid-day is a support
  // ticket.
  setPersistence(_auth, browserLocalPersistence).catch(() => {
    // Private mode / blocked storage. Auth still works for this tab.
  });

  // Memory cache, deliberately NOT persistentLocalCache.
  //
  // Firestore's IndexedDB persistence is the one piece known to fail silently
  // on iPhone. WebKit drops its IndexedDB connection after Safari or a Home
  // Screen app is backgrounded ("Connection to Indexed Database server lost",
  // WebKit bug 273827), Firestore's listeners then stop WITHOUT calling their
  // error callbacks (firebase-js-sdk #4948), and because that state lives on
  // disk it survives reloads and sign-out. In the field that looked like:
  // signed in, no schedule, refresh and re-login no help, desktop fine.
  //
  // Offline display does not depend on it: pa-assignments.js and pa-store.js
  // keep a small copy of the operator's own schedule and profile in
  // localStorage and render from it until live data arrives.
  try {
    _db = initializeFirestore(_app, { localCache: memoryLocalCache() });
  } catch (e) {
    // Already initialised in this page (e.g. two modules raced) - reuse it.
    _db = getFirestore(_app);
  }

  return { app: _app, auth: _auth, db: _db };
}
