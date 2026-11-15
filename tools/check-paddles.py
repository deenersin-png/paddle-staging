"""Check paddle CSVs for mistakes before the Paddle App reads them.

Run after uploading a new pick (GitHub runs it by itself on every upload,
see .github/workflows/check-paddles.yml), or by hand:

    python tools/check-paddles.py                      # every pick in data/
    python tools/check-paddles.py data/victory-fall-2026
    python tools/check-paddles.py --fix data/victory-fall-2026

Every run row is cross-checked against itself: report time -> each piece's
pull-out and pull-in -> finish must run forward in a sensible way, each
piece's length must match its own minutes column (stimeint), and the finish
must match the `arrive` column. An AM/PM typed the wrong way round anywhere
on a run, long or short, breaks one of these.

ERRORS (exit code 1) are mistakes the app would show wrong:
  finish-ampm   finish 12 h off (e.g. pull-in 2:52 PM, finish "2:55 AM")  [--fix]
  start-ampm    report 12 h off from the first pull-out                    [--fix]
  piece-ampm    a piece's pull-out / pull-in 12 h off from its own length
  arrive        finish clock disagrees with the `arrive` column
  order         times run backwards or a piece starts before the last ended
  too-long      report to finish over 16 hours
  bad-time      a time that can't be read
  pay           pay missing or not a number
  day           `day` column is not the file's day
  missing-file  a pick in a manifest without its weekday/saturday/sunday file
WARNINGS (reported, exit code unchanged) are worth a look:
  long-report   more than 60 min from report to first pull-out
  long-finish   more than 90 min from last pull-in to finish
  piece-length  piece length differs from its minutes column by > 5 min
  versions      run listed twice with different times, not in run-variants.json
  pay-high      pay over 16 hours
  no-block      a piece without a block number

--fix corrects only finish-ampm and start-ampm (the date moves with it) and
leaves every other byte of the file alone. Everything else needs a person:
check the run in SEPTA's paddle PDF (pdfs.csv links it).
"""

import argparse
import csv
import datetime
import glob
import json
import os
import re
import sys

DAYS = ('weekday', 'saturday', 'sunday')
HALF_DAY = 720
FLIP_LO, FLIP_HI = 690, 780          # "12 h off, give or take half an hour"

TIME = re.compile(r'(\d{1,2}):(\d{2})\s*([AP]M)', re.I)


def clock(s):
    m = TIME.search(s or '')
    if not m:
        return None
    return (int(m.group(1)) % 12 + (12 if m.group(3).upper() == 'PM' else 0)) * 60 + int(m.group(2))


def fmt(mins):
    mins %= 1440
    h, m = divmod(mins, 60)
    return '%d:%02d %s' % ((h % 12) or 12, m, 'AM' if h < 12 else 'PM')


def flip_ampm(s):
    return re.sub(r'(AM|PM)(\s*)$', lambda m: ('PM' if m.group(1).upper() == 'AM' else 'AM') + m.group(2), s, flags=re.I)


def is_flip(gap):
    return FLIP_LO <= gap <= FLIP_HI


class Report:
    def __init__(self):
        self.items = []            # (level, file, run, code, message)

    def add(self, level, path, run, code, msg, fixable=False):
        self.items.append({'level': level, 'file': path, 'run': run, 'code': code, 'msg': msg, 'fixable': fixable})

    def errors(self):
        return [i for i in self.items if i['level'] == 'error']

    def warnings(self):
        return [i for i in self.items if i['level'] == 'warning']


def norm_row(r):
    return {(k or '').strip().lower(): (v or '').strip() for k, v in r.items()}


def check_row(rep, path, day, r, fixes):
    run = r.get('runno', '')
    seen = len(rep.items)
    if not run:
        rep.add('error', path, '?', 'bad-time', 'row without a run number')
        return
    if r.get('day') and r['day'].lower() != day:
        rep.add('error', path, run, 'day', '`day` says "%s" in the %s file' % (r['day'], day))

    pay = r.get('pay', '')
    try:
        p = float(pay)
        if p <= 0:
            rep.add('error', path, run, 'pay', 'pay is %s' % pay)
        elif p > 16:
            rep.add('warning', path, run, 'pay-high', 'pay %s h' % pay)
    except ValueError:
        rep.add('error', path, run, 'pay', 'pay "%s" is not a number' % pay)

    start, finish = clock(r.get('start')), clock(r.get('finish'))
    if start is None or finish is None:
        rep.add('error', path, run, 'bad-time', 'start "%s" / finish "%s" not readable' % (r.get('start'), r.get('finish')))
        return

    pieces = []
    for i in range(1, 11):
        if not r.get('r%d' % i):
            continue
        po, pi = clock(r.get('pot%d' % i)), clock(r.get('pit%d' % i))
        if po is None or pi is None:
            rep.add('error', path, run, 'bad-time', 'piece %d pull-out "%s" / pull-in "%s" not readable' % (i, r.get('pot%d' % i), r.get('pit%d' % i)))
            return
        mins = r.get('stimeint%d' % i, '')
        pieces.append({'i': i, 'po': po, 'pi': pi, 'mins': int(mins) if mins.isdigit() else None, 'block': r.get('b%d' % i, '')})
    if not pieces:
        rep.add('error', path, run, 'bad-time', 'no pieces')
        return

    # Each piece on its own: pull-in minus pull-out against its minutes column.
    for p in pieces:
        length = (p['pi'] - p['po']) % 1440
        if not p['block']:
            rep.add('warning', path, run, 'no-block', 'piece %d has no block number' % p['i'])
        if p['mins'] is None:
            continue
        diff = abs(length - p['mins'])
        diff = min(diff, 1440 - diff)
        if is_flip(diff):
            rep.add('error', path, run, 'piece-ampm', 'piece %d: %s -> %s is %d min, but it is listed as %d min (AM/PM?)'
                    % (p['i'], r.get('pot%d' % p['i']), r.get('pit%d' % p['i']), length, p['mins']))
        elif diff > 5:
            rep.add('warning', path, run, 'piece-length', 'piece %d: %s -> %s is %d min, listed as %d min'
                    % (p['i'], r.get('pot%d' % p['i']), r.get('pit%d' % p['i']), length, p['mins']))

    # Report -> first pull-out.
    first_gap = (pieces[0]['po'] - start) % 1440
    if is_flip(first_gap):
        rep.add('error', path, run, 'start-ampm', 'report %s but first pull-out %s (report AM/PM?)'
                % (r['start'][11:] or r['start'], r.get('pot%d' % pieces[0]['i'])), fixable=True)
        fixes.append(('start', run, r['start']))
    elif first_gap > 60:
        rep.add('warning', path, run, 'long-report', 'report %s, first pull-out %s (%d min)' % (fmt(start), fmt(pieces[0]['po']), first_gap))

    # Between pieces: the next piece must not start long before / 12 h after the last ended.
    for a, b in zip(pieces, pieces[1:]):
        gap = (b['po'] - a['pi']) % 1440
        if (is_flip(gap) or gap > 10 * 60) and not any(i['code'] == 'piece-ampm' for i in rep.items[seen:]):
            rep.add('error', path, run, 'order', 'piece %d ends %s, piece %d starts %s (%d min later; AM/PM?)'
                    % (a['i'], fmt(a['pi']), b['i'], fmt(b['po']), gap))

    # Last pull-in -> finish.
    last_gap = (finish - pieces[-1]['pi']) % 1440
    if is_flip(last_gap):
        rep.add('error', path, run, 'finish-ampm', 'last pull-in %s but finish "%s" (should be %s)'
                % (fmt(pieces[-1]['pi']), r['finish'][11:] or r['finish'], fmt(finish - HALF_DAY)), fixable=True)
        fixes.append(('finish', run, r['finish']))
        finish -= HALF_DAY
    elif last_gap > 90:
        rep.add('warning', path, run, 'long-finish', 'last pull-in %s, finish %s (%d min)' % (fmt(pieces[-1]['pi']), fmt(finish), last_gap))

    # Finish against the `arrive` column (the finish clock without AM/PM).
    arr = r.get('arrive', '')
    m = re.match(r'^(\d{1,2}):(\d{2})$', arr)
    if m:
        a = (int(m.group(1)) % 12) * 60 + int(m.group(2))
        if a != (clock(r['finish']) % 720):
            rep.add('error', path, run, 'arrive', 'finish %s but arrive %s' % (fmt(clock(r['finish'])), arr))

    # The whole run, report to finish, with every crossing of midnight.
    span = 0
    prev = start
    for t in [p for pc in pieces for p in (pc['po'], pc['pi'])] + [finish % 1440]:
        span += (t - prev) % 1440
        prev = t
    # A run already flagged for a 12-hour slip is long because of it: one message is enough.
    own = [i for i in rep.items[seen:] if i['level'] == 'error']
    if span > 16 * 60 and not own:
        rep.add('error', path, run, 'too-long', 'report %s to finish %s is %.1f hours' % (fmt(start), fmt(finish), span / 60))


def run_key(r):
    t = lambda s: ' '.join((s or '').split(' ')[1:3])
    return t(r.get('start')) + '|' + t(r.get('finish')) + '|' + r.get('pay', '')


def check_file(rep, path, day, variants, fix):
    raw = open(path, 'rb').read().decode('utf-8-sig')
    rows = [norm_row(r) for r in csv.DictReader(raw.splitlines())]
    fixes = []
    by_run = {}
    for r in rows:
        check_row(rep, path, day, r, fixes)
        if r.get('runno'):
            by_run.setdefault(r['runno'], {})[json.dumps(r, sort_keys=True)] = r
    slug = os.path.basename(os.path.dirname(path))
    known = ((variants.get('districts') or {}).get(slug) or {}).get(day.capitalize()) or {}
    for run, versions in by_run.items():
        if len(versions) < 2:
            continue
        keys = {e.get('key') for e in known.get(run, [])}
        if not all(run_key(v) in keys for v in versions.values()):
            rep.add('warning', path, run, 'versions', 'listed %d times with different times/pay; run tools/run-variants.py so the app knows which days each works' % len(versions))
    if fix and fixes:
        apply_fixes(path, raw, fixes)
    return len(rows)


def apply_fixes(path, raw, fixes):
    """Flip AM/PM of the listed start/finish values in place, and put the
    finish on the start's date (or the next day when it is earlier in the
    day). Only those two fields of those rows change; every other byte of
    the file stays as uploaded."""
    lines = raw.splitlines(keepends=True)
    hdr = [h.strip().lower() for h in next(csv.reader([lines[0]]))]
    ri, si, fi = hdr.index('runno'), hdr.index('start'), hdr.index('finish')
    done = 0
    for n, line in enumerate(lines[1:], 1):
        v = next(csv.reader([line]))
        if len(v) <= fi:
            continue
        mine = [f for f in fixes if f[1] == v[ri] and f[2] == v[si if f[0] == 'start' else fi]]
        if not mine:
            continue
        st, fn = v[si], v[fi]
        for what in {f[0] for f in mine}:          # a row listed twice is flipped once
            if what == 'start':
                st = flip_ampm(st)
            else:
                fn = flip_ampm(fn)
            done += 1
        if re.match(r'^\d{4}-\d{2}-\d{2} ', st) and re.match(r'^\d{4}-\d{2}-\d{2} ', fn):
            sd = datetime.date.fromisoformat(st[:10])
            fn = (sd if clock(fn) >= clock(st) else sd + datetime.timedelta(days=1)).isoformat() + fn[10:]
        out = line
        for old, new in ((v[si], st), (v[fi], fn)):
            if old != new:
                assert out.count(old) == 1, (path, v[ri], old)
                out = out.replace(old, new)
        lines[n] = out
    with open(path, 'wb') as f:
        f.write(''.join(lines).encode('utf-8'))
    print('fixed %d value(s) in %s' % (done, path.replace(os.sep, '/')))


def check_manifests(rep, root):
    for mf in sorted(glob.glob(os.path.join(root, 'manifest*.json'))):
        try:
            j = json.load(open(mf, encoding='utf-8'))
        except Exception as e:
            rep.add('error', mf, '-', 'missing-file', 'manifest is not valid JSON: %s' % e)
            continue
        for d in j.get('districts', []):
            for day in d.get('days', []):
                p = os.path.join(root, d.get('name', ''), day.lower() + '.csv')
                if not os.path.exists(p):
                    rep.add('error', mf, '-', 'missing-file', '%s lists %s %s but %s is missing' % (os.path.basename(mf), d.get('label', d.get('name')), day, p.replace('\\', '/')))


def markdown(rep, files, rows):
    e, w = rep.errors(), rep.warnings()
    out = ['## Paddle check: %s' % ('%d error(s)' % len(e) if e else 'no errors'),
           '', 'Checked %d run(s) in %d file(s). %d warning(s).' % (rows, files, len(w)), '']
    for title, items in (('Errors (the app shows these wrong)', e), ('Warnings (worth a look)', w)):
        if not items:
            continue
        out += ['### ' + title, '', '| File | Run | Check | What |', '|---|---|---|---|']
        for i in items[:300]:
            out.append('| %s | %s | %s%s | %s |' % (i['file'].replace('\\', '/'), i['run'], i['code'], ' (fixable)' if i['fixable'] else '', i['msg'].replace('|', '/')))
        if len(items) > 300:
            out.append('| … | | | %d more |' % (len(items) - 300))
        out.append('')
    if any(i['fixable'] for i in e):
        out.append('Fixable ones: `python tools/check-paddles.py --fix <pick folder>` then commit, or ask Claude.')
    return '\n'.join(out) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('paths', nargs='*', help='pick folders or CSV files (default: every pick in data/)')
    ap.add_argument('--data', default='data')
    ap.add_argument('--fix', action='store_true', help='correct finish-ampm / start-ampm in place')
    ap.add_argument('--summary', help='also write a Markdown report to this file')
    ap.add_argument('--quiet-warnings', action='store_true', help='print errors only')
    a = ap.parse_args()

    targets = []
    for p in a.paths or [a.data]:
        if os.path.isfile(p):
            targets.append(p)
        else:
            for day in DAYS:
                targets += glob.glob(os.path.join(p, day + '.csv')) + glob.glob(os.path.join(p, '*', day + '.csv'))
    targets = sorted(set(t for t in targets if os.path.basename(t)[:-4] in DAYS))

    try:
        variants = json.load(open(os.path.join(a.data, 'run-variants.json'), encoding='utf-8'))
    except Exception:
        variants = {}

    rep = Report()
    rows = 0
    for t in targets:
        rows += check_file(rep, t, os.path.basename(t)[:-4], variants, a.fix)
    if a.fix and any(i['fixable'] for i in rep.items):
        print('re-checking after --fix ...')
        rep, rows = Report(), 0
        for t in targets:
            rows += check_file(rep, t, os.path.basename(t)[:-4], variants, False)
    if not a.paths:
        check_manifests(rep, a.data)

    for i in rep.items:
        if a.quiet_warnings and i['level'] != 'error':
            continue
        print('%-7s %s run %s: [%s] %s' % (i['level'].upper(), i['file'].replace('\\', '/'), i['run'], i['code'], i['msg']))
    print('\n%d file(s), %d run(s): %d error(s), %d warning(s)' % (len(targets), rows, len(rep.errors()), len(rep.warnings())))
    if a.summary:
        with open(a.summary, 'a', encoding='utf-8') as f:
            f.write(markdown(rep, len(targets), rows))
    return 1 if rep.errors() else 0


if __name__ == '__main__':
    sys.exit(main())
