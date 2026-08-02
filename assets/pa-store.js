// ==========================================================================
// Paddle App — local-first user store.
//
// Reads are ALWAYS synchronous and ALWAYS from localStorage, so the UI never
// waits on the network. Firestore is a mirror that reconciles when it arrives.
// That is what keeps every tool working signed-out, offline, and in a depot
// parking lot with one bar.
//
// HARD CONSTRAINT: never rename or stop writing the existing localStorage
// keys. summer2026.html, spring2026.html, index-sample.html, livetest.html
// and holdowner*.html all read them and are frozen — they will never be
// updated. This module shadow-writes the legacy keys forever.
// ==========================================================================

import {
  doc, getDoc, setDoc, onSnapshot, serverTimestamp, collection, getDocs
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js';

import { initFirebase } from './pa-firebase.js';

const MIGRATED_FLAG = 'pa_migrated_v1';
const LOCAL_STAMP   = 'pa_localUpdatedAt';
const DEBOUNCE_MS   = 3000;

// SEPTA schedule data orders days Sunday-first (DAY_ORDER in index.html:990),
// so weeks here start on Sunday, not ISO Monday. One constant, one place to
// change it if payroll disagrees.
const WEEK_STARTS_ON = 0; // 0 = Sunday

let db = null;
let uid = null;
let suppress = false;          // guards the cloud -> local -> cloud loop
const timers = {};             // per-tool debounce handles
const lastSent = {};           // per-tool dirty check
const unsubs = [];

// ---- localStorage <-> settings-doc mapping --------------------------------

/** Read the current local state for one tool, straight from localStorage. */
export function readLocal(tool) {
  const g = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  if (tool === 'paddle') {
    const seasonId = g('paddleSeason') || '';
    const districtBySeason = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('paddleDepot_')) {
          districtBySeason[k.slice('paddleDepot_'.length)] = localStorage.getItem(k);
        }
      }
    } catch (_) { /* storage blocked */ }
    return { seasonId, districtBySeason };
  }
  if (tool === 'tracker') return { route: g('bt_route') || '', block: g('bt_block') || '' };
  if (tool === 'vacsick') return { viewMode: g('vacSickViewMode') || '' };
  return {};
}

/** Write one tool's state into localStorage, including the legacy keys. */
function writeLocal(tool, data) {
  const s = (k, v) => {
    try { if (v !== undefined && v !== null && v !== '') localStorage.setItem(k, v); }
    catch (_) { /* storage blocked */ }
  };
  if (tool === 'paddle') {
    s('paddleSeason', data.seasonId);
    const map = data.districtBySeason || {};
    Object.keys(map).forEach(season => s('paddleDepot_' + season, map[season]));
    // Legacy un-namespaced key, still read by summer2026.html:897 and
    // spring2026.html:897. Point it at the current season's depot.
    if (data.seasonId && map[data.seasonId]) s('paddleDepot', map[data.seasonId]);
  } else if (tool === 'tracker') {
    s('bt_route', data.route);
    s('bt_block', data.block);
  } else if (tool === 'vacsick') {
    s('vacSickViewMode', data.viewMode);
  }
}

/**
 * Order-independent signature for the dirty check. Firestore does not
 * guarantee field order on a returned document, so a plain JSON.stringify
 * comparison against a locally-built object reports false differences and
 * causes a write loop.
 */
function sig(obj) {
  return JSON.stringify(obj, (k, v) =>
    (v && typeof v === 'object' && !Array.isArray(v))
      ? Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {})
      : v
  );
}

/** Which tool owns a given localStorage key. */
function toolForKey(key) {
  if (key === 'paddleSeason' || key.startsWith('paddleDepot')) return 'paddle';
  if (key === 'bt_route' || key === 'bt_block') return 'tracker';
  if (key === 'vacSickViewMode') return 'vacsick';
  return null;
}

// ---- Firestore paths ------------------------------------------------------

const profileRef  = () => doc(db, 'users', uid);
const settingsRef = tool => doc(db, 'users', uid, 'settings', tool);
const weekRef     = weekId => doc(db, 'users', uid, 'timesheets', weekId);

// ---- profile --------------------------------------------------------------

export async function loadProfile() {
  const snap = await getDoc(profileRef());
  return snap.exists() ? snap.data() : null;
}

export async function saveProfile(fields) {
  // Keys here must stay inside the hasOnly() allowlist in firestore.rules,
  // or the write is rejected server-side.
  const payload = {
    uid,
    email:           fields.email ?? '',
    displayName:     fields.displayName ?? '',
    badgeNumber:     fields.badgeNumber ?? '',
    driverType:      fields.driverType || 'regular',
    depotKey:        fields.depotKey ?? '',
    depotLabel:      fields.depotLabel ?? '',
    defaultSeasonId: fields.defaultSeasonId ?? '',
    seniority:       fields.seniority ?? null,
    roles:           { admin: false },
    updatedAt:       serverTimestamp(),
    schemaVersion:   1,
    lastPlatform:    'web'
  };
  if (fields.createdAt) payload.createdAt = fields.createdAt;
  else payload.createdAt = serverTimestamp();

  await setDoc(profileRef(), payload, { merge: true });
  return payload;
}

// ---- settings sync --------------------------------------------------------

/** Queue a debounced cloud write for one tool. Cheap and safe to spam. */
export function scheduleSync(tool) {
  if (!db || !uid) return;
  clearTimeout(timers[tool]);
  timers[tool] = setTimeout(() => flush(tool), DEBOUNCE_MS);
  try { localStorage.setItem(LOCAL_STAMP, String(Date.now())); } catch (_) {}
}

/**
 * Write one tool's local state to Firestore now, unless nothing changed.
 *
 * The dirty check is not an optimisation, it is a quota guard. index.html
 * wires oninput="render()" on two search boxes (:955, :960) and toggleRoute()
 * fires on every route-chip tap. Wiring any of those straight through would
 * cost thousands of writes a day against a 20,000/day free tier.
 */
export async function flush(tool) {
  if (!db || !uid) return;
  clearTimeout(timers[tool]);
  const data = readLocal(tool);
  const s = sig(data);
  if (s === lastSent[tool]) return;
  lastSent[tool] = s;
  try {
    await setDoc(settingsRef(tool), { ...data, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    delete lastSent[tool];   // let the next change retry
    console.warn('[pa] settings sync failed for', tool, e.code || e.message);
  }
}

export function flushAll() { ['paddle', 'tracker', 'vacsick'].forEach(flush); }

/**
 * Apply a cloud settings doc to localStorage and re-drive the host page.
 *
 * The page's own inline script has already booted by the time any module
 * runs (index.html calls initSeasons() at :1485 during parse), so this cannot
 * pre-seed the dropdowns. It instead sets the select values and calls the
 * page's existing entry points, which already do the right thing.
 */
function applyToPage(tool, data) {
  suppress = true;
  try {
    writeLocal(tool, data);
    // Seed the dirty check from the state we just wrote. changeDistrict()
    // fires later, after an await, by which point suppress is already false —
    // without this its localStorage write would echo straight back to
    // Firestore as a redundant write of the value we just received.
    lastSent[tool] = sig(readLocal(tool));

    if (tool === 'paddle') {
      const seasonSel = document.getElementById('season-select');
      const distSel   = document.getElementById('district-select');
      if (seasonSel && data.seasonId && seasonSel.value !== data.seasonId) {
        const has = [...seasonSel.options].some(o => o.value === data.seasonId);
        if (has && typeof window.changeSeason === 'function') {
          seasonSel.value = data.seasonId;
          window.changeSeason();       // cascades into changeDistrict()
          return;
        }
      }
      const want = (data.districtBySeason || {})[data.seasonId];
      if (distSel && want && distSel.value !== want) {
        const has = [...distSel.options].some(o => o.value === want);
        if (has && typeof window.changeDistrict === 'function') {
          distSel.value = want;
          window.changeDistrict();
        }
      }
    }

    if (tool === 'tracker' && data.route) {
      const sel = document.getElementById('routeSelect');
      if (sel && sel.value !== data.route) {
        const has = [...sel.options].some(o => o.value === data.route);
        if (has) {
          sel.value = data.route;
          if (typeof window.onRouteChange === 'function') window.onRouteChange();
        }
      }
    }
  } finally {
    // Let the synchronous localStorage writes above drain before re-arming,
    // otherwise our own writes bounce straight back as a cloud sync.
    setTimeout(() => { suppress = false; }, 0);
  }
}

// ---- first sign-in migration ---------------------------------------------

/**
 * One-time merge of whatever is already on this device with whatever is in
 * the cloud. Runs once per device per account.
 *
 *   - no cloud doc  -> upload local as-is (new account on an existing phone)
 *   - cloud doc     -> newer side wins for scalars
 *   - favorites     -> always union, never delete
 */
async function migrateOnce() {
  let done = false;
  try { done = localStorage.getItem(MIGRATED_FLAG) === '1'; } catch (_) {}
  if (done) return;

  let localStamp = 0;
  try { localStamp = Number(localStorage.getItem(LOCAL_STAMP) || 0); } catch (_) {}

  for (const tool of ['paddle', 'tracker', 'vacsick']) {
    try {
      const snap = await getDoc(settingsRef(tool));
      if (!snap.exists()) {
        const local = readLocal(tool);
        if (Object.values(local).some(v => v && (typeof v !== 'object' || Object.keys(v).length))) {
          await setDoc(settingsRef(tool), { ...local, updatedAt: serverTimestamp() }, { merge: true });
        }
        continue;
      }
      const cloud = snap.data();
      const cloudMs = cloud.updatedAt?.toMillis ? cloud.updatedAt.toMillis() : 0;

      if (cloudMs >= localStamp) {
        // Union the depot map rather than replacing it, so a season this
        // device knows about but the cloud does not is preserved.
        if (tool === 'paddle') {
          const local = readLocal(tool);
          cloud.districtBySeason = { ...local.districtBySeason, ...(cloud.districtBySeason || {}) };
        }
        applyToPage(tool, cloud);
      } else {
        await flush(tool);
      }
    } catch (e) {
      console.warn('[pa] migration skipped for', tool, e.code || e.message);
    }
  }

  try { localStorage.setItem(MIGRATED_FLAG, '1'); } catch (_) {}
}

// ---- lifecycle ------------------------------------------------------------

/** Call on sign-in. Migrates, then keeps settings live across devices. */
export async function attach(userId) {
  const fb = initFirebase();
  if (!fb) return;
  db = fb.db;
  uid = userId;

  await migrateOnce();

  for (const tool of ['paddle', 'tracker', 'vacsick']) {
    unsubs.push(onSnapshot(settingsRef(tool), snap => {
      if (!snap.exists()) return;
      // Skip our own in-flight write echoing back.
      if (snap.metadata.hasPendingWrites) return;
      const data = snap.data();
      const incoming = { ...data };
      delete incoming.updatedAt;
      // Compare only the fields this tool actually owns locally, so an extra
      // field in the cloud doc does not read as a change forever.
      const local = readLocal(tool);
      const trimmed = {};
      Object.keys(local).forEach(k => { trimmed[k] = incoming[k] ?? local[k]; });
      if (sig(trimmed) === sig(local)) return;
      applyToPage(tool, data);
    }, err => console.warn('[pa] settings listener', err.code || err.message)));
  }
}

/** Call on sign-out. Leaves localStorage intact on purpose. */
export function detach() {
  unsubs.splice(0).forEach(u => { try { u(); } catch (_) {} });
  Object.keys(timers).forEach(t => clearTimeout(timers[t]));
  Object.keys(lastSent).forEach(k => delete lastSent[k]);
  db = null; uid = null;
  // Signing out must not wipe someone's depot selection — they are far more
  // likely to want their tools to keep working than to want a clean slate.
  try { localStorage.removeItem(MIGRATED_FLAG); } catch (_) {}
}

// The host page writes localStorage directly (index.html:1101, :1140,
// block-tracker.html:2220, vac.html:541). A tiny classic-script hook in each
// page's <head> re-broadcasts those writes as 'pa:setting' so this module can
// observe them without a single edit to any page's 1,500-line inline script.
window.addEventListener('pa:setting', e => {
  if (suppress) return;
  const tool = toolForKey(e.detail?.key || '');
  if (tool) scheduleSync(tool);
});

// A trailing debounce loses the last change if the user backgrounds the app
// before it fires. Both events are needed: pagehide is unreliable on mobile
// Safari, visibilitychange does not fire on desktop tab close.
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});
window.addEventListener('pagehide', flushAll);

// ---- timesheets (hours.html) ---------------------------------------------

/** Sunday-start week id, e.g. "2026-W32". */
export function weekIdFor(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const start = weekStartFor(d);
  // Week number counted from the first week-start on or before Jan 1.
  const jan1 = new Date(start.getFullYear(), 0, 1);
  const firstStart = weekStartFor(jan1);
  const weeks = Math.round((start - firstStart) / 604800000) + 1;
  return `${start.getFullYear()}-W${String(weeks).padStart(2, '0')}`;
}

export function weekStartFor(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (d.getDay() - WEEK_STARTS_ON + 7) % 7;
  d.setDate(d.getDate() - shift);
  return d;
}

export async function loadWeek(weekId) {
  if (!db || !uid) return null;
  const snap = await getDoc(weekRef(weekId));
  return snap.exists() ? snap.data() : null;
}

export async function saveWeek(weekId, payload) {
  if (!db || !uid) throw new Error('not signed in');
  await setDoc(weekRef(weekId), { ...payload, weekId, updatedAt: serverTimestamp(), schemaVersion: 1 },
               { merge: true });
}

export async function listWeeks() {
  if (!db || !uid) return [];
  const snap = await getDocs(collection(db, 'users', uid, 'timesheets'));
  return snap.docs.map(d => d.data()).sort((a, b) => (b.weekId || '').localeCompare(a.weekId || ''));
}
