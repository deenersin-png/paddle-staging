// ==========================================================================
// Paddle App — account button and modal. This is the ONLY file a page
// references.
//
// Two rules govern this module:
//
// 1. NO Firebase imports at the top level. Traffic comes from QR flyers taped
//    up at depots — most visitors are signed out, first-time, on cellular.
//    They should download zero bytes of the SDK. Firebase is dynamically
//    import()ed on first click, or immediately for someone who was already
//    signed in last visit.
//
// 2. NO inline onclick anywhere. Module scripts are module-scoped, so nothing
//    declared here is reachable from an HTML attribute. Every handler is
//    attached with addEventListener, and the button markup is rendered by
//    this module rather than living in the page, so there is no window that
//    exists before its handler does.
// ==========================================================================

const SIGNED_IN_FLAG = 'pa_signed_in';

const DRIVER_TYPES = [
  { id: 'regular', label: 'REGULAR' },
  { id: 'relief',  label: 'RELIEF'  },
  { id: 'slate',   label: 'SLATE'   }
];

// Depot slugs carry the season ("callowhillb-summer2026") because they double
// as directory paths under data/. A profile must store the season-independent
// key, or a driver's home depot silently breaks the moment the next pick
// ships.
const SEASON_SUFFIX = /-(summer|fall|spring|winter)-?\d{4}$/i;
const depotKeyOf = slug => String(slug || '').replace(SEASON_SUFFIX, '');

let auth = null, store = null;      // lazily imported modules
let booting = null;                 // in-flight boot promise
let user = null, profile = null;
let slot = null, overlay = null;
let mode = 'signin';                // signin | signup

// ---- boot -----------------------------------------------------------------

// Resolves to a status rather than throwing. The caller opens the modal, so
// boot() must not — otherwise the caller's own openModal() re-renders the body
// and wipes whatever message boot() just put there.
async function boot() {
  if (booting) return booting;
  booting = (async () => {
    const fbMod = await import('./pa-firebase.js');
    if (!fbMod.isConfigured) {
      booting = null;                       // let a later attempt retry
      return { ok: false, reason: 'unconfigured' };
    }
    auth  = await import('./pa-auth.js');
    store = await import('./pa-store.js');
    window.addEventListener('pa:auth', onAuthChange);
    await auth.startAuth();
    return { ok: true };
  })();
  return booting;
}

const UNCONFIGURED_MSG =
  'Accounts are not switched on yet. Paste your Firebase project config into '
  + 'assets/pa-firebase.js to enable sign-in. Every tool on this site works '
  + 'without an account.';

async function onAuthChange(e) {
  user = e.detail.user;
  if (user) {
    try {
      await store.attach(user.uid);
      profile = await store.loadProfile();
      if (!profile) {
        profile = await store.saveProfile({
          email:       user.email || '',
          displayName: user.displayName || '',
          driverType:  'regular'
        });
      }
    } catch (err) {
      console.warn('[pa] profile load failed', err.code || err.message);
    }
  } else {
    profile = null;
    if (store) store.detach();
  }
  renderButton();
  if (overlay && !overlay.hidden) renderModal();
}

// ---- header button --------------------------------------------------------

function initials(p, u) {
  const name = (p?.displayName || u?.displayName || '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
  }
  const email = u?.email || '';
  return (email[0] || '?').toUpperCase();
}

function renderButton() {
  if (!slot) return;
  slot.textContent = '';
  slot.classList.add('pa-root');

  if (user) {
    const b = el('button', 'pa-avatar');
    b.type = 'button';
    b.setAttribute('aria-label', 'Account');
    const c = el('span', 'pa-avatar-circle');
    c.textContent = initials(profile, user);
    b.appendChild(c);
    if (profile?.badgeNumber) {
      const n = el('span', 'pa-avatar-badge');
      n.textContent = profile.badgeNumber;
      b.appendChild(n);
    }
    b.addEventListener('click', openModal);
    slot.appendChild(b);
    return;
  }

  const b = el('button', 'pa-btn');
  b.type = 'button';
  b.textContent = 'SIGN IN';
  b.addEventListener('click', async () => {
    b.classList.add('pa-loading');
    let res = { ok: false, reason: 'error' };
    try { res = await boot(); } catch (err) { console.warn('[pa] boot failed', err); }
    b.classList.remove('pa-loading');
    openModal();
    if (!res.ok) {
      showMsg(res.reason === 'unconfigured'
        ? UNCONFIGURED_MSG
        : 'Could not reach the sign-in service. Check your connection.', 'err');
      disableForm();
    }
  });
  slot.appendChild(b);
}

// ---- modal ----------------------------------------------------------------

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = el('div', 'pa-overlay pa-root');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) closeModal();
  });
  return overlay;
}

function openModal() { ensureOverlay().hidden = false; renderModal(); }
function closeModal() { if (overlay) overlay.hidden = true; }

function renderModal() {
  const o = ensureOverlay();
  o.textContent = '';
  const card = el('div', 'pa-card');
  const head = el('div', 'pa-card-head');
  const title = el('div', 'pa-card-title');
  title.textContent = user ? 'Account' : 'Paddle App Account';
  const x = el('button', 'pa-close');
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', closeModal);
  head.append(title, x);

  const body = el('div', 'pa-card-body');
  body.appendChild(msgNode());
  (user ? buildSignedIn : buildSignedOut)(body);

  card.append(head, body);
  o.appendChild(card);
}

let msgEl = null;
function msgNode() {
  msgEl = el('div', 'pa-msg');
  msgEl.hidden = true;
  return msgEl;
}
function showMsg(text, kind) {
  if (!msgEl) return;
  msgEl.className = 'pa-msg ' + (kind === 'ok' ? 'pa-ok' : 'pa-err');
  msgEl.textContent = text;
  msgEl.hidden = false;
}
function clearMsg() { if (msgEl) msgEl.hidden = true; }

/** Grey out the sign-in controls when there is no backend to talk to. */
function disableForm() {
  if (!overlay) return;
  overlay.querySelectorAll('.pa-input, .pa-select, .pa-submit, .pa-google, .pa-seg-btn, .pa-link')
    .forEach(n => { n.disabled = true; });
}

// ---- signed-out ------------------------------------------------------------

function buildSignedOut(body) {
  const tabs = el('div', 'pa-tabs');
  [['signin', 'SIGN IN'], ['signup', 'CREATE ACCOUNT']].forEach(([id, label]) => {
    const t = el('button', 'pa-tab' + (mode === id ? ' pa-on' : ''));
    t.type = 'button';
    t.textContent = label;
    t.addEventListener('click', () => { mode = id; clearMsg(); renderModal(); });
    tabs.appendChild(t);
  });
  body.appendChild(tabs);

  const form = el('form');
  form.noValidate = true;

  const email = field(form, 'Email', 'email', { type: 'email', autocomplete: 'email' });
  const pass  = field(form, 'Password', 'password', {
    type: 'password',
    autocomplete: mode === 'signup' ? 'new-password' : 'current-password'
  });

  let name, badge, depot, driverType = 'regular';
  if (mode === 'signup') {
    name  = field(form, 'Display name', 'name', { type: 'text', autocomplete: 'name' });
    badge = field(form, 'Badge number', 'badge', { type: 'text', inputmode: 'numeric' });

    const dtWrap = el('div', 'pa-field');
    dtWrap.appendChild(labelNode('Driver type'));
    const seg = el('div', 'pa-seg');
    DRIVER_TYPES.forEach(dt => {
      const b = el('button', 'pa-seg-btn' + (dt.id === driverType ? ' pa-on' : ''));
      b.type = 'button';
      b.textContent = dt.label;
      b.addEventListener('click', () => {
        driverType = dt.id;
        [...seg.children].forEach(c => c.classList.remove('pa-on'));
        b.classList.add('pa-on');
      });
      seg.appendChild(b);
    });
    dtWrap.appendChild(seg);
    form.appendChild(dtWrap);

    const dWrap = el('div', 'pa-field');
    dWrap.appendChild(labelNode('Home depot'));
    depot = el('select', 'pa-select');
    depotOptions().forEach(d => {
      const o = el('option');
      o.value = d.key; o.textContent = d.label;
      depot.appendChild(o);
    });
    dWrap.appendChild(depot);
    form.appendChild(dWrap);
  }

  const submit = el('button', 'pa-submit');
  submit.type = 'submit';
  submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  form.appendChild(submit);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    clearMsg();
    busy(form, true, submit, mode === 'signup' ? 'Create account' : 'Sign in');
    try {
      if (mode === 'signup') {
        await auth.signUp({
          email: email.value.trim(),
          password: pass.value,
          displayName: name.value.trim()
        });
        const opt = depot.selectedOptions[0];
        await store.saveProfile({
          email:       email.value.trim(),
          displayName: name.value.trim(),
          badgeNumber: badge.value.trim(),
          driverType,
          depotKey:    depot.value,
          depotLabel:  opt ? opt.textContent : ''
        });
        profile = await store.loadProfile();
        renderButton();
      } else {
        await auth.signIn({ email: email.value.trim(), password: pass.value });
      }
      closeModal();
    } catch (err) {
      showMsg(auth.errText(err), 'err');
    } finally {
      busy(form, false, submit, mode === 'signup' ? 'Create account' : 'Sign in');
    }
  });

  body.appendChild(form);

  // Google sits BELOW the email form, not above it and not behind a tab.
  // QR codes routinely open in in-app browsers (iOS Camera, Instagram,
  // Facebook) where popups are blocked and Google OAuth often refuses to run
  // at all. When that happens the user needs the email form already visible.
  const div = el('div', 'pa-divider');
  div.textContent = 'OR';
  body.appendChild(div);

  const g = el('button', 'pa-google');
  g.type = 'button';
  g.innerHTML = googleMark();
  g.appendChild(document.createTextNode('Continue with Google'));
  g.addEventListener('click', async () => {
    clearMsg();
    g.disabled = true;
    try {
      await auth.signInWithGoogle();
      closeModal();
    } catch (err) {
      showMsg(auth.errText(err), 'err');
    } finally {
      g.disabled = false;
    }
  });
  body.appendChild(g);

  if (mode === 'signin') {
    const row = el('div', 'pa-linkrow');
    const link = el('button', 'pa-link');
    link.type = 'button';
    link.textContent = 'Forgot password?';
    link.addEventListener('click', async () => {
      const addr = email.value.trim();
      if (!addr) { showMsg('Enter your email address first.', 'err'); return; }
      try {
        await auth.resetPassword(addr);
        showMsg('Password reset email sent to ' + addr + '.', 'ok');
      } catch (err) { showMsg(auth.errText(err), 'err'); }
    });
    row.appendChild(link);
    body.appendChild(row);
  }
}

// ---- signed-in -------------------------------------------------------------

function buildSignedIn(body) {
  const who = el('div', 'pa-who');
  const n = el('div', 'pa-who-name');
  n.textContent = profile?.displayName || user.displayName || 'Operator';
  const e2 = el('div', 'pa-who-email');
  e2.textContent = user.email || '';
  who.append(n, e2);
  body.appendChild(who);

  const grid = el('div', 'pa-grid');
  const dt = DRIVER_TYPES.find(d => d.id === profile?.driverType);
  [
    ['Badge',  profile?.badgeNumber || '—'],
    ['Depot',  profile?.depotLabel || profile?.depotKey || '—'],
    ['Type',   dt ? dt.label : '—'],
    ['Season', profile?.defaultSeasonId || currentSeason() || '—']
  ].forEach(([k, v]) => {
    const cell = el('div', 'pa-cell');
    const kk = el('div', 'pa-cell-k'); kk.textContent = k;
    const vv = el('div', 'pa-cell-v'); vv.textContent = v;
    cell.append(kk, vv);
    grid.appendChild(cell);
  });
  body.appendChild(grid);

  const stack = el('div', 'pa-stack');

  const hours = el('a', 'pa-ghost');
  hours.href = 'hours.html';
  hours.textContent = 'Weekly hours';
  stack.appendChild(hours);

  const edit = el('button', 'pa-ghost');
  edit.type = 'button';
  edit.textContent = 'Edit profile';
  edit.addEventListener('click', () => buildEditProfile(body));
  stack.appendChild(edit);

  const out = el('button', 'pa-ghost pa-danger');
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    if (out.dataset.confirm !== '1') {
      out.dataset.confirm = '1';
      out.textContent = 'Tap again to sign out';
      return;
    }
    try { await auth.signOut(); closeModal(); }
    catch (err) { showMsg(auth.errText(err), 'err'); }
  });
  stack.appendChild(out);

  body.appendChild(stack);
}

function buildEditProfile(body) {
  body.textContent = '';
  body.appendChild(msgNode());

  const form = el('form');
  form.noValidate = true;
  const name  = field(form, 'Display name', 'name', { type: 'text', value: profile?.displayName || '' });
  const badge = field(form, 'Badge number', 'badge', { type: 'text', inputmode: 'numeric',
                                                       value: profile?.badgeNumber || '' });

  let driverType = profile?.driverType || 'regular';
  const dtWrap = el('div', 'pa-field');
  dtWrap.appendChild(labelNode('Driver type'));
  const seg = el('div', 'pa-seg');
  DRIVER_TYPES.forEach(dt => {
    const b = el('button', 'pa-seg-btn' + (dt.id === driverType ? ' pa-on' : ''));
    b.type = 'button';
    b.textContent = dt.label;
    b.addEventListener('click', () => {
      driverType = dt.id;
      [...seg.children].forEach(c => c.classList.remove('pa-on'));
      b.classList.add('pa-on');
    });
    seg.appendChild(b);
  });
  dtWrap.appendChild(seg);
  form.appendChild(dtWrap);

  const dWrap = el('div', 'pa-field');
  dWrap.appendChild(labelNode('Home depot'));
  const depot = el('select', 'pa-select');
  depotOptions().forEach(d => {
    const o = el('option');
    o.value = d.key; o.textContent = d.label;
    if (d.key === profile?.depotKey) o.selected = true;
    depot.appendChild(o);
  });
  dWrap.appendChild(depot);
  form.appendChild(dWrap);

  const save = el('button', 'pa-submit');
  save.type = 'submit';
  save.textContent = 'Save';
  form.appendChild(save);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    clearMsg();
    busy(form, true, save, 'Save');
    try {
      const opt = depot.selectedOptions[0];
      await store.saveProfile({
        ...profile,
        email:       user.email || '',
        displayName: name.value.trim(),
        badgeNumber: badge.value.trim(),
        driverType,
        depotKey:    depot.value,
        depotLabel:  opt ? opt.textContent : '',
        createdAt:   profile?.createdAt
      });
      profile = await store.loadProfile();
      renderButton();
      renderModal();
      showMsg('Profile saved.', 'ok');
    } catch (err) {
      showMsg(err.code === 'permission-denied'
        ? 'That change was rejected by the security rules.'
        : (err.message || 'Could not save.'), 'err');
    } finally {
      busy(form, false, save, 'Save');
    }
  });

  body.appendChild(form);

  const back = el('div', 'pa-linkrow');
  const link = el('button', 'pa-link');
  link.type = 'button';
  link.textContent = 'Back';
  link.addEventListener('click', renderModal);
  back.appendChild(link);
  body.appendChild(back);
}

// ---- helpers ---------------------------------------------------------------

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function labelNode(text) {
  const l = el('label', 'pa-label');
  l.textContent = text;
  return l;
}

function field(form, label, name, attrs = {}) {
  const wrap = el('div', 'pa-field');
  wrap.appendChild(labelNode(label));
  const i = el('input', 'pa-input');
  i.name = name;
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'value') i.value = v; else i.setAttribute(k, v);
  });
  wrap.appendChild(i);
  form.appendChild(wrap);
  return i;
}

function busy(form, on, btn, label) {
  [...form.elements].forEach(n => { n.disabled = on; });
  btn.disabled = on;
  btn.textContent = on ? '…' : label;
}

function currentSeason() {
  try { return localStorage.getItem('paddleSeason') || ''; } catch (_) { return ''; }
}

/**
 * Depot list for the profile form. index.html already loads the manifest into
 * window.STATE.manifest.districts (:1119), so reuse it when it is there and
 * fall back to the known depot set on pages that never load a manifest.
 */
function depotOptions() {
  const seen = new Map();
  const districts = window.STATE?.manifest?.districts;
  if (Array.isArray(districts)) {
    districts.forEach(d => {
      const key = depotKeyOf(d.name);
      if (!seen.has(key)) seen.set(key, (d.label || d.name).replace(SEASON_SUFFIX, '').trim());
    });
  }
  if (!seen.size) {
    [
      ['callowhillb', 'Callowhill'], ['allegheny', 'Allegheny'], ['victory', 'Victory'],
      ['frontier', 'Frontier'], ['southern', 'Southern'], ['elmwood', 'Elmwood'],
      ['comly', 'Comly'], ['frankfordb', 'Frankford Bus'], ['frankford-rail', 'Frankford Rail'],
      ['midvale', 'Midvale']
    ].forEach(([k, l]) => seen.set(k, l));
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

function googleMark() {
  return '<svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">'
    + '<path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.8-1.5 4.6-4.4 6.4l6.7 5.2C42.2 35.2 45 30.1 45 24z"/>'
    + '<path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8 41.1 15.4 46 24 46z"/>'
    + '<path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 10z"/>'
    + '<path fill="#EA4335" d="M24 10.8c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.6 29.9 2 24 2 15.4 2 8 6.9 4.4 14l7.1 5.5c1.8-5.3 6.7-8.7 12.5-8.7z"/>'
    + '</svg>';
}

// ---- entry ----------------------------------------------------------------

function mount() {
  slot = document.getElementById('pa-slot');
  if (!slot) return;                       // page not wired; do nothing
  renderButton();

  // Returning user: hydrate straight away so the header does not sit on
  // "SIGN IN" while they are in fact signed in. Everyone else pays nothing
  // until they click.
  let was = false;
  try { was = localStorage.getItem(SIGNED_IN_FLAG) === '1'; } catch (_) {}
  if (was) {
    const b = slot.querySelector('.pa-btn');
    if (b) b.classList.add('pa-loading');
    boot()
      .catch(err => console.warn('[pa] boot failed', err))
      .finally(() => {
        const btn = slot.querySelector('.pa-btn');
        if (btn) btn.classList.remove('pa-loading');
      });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
