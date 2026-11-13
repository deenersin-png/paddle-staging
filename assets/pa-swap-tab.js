// ==========================================================================
// Paddle App — the SWAP tab (home.html, fourth tab after Today, Schedule
// and Alerts).
//
//   BOARD       offers in the user's own district (from the profile), each
//               checked against the user's own week: green fits, red not
//               eligible with the reason, yellow no run on record for a day
//               that decides it — enter it, and it is checked again
//   MY OFFERS   what I posted, who is interested, pick one, contact, arranged
//   INTERESTED  offers I said "I'm interested" in, and where they stand
//   + NEW OFFER one question per screen, big buttons
//
// The app only connects operators. Nothing here approves a swap; "arranged"
// always comes with the reminder that the dispatcher must approve it.
//
// The database is passed in (deps.store, default pa-swap-store.js) so the
// screens can be driven against a stand-in without Firebase.
// ==========================================================================

import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';
import * as E from './pa-edit-sheet.js';
import * as W from './pa-swap.js';
import * as U from './pa-swap-ui.js';
import * as realStore from './pa-swap-store.js';
import * as P from './pa-push.js';

const { el, button, field } = U;

export const PENDING_KEY = 'pa_swap_pending';
const MANUAL_PREFIX = 'pa_swap_manual_v1_';
const NAME_KEY = 'pa_swap_name';
const LOAD_MS = 15000;

const withTimeout = (p, ms = LOAD_MS) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms))]);

const errText = e => (e && e.code === 'timeout') ? 'No answer from the server. Check your signal and try again.'
  : (e && e.code === 'permission-denied') ? 'The server refused that (permission denied).'
  : 'Something went wrong. Try again.';

export function mount(root, deps) {
  const store = deps.store || realStore;
  const st = {
    view: 'board', district: '', districts: [], seasons: [], blocks: new Map(),
    interestedIds: new Set(), pending: null, wizard: null, token: 0
  };

  const user = () => deps.getUser();
  const profile = () => deps.getProfile() || {};
  const overrides = () => (deps.getOverrides && deps.getOverrides()) || {};
  const today = () => S.todayIso();
  const uid = () => (user() ? user().uid : null);

  // ---- the operator's own week ------------------------------------------

  const manualKey = () => MANUAL_PREFIX + uid();
  function manual() { try { return JSON.parse(localStorage.getItem(manualKey()) || '{}'); } catch (_) { return {}; } }
  function setManual(date, v) {
    const m = manual();
    if (v) m[date] = v; else delete m[date];
    // Keep only days still to come.
    Object.keys(m).forEach(d => { if (d < W.weekOf(today())) delete m[d]; });
    try { localStorage.setItem(manualKey(), JSON.stringify(m)); } catch (_) {}
  }

  function myName() {
    let saved = '';
    try { saved = localStorage.getItem(NAME_KEY) || ''; } catch (_) {}
    return saved || profile().displayName || (user() && user().displayName) || '';
  }
  function rememberName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} }

  async function lookupCard(date, runNo) {
    const { slug } = await E.slugForDate(profile().depotKey, date);
    if (!slug) return null;
    const run = await S.getRun(slug, S.dayTypeFor(date, overrides()), String(runNo).trim(), date);
    return run ? W.runCard(run, date) : null;
  }

  const bareCard = (date, runNo, dayType) => ({ date, dayType: dayType || '', runNo: String(runNo), routeLabel: '', routes: [],
    owl: false, reportMin: null, finishMin: null, payHours: 0, swing: false });

  /** { known, card, away, manual } for one date. */
  async function dayInfo(date) {
    const m = manual()[date];
    if (m) {
      if (m.off) return { known: true, card: null, manual: true };
      let c = null; try { c = await lookupCard(date, m.runNo); } catch (_) {}
      return { known: true, card: c || bareCard(date, m.runNo), manual: true };
    }
    const r = A.resolve(date, overrides());
    if (r.unregistered) return { known: false, card: null };
    if (r.status === 'vacation') return { known: true, card: null, away: true };
    if (r.off || !r.runNo) return { known: true, card: null };
    let run = null; try { run = await E.runFor(r, date, profile().depotKey); } catch (_) {}
    return { known: true, card: W.runCard(run, date) || bareCard(date, r.runNo, r.dayType) };
  }

  async function daysFor(dates) {
    const all = [...new Set(dates.flatMap(d => [S.addDays(d, -1), d, S.addDays(d, 1)]))];
    const infos = await Promise.all(all.map(d => dayInfo(d).catch(() => ({ known: false, card: null }))));
    return new Map(all.map((d, i) => [d, infos[i]]));
  }

  async function meFor(offers) {
    const days = await daysFor(offers.flatMap(W.offerDates));
    const myKey = await myDistrictKey();
    return {
      uid: uid(), depotKey: myKey,
      seasonFor: d => { const s = S.seasonFor(st.seasons, d); return s ? s.id : null; },
      day: d => days.get(d) || { known: false, card: null }
    };
  }

  async function myDistrictKey() {
    try { const r = await E.slugForDate(profile().depotKey, today()); if (r && r.slug) return S.depotKeyOf(r.slug); } catch (_) {}
    return profile().depotKey || '';
  }

  async function loadDistricts() {
    if (st.districts.length) return;
    st.seasons = await S.loadSeasons();
    const season = S.seasonFor(st.seasons, today());
    const list = season ? await S.loadManifest(season) : [];
    st.districts = list.map(d => ({ key: S.depotKeyOf(d.name), label: d.label }));
  }

  /** The board always shows the operator's own district, from their profile. */
  async function useMyDistrict() {
    const mine = await myDistrictKey();
    const hit = st.districts.find(d => W.sameDepot(d.key, mine));
    st.district = hit ? hit.key : mine;
    return hit ? hit.label : (profile().depotLabel || mine);
  }

  // ---- frame ---------------------------------------------------------------

  let counts = { mine: 0, interested: 0 };
  const segCounts = {};

  function drawCounts() {
    Object.entries(segCounts).forEach(([v, span]) => { const n = counts[v] || 0; span.hidden = !n; span.textContent = String(n); });
  }

  function frame() {
    root.innerHTML = '';
    const seg = el('div', 'sw-seg');
    [['board', 'BOARD'], ['mine', 'MY OFFERS'], ['interested', 'INTERESTED']].forEach(([v, t]) => {
      const b = button(st.view === v ? 'on' : '', t, () => go(v));
      if (v !== 'board') { segCounts[v] = el('span', 'n'); b.appendChild(segCounts[v]); }
      seg.appendChild(b);
    });
    drawCounts();
    root.appendChild(seg);
    const body = el('div');
    root.appendChild(body);
    return body;
  }

  function loading(body, text) { body.innerHTML = ''; body.appendChild(el('div', 'sw-empty', text || 'Loading…')); }
  function failed(body, e, retry) {
    body.innerHTML = '';
    const box = el('div', 'sw-empty', errText(e));
    const b = button('pa-ghost', 'Try again', retry); b.style.marginTop = '12px';
    box.appendChild(b);
    body.appendChild(box);
  }

  function go(v, opts = {}) {
    st.view = v;
    if (v !== 'new') st.wizard = null;
    const t = ++st.token;
    const live = () => t === st.token;
    if (v === 'board') return renderBoard(live, opts);
    if (v === 'mine') return renderMine(live);
    if (v === 'interested') return renderInterested(live);
    if (v === 'new') return renderWizard(opts.offer || null);
  }

  // ---- BOARD ---------------------------------------------------------------

  async function renderBoard(live) {
    const body = frame();
    const bar = el('div', 'sw-bar');
    body.appendChild(bar);
    const list = el('div');
    body.appendChild(list);
    loading(list, 'Loading offers…');
    let label;
    try {
      await withTimeout(loadDistricts());
      label = await withTimeout(useMyDistrict());
    } catch (e) { if (live()) failed(list, e, () => go('board')); return; }
    if (!live()) return;

    const where = el('div', 'sw-where');
    where.appendChild(el('span', 'k', 'Your district'));
    where.appendChild(el('b', null, label || '—'));
    bar.append(where, button('pa-submit', '+ New offer', () => go('new')));

    let offers, me, extra = null;
    try {
      const [o, blocks, interested] = await withTimeout(Promise.all([
        store.listBoard(st.district, today()),
        store.listBlocks(uid()).catch(() => new Map()),
        store.interestedOffers(uid()).catch(() => [])
      ]));
      offers = o; st.blocks = blocks;
      st.interestedIds = new Set(interested.map(r => r.offer.id));
      // The offer a guest tapped on the public board, carried through sign-up.
      if (st.pending && !offers.some(x => x.id === st.pending)) {
        extra = await store.getOffer(st.pending).catch(() => null);
      }
      me = await meFor(extra ? [extra, ...offers] : offers);
    } catch (e) { if (live()) failed(list, e, () => go('board')); return; }
    if (!live()) return;

    list.innerHTML = '';
    let opened = null;
    if (st.pending) {
      opened = extra || offers.find(x => x.id === st.pending) || null;
      try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
      st.pending = null;
    }
    if (opened) {
      list.appendChild(el('div', 'sw-sub', 'The offer you opened'));
      list.appendChild(offerCard(opened, me, true));
    }
    const shown = offers.filter(o => !st.blocks.has(o.posterUid) && (!opened || o.id !== opened.id));
    if (opened && shown.length) list.appendChild(el('div', 'sw-sub', 'All open offers'));
    if (!shown.length && !opened) {
      list.appendChild(el('div', 'sw-empty', 'No open offers in this district yet. Post one with + New offer.'));
    }
    shown.forEach(o => list.appendChild(offerCard(o, me, false)));
  }

  function offerCard(o, me, highlight) {
    const check = W.checkOffer(o, me, today());
    const actions = [];
    let card;
    const menu = check.color === 'mine' ? null : [
      ['Report', () => { const p = card.querySelector('.sw-panel'); if (p) p.remove(); card.appendChild(U.reportPanel(
        (reason, note) => store.reportOffer(o.id, uid(), reason, note), () => { const x = card.querySelector('.sw-panel'); if (x) x.remove(); })); }],
      ['Block ' + (o.posterName || 'poster'), async () => {
        if (!confirm('Hide every offer from ' + (o.posterName || 'this operator') + '? You can undo this in My Offers.')) return;
        await store.block(uid(), o.posterUid, o.posterName).catch(() => {});
        go('board');
      }]
    ];
    if (check.color === 'mine') {
      actions.push(button('pa-ghost', 'Manage', () => go('mine')));
    } else if (st.interestedIds.has(o.id)) {
      const b = button('pa-ghost', 'Interest sent ✓', () => go('interested'));
      actions.push(b);
    } else if (check.color === 'green') {
      actions.push(button('pa-submit', 'I’m interested', () => interestPanel(card, o, check)));
    } else if (check.color === 'yellow') {
      // The run entry below opens by itself; interest waits for the recheck.
      const b = button('pa-ghost', 'Check first'); b.disabled = true; actions.push(b);
    } else {
      const b = button('pa-ghost', 'Not eligible'); b.disabled = true; actions.push(b);
    }
    card = U.scorecard(o, check, { actions, menu, blocked: check.color === 'mine' ? blockedNames() : null });
    if (highlight) card.style.boxShadow = '0 0 0 1px rgba(245,166,35,.45)';
    if (check.color === 'yellow') manualPanel(card, check.needs);
    else if (check.color !== 'mine') entryLine(card, o);
    return card;
  }

  // Days of this offer the operator typed in by hand, as one line with a
  // way to change them. Without it a mistyped run could never be fixed.
  function entryLine(card, o) {
    const m = manual();
    const dates = [...new Set(W.offerDates(o).flatMap(d => [S.addDays(d, -1), d, S.addDays(d, 1)]))].filter(d => m[d]).sort();
    if (!dates.length) return;
    const line = el('div', 'sw-status');
    line.append('You entered: ' + dates.map(d => W.shortDay(d) + ' ' + (m[d].off ? 'off' : 'run ' + m[d].runNo)).join(', ') + ' ');
    line.appendChild(button('rowbtn', 'Change', () => { line.remove(); manualPanel(card, dates, true); }));
    card.appendChild(line);
  }

  // Yellow: ask which run they hold (or that they are off), then check again.
  // `editing` reopens days already entered, with a way back to the schedule.
  function manualPanel(card, needs, editing) {
    const old = card.querySelector('.sw-panel.manual');
    if (old) return;
    const m = manual();
    const p = el('div', 'sw-panel manual');
    p.appendChild(el('span', 'k', editing ? 'Change what you entered' : 'Your run that day'));
    p.appendChild(el('div', 'hint', editing
      ? 'Fix the run number, mark the day off, or clear it to go back to your schedule.'
      : 'Your schedule has nothing for ' + needs.map(W.longDay).join(' or ') + '. Enter the run you hold (or say you\'re off) and the offer is checked again. This stays on this phone and does not change your schedule.'));
    for (const d of needs) {
      const row = el('div', 'sw-row');
      const inp = field(row, W.longDay(d) + ' ' + W.fmtDay(d).slice(4) + ' run #', { inputmode: 'numeric', maxlength: '8', placeholder: 'e.g. 209', value: (m[d] && m[d].runNo) || '' });
      const msg = el('div', 'msgline');
      row.appendChild(button('pa-ghost', 'Check', async () => {
        const v = inp.value.trim();
        if (!v) { msg.className = 'msgline err'; msg.textContent = 'Enter a run number.'; return; }
        msg.className = 'msgline'; msg.textContent = 'Looking it up…';
        let c = null; try { c = await lookupCard(d, v); } catch (_) {}
        if (!c) { msg.className = 'msgline err'; msg.textContent = 'Run ' + v + ' is not in the ' + W.longDay(d) + ' paddle for your district.'; return; }
        setManual(d, { runNo: v });
        go(st.view);
      }));
      row.appendChild(button('pa-ghost', 'I\'m off', () => { setManual(d, { off: true }); go(st.view); }));
      if (m[d]) row.appendChild(button('pa-ghost', 'Clear', () => { setManual(d, null); go(st.view); }));
      p.append(row, msg);
    }
    if (editing) {
      const acts = el('div', 'sw-acts');
      acts.appendChild(button('pa-ghost', 'Close', () => go(st.view)));
      p.appendChild(acts);
    }
    card.appendChild(p);
  }

  function interestPanel(card, o, check) {
    const old = card.querySelector('.sw-panel');
    if (old) { old.remove(); return; }
    const p = el('div', 'sw-panel');
    const mine = check.myCard;
    const w = o.wants[check.want];
    p.appendChild(el('span', 'k', 'The swap'));
    const line = el('div', 'sw-pick');
    line.innerHTML = '';
    line.append('You take ', strong('run ' + o.give.runNo), ' on ' + W.longDay(o.give.date) + '. ');
    line.append((o.posterName || 'The poster') + ' takes your ', strong('run ' + mine.runNo),
      ' on ' + W.longDay(w.type === 'day' ? w.date : o.give.date)
      + (mine.reportMin != null ? ' (' + S.fmtClock(mine.reportMin) + '–' + S.fmtClock(mine.finishMin) + ')' : '') + '.');
    p.appendChild(line);
    const name = field(p, 'Your name on the board', { maxlength: '60', value: myName(), autocomplete: 'name' });
    const contact = U.contactFields(p, realStore.lastContact(), 'How should ' + (o.posterName || 'the poster') + ' reach you?');
    const note = field(p, 'Message (optional)', { maxlength: '140' });
    const msg = el('div', 'msgline');
    const acts = el('div', 'sw-acts');
    const send = button('pa-submit', 'Send interest', async () => {
      const c = contact.value(), n = name.value.trim();
      if (!n) { msg.className = 'msgline err'; msg.textContent = 'Enter the name to show the poster.'; return; }
      if (!c.phone && !c.email) { msg.className = 'msgline err'; msg.textContent = 'Leave a phone number or an email, so they can reach you if they pick you.'; return; }
      send.disabled = true; msg.className = 'msgline'; msg.textContent = 'Sending…';
      try {
        await withTimeout(store.saveContact(o.id, uid(), { name: n, ...c }));
        await withTimeout(store.expressInterest(o.id, uid(), {
          name: n, run: mine, wantIndex: check.want, color: 'green', reason: check.reason || '', note: note.value.trim().slice(0, 140)
        }));
        rememberName(n); realStore.rememberContact(c);
        msg.className = 'msgline ok'; msg.textContent = 'Sent. ' + (o.posterName || 'The poster') + ' will see it and can pick you.';
        st.interestedIds.add(o.id);
        setTimeout(() => go('interested'), 900);
      } catch (e) { send.disabled = false; msg.className = 'msgline err'; msg.textContent = errText(e); }
    });
    acts.append(send, button('pa-ghost', 'Cancel', () => p.remove()));
    p.append(acts, msg);
    card.appendChild(p);
  }

  const strong = t => el('b', null, t);

  // ---- MY OFFERS -----------------------------------------------------------

  async function renderMine(live) {
    const body = frame();
    const top = el('div', 'sw-bar');
    top.appendChild(button('pa-submit', '+ New offer', () => go('new')));
    body.appendChild(top);
    pushLine(body);
    const list = el('div');
    body.appendChild(list);
    loading(list, 'Loading your offers…');
    let rows;
    try {
      const [offers, blocks] = await withTimeout(Promise.all([store.myOffers(uid()), store.listBlocks(uid()).catch(() => new Map())]));
      st.blocks = blocks;
      rows = await withTimeout(Promise.all(offers.map(async o => ({
        o,
        interest: ['open', 'matched', 'arranged'].includes(o.status) ? await store.listInterest(o.id).catch(() => []) : [],
        contact: ['matched', 'arranged'].includes(o.status) && o.matchedUid ? await store.readContact(o.id, o.matchedUid) : null
      }))));
    } catch (e) { if (live()) failed(list, e, () => go('mine')); return; }
    if (!live()) return;
    list.innerHTML = '';
    const t = today();
    const current = rows.filter(r => !W.isExpired(r.o, t) || r.o.status === 'arranged');
    if (!current.length) list.appendChild(el('div', 'sw-empty', 'You have no offers. Tap + New offer to post one.'));
    current.forEach(r => list.appendChild(mineCard(r)));
    blocksSection(list);
    setCounts({ mine: rows.reduce((n, r) => n + (r.o.status === 'open' ? r.interest.filter(i => !st.blocks.has(i.uid)).length : 0), 0) });
  }

  function mineCard({ o, interest, contact }) {
    const actions = [];
    const st_ = o.status;
    if (st_ === 'open') {
      actions.push(button('pa-ghost', 'Edit', () => go('new', { offer: o })));
      actions.push(button('pa-ghost pa-danger', 'Cancel', async () => {
        if (!confirm('Cancel this offer? It comes off the board.')) return;
        await store.cancelOffer(o.id).catch(e => alert(errText(e))); go('mine');
      }));
    } else if (st_ === 'cancelled' || st_ === 'hidden') {
      actions.push(button('pa-ghost', 'Delete', async () => { await store.deleteOffer(o.id).catch(e => alert(errText(e))); go('mine'); }));
    }
    const card = U.scorecard(o, { color: 'mine', reason: '' }, { actions, blocked: blockedNames() });
    const box = el('div', 'sw-status');
    if (st_ === 'hidden') box.textContent = 'Hidden after reports from other operators. An admin will review it.';
    if (st_ === 'cancelled') box.textContent = 'Cancelled.';
    card.appendChild(box);

    if (st_ === 'open') {
      const people = interest.filter(i => !st.blocks.has(i.uid));
      box.textContent = people.length ? people.length + ' interested. Pick one to share contact details.' : 'On the board. Nobody interested yet.';
      people.forEach(i => card.appendChild(interestRow(o, i)));
    }
    if (st_ === 'matched' || st_ === 'arranged') {
      box.innerHTML = '';
      box.append(st_ === 'matched' ? 'Talking with ' : 'Arranged with ', strong(o.matchedName || 'operator'), '. ');
      const mi = interest.find(i => i.uid === o.matchedUid);
      if (mi && mi.run) box.append('They give run ' + mi.run.runNo + ' on ' + W.longDay(mi.run.date) + '. ');
      box.appendChild(U.contactLine(contact));
      card.appendChild(remind());
      const acts = el('div', 'sw-acts');
      if (st_ === 'matched') {
        acts.appendChild(button('pa-submit', 'Mark arranged', () => arrangedConfirm(card, o)));
        acts.appendChild(button('pa-ghost', 'Back to board', async () => {
          if (!confirm('Stop talking with ' + (o.matchedName || 'them') + ' and put the offer back on the board?')) return;
          await store.unpick(o.id).catch(e => alert(errText(e))); go('mine');
        }));
      }
      acts.appendChild(button('pa-ghost', 'Delete', async () => {
        if (!confirm('Delete this offer from your list?')) return;
        await store.deleteOffer(o.id).catch(e => alert(errText(e))); go('mine');
      }));
      card.appendChild(acts);
    }
    return card;
  }

  function interestRow(o, i) {
    const row = el('div', 'sw-int');
    row.appendChild(el('span', 'sw-dot ' + (i.color || '')));
    const who = el('div');
    who.appendChild(el('span', 'who', i.name || 'Operator'));
    const r = i.run;
    who.appendChild(el('small', null, r
      ? 'Gives ' + W.shortDay(r.date) + ' run ' + r.runNo + (r.routeLabel ? ' · ' + r.routeLabel : '')
        + (r.reportMin != null ? ' · ' + S.fmtClock(r.reportMin) + '–' + S.fmtClock(r.finishMin) : '') + (r.payHours ? ' · ' + r.payHours.toFixed(2) + ' h' : '')
      : 'No run given'));
    if (i.note) who.appendChild(el('small', null, '“' + i.note + '”'));
    row.appendChild(who);
    const acts = el('div', 'sw-acts'); acts.style.marginTop = '0';
    acts.appendChild(button('rowbtn', 'Pick', () => pickPanel(row, o, i)));
    acts.appendChild(button('rowbtn rm', 'Dismiss', async () => { await store.dismissInterest(o.id, i.uid).catch(() => {}); go('mine'); }));
    acts.appendChild(button('rowbtn rm', 'Block', async () => {
      if (!confirm('Block ' + (i.name || 'this operator') + '? Their interest and offers will be hidden from you.')) return;
      await store.block(uid(), i.uid, i.name).catch(() => {}); go('mine');
    }));
    row.appendChild(acts);
    return row;
  }

  function pickPanel(row, o, i) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('sw-panel')) { next.remove(); return; }
    const p = el('div', 'sw-panel');
    p.appendChild(el('div', 'hint', 'Picking ' + (i.name || 'them') + ' takes the offer off the board and shares contact details between just the two of you.'));
    const name = field(p, 'Your name', { maxlength: '60', value: myName() });
    const contact = U.contactFields(p, realStore.lastContact(), 'How should ' + (i.name || 'they') + ' reach you?');
    const msg = el('div', 'msgline');
    const acts = el('div', 'sw-acts');
    const ok = button('pa-submit', 'Pick ' + (i.name || 'them'), async () => {
      const c = contact.value();
      if (!c.phone && !c.email) { msg.className = 'msgline err'; msg.textContent = 'Leave a phone number or an email.'; return; }
      ok.disabled = true;
      try {
        await withTimeout(store.saveContact(o.id, uid(), { name: name.value.trim() || myName(), ...c }));
        await withTimeout(store.pickInterested(o.id, { uid: i.uid, name: i.name || 'Operator' }));
        realStore.rememberContact(c); rememberName(name.value.trim());
        go('mine');
      } catch (e) { ok.disabled = false; msg.className = 'msgline err'; msg.textContent = errText(e); }
    });
    acts.append(ok, button('pa-ghost', 'Cancel', () => p.remove()));
    p.append(acts, msg);
    row.after(p);
  }

  const remind = () => el('div', 'sw-remind', W.DISPATCH_REMINDER);

  // The operators this poster blocked: shown on their own offers only, since
  // a block is private.
  const blockedNames = () => [...st.blocks.values()].map(n => n || 'an operator');

  function arrangedConfirm(card, o) {
    const old = card.querySelector('.sw-panel.arr');
    if (old) { old.remove(); return; }
    const p = el('div', 'sw-panel arr');
    p.appendChild(el('div', 'sw-remind', 'Have you both agreed? ' + W.DISPATCH_REMINDER + ' Go to the dispatcher together, or as your depot requires.'));
    const acts = el('div', 'sw-acts');
    acts.append(button('pa-submit', 'Yes, mark arranged', async () => {
      try { await withTimeout(store.markArranged(o.id, uid())); go(st.view); } catch (e) { alert(errText(e)); }
    }), button('pa-ghost', 'Not yet', () => p.remove()));
    p.appendChild(acts);
    card.appendChild(p);
  }

  function blocksSection(list) {
    if (!st.blocks.size) return;
    const box = el('div', 'card sect');
    box.appendChild(el('h2', 'k', 'Blocked'));
    st.blocks.forEach((name, other) => {
      const r = el('div', 'win');
      r.appendChild(el('div', 'win-d', name || 'Operator'));
      r.appendChild(button('rowbtn', 'Unblock', async () => { await store.unblock(uid(), other).catch(() => {}); go(st.view); }));
      box.appendChild(r);
    });
    list.appendChild(box);
  }

  // Swap alerts go to the phones registered for push (pa-push.js), the same
  // registration as the alert before a run.
  function pushLine(body) {
    if (P.registeredHere(uid())) return;
    const line = el('div', 'hint');
    line.style.margin = '0 0 12px';
    if (!P.pushConfigured()) {
      line.textContent = 'Phone alerts are not switched on for this app yet. Check this tab for new interest.';
      body.appendChild(line);
      return;
    }
    const b = button('pa-ghost', 'Get swap alerts on this phone', async () => {
      b.disabled = true;
      const r = await P.registerPush(uid());
      if (r.ok) { line.textContent = 'Phone alerts are on for this phone.'; b.remove(); }
      else { b.disabled = false; line.textContent = P.pushProblem(r.reason); }
    });
    body.append(b, line);
  }

  // ---- INTERESTED ----------------------------------------------------------

  async function renderInterested(live) {
    const body = frame();
    const list = el('div');
    body.appendChild(list);
    loading(list, 'Loading…');
    let rows;
    try {
      rows = await withTimeout(store.interestedOffers(uid()));
      rows = await withTimeout(Promise.all(rows.map(async r => ({
        ...r,
        contact: ['matched', 'arranged'].includes(r.offer.status) && r.offer.matchedUid === uid()
          ? await store.readContact(r.offer.id, r.offer.posterUid) : null
      }))));
    } catch (e) { if (live()) failed(list, e, () => go('interested')); return; }
    if (!live()) return;
    list.innerHTML = '';
    st.interestedIds = new Set(rows.map(r => r.offer.id));
    const t = today();
    const current = rows.filter(r => !W.isExpired(r.offer, t) || r.offer.status === 'arranged');
    if (!current.length) list.appendChild(el('div', 'sw-empty', 'You have not said "I\'m interested" to any offer. Find one on the BOARD.'));
    current.forEach(r => list.appendChild(interestedCard(r)));
    setCounts({ interested: rows.filter(r => r.offer.status === 'matched' && r.offer.matchedUid === uid()).length });
  }

  function interestedCard({ offer: o, interest: i, contact }) {
    const me = uid();
    const pickedMe = o.matchedUid === me;
    const actions = [];
    const withdraw = button('pa-ghost', o.status === 'open' ? 'Withdraw' : 'Remove', async () => {
      await store.withdrawInterest(o.id, me).catch(() => {}); go('interested');
    });
    if (!(pickedMe && (o.status === 'matched' || o.status === 'arranged'))) actions.push(withdraw);
    const color = pickedMe ? 'green' : o.status === 'open' ? (i.color || 'yellow') : 'red';
    const card = U.scorecard(o, { color, reason: '' }, { actions });
    const box = el('div', 'sw-status');
    const poster = o.posterName || 'The poster';
    if (o.status === 'open') box.append('Waiting for ', strong(poster), ' to pick. ' + (i.run ? 'You offered run ' + i.run.runNo + ' on ' + W.longDay(i.run.date) + '.' : ''));
    else if (o.status === 'cancelled') box.textContent = poster + ' cancelled this offer.';
    else if (!pickedMe) box.textContent = poster + ' picked someone else.';
    else {
      if (o.status === 'arranged') box.append(o.arrangedBy === me ? 'You marked this arranged with ' : '', strong(poster), o.arrangedBy === me ? '. ' : ' marked this arranged. ');
      else box.append(strong(poster), ' picked you. Reach them: ');
      box.appendChild(U.contactLine(contact));
    }
    card.appendChild(box);
    if (pickedMe && (o.status === 'matched' || o.status === 'arranged')) {
      card.appendChild(remind());
      if (o.status === 'matched') {
        const acts = el('div', 'sw-acts');
        acts.appendChild(button('pa-submit', 'Mark arranged', () => arrangedConfirm(card, o)));
        card.appendChild(acts);
      }
    }
    return card;
  }

  // ---- NEW OFFER (and edit) ------------------------------------------------
  //
  // One question per screen, answered with big buttons, so it works with a
  // thumb between trips:
  //   day      which day of this week to swap (today only while its run is
  //            more than two hours away, W.CUTOFF_MIN)
  //   run      only when that day has no run on file: add it by run number
  //   same     same day or a different day
  //   wantday  only for a different day: which of my off days I'd work
  //   time     the hours I'd work (start no earlier than, finish by)
  //   routes   routes I won't take, night liners included
  //   review   the offer as the board will show it, then post
  // Back keeps every answer.

  const START_OPTS = [['', 'Any time']];
  for (let m = 180; m <= 1410; m += 30) START_OPTS.push([String(m), S.fmtClock(m)]);
  const FINISH_OPTS = [['', 'Any time']];
  for (let m = 360; m <= 1620; m += 30) FINISH_OPTS.push([String(m), S.fmtClock(m) + (m >= 1440 ? ' (next day)' : '')]);

  function renderWizard(offer) {
    const ws = W.weekOf(today());
    const blank = { step: 'day', weekStart: ws, date: null, give: null, needRun: false, same: null, wantDates: [],
      prefs: { flexible: false, excludeRoutes: [], earliestMin: null, latestMin: null, note: '' }, days: null, routes: null, adding: false };
    const w = st.wizard = offer ? {
      ...blank, id: offer.id,
      date: offer.give.date >= today() && W.weekOf(offer.give.date) === ws ? offer.give.date : null,
      give: offer.give,
      same: offer.wants.some(x => x.type === 'same' || x.type === 'shift') ? true : offer.wants.length ? false : null,
      wantDates: offer.wants.filter(x => x.type === 'day').map(x => x.date),
      prefs: { ...blank.prefs, ...offer.prefs, excludeRoutes: [...(offer.prefs.excludeRoutes || [])] }
    } : blank;
    if (!w.date) w.give = null;
    drawStep();
  }

  const stepsOf = w => ['day', ...(w.needRun ? ['run'] : []), 'same', ...(w.same === false ? ['wantday'] : []), 'time', 'routes', 'review'];

  // Days I could work someone's run in return: this week, not past, not the
  // day I give, and not a day I already work or am away.
  function wantableDays(w) {
    return W.weekDates(w.weekStart).filter(d => {
      if (d === w.date || d < today()) return false;
      const info = w.days.get(d) || {};
      return !info.card && !info.away;
    });
  }

  const runLine = c => 'Run ' + c.runNo + (c.routeLabel ? ' · ' + c.routeLabel : '')
    + (c.reportMin != null ? ' · ' + S.fmtClock(c.reportMin) + '–' + S.fmtClock(c.finishMin) : '')
    + (c.payHours ? ' · ' + c.payHours.toFixed(2) + ' h' : '');

  function bigButton(title, sub, onClick, cls = '') {
    const b = button('sw-bb ' + cls, null, onClick);
    b.appendChild(el('span', 't', title));
    if (sub) b.appendChild(el('span', 's', sub));
    return b;
  }

  function drawStep() {
    const w = st.wizard;
    const steps = stepsOf(w);
    if (!steps.includes(w.step)) w.step = 'day';
    const idx = steps.indexOf(w.step);
    const goTo = name => { w.step = name; w.adding = false; drawStep(); };
    const nextStep = () => { const s = stepsOf(w); goTo(s[s.indexOf(w.step) + 1]); };

    const body = frame();
    const wz = el('div', 'sw-wz');
    body.appendChild(wz);
    const prog = el('div', 'sw-prog');
    prog.appendChild(el('span', null, (w.id ? 'Edit offer' : 'New offer') + ' · Step ' + (idx + 1) + ' of ' + steps.length));
    const bar = el('div', 'bar');
    steps.forEach((_, i) => bar.appendChild(el('i', i <= idx ? 'on' : '')));
    prog.appendChild(bar);
    const q = el('div', 'sw-bq');
    const content = el('div', 'sw-bbody');
    const msg = el('div', 'sw-bmsg');
    const nav = el('div', 'sw-bnav');
    wz.append(prog, q, msg, content, nav);
    const fail = t => { msg.className = 'sw-bmsg err'; msg.textContent = t; };
    const say = t => { msg.className = 'sw-bmsg'; msg.textContent = t; };

    const back = button('sw-bnb', idx === 0 ? 'Cancel' : '‹ Back', () => {
      if (idx === 0) { st.wizard = null; go(w.id ? 'mine' : 'board'); } else goTo(steps[idx - 1]);
    });
    const next = button('sw-bnb go', w.step === 'review' ? (w.id ? 'Save changes' : 'Confirm & post') : 'Next ›');
    nav.append(back, next);

    // ---- which day
    if (w.step === 'day') {
      q.textContent = 'Which day do you want to swap?';
      if (!w.days) {
        say('Loading your week…');
        daysFor(W.weekDates(w.weekStart)).then(m => { w.days = m; if (st.wizard === w && w.step === 'day') drawStep(); })
          .catch(() => fail('Could not load your schedule. Check your signal and try again.'));
      }
      const nowMs = Date.now();
      W.weekDates(w.weekStart).forEach(d => {
        const info = w.days && w.days.get(d);
        const past = d < today();
        const late = !past && !!info && !!info.card && W.runInCutoff(info.card, nowMs);
        const sub = past ? 'Past' : !info ? '…' : late ? (W.startsAtOf(info.card) <= nowMs ? 'Already started' : 'Starts within 2 hours')
          : info.card ? runLine(info.card) : info.away ? 'Vacation · no run on file' : info.known ? 'Off · no run on file' : 'No run on file';
        const b = bigButton(W.longDay(d) + ' ' + W.fmtDay(d).slice(4) + (d === today() ? ' · today' : ''), sub, () => {
          if (late) return fail(d === today() ? W.CUTOFF_TEXT : 'You can\'t post a swap within two hours of the run\'s start time.');
          if (d !== w.date) {
            w.date = d;
            w.give = info.card || null;
            w.needRun = !info.card;
            w.wantDates = w.wantDates.filter(x => x !== d);
            w.routes = null;
          }
          nextStep();
        }, (d === w.date ? 'on' : '') + (late ? ' off' : ''));
        b.disabled = past || !info;
        content.appendChild(b);
      });
      next.disabled = !w.date || !w.days;
      next.addEventListener('click', () => nextStep());
      return;
    }

    // ---- no run on file: add it by number
    if (w.step === 'run') {
      const day = W.longDay(w.date);
      if (w.give && !w.adding) {
        q.textContent = 'Your run on ' + day;
        content.appendChild(el('div', 'sw-bcard', runLine(w.give)));
        content.appendChild(bigButton('Change run number', null, () => { w.adding = true; drawStep(); }));
        next.addEventListener('click', () => nextStep());
        return;
      }
      if (!w.adding) {
        q.textContent = 'You don\'t have a run on file for ' + day + '. Add one now?';
        content.appendChild(bigButton('Yes, add my run', 'Just the run number', () => { w.adding = true; drawStep(); }));
        content.appendChild(bigButton('No, pick another day', null, () => goTo('day')));
        next.hidden = true;
        return;
      }
      q.textContent = 'Your run number for ' + day + '?';
      const inp = el('input', 'sw-binput');
      Object.assign(inp, { type: 'text', inputMode: 'numeric', maxLength: 8, placeholder: 'e.g. 209', autocomplete: 'off' });
      content.appendChild(inp);
      content.appendChild(el('div', 'sw-bhint', 'Route, times, hours and pay come from the paddle. This stays on this phone and does not change your schedule.'));
      const look = async () => {
        const v = inp.value.trim();
        if (!v) return fail('Enter a run number.');
        next.disabled = true; say('Looking it up…');
        let c = null; try { c = await lookupCard(w.date, v); } catch (_) {}
        next.disabled = false;
        if (st.wizard !== w) return;
        if (!c) return fail('Run ' + v + ' is not in the ' + day + ' paddle for your district.');
        if (W.runInCutoff(c, Date.now())) return fail(W.CUTOFF_TEXT);
        setManual(w.date, { runNo: v });
        w.days.set(w.date, { known: true, card: c, manual: true });
        w.give = c; w.adding = false;
        drawStep();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') look(); });
      next.textContent = 'Look up ›';
      next.addEventListener('click', look);
      setTimeout(() => inp.focus(), 0);
      return;
    }

    // ---- same day or a different day
    if (w.step === 'same') {
      q.textContent = 'Swap for the same day or a different day?';
      content.appendChild(bigButton('Same day', 'Another run on ' + W.longDay(w.date), () => { w.same = true; nextStep(); }, w.same === true ? 'on' : ''));
      content.appendChild(bigButton('Different day', 'Work someone\'s run on a day you\'re off this week', () => { w.same = false; nextStep(); }, w.same === false ? 'on' : ''));
      next.disabled = w.same == null;
      next.addEventListener('click', () => nextStep());
      return;
    }

    // ---- which day to work instead
    if (w.step === 'wantday') {
      q.textContent = 'Which day do you want to work instead?';
      const days = wantableDays(w);
      w.wantDates = w.wantDates.filter(d => days.includes(d));
      if (!days.length) {
        content.appendChild(el('div', 'sw-bcard', 'You work every other day left this week, so there is no day to trade into. Go back and choose Same day.'));
        next.disabled = true;
        return;
      }
      const toggle = d => { w.wantDates = w.wantDates.includes(d) ? w.wantDates.filter(x => x !== d) : [...w.wantDates, d]; drawStep(); };
      days.forEach(d => {
        const info = w.days.get(d) || {};
        content.appendChild(bigButton(W.longDay(d) + ' ' + W.fmtDay(d).slice(4), info.known ? 'You\'re off' : 'No run on file',
          () => toggle(d), w.wantDates.includes(d) ? 'on' : ''));
      });
      if (days.length > 1) {
        const all = days.every(d => w.wantDates.includes(d));
        content.appendChild(bigButton(days.length === 2 ? 'Both' : 'Any of these', null, () => {
          w.wantDates = all ? [] : [...days]; drawStep();
        }, 'all' + (all ? ' on' : '')));
      }
      content.appendChild(el('div', 'sw-bhint', 'Tap one day, or more than one.'));
      next.addEventListener('click', () => { if (!w.wantDates.length) return fail('Tap at least one day.'); nextStep(); });
      return;
    }

    // ---- the hours
    if (w.step === 'time') {
      q.textContent = 'What hours do you want to work?';
      // 8 hours' rest from my own runs the day before and the day after: the
      // pickers start there, and nothing tighter is offered.
      const lim = W.restWindow(d => w.days.get(d), w.same ? [w.date] : w.wantDates, w.date);
      if (lim.earliestMin != null && !(w.prefs.earliestMin >= lim.earliestMin)) w.prefs.earliestMin = lim.earliestMin;
      if (lim.latestMin != null && !(w.prefs.latestMin != null && w.prefs.latestMin <= lim.latestMin)) w.prefs.latestMin = lim.latestMin;
      const clock = m => S.fmtClock(m) + (m >= 1440 ? ' (next day)' : '');
      const within = (opts, m, keep) => {
        if (m == null) return opts;
        const list = opts.filter(([v]) => v !== '' && keep(+v));
        if (!list.some(([v]) => +v === m)) list.push([String(m), clock(m)]);
        return list.sort((a, b) => +a[0] - +b[0]);
      };
      const pick = (label, opts, key, hint) => {
        const wrap = el('label', 'sw-bsel');
        wrap.appendChild(el('span', null, label));
        const s = el('select');
        opts.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; s.appendChild(o); });
        s.value = w.prefs[key] != null ? String(w.prefs[key]) : '';
        s.addEventListener('change', () => { w.prefs[key] = s.value === '' ? null : +s.value; msg.textContent = ''; });
        wrap.appendChild(s);
        if (hint) wrap.appendChild(el('div', 'sw-bhint', hint));
        content.appendChild(wrap);
      };
      const restHint = (c, word) => '8 hours ' + word + ' your ' + W.longDay(c.date) + ' run ' + c.runNo
        + ' (' + (word === 'after' ? 'finishes ' + S.fmtClock(c.finishMin) : 'starts ' + S.fmtClock(c.reportMin)) + ')';
      pick('Start no earlier than', within(START_OPTS, lim.earliestMin, m => m >= lim.earliestMin), 'earliestMin',
        lim.after && restHint(lim.after, 'after'));
      pick('Finish by', within(FINISH_OPTS, lim.latestMin, m => m <= lim.latestMin), 'latestMin',
        lim.before && restHint(lim.before, 'before'));
      if (lim.earliestMin != null && lim.latestMin != null && lim.latestMin <= lim.earliestMin) {
        fail('With 8 hours\' rest around your own runs there is no time left to work that day.');
      }
      next.addEventListener('click', () => {
        const { earliestMin: a, latestMin: b } = w.prefs;
        if (a != null && b != null && b <= a) return fail('The finish time has to be after the start time.');
        nextStep();
      });
      return;
    }

    // ---- routes to leave out
    if (w.step === 'routes') {
      q.textContent = 'Any routes you won\'t drive?';
      const grid = el('div', 'sw-bgrid');
      content.appendChild(grid);
      const skip = button('sw-bnb', 'Skip · none', () => { w.prefs.excludeRoutes = []; nextStep(); });
      const drawNext = () => { skip.hidden = w.prefs.excludeRoutes.length > 0; next.hidden = !w.prefs.excludeRoutes.length; };
      const draw = () => {
        grid.innerHTML = '';
        if (!w.routes) { grid.appendChild(el('div', 'sw-bhint', 'Loading routes…')); return; }
        [...w.routes, W.OWL].forEach(r => {
          const on = w.prefs.excludeRoutes.includes(r);
          grid.appendChild(button('sw-bb sq' + (on ? ' on' : '') + (r === W.OWL ? ' wide' : ''), r === W.OWL ? 'Night liners' : r, () => {
            w.prefs.excludeRoutes = on ? w.prefs.excludeRoutes.filter(x => x !== r) : [...w.prefs.excludeRoutes, r];
            draw(); drawNext();
          }));
        });
      };
      draw();
      if (!w.routes) districtRoutes(w.date).then(r => { w.routes = r; }).catch(() => { w.routes = []; })
        .then(() => { if (st.wizard === w && w.step === 'routes') draw(); });
      content.appendChild(el('div', 'sw-bhint', 'Tap every route you won\'t take.'));
      nav.insertBefore(skip, next);
      drawNext();
      next.addEventListener('click', () => nextStep());
      return;
    }

    // ---- review and post
    q.textContent = 'Ready to post?';
    const wants = w.same ? [{ type: 'same' }] : w.wantDates.slice().sort().map(d => ({ type: 'day', date: d }));
    const poster = { day: d => (w.days && w.days.get(d)) || { known: false, card: null } };
    const build = () => W.buildOffer({ kind: 'give', give: w.give, wants, prefs: { ...w.prefs, flexible: false } }, poster, today(), Date.now());
    const built = build();
    if (built.error) { fail(built.error); next.disabled = true; return; }
    const preview = { ...built.doc, id: w.id || '', status: 'open', posterName: myName() || 'You',
      depotKey: profile().depotKey || '', depotLabel: profile().depotLabel || '' };
    content.appendChild(U.scorecard(preview, { color: 'mine', reason: '' }, { actions: [] }));
    const nameWrap = el('label', 'sw-bsel');
    nameWrap.appendChild(el('span', null, 'Your name on the board'));
    const name = el('input', 'sw-binput');
    Object.assign(name, { type: 'text', maxLength: 60, value: myName(), autocomplete: 'name' });
    nameWrap.appendChild(name);
    content.appendChild(nameWrap);
    content.appendChild(el('div', 'sw-bhint', 'Only this name is shown. Phone or email is shared later, only with the one person you pick.'));
    content.appendChild(remind());

    next.addEventListener('click', async () => {
      const posterName = name.value.trim();
      if (!posterName) return fail('Enter the name to show on the board.');
      const again = build();
      if (again.error) return fail(again.error);
      next.disabled = true; say('Posting…');
      try {
        const info = await E.slugForDate(profile().depotKey, w.give.date);
        if (!info || !info.season) throw Object.assign(new Error('no season'), { code: 'no-season' });
        const fields = {
          ...again.doc,
          posterUid: uid(), posterName,
          depotKey: info.slug ? S.depotKeyOf(info.slug) : profile().depotKey,
          depotLabel: (info.district && info.district.label) || profile().depotLabel || profile().depotKey,
          seasonId: info.season.id, seasonLabel: info.season.label
        };
        rememberName(posterName);
        if (w.id) await withTimeout(store.editOffer(w.id, fields)); else await withTimeout(store.createOffer(fields));
        st.wizard = null;
        go('mine');
      } catch (e) {
        next.disabled = false;
        fail(e && e.code === 'no-season' ? 'This week is not in a picking the app knows yet.' : errText(e));
      }
    });
  }

  const routeCache = new Map();
  async function districtRoutes(date) {
    const { slug } = await E.slugForDate(profile().depotKey, date);
    if (!slug) return [];
    if (!routeCache.has(slug)) {
      routeCache.set(slug, Promise.all(['weekday', 'saturday', 'sunday'].map(dt => S.loadPaddle(slug, dt).catch(() => new Map())))
        .then(maps => {
          const set = new Set();
          maps.forEach(m => m.forEach(row => { for (let i = 1; i <= 10; i++) if (row['r' + i]) S.routesOfLabel(row['r' + i]).forEach(r => set.add(r)); }));
          return [...set].filter(r => /^[A-Z0-9]{1,4}$/i.test(r) && r.toLowerCase() !== 'r1')
            .sort((a, b) => (parseInt(a, 10) || 999) - (parseInt(b, 10) || 999) || a.localeCompare(b));
        }));
    }
    return routeCache.get(slug);
  }

  // ---- counts for the tab badge -------------------------------------------

  function setCounts(c) {
    counts = { ...counts, ...c };
    drawCounts();
    if (deps.onBadge) deps.onBadge(counts.mine + counts.interested);
  }

  /** Cheap-ish refresh of the badge without drawing anything. */
  async function refreshBadge() {
    if (!uid()) return;
    try {
      const [offers, mine, blocks] = await withTimeout(Promise.all([
        store.interestedOffers(uid()), store.myOffers(uid()), store.listBlocks(uid()).catch(() => new Map())]));
      const open = mine.filter(o => o.status === 'open' && !W.isExpired(o, today()));
      const lists = await Promise.all(open.map(o => store.listInterest(o.id).catch(() => [])));
      setCounts({
        mine: lists.reduce((n, l) => n + l.filter(i => !blocks.has(i.uid)).length, 0),
        interested: offers.filter(r => r.offer.status === 'matched' && r.offer.matchedUid === uid()).length
      });
    } catch (_) { /* the badge is a nicety */ }
  }

  return {
    state: st,
    /** Open the tab. params: { offer: id, new: bool } from the URL or the board. */
    show(params = {}) {
      let pending = params.offer || null;
      if (!pending) { try { pending = localStorage.getItem(PENDING_KEY); } catch (_) {} }
      if (pending) st.pending = pending;
      if (params.new) return go('new');
      if (st.view === 'new' && st.wizard) return drawStep();
      return go(st.pending ? 'board' : st.view);
    },
    refreshBadge,
    reset() { st.view = 'board'; st.wizard = null; st.pending = null; st.districts = []; st.district = ''; counts = { mine: 0, interested: 0 }; root.innerHTML = ''; }
  };
}
