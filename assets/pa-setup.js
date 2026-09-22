// ==========================================================================
// Paddle App — first-run setup, the only thing between a new account and a
// working schedule.
//
// Creating the account asks for an email and a password and nothing else, so
// everything the app needs to be useful is asked here instead, in three
// steps: who you are (depot + driver type), your vacation weeks, and your
// runs. The runs step is shaped by the driver type, because the three kinds
// of operator know their work in completely different units:
//
//   Regular   one set of runs for the whole pick — ask the days off, the
//             weekday run, and the Saturday / Sunday runs only when those
//             days are worked.
//   Holddown  the same questions, but a holddown does not cover the whole
//             pick: it is held for this week, next week, or until dispatch
//             changes it.
//   Slate     day by day. Ask today and tomorrow, plus a whole week when
//             they are covering someone (a sick run), this week or next.
//
// Nothing is written until the last step, and the PROFILE is written last of
// all: a profile with a depot and a driver type is what marks setup as
// finished, so an abandoned run-through leaves the operator back here rather
// than in a half-built account.
// ==========================================================================

import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';
import * as E from './pa-edit-sheet.js';
import { saveProfile } from './pa-store.js';

export const DRIVER_TYPES = [
  { id: 'regular', label: 'REGULAR',  blurb: 'You hold the same runs for the whole pick.' },
  { id: 'relief',  label: 'HOLDDOWN', blurb: 'You hold runs by the week until dispatch changes them.' },
  { id: 'slate',   label: 'SLATE',    blurb: 'Dispatch gives you your runs day by day.' }
];

/** Setup is finished once the profile knows the depot and the driver type. */
export function needsSetup(profile) {
  return !profile || !profile.depotKey || !profile.driverType;
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const DRAFT_PREFIX = 'pa_setup_v1_';

// ---- styles ---------------------------------------------------------------
// Scoped to .pa-su so the wizard can live on any page without touching it.

function css() {
  if (document.getElementById('pa-setup-css')) return;
  const st = el('style'); st.id = 'pa-setup-css';
  st.textContent = `
  .pa-su{max-width:560px;margin:0 auto}
  .pa-su-steps{display:flex;gap:6px;margin-bottom:14px}
  .pa-su-step{flex:1 1 0;height:3px;border-radius:2px;background:var(--pa-line2)}
  .pa-su-step.on{background:var(--pa-amber)}
  .pa-su-h{font-family:var(--pa-mono);font-size:17px;font-weight:600;color:var(--pa-bright);letter-spacing:.02em}
  .pa-su-sub{font-family:var(--pa-sans);font-size:13px;color:var(--pa-mid);margin:6px 0 16px;line-height:1.5}
  .pa-su-opts{display:flex;flex-direction:column;gap:8px;margin-bottom:6px}
  .pa-su-opt{display:block;width:100%;text-align:left;padding:12px 14px;background:var(--pa-ink);border:1px solid var(--pa-line2);
    border-radius:var(--pa-radius);color:var(--pa-text);cursor:pointer}
  .pa-su-opt:hover{border-color:var(--pa-line3)}
  .pa-su-opt.on{border-color:var(--pa-amber);background:var(--pa-amber-dim)}
  .pa-su-opt b{display:block;font-family:var(--pa-mono);font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--pa-bright)}
  .pa-su-opt.on b{color:var(--pa-amber)}
  .pa-su-opt span{display:block;font-family:var(--pa-sans);font-size:12px;color:var(--pa-mid);margin-top:3px;line-height:1.4}
  .pa-su-days{display:flex;gap:5px;flex-wrap:nowrap}
  .pa-su-day{flex:1 1 0;min-width:0;padding:8px 0;background:var(--pa-ink);border:1px solid var(--pa-line2);border-radius:var(--pa-radius);
    color:var(--pa-mid);font-family:var(--pa-mono);font-size:11px;font-weight:600;letter-spacing:.04em;cursor:pointer;text-align:center}
  .pa-su-day small{display:block;font-size:9px;font-weight:400;letter-spacing:.06em;color:var(--pa-dim);margin-top:3px}
  .pa-su-day.off{border-color:rgba(245,166,35,.35);background:var(--pa-amber-dim);color:var(--pa-amber)}
  .pa-su-day.off small{color:var(--pa-amber)}
  .pa-su-wk{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}
  .pa-su-wk .pa-input{flex:1 1 auto}
  .pa-su-x{flex:0 0 auto;width:38px;height:38px;background:none;border:1px solid var(--pa-line2);border-radius:var(--pa-radius);
    color:var(--pa-dim);font-size:16px;line-height:1;cursor:pointer}
  .pa-su-x:hover{color:var(--pa-red);border-color:rgba(255,107,107,.35)}
  .pa-su-read{font-family:var(--pa-mono);font-size:11px;color:var(--pa-dim);margin:-4px 0 10px;line-height:1.5;min-height:15px}
  .pa-su-read.ok{color:var(--pa-green)}.pa-su-read.warn{color:var(--pa-amber)}
  .pa-su-nav{display:flex;gap:8px;margin-top:18px}
  .pa-su-nav .pa-submit{margin-top:0}
  .pa-su-nav .pa-ghost{width:auto;flex:0 0 auto;padding-left:18px;padding-right:18px}
  .pa-su-nav .pa-submit{flex:1 1 auto}
  .pa-su-note{font-family:var(--pa-sans);font-size:12px;color:var(--pa-dim);line-height:1.5;margin-top:10px}
  .pa-su-sum{font-family:var(--pa-mono);font-size:12px;color:var(--pa-mid);border:1px solid var(--pa-line);border-radius:var(--pa-radius);
    padding:12px 14px;margin-top:12px;line-height:1.9}
  .pa-su-sum b{color:var(--pa-amber);font-weight:600}
  .pa-su-link{background:none;border:none;padding:0;margin-top:2px;color:var(--pa-mid);font-family:var(--pa-mono);font-size:11px;
    text-decoration:underline;cursor:pointer}
  .pa-su-link:hover{color:var(--pa-amber)}`;
  document.head.appendChild(st);
}

// ---- draft ----------------------------------------------------------------
// Setup is several screens long and phones lock. The answers so far live on
// the device until the last step writes them, so a locked screen or a closed
// tab does not mean starting again.

function loadDraft(uid) {
  try {
    const j = JSON.parse(localStorage.getItem(DRAFT_PREFIX + uid) || 'null');
    if (j && j.offDays) j.offDays = new Set(j.offDays);
    return j;
  } catch (_) { return null; }
}
function saveDraft(uid, w) {
  try {
    // The answers only — the season and the depot list are reloaded, not kept.
    const { depotKey, depotLabel, driverType, vacDays, vacWeeks, runs, perDay, scope, slate } = w;
    localStorage.setItem(DRAFT_PREFIX + uid, JSON.stringify({
      depotKey, depotLabel, driverType, vacDays, vacWeeks, runs, perDay, scope, slate,
      offDays: [...w.offDays]
    }));
  } catch (_) {}
}
function clearDraft(uid) { try { localStorage.removeItem(DRAFT_PREFIX + uid); } catch (_) {} }

// ---- the wizard -----------------------------------------------------------

/**
 * Render setup into `node`.
 * @param node      container, emptied and owned by the wizard
 * @param user      the signed-in Firebase user
 * @param profile   whatever profile exists (may be null)
 * @param onDone    called with the saved profile once setup finishes
 */
export async function openSetup(node, { user, profile, overrides, onDone }) {
  css();
  const today = S.todayIso();
  const ov = overrides || {};
  const draft = loadDraft(user.uid) || {};
  const w = {
    step: 0,
    depotKey:   draft.depotKey   || (profile && profile.depotKey)   || '',
    depotLabel: draft.depotLabel || (profile && profile.depotLabel) || '',
    driverType: draft.driverType || '',
    vacDays:    draft.vacDays != null ? draft.vacDays : null,
    vacWeeks:   Array.isArray(draft.vacWeeks) ? draft.vacWeeks : [''],
    offDays:    draft.offDays instanceof Set ? draft.offDays : new Set([0, 6]),
    runs:       draft.runs || { weekday: '', saturday: '', sunday: '' },
    perDay:     draft.perDay || null,
    scope:      draft.scope || null,
    slate:      draft.slate || { today: '', todayRun: '', tomorrow: '', tomorrowRun: '', week: 'none' },
    // Filled in from picks.csv; the runs step needs the pick it is filling.
    season: null, depots: []
  };

  // Attach in the background: nothing is written before the last step, but
  // the save must not then wait on a first connection.
  if (!A.isAttached()) A.attach(user.uid).catch(() => {});

  S.loadSeasons()
    .then(async seasons => {
      w.season = S.seasonFor(seasons, today);
      w.depots = w.season ? await S.loadManifest(w.season) : [];
      if (w.step === 0) draw();            // never redraw under someone mid-answer
    })
    .catch(() => {});

  const root = el('div', 'pa-su pa-root');
  node.textContent = '';
  node.appendChild(root);

  const STEPS = ['You', 'Vacation', 'Your runs'];

  function draw() {
    root.textContent = '';
    const bar = el('div', 'pa-su-steps');
    STEPS.forEach((_, i) => bar.appendChild(el('div', 'pa-su-step' + (i <= w.step ? ' on' : ''))));
    root.appendChild(bar);
    [stepWho, stepVacation, stepRuns, stepSaving][w.step](root);
    saveDraft(user.uid, w);
  }

  function nav(parent, { next, nextLabel, back, disabled }) {
    const row = el('div', 'pa-su-nav');
    if (back) {
      const b = el('button', 'pa-ghost', 'Back'); b.type = 'button';
      b.addEventListener('click', back);
      row.appendChild(b);
    }
    const n = el('button', 'pa-submit', nextLabel || 'Next'); n.type = 'button';
    n.disabled = !!disabled;
    n.addEventListener('click', next);
    row.appendChild(n);
    parent.appendChild(row);
    return n;
  }

  // ---- step 1: depot + driver type ----------------------------------------

  function stepWho(parent) {
    parent.appendChild(el('div', 'pa-su-h', 'Where do you work?'));
    parent.appendChild(el('div', 'pa-su-sub', 'Your depot decides which paddle your run numbers come from.'));

    const f = el('div', 'pa-field');
    f.appendChild(el('label', 'pa-label', 'Home depot'));
    const sel = el('select', 'pa-select');
    const o0 = el('option', null, 'Choose your depot…'); o0.value = ''; sel.appendChild(o0);
    depotOptions(w.depots).forEach(d => {
      const o = el('option', null, d.label); o.value = d.key;
      if (d.key === w.depotKey) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      w.depotKey = sel.value;
      w.depotLabel = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
      saveDraft(user.uid, w);
      go.disabled = !ready();
    });
    f.appendChild(sel);
    parent.appendChild(f);

    parent.appendChild(el('label', 'pa-label', 'What kind of operator are you?'));
    const opts = el('div', 'pa-su-opts');
    DRIVER_TYPES.forEach(dt => {
      const b = el('button', 'pa-su-opt' + (dt.id === w.driverType ? ' on' : '')); b.type = 'button';
      b.append(el('b', null, dt.label), el('span', null, dt.blurb));
      b.addEventListener('click', () => {
        w.driverType = dt.id;
        [...opts.children].forEach(c => c.classList.remove('on'));
        b.classList.add('on');
        saveDraft(user.uid, w);
        go.disabled = !ready();
      });
      opts.appendChild(b);
    });
    parent.appendChild(opts);

    const ready = () => !!w.depotKey && !!w.driverType;
    const go = nav(parent, { next: () => { w.step = 1; draw(); }, disabled: !ready() });
  }

  // ---- step 2: vacation ---------------------------------------------------

  function stepVacation(parent) {
    parent.appendChild(el('div', 'pa-su-h', 'Your vacation'));
    parent.appendChild(el('div', 'pa-su-sub', 'Every vacation week is paid 44 hours, and the weeks you name here stay off your schedule. You can change them later.'));

    const fd = el('div', 'pa-field');
    fd.appendChild(el('label', 'pa-label', 'How many vacation days do you have?'));
    const days = el('input', 'pa-input');
    days.type = 'number'; days.min = '0'; days.max = '60'; days.step = '1'; days.inputMode = 'numeric';
    days.placeholder = 'e.g. 10';
    if (w.vacDays != null) days.value = String(w.vacDays);
    days.addEventListener('input', () => {
      const n = parseInt(days.value, 10);
      w.vacDays = Number.isFinite(n) && n >= 0 ? n : null;
      drawTotal(); saveDraft(user.uid, w);
    });
    fd.appendChild(days);
    fd.appendChild(el('div', 'hint', 'Five vacation days make one week. Leave it blank if you would rather not say.'));
    parent.appendChild(fd);

    parent.appendChild(el('label', 'pa-label', 'Which weeks?'));
    parent.appendChild(el('div', 'hint', 'Type the Sunday the week starts — 27/9 and 9/27 both work, so does Sep 27.'));
    const list = el('div'); list.style.marginTop = '8px';
    parent.appendChild(list);

    function drawWeeks() {
      list.textContent = '';
      w.vacWeeks.forEach((val, i) => {
        const row = el('div', 'pa-su-wk');
        const inp = el('input', 'pa-input');
        inp.type = 'text'; inp.placeholder = i === 0 ? 'e.g. 27/9' : 'another week';
        inp.value = val || '';
        inp.setAttribute('aria-label', 'Vacation week ' + (i + 1));
        const read = el('div', 'pa-su-read');
        const x = el('button', 'pa-su-x', '×'); x.type = 'button';
        x.setAttribute('aria-label', 'Remove this week');
        x.addEventListener('click', () => {
          w.vacWeeks.splice(i, 1);
          if (!w.vacWeeks.length) w.vacWeeks = [''];
          drawWeeks(); drawTotal(); saveDraft(user.uid, w);
        });
        inp.addEventListener('input', () => {
          w.vacWeeks[i] = inp.value;
          showRead(read, inp.value);
          drawTotal(); saveDraft(user.uid, w);
        });
        showRead(read, val);
        row.append(inp, x);
        list.append(row, read);
      });
      const add = el('button', 'pa-ghost', '+ Add another week'); add.type = 'button';
      add.addEventListener('click', () => { w.vacWeeks.push(''); drawWeeks(); saveDraft(user.uid, w); });
      list.appendChild(add);
    }

    function showRead(node, text) {
      const t = String(text || '').trim();
      if (!t) { node.textContent = ''; node.className = 'pa-su-read'; return; }
      const p = S.parseWeekInput(t, today);
      if (!p) { node.textContent = 'Not a date I can read — try 27/9 or Sep 27.'; node.className = 'pa-su-read warn'; return; }
      node.textContent = weekLabel(p.weekStart) + ' · 44 h'
        + (p.ambiguous ? ' · read as ' + S.fmtDate(p.date) : '');
      node.className = 'pa-su-read ok';
    }

    const total = el('div', 'pa-su-note');
    function drawTotal() {
      const weeks = pickedWeeks(w, today);
      const bits = [];
      bits.push(weeks.length ? weeks.length + (weeks.length === 1 ? ' week' : ' weeks') + ' · ' + A.fmtHours(weeks.length * A.VACATION_WEEK_PAY_MIN) + ' h' : 'No weeks entered yet.');
      if (w.vacDays) {
        const full = Math.floor(w.vacDays / 5), left = w.vacDays % 5;
        bits.push(w.vacDays + ' days is ' + full + (full === 1 ? ' full week' : ' full weeks')
          + (left ? ' and ' + left + (left === 1 ? ' day' : ' days') + ' over — mark single days later on the day itself.' : '.'));
      }
      total.textContent = bits.join(' · ');
    }

    drawWeeks(); drawTotal();
    parent.appendChild(total);

    nav(parent, { back: () => { w.step = 0; draw(); }, next: () => { w.step = 2; draw(); } });
  }

  // ---- step 3: runs -------------------------------------------------------

  function stepRuns(parent) {
    const isSlate = w.driverType === 'slate';
    const isRegular = w.driverType === 'regular';
    parent.appendChild(el('div', 'pa-su-h', 'Your runs'));
    parent.appendChild(el('div', 'pa-su-sub', isRegular
      ? 'Your pick fills in every week by itself once the app knows it.'
      : isSlate
        ? 'Whatever dispatch has given you so far. Add the rest as you get it.'
        : 'What you are holding right now. Enter the next one when dispatch changes it.'));

    const msg = el('div', 'msgline');
    if (isSlate) slateFields(parent, msg); else weekFields(parent, msg, isRegular);
    parent.appendChild(msg);

    nav(parent, {
      back: () => { w.step = 1; draw(); },
      nextLabel: 'Finish',
      next: () => {
        const problem = validate(w, msg);
        if (problem) { msg.textContent = problem; msg.className = 'msgline err'; return; }
        w.step = 3; draw();
      }
    });
  }

  /** Days off + runs: the Regular and Holddown questions, and the Slate's
   *  week when they are covering someone. The Slate has already said which
   *  weeks it covers, so it passes withScope false. */
  function weekFields(parent, msg, isRegular, withScope = true) {
    parent.appendChild(el('label', 'pa-label', 'Which days are you off?'));
    const days = el('div', 'pa-su-days');
    parent.appendChild(days);
    parent.appendChild(el('div', 'hint', 'Tap the days you do not work.'));

    const runsWrap = el('div'); runsWrap.style.marginTop = '14px';
    parent.appendChild(runsWrap);

    function drawDays() {
      days.textContent = '';
      for (let i = 0; i < 7; i++) {
        const off = w.offDays.has(i);
        const b = el('button', 'pa-su-day' + (off ? ' off' : '')); b.type = 'button';
        b.append(document.createTextNode(S.DAY_SHORT[i].toUpperCase()), el('small', null, off ? 'OFF' : 'WORK'));
        b.addEventListener('click', () => {
          off ? w.offDays.delete(i) : w.offDays.add(i);
          if (w.perDay) delete w.perDay[i];
          drawDays(); drawRuns(); saveDraft(user.uid, w);
        });
        days.appendChild(b);
      }
    }

    function drawRuns() {
      runsWrap.textContent = '';
      const weekdays = [1, 2, 3, 4, 5].filter(i => !w.offDays.has(i));
      if (!weekdays.length && w.offDays.has(0) && w.offDays.has(6)) {
        runsWrap.appendChild(el('div', 'hint', 'Every day is marked off — tap at least one working day above.'));
        return;
      }
      if (weekdays.length) {
        if (w.perDay) {
          weekdays.forEach(i => runField(runsWrap, {
            label: S.DAY_NAMES[i] + ' run #', dayType: 'weekday',
            get: () => w.perDay[i] || '', set: v => { w.perDay[i] = v; }
          }));
        } else {
          runField(runsWrap, {
            label: 'Weekday run # · ' + weekdays.map(i => S.DAY_SHORT[i]).join(' '), dayType: 'weekday',
            get: () => w.runs.weekday, set: v => { w.runs.weekday = v; }
          });
        }
        const t = el('button', 'pa-su-link', w.perDay ? 'Same run every weekday' : 'Different run on some weekdays?');
        t.type = 'button';
        t.addEventListener('click', () => {
          if (w.perDay) w.perDay = null;
          else { w.perDay = {}; weekdays.forEach(i => { w.perDay[i] = w.runs.weekday || ''; }); }
          drawRuns(); saveDraft(user.uid, w);
        });
        runsWrap.appendChild(t);
      }
      if (!w.offDays.has(6)) runField(runsWrap, { label: 'Saturday run #', dayType: 'saturday', get: () => w.runs.saturday, set: v => { w.runs.saturday = v; } });
      if (!w.offDays.has(0)) runField(runsWrap, { label: 'Sunday run #', dayType: 'sunday', get: () => w.runs.sunday, set: v => { w.runs.sunday = v; } });
    }

    drawDays(); drawRuns();

    // Holddown: the relief packages the depot publishes fill the whole week.
    if (!isRegular) {
      const pkg = el('div', 'pa-field'); pkg.style.marginTop = '14px';
      parent.appendChild(pkg);
      E.slugForDate(w.depotKey, today)
        .then(({ slug }) => (slug ? S.loadReliefPackages(slug) : new Map()))
        .then(pk => {
          if (!pk || !pk.size) return;
          pkg.appendChild(el('label', 'pa-label', 'Or fill it from a relief package'));
          const sel = el('select', 'pa-select');
          const o0 = el('option', null, 'Choose a package…'); o0.value = ''; sel.appendChild(o0);
          for (const [id, d] of pk) {
            const o = el('option', null, 'Relief ' + id + ' · ' + S.DAY_NAMES.map(n => d[n.toLowerCase()] || 'off').join(' '));
            o.value = id; sel.appendChild(o);
          }
          sel.addEventListener('change', () => {
            const d = pk.get(sel.value);
            if (!d) return;
            w.offDays = new Set();
            w.perDay = {};
            S.DAY_NAMES.forEach((n, i) => {
              const run = d[n.toLowerCase()] || '';
              if (!run) { w.offDays.add(i); return; }
              if (i === 0) w.runs.sunday = run; else if (i === 6) w.runs.saturday = run; else w.perDay[i] = run;
            });
            if (!Object.keys(w.perDay).length) w.perDay = null;
            drawDays(); drawRuns(); saveDraft(user.uid, w);
          });
          pkg.appendChild(sel);
        })
        .catch(() => {});
    }

    // How far the answers reach.
    if (!withScope) return;
    const scopeWrap = el('div'); scopeWrap.style.marginTop = '16px';
    parent.appendChild(scopeWrap);
    if (isRegular) {
      if (!w.scope) w.scope = 'pick';
      scopeWrap.appendChild(el('div', 'pa-su-note', pickNote(w)));
    } else {
      scopeWrap.appendChild(el('label', 'pa-label', 'How long do you have this?'));
      const opts = el('div', 'pa-su-opts');
      if (!w.scope) w.scope = 'open';
      [
        ['week',  'THIS WEEK ONLY',        weekLabel(S.weekStartOf(today))],
        ['2week', 'THIS WEEK AND NEXT',    weekLabel(S.weekStartOf(today)) + ' → ' + weekLabel(S.addDays(S.weekStartOf(today), 7))],
        ['open',  'UNTIL I CHANGE IT',     'Every week from this one. Enter the new week when dispatch moves you.']
      ].forEach(([id, label, blurb]) => {
        const b = el('button', 'pa-su-opt' + (id === w.scope ? ' on' : '')); b.type = 'button';
        b.append(el('b', null, label), el('span', null, blurb));
        b.addEventListener('click', () => {
          w.scope = id;
          [...opts.children].forEach(c => c.classList.remove('on'));
          b.classList.add('on');
          saveDraft(user.uid, w);
        });
        opts.appendChild(b);
      });
      scopeWrap.appendChild(opts);
    }
  }

  /** Slate: today, tomorrow, and a week when they are covering someone. */
  function slateFields(parent, msg) {
    const tomorrow = S.addDays(today, 1);

    dayChoice(parent, 'Today · ' + S.fmtDate(today), 'today', 'todayRun');
    dayChoice(parent, 'Tomorrow · ' + S.fmtDate(tomorrow), 'tomorrow', 'tomorrowRun');

    parent.appendChild(el('label', 'pa-label', 'Are you covering a run for a whole week?'));
    parent.appendChild(el('div', 'hint', 'A sick run or any hold dispatch gave you for the week.'));
    const opts = el('div', 'pa-su-opts');
    const weekWrap = el('div');
    [
      ['none', 'NO', 'Just the days above.'],
      ['this', 'THIS WEEK', weekLabel(S.weekStartOf(today))],
      ['both', 'THIS WEEK AND NEXT', weekLabel(S.weekStartOf(today)) + ' → ' + weekLabel(S.addDays(S.weekStartOf(today), 7))]
    ].forEach(([id, label, blurb]) => {
      const b = el('button', 'pa-su-opt' + (id === w.slate.week ? ' on' : '')); b.type = 'button';
      b.append(el('b', null, label), el('span', null, blurb));
      b.addEventListener('click', () => {
        w.slate.week = id;
        [...opts.children].forEach(c => c.classList.remove('on'));
        b.classList.add('on');
        drawWeek(); saveDraft(user.uid, w);
      });
      opts.appendChild(b);
    });
    parent.append(opts, weekWrap);

    function drawWeek() {
      weekWrap.textContent = '';
      if (w.slate.week === 'none') return;
      w.scope = w.slate.week === 'both' ? '2week' : 'week';
      const box = el('div'); box.style.marginTop = '14px';
      weekFields(box, msg, false, false);
      weekWrap.appendChild(box);
    }
    drawWeek();

    function dayChoice(parent, label, modeKey, runKey) {
      const f = el('div', 'pa-field');
      f.appendChild(el('label', 'pa-label', label));
      const seg = el('div', 'pa-seg');
      const runWrap = el('div');
      [['run', 'RUN'], ['off', 'OFF'], ['unknown', 'NOT YET']].forEach(([id, lab]) => {
        const b = el('button', 'pa-seg-btn' + (w.slate[modeKey] === id ? ' pa-on' : '')); b.type = 'button';
        b.textContent = lab;
        b.addEventListener('click', () => {
          w.slate[modeKey] = id;
          [...seg.children].forEach(c => c.classList.remove('pa-on'));
          b.classList.add('pa-on');
          drawRun(); saveDraft(user.uid, w);
        });
        seg.appendChild(b);
      });
      f.append(seg, runWrap);
      parent.appendChild(f);

      function drawRun() {
        runWrap.textContent = '';
        if (w.slate[modeKey] !== 'run') return;
        const date = modeKey === 'today' ? today : S.addDays(today, 1);
        runField(runWrap, {
          label: '', dayType: S.dayTypeFor(date, ov), date,
          get: () => w.slate[runKey], set: v => { w.slate[runKey] = v; }
        });
      }
      drawRun();
    }
  }

  /** One run number with the paddle's answer under it. */
  function runField(parent, { label, dayType, date, get, set }) {
    const f = el('div', 'pa-field');
    if (label) f.appendChild(el('label', 'pa-label', label));
    const inp = el('input', 'pa-input');
    inp.type = 'text'; inp.inputMode = 'numeric'; inp.maxLength = 4; inp.placeholder = 'e.g. 209';
    inp.value = get() || '';
    if (label) inp.setAttribute('aria-label', label);
    const look = el('div', 'lookup');
    let t;
    const lookup = () => E.lookupLine(look, dayType, (get() || '').trim(), date || today, w.depotKey);
    inp.addEventListener('input', () => {
      set(inp.value.trim());
      saveDraft(user.uid, w);
      clearTimeout(t); t = setTimeout(lookup, 350);
    });
    f.append(inp, look);
    parent.appendChild(f);
    if (get()) lookup();
    return inp;
  }

  // ---- step 4: save -------------------------------------------------------

  function stepSaving(parent) {
    parent.appendChild(el('div', 'pa-su-h', 'Setting up your schedule'));
    const line = el('div', 'pa-su-sub', 'Saving…');
    parent.appendChild(line);
    const summary = el('div', 'pa-su-sum');
    summary.innerHTML = summaryHtml(w, today);
    parent.appendChild(summary);
    const msg = el('div', 'msgline');
    parent.appendChild(msg);

    let retry = null;
    const run = async () => {
      msg.textContent = ''; msg.className = 'msgline';
      if (retry) { retry.remove(); retry = null; }
      try {
        const saved = await commit(w, user, profile, today, ov, s => { line.textContent = s; });
        clearDraft(user.uid);
        line.textContent = 'Done.';
        // Hand back the profile just written, so the page never has to read it
        // again to carry on — that read is exactly what fails on a bad signal.
        if (onDone) onDone(saved);
      } catch (err) {
        line.textContent = 'Nothing was lost — your answers are still here.';
        msg.textContent = err && err.code === 'permission-denied'
          ? 'The server refused that save. Check you are still signed in.'
          : 'Could not save: ' + ((err && (err.code || err.message)) || 'unknown error');
        msg.className = 'msgline err';
        const row = el('div', 'pa-su-nav');
        const back = el('button', 'pa-ghost', 'Back'); back.type = 'button';
        back.addEventListener('click', () => { w.step = 2; draw(); });
        const again = el('button', 'pa-submit', 'Try again'); again.type = 'button';
        again.addEventListener('click', run);
        row.append(back, again);
        parent.appendChild(row);
        retry = row;
      }
    };
    run();
  }

  draw();
}

// ---- pure helpers ---------------------------------------------------------

/** Vacation weeks the operator typed, as week-start Sundays, deduped. */
export function pickedWeeks(w, today) {
  const out = [];
  (w.vacWeeks || []).forEach(t => {
    const p = S.parseWeekInput(t, today);
    if (p && !out.includes(p.weekStart)) out.push(p.weekStart);
  });
  return out.sort();
}

/** What is missing before setup can be saved, or '' when it is complete. */
export function validate(w, _msg) {
  if (w.driverType === 'slate') {
    if (!w.slate.today) return 'Say what you are doing today.';
    if (w.slate.today === 'run' && !w.slate.todayRun) return 'Enter today’s run number.';
    if (!w.slate.tomorrow) return 'Say what you are doing tomorrow.';
    if (w.slate.tomorrow === 'run' && !w.slate.tomorrowRun) return 'Enter tomorrow’s run number.';
    if (w.slate.week === 'none') return '';
  }
  const working = [0, 1, 2, 3, 4, 5, 6].filter(i => !w.offDays.has(i));
  if (!working.length) return 'Tap at least one working day.';
  const missing = [];
  const weekdays = [1, 2, 3, 4, 5].filter(i => !w.offDays.has(i));
  if (weekdays.length) {
    if (w.perDay) weekdays.forEach(i => { if (!w.perDay[i]) missing.push(S.DAY_SHORT[i]); });
    else if (!w.runs.weekday) missing.push('weekday');
  }
  if (!w.offDays.has(6) && !w.runs.saturday) missing.push('Saturday');
  if (!w.offDays.has(0) && !w.runs.sunday) missing.push('Sunday');
  return missing.length ? 'Enter the run number for: ' + missing.join(', ') + '.' : '';
}

/** The pattern days/runByDayType the answers describe. */
export function patternFrom(w) {
  const days = {}, runByDayType = {};
  const weekdays = [1, 2, 3, 4, 5].filter(i => !w.offDays.has(i));
  weekdays.forEach(i => {
    const run = w.perDay ? (w.perDay[i] || '') : w.runs.weekday;
    if (run) days[String(i)] = { runNo: String(run).trim() };
  });
  if (weekdays.length && !w.perDay && w.runs.weekday) runByDayType.weekday = String(w.runs.weekday).trim();
  if (!w.offDays.has(6) && w.runs.saturday) { days['6'] = { runNo: String(w.runs.saturday).trim() }; runByDayType.saturday = String(w.runs.saturday).trim(); }
  if (!w.offDays.has(0) && w.runs.sunday)   { days['0'] = { runNo: String(w.runs.sunday).trim() };   runByDayType.sunday = String(w.runs.sunday).trim(); }
  return { days, runByDayType };
}

/** The window a pattern covers, from the scope the operator chose. */
export function windowFor(w, today) {
  const ws = S.weekStartOf(today);
  if (w.driverType === 'regular') {
    const from = w.season && w.season.start ? w.season.start : ws;
    // picks.csv holds the NEXT pick's start as this one's end, so the last
    // day covered is the day before it. The current pick has none: it runs
    // until the operator enters their next one.
    const to = w.season && w.season.end ? S.addDays(w.season.end, -1) : null;
    return { from, to, preset: 'pick' };
  }
  const preset = w.driverType === 'slate' ? 'slate-week' : 'relief-week';
  if (w.scope === 'week')  return { from: ws, to: S.addDays(ws, 6),  preset };
  if (w.scope === '2week') return { from: ws, to: S.addDays(ws, 13), preset };
  return { from: ws, to: null, preset };
}

function pickNote(w) {
  const win = windowFor(w, S.todayIso());
  return w.season
    ? 'This fills your whole ' + w.season.label + ' pick: from ' + S.fmtDate(win.from)
      + (win.to ? ' to ' + S.fmtDate(win.to) + '.' : ' until your next pick.')
    : 'This fills every week from ' + S.fmtDate(win.from) + ' until you change it.';
}

const weekLabel = ws => S.fmtDate(ws) + ' – ' + S.fmtDate(S.addDays(ws, 6));

function summaryHtml(w, today) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dt = DRIVER_TYPES.find(d => d.id === w.driverType);
  const rows = [['Depot', w.depotLabel || w.depotKey], ['Type', dt ? dt.label : w.driverType]];
  const weeks = pickedWeeks(w, today);
  rows.push(['Vacation', weeks.length
    ? weeks.length + (weeks.length === 1 ? ' week' : ' weeks') + ' · ' + A.fmtHours(weeks.length * A.VACATION_WEEK_PAY_MIN) + ' h'
    : 'none yet']);
  if (w.driverType === 'slate') {
    rows.push(['Today', w.slate.today === 'run' ? 'Run ' + w.slate.todayRun : w.slate.today === 'off' ? 'Off' : 'not known yet']);
    rows.push(['Tomorrow', w.slate.tomorrow === 'run' ? 'Run ' + w.slate.tomorrowRun : w.slate.tomorrow === 'off' ? 'Off' : 'not known yet']);
  }
  if (w.driverType !== 'slate' || w.slate.week !== 'none') {
    const { days } = patternFrom(w);
    const runs = Object.keys(days).map(Number).sort((a, b) => a - b).map(i => S.DAY_SHORT[i] + ' ' + days[i].runNo);
    rows.push(['Runs', runs.join(' · ') || '—']);
    const win = windowFor(w, today);
    rows.push(['Covers', S.fmtDate(win.from) + (win.to ? ' – ' + S.fmtDate(win.to) : ' onwards')]);
  }
  return rows.map(([k, v]) => esc(k) + ' <b>' + esc(v) + '</b>').join('<br>');
}

/** Depot list for the picker: this season's manifest, else the known depots. */
function depotOptions(districts) {
  const seen = new Map();
  (districts || []).forEach(d => {
    const k = S.depotKeyOf(d.name);
    if (!seen.has(k)) seen.set(k, d.label || d.name);
  });
  if (!seen.size) {
    [['callowhillb', 'Callowhill Bus'], ['allegheny', 'Allegheny'], ['victory', 'Victory Bus'],
     ['frontier', 'Frontier'], ['southern', 'Southern'], ['elmwood', 'Elmwood'], ['comly', 'Comly'],
     ['frankfordb', 'Frankford Bus'], ['frankford-rail', 'Frankford Rail'], ['midvale', 'Midvale']]
      .forEach(([k, l]) => seen.set(k, l));
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

// ---- the one write --------------------------------------------------------

/**
 * Write the answers: vacation weeks, then runs, then the profile LAST,
 * because the profile is what says setup is finished. Every write waits for
 * the server to confirm it (E.confirmWrite), so "Done" is the truth.
 */
async function commit(w, user, profile, today, ov, say) {
  const slow = what => () => say('Waiting for signal… keep this page open — ' + what);

  if (!A.isAttached()) { say('Connecting…'); await A.attach(user.uid); }

  say('Saving your vacation weeks…');
  await E.confirmWrite(A.saveVacation(pickedWeeks(w, today), w.vacDays), slow('saving vacation'));

  const hasWeek = w.driverType !== 'slate' || w.slate.week !== 'none';
  if (hasWeek) {
    say('Saving your runs…');
    const { days, runByDayType } = patternFrom(w);
    const win = windowFor(w, today);
    await E.confirmWrite(A.savePattern({
      periodDays: 7, days, runByDayType, depotKey: w.depotKey,
      effectiveFrom: win.from, effectiveTo: win.to, preset: win.preset,
      label: win.preset === 'pick' && w.season ? w.season.label + ' pick' : 'week of ' + win.from
    }), slow('saving runs'));
  }

  if (w.driverType === 'slate') {
    // Today and tomorrow are single days, and they outrank any week above —
    // dispatch's latest word wins.
    const ops = [];
    [['today', 'todayRun', today], ['tomorrow', 'tomorrowRun', S.addDays(today, 1)]].forEach(([modeKey, runKey, date]) => {
      if (w.slate[modeKey] === 'run' && w.slate[runKey]) {
        ops.push({ date, runNo: String(w.slate[runKey]).trim(), status: 'scheduled', source: 'manual',
                   depotKey: w.depotKey, dayType: S.dayTypeFor(date, ov) });
      } else if (w.slate[modeKey] === 'off' && hasWeek) {
        // Off beats the week they just entered, so say so explicitly.
        ops.push({ date, runNo: null, status: 'off', kind: 'unpaid-off', source: 'manual',
                   depotKey: w.depotKey, dayType: S.dayTypeFor(date, ov) });
      }
    });
    if (ops.length) {
      say('Saving today and tomorrow…');
      await E.confirmWrite(A.saveDays(ops), slow('saving your days'));
    }
  }

  say('Finishing your account…');
  const saved = await E.confirmWrite(saveProfile({
    ...(profile || {}),
    email:       user.email || (profile && profile.email) || '',
    displayName: (profile && profile.displayName) || user.displayName || '',
    badgeNumber: (profile && profile.badgeNumber) || '',
    driverType:  w.driverType,
    depotKey:    w.depotKey,
    depotLabel:  w.depotLabel,
    defaultSeasonId: w.season ? w.season.id : (profile && profile.defaultSeasonId) || '',
    createdAt:   profile && profile.createdAt
  }), slow('finishing your account'));
  return saved;
}

// ---- vacation, after setup ------------------------------------------------

/**
 * The "My vacation" card on the schedule tab: the weeks on record, a box to
 * add one, and how many days are still unspoken for. Same input rules as
 * setup, so an operator learns them once.
 */
export function renderVacationCard(node, { onChange } = {}) {
  css();
  const today = S.todayIso();
  node.textContent = '';
  node.appendChild(el('h2', 'k', 'My vacation'));

  const st = A.getState();
  const weeks = A.vacationWeeks();
  const msg = el('div', 'msgline');

  if (weeks.length) {
    const list = el('div', 'wins');
    weeks.forEach(ws => {
      const row = el('div', 'win');
      const d = el('div', 'win-d', weekLabel(ws));
      d.appendChild(el('small', null, A.fmtHours(A.VACATION_WEEK_PAY_MIN) + ' h'
        + (ws < S.weekStartOf(today) ? ' · taken' : ws === S.weekStartOf(today) ? ' · this week' : '')));
      const acts = el('div', 'win-acts');
      const rm = el('button', 'rowbtn rm', 'REMOVE'); rm.type = 'button';
      rm.addEventListener('click', async () => {
        if (rm.dataset.armed !== '1') {
          rm.dataset.armed = '1'; rm.textContent = 'TAP AGAIN';
          setTimeout(() => { rm.dataset.armed = ''; rm.textContent = 'REMOVE'; }, 4000);
          return;
        }
        rm.disabled = true;
        try {
          await E.confirmWrite(A.setVacationWeek(ws, false), () => { msg.textContent = E.WAITING_FOR_SIGNAL; msg.className = 'msgline'; });
          msg.textContent = 'Removed ' + weekLabel(ws) + '.'; msg.className = 'msgline ok';
          if (onChange) onChange();
        } catch (err) {
          msg.textContent = 'Could not remove: ' + (err.code || err.message); msg.className = 'msgline err';
          rm.disabled = false; rm.dataset.armed = ''; rm.textContent = 'REMOVE';
        }
      });
      acts.appendChild(rm);
      row.append(d, acts);
      list.appendChild(row);
    });
    node.appendChild(list);
  } else {
    node.appendChild(el('div', 'hint', 'No vacation weeks on record. Each one you add is paid 44 hours and clears your runs for that week.'));
  }

  const f = el('div', 'pa-field'); f.style.marginTop = '12px';
  f.appendChild(el('label', 'pa-label', 'Add a week'));
  const row = el('div', 'pa-su-wk');
  const inp = el('input', 'pa-input');
  inp.type = 'text'; inp.placeholder = 'e.g. 27/9'; inp.setAttribute('aria-label', 'Vacation week to add');
  const add = el('button', 'pa-ghost', 'ADD'); add.type = 'button'; add.style.width = 'auto'; add.style.flex = '0 0 auto';
  const read = el('div', 'pa-su-read');
  inp.addEventListener('input', () => {
    const p = S.parseWeekInput(inp.value, today);
    read.className = 'pa-su-read' + (p ? ' ok' : inp.value.trim() ? ' warn' : '');
    read.textContent = !inp.value.trim() ? ''
      : p ? weekLabel(p.weekStart) + ' · 44 h' : 'Not a date I can read — try 27/9 or Sep 27.';
  });
  add.addEventListener('click', async () => {
    const p = S.parseWeekInput(inp.value, today);
    if (!p) { msg.textContent = 'Type the week first, for example 27/9.'; msg.className = 'msgline err'; return; }
    if (A.getState().vacations.has(p.weekStart)) { msg.textContent = 'That week is already on your vacation.'; msg.className = 'msgline err'; return; }
    add.disabled = true;
    try {
      await E.confirmWrite(A.setVacationWeek(p.weekStart, true), () => { msg.textContent = E.WAITING_FOR_SIGNAL; msg.className = 'msgline'; });
      msg.textContent = 'Added ' + weekLabel(p.weekStart) + '.'; msg.className = 'msgline ok';
      inp.value = ''; read.textContent = '';
      if (onChange) onChange();
    } catch (err) {
      msg.textContent = 'Could not add: ' + (err.code || err.message); msg.className = 'msgline err';
    }
    add.disabled = false;
  });
  row.append(inp, add);
  f.append(row, read);
  node.appendChild(f);

  if (st.vacationDays != null) {
    const left = st.vacationDays - weeks.length * 5;
    node.appendChild(el('div', 'hint', st.vacationDays + ' vacation days'
      + (weeks.length ? ' · ' + weeks.length * 5 + ' in the weeks above' : '')
      + (left > 0 ? ' · ' + left + ' still to place' : left < 0 ? ' · ' + (-left) + ' more than you said you had' : ' · all placed')));
  }
  node.appendChild(msg);
}
