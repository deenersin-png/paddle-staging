// The swap rules in assets/pa-swap.js, run without a browser or Firebase.
//
//   node --test assets/tests/swap.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkOffer, buildOffer, restProblem, shiftOf, excludedRoute, weekChoices, openDates,
  describeWants, sameDepot, OWL
} from '../pa-swap.js';

// Week of Sun 2026-11-01 .. Sat 2026-11-07. "Today" is the Sunday.
const TODAY = '2026-11-01';
const SUN = '2026-11-01', MON = '2026-11-02', TUE = '2026-11-03', WED = '2026-11-04',
      THU = '2026-11-05', FRI = '2026-11-06', SAT = '2026-11-07', NEXT_MON = '2026-11-09';

const card = (date, runNo, reportMin, finishMin, routes = ['40'], extra = {}) => ({
  date, dayType: 'weekday', runNo: String(runNo), routeLabel: routes.join('-'), routes, owl: false,
  reportMin, finishMin, payHours: 8.5, swing: false, ...extra
});

/** An operator: { date: card | 'off' } plus which days are on record at all. */
function who(uid, week, { depotKey = 'callowhillb', season = 'fall2026', unknown = [] } = {}) {
  return {
    uid, depotKey,
    seasonFor: () => season,
    day: d => (unknown.includes(d) ? { known: false, card: null }
      : { known: true, card: week[d] && week[d] !== 'off' ? week[d] : null })
  };
}

// Deen is off Thursday and Friday and wants Saturday off. He offers his
// Saturday run and would work someone's Thursday or Friday in return.
const deen = who('deen', {
  [SUN]: card(SUN, 101, 360, 870), [MON]: card(MON, 101, 360, 870), [TUE]: card(TUE, 101, 360, 870),
  [WED]: card(WED, 101, 360, 870), [SAT]: card(SAT, 300, 360, 870)
});

function deenOffer(over = {}) {
  const { doc, error } = buildOffer({
    kind: 'dayoff', give: deen.day(SAT).card,
    wants: [{ type: 'day', date: THU }, { type: 'day', date: FRI }], prefs: {}, ...over
  }, deen, TODAY);
  assert.equal(error, undefined);
  return { ...doc, posterUid: 'deen', status: 'open', depotKey: 'callowhillb', depotLabel: 'Callowhill Bus', seasonId: 'fall2026' };
}

test('the Deen example: a Thursday run for his Saturday is green', () => {
  const pat = who('pat', { [THU]: card(THU, 400, 420, 900), [FRI]: 'off', [SAT]: 'off' });
  const r = checkOffer(deenOffer(), pat, TODAY);
  assert.equal(r.color, 'green');
  assert.equal(r.want, 0);
  assert.equal(r.myCard.runNo, '400');
});

test('red when the interested operator already works the offered day', () => {
  const pat = who('pat', { [THU]: card(THU, 400, 420, 900), [SAT]: card(SAT, 500, 420, 900) });
  const r = checkOffer(deenOffer(), pat, TODAY);
  assert.equal(r.color, 'red');
  assert.match(r.reason, /You work Saturday/);
});

test('yellow names the day with nothing on record; red options do not hide it', () => {
  const pat = who('pat', { [THU]: 'off', [SAT]: 'off' }, { unknown: [FRI] });
  const r = checkOffer(deenOffer(), pat, TODAY);
  assert.equal(r.color, 'yellow');
  assert.deepEqual(r.needs, [FRI]);
});

test('red when on vacation the offered day', () => {
  const pat = { uid: 'p', depotKey: 'callowhillb', seasonFor: () => 'fall2026',
    day: d => (d === THU ? { known: true, card: card(THU, 400, 420, 900) } : d === SAT ? { known: true, card: null, away: true } : { known: true, card: null }) };
  assert.match(checkOffer(deenOffer({ wants: [{ type: 'day', date: THU }] }), pat, TODAY).reason, /vacation Saturday/);
});

test('rest rule, the taker: Friday 11 PM finish cannot take a 6 AM Saturday', () => {
  const pat = who('pat', { [THU]: card(THU, 400, 420, 900), [FRI]: card(FRI, 410, 900, 1380), [SAT]: 'off' });
  const offer = deenOffer({ wants: [{ type: 'day', date: THU }] });
  // Pat gives Thu, keeps Fri, takes Deen's Sat 6:00 AM: 7 h after 11 PM.
  const r = checkOffer(offer, pat, TODAY);
  assert.equal(r.color, 'red');
  assert.match(r.reason, /^You would get only 7h 00m rest between Fri and Sat/);
});

test('rest rule, the poster: a Wednesday 11 PM finish cannot take a 6 AM Thursday', () => {
  const late = who('deen', { [WED]: card(WED, 101, 900, 1380), [SAT]: card(SAT, 300, 360, 870) });
  const { doc } = buildOffer({ kind: 'dayoff', give: late.day(SAT).card, wants: [{ type: 'day', date: THU }], prefs: {} }, late, TODAY);
  const offer = { ...doc, posterUid: 'deen', status: 'open', depotKey: 'callowhillb', seasonId: 'fall2026' };
  const pat = who('pat', { [THU]: card(THU, 400, 360, 840), [SAT]: 'off' });
  const r = checkOffer(offer, pat, TODAY);
  assert.equal(r.color, 'red');
  assert.match(r.reason, /^The poster would get only 7h 00m rest between Wed and Thu/);
});

test('rest across midnight: a run finishing 1 AM is checked against the next day', () => {
  // finishMin 1500 = 1:00 AM the next morning; next start 8:00 AM = 7 h.
  assert.deepEqual(restProblem({ [MON]: [900, 1500], [TUE]: [480, 900] }, TUE), { from: MON, to: TUE, restMin: 420 });
  assert.equal(restProblem({ [MON]: [900, 1500], [TUE]: [540, 900] }, TUE), null);   // exactly 8 h is fine
});

test('excluded routes and night liners', () => {
  const offer = deenOffer({ prefs: { excludeRoutes: ['21', 'owl'] } });
  const p21 = who('p', { [THU]: card(THU, 400, 420, 900, ['21', '42']), [FRI]: 'off', [SAT]: 'off' });
  assert.match(checkOffer(offer, p21, TODAY).reason, /not taking route 21/);
  const owl = who('p', { [THU]: card(THU, 990, 1430, 1900, ['L1'], { owl: true }), [FRI]: 'off', [SAT]: 'off' });
  assert.match(checkOffer(offer, owl, TODAY).reason, /night liners/);
  assert.equal(excludedRoute(card(THU, 1, 420, 900, ['52']), ['21', OWL]), null);
});

test('time window: start no earlier than 6 AM, finish by 5 PM', () => {
  const offer = deenOffer({ prefs: { earliestMin: 360, latestMin: 1020 } });
  const early = who('p', { [THU]: card(THU, 400, 300, 800), [FRI]: 'off', [SAT]: 'off' });
  assert.match(checkOffer(offer, early, TODAY).reason, /^Starts 5:00 AM/);
  const late = who('p', { [THU]: card(THU, 400, 600, 1080), [FRI]: 'off', [SAT]: 'off' });
  assert.match(checkOffer(offer, late, TODAY).reason, /^Finishes 6:00 PM/);
});

test('different district and different picking are red', () => {
  const pat = { [THU]: card(THU, 400, 420, 900), [SAT]: 'off' };
  assert.match(checkOffer(deenOffer(), who('p', pat, { depotKey: 'midvale' }), TODAY).reason, /^Different district/);
  assert.match(checkOffer(deenOffer(), who('p', pat, { season: 'winter2027' }), TODAY).reason, /^Different picking/);
  assert.ok(sameDepot('callowhill', 'callowhillb'));
});

test('same-day shift swap: Tuesday late for Tuesday early', () => {
  const poster = who('deen', { [TUE]: card(TUE, 209, 900, 1440) });
  const { doc, error } = buildOffer({ kind: 'give', give: poster.day(TUE).card, wants: [{ type: 'shift', shift: 'early' }], prefs: {} }, poster, TODAY);
  assert.equal(error, undefined);
  const offer = { ...doc, posterUid: 'deen', status: 'open', depotKey: 'callowhillb', seasonId: 'fall2026' };
  assert.equal(checkOffer(offer, who('p', { [TUE]: card(TUE, 105, 330, 840) }), TODAY).color, 'green');
  assert.match(checkOffer(offer, who('p', { [TUE]: card(TUE, 211, 930, 1450) }), TODAY).reason, /wants an early run; yours \(211\) is late/);
  assert.match(checkOffer(offer, who('p', { [TUE]: 'off' }), TODAY).reason, /You are off Tuesday/);
  assert.equal(describeWants(offer), 'An early run on Tue');
});

test('Tuesday all day for someone\'s Monday', () => {
  const poster = who('deen', { [TUE]: card(TUE, 209, 360, 870), [MON]: 'off' });
  const { doc } = buildOffer({ kind: 'give', give: poster.day(TUE).card, wants: [{ type: 'day', date: MON }], prefs: {} }, poster, TODAY);
  const offer = { ...doc, posterUid: 'deen', status: 'open', depotKey: 'callowhillb', seasonId: 'fall2026' };
  assert.equal(offer.expiresOn, MON);                  // gone once Monday passes
  const pat = who('p', { [MON]: card(MON, 310, 420, 900), [TUE]: 'off' });
  assert.equal(checkOffer(offer, pat, TODAY).color, 'green');
  assert.match(checkOffer(offer, pat, TUE).reason, /expired/);
});

test('week rule: one Sunday-to-Saturday week, never a past day, never crossing', () => {
  const give = deen.day(SAT).card;
  assert.match(buildOffer({ kind: 'dayoff', give, wants: [{ type: 'day', date: NEXT_MON }] }, deen, TODAY).error, /same week/);
  assert.match(buildOffer({ kind: 'dayoff', give, wants: [{ type: 'day', date: MON }] }, deen, TODAY).error, /already work Monday/);
  assert.match(buildOffer({ kind: 'give', give: card('2026-10-30', 1, 360, 800), wants: [{ type: 'day', date: '2026-10-31' }] }, deen, TODAY).error, /passed/);
  assert.match(buildOffer({ kind: 'dayoff', give, wants: [] }, deen, TODAY).error, /at least one/);
  assert.match(buildOffer({ kind: 'dayoff', give, wants: [{ type: 'shift', shift: 'early' }] }, deen, TODAY).error, /different day/);
  assert.equal(weekChoices(TUE)[0], SUN);
  assert.deepEqual(openDates(SUN, THU), [THU, FRI, SAT]);
});

test('poster busy carries times only, Saturday before to Sunday after', () => {
  const o = deenOffer();
  assert.deepEqual(Object.keys(o.posterBusy).sort(), [SUN, MON, TUE, WED, SAT].sort());
  assert.deepEqual(o.posterBusy[SAT], [360, 870]);
  assert.equal(o.expiresOn, THU);
});

test('guests, posters and closed offers', () => {
  assert.equal(checkOffer(deenOffer(), null, TODAY).color, 'yellow');
  assert.equal(checkOffer(deenOffer(), deen, TODAY).color, 'mine');
  assert.match(checkOffer({ ...deenOffer(), status: 'matched' }, who('p', {}), TODAY).reason, /no longer open/);
});

test('shifts by report time', () => {
  assert.equal(shiftOf(29), 'night');
  assert.equal(shiftOf(330), 'early');
  assert.equal(shiftOf(233), 'early');          // 3:53 AM is an early run, not a night liner
  assert.equal(shiftOf(700), 'mid');
  assert.equal(shiftOf(900), 'late');
  assert.equal(shiftOf(1434), 'night');
});

test('an offer knows when its run starts, a night liner the evening before its date', async () => {
  const { startsAtOf, hasStarted } = await import('../pa-swap.js');
  const { minToMs } = await import('../pa-schedule.js');
  const owl = card(THU, 51, -6, 553, ['L1 OWL'], { owl: true });
  assert.equal(startsAtOf(owl), minToMs(WED, 1434));                 // Wed 11:54 PM
  const offer = { status: 'open', give: owl };
  assert.equal(hasStarted(offer, minToMs(WED, 1433)), false);
  assert.equal(hasStarted(offer, minToMs(WED, 1434)), true);
  assert.equal(hasStarted({ ...offer, status: 'arranged' }, minToMs(THU, 600)), false);
  const { doc } = buildOffer({ kind: 'give', give: owl, wants: [{ type: 'day', date: FRI }] }, who('me', {}), TODAY);
  assert.equal(doc.startsAtMs, minToMs(WED, 1434));
});

test('same day: any other run that day inside the time window, rest checked both ways', () => {
  const poster = who('deen', { [TUE]: card(TUE, 209, 900, 1440), [WED]: card(WED, 209, 900, 1440) });
  const { doc, error } = buildOffer({ kind: 'give', give: poster.day(TUE).card, wants: [{ type: 'same' }],
    prefs: { earliestMin: 300, latestMin: 900 } }, poster, TODAY);
  assert.equal(error, undefined);
  const offer = { ...doc, posterUid: 'deen', status: 'open', depotKey: 'callowhillb', seasonId: 'fall2026' };
  assert.equal(describeWants(offer), 'Another run on Tue, same day');
  assert.equal(checkOffer(offer, who('p', { [TUE]: card(TUE, 105, 330, 840) }), TODAY).color, 'green');
  assert.match(checkOffer(offer, who('p', { [TUE]: card(TUE, 105, 240, 840) }), TODAY).reason, /no earlier than/);
  assert.match(checkOffer(offer, who('p', { [TUE]: 'off' }), TODAY).reason, /You are off Tuesday/);
  assert.match(checkOffer(offer, who('p', { [TUE]: card(TUE, 209, 330, 840) }), TODAY).reason, /same run/);
  // The taker finishes Tuesday at midnight and starts Wednesday at 5 AM.
  assert.match(checkOffer(offer, who('p', { [TUE]: card(TUE, 105, 330, 840), [WED]: card(WED, 7, 300, 800) }), TODAY).reason, /You would get only 5h/);
});

test('two-hour cutoff and this week only', async () => {
  const { runInCutoff, pastCutoff, CUTOFF_TEXT } = await import('../pa-swap.js');
  const { minToMs } = await import('../pa-schedule.js');
  const give = card(SUN, 101, 600, 1100);                       // Sunday 10:00 AM
  assert.equal(runInCutoff(give, minToMs(SUN, 479)), false);    // 7:59 AM: still open
  assert.equal(runInCutoff(give, minToMs(SUN, 480)), true);     // 8:00 AM: two hours out
  const ok = buildOffer({ kind: 'give', give, wants: [{ type: 'same' }] }, who('me', {}), TODAY, minToMs(SUN, 400));
  assert.equal(ok.error, undefined);
  assert.equal(buildOffer({ kind: 'give', give, wants: [{ type: 'same' }] }, who('me', {}), TODAY, minToMs(SUN, 500)).error, CUTOFF_TEXT);
  assert.equal(pastCutoff({ ...ok.doc, status: 'open' }, minToMs(SUN, 480)), true);
  assert.equal(pastCutoff({ ...ok.doc, status: 'arranged' }, minToMs(SUN, 480)), false);
  // Later days have no cutoff today.
  assert.equal(runInCutoff(card(MON, 101, 300, 800), minToMs(SUN, 1000)), false);
  assert.match(buildOffer({ kind: 'give', give: card(NEXT_MON, 1, 360, 800), wants: [{ type: 'same' }] }, who('me', {}), TODAY).error, /this week only/);
});
