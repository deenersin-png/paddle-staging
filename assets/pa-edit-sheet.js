// ==========================================================================
// Paddle App — the day edit sheet, shared by home.html and hours.html.
//
// Editing a day writes ONLY assignments/{date}; the pattern is never touched.
// "Revert to my pattern" deletes that document.
//
// One dropdown decides the day's kind; each kind shows only the fields it
// needs. Hours for a known run come from the paddle and are pre-filled, never
// required. A run swapped in from another day's schedule (a Sunday run worked
// on a Monday) carries `runDayType`, so its hours come from the right paddle.
// ==========================================================================

import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';
import * as SR from './pa-short-runs.js';

const cfg = { profile: null, onSaved: null, onClosed: null, dayNotes: null };
let overlay = null, msgEl = null;
const slugCache = new Map();

export function configure(c) { Object.assign(cfg, c); }

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The ids are stored on saved days, so they stay as they are; only the
// labels changed ('holiday-worked' = Holiday premium, 'paid-off' = Earned
// paid off day, 'unpaid-off' = Earned excused off).
export const KINDS = [
  ['normal',           'Normal hours worked'],
  ['late',             'Late allowance'],
  ['overtime',         'Overtime (run + 4 h paid)'],
  ['holiday-off',      'Holiday, not worked (8 h)'],
  ['holiday-worked',   'Holiday premium (run + 8 + 4 h paid)'],
  ['worked-holiday',   'Worked holiday (run + 8 h paid)'],
  ['personal-holiday', 'Personal holiday (paid the run’s hours)'],
  ['paid-off',         'Earned paid off day'],
  ['unpaid-off',       'Earned excused off']
];
const WORKING = new Set(['normal', 'late', 'overtime', 'holiday-worked', 'worked-holiday']);
// Kinds that need a run: the working ones, and a personal holiday (paid the
// run's hours, not worked).
const NEEDS_RUN = new Set([...WORKING, 'personal-holiday']);
const HOLIDAY_KINDS = new Set(['holiday-off', 'holiday-worked', 'worked-holiday']);
// Kinds that can carry minutes held late (paid at time and a half, and real
// time worked). Required on a Late allowance day, optional on the others.
const LATE_OK = new Set(['late', 'overtime', 'holiday-worked', 'worked-holiday']);
const DAY_TYPES = [['weekday', 'Weekday schedule'], ['saturday', 'Saturday schedule'], ['sunday', 'Sunday schedule']];

// ---- shared lookups -------------------------------------------------------

export async function slugForDate(depotKey, iso) {
  // Keyed by the DAY, not the month: picks change mid-month (Summer 2026
  // starts June 14), so a month key handed June 14-30 the Spring paddle
  // whenever June 1-13 was looked up first. The files themselves are
  // fetched once (pa-schedule's fetch cache), so a day key costs nothing.
  const k = 'slug|' + depotKey + '|' + iso.slice(0, 10);
  if (!slugCache.has(k)) {
    // An empty answer is usually a failed download, not a real "no season":
    // don't keep it, so the next lookup tries again.
    const p = S.slugFor(depotKey, iso).then(
      r => { if (!r || !r.slug) slugCache.delete(k); return r; },
      e => { slugCache.delete(k); throw e; });
    slugCache.set(k, p);
  }
  return slugCache.get(k);
}

/** Normalised run for a resolved day. The paddle consulted is the run's own
 *  schedule (`runDayType`) when the run was swapped in from another day. */
export async function runFor(r, iso, depotKey) {
  if (!r || r.off || !r.runNo) return null;
  const depot = r.depotKey || depotKey || (cfg.profile && cfg.profile.depotKey);
  const { slug } = await slugForDate(depot, iso);
  const dt = r.runDayType || r.dayType;
  let run = slug ? await S.getRun(slug, dt, r.runNo, iso) : null;
  // Keep the paddle's start: the Slate report time is paid against it.
  // A night liner starts the evening before its date (a negative minute), so
  // an evening report time typed in for it belongs to that evening too.
  const typed = r.reportMin != null && run && run.reportMin < 0 && r.reportMin >= 720 ? r.reportMin - 1440 : r.reportMin;
  if (run && r.reportMin != null) run = { ...run, paddleStartMin: run.reportMin, reportMin: typed, overridden: true };
  if (!run && r.reportMin != null) {
    run = { runNo: r.runNo, dayType: dt, reportMin: r.reportMin, finishMin: null,
            pullOutMin: r.reportMin, pullInMin: null, payHours: 0, pieces: [], routes: [], blocks: [], synthetic: true };
  }
  // The additional short run rides on the main run: dayHours() adds its
  // hours from run.shortRun, the schedule views show it from there.
  if (run && r.shortRun && r.shortRun.runNo) {
    const sr = slug ? await S.getRun(slug, r.shortRun.runDayType || dt, r.shortRun.runNo, iso).catch(() => null) : null;
    run = { ...run, shortRun: sr };
  }
  return run;
}

/** "RUN 512 · 2.35 h · 6:10 AM – 8:45 AM · 23" for the additional short run. */
export function shortRunText(sr, run) {
  if (!sr) return '';
  const bits = ['RUN ' + sr.runNo];
  if (run) {
    bits.push(run.payHours.toFixed(2) + ' h');
    if (run.reportMin != null && run.finishMin != null) bits.push(S.fmtClock(run.reportMin) + ' – ' + S.fmtClock(run.finishMin));
    if (run.pieces && run.pieces[0]) bits.push(run.pieces.map(p => p.routeLabel).join(' / '));
  }
  return bits.join(' · ');
}

/** Fill `node` with what the paddle knows about a run. Resolves to the run. */
export function lookupLine(node, dayType, runNo, iso, depotKey) {
  node.className = 'lookup'; node.textContent = '';
  if (!runNo) return Promise.resolve(null);
  node.textContent = 'Looking up run ' + runNo + '…';
  const depot = depotKey || (cfg.profile && cfg.profile.depotKey);
  return slugForDate(depot, iso || S.todayIso()).then(({ slug, district }) => {
    if (!slug) { node.textContent = 'No paddle data for your depot this season.'; node.className = 'lookup warn'; return null; }
    return S.getRun(slug, dayType, runNo, iso || S.todayIso()).then(run => {
      if (!run) {
        node.textContent = 'Run ' + runNo + ' is not in the ' + ((district && district.label) || slug) + ' ' + dayType + ' paddle.';
        node.className = 'lookup warn';
        return null;
      }
      node.textContent = run.payHours.toFixed(1) + ' hrs · Start ' + S.fmtClock(run.reportMin) + ' · Finish ' + S.fmtClock(run.finishMin) + ' · ' + run.pieces.map(p => p.routeLabel).join(' / ');
      node.className = 'lookup ok';
      return run;
    });
  }).catch(() => { node.textContent = ''; return null; });
}

// ---- saving and sync, shown honestly ---------------------------------------

/**
 * Await a Firestore write. A write only resolves once the SERVER has it, so
 * if that takes more than a few seconds `onSlow` tells the operator why
 * nothing has happened yet. Firestore keeps retrying while the page is open.
 */
export async function confirmWrite(promise, onSlow, slowMs = 6000) {
  const t = setTimeout(() => { try { onSlow(); } catch (_) {} }, slowMs);
  try { return await promise; } finally { clearTimeout(t); }
}
export const WAITING_FOR_SIGNAL = 'Waiting for signal… keep this page open until it says saved.';

const clock = ms => {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + t;
};

/**
 * One line saying where the schedule on screen came from, with Retry when it
 * isn't live. Deliberately just the line: an operator wants to know whether
 * what they are looking at is current, not to read a diagnostics panel.
 * `st` is pa-assignments getState().
 */
export function renderSync(node, st, onRetry) {
  if (!node || !st) return;
  const s = st.sync || {};
  node.textContent = '';
  if (s.status === 'idle') { node.hidden = true; return; }
  node.hidden = false;

  const line = el('div', 'pa-sync-line');
  const dot = el('span', 'pa-sync-dot');
  const text = el('span', 'pa-sync-text');
  const kind = { live: 'ok', offline: 'warn', saved: 'warn', connecting: 'dim', error: 'err' }[s.status] || 'dim';
  node.className = 'pa-sync pa-root pa-sync-' + kind;
  text.textContent = s.status === 'live' ? 'Synced ' + clock(s.lastServerAt)
    : s.status === 'offline' ? 'No connection · showing what synced at ' + clock(s.lastServerAt)
    : s.status === 'saved' ? 'Connecting… · showing this device’s copy from ' + clock(s.savedAt)
    : s.status === 'error' ? 'Can’t sync (' + s.error + ') · retrying'
    : 'Connecting…';
  line.append(dot, text);
  if (s.status !== 'live' && s.status !== 'connecting' && onRetry) {
    const b = el('button', 'pa-sync-retry', 'Retry'); b.type = 'button';
    b.addEventListener('click', onRetry);
    line.appendChild(b);
  }
  node.appendChild(line);
}

// ---- the sheet ------------------------------------------------------------

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = el('div', 'pa-overlay pa-root');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
  overlay.addEventListener('click', e => { if (e.target === overlay) closeEdit(); });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay && !overlay.hidden) closeEdit(); });
  return overlay;
}

export function closeEdit() {
  if (overlay) overlay.hidden = true;
  if (cfg.onClosed) cfg.onClosed();
}

function showMsg(text, kind) {
  if (!msgEl) return;
  msgEl.className = 'pa-msg ' + (kind === 'ok' ? 'pa-ok' : kind === 'warn' ? 'pa-warn' : 'pa-err');
  msgEl.textContent = text; msgEl.hidden = false;
}

/** Best guess of the kind for a day that predates the dropdown. */
function kindOf(r) {
  if (r.source === 'vacation') return 'vacation';
  if (r.kind && KINDS.some(([v]) => v === r.kind)) return r.kind;
  // Kinds no longer offered (called out, sick, unpaid excused) were all
  // zero-hour days; they open as an unpaid day off.
  if (r.kind) return 'unpaid-off';
  if (r.status === 'holiday') return 'holiday-off';
  if (r.status === 'vacation') return 'paid-off';
  if (r.status === 'off' || r.status === 'sick') return 'unpaid-off';
  if (r.extras && r.extras.some(x => x.kind === 'holiday')) return 'holiday-worked';
  if (r.extras && r.extras.some(x => x.kind === 'late')) return 'late';
  return 'normal';
}

// ---- the small window ------------------------------------------------------

/**
 * A small window over the current one asking ONE thing (a run number, the
 * minutes held late). Resolves to the typed text, or null on Cancel / ×.
 * opts: { title, label, hint, placeholder, value, numeric, maxLength, check }
 * where check(text) returns an error message or ''.
 */
export function askSmall(opts = {}) {
  miniCss();
  return new Promise(resolve => {
    const ov = el('div', 'pa-overlay pa-root pa-mini-ov');
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const card = el('div', 'pa-card pa-mini');
    const head = el('div', 'pa-card-head');
    head.appendChild(el('div', 'pa-card-title', opts.title || ''));
    const x = el('button', 'pa-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    head.appendChild(x);
    const body = el('div', 'pa-card-body');
    const f = el('div', 'pa-field');
    if (opts.label) f.appendChild(el('label', 'pa-label pa-mini-q', opts.label));
    const inp = el('input', 'pa-input pa-mini-in'); inp.type = 'text';
    if (opts.numeric) { inp.inputMode = 'numeric'; inp.pattern = '[0-9]*'; }
    if (opts.maxLength) inp.maxLength = opts.maxLength;
    inp.placeholder = opts.placeholder || '';
    inp.value = opts.value != null ? String(opts.value) : '';
    f.appendChild(inp);
    if (opts.hint) f.appendChild(el('div', 'hint', opts.hint));
    const err = el('div', 'pa-msg pa-err'); err.hidden = true;
    const row = el('div', 'pa-mini-row');
    const cancel = el('button', 'pa-ghost', 'Cancel'); cancel.type = 'button';
    const ok = el('button', 'pa-submit', 'OK'); ok.type = 'button';
    row.append(cancel, ok);
    body.append(f, err, row);
    card.append(head, body); ov.appendChild(card);
    document.body.appendChild(ov);
    const done = v => { ov.remove(); resolve(v); };
    const submit = () => {
      const v = inp.value.trim();
      const e = !v ? 'Enter a value, or tap Cancel.' : (opts.check ? opts.check(v) : '');
      if (e) { err.textContent = e; err.hidden = false; return; }
      done(v);
    };
    x.addEventListener('click', () => done(null));
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', submit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 30);
  });
}
let miniCssDone = false;
function miniCss() {
  if (miniCssDone) return; miniCssDone = true;
  const st = document.createElement('style');
  st.textContent = '.pa-mini-ov{z-index:10050}'
    + '.pa-card.pa-mini{max-width:300px}'
    + '.pa-mini-q{font-size:13px!important;letter-spacing:.02em!important;text-transform:none!important}'
    + '.pa-mini-in{font-size:22px!important;text-align:center;letter-spacing:.06em}'
    + '.pa-mini-row{display:flex;gap:8px;margin-top:14px}'
    + '.pa-mini-row > *{flex:1 1 0;width:auto!important;margin:0!important}'
    + '.pa-late-line{display:flex;align-items:center;justify-content:space-between;gap:10px;font-family:var(--pa-mono);font-size:13px;font-weight:600;padding:10px 12px;border:1px solid var(--pa-line2);border-radius:6px;background:var(--pa-amber-dim);color:var(--pa-bright)}'
    + '@media (max-width:480px){.pa-mini-ov{align-items:center!important;padding:16px!important}.pa-card.pa-mini{border-radius:var(--pa-radius)!important;border:1px solid var(--pa-line2)!important}}';
  document.head.appendChild(st);
}
const LATE_CHECK = v => (/^\d{1,3}$/.test(v) && +v > 0 ? '' : 'Enter the minutes as a number, e.g. 8.');
const RUN_CHECK = v => (/^[0-9A-Za-z]{1,4}$/.test(v) ? '' : 'Enter the run number, e.g. 209.');
function askLate(cur) {
  return askSmall({ title: 'Late allowance', label: 'How many minutes were you held late?', placeholder: 'e.g. 8', numeric: true, maxLength: 3,
    value: cur || '', hint: 'Paid at time and a half: 8 minutes adds 0.20 h pay and 0.13 h work.', check: LATE_CHECK });
}
function askRun(r, cur) {
  return askSmall({ title: 'Add a run', label: 'Which run number for ' + S.fmtDate(r.date) + '?', placeholder: 'e.g. 209', numeric: true, maxLength: 4,
    value: cur || '', hint: 'The hours come from the paddle.', check: RUN_CHECK });
}

const hoursStr = min => (min == null ? '' : (Math.round(min) / 60).toFixed(2).replace(/\.?0+$/, ''));
const parseHours = v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : null; };

/**
 * The fields of one day: kind, run, hours, late allowance, report time,
 * notes and the pay line. Used by the Edit this day window (openEdit) and,
 * one day at a time, by Edit this week (assets/pa-sched-edit.js).
 *
 * @param r  a resolved day from pa-assignments (resolve / resolveRange)
 * @returns { node, result(), isDirty() }. result() is { error } when the
 *   answers are not complete, { noop: true } when there is nothing to write,
 *   { remove: true } to drop the explicit day, else { data } for saveAssignment.
 */
export function dayForm(r, opts = {}) {
  miniCss();
  const depotKey = opts.depotKey || (cfg.profile && cfg.profile.depotKey);
  const body = el('div', 'pa-dayform');
  let dirty = false;
  body.addEventListener('input', () => { dirty = true; });
  body.addEventListener('change', () => { dirty = true; });
  let lkEl = null, iHEl = null, repHintEl = null;

  const st = {
    kind: kindOf(r),
    runNo: r.runNo || (r.assignment && r.assignment.paidRun && r.assignment.paidRun.runNo) || r.patternRunNo || '',
    runDayType: r.runDayType || (r.assignment && r.assignment.paidRun && r.assignment.paidRun.runDayType) || r.dayType,
    run: null,                                  // paddle run for runNo/runDayType
    hoursMin: r.payMin != null ? r.payMin : null,   // typed hours (override / paid-off)
    lateMin: (r.extras || []).filter(x => x.kind === 'late').reduce((s, x) => s + Math.abs(x.min), 0) || null,
    reportMin: r.reportMin != null ? r.reportMin : null,
    note: r.note || '',
    // The additional short run (districts with allowsShortRuns).
    shortRun: r.shortRun && r.shortRun.runNo ? { runNo: r.shortRun.runNo, runDayType: r.shortRun.runDayType || null } : null,
    shortObj: null,                             // its paddle run
    rules: null                                 // this district's short-run rules, once loaded
  };
  let shortEl = null, shortToken = 0;
  SR.rulesFor(depotKey).then(x => { st.rules = x; drawShort(); }).catch(() => {});
  if ((st.kind === 'paid-off' || st.kind === 'personal-holiday') && st.hoursMin == null) {
    const other = (r.extras || []).find(x => x.kind === 'other');
    st.hoursMin = other ? other.min : null;
  }

  if (r.vacationWeek) {
    body.appendChild(el('div', 'hint', 'In your vacation week of ' + S.fmtDate(r.vacationWeek)
      + ' — 44 hours for the week, whatever this day says. Change this day only if you worked it. '
      + 'The week itself is under Edit → Vacation edit on My run → Schedule.'));
  } else if (r.source === 'pattern' && r.runNo) body.appendChild(el('div', 'hint', 'From your pattern. Changes here affect this day only.'));
  else if (r.unregistered) body.appendChild(el('div', 'hint', 'Nothing registered for this day.'));

  // ---- kind
  // A day inside a vacation week can say so; that is the absence of an
  // explicit day rather than a kind of its own, so saving it clears the day.
  const kinds = r.vacationWeek ? [['vacation', 'On vacation'], ...KINDS] : KINDS;
  const fK = el('div', 'pa-field'); fK.appendChild(el('label', 'pa-label', 'This day'));
  const sK = el('select', 'pa-select');
  kinds.forEach(([v, l]) => { const oo = el('option', null, l); oo.value = v; if (v === st.kind) oo.selected = true; sK.appendChild(oo); });
  sK.addEventListener('change', async () => {
    const was = st.kind, want = sK.value;
    // A working day needs a run, and a late allowance its minutes: ask for
    // each in a small window. Cancel leaves the day as it was.
    if (NEEDS_RUN.has(want) && !st.runNo) {
      const v = await askRun(r, '');
      if (v == null) { sK.value = was; return; }
      st.runNo = v;
    }
    if (want === 'late') {
      const v = await askLate(st.lateMin);
      if (v == null) { sK.value = was; return; }
      st.lateMin = parseInt(v, 10);
    }
    dirty = true;
    st.kind = want;
    // Worked hours and paid-day-off hours mean different things; don't carry
    // one into the other when switching between a working and a day-off kind.
    if (WORKING.has(was) !== WORKING.has(st.kind) || was === 'personal-holiday' || st.kind === 'personal-holiday') st.hoursMin = null;
    if (st.kind === 'paid-off' && st.hoursMin == null) st.hoursMin = 480;
    drawFields(); drawPay();
  });
  fK.appendChild(sK); body.appendChild(fK);

  // ---- kind-specific fields
  const fields = el('div'); body.appendChild(fields);
  let lookupTimer;
  function drawFields() {
    fields.textContent = '';
    lkEl = iHEl = repHintEl = shortEl = null;
    const working = WORKING.has(st.kind);

    if (st.kind === 'vacation') {
      fields.appendChild(el('div', 'hint', 'Left as a vacation day. The week pays 44 hours.'));
      return;
    }

    if (working || st.kind === 'personal-holiday') {
      const row = el('div', 'form-row');
      const fRun = el('div', 'pa-field'); fRun.appendChild(el('label', 'pa-label', 'Run #'));
      const iRun = el('input', 'pa-input'); iRun.type = 'text'; iRun.inputMode = 'numeric'; iRun.maxLength = 4; iRun.value = st.runNo;
      iRun.addEventListener('input', () => { st.runNo = iRun.value.trim(); clearTimeout(lookupTimer); lookupTimer = setTimeout(doLookup, 350); });
      fRun.appendChild(iRun); row.appendChild(fRun);

      // Which schedule the run belongs to. A Sunday run worked on a Monday
      // must be looked up in the Sunday paddle, not Monday's.
      const fDt = el('div', 'pa-field'); fDt.appendChild(el('label', 'pa-label', 'Run is from'));
      const sDt = el('select', 'pa-select');
      DAY_TYPES.forEach(([v, l]) => { const oo = el('option', null, l + (v === r.dayType ? ' (this day)' : '')); oo.value = v; if (v === st.runDayType) oo.selected = true; sDt.appendChild(oo); });
      sDt.addEventListener('change', () => { st.runDayType = sDt.value; doLookup(); });
      fDt.appendChild(sDt); row.appendChild(fDt);
      fields.appendChild(row);

      const lk = el('div', 'lookup'); lkEl = lk; fields.appendChild(lk);

      const fH = el('div', 'pa-field'); fH.style.marginTop = '10px';
      fH.appendChild(el('label', 'pa-label', working ? 'Paid hours for the run' : 'Personal holiday pay (hours)'));
      const iH = el('input', 'pa-input'); iH.type = 'number'; iH.step = '0.05'; iH.min = '0'; iH.inputMode = 'decimal'; iHEl = iH;
      iH.placeholder = 'from the paddle';
      if (st.hoursMin != null) iH.value = hoursStr(st.hoursMin);
      iH.addEventListener('input', () => { st.hoursMin = parseHours(iH.value); drawPay(); });
      fH.appendChild(iH);
      fH.appendChild(el('div', 'hint', working
        ? 'Pre-filled with the run’s pay from the paddle. Change it only if you were paid a different amount (e.g. you left early).'
        : 'Not worked. You are paid the run’s regular hours, pre-filled from the paddle.'));
      fields.appendChild(fH);
      if (!working) {
        if (st.runNo) doLookup();
        return;
      }

      shortEl = el('div', 'pa-field pa-short'); shortEl.style.display = 'none';
      fields.appendChild(shortEl);

      if (LATE_OK.has(st.kind)) {
        const fL = el('div', 'pa-field'); fL.appendChild(el('label', 'pa-label', st.kind === 'late' ? 'Late allowance' : 'Held late (optional)'));
        const line = el('div', 'pa-late-line');
        const txt = el('span', null, st.lateMin ? st.lateMin + ' min late · +' + (st.lateMin * A.LATE_ALLOWANCE_RATE / 60).toFixed(2) + ' h paid' : st.kind === 'late' ? 'No minutes yet' : 'Not held late');
        const ch = el('button', 'rowbtn', st.lateMin ? 'CHANGE' : 'ADD'); ch.type = 'button';
        ch.addEventListener('click', async () => {
          const v = await askLate(st.lateMin);
          if (v == null) return;
          st.lateMin = parseInt(v, 10); dirty = true;
          drawFields(); drawPay();
        });
        line.append(txt, ch);
        if (st.kind !== 'late' && st.lateMin) {
          const rm = el('button', 'rowbtn', 'REMOVE'); rm.type = 'button';
          rm.addEventListener('click', () => { st.lateMin = null; dirty = true; drawFields(); drawPay(); });
          line.appendChild(rm);
        }
        fL.appendChild(line);
        fields.appendChild(fL);
      }

      const fRep = el('div', 'pa-field'); fRep.appendChild(el('label', 'pa-label', 'Report time (Slate)'));
      const iRep = el('input', 'pa-input'); iRep.type = 'time';
      if (st.reportMin != null) iRep.value = S.pad2(Math.floor((st.reportMin % 1440) / 60)) + ':' + S.pad2(st.reportMin % 60);
      iRep.addEventListener('input', () => { const m = iRep.value.match(/^(\d{2}):(\d{2})$/); st.reportMin = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; drawPay(); });
      fRep.appendChild(iRep);
      const repHint = el('div', 'hint'); repHintEl = repHint;
      fRep.appendChild(repHint);
      fields.appendChild(fRep);

      if (st.runNo) doLookup();
    } else if (st.kind === 'paid-off') {
      const fH = el('div', 'pa-field'); fH.appendChild(el('label', 'pa-label', 'Paid hours'));
      const iH = el('input', 'pa-input'); iH.type = 'number'; iH.step = '0.05'; iH.min = '0'; iH.inputMode = 'decimal';
      iH.value = hoursStr(st.hoursMin != null ? st.hoursMin : 480);
      iH.addEventListener('input', () => { st.hoursMin = parseHours(iH.value); drawPay(); });
      fH.appendChild(iH); fH.appendChild(el('div', 'hint', 'No run this day. Enter whatever is paid.'));
      fields.appendChild(fH);
    } else if (st.kind === 'holiday-off') {
      fields.appendChild(el('div', 'hint', 'No run this day. 8 hours holiday pay is added automatically.'));
    } else {
      fields.appendChild(el('div', 'hint', 'No run and no hours this day.'));
    }
  }

  async function doLookup() {
    const lk = lkEl;
    if (!lk) return;
    st.run = await lookupLine(lk, st.runDayType, st.runNo, r.date, depotKey);
    const iH = iHEl;
    if (iH && st.run && st.hoursMin == null) iH.value = hoursStr(Math.round(st.run.payHours * 60));
    if (iH && !st.run) iH.placeholder = 'run not in paddle - enter hours';
    drawPay();
    drawShort();
  }

  // ---- the additional short run
  // Shown only where the district allows short runs, and only once the day
  // has a REGULAR run from the paddle: the picker then offers short runs and
  // nothing else. A short run already on the day stays visible in every case
  // so the operator sees why a save is refused.
  async function drawShort() {
    const box = shortEl, rules = st.rules;
    if (!box) return;
    const my = ++shortToken;
    box.textContent = ''; box.style.display = 'none';
    if (!rules) return;
    const max = rules.shortRunMaxPayHours;
    const head = () => { box.style.display = ''; box.appendChild(el('label', 'pa-label', 'Additional short run (under ' + hoursStr(max * 60) + ' h)')); };
    if (!rules.allowsShortRuns) {
      if (st.shortRun) {
        head();
        box.appendChild(el('div', 'lookup warn', 'Run ' + st.shortRun.runNo + ' was saved as a short run, but your district allows one run per day. Remove it to save this day.'));
        addRemove(box);
      }
      return;
    }
    const regular = st.run && st.run.payHours > 0 && !A.isShortPay(st.run.payHours, rules);
    if (!regular) {
      // Nothing to say about a run the paddle doesn't know, unless a short
      // run is already on the day.
      if (!st.runNo || (!st.run && !st.shortRun)) return;
      head();
      box.appendChild(el('div', 'hint', !st.run
        ? 'A short run can be added only next to a regular run from the paddle.'
        : 'Run ' + st.runNo + ' is itself a short run (' + st.run.payHours.toFixed(2) + ' h). A short run can’t be the only run of the day, and two short runs are not allowed.'));
      if (st.shortRun) { box.appendChild(el('div', 'lookup warn', 'Short run ' + st.shortRun.runNo + ' can’t stay on this day.')); addRemove(box); }
      return;
    }
    head();
    // Short runs go on their own kind of day: this day's schedule decides.
    const dt = r.dayType, Dt = dt === 'weekday' ? 'weekday' : S.dayLabel(dt);
    const sel = el('select', 'pa-select');
    const none = el('option', null, 'None'); none.value = ''; sel.appendChild(none);
    sel.disabled = true;
    box.appendChild(sel);
    const info = el('div', 'lookup'); box.appendChild(info);
    info.textContent = 'Looking up short runs…';
    let list = [];
    try { list = await SR.shortRunOptions(depotKey, dt, r.date, st.runNo, [st.run]); } catch (_) {}
    if (my !== shortToken) return;
    // A paddle with no short runs at all: nothing to offer, say nothing.
    if (!list.length && !list.overlapping && !st.shortRun) { box.textContent = ''; box.style.display = 'none'; return; }
    for (const run of list) {
      const o = el('option', null, shortRunText({ runNo: run.runNo }, run).replace(/^RUN /, 'Run '));
      o.value = run.runNo;
      sel.appendChild(o);
    }
    // A short run saved earlier that the list no longer offers (other
    // schedule, paddle changed) stays selectable so it is not lost silently.
    if (st.shortRun && !list.some(x => x.runNo === String(st.shortRun.runNo))) {
      const o = el('option', null, 'Run ' + st.shortRun.runNo + ' (can’t go with run ' + st.runNo + ')'); o.value = st.shortRun.runNo; sel.appendChild(o);
    }
    sel.value = st.shortRun ? String(st.shortRun.runNo) : '';
    sel.disabled = false;
    const show = () => {
      st.shortObj = st.shortRun ? (list.find(x => x.runNo === String(st.shortRun.runNo)) || null) : null;
      info.className = 'lookup' + (st.shortRun && !st.shortObj ? ' warn' : st.shortObj ? ' ok' : '');
      info.textContent = st.shortObj ? 'Added on top of run ' + st.runNo + ': ' + shortRunText(st.shortRun, st.shortObj).replace(/^RUN \S+ · /, '')
        : st.shortRun ? 'Run ' + st.shortRun.runNo + ' can’t go with run ' + st.runNo + ': it is not a short run in the ' + Dt + ' paddle, or its times overlap your run. Choose another or None.'
        : (list.length ? 'Only ' + Dt + ' short runs outside your run’s times are listed. One per day, on top of your regular run.'
                       : 'No ' + Dt + ' short run fits outside your run’s times.')
          + (list.overlapping ? ' (' + list.overlapping + ' hidden: ' + (list.overlapping === 1 ? 'it overlaps' : 'they overlap') + ' run ' + st.runNo + '.)' : '');
      drawPay();
    };
    sel.addEventListener('change', () => {
      dirty = true;
      st.shortRun = sel.value ? { runNo: sel.value, runDayType: dt } : null;
      show();
    });
    show();
  }
  function addRemove(box) {
    const b = el('button', 'rowbtn', 'REMOVE SHORT RUN'); b.type = 'button';
    b.addEventListener('click', () => { st.shortRun = null; st.shortObj = null; dirty = true; drawShort(); drawPay(); });
    box.appendChild(b);
  }

  // ---- notes (every kind)
  const fN = el('div', 'pa-field'); fN.appendChild(el('label', 'pa-label', 'Notes'));
  const iN = el('input', 'pa-input'); iN.type = 'text'; iN.maxLength = 140; iN.value = st.note; iN.placeholder = 'e.g. Martin Luther King Day';
  iN.addEventListener('input', () => { st.note = iN.value; });
  fN.appendChild(iN); body.appendChild(fN);

  // ---- pay line
  const pay = el('div', 'pay'); body.appendChild(pay);
  function build() {
    const working = WORKING.has(st.kind);
    const personal = st.kind === 'personal-holiday';
    const runMin = st.run ? Math.round(st.run.payHours * 60) : 0;
    const workedMin = working ? (st.hoursMin != null ? st.hoursMin : runMin) : 0;
    const extras = [];
    // Late allowance is stored as the minutes held late; the 1.5x is applied
    // when hours are read (A.extraPayMin), so the rule lives in one place.
    if (LATE_OK.has(st.kind) && st.lateMin) extras.push({ kind: 'late', min: st.lateMin, note: '' });
    if (st.kind === 'holiday-off') extras.push({ kind: 'holiday', min: A.HOLIDAY_PAY_MIN, note: '' });
    if (st.kind === 'holiday-worked') extras.push({ kind: 'holiday', min: A.HOLIDAY_WORKED_PAY_MIN, note: '' });
    if (st.kind === 'worked-holiday') extras.push({ kind: 'holiday', min: A.WORKED_HOLIDAY_PAY_MIN, note: '' });
    if (st.kind === 'overtime') extras.push({ kind: 'ot', min: A.OVERTIME_PAY_MIN, note: 'paid' });
    // A personal holiday pays the run's regular hours, not worked.
    const personalMin = personal ? (st.hoursMin != null ? st.hoursMin : runMin) : 0;
    if (personal && personalMin) extras.push({ kind: 'other', min: personalMin, note: 'personal holiday' });
    if (st.kind === 'paid-off') extras.push({ kind: 'other', min: st.hoursMin != null ? st.hoursMin : 480, note: 'paid day off' });
    // Slate report time against the run's scheduled start (the paddle's).
    const earlyMin = working ? A.earlyReportMin(st.reportMin, st.run ? st.run.reportMin : null) : 0;
    const status = working ? 'scheduled'
      : st.kind === 'holiday-off' ? 'holiday'
      : st.kind === 'paid-off' ? 'vacation' : 'off';
    // The additional short run's paddle pay, on top of the regular run's.
    const shortMin = working && st.shortRun && st.shortObj ? Math.round(st.shortObj.payHours * 60) : 0;
    return { working, personal, personalMin, runMin, workedMin, shortMin, extras, earlyMin, status };
  }
  function drawReportHint(b) {
    const h = repHintEl;
    if (!h) return;
    if (st.reportMin == null) { h.textContent = 'If dispatch had you report before the run’s start, enter the time. The difference is added to the day.'; return; }
    if (!st.run) { h.textContent = 'Run start unknown (not in the paddle), so nothing is added.'; return; }
    h.textContent = 'Run starts ' + S.fmtClock(st.run.reportMin) + ' · reporting ' + S.fmtClock(st.reportMin)
      + (b.earlyMin ? ' adds ' + (b.earlyMin / 60).toFixed(2) + ' h.' : ' adds nothing (not before the start).');
  }
  /** Real time worked: the run's finish minus its start (earlier when
   *  reporting early), paid-hours changes and the minutes held late. */
  function workLine(b) {
    if (!b.working) return 'Worked <b>0.00 h</b>';
    const run = st.run;
    if (!run || run.reportMin == null || run.finishMin == null || !(run.finishMin > run.reportMin)) {
      return 'Worked <b>' + (b.workedMin / 60).toFixed(2) + ' h</b> (run times not in the paddle)';
    }
    const start = run.reportMin - (b.earlyMin || 0);
    let min = run.finishMin - start;
    const bits = [S.fmtClock(start) + ' – ' + S.fmtClock(run.finishMin)];
    if (st.hoursMin != null && st.hoursMin !== b.runMin) { const d = st.hoursMin - b.runMin; min += d; bits.push((d < 0 ? '− ' : '+ ') + (Math.abs(d) / 60).toFixed(2) + ' changed'); }
    if (LATE_OK.has(st.kind) && st.lateMin) { min += st.lateMin; bits.push('+ ' + st.lateMin + ' min late'); }
    if (bits.length > 1) bits[0] += ' (' + ((run.finishMin - start) / 60).toFixed(2) + ')';
    const so = b.shortMin ? st.shortObj : null;
    if (so && so.reportMin != null && so.finishMin > so.reportMin) {
      min += so.finishMin - so.reportMin;
      bits.push('+ short run ' + S.fmtClock(so.reportMin) + ' – ' + S.fmtClock(so.finishMin) + ' (' + ((so.finishMin - so.reportMin) / 60).toFixed(2) + ')');
    }
    return 'Worked ' + esc(bits.join(' ')) + ' = <b>' + (Math.max(0, min) / 60).toFixed(2) + ' h</b>';
  }
  function drawPay() {
    if (st.kind === 'vacation') {
      pay.innerHTML = 'Worked <b>0.00 h</b><br>Paid <b>' + (A.VACATION_WEEK_PAY_MIN / 60).toFixed(2) + ' h</b> for the vacation week, not per day';
      return;
    }
    const b = build();
    drawReportHint(b);
    const parts = [];
    if (b.working) parts.push(['Run', b.workedMin]);
    if (b.shortMin) parts.push(['Short run ' + st.shortRun.runNo, b.shortMin]);
    const exLabel = x => x.kind === 'holiday' ? (A.KIND_LABELS[st.kind] || 'Holiday') + (st.kind === 'holiday-worked' ? ' (8 + 4)' : '')
      : x.kind === 'other' && A.KIND_LABELS[st.kind] && !WORKING.has(st.kind) ? A.KIND_LABELS[st.kind]
      : x.kind === 'other' && x.note ? x.note.charAt(0).toUpperCase() + x.note.slice(1)
      : A.EXTRA_KINDS[x.kind] || 'Extra';
    b.extras.forEach(x => parts.push([exLabel(x), A.extraPayMin(x)]));
    if (b.earlyMin) parts.push(['Early report', b.earlyMin]);
    const total = parts.reduce((s, p) => s + p[1], 0);
    pay.innerHTML = workLine(b) + '<br>Paid ' + (parts.length
      ? parts.map(([k, v]) => esc(k) + ' ' + (v / 60).toFixed(2)).join(' + ') + ' = <b>' + (total / 60).toFixed(2) + ' h</b>'
      : '<b>0.00 h</b>');
  }

  // ---- the answer
  function result() {
    // "On vacation" is the day having nothing of its own: clear any explicit
    // day so the vacation week shows through again.
    if (st.kind === 'vacation') return r.source === 'assignment' ? { remove: true } : { noop: true };
    const b = build();
    if (b.working && !st.runNo) return { error: 'Enter the run number, or choose a day-off kind.' };
    if (st.kind === 'late' && !st.lateMin) return { error: 'Enter the minutes you were held late (Late allowance → ADD).' };
    if (b.working && !st.run && st.hoursMin == null) return { error: 'That run is not in the paddle. Enter the hours.' };
    if (b.personal && !st.runNo) return { error: 'Enter the run number for the personal holiday.' };
    if (b.personal && !b.personalMin) return { error: st.run || st.hoursMin != null ? 'Enter the hours paid for the personal holiday.' : 'Run ' + st.runNo + ' is not in the paddle (or still loading). Enter the hours.' };
    // The day's runs must be an allowed combination (checked again, from
    // the paddle, by A.saveAssignment / A.saveDays before anything is written).
    const shortRun = b.working && st.shortRun ? { runNo: String(st.shortRun.runNo), runDayType: st.shortRun.runDayType || r.dayType } : null;
    // A short run whose paddle run is not in hand yet is left to that check.
    if (b.working && st.rules && st.rules.loaded && (shortRun ? !!st.shortObj : !!st.run)) {
      const msg = A.checkDayRuns({
        runNo: st.runNo, payHours: st.run ? st.run.payHours : null, run: st.run, dayType: r.dayType,
        shortRun: shortRun ? { runNo: shortRun.runNo, payHours: st.shortObj ? st.shortObj.payHours : null, run: st.shortObj, runDayType: shortRun.runDayType } : null
      }, st.rules);
      if (msg) return { error: msg };
    }
    return { data: {
      kind: st.kind,
      runNo: b.working ? st.runNo : null,
      runDayType: b.working ? st.runDayType : null,
      shortRun,
      // The run a personal holiday is paid for (not worked, so not runNo).
      paidRun: b.personal ? { runNo: String(st.runNo), runDayType: st.runDayType || r.dayType } : null,
      depotKey: depotKey || null, dayType: r.dayType,
      status: b.status,
      extras: b.extras,
      payMin: b.working && st.hoursMin != null && (!st.run || st.hoursMin !== b.runMin) ? st.hoursMin : null,
      reportMin: b.working ? st.reportMin : null,
      flags: { holiday: HOLIDAY_KINDS.has(st.kind), late: LATE_OK.has(st.kind) && !!st.lateMin, overtime: st.kind === 'overtime', callIn: false },
      note: st.note, source: 'edit'
    } };
  }

  drawFields(); drawPay();
  return { node: body, result, isDirty: () => dirty };
}

/**
 * The Edit this day window.
 * @param r  a resolved day from pa-assignments (resolve / resolveRange)
 */
export function openEdit(r) {
  const o = ensureOverlay();
  o.textContent = ''; o.hidden = false;

  const card = el('div', 'pa-card');
  const head = el('div', 'pa-card-head');
  head.appendChild(el('div', 'pa-card-title', S.fmtDate(r.date) + (r.holidayDate ? ' · holiday' : '')));
  const x = el('button', 'pa-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', closeEdit); head.appendChild(x);
  const body = el('div', 'pa-card-body');
  msgEl = el('div', 'pa-msg'); msgEl.hidden = true; body.appendChild(msgEl);
  if (cfg.dayNotes) cfg.dayNotes(r).forEach(n => body.appendChild(n));
  const form = dayForm(r);
  body.appendChild(form.node);

  // ---- actions
  const stack = el('div', 'pa-stack');
  const save = el('button', 'pa-submit', 'Save day'); save.type = 'button';
  save.addEventListener('click', async () => {
    const res = form.result();
    if (res.error) { showMsg(res.error, 'err'); return; }
    if (res.noop) { closeEdit(); return; }
    save.disabled = true; msgEl.hidden = true;
    try {
      if (res.remove) await confirmWrite(A.clearAssignment(r.date), () => showMsg(WAITING_FOR_SIGNAL, 'warn'));
      else await confirmWrite(A.saveAssignment(r.date, res.data), () => showMsg(WAITING_FOR_SIGNAL, 'warn'));
      closeEdit();
      if (cfg.onSaved) cfg.onSaved(r.date);
    } catch (err) {
      showMsg(err.code === 'permission-denied' ? 'That change was rejected by the security rules.' : ('Could not save: ' + (err.code || err.message)), 'err');
      save.disabled = false;
    }
  });
  stack.appendChild(save);
  if (r.source === 'assignment') {
    const hasPattern = !!A.activePattern(A.getState().patterns, r.date);
    const rev = el('button', 'pa-ghost', hasPattern ? 'Revert to my pattern' : 'Remove this day'); rev.type = 'button';
    rev.addEventListener('click', async () => {
      rev.disabled = true;
      try { await confirmWrite(A.clearAssignment(r.date), () => showMsg(WAITING_FOR_SIGNAL, 'warn')); closeEdit(); if (cfg.onSaved) cfg.onSaved(r.date); }
      catch (err) { showMsg(err.message, 'err'); rev.disabled = false; }
    });
    stack.appendChild(rev);
  }
  const cancel = el('button', 'pa-ghost', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', closeEdit);
  stack.appendChild(cancel);
  body.appendChild(stack);

  card.append(head, body); o.appendChild(card);
}

/**
 * One of the pick's short runs, for the screens where an operator enters a
 * whole pick (Bulk edit, first-time setup). A short run goes only on its own
 * kind of day: `dayType` 'weekday' (every Monday-Friday of the pick),
 * 'saturday' or 'sunday'. Shown only where the district allows short runs
 * AND that day's paddle has some; it offers that paddle's SHORT runs that
 * don't overlap the regular run(s).
 *   opts = { depotKey, dayType, iso (a date in the pick), value (run # or ''),
 *            exclude: () => [that day's regular run #s], onChange(runNo) }
 * Call refresh() when those runs change. Returns { node, refresh() }.
 */
export function shortRunChooser(opts) {
  const node = el('div', 'pa-field pa-short-pick');
  node.style.display = 'none';
  const dt = opts.dayType || 'weekday';
  const Day = dt === 'weekday' ? 'weekday' : S.dayLabel(dt);           // "weekday" / "Saturday" / "Sunday"
  const every = dt === 'weekday' ? 'every weekday' : 'every ' + Day;
  let value = opts.value ? String(opts.value) : '';
  let token = 0;
  async function refresh() {
    const my = ++token;
    let rules = null, list = [];
    try { rules = await SR.rulesFor(opts.depotKey); } catch (_) {}
    if (my !== token) return;
    node.textContent = '';
    if (!rules || !rules.allowsShortRuns) {
      if (value) {
        node.style.display = '';
        node.appendChild(el('div', 'lookup warn', 'Short run ' + value + ' is saved with your ' + Day + ' run, but your district allows one run per day. It will be removed when you save.'));
        value = ''; opts.onChange && opts.onChange('');
      } else node.style.display = 'none';
      return;
    }
    const ex = [...new Set((opts.exclude ? opts.exclude() : []).map(String).filter(Boolean))];
    const iso = opts.iso || S.todayIso();
    let overlapping = 0;
    try {
      const regs = await Promise.all(ex.map(n => SR.paddleRun(opts.depotKey, dt, n, iso).catch(() => null)));
      list = await SR.shortRunOptions(opts.depotKey, dt, iso, null, regs);
      overlapping = list.overlapping || 0;
    } catch (_) {}
    if (my !== token) return;
    list = list.filter(r => !ex.includes(r.runNo));
    // This day's paddle has no short runs at all: nothing to offer.
    if (!list.length && !overlapping && !value) { node.textContent = ''; node.style.display = 'none'; return; }
    node.style.display = '';
    const max = hoursStr(rules.shortRunMaxPayHours * 60);
    node.appendChild(el('label', 'pa-label', 'Short run with your ' + Day + ' run' + (dt === 'weekday' ? 's' : '')));
    node.appendChild(el('div', 'hint', 'Your depot has ' + Day + ' short runs (under ' + max + ' h). If your pick has one, choose it here: it is added to ' + every + ', on top of your regular run.'));
    const sel = el('select', 'pa-select');
    const none = el('option', null, 'No short run'); none.value = ''; sel.appendChild(none);
    for (const run of list) {
      const o = el('option', null, shortRunText({ runNo: run.runNo }, run).replace(/^RUN /, 'Run '));
      o.value = run.runNo; sel.appendChild(o);
    }
    if (value && !list.some(r => r.runNo === value)) {
      const o = el('option', null, 'Run ' + value + ' (can’t go with your ' + Day + ' run)'); o.value = value; sel.appendChild(o);
    }
    sel.value = value;
    const info = el('div', 'lookup');
    node.append(sel, info);
    const hidden = overlapping ? ' ' + overlapping + ' more ' + (overlapping === 1 ? 'overlaps' : 'overlap') + ' your ' + Day + ' run' + (ex.length > 1 ? 's' : '') + (overlapping === 1 ? ' and is not listed.' : ' and are not listed.') : '';
    const show = () => {
      const run = list.find(r => r.runNo === value);
      info.className = 'lookup' + (value && !run ? ' warn' : run ? ' ok' : '');
      info.textContent = run ? S.dayLabel(every) + ': your regular run + short run ' + shortRunText({ runNo: value }, run).replace(/^RUN /, '')
        : value ? 'Run ' + value + ' can’t go with your ' + Day + ' run: it is not a ' + Day + ' short run, or its times overlap it. Choose another or No short run.'
        : (list.length ? list.length + ' ' + Day + ' short run' + (list.length === 1 ? ' fits' : 's fit') + ' outside your run times. Leave it at No short run if your pick has none.'
                       : 'No ' + Day + ' short run fits outside your run times.') + hidden;
    };
    sel.addEventListener('change', () => { value = sel.value; show(); opts.onChange && opts.onChange(value); });
    show();
  }
  refresh();
  return { node, refresh };
}
