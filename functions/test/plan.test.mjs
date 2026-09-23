// The timing and input rules, against the vectors pinned for the whole project.
//
//   npm --prefix functions test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isDue, philadelphiaNow, cleanAddress, pieceAt } from '../lib/plan.js';

const vectors = JSON.parse(readFileSync(new URL('../../assets/tests/resolver-cases.json', import.meta.url), 'utf8'));

test('isDue matches every pinned vector', () => {
  const spec = vectors.formulas.isDue;
  assert.ok(spec.cases.length >= 10, 'the vectors are there');
  for (const c of spec.cases) {
    const got = isDue({ reportMin: c.reportMin, nowMin: c.nowMin, lead: c.lead, dayOffsetMin: c.dayOffsetMin || 0, catchUp: spec.catchUp });
    assert.equal(got.due, c.expectDue, c.why);
    if (c.expectMinutesAway != null) assert.equal(got.minutesAway, c.expectMinutesAway, c.why + ' (minutes away)');
  }
});

test('a run is never due in today\'s frame and tomorrow\'s in the same minute', () => {
  let both = 0;
  for (let report = 0; report < 60; report++) {
    for (let now = 0; now < 1440; now++) {
      for (const lead of [2, 5, 30]) {
        if (isDue({ reportMin: report, nowMin: now, lead }).due && isDue({ reportMin: report, nowMin: now, lead, dayOffsetMin: 1440 }).due) both++;
      }
    }
  }
  assert.equal(both, 0);
});

test('Philadelphia time does not depend on the machine\'s own clock', () => {
  const cases = [
    ['2026-09-23T18:29:00Z', '2026-09-23', 14 * 60 + 29],
    ['2026-09-24T04:30:00Z', '2026-09-24', 30],
    ['2026-09-24T03:59:00Z', '2026-09-23', 23 * 60 + 59],
    ['2026-01-15T04:30:00Z', '2026-01-14', 23 * 60 + 30],
    ['2026-09-24T04:00:00Z', '2026-09-24', 0],
    ['2026-03-08T06:59:00Z', '2026-03-08', 119],       // the last minute before spring forward
    ['2026-03-08T07:00:00Z', '2026-03-08', 180],       // the first one after
    ['2026-11-01T04:00:00Z', '2026-11-01', 0],
    ['2026-11-01T05:30:00Z', '2026-11-01', 90],        // 1:30 AM, first time round
    ['2026-11-01T06:30:00Z', '2026-11-01', 90]         // 1:30 AM again, after falling back
  ];
  const was = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York']) {
      process.env.TZ = zone;
      for (const [iso, date, min] of cases) {
        const got = philadelphiaNow(new Date(iso));
        assert.deepEqual([got.date, got.nowMin], [date, min], iso + ' with the machine clock in ' + zone);
      }
    }
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

test('cleanAddress takes one plain address and nothing else', () => {
  const rejected = [
    'a@b.com, c@d.com', 'a@b.com;c@d.com', 'x@y.com\r\nBcc: z@w.com', 'x@y.com\nBcc: z@w.com',
    '"a b"@c.com', '<a@b.com>', 'Name <a@b.com>', 'a@b', 'a@@b.com', '@b.com', 'a@.com',
    'a'.repeat(300) + '@b.com', 'a@' + 'b.'.repeat(300) + 'com', 'x'.repeat(1_000_000), '', '   ', null, undefined, 42
  ];
  for (const s of rejected) assert.equal(cleanAddress(s), '', JSON.stringify(String(s)).slice(0, 40));

  assert.equal(cleanAddress('fotokonyc@googlemail.com'), 'fotokonyc@googlemail.com');
  assert.equal(cleanAddress('  op.erator+paddle@mail.example.co  '), 'op.erator+paddle@mail.example.co');
  assert.equal(cleanAddress('o\'brien@example.org'), 'o\'brien@example.org');
});

test('cleanAddress is not slow on hostile input', () => {
  const t0 = Date.now();
  cleanAddress('x'.repeat(1_000_000));
  cleanAddress('a@' + 'b'.repeat(250) + '!');
  cleanAddress('a@' + 'b.'.repeat(120));
  assert.ok(Date.now() - t0 < 100);
});

test('pieceAt picks the piece in progress, else the first', () => {
  const run = { pieces: [{ block: 'A', startMin: 300, endMin: 500 }, { block: 'B', startMin: 600, endMin: 800 }] };
  assert.equal(pieceAt(run, 700).block, 'B');
  assert.equal(pieceAt(run, 550).block, 'A', 'in a gap between pieces: the first');
  assert.equal(pieceAt(run, 100).block, 'A');
  assert.equal(pieceAt({ pieces: [] }, 100), null);
  assert.equal(pieceAt(null, 100), null);
});
