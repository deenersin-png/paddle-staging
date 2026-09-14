// ==========================================================================
// Paddle App — the day edit sheet, shared by home.html and hours.html.
//
// Editing a day writes ONLY assignments/{date}; the pattern is never touched.
// "Revert to my pattern" deletes that document. The sheet never asks for a
// run's base hours when the paddle knows the run — it looks them up — and
// only offers a manual hours field when the run is not in the paddle.
// ==========================================================================

import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';

const cfg = { profile: null, onSaved: null, onClosed: null };
let overlay = null, msgEl = null;
const slugCache = new Map();

export function configure(c) { Object.assign(cfg, c); }

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- shared lookups -------------------------------------------------------

export async function slugForDate(depotKey, iso) {
  const k = 'slug|' + depotKey + '|' + iso.slice(0, 7);
  if (!slugCache.has(k)) slugCache.set(k, S.slugFor(depotKey, iso));
  return slugCache.get(k);
}

/** Normalised run for a resolved day (paddle), with the day's report-time
 *  override applied; a synthetic run when only a manual time is known. */
export async function runFor(r, iso, depotKey) {
  if (!r || r.off || !r.runNo) return null;
  const depot = r.depotKey || depotKey || (cfg.profile && cfg.profile.depotKey);
  const { slug } = await slugForDate(depot, iso);
  let run = slug ? await S.getRun(slug, r.dayType, r.runNo) : null;
  if (run && r.reportMin != null) run = { ...run, reportMin: r.reportMin, overridden: true };
  if (!run && r.reportMin != null) {
    run = { runNo: r.runNo, dayType: r.dayType, reportMin: r.reportMin, finishMin: null,
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
      node.textContent = run.payHours.toFixed(1) + ' hrs · Report ' + S.fmtClock(run.reportMin) + ' · Finish ' + S.fmtClock(run.finishMin) + ' · ' + run.pieces.map(p => p.routeLabel).join(' / ');
      node.className = 'lookup ok';
      return run;
    });
  }).catch(() => { node.textContent = ''; return null; });
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
  msgEl.className = 'pa-msg ' + (kind === 'ok' ? 'pa-ok' : 'pa-err');
  msgEl.textContent = text; msgEl.hidden = false;
}

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

  // Working state of the sheet.
  const st = {
    runNo: r.runNo || r.patternRunNo || '',
    status: r.status && r.status !== 'holiday' ? r.status : (r.status === 'holiday' ? 'holiday' : 'scheduled'),
    extras: (r.extras || []).map(x => ({ ...x })),
    payMin: r.payMin != null ? r.payMin : null,
    reportMin: r.reportMin != null ? r.reportMin : null,
    callIn: !!(r.flags && r.flags.callIn),
    note: r.note || '',
    run: null
  };
  if (r.source !== 'assignment' && r.off && !r.holidayDate) st.status = 'off';

  if (r.source === 'pattern' && r.runNo) {
    body.appendChild(el('div', 'hint', 'From your pattern. Changes here affect this day only.'));
  } else if (r.unregistered) {
    body.appendChild(el('div', 'hint', 'Nothing registered for this day. Enter a run to log an extra shift.'));
  }

  // Run
  const fRun = el('div', 'pa-field'); fRun.appendChild(el('label', 'pa-label', 'Run #'));
  const iRun = el('input', 'pa-input'); iRun.type = 'text'; iRun.inputMode = 'numeric'; iRun.maxLength = 4; iRun.value = st.runNo;
  const lk = el('div', 'lookup');
  const manualWrap = el('div', 'pa-field'); manualWrap.hidden = true;
  manualWrap.appendChild(el('label', 'pa-label', 'Hours for this run (not in paddle)'));
  const iPay = el('input', 'pa-input'); iPay.type = 'number'; iPay.step = '0.1'; iPay.min = '0'; iPay.placeholder = 'e.g. 8.5';
  if (st.payMin != null) iPay.value = (st.payMin / 60).toFixed(2);
  iPay.addEventListener('input', () => { const v = parseFloat(iPay.value); st.payMin = Number.isFinite(v) ? Math.round(v * 60) : null; drawPay(); });
  manualWrap.appendChild(iPay);
  let t;
  async function doLookup() {
    st.run = await lookupLine(lk, r.dayType, st.runNo, r.date, depotKey);
    manualWrap.hidden = !(st.runNo && !st.run);
    drawPay();
  }
  iRun.addEventListener('input', () => { st.runNo = iRun.value.trim(); clearTimeout(t); t = setTimeout(doLookup, 350); });
  fRun.append(iRun, lk); body.appendChild(fRun); body.appendChild(manualWrap);

  // Status
  const fSt = el('div', 'pa-field'); fSt.appendChild(el('label', 'pa-label', 'This day'));
  const sSt = el('select', 'pa-select');
  [['scheduled', 'Working'], ['off', 'Off'], ['sick', 'Sick'], ['vacation', 'Vacation'], ['holiday', 'Holiday (not worked)']]
    .forEach(([v, l]) => { const oo = el('option', null, l); oo.value = v; if (v === st.status) oo.selected = true; sSt.appendChild(oo); });
  sSt.addEventListener('change', () => {
    st.status = sSt.value;
    if (st.status === 'holiday' && !st.extras.some(x => x.kind === 'holiday')) {
      st.extras.push({ kind: 'holiday', min: A.HOLIDAY_PAY_MIN, note: '' });
    }
    drawExtras(); drawPay();
  });
  fSt.appendChild(sSt); body.appendChild(fSt);

  // Report time override
  const fRep = el('div', 'pa-field'); fRep.appendChild(el('label', 'pa-label', 'Report time override (optional)'));
  const iRep = el('input', 'pa-input'); iRep.type = 'time';
  if (st.reportMin != null) iRep.value = S.pad2(Math.floor((st.reportMin % 1440) / 60)) + ':' + S.pad2(st.reportMin % 60);
  iRep.addEventListener('input', () => { const m = iRep.value.match(/^(\d{2}):(\d{2})$/); st.reportMin = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; });
  fRep.appendChild(iRep); body.appendChild(fRep);

  // Extras
  const exWrap = el('div', 'pa-field');
  exWrap.appendChild(el('label', 'pa-label', 'Extra hours on top of the run'));
  const exList = el('div', 'pa-stack');
  exWrap.appendChild(exList);
  const addRow = el('div', 'form-row'); addRow.style.marginTop = '8px';
  [['ot', '+ Overtime'], ['holiday', '+ Holiday bonus'], ['other', '+ Other']].forEach(([kind, label]) => {
    const b = el('button', 'pa-ghost', label); b.type = 'button';
    b.addEventListener('click', () => {
      st.extras.push({ kind, min: kind === 'ot' ? 30 : (kind === 'holiday' ? A.HOLIDAY_WORKED_BONUS_MIN : 60), note: '' });
      drawExtras(); drawPay();
    });
    addRow.appendChild(b);
  });
  exWrap.appendChild(addRow);
  body.appendChild(exWrap);

  function drawExtras() {
    exList.textContent = '';
    if (!st.extras.length) { exList.appendChild(el('div', 'hint', 'None. Overtime is entered in minutes; bonuses in hours.')); return; }
    st.extras.forEach((x, i) => {
      const row = el('div', 'extra-row');
      row.appendChild(el('span', 'extra-k', A.EXTRA_KINDS[x.kind] || 'Extra'));
      const inp = el('input', 'pa-input extra-in'); inp.type = 'number'; inp.min = '0';
      if (x.kind === 'ot') { inp.step = '5'; inp.value = x.min; inp.placeholder = 'min'; }
      else { inp.step = '0.25'; inp.value = (x.min / 60).toFixed(2).replace(/\.?0+$/, ''); inp.placeholder = 'hrs'; }
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        x.min = Number.isFinite(v) ? Math.round(x.kind === 'ot' ? v : v * 60) : 0;
        drawPay();
      });
      row.appendChild(inp);
      row.appendChild(el('span', 'extra-u', x.kind === 'ot' ? 'min' : 'hrs'));
      const note = el('input', 'pa-input extra-note'); note.type = 'text'; note.placeholder = 'note'; note.value = x.note || ''; note.maxLength = 60;
      note.addEventListener('input', () => { x.note = note.value; });
      row.appendChild(note);
      const rm = el('button', 'pa-close', '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove');
      rm.addEventListener('click', () => { st.extras.splice(i, 1); drawExtras(); drawPay(); });
      row.appendChild(rm);
      exList.appendChild(row);
    });
  }

  // Called in late (no hours effect), note
  const ci = el('label', 'check'); const cic = el('input'); cic.type = 'checkbox'; cic.checked = st.callIn;
  cic.addEventListener('change', () => { st.callIn = cic.checked; });
  ci.append(cic, document.createTextNode('Called in late')); body.appendChild(ci);

  const fNote = el('div', 'pa-field'); fNote.appendChild(el('label', 'pa-label', 'Note'));
  const iNote = el('input', 'pa-input'); iNote.type = 'text'; iNote.maxLength = 140; iNote.value = st.note;
  iNote.addEventListener('input', () => { st.note = iNote.value; });
  fNote.appendChild(iNote); body.appendChild(fNote);

  // Pay line
  const pay = el('div', 'pay'); body.appendChild(pay);
  function drawPay() {
    const working = st.status === 'scheduled' && !!st.runNo;
    const fake = { date: r.date, off: !working, runNo: st.runNo, status: st.status, dayType: r.dayType,
                   payMin: st.payMin, extras: st.extras, source: 'assignment' };
    const p = A.payHoursFor(fake, working ? st.run : null);
    pay.innerHTML = p.parts.length
      ? p.parts.map(([k, v]) => esc(k) + ' ' + (+v).toFixed(2)).join(' + ') + ' = <b>' + p.total.toFixed(2) + ' hrs</b>'
      : '<b>0.00 hrs</b>';
  }

  // Actions
  const stack = el('div', 'pa-stack');
  const save = el('button', 'pa-submit', 'Save day'); save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true; msgEl.hidden = true;
    try {
      const working = st.status === 'scheduled' && !!st.runNo;
      const extras = st.extras.filter(x => x.min > 0 || x.note).map(x => ({ kind: x.kind, min: Math.round(x.min), note: x.note || '' }));
      await A.saveAssignment(r.date, {
        runNo: working ? st.runNo : null,
        depotKey: depotKey || null, dayType: r.dayType,
        status: working ? 'scheduled' : (st.status === 'scheduled' ? 'off' : st.status),
        extras,
        payMin: working && !st.run && st.payMin != null ? st.payMin : null,
        reportMin: st.reportMin,
        flags: { overtime: extras.some(x => x.kind === 'ot'), holiday: st.status === 'holiday' || extras.some(x => x.kind === 'holiday'), callIn: st.callIn },
        note: st.note, source: 'edit'
      });
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
      try { await A.clearAssignment(r.date); closeEdit(); if (cfg.onSaved) cfg.onSaved(r.date); }
      catch (err) { showMsg(err.message, 'err'); }
    });
    stack.appendChild(rev);
  }
  const cancel = el('button', 'pa-ghost', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', closeEdit);
  stack.appendChild(cancel);
  body.appendChild(stack);

  card.append(head, body); o.appendChild(card);
  drawExtras(); drawPay();
  if (st.runNo) doLookup();
}
