// The Swap board's server side, against the in-memory database and a fake
// push sender — no Google involved.
//
//   npm --prefix functions test

import test from 'node:test';
import assert from 'node:assert/strict';

import { onInterestCreated, onOfferUpdated, onReportCreated, cleanupExpired, expireStarted, statusMessage, interestMessage, runLabel, HIDE_AT_REPORTS } from '../lib/swap.js';
import { makeDb } from './fake-db.mjs';

const GIVE = { date: '2026-11-07', runNo: '300' };   // a Saturday

function harness({ fail = {} } = {}) {
  const db = makeDb();
  const pushes = [];
  const deps = {
    db, appUrl: 'https://example.test/home.html?view=swap', log: { error() {}, info() {} },
    async sendPush(token, p) {
      if (fail[token]) throw Object.assign(new Error('x'), { code: fail[token] });
      pushes.push({ token, ...p });
    },
    async deleteTree(ref) { await ref.delete(); }
  };
  const device = (uid, id, data) => db.store.set('users/' + uid + '/devices/' + id, data);
  const offer = (id, data) => db.store.set('swapOffers/' + id, { give: GIVE, posterUid: 'deen', posterName: 'Deen', status: 'open', ...data });
  return { db, deps, pushes, device, offer };
}

test('interest reaches the poster on every registered phone', async () => {
  const h = harness();
  h.offer('o1', {});
  h.device('deen', 'a', { fcmToken: 'tA' });
  h.device('deen', 'c', { platform: 'no token' });
  const n = await onInterestCreated(h.deps, 'o1', { uid: 'pat', name: 'Pat', run: { date: '2026-11-05', runNo: '400' } });
  assert.equal(n, 1);
  assert.equal(h.pushes[0].token, 'tA');
  assert.match(h.pushes[0].body, /^Pat wants your Sat run 300 \(they give Thu run 400\)/);
  assert.equal(h.pushes[0].url, h.deps.appUrl);
});

test('no alert for a closed offer, a missing one, or the poster themself', async () => {
  const h = harness();
  h.device('deen', 'a', { fcmToken: 'tA' });
  h.offer('o1', { status: 'matched' });
  h.offer('o2', {});
  assert.equal(await onInterestCreated(h.deps, 'o1', { uid: 'pat' }), 0);
  assert.equal(await onInterestCreated(h.deps, 'nope', { uid: 'pat' }), 0);
  assert.equal(await onInterestCreated(h.deps, 'o2', { uid: 'deen' }), 0);
  assert.equal(h.pushes.length, 0);
});

test('a dead token is deleted; other failures are kept and logged', async () => {
  const h = harness({ fail: { dead: 'messaging/registration-token-not-registered', flaky: 'messaging/internal-error' } });
  h.offer('o1', {});
  h.device('deen', 'x', { fcmToken: 'dead' });
  h.device('deen', 'y', { fcmToken: 'flaky' });
  await onInterestCreated(h.deps, 'o1', { uid: 'pat', name: 'Pat' });
  assert.equal(h.db.store.has('users/deen/devices/x'), false);
  assert.equal(h.db.store.has('users/deen/devices/y'), true);
});

test('status changes: picked, arranged (other side, with the dispatcher reminder), cancelled after a pick', async () => {
  const h = harness();
  h.device('pat', 'p', { fcmToken: 'tP' });
  h.device('deen', 'd', { fcmToken: 'tD' });
  const open = { give: GIVE, posterUid: 'deen', posterName: 'Deen', status: 'open' };
  const matched = { ...open, status: 'matched', matchedUid: 'pat', matchedName: 'Pat' };

  await onOfferUpdated(h.deps, 'o1', open, matched);
  assert.equal(h.pushes.at(-1).token, 'tP');
  assert.match(h.pushes.at(-1).body, /Deen picked you for Sat run 300/);

  await onOfferUpdated(h.deps, 'o1', matched, { ...matched, status: 'arranged', arrangedBy: 'pat' });
  assert.equal(h.pushes.at(-1).token, 'tD');
  assert.match(h.pushes.at(-1).body, /dispatcher must still approve/);

  await onOfferUpdated(h.deps, 'o1', matched, { ...matched, status: 'cancelled' });
  assert.equal(h.pushes.at(-1).token, 'tP');
  assert.equal(h.pushes.length, 3);

  // Edits that leave the status alone send nothing.
  assert.equal(statusMessage(open, { ...open, prefs: { note: 'x' } }), null);
  assert.equal(statusMessage(open, { ...open, status: 'cancelled' }), null);
});

test('three different reporters hide an open offer', async () => {
  const h = harness();
  h.offer('o1', {});
  for (let i = 1; i <= HIDE_AT_REPORTS; i++) {
    const r = { offerId: 'o1', reporterUid: 'u' + i, reason: 'fake' };
    h.db.store.set('swapReports/o1_u' + i, r);
    const patch = await onReportCreated(h.deps, r);
    assert.equal(patch.reportCount, i);
  }
  assert.equal(h.db.store.get('swapOffers/o1').status, 'hidden');
});

test('daily cleanup removes expired offers, keeps arranged ones a week', async () => {
  const h = harness();
  h.offer('old', { expiresOn: '2026-10-20' });
  h.offer('arrangedRecent', { expiresOn: '2026-10-25', status: 'arranged' });
  h.offer('arrangedOld', { expiresOn: '2026-10-10', status: 'arranged' });
  h.offer('today', { expiresOn: '2026-10-27' });
  const n = await cleanupExpired(h.deps, '2026-10-27');
  assert.equal(n, 2);
  assert.deepEqual([...h.db.store.keys()].filter(k => k.startsWith('swapOffers/')).sort(), ['swapOffers/arrangedRecent', 'swapOffers/today']);
});

test('labels', () => {
  assert.equal(runLabel({ date: '2026-11-03', runNo: '209' }), 'Tue run 209');
  assert.match(interestMessage({ id: 'o', give: GIVE }, null).body, /^An operator wants your Sat run 300\./);
});

test('an offer is deleted two hours before its run starts, unless the swap was arranged', async () => {
  const h = harness();
  const NOW = Date.UTC(2026, 9, 29, 3, 54);
  h.offer('started', { startsAtMs: NOW - 1000 });
  h.offer('talking', { startsAtMs: NOW + 120 * 60000, status: 'matched' });   // exactly two hours out
  h.offer('later', { startsAtMs: NOW + 121 * 60000 });
  h.offer('old', {});                                  // posted before startsAtMs: left to the daily cleanup
  h.offer('arranged', { startsAtMs: NOW - 5000, status: 'arranged' });
  const n = await expireStarted(h.deps, NOW);
  assert.equal(n, 2);
  assert.deepEqual([...h.db.store.keys()].filter(k => k.startsWith('swapOffers/')).sort(),
    ['swapOffers/arranged', 'swapOffers/later', 'swapOffers/old']);
  assert.equal(h.db.store.get('swapOffers/arranged').startsAtMs, null);
  assert.equal(await expireStarted(h.deps, NOW), 0);
});
