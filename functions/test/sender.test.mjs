// The sender's decisions, run against an in-memory database, a fake mailer and
// a stub for the live data — no Google, Gmail or SEPTA involved, no network.
//
//   npm --prefix functions test

import test from 'node:test';
import assert from 'node:assert/strict';

import { sweep, runJob, handle, subscribers, clampLead, claimIdFor, problemCode, CATCH_UP_MIN } from '../lib/sender.js';
import { makeDb } from './fake-db.mjs';

// ---- fixtures and a harness -----------------------------------------------

const TODAY = '2026-09-23';
const RUN = { pullOutMin: 883, finishMin: 1342, payHours: 9.1, routes: ['44'], pieces: [{ routeLabel: '44', block: '9663', startMin: 883, endMin: 1339 }] };
const plan = (date, reportMin = 869, runNo = '209', run = RUN) => ({ resolved: { date, runNo, dayType: 'weekday' }, run, reportMin });
const LIVE = { routes: ['44'], leader: { block: '9659', vehicleId: '3651', late: 4, nextStop: 'City Ave', destination: 'Ardmore' }, leaderTrip: { s: 875 }, detours: [], detoursFailed: [] };
const NO_LIVE = { routes: [], leader: null, detours: [], detoursFailed: [] };

function seedUser(db, uid, { profile = {}, settings = {} } = {}) {
  db.store.set('users/' + uid, { depotKey: 'callowhillb', depotLabel: 'Callowhill Bus', email: uid + '@example.com', ...profile });
  db.store.set('users/' + uid + '/settings/notifications', { emailEnabled: true, emailLeadMin: 2, emailTo: '', ...settings });
}

function harness({ plans = {}, live = LIVE, sendImpl } = {}) {
  const db = makeDb();
  const sent = [];
  const calls = { getPlan: 0 };
  const deps = {
    db,
    serverTimestamp: () => 'TS',
    now: { date: TODAY, nowMin: 867 },
    overrides: {},
    appUrl: 'https://example.test/home.html',
    getPlan: async (_db, uid, _profile, date) => { calls.getPlan++; return (plans[uid] && plans[uid][date]) || null; },
    getLive: async () => live,
    send: async (to, mail) => { if (sendImpl) await sendImpl(to, mail); sent.push({ to, mail }); },
    liveBudgetMs: 150,
    log: { info() {}, error() {} }
  };
  return { db, deps, sent, calls, at: (nowMin, extra = {}) => sweep({ ...deps, now: { date: TODAY, nowMin }, ...extra }) };
}

const one = (h, uid = 'u1', settings = {}, profile = {}) => { seedUser(h.db, uid, { settings, profile }); return h; };

// ---- when, and how many times ---------------------------------------------

test('sends once, to the right address, in the right minute', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  assert.equal((await h.at(866)).sent, 0, 'a minute early');
  assert.equal(h.sent.length, 0);

  const r = await h.at(867);
  assert.equal(r.sent, 1);
  assert.equal(h.sent[0].to, 'u1@example.com');
  assert.equal(h.sent[0].mail.subject, 'Run 209 · report 2:29 PM · in 2 min · leader 4 min late');
  assert.equal(h.db.store.get('users/u1/alerts/' + TODAY + '-209').sentAt, 'TS', 'the claim records that it went out');
});

test('never sends the same run twice while the window is open', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  const words = [];
  for (const m of [867, 868, 869, 870]) words.push((await h.at(m)).results.u1);
  assert.deepEqual(words, ['sent', 'already-sent', 'already-sent', 'already-sent']);
  assert.equal(h.sent.length, 1);
});

test('a missed minute still sends, but not forever', async () => {
  const late = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  assert.equal((await late.at(867 + CATCH_UP_MIN)).sent, 1, 'last minute of the window');
  const tooLate = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  const r = await tooLate.at(867 + CATCH_UP_MIN + 1);
  assert.equal(r.sent, 0);
  assert.equal(r.results.u1, 'not-due');
});

test('the operator\'s own lead time is honoured', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }), 'u1', { emailLeadMin: 15 });
  assert.equal((await h.at(867)).sent, 0, 'not at the 2-minute mark');
  assert.equal((await h.at(854)).sent, 1, '15 minutes before 2:29 PM');
  assert.match(h.sent[0].mail.subject, /in 15 min/);
});

test('a run reporting just after midnight is sent for the night before', async () => {
  const h = one(harness({ plans: { u1: { '2026-09-24': plan('2026-09-24', 5) } } }), 'u1', { emailLeadMin: 10 });
  const early = await h.at(1430);
  assert.equal(early.sent, 0, 'not yet at 11:50 PM');
  const r = await h.at(1435);
  assert.equal(r.sent, 1);
  assert.match(h.sent[0].mail.subject, /report 12:05 AM · in 10 min/);
  assert.ok(h.db.store.has('users/u1/alerts/2026-09-24-209'), 'claimed under the run\'s own day');
  const noon = one(harness({ plans: { u1: { '2026-09-24': plan('2026-09-24', 5) } } }));
  assert.equal((await noon.at(700)).results.u1, 'no-run', 'tomorrow is not looked at at noon');
});

test('a run the paddle does not know is still emailed when it has a report time', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY, 480, '9999', null) } }, live: NO_LIVE }));
  const r = await h.at(478);
  assert.equal(r.sent, 1);
  assert.match(h.sent[0].mail.html, /is not in the Callowhill Bus weekday paddle/);
  assert.match(h.sent[0].mail.subject, /^Run 9999 · report 8:00 AM/);
});

test('a day off, or nothing registered, sends nothing', async () => {
  const h = one(harness({ plans: {} }));
  const r = await h.at(867);
  assert.equal(r.sent, 0);
  assert.equal(r.results.u1, 'no-run');
});

// ---- when it goes wrong ---------------------------------------------------

test('a failed send frees the claim, so the next minute tries again', async () => {
  let fail = true;
  const h = one(harness({
    plans: { u1: { [TODAY]: plan(TODAY) } },
    sendImpl: async () => { if (fail) throw Object.assign(new Error('535 Username and Password not accepted'), { code: 'EAUTH' }); }
  }));
  const first = await h.at(867);
  assert.equal(first.sent, 0);
  assert.equal(first.failed, 1);
  assert.equal(first.sendErrorCode, 'EAUTH');
  assert.equal(h.db.store.has('users/u1/alerts/' + TODAY + '-209'), false, 'claim freed');

  fail = false;
  const second = await h.at(868);
  assert.equal(second.sent, 1);
  assert.equal(h.sent.length, 1, 'delivered exactly once');
});

test('a database hiccup AFTER a good send cannot cause a second email', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  h.db.hooks.onSet = (path, _data, opts) => { if (path.includes('/alerts/') && opts && opts.merge) throw new Error('unavailable'); };
  assert.equal((await h.at(867)).sent, 1, 'sent, though recording it failed');
  assert.equal((await h.at(868)).results.u1, 'already-sent');
  assert.equal(h.sent.length, 1);
});

test('live data that never arrives cannot hold the email up', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  h.deps.getLive = () => new Promise(() => {});           // SEPTA never answers
  const t0 = Date.now();
  const r = await h.at(867);
  assert.equal(r.sent, 1);
  assert.ok(Date.now() - t0 < 2000, 'went out on the budget, not on SEPTA');
  assert.match(h.sent[0].mail.html, /Could not load the bus ahead/);
  assert.match(h.sent[0].mail.html, /Could not reach SEPTA/);
  assert.match(h.sent[0].mail.text, /Could not load the bus ahead/);
});

test('a live lookup that throws is treated the same way', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  h.deps.getLive = async () => { throw new Error('boom'); };
  assert.equal((await h.at(867)).sent, 1);
  assert.match(h.sent[0].mail.html, /Could not load the bus ahead/);
});

test('an address that fails the check falls back to the account\'s own', async () => {
  const bad = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }), 'u1', { emailTo: 'a@b.com, c@d.com' });
  await bad.at(867);
  assert.equal(bad.sent[0].to, 'u1@example.com');

  const chosen = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }), 'u1', { emailTo: ' me@work.example ' });
  await chosen.at(867);
  assert.equal(chosen.sent[0].to, 'me@work.example');

  const none = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }), 'u1', { emailTo: 'x\r\nBcc: y@z.com' }, { email: 'not an address' });
  const r = await none.at(867);
  assert.equal(r.results.u1, 'no-address');
  assert.equal(none.sent.length, 0);
});

test('an account with no depot, or no profile, is left alone', async () => {
  const h = harness({ plans: { u1: { [TODAY]: plan(TODAY) }, u2: { [TODAY]: plan(TODAY) } } });
  seedUser(h.db, 'u1', { profile: { depotKey: '' } });
  h.db.store.set('users/u2/settings/notifications', { emailEnabled: true });
  const r = await h.at(867);
  assert.deepEqual(r.results, { u1: 'no-profile', u2: 'no-profile' });
  assert.equal(h.sent.length, 0);
});

test('a run number cannot break the claim document\'s path', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY, 869, '20/9') } } }));
  assert.equal((await h.at(867)).sent, 1);
  assert.ok(h.db.store.has('users/u1/alerts/' + TODAY + '-20_9'));
});

// ---- many people ----------------------------------------------------------

test('everyone due in the same minute gets exactly one email, a few at a time', async () => {
  let active = 0, peak = 0;
  const plans = {};
  const h = harness({
    plans,
    sendImpl: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; }
  });
  for (let i = 1; i <= 12; i++) { plans['u' + i] = { [TODAY]: plan(TODAY) }; seedUser(h.db, 'u' + i); }

  const r = await h.at(867);
  assert.equal(r.sent, 12);
  assert.equal(new Set(h.sent.map(s => s.to)).size, 12, 'twelve different people');
  assert.ok(peak > 1 && peak <= 5, 'concurrency used but capped (peak ' + peak + ')');
  assert.equal((await h.at(868)).sent, 0, 'and nobody again a minute later');
});

test('one operator\'s failure never stops the others', async () => {
  const plans = {};
  const h = harness({
    plans,
    sendImpl: async to => { if (to === 'u2@example.com') throw new Error('mailbox unavailable'); }
  });
  for (const u of ['u1', 'u2', 'u3']) { plans[u] = { [TODAY]: plan(TODAY) }; seedUser(h.db, u); }
  const r = await h.at(867);
  assert.equal(r.sent, 2);
  assert.deepEqual(r.results, { u1: 'sent', u2: 'error', u3: 'sent' });
  assert.equal(r.sendErrorCode, 'SEND_FAILED');
});

test('people who have not switched it on are never even looked at', async () => {
  const h = harness({ plans: { u1: { [TODAY]: plan(TODAY) } } });
  seedUser(h.db, 'u1', { settings: { emailEnabled: false } });
  h.db.store.set('users/u1/settings/paddle', { emailEnabled: true });     // some other settings document
  const r = await h.at(867);
  assert.equal(r.subscribers, 0);
  assert.equal(h.calls.getPlan, 0);
});

test('subscribers() reads only the notifications document', async () => {
  const db = makeDb();
  seedUser(db, 'u1');
  db.store.set('users/u2/settings/tracker', { emailEnabled: true });
  assert.deepEqual((await subscribers(db)).map(s => s.uid), ['u1']);
});

// ---- the heartbeat the ALERTS screen reads --------------------------------

test('every run leaves a heartbeat, and a clean one reports no problem', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  const out = await runJob(h.deps);
  const beat = h.db.store.get('config/emailSender');
  assert.equal(beat.lastRunAt, 'TS');
  assert.equal(beat.problem, null);
  assert.equal(out.problem, null);
});

test('a missing index is reported as "still building", and the job does not throw', async () => {
  const h = one(harness());
  h.db.hooks.onGroupGet = () => { throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index for collection settings and field emailEnabled.'), { code: 9 }); };
  const out = await runJob(h.deps);
  assert.equal(out.problem, 'INDEX_BUILDING');
  const beat = h.db.store.get('config/emailSender');
  assert.equal(beat.problem, 'INDEX_BUILDING');
  assert.equal(beat.lastRunAt, 'TS', 'it still says it ran');
});

test('any other database failure is reported plainly', async () => {
  const h = one(harness());
  h.db.hooks.onGroupGet = () => { throw new Error('socket hang up'); };
  assert.equal((await runJob(h.deps)).problem, 'QUERY_FAILED');
});

test('a send problem is remembered until an email actually goes out', async () => {
  let fail = true;
  const h = one(harness({
    plans: { u1: { [TODAY]: plan(TODAY) } },
    sendImpl: async () => { if (fail) throw Object.assign(new Error('535'), { code: 'EAUTH' }); }
  }));
  await runJob({ ...h.deps, now: { date: TODAY, nowMin: 867 } });
  let beat = h.db.store.get('config/emailSender');
  assert.equal(beat.sendProblem, 'EAUTH');
  assert.equal(beat.sendProblemAt, 'TS');

  await runJob({ ...h.deps, now: { date: TODAY, nowMin: 700 } });            // a quiet minute in between
  assert.equal(h.db.store.get('config/emailSender').sendProblem, 'EAUTH', 'a quiet minute does not erase it');

  fail = false;
  await runJob({ ...h.deps, now: { date: TODAY, nowMin: 868 } });
  beat = h.db.store.get('config/emailSender');
  assert.equal(beat.sendProblem, null, 'cleared by a successful send');
  assert.equal(h.sent.length, 1);
});

// ---- the small pure parts -------------------------------------------------

test('clampLead keeps the operator\'s setting sane', () => {
  for (const [input, want] of [[undefined, 2], [null, 2], ['', 2], [NaN, 2], ['abc', 2], [0, 1], [-5, 1], [100, 60], ['5', 5], [2.6, 3], [15, 15]]) {
    assert.equal(clampLead(input), want, String(input));
  }
});

test('claimIdFor turns whatever was typed into a safe document id', () => {
  assert.equal(claimIdFor('2026-09-23', '209'), '2026-09-23-209');
  assert.equal(claimIdFor('2026-09-23', '20/9'), '2026-09-23-20_9');
  assert.equal(claimIdFor('2026-09-23', '../../x'), '2026-09-23-______x');
  assert.equal(claimIdFor('2026-09-23', 'x'.repeat(100)).length, 10 + 1 + 24, 'date, a dash, and at most 24 characters of run');
});

test('problemCode tells a building index from any other failure', () => {
  assert.equal(problemCode({ code: 9 }), 'INDEX_BUILDING');
  assert.equal(problemCode({ code: 'failed-precondition' }), 'INDEX_BUILDING');
  assert.equal(problemCode(new Error('The query requires an index. You can create it here')), 'INDEX_BUILDING');
  assert.equal(problemCode(new Error('boom')), 'QUERY_FAILED');
  assert.equal(problemCode(null), 'QUERY_FAILED');
});

test('handle() on its own reports what it did', async () => {
  const h = one(harness({ plans: { u1: { [TODAY]: plan(TODAY) } } }));
  assert.equal(await handle(h.deps, { uid: 'u1', settings: { emailLeadMin: 2 } }), 'sent');
  assert.equal(await handle(h.deps, { uid: 'u1', settings: { emailLeadMin: 2 } }), 'already-sent');
});
