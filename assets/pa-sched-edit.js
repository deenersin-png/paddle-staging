// ==========================================================================
// Paddle App — the Schedule tab's edit windows (My Run → Schedule → Edit).
//
//   openMenu(weekStart)   Edit this week · Bulk edit · Vacation edit · Cancel
//   editWeek(weekStart)   whole week or certain days, then one day at a time
//                         (the same fields as Edit this day), one Save
//   openBulk()            a whole picking: add, change, split or remove runs
//                         (Regular operators; holddown / slate keep their
//                         week-by-week page, cfg.openBulkPage)
//   openVacation()        this work year or next: add, move, remove weeks;
//                         a week with days entered by hand asks first
//
// Every window is the same compact card as Edit this day (pa-edit-sheet.js):
// a title, an × that closes WITHOUT saving, and a Save button that saves and
// closes. Nothing is written until Save.
// ==========================================================================

import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';
import * as E from './pa-edit-sheet.js';
import { weekCalendar } from './pa-setup.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (cls, text, on) => { const b = el('button', cls, text); b.type = 'button'; if (on) b.addEventListener('click', on); return b; };

const cfg = {
  getProfile: () => null,
  getOverrides: () => ({}),
  onSaved: () => {},
  dayNotes: null,          // (r, run) => [nodes]: vacation / holiday / alternate schedule notes
  openBulkPage: null       // holddown / slate: their week-by-week page
};
export function configure(c) { Object.assign(cfg, c); }

const depotKey = () => { const p = cfg.getProfile(); return p && p.depotKey; };
const dtOf = i => (i === 0 ? 'sunday' : i === 6 ? 'saturday' : 'weekday');
const yr = iso => S.fromIso(iso).getFullYear();
const fmtY = iso => S.fmtDate(iso) + ', ' + yr(iso);
const range = (a, b) => S.fmtDate(a) + ' – ' + (b ? S.fmtDate(b) : 'open');
const rangeY = (a, b) => fmtY(a) + ' – ' + (b ? fmtY(b) : 'until further notice');
const weekText = ws => 'Week of ' + S.fmtDate(ws) + ' – ' + S.fmtDate(S.addDays(ws, 6));

// ---- the window ------------------------------------------------------------

let current = null;
function closeAll() { if (current) { current.remove(); current = null; } document.removeEventListener('keydown', onKey); }
function onKey(e) { if (e.key === 'Escape') closeAll(); }

/** A compact card: title, ×, a body, a message line and a footer. */
function popup(title) {
  css();
  closeAll();
  const ov = el('div', 'pa-overlay pa-root se-ov');
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  const card = el('div', 'pa-card se-card');
  const head = el('div', 'pa-card-head');
  const t = el('div', 'pa-card-title', title);
  const x = btn('pa-close', '×', closeAll); x.setAttribute('aria-label', 'Close without saving');
  head.append(t, x);
  const body = el('div', 'pa-card-body');
  const main = el('div');
  const msg = el('div', 'pa-msg'); msg.hidden = true;
  const foot = el('div', 'se-foot');
  body.append(main, msg, foot);
  card.append(head, body); ov.appendChild(card);
  document.body.appendChild(ov);
  document.addEventListener('keydown', onKey);
  current = ov;
  return {
    main, foot,
    title(s) { t.textContent = s; },
    page() { main.textContent = ''; foot.textContent = ''; msg.hidden = true; card.scrollTop = 0; },
    say(text, kind) { msg.className = 'pa-msg ' + (kind === 'ok' ? 'pa-ok' : kind === 'warn' ? 'pa-warn' : 'pa-err'); msg.textContent = text; msg.hidden = !text; },
    close: closeAll
  };
}

/** A big tappable choice: a title and a line under it. */
function option(title, sub, on, cls) {
  const b = btn('se-opt' + (cls ? ' ' + cls : ''), null, on);
  b.appendChild(el('span', 'se-opt-t', title));
  if (sub) b.appendChild(el('span', 'se-opt-s', sub));
  return b;
}
function footer(w, back, nextLabel, onNext) {
  if (back) w.foot.appendChild(btn('pa-ghost', 'Back', back));
  if (nextLabel) { const b = btn('pa-submit', nextLabel, onNext); w.foot.appendChild(b); return b; }
  return null;
}
async function write(w, promise, okText) {
  try {
    await E.confirmWrite(promise, () => w.say(E.WAITING_FOR_SIGNAL, 'warn'));
    w.say(okText, 'ok');
    cfg.onSaved();
    setTimeout(closeAll, 700);
    return true;
  } catch (err) {
    w.say(err && err.code === 'permission-denied' ? 'That change was rejected by the security rules.' : 'Could not save: ' + ((err && (err.code || err.message)) || 'unknown error'), 'err');
    return false;
  }
}

// ---- the menu --------------------------------------------------------------

export function openMenu(weekStart) {
  const w = popup('Edit schedule');
  const p = cfg.getProfile();
  w.main.appendChild(el('div', 'se-sub', weekText(weekStart) + ', ' + yr(S.addDays(weekStart, 6))));
  const list = el('div', 'se-opts');
  list.append(
    option('Edit this week', 'Change one day, some days or the whole week', () => editWeek(weekStart)),
    option('Bulk edit', p && p.driverType !== 'regular' ? 'Your runs, week by week' : 'Your runs for a whole picking', () => {
      if (p && p.driverType !== 'regular' && cfg.openBulkPage) { closeAll(); cfg.openBulkPage(); } else openBulk();
    }),
    option('Vacation edit', 'Add, move or remove vacation weeks', () => openVacation())
  );
  w.main.appendChild(list);
  w.foot.appendChild(btn('pa-ghost', 'Cancel', closeAll));
}

// ---- Edit this week --------------------------------------------------------

export function editWeek(weekStart) {
  const w = popup('Edit this week');
  const dates = [0, 1, 2, 3, 4, 5, 6].map(i => S.addDays(weekStart, i));
  const resolved = new Map(dates.map(d => [d, A.resolve(d, cfg.getOverrides())]));
  const st = { chosen: new Set(), list: [], i: 0, forms: new Map(), revert: new Set() };
  const label = weekText(weekStart);

  function stepWhich() {
    w.page(); w.title('Edit this week');
    w.main.appendChild(el('div', 'se-sub', label));
    w.main.appendChild(el('div', 'se-q', 'What do you want to change?'));
    const list = el('div', 'se-opts');
    list.append(
      option('The whole week', 'Go through all 7 days, Sunday to Saturday', () => { st.whole = true; st.chosen = new Set(dates); begin(); }),
      option('Certain days', 'Choose the day or days', () => { if (st.whole) st.chosen = new Set(); st.whole = false; stepDays(); })
    );
    w.main.appendChild(list);
    footer(w, () => openMenu(weekStart));
  }

  function tagOf(r) {
    if (r.vacationWeek && r.source !== 'assignment') return 'VAC';
    if (r.holidayDate) return 'HOL';
    if (r.unregistered) return '—';
    return r.off ? 'OFF' : r.runNo;
  }
  function stepDays() {
    w.page(); w.title('Edit this week');
    w.main.appendChild(el('div', 'se-sub', label));
    w.main.appendChild(el('div', 'se-q', 'Which day or days?'));
    const row = el('div', 'se-days');
    dates.forEach((d, i) => {
      const r = resolved.get(d);
      const b = btn('se-day' + (st.chosen.has(d) ? ' on' : ''), null, () => {
        st.chosen.has(d) ? st.chosen.delete(d) : st.chosen.add(d);
        b.classList.toggle('on', st.chosen.has(d)); next.disabled = !st.chosen.size;
      });
      b.append(el('b', null, S.DAY_SHORT[i]), el('small', null, String(+d.slice(8))), el('i', null, tagOf(r)));
      row.appendChild(b);
    });
    w.main.appendChild(row);
    const next = footer(w, stepWhich, 'Next', () => { if (st.chosen.size) begin(); });
    next.disabled = !st.chosen.size;
  }

  function begin() { st.list = dates.filter(d => st.chosen.has(d)); st.i = 0; stepDay(); }

  function formFor(d) {
    if (!st.forms.has(d)) st.forms.set(d, E.dayForm(resolved.get(d), { depotKey: depotKey() }));
    return st.forms.get(d);
  }
  function stepDay() {
    const d = st.list[st.i], r = resolved.get(d);
    w.page();
    w.title(S.fmtDate(d) + (r.holidayDate ? ' · holiday' : ''));
    w.main.appendChild(el('div', 'se-sub', 'Day ' + (st.i + 1) + ' of ' + st.list.length + ' · ' + label));
    if (cfg.dayNotes) cfg.dayNotes(r).forEach(n => w.main.appendChild(n));
    const form = formFor(d);
    const box = el('div', 'se-form' + (st.revert.has(d) ? ' off' : ''));
    box.appendChild(form.node);
    if (r.source === 'assignment') {
      const hasPattern = !!A.activePattern(A.getState().patterns, d);
      const lab = el('label', 'check se-revert');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = st.revert.has(d);
      cb.addEventListener('change', () => { cb.checked ? st.revert.add(d) : st.revert.delete(d); box.classList.toggle('off', cb.checked); });
      lab.append(cb, document.createTextNode(hasPattern ? ' Clear my changes: back to my pick' : ' Remove this day (nothing registered)'));
      w.main.appendChild(lab);
    }
    w.main.appendChild(box);
    const last = st.i === st.list.length - 1;
    footer(w, () => { if (st.i > 0) { st.i--; stepDay(); } else if (st.whole) stepWhich(); else stepDays(); },
      last ? 'Save' : 'Next', () => {
        if (!st.revert.has(d) && form.isDirty()) {
          const res = form.result();
          if (res.error) { w.say(res.error, 'err'); return; }
        }
        if (last) save(); else { st.i++; stepDay(); }
      });
  }

  async function save() {
    const entries = [];
    for (const d of st.list) {
      if (st.revert.has(d)) { entries.push({ date: d, remove: true }); continue; }
      const f = st.forms.get(d);
      if (!f || !f.isDirty()) continue;
      const res = f.result();
      if (res.error) { st.i = st.list.indexOf(d); stepDay(); w.say(res.error, 'err'); return; }
      if (res.noop) continue;
      entries.push(res.remove ? { date: d, remove: true } : { date: d, ...res.data });
    }
    if (!entries.length) { closeAll(); return; }
    w.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const ok = await write(w, A.saveDays(entries), 'Saved ' + entries.length + (entries.length === 1 ? ' day.' : ' days.'));
    if (!ok) w.foot.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }

  stepWhich();
}

// ---- Bulk edit: a whole picking ---------------------------------------------

/** The runs of a saved block, by day of the week. */
function runsOf(p) {
  const o = {};
  Object.keys(p.days || {}).forEach(i => { o[+i] = (p.days[i] && p.days[i].runNo) || (p.runByDayType && p.runByDayType[dtOf(+i)]) || ''; });
  return o;
}
const summary = runs => Object.keys(runs).map(Number).sort((x, y) => x - y).map(i => S.DAY_SHORT[i] + ' ' + runs[i]).join(' · ');

/** The saved blocks inside a picking, cut to its dates. */
function partsIn(pk) {
  const lo = pk.start, hi = pk.last || '9999-12-31';
  return A.getState().patterns
    .filter(p => p.effectiveFrom <= hi && (!p.effectiveTo || p.effectiveTo >= lo))
    .map(p => ({ p, from: p.effectiveFrom < lo ? lo : p.effectiveFrom, to: !p.effectiveTo || p.effectiveTo > hi ? (pk.last || null) : p.effectiveTo, runs: runsOf(p) }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

/** Work days + one run per day, for [from, to]. */
function runsEditor(seed, from) {
  const v = { days: new Set(seed && seed.days ? seed.days : [1, 2, 3, 4, 5]), runs: { ...((seed && seed.runs) || {}) } };
  const node = el('div');
  const dWrap = el('div', 'pa-field');
  dWrap.appendChild(el('label', 'pa-label', 'Work days (tap to change)'));
  const dRow = el('div', 'days'); dWrap.appendChild(dRow);
  const rWrap = el('div', 'se-runs');
  node.append(dWrap, rWrap);
  function drawDays() {
    dRow.textContent = '';
    for (let i = 0; i < 7; i++) {
      dRow.appendChild(btn('dchip' + (v.days.has(i) ? ' on' : ''), S.DAY_SHORT[i].toUpperCase(), () => {
        v.days.has(i) ? v.days.delete(i) : v.days.add(i); drawDays(); drawRuns();
      }));
    }
  }
  function drawRuns() {
    rWrap.textContent = '';
    for (let i = 0; i < 7; i++) {
      if (!v.days.has(i)) continue;
      const f = el('div', 'pa-field');
      f.appendChild(el('label', 'pa-label', S.DAY_NAMES[i] + ' run #'));
      const inp = el('input', 'pa-input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.maxLength = 4; inp.placeholder = 'e.g. 209'; inp.value = v.runs[i] || '';
      const lk = el('div', 'lookup');
      let t; inp.addEventListener('input', () => { v.runs[i] = inp.value.trim(); clearTimeout(t); t = setTimeout(() => E.lookupLine(lk, dtOf(i), v.runs[i], from, depotKey()), 350); });
      f.append(inp, lk);
      if (v.runs[i]) E.lookupLine(lk, dtOf(i), v.runs[i], from, depotKey());
      rWrap.appendChild(f);
    }
  }
  drawDays(); drawRuns();
  return {
    node,
    value: () => ({ days: new Set(v.days), runs: { ...v.runs } }),
    error() {
      if (!v.days.size) return 'Tap at least one work day.';
      const missing = [...v.days].sort().filter(i => !v.runs[i]).map(i => S.DAY_SHORT[i]);
      return missing.length ? 'Enter the run number for: ' + missing.join(', ') + '.' : '';
    }
  };
}
function patternOf(v, from, to) {
  const d = {}; [...v.days].forEach(i => { d[String(i)] = { runNo: v.runs[i] }; });
  const rbt = {};
  const wk = [1, 2, 3, 4, 5].filter(i => v.days.has(i));
  if (wk.length) rbt.weekday = v.runs[wk[0]];
  if (v.days.has(6)) rbt.saturday = v.runs[6];
  if (v.days.has(0)) rbt.sunday = v.runs[0];
  return { periodDays: 7, days: d, runByDayType: rbt, depotKey: depotKey(), effectiveFrom: from, effectiveTo: to || null, preset: 'pick', label: range(from, to) };
}
const seedOf = part => part ? { days: Object.keys(part.runs).map(Number), runs: part.runs } : null;

export async function openBulk() {
  const w = popup('Bulk edit');
  w.main.appendChild(el('div', 'se-sub', 'Loading your pickings…'));
  const today = S.todayIso();
  let picks = [];
  try { picks = await S.loadSeasons(); } catch (_) {}
  if (current == null) return;
  const P = window.PaPicks;
  const cur = P && picks.length ? P.current(picks, today) : null;
  const nextPick = cur ? picks.find(p => p.startDate > cur.startDate) : null;
  const shown = [
    ...(nextPick ? [{ ...nextPick, when: 'next' }] : []),
    ...picks.filter(p => cur && p.startDate <= cur.startDate).reverse().map(p => ({ ...p, when: p.id === cur.id ? 'now' : 'past' }))
  ];

  function stepPicks() {
    w.page(); w.title('Bulk edit');
    w.main.appendChild(el('div', 'se-sub', 'Your runs for a whole picking (about six months).'));
    if (!shown.length) { w.main.appendChild(el('div', 'hint', 'The pick list could not be loaded. Check your connection and try again.')); return; }
    w.main.appendChild(el('div', 'se-q', 'Which picking?'));
    const list = el('div', 'se-opts');
    shown.forEach(pk => {
      const parts = partsIn(pk);
      const what = !parts.length ? 'Nothing saved yet'
        : parts.length === 1 ? summary(parts[0].runs) : parts.length + ' schedules saved';
      const b = option(pk.label + (pk.when === 'now' ? ' · now' : pk.when === 'next' ? ' · next' : ''),
        rangeY(pk.start, pk.last), () => stepPick(pk), pk.when === 'now' ? 'cur' : '');
      b.appendChild(el('span', 'se-opt-s se-opt-runs' + (parts.length ? '' : ' none'), what));
      list.appendChild(b);
    });
    w.main.appendChild(list);
    w.main.appendChild(el('div', 'hint', 'Past pickings are here too, so you can add your history.'));
  }

  function stepPick(pk) {
    const parts = partsIn(pk);
    w.page(); w.title(pk.label);
    w.main.appendChild(el('div', 'se-sub', rangeY(pk.start, pk.last)));
    if (parts.length) {
      const wins = el('div', 'wins');
      parts.forEach(pt => {
        const row = el('div', 'win');
        const dd = el('div', 'win-d', range(pt.from, pt.to));
        dd.appendChild(el('small', null, summary(pt.runs)));
        row.appendChild(dd);
        wins.appendChild(row);
      });
      w.main.appendChild(wins);
      // Weeks of the picking with no runs saved.
      const covered = d => parts.some(pt => pt.from <= d && (!pt.to || d <= pt.to));
      let gap = 0;
      for (let d = pk.start, n = 0; n < 60 && (!pk.last || d <= pk.last); d = S.addDays(d, 7), n++) if (!covered(d)) gap++;
      if (gap) w.main.appendChild(el('div', 'hint', gap + (gap === 1 ? ' week' : ' weeks') + ' of this picking ' + (gap === 1 ? 'has' : 'have') + ' no runs saved.'));
    }
    w.main.appendChild(el('div', 'se-q', 'What do you want to do?'));
    const list = el('div', 'se-opts');
    if (!parts.length) {
      const before = A.getState().patterns.filter(p => p.effectiveFrom < pk.start).slice(-1)[0];
      list.appendChild(option('Add my runs', 'One schedule for the whole picking', () => stepEdit(pk, [{ from: pk.start, to: pk.last || null, seed: before ? seedOf({ runs: runsOf(before) }) : null }])));
    } else {
      list.append(
        option('Change', parts.length === 1 ? 'New runs for the whole picking' : 'One schedule for the whole picking, replacing the ' + parts.length + ' saved',
          () => stepEdit(pk, [{ from: pk.start, to: pk.last || null, seed: seedOf(parts[0]) }])),
        option('Split', 'One schedule until a date, a different one after it', () => stepSplit(pk, parts)),
        option('Remove', 'Delete the runs saved for this picking', () => stepRemove(pk), 'danger')
      );
    }
    w.main.appendChild(list);
    footer(w, stepPicks);
  }

  function stepSplit(pk, parts) {
    w.page(); w.title(pk.label + ' · split');
    w.main.appendChild(el('div', 'se-sub', rangeY(pk.start, pk.last)));
    w.main.appendChild(el('div', 'se-q', 'When does the second schedule start?'));
    const f = el('div', 'pa-field');
    f.appendChild(el('label', 'pa-label', 'Starts on (Sunday)'));
    const sel = el('select', 'pa-select');
    const first = S.addDays(S.weekStartOf(pk.start), 7);
    const lastSun = pk.last ? S.weekStartOf(pk.last) : S.addDays(first, 40 * 7);
    const nextSun = S.addDays(S.weekStartOf(today), 7);
    let pick = nextSun >= first && nextSun <= lastSun ? nextSun : S.addDays(first, 7 * Math.floor(S.daysBetween(first, lastSun) / 14));
    // Where a saved part starts inside the picking, that is the likely answer.
    if (parts.length > 1) pick = parts[1].from > first && parts[1].from <= lastSun ? S.weekStartOf(parts[1].from) : pick;
    for (let d = first, n = 0; d <= lastSun && n < 60; d = S.addDays(d, 7), n++) {
      const o = el('option', null, fmtY(d) + (d === nextSun ? ' · next week' : '')); o.value = d; if (d === pick) o.selected = true; sel.appendChild(o);
    }
    f.appendChild(sel);
    w.main.appendChild(f);
    const out = el('div', 'se-split');
    const draw = () => {
      const s = sel.value;
      out.textContent = '';
      out.append(el('div', null, 'First schedule: ' + range(pk.start, S.addDays(s, -1))),
                 el('div', null, 'Second schedule: ' + range(s, pk.last || null)));
    };
    sel.addEventListener('change', draw); draw();
    w.main.appendChild(out);
    const at = d => parts.find(pt => pt.from <= d && (!pt.to || d <= pt.to)) || parts[0];
    footer(w, () => stepPick(pk), 'Next', () => {
      const s = sel.value;
      stepEdit(pk, [
        { from: pk.start, to: S.addDays(s, -1), seed: seedOf(at(pk.start)), name: 'First schedule' },
        { from: s, to: pk.last || null, seed: seedOf(at(s)), name: 'Second schedule' }
      ]);
    });
  }

  /** One page per schedule; Save on the last writes them all. */
  function stepEdit(pk, segs, i = 0) {
    const seg = segs[i];
    w.page(); w.title(pk.label + (segs.length > 1 ? ' · ' + (i + 1) + ' of ' + segs.length : ''));
    if (seg.name) w.main.appendChild(el('div', 'se-q', seg.name));
    const box = el('div', 'whole-pick');
    box.appendChild(el('b', null, rangeY(seg.from, seg.to)));
    w.main.appendChild(box);
    if (!seg.editor) seg.editor = runsEditor(seg.value ? { days: [...seg.value.days], runs: seg.value.runs } : seg.seed, seg.from);
    w.main.appendChild(seg.editor.node);
    if (i > 0 && !segs[i].touchedCopy) {
      const prev = segs[i - 1];
      w.main.appendChild(btn('pa-ghost se-copy', 'Copy runs from the first schedule', () => {
        const v = prev.editor.value();
        seg.editor = runsEditor({ days: [...v.days], runs: v.runs }, seg.from); seg.touchedCopy = true; stepEdit(pk, segs, i);
      }));
    }
    w.main.appendChild(el('div', 'hint', 'Every day in these dates fills in with these runs. Days you changed by hand, vacation weeks and holidays stay as they are.'));
    const last = i === segs.length - 1;
    const go = footer(w, () => { if (i > 0) stepEdit(pk, segs, i - 1); else stepPick(pk); }, last ? 'Save' : 'Next', async () => {
      const err = seg.editor.error();
      if (err) { w.say(err, 'err'); return; }
      seg.value = seg.editor.value();
      if (!last) { stepEdit(pk, segs, i + 1); return; }
      go.disabled = true;
      w.say('Saving…', 'warn');
      try {
        const list = segs.map(sg => patternOf(sg.value || sg.editor.value(), sg.from, sg.to));
        await E.confirmWrite(A.replaceWindow(segs[0].from, segs[segs.length - 1].to, list), () => w.say(E.WAITING_FOR_SIGNAL, 'warn'));
        w.say('Saved. ' + pk.label + ' is filled in.', 'ok');
        cfg.onSaved();
        setTimeout(closeAll, 700);
      } catch (e) {
        w.say('Could not save: ' + ((e && (e.code || e.message)) || 'unknown error'), 'err');
        go.disabled = false;
      }
    });
  }

  function stepRemove(pk) {
    w.page(); w.title(pk.label + ' · remove');
    w.main.appendChild(el('div', 'se-warn', 'Remove all runs saved for ' + pk.label + ' (' + range(pk.start, pk.last) + ')?'));
    w.main.appendChild(el('div', 'hint', 'Days you changed by hand and vacation weeks stay. You can add the runs again any time.'));
    w.foot.appendChild(btn('pa-ghost', 'Cancel', () => stepPick(pk)));
    const go = btn('pa-submit', 'Remove', async () => {
      go.disabled = true;
      await write(w, A.clearWindow(pk.start, pk.last || null), 'Removed the runs for ' + pk.label + '.');
      go.disabled = false;
    });
    w.foot.appendChild(go);
  }

  stepPicks();
}

// ---- Vacation edit ---------------------------------------------------------

/** Days entered by hand in the week starting `ws`: [{ date, text }]. */
function handDays(ws) {
  const out = [];
  const asg = A.getState().assignments;
  for (let i = 0; i < 7; i++) {
    const d = S.addDays(ws, i);
    const a = asg.get(d);
    if (!a) continue;
    const r = A.resolve(d, cfg.getOverrides());
    out.push({ date: d, text: S.DAY_SHORT[i] + ' ' + S.fmtDate(d).slice(4) + ': '
      + (!r.off && r.runNo ? 'run ' + r.runNo : (A.KIND_LABELS[r.kind] || r.status || 'day off').toLowerCase()) });
  }
  return out;
}

export async function openVacation() {
  const w = popup('Vacation edit');
  w.main.appendChild(el('div', 'se-sub', 'Loading…'));
  const today = S.todayIso();
  let years = [];
  try { await S.loadSeasons(); years = window.PaPicks && window.PaPicks.loadYears ? await window.PaPicks.loadYears() : []; } catch (_) {}
  if (current == null) return;
  const P = window.PaPicks;
  const calYear = y => ({ start: y + '-01-01', last: y + '-12-31', label: String(y), calendar: true });
  const thisY = years.length ? P.workYearFor(years, today) : calYear(+today.slice(0, 4));
  const nextY = years.length ? P.workYearNext(years, thisY, 1) : calYear(+today.slice(0, 4) + 1);

  const original = new Set(A.vacationWeeks());
  const staged = new Set(original);
  const allowance = A.getState().vacationAllowance;
  const inYear = (y, ws) => ws >= y.start && ws <= y.last;
  const countIn = (set, y) => [...set].filter(ws => inYear(y, ws)).length;

  function stepYear() {
    w.page(); w.title('Vacation edit');
    w.main.appendChild(el('div', 'se-q', 'Which year?'));
    const list = el('div', 'se-opts');
    [[thisY, 'This year'], [nextY, 'Next year']].forEach(([y, name]) => {
      const n = countIn(staged, y);
      list.appendChild(option(name + ' · ' + y.label, rangeY(y.start, y.last) + ' · ' + n + (n === 1 ? ' week' : ' weeks')
        + (allowance != null ? ' of ' + allowance : ''), () => stepWeeks(y)));
    });
    w.main.appendChild(list);
    if (!years.length) w.main.appendChild(el('div', 'hint', 'The work year start is not in the pick sheet yet, so calendar years are used.'));
    footer(w, null, null);
    w.foot.appendChild(btn('pa-ghost', 'Cancel', closeAll));
  }

  function stepWeeks(y, moving) {
    w.page(); w.title('Vacation ' + y.label);
    w.main.appendChild(el('div', 'se-sub', rangeY(y.start, y.last)));
    const n = countIn(staged, y);
    w.main.appendChild(el('div', 'se-count', n + (n === 1 ? ' vacation week' : ' vacation weeks')
      + (allowance != null ? ' of ' + allowance + (allowance - n > 0 ? ' · ' + (allowance - n) + ' still to place' : allowance - n < 0 ? ' · ' + (n - allowance) + ' more than you have' : ' · all placed') : '')
      + ' · 44 h each'));

    const weeks = [...staged].filter(ws => inYear(y, ws)).sort();
    if (weeks.length) {
      const list = el('div', 'wins');
      weeks.forEach(ws => {
        const row = el('div', 'win' + (moving === ws ? ' se-moving' : ''));
        const dd = el('div', 'win-d', weekText(ws));
        const hd = handDays(ws).length;
        dd.appendChild(el('small', null, (original.has(ws) ? '' : 'new · ') + (ws < S.weekStartOf(today) ? 'taken' : ws === S.weekStartOf(today) ? 'this week' : 'coming')
          + (hd && !original.has(ws) ? ' · has days entered by hand' : '')));
        const acts = el('div', 'win-acts');
        acts.append(
          btn('rowbtn', moving === ws ? 'CANCEL' : 'CHANGE', () => stepWeeks(y, moving === ws ? null : ws)),
          btn('rowbtn rm', 'REMOVE', () => { staged.delete(ws); stepWeeks(y); })
        );
        row.append(dd, acts);
        list.appendChild(row);
      });
      w.main.appendChild(list);
    }
    w.main.appendChild(el('div', 'se-q', moving ? 'Tap the Sunday of the new week for ' + S.fmtDate(moving) + '.' : 'Tap a Sunday to add a week.'));
    const cal = el('div', 'se-cal');
    w.main.appendChild(cal);
    weekCalendar(cal, {
      today, from: y.start, to: y.last,
      start: moving || y.month || (inYear(y, today) ? today : y.start),
      selected: () => [...staged],
      marks: ws => (!staged.has(ws) && handDays(ws).length ? 'se-hand' : ''),
      onToggle: ws => {
        y.month = ws;                       // stay on this month after the redraw
        if (moving) { if (!staged.has(ws)) { staged.delete(moving); staged.add(ws); } stepWeeks(y); return; }
        staged.has(ws) ? staged.delete(ws) : staged.add(ws);
        stepWeeks(y);
      }
    });
    w.main.appendChild(el('div', 'hint', 'A vacation week pays 44 hours and clears your runs for that week. A red line under a Sunday means that week has days you entered by hand.'));
    footer(w, stepYear, 'Save', () => save(y));
  }

  async function save(y, confirmed) {
    const added = [...staged].filter(ws => !original.has(ws));
    const removed = [...original].filter(ws => !staged.has(ws));
    if (!added.length && !removed.length) { closeAll(); return; }
    const clash = added.map(ws => ({ ws, days: handDays(ws) })).filter(c => c.days.length);
    if (clash.length && !confirmed) {
      w.page(); w.title('Vacation ' + y.label);
      w.main.appendChild(el('div', 'se-warn', clash.length === 1 ? 'This week already has scheduled work. Replace it with vacation?' : 'These weeks already have scheduled work. Replace them with vacation?'));
      clash.forEach(c => {
        const box = el('div', 'se-clash');
        box.appendChild(el('b', null, weekText(c.ws)));
        c.days.forEach(d => box.appendChild(el('div', null, d.text)));
        w.main.appendChild(box);
      });
      w.main.appendChild(el('div', 'hint', 'Confirm deletes those days, so each week is just the 44 hours of vacation.'));
      w.foot.appendChild(btn('pa-ghost', 'Cancel', () => stepWeeks(y)));
      w.foot.appendChild(btn('pa-submit', 'Confirm', () => save(y, true)));
      return;
    }
    const clear = clash.flatMap(c => c.days.map(d => d.date));
    w.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const ok = await write(w, A.saveVacationWeeks([...staged], clear),
      'Saved: ' + (added.length ? added.length + ' added' : '') + (added.length && removed.length ? ', ' : '') + (removed.length ? removed.length + ' removed' : '') + '.');
    if (!ok) w.foot.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }

  stepYear();
}

// ---- styles ----------------------------------------------------------------

let cssDone = false;
function css() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement('style');
  s.textContent = `
  .se-card .pa-card-body{display:flex;flex-direction:column;gap:0}
  .se-sub{font-family:var(--pa-mono);font-size:12px;color:var(--pa-dim);margin-bottom:12px}
  .se-q{font-family:var(--pa-sans);font-size:15px;font-weight:600;color:var(--pa-bright);margin:4px 0 10px}
  .se-opts{display:flex;flex-direction:column;gap:8px}
  .se-opt{display:flex;flex-direction:column;align-items:flex-start;gap:3px;width:100%;text-align:left;padding:12px 14px;
    background:var(--pa-ink);border:1px solid var(--pa-line2);border-left:4px solid var(--pa-amber);border-radius:8px;cursor:pointer;
    font-family:var(--pa-sans);color:var(--pa-bright)}
  .se-opt:hover,.se-opt:focus-visible{background:var(--pa-amber-dim);outline:none}
  .se-opt.cur{background:var(--pa-amber-dim)}
  .se-opt.danger{border-left-color:var(--pa-red)}
  .se-opt-t{font-size:15px;font-weight:700}
  .se-opt-s{font-size:13px;color:var(--pa-mid)}
  .se-opt-runs{font-family:var(--pa-mono);font-size:12px;color:var(--pa-text)}
  .se-opt-runs.none{color:var(--pa-dim);font-style:italic}
  .se-foot{display:flex;gap:8px;margin-top:16px}
  .se-foot:empty{display:none}
  .se-foot > *{flex:1 1 0;width:auto!important;margin:0!important}
  .se-days{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
  .se-day{display:flex;flex-direction:column;align-items:center;gap:1px;padding:8px 0;border:1px solid var(--pa-line2);border-radius:6px;
    background:var(--pa-ink);color:var(--pa-mid);cursor:pointer;font-family:var(--pa-mono)}
  .se-day b{font-size:12px}.se-day small{font-size:15px;font-weight:600;color:var(--pa-bright)}
  .se-day i{font-style:normal;font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .se-day.on{border-color:var(--pa-amber);background:var(--pa-amber-dim);color:var(--pa-amber);box-shadow:inset 0 0 0 1px var(--pa-amber)}
  .se-form.off{opacity:.35;pointer-events:none}
  .se-revert{margin:0 0 10px}
  .se-split{font-family:var(--pa-mono);font-size:12px;color:var(--pa-text);line-height:1.8;margin-top:8px}
  .se-copy{margin-top:8px}
  .se-runs{display:grid;grid-template-columns:1fr 1fr;gap:0 10px;margin-top:8px}
  .se-runs .pa-field{margin:0 0 8px;min-width:0}
  .se-runs .lookup{font-size:10px;line-height:1.35}
  .se-warn{font-family:var(--pa-sans);font-size:15px;font-weight:600;color:var(--pa-red);margin:4px 0 10px}
  .se-clash{border:1px solid var(--pa-line2);border-left:4px solid var(--pa-red);border-radius:8px;padding:8px 12px;margin-bottom:8px;
    font-family:var(--pa-mono);font-size:12px;color:var(--pa-text);line-height:1.6}
  .se-count{font-family:var(--pa-mono);font-size:12px;font-weight:600;color:var(--pa-amber);margin-bottom:10px}
  .se-moving{background:var(--pa-amber-dim)!important}
  .se-cal .pa-cal-row.se-hand .pa-cal-sun{box-shadow:inset 0 -3px 0 var(--pa-red)}
  .se-note{font-family:var(--pa-sans);font-size:13px;line-height:1.4;padding:8px 10px;border-radius:6px;margin-bottom:10px;
    border:1px solid var(--pa-line2);border-left:4px solid var(--pa-amber);background:var(--pa-amber-dim);color:var(--pa-text)}
  .se-note.alt{border-left-color:var(--pa-red);background:var(--pa-red-dim)}
  `;
  document.head.appendChild(s);
}

/** A note above a day's fields (also used by the Edit this day window). */
export function note(text, kind) { css(); return el('div', 'se-note' + (kind ? ' ' + kind : ''), text); }
