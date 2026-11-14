// The single-week hours view: day rows, scheduled and actual hours, week
// totals. Weekly Hours (hours.html) shows it editable; the Schedule tab on
// My run shows it read-only until the operator taps Edit. Its classes are
// prefixed hv- so the host page's own .row / .hint styles never reach it.
import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';
import * as E from './pa-edit-sheet.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

const HINT_EDIT = 'Tap a day to swap the run, mark it off, sick, vacation or holiday, or add overtime and bonuses. Hours come from the paddle for the run number; you never type them. Amber-edged days have something extra on them.';
const HINT_READ = 'Tap Edit to change a day: swap the run, mark it off, sick, vacation or holiday, or add overtime and bonuses. Hours come from the paddle for the run number. Amber-edged days have something extra on them.';

function statusLabel(r) {
  if (r.unregistered) return '—';
  if (!r.off) return 'RUN ' + r.runNo + (r.runDayType && r.runDayType !== r.dayType ? ' (' + r.runDayType + ')' : '');
  if (r.kind && A.KIND_LABELS[r.kind]) return A.KIND_LABELS[r.kind].toUpperCase();
  return ({ off: 'OFF', sick: 'SICK', vacation: 'PAID DAY OFF', holiday: 'HOLIDAY' })[r.status] || r.status.toUpperCase();
}

function extrasText(r, hours) {
  const bits = [];
  (r.extras || []).forEach(x => {
    if (x.kind === 'late') { bits.push('Late allowance ' + Math.abs(x.min) + 'm (+' + A.fmtHours(A.extraPayMin(x)) + 'h)'); return; }
    if (x.kind === 'ot') { bits.push('OT ' + x.min + 'm'); return; }
    const label = x.kind === 'holiday' ? 'Holiday' : (x.note || 'Extra');
    bits.push(label + ' +' + (x.min / 60).toFixed(2).replace(/\.?0+$/, '') + 'h');
  });
  if (hours && hours.earlyReportMin) bits.push('Early report +' + A.fmtHours(hours.earlyReportMin) + 'h');
  if (r.note) bits.push('“' + r.note + '”');
  return bits.join(' · ');
}

/**
 * Build the view inside `root`. opts:
 *   readOnly   rows do nothing when tapped (default false)
 *   getProfile () => the operator's profile (depotKey is needed)
 *   onEditDay  (r) => open the edit sheet for a day (default E.openEdit)
 *   onEditMenu (weekStart) => when set, an Edit button sits under the
 *              Saturday row, above the totals (My Run's Schedule tab)
 *   ytd        true: three more boxes under the totals, year to date (the
 *              work year from the pick sheet, through today)
 *   dayInfo    (iso, routes) => { alt } from the holiday calendar: a working
 *              day on an alternate schedule gets a "check" tag
 *   hint       text under the totals (replaces the read-only hint)
 *   workPaid   true: Actual is the REAL time worked (finish minus start,
 *              plus minutes held late) and a Paid column / box shows the pay
 *              (extras, holiday hours, vacation's 44 h). My Run only; Weekly
 *              Hours keeps Actual = pay.
 * Returns { render, setReadOnly, setOverrides, state }.
 */
export function mount(root, opts = {}) {
  const st = { readOnly: !!opts.readOnly, overrides: {}, seasons: [], seasonsLoaded: false, weekStart: null, token: 0 };
  const getProfile = opts.getProfile || (() => null);
  const onEditDay = opts.onEditDay || (r => E.openEdit(r));

  root.textContent = '';
  root.classList.add('pa-hours');
  const nav = el('div', 'hv-weeknav');
  const prev = el('button', 'hv-btn', '← PREV'); prev.type = 'button';
  const next = el('button', 'hv-btn', 'NEXT →'); next.type = 'button';
  const mid = el('div');
  const label = el('div', 'hv-label', '—');
  const pick = el('div', 'hv-pick');
  mid.append(label, pick);
  nav.append(prev, mid, next);

  const sheet = el('div', 'hv-sheet');
  const head = el('div', 'hv-hrow');
  const wp = !!opts.workPaid;
  head.append(el('span', null, 'Day'), el('span', null, 'Run'), el('span', 'n', 'Sched'), el('span', 'n', 'Actual'));
  if (wp) { head.appendChild(el('span', 'n', 'Paid')); root.classList.add('hv-wp'); }
  const rows = el('div');
  sheet.append(head, rows);

  const totals = el('div', 'hv-totals');
  const tot = (k, cls, sub) => {
    const t = el('div', 'hv-tot');
    const v = el('div', 'hv-tot-v' + (cls ? ' ' + cls : ''), k === 'Days worked' ? '0' : '0.00');
    const s = el('div', 'hv-tot-s', sub);
    t.append(el('div', 'hv-tot-k', k), v, s);
    totals.appendChild(t);
    return { v, s };
  };
  const tSch = tot('Scheduled', '', 'full week');
  const tAct = tot(wp ? 'Actual worked' : 'Actual', 'amber', 'through today');
  const tPaid = wp ? tot('Paid', '', 'through today') : null;
  const tDays = tot('Days worked', '', 'through today');
  if (wp) totals.classList.add('hv-four');
  const hintRead = opts.hint || HINT_READ;
  const hint = el('div', 'hv-hint', st.readOnly ? hintRead : HINT_EDIT);

  // Edit: under the Saturday row, above the totals.
  let editBar = null;
  if (opts.onEditMenu) {
    editBar = el('div', 'hv-editbar');
    const eb = el('button', 'hv-edit'); eb.type = 'button';
    eb.innerHTML = '<span aria-hidden="true">&#9998;</span> Edit schedule';
    eb.addEventListener('click', () => opts.onEditMenu(st.weekStart));
    editBar.appendChild(eb);
  }

  // Year to date: the same three boxes for the work year so far.
  let ytd = null;
  if (opts.ytd) {
    ytd = { head: el('div', 'hv-ytd-h', 'Year to date'), grid: el('div', 'hv-totals hv-ytd' + (wp ? ' hv-four' : '')), key: '', busy: null };
    const ytot = (k, cls, sub) => {
      const t = el('div', 'hv-tot');
      const v = el('div', 'hv-tot-v' + (cls ? ' ' + cls : ''), '…');
      t.append(el('div', 'hv-tot-k', k), v, el('div', 'hv-tot-s', sub));
      ytd.grid.appendChild(t);
      return v;
    };
    ytd.sch = ytot('YTD scheduled', '', 'through today');
    ytd.act = ytot(wp ? 'YTD actual worked' : 'YTD actual', 'amber', 'through today');
    ytd.paid = wp ? ytot('YTD paid', '', 'through today') : null;
    ytd.days = ytot('YTD days worked', '', 'through today');
  }
  root.append(nav, sheet);
  if (editBar) root.appendChild(editBar);
  root.appendChild(totals);
  if (ytd) root.append(ytd.head, ytd.grid);
  root.appendChild(hint);

  prev.addEventListener('click', () => { st.weekStart = S.addDays(st.weekStart, -7); render(); });
  next.addEventListener('click', () => { st.weekStart = S.addDays(st.weekStart, 7); render(); });

  // The season list arrives in the background; the week renders from the
  // operator's own schedule without waiting for it.
  S.loadSeasons().then(s => { st.seasons = s || []; st.seasonsLoaded = true; render(); }).catch(() => {});

  async function render() {
    const profile = getProfile();
    if (!profile) return;
    const myToken = ++st.token;
    const today = S.todayIso();
    if (!st.weekStart) st.weekStart = S.weekStartOf(today);
    root.classList.toggle('hv-ro', st.readOnly);
    const ws = st.weekStart, we = S.addDays(ws, 6);
    const season = S.seasonFor(st.seasons, ws);
    const seasonEnd = S.seasonFor(st.seasons, we);
    label.textContent = S.fmtDate(ws) + ' – ' + S.fmtDate(we) + ', ' + S.fromIso(we).getFullYear();
    if (season) {
      pick.textContent = season.label + ' pick' + (seasonEnd && seasonEnd.id !== season.id ? ' → ' + seasonEnd.label : '');
      pick.className = 'hv-pick';
    } else { pick.textContent = st.seasonsLoaded ? 'before any pick on record' : ''; pick.className = 'hv-pick none'; }

    const resolved = A.resolveRange(ws, we, st.overrides);
    const days = await Promise.all(resolved.map(async r => {
      const run = r.off ? null : await E.runFor(r, r.date, profile.depotKey).catch(() => null);
      return { r, run, hours: A.dayHours(r, run, today) };
    }));
    if (myToken !== st.token) return;      // a newer render superseded this one

    rows.textContent = '';
    let anyRegistered = false;
    for (const d of days) {
      const { r, run, hours } = d;
      if (!r.unregistered) anyRegistered = true;
      const row = el('div', 'hv-row' + (r.date === today ? ' today' : '') + (hours.flagged ? ' flag' : '') + (!hours.past ? ' future' : ''));
      const dc = el('div', 'd', S.DAY_SHORT[S.dowOf(r.date)].toUpperCase());
      dc.appendChild(el('small', null, S.fmtDate(r.date).slice(4) + (r.date === today ? ' · today' : '')));

      const rc = el('div', 'run' + (r.off ? ' off' : ''));
      rc.appendChild(document.createTextNode(statusLabel(r)));
      if (!r.off && run && run.pieces[0]) rc.appendChild(document.createTextNode(' · ' + run.pieces.map(p => p.routeLabel).join(' / ')));
      if (r.extraShift) rc.appendChild(el('span', 'tag green', 'extra shift'));
      else if (r.source === 'assignment' && !r.off && r.patternRunNo && r.runNo !== r.patternRunNo) rc.appendChild(el('span', 'tag violet', 'swapped'));
      else if (r.source === 'assignment' && r.off && r.patternRunNo) rc.appendChild(el('span', 'tag red', 'override'));
      if (r.holidayDate && !r.unregistered) rc.appendChild(el('span', 'tag amber', 'holiday'));
      if (hours.unknownRun) rc.appendChild(el('span', 'tag amber', 'not in paddle'));
      if (r.vacationWeek && r.source === 'assignment') rc.appendChild(el('span', 'tag amber', 'in vacation week'));
      if (opts.dayInfo && hours.working) {
        const inf = opts.dayInfo(r.date, run && run.pieces ? run.pieces.map(p => p.routeLabel) : null);
        if (inf && inf.alt) rc.appendChild(el('span', 'tag red', 'alt schedule · check'));
      }
      const rowSeason = S.seasonFor(st.seasons, r.date);
      if (rowSeason && season && rowSeason.id !== season.id) rc.appendChild(el('span', 'tag', rowSeason.label));
      const ex = extrasText(r, hours);
      if (ex) rc.appendChild(el('span', 'ex', ex));

      const sc = el('div', 'n' + (hours.scheduledMin ? '' : ' dim') + (hours.unknownRun ? ' warn' : ''), hours.scheduledMin ? A.fmtHours(hours.scheduledMin) : '—');
      // Future days and plain days off show a dash; a day that was worked, or
      // that carries extras (holiday pay, sick pay logged as "other"), shows hours.
      const blank = hours.actualMin == null || (!hours.working && !(r.extras && r.extras.length));
      if (wp) {
        // Actual = real time worked; Paid = what the day pays.
        const wBlank = hours.workMin == null || !hours.working;
        row.append(dc, rc, sc,
          el('div', 'n' + (wBlank ? ' dim' : ''), wBlank ? '—' : A.fmtHours(hours.workMin)),
          el('div', 'n paid' + (blank ? ' dim' : ''), blank ? '—' : A.fmtHours(hours.paidMin)));
      } else {
        const ac = el('div', 'n' + (blank ? ' dim' : ''), blank ? '—' : A.fmtHours(hours.actualMin));
        row.append(dc, rc, sc, ac);
      }
      if (!r.unregistered || r.date >= (st.seasons[0] ? st.seasons[0].start : '0000')) {
        // Checked at tap time, so switching modes needs no redraw.
        row.addEventListener('click', () => { if (!st.readOnly) onEditDay(r); });
      }
      rows.appendChild(row);
    }

    // Vacation is paid by the week, not by the day, so it is stated once
    // rather than smeared across seven rows that each read "VACATION".
    const t = A.weekTotals(days, today);
    if (t.vacationWeeks) {
      const vr = el('div', 'hv-row flag');
      const vd = el('div', 'd', 'VAC');
      vd.appendChild(el('small', null, 'week'));
      const vc = el('div', 'run');
      vc.appendChild(document.createTextNode('VACATION WEEK'));
      vc.appendChild(el('span', 'ex', 'Paid by the week, whatever the pick says.'));
      const started = ws <= today;
      if (wp) {
        vc.lastChild.textContent = 'Paid 44 hours by the week; nothing worked.';
        vr.append(vd, vc,
          el('div', 'n', A.fmtHours(t.vacationMin)),
          el('div', 'n' + (started ? '' : ' dim'), started ? '0.00' : '—'),
          el('div', 'n paid' + (started ? '' : ' dim'), started ? A.fmtHours(t.vacationMin) : '—'));
      } else {
        vr.append(vd, vc,
          el('div', 'n', A.fmtHours(t.vacationMin)),
          el('div', 'n' + (started ? '' : ' dim'), started ? A.fmtHours(t.vacationMin) : '—'));
      }
      rows.appendChild(vr);
    }
    tSch.v.textContent = A.fmtHours(t.scheduledMin);
    tAct.v.textContent = A.fmtHours(wp ? t.workMin : t.actualMin);
    if (tPaid) tPaid.v.textContent = A.fmtHours(t.paidMin);
    tDays.v.textContent = String(t.daysWorked);
    const whole = we < today;
    tAct.s.textContent = whole ? 'full week' : (ws > today ? 'not started' : 'through today');
    tDays.s.textContent = tAct.s.textContent;
    if (tPaid) tPaid.s.textContent = tAct.s.textContent;
    if (ytd) renderYtd(profile, today).catch(() => {});
    const sync = A.getState().sync;
    hint.textContent = anyRegistered
      ? (st.readOnly ? hintRead : HINT_EDIT)
      : sync.status === 'connecting' ? 'Loading your schedule…'
      : sync.status === 'error' && !A.getState().patterns.length ? 'Can’t load your schedule right now (' + sync.error + '). It will retry by itself.'
      : 'Nothing is registered for this week. Set up your pick on My run and every week from its start date fills in by itself.';
  }

  /** Year to date, from the work year's first day through today. Worked
   *  out again only when the schedule or the day changes. */
  async function renderYtd(profile, today) {
    let years = [];
    try { await S.loadSeasons(); years = window.PaPicks && window.PaPicks.loadYears ? await window.PaPicks.loadYears() : []; } catch (_) {}
    const y = years.length ? window.PaPicks.workYearFor(years, today) : null;
    if (!y) {
      ytd.head.textContent = 'Year to date · set "New Work Year" in the pick sheet';
      ytd.sch.textContent = ytd.act.textContent = ytd.days.textContent = '—';
      if (ytd.paid) ytd.paid.textContent = '—';
      return;
    }
    const key = A.getState().version + '|' + today + '|' + y.start + '|' + Object.keys(st.overrides || {}).length;
    ytd.head.textContent = 'Year to date · since ' + S.fmtDate(y.start) + ', ' + S.fromIso(y.start).getFullYear();
    if (ytd.key === key) return;
    ytd.key = key;
    const from = y.start, to = today < y.last ? today : y.last;
    const resolved = from <= to ? A.resolveRange(from, to, st.overrides) : [];
    const days = await Promise.all(resolved.map(async r => {
      const run = r.off ? null : await E.runFor(r, r.date, profile.depotKey).catch(() => null);
      return { r, run, hours: A.dayHours(r, run, today) };
    }));
    if (ytd.key !== key) return;            // a newer one started meanwhile
    const t = A.weekTotals(days, today);
    // Scheduled through today: the vacation weeks that have started count
    // their 44 hours (weekTotals adds each week once).
    ytd.sch.textContent = A.fmtHours(t.scheduledMin);
    ytd.act.textContent = A.fmtHours(wp ? t.workMin : t.actualMin);
    if (ytd.paid) ytd.paid.textContent = A.fmtHours(t.paidMin);
    ytd.days.textContent = String(t.daysWorked);
  }

  return {
    render,
    state: st,
    setReadOnly(v) { st.readOnly = !!v; render(); },
    setOverrides(ov) { st.overrides = ov || {}; render(); }
  };
}
