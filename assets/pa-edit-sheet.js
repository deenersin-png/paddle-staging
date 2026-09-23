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

const cfg = { profile: null, onSaved: null, onClosed: null };
let overlay = null, msgEl = null;
const slugCache = new Map();

export function configure(c) { Object.assign(cfg, c); }

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const KINDS = [
  ['normal',         'Normal hours worked'],
  ['late',           'Late allowance'],
  ['holiday-off',    'Holiday, not worked (8 h)'],
  ['holiday-worked', 'Holiday, worked (12 h + hours worked)'],
  ['paid-off',       'Paid day off'],
  ['unpaid-off',     'Unpaid day off']
];
const WORKING = new Set(['normal', 'late', 'holiday-worked']);
const DAY_TYPES = [['weekday', 'Weekday schedule'], ['saturday', 'Saturday schedule'], ['sunday', 'Sunday schedule']];

// ---- shared lookups -------------------------------------------------------

export async function slugForDate(depotKey, iso) {
  const k = 'slug|' + depotKey + '|' + iso.slice(0, 7);
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
  let run = slug ? await S.getRun(slug, dt, r.runNo) : null;
  // Keep the paddle's start: the Slate report time is paid against it.
  if (run && r.reportMin != null) run = { ...run, paddleStartMin: run.reportMin, reportMin: r.reportMin, overridden: true };
  if (!run && r.reportMin != null) {
    run = { runNo: r.runNo, dayType: dt, reportMin: r.reportMin, finishMin: null,
            pullOutMin: r.reportMin, pullInMin: null, payHours: 0, pieces: [], routes: [], blocks: [], synthetic: true };
  }
  return run;
}

/** Fill `node` with what the paddle knows about a run. Resolves to the run. */
export function lookupLine(node, dayType, runNo, iso, depotKey) {
  node.className = 'lookup'; node.textContent = '';
  if (!runNo) return Promise.resolve(null);
  node.textContent = 'Looking up run ' + runNo + '…';
  const depot = depotKey || (cfg.profile && cfg.profile.depotKey);
  return slugForDate(depot, iso || S.todayIso()).then(({ slug, district }) => {
    if (!slug) { node.textContent = 'No paddle data for your depot this season.'; node.className = 'lookup warn'; return null; }
    return S.getRun(slug, dayType, runNo).then(run => {
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

const hoursStr = min => (min == null ? '' : (Math.round(min) / 60).toFixed(2).replace(/\.?0+$/, ''));
const parseHours = v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : null; };

/**
 * @param r  a resolved day from pa-assignments (resolve / resolveRange)
 */
export function openEdit(r) {
  const o = ensureOverlay();
  o.textContent = ''; o.hidden = false;
  const depotKey = cfg.profile && cfg.profile.depotKey;

  const card = el('div', 'pa-card');
  const head = el('div', 'pa-card-head');
  head.appendChild(el('div', 'pa-card-title', S.fmtDate(r.date) + (r.holidayDate ? ' · holiday' : '')));
  const x = el('button', 'pa-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', closeEdit); head.appendChild(x);
  const body = el('div', 'pa-card-body');
  msgEl = el('div', 'pa-msg'); msgEl.hidden = true; body.appendChild(msgEl);

  const st = {
    kind: kindOf(r),
    runNo: r.runNo || r.patternRunNo || '',
    runDayType: r.runDayType || r.dayType,
    run: null,                                  // paddle run for runNo/runDayType
    hoursMin: r.payMin != null ? r.payMin : null,   // typed hours (override / paid-off)
    lateMin: (r.extras || []).filter(x => x.kind === 'late').reduce((s, x) => s + Math.abs(x.min), 0) || null,
    reportMin: r.reportMin != null ? r.reportMin : null,
    note: r.note || ''
  };
  if (st.kind === 'paid-off' && st.hoursMin == null) {
    const other = (r.extras || []).find(x => x.kind === 'other');
    st.hoursMin = other ? other.min : null;
  }

  if (r.vacationWeek) {
    body.appendChild(el('div', 'hint', 'In your vacation week of ' + S.fmtDate(r.vacationWeek)
      + ' — 44 hours for the week, whatever this day says. Change this day only if you worked it. '
      + 'The week itself is on My run → Schedule.'));
  } else if (r.source === 'pattern' && r.runNo) body.appendChild(el('div', 'hint', 'From your pattern. Changes here affect this day only.'));
  else if (r.unregistered) body.appendChild(el('div', 'hint', 'Nothing registered for this day.'));

  // ---- kind
  // A day inside a vacation week can say so; that is the absence of an
  // explicit day rather than a kind of its own, so saving it clears the day.
  const kinds = r.vacationWeek ? [['vacation', 'On vacation'], ...KINDS] : KINDS;
  const fK = el('div', 'pa-field'); fK.appendChild(el('label', 'pa-label', 'This day'));
  const sK = el('select', 'pa-select');
  kinds.forEach(([v, l]) => { const oo = el('option', null, l); oo.value = v; if (v === st.kind) oo.selected = true; sK.appendChild(oo); });
  sK.addEventListener('change', () => {
    const was = st.kind;
    st.kind = sK.value;
    // Worked hours and paid-day-off hours mean different things; don't carry
    // one into the other when switching between a working and a day-off kind.
    if (WORKING.has(was) !== WORKING.has(st.kind)) st.hoursMin = null;
    if (st.kind === 'paid-off' && st.hoursMin == null) st.hoursMin = 480;
    drawFields(); drawPay();
  });
  fK.appendChild(sK); body.appendChild(fK);

  // ---- kind-specific fields
  const fields = el('div'); body.appendChild(fields);
  let lookupTimer;
  function drawFields() {
    fields.textContent = '';
    const working = WORKING.has(st.kind);

    if (st.kind === 'vacation') {
      fields.appendChild(el('div', 'hint', 'Left as a vacation day. The week pays 44 hours.'));
      return;
    }

    if (working) {
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

      const lk = el('div', 'lookup'); lk.id = 'pa-edit-lookup'; fields.appendChild(lk);

      const fH = el('div', 'pa-field'); fH.style.marginTop = '10px';
      fH.appendChild(el('label', 'pa-label', st.kind === 'holiday-worked' ? 'Hours actually worked' : 'Hours'));
      const iH = el('input', 'pa-input'); iH.type = 'number'; iH.step = '0.05'; iH.min = '0'; iH.inputMode = 'decimal'; iH.id = 'pa-edit-hours';
      iH.placeholder = 'from the paddle';
      if (st.hoursMin != null) iH.value = hoursStr(st.hoursMin);
      iH.addEventListener('input', () => { st.hoursMin = parseHours(iH.value); drawPay(); });
      fH.appendChild(iH);
      fH.appendChild(el('div', 'hint', 'Pre-filled from the run. Change it only if you worked a different amount.'));
      fields.appendChild(fH);

      if (st.kind === 'late') {
        const fL = el('div', 'pa-field'); fL.appendChild(el('label', 'pa-label', 'Late allowance (minutes)'));
        const iL = el('input', 'pa-input'); iL.type = 'number'; iL.step = '5'; iL.min = '0'; iL.inputMode = 'numeric'; iL.placeholder = 'e.g. 30';
        if (st.lateMin != null) iL.value = st.lateMin;
        iL.addEventListener('input', () => { const n = parseInt(iL.value, 10); st.lateMin = Number.isFinite(n) && n > 0 ? n : null; drawPay(); });
        fL.appendChild(iL);
        fL.appendChild(el('div', 'hint', 'Paid at time and a half and added to the day: 30 min adds 0.75 h.'));
        fields.appendChild(fL);
      }

      const fRep = el('div', 'pa-field'); fRep.appendChild(el('label', 'pa-label', 'Report time (Slate)'));
      const iRep = el('input', 'pa-input'); iRep.type = 'time';
      if (st.reportMin != null) iRep.value = S.pad2(Math.floor((st.reportMin % 1440) / 60)) + ':' + S.pad2(st.reportMin % 60);
      iRep.addEventListener('input', () => { const m = iRep.value.match(/^(\d{2}):(\d{2})$/); st.reportMin = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; drawPay(); });
      fRep.appendChild(iRep);
      const repHint = el('div', 'hint'); repHint.id = 'pa-edit-rephint';
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
    const lk = document.getElementById('pa-edit-lookup');
    if (!lk) return;
    st.run = await lookupLine(lk, st.runDayType, st.runNo, r.date, depotKey);
    const iH = document.getElementById('pa-edit-hours');
    if (iH && st.run && st.hoursMin == null) iH.value = hoursStr(Math.round(st.run.payHours * 60));
    if (iH && !st.run) iH.placeholder = 'run not in paddle - enter hours';
    drawPay();
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
    const runMin = st.run ? Math.round(st.run.payHours * 60) : 0;
    const workedMin = working ? (st.hoursMin != null ? st.hoursMin : runMin) : 0;
    const extras = [];
    // Late allowance is stored as the minutes held late; the 1.5x is applied
    // when hours are read (A.extraPayMin), so the rule lives in one place.
    if (st.kind === 'late' && st.lateMin) extras.push({ kind: 'late', min: st.lateMin, note: '' });
    if (st.kind === 'holiday-off') extras.push({ kind: 'holiday', min: A.HOLIDAY_PAY_MIN, note: '' });
    if (st.kind === 'holiday-worked') extras.push({ kind: 'holiday', min: A.HOLIDAY_WORKED_PAY_MIN, note: '' });
    if (st.kind === 'paid-off') extras.push({ kind: 'other', min: st.hoursMin != null ? st.hoursMin : 480, note: 'paid day off' });
    // Slate report time against the run's scheduled start (the paddle's).
    const earlyMin = working ? A.earlyReportMin(st.reportMin, st.run ? st.run.reportMin : null) : 0;
    const status = working ? 'scheduled'
      : st.kind === 'holiday-off' ? 'holiday'
      : st.kind === 'paid-off' ? 'vacation' : 'off';
    return { working, runMin, workedMin, extras, earlyMin, status };
  }
  function drawReportHint(b) {
    const h = document.getElementById('pa-edit-rephint');
    if (!h) return;
    if (st.reportMin == null) { h.textContent = 'If dispatch had you report before the run’s start, enter the time. The difference is added to the day.'; return; }
    if (!st.run) { h.textContent = 'Run start unknown (not in the paddle), so nothing is added.'; return; }
    h.textContent = 'Run starts ' + S.fmtClock(st.run.reportMin) + ' · reporting ' + S.fmtClock(st.reportMin)
      + (b.earlyMin ? ' adds ' + (b.earlyMin / 60).toFixed(2) + ' h.' : ' adds nothing (not before the start).');
  }
  function drawPay() {
    if (st.kind === 'vacation') {
      pay.innerHTML = 'Vacation week <b>' + (A.VACATION_WEEK_PAY_MIN / 60).toFixed(2) + ' hrs</b> · paid once for the week, not per day';
      return;
    }
    const b = build();
    drawReportHint(b);
    const parts = [];
    if (b.working) parts.push(['Worked', b.workedMin]);
    b.extras.forEach(x => parts.push([A.EXTRA_KINDS[x.kind] || 'Extra', A.extraPayMin(x)]));
    if (b.earlyMin) parts.push(['Early report', b.earlyMin]);
    const total = parts.reduce((s, p) => s + p[1], 0);
    pay.innerHTML = parts.length
      ? parts.map(([k, v]) => esc(k) + ' ' + (v / 60).toFixed(2)).join(' + ') + ' = <b>' + (total / 60).toFixed(2) + ' hrs</b>'
      : '<b>0.00 hrs</b>';
  }

  // ---- actions
  const stack = el('div', 'pa-stack');
  const save = el('button', 'pa-submit', 'Save day'); save.type = 'button';
  save.addEventListener('click', async () => {
    const b = build();
    // "On vacation" is the day having nothing of its own: clear any explicit
    // day so the vacation week shows through again.
    if (st.kind === 'vacation') {
      save.disabled = true;
      try {
        if (r.source === 'assignment') await confirmWrite(A.clearAssignment(r.date), () => showMsg(WAITING_FOR_SIGNAL, 'warn'));
        closeEdit();
        if (cfg.onSaved) cfg.onSaved(r.date);
      } catch (err) { showMsg('Could not save: ' + (err.code || err.message), 'err'); save.disabled = false; }
      return;
    }
    if (b.working && !st.runNo) { showMsg('Enter the run number, or choose a day-off kind.', 'err'); return; }
    if (b.working && !st.run && st.hoursMin == null) { showMsg('That run is not in the paddle. Enter the hours.', 'err'); return; }
    save.disabled = true; msgEl.hidden = true;
    try {
      await confirmWrite(A.saveAssignment(r.date, {
        kind: st.kind,
        runNo: b.working ? st.runNo : null,
        runDayType: b.working ? st.runDayType : null,
        depotKey: depotKey || null, dayType: r.dayType,
        status: b.status,
        extras: b.extras,
        payMin: b.working && st.hoursMin != null && (!st.run || st.hoursMin !== b.runMin) ? st.hoursMin : null,
        reportMin: b.working ? st.reportMin : null,
        flags: { holiday: st.kind.startsWith('holiday'), late: st.kind === 'late', callIn: false },
        note: st.note, source: 'edit'
      }), () => showMsg(WAITING_FOR_SIGNAL, 'warn'));
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
  drawFields(); drawPay();
}
