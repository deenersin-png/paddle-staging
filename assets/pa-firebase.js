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
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
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
  apiKey:            'REPLACE_ME',
  authDomain:        'REPLACE_ME.firebaseapp.com',
  projectId:         'REPLACE_ME',
  storageBucket:     'REPLACE_ME.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME',
  appId:             'REPLACE_ME'
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

  // persistentLocalCache, not the deprecated enableIndexedDbPersistence().
  // This is what makes depot dead zones a non-issue: reads serve from
  // IndexedDB, writes queue locally and replay on reconnect, and snapshots
  // fire immediately from cache with metadata.fromCache === true.
  try {
    _db = initializeFirestore(_app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    // initializeFirestore throws if Firestore was already started with
    // different settings (e.g. two modules raced). Fall back to defaults.
    _db = initializeFirestore(_app, {});
  }

  return { app: _app, auth: _auth, db: _db };
}
