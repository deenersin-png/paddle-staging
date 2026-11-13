// ==========================================================================
// Paddle App — swap scorecards and small form pieces.
//
// Shared by the public board (swap.html) and the SWAP tab (pa-swap-tab.js),
// so an offer looks the same everywhere: the swap details (the day, what the
// poster wants in return, their conditions) on top of the Paddle App's own
// run scorecard. DOM only; no Firebase.
// ==========================================================================

import { slugFor, getRun, paddleLinkFor } from './pa-schedule.js';
import * as W from './pa-swap.js';
import * as RC from './pa-run-card.js';

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function button(cls, text, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** A labelled input in the account form style. */
export function field(parent, label, attrs = {}) {
  const wrap = el('div', 'pa-field');
  wrap.appendChild(el('label', 'pa-label', label));
  const i = el(attrs.tag === 'select' ? 'select' : 'input', attrs.tag === 'select' ? 'pa-select' : 'pa-input');
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'tag' || k === 'options') return;
    if (k === 'value') i.value = v; else i.setAttribute(k, v);
  });
  (attrs.options || []).forEach(([v, t]) => { const o = el('option', null, t); o.value = v; i.appendChild(o); });
  if (attrs.tag === 'select' && attrs.value != null) i.value = attrs.value;
  wrap.appendChild(i);
  parent.appendChild(wrap);
  return i;
}

const BADGE = { green: 'FITS', red: 'NOT ELIGIBLE', yellow: 'CHECK', mine: 'YOURS' };

// The offered run as the paddle has it, for the scorecard's timeline and
// PADDLE link: { run, url } or null. One lookup per run, shared by every card.
const runCache = new Map();
function paddleRun(offer) {
  const g = offer.give || {};
  if (!offer.depotKey || !g.date || !g.runNo || !g.dayType) return Promise.resolve(null);
  const k = offer.depotKey + '|' + g.date + '|' + g.dayType + '|' + g.runNo;
  if (!runCache.has(k)) {
    const p = slugFor(offer.depotKey, g.date).then(async ({ slug }) => {
      if (!slug) return null;
      const [run, url] = await Promise.all([getRun(slug, g.dayType, g.runNo, g.date), paddleLinkFor(slug, g.dayType, g.runNo).catch(() => '')]);
      return run ? { run, url } : null;
    });
    p.catch(() => runCache.delete(k));
    runCache.set(k, p);
  }
  return runCache.get(k).catch(() => null);
}

/**
 * One offer: the swap details on top of the Paddle App's run scorecard
 * (pa-run-card.js), as one card.
 *   check  — checkOffer()'s answer (or guestCheck())
 *   opts.actions — nodes for the footer (e.g. the "I'm interested" button)
 *   opts.menu    — [[label, onClick], ...] behind the ⋯ button (report, block)
 *   opts.guest   — show the guest badge text
 *   opts.blocked — names of the operators the poster blocked; given only on
 *                  the poster's own offers, because blocks are private
 */
export function scorecard(offer, check, opts = {}) {
  const g = offer.give || {};
  const c = check || W.guestCheck();
  const closed = offer.status && !['open', 'matched'].includes(offer.status);

  // ---- the swap details
  const top = el('div', 'sw-details');
  const row = el('div', 'sw-top');
  const when = el('div', 'sw-date');
  when.appendChild(el('small', null, offer.kind === 'dayoff' ? 'DAY OFF WANTED' : 'OFFERED FOR'));
  when.appendChild(document.createTextNode(g.date ? W.longDay(g.date) + ' ' + W.fmtDay(g.date).slice(4) : '?'));
  row.appendChild(when);
  const badge = opts.guest ? 'SIGN IN TO CHECK' : (offer.status && offer.status !== 'open' && c.color !== 'mine')
    ? W.STATUS_LABELS[offer.status].toUpperCase() : BADGE[c.color];
  row.appendChild(el('span', 'sw-badge ' + c.color, badge));
  top.appendChild(row);
  const sh = W.shiftOf(g.reportMin);
  top.appendChild(el('div', 'sw-head', W.headline(offer)
    + (sh ? ' · ' + W.SHIFTS[sh] + ' run' : '')
    + (g.reportMin != null && g.reportMin < 0 ? ' · starts the night before' : '')
    + ' · week of ' + W.fmtDay(offer.weekStart || W.weekOf(g.date || '')).slice(4)));

  const wants = el('div', 'sw-wants');
  wants.appendChild(el('span', 'k', 'Wants in return'));
  wants.appendChild(document.createTextNode(W.describeWants(offer)));
  top.appendChild(wants);

  const conds = W.describePrefs(offer.prefs);
  if (opts.blocked && opts.blocked.length) conds.push('Not swapping with ' + opts.blocked.join(', '));
  if (conds.length) {
    const p = el('div', 'sw-prefs');
    p.appendChild(el('span', 'k', 'Conditions'));
    conds.forEach(t => p.appendChild(el('span', 'sw-cond', t)));
    top.appendChild(p);
  }
  if (offer.prefs && offer.prefs.note) top.appendChild(el('div', 'sw-note', '“' + offer.prefs.note + '”'));
  if (c.reason && c.color !== 'mine') top.appendChild(el('div', 'sw-reason ' + c.color, c.reason));

  // ---- the run, as the paddle viewer draws it; the timeline fills in once
  // the paddle answers
  const fallback = { runNo: g.runNo, dayType: g.dayType, reportMin: g.reportMin, finishMin: g.finishMin, payHours: g.payHours, routeLabel: g.routeLabel };
  let runEl = RC.card(RC.modelFromRun(null, fallback));
  const card = RC.stack(top, runEl, g.dayType);
  card.classList.add('sw-card', c.color);
  if (closed) card.classList.add('closed');
  card.dataset.offer = offer.id || '';
  paddleRun(offer).then(x => {
    if (!x || !card.contains(runEl)) return;
    const full = RC.card(RC.modelFromRun(x.run, fallback), { paddleUrl: x.url });
    runEl.replaceWith(full); runEl = full;
  });

  // ---- who posted it, and what can be done
  const foot = el('div', 'sw-foot');
  foot.appendChild(el('div', 'sw-by', 'Posted by ' + (offer.posterName || 'an operator') + (offer.depotLabel ? ' · ' + offer.depotLabel : '')));
  (opts.actions || []).forEach(n => foot.appendChild(n));
  let menu = null;
  if (opts.menu && opts.menu.length) {
    const more = button('sw-more', '⋯', () => { menu.hidden = !menu.hidden; });
    more.setAttribute('aria-label', 'More: report or block');
    foot.appendChild(more);
    menu = el('div', 'sw-menu'); menu.hidden = true;
    opts.menu.forEach(([label, fn]) => menu.appendChild(button('rowbtn', label, fn)));
  }
  card.appendChild(foot);
  if (menu) card.appendChild(menu);
  return card;
}

/** The report form, inline under a card. Resolves through onSend(reason, note). */
export function reportPanel(onSend, onCancel) {
  const p = el('div', 'sw-panel');
  p.appendChild(el('span', 'k', 'Report this offer'));
  const reason = field(p, 'Reason', { tag: 'select', options: Object.entries(W.REPORT_REASONS) });
  const note = field(p, 'Details (optional)', { maxlength: '280' });
  const msg = el('div', 'msgline');
  const acts = el('div', 'sw-acts');
  const send = button('pa-submit', 'Send report', async () => {
    send.disabled = true;
    try { await onSend(reason.value, note.value); msg.className = 'msgline ok'; msg.textContent = 'Thanks. An admin will look at it.'; setTimeout(onCancel, 1200); }
    catch (e) { send.disabled = false; msg.className = 'msgline err'; msg.textContent = e && e.code === 'permission-denied' ? 'You already reported this offer.' : 'Could not send. Try again.'; }
  });
  acts.append(send, button('pa-ghost', 'Cancel', onCancel));
  p.append(acts, msg);
  return p;
}

/** Contact links: tel: / mailto:. */
export function contactLine(c) {
  const box = el('div', 'sw-contact');
  if (!c || (!c.phone && !c.email)) { box.textContent = 'No contact left yet.'; return box; }
  if (c.phone) { const a = el('a', null, c.phone); a.href = 'tel:' + c.phone.replace(/[^\d+]/g, ''); box.appendChild(a); }
  if (c.phone && c.email) box.appendChild(document.createTextNode(' · '));
  if (c.email) { const a = el('a', null, c.email); a.href = 'mailto:' + c.email; box.appendChild(a); }
  return box;
}

/** Inline phone / email entry; returns { node, value() }. */
export function contactFields(parent, initial, label) {
  const p = el('div', 'sw-panel');
  p.appendChild(el('span', 'k', label || 'How should they reach you?'));
  const row = el('div', 'sw-row');
  const phone = field(row, 'Phone', { type: 'tel', autocomplete: 'tel', maxlength: '30', value: initial.phone || '' });
  const email = field(row, 'Email', { type: 'email', autocomplete: 'email', maxlength: '120', value: initial.email || '' });
  p.appendChild(row);
  p.appendChild(el('div', 'hint', 'Shared only with the one person matched with you.'));
  parent.appendChild(p);
  return { node: p, value: () => ({ phone: phone.value.trim(), email: email.value.trim() }) };
}
