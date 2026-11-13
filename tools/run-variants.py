"""Which days each version of a doubled run works.

Some paddle CSVs list a run number twice with different times / pay / pieces
(e.g. Comly 965: one version on Mon-Thu, an earlier one on Fridays). This tool
looks up, in SEPTA's GTFS, the trips that only ONE version covers, and reads
the days those trips run from the GTFS calendar. Output: data/run-variants.json,
read by index.html (Paddles) to label each version and mark what differs.

Usage (bus GTFS = the folder with trips.txt, stop_times.txt, calendar.txt ...,
e.g. unzipped from google_bus.zip inside https://www3.septa.org/developer/gtfs_public.zip):

    python -I tools/run-variants.py <bus-gtfs-dir> data/manifest-fall-2026.json

Re-run for every new pick (adds / replaces that pick's depots in the JSON).
"""
import collections
import csv
import datetime
import json
import os
import sys

DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
WEEK = DOW[:5]
CAL_COLS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
DAY_TYPES = {'weekday': WEEK, 'saturday': ['Sat'], 'sunday': ['Sun']}


def read(path):
    return csv.DictReader(open(path, encoding='utf-8-sig'))


def main(gtfs, manifest_path):
    root = os.path.dirname(os.path.dirname(os.path.abspath(manifest_path)))
    data_dir = os.path.join(root, 'data')

    # service_id -> weekdays it runs regularly (calendar flags, or added on 5+ dates)
    svc = {}
    for r in read(os.path.join(gtfs, 'calendar.txt')):
        svc[r['service_id']] = collections.Counter({d: 99 for d, c in zip(DOW, CAL_COLS) if r[c] == '1'})
    for r in read(os.path.join(gtfs, 'calendar_dates.txt')):
        if r['exception_type'] != '1':
            continue
        d = r['date']
        dw = DOW[datetime.date(int(d[:4]), int(d[4:6]), int(d[6:])).weekday()]
        svc.setdefault(r['service_id'], collections.Counter())[dw] += 1

    def svc_days(s):
        c = svc.get(s, {})
        return {d for d in DOW if c.get(d, 0) >= 5}

    feed = next(read(os.path.join(gtfs, 'feed_info.txt')), {})
    rname = {r['route_id']: r['route_short_name'] for r in read(os.path.join(gtfs, 'routes.txt'))}
    manifest = json.load(open(manifest_path, encoding='utf-8'))

    # doubled runs whose rows are not exact copies
    groups = []   # (district, Day, runno, rows)
    blocks = set()
    for dist in manifest['districts']:
        for day in DAY_TYPES:
            p = os.path.join(data_dir, dist['name'], day + '.csv')
            if not os.path.exists(p):
                continue
            by = collections.defaultdict(list)
            for row in read(p):
                by[(row.get('runno') or '').strip()].append(row)
            for run, rows in by.items():
                uniq = []
                for row in rows:
                    if row not in uniq:
                        uniq.append(row)
                if len(uniq) > 1:
                    groups.append((dist['name'], day, run, uniq))
                    for row in uniq:
                        for i in range(1, 11):
                            if (row.get('b%d' % i) or '').strip():
                                blocks.add(row['b%d' % i].strip())

    trips = {}
    for r in read(os.path.join(gtfs, 'trips.txt')):
        if r['block_id'] in blocks:
            trips[r['trip_id']] = dict(block=r['block_id'], svc=r['service_id'],
                                       rt=rname.get(r['route_id'], r['route_id']), s=None, e=None)

    def gmin(t):
        h, m, _ = t.split(':')
        return int(h) * 60 + int(m)

    for r in read(os.path.join(gtfs, 'stop_times.txt')):
        t = trips.get(r['trip_id'])
        if t is None:
            continue
        x = gmin(r['arrival_time'] or r['departure_time'])
        t['s'] = x if t['s'] is None else min(t['s'], x)
        t['e'] = x if t['e'] is None else max(t['e'], x)

    by_block = collections.defaultdict(list)
    for t in trips.values():
        if t['s'] is not None and svc_days(t['svc']):
            by_block[t['block']].append(t)

    def clock(s):
        s = (s or '').strip()
        hm, ap = s.split()
        h, m = hm.split(':')
        return (int(h) % 12 + (12 if ap.upper() == 'PM' else 0)) * 60 + int(m)

    def pieces(row):
        out, prev = [], None
        for i in range(1, 11):
            b = (row.get('b%d' % i) or '').strip()
            if not b:
                continue
            a, e = clock(row['pot%d' % i]), clock(row['pit%d' % i])
            if prev is not None and a < prev - 600:
                a += 1440
            if e < a:
                e += 1440
            prev = e
            out.append((b, a, e))
        return out

    def covered(t, ps):
        for b, a, e in ps:
            for sh in (0, 1440, -1440):
                if t['block'] == b and a + sh - 3 <= t['s'] and t['e'] <= e + sh + 3:
                    return True
        return False

    def hm12(x):
        x %= 1440
        h, m = divmod(x, 60)
        return '%d:%02d %s' % (h % 12 or 12, m, 'AM' if h < 12 else 'PM')

    def day_text(days):
        idx = sorted(DOW.index(d) for d in days)
        runs, out = [], []
        for i in idx:
            if runs and i == runs[-1][-1] + 1:
                runs[-1].append(i)
            else:
                runs.append([i])
        for r in runs:
            if len(r) >= 3:
                out.append(DOW[r[0]] + '–' + DOW[r[-1]])
            else:
                out.extend(DOW[i] for i in r)
        return ', '.join(out)

    def trip_text(t):
        return 'Rt %s Block %s %s–%s' % (t['rt'], t['block'], hm12(t['s']), hm12(t['e']))

    def key(row):
        start = ' '.join((row.get('start') or '').split(' ')[1:3])
        finish = ' '.join((row.get('finish') or '').split(' ')[1:3])
        return '%s|%s|%s' % (start, finish, (row.get('pay') or '').strip())

    out_path = os.path.join(data_dir, 'run-variants.json')
    old = json.load(open(out_path, encoding='utf-8')) if os.path.exists(out_path) else {}
    picks = old.get('districts', {})
    for dist in manifest['districts']:
        picks.pop(dist['name'], None)

    found = unresolved = 0
    for dist, day, run, rows in groups:
        all_days = set(DAY_TYPES[day])
        ps = [pieces(r) for r in rows]
        cand = {id(t): t for b in {p[0] for pp in ps for p in pp} for t in by_block.get(b, [])}.values()
        only = []
        for i in range(len(rows)):
            others = [ps[j] for j in range(len(rows)) if j != i]
            only.append(sorted([t for t in cand if covered(t, ps[i]) and not all(covered(t, o) for o in others)],
                               key=lambda t: t['s']))
        days = []
        for i in range(len(rows)):
            d = set()
            for t in only[i]:
                d |= svc_days(t['svc']) & all_days
            days.append(d)
        known = set().union(*days)
        for i in range(len(rows)):
            if not days[i]:
                days[i] = all_days - known
        entries = []
        for i, row in enumerate(rows):
            if only[i]:
                why = 'Has the trip %s, which runs %s only (SEPTA timetable).' % (
                    trip_text(only[i][0]), day_text(svc_days(only[i][0]['svc']) & all_days))
            else:
                other = next((t for j in range(len(rows)) if j != i for t in only[j]), None)
                why = ('No trip %s here: that trip runs %s only (SEPTA timetable).' % (
                    trip_text(other), day_text(svc_days(other['svc']) & all_days))) if other else ''
            entries.append({'key': key(row), 'days': [d for d in DOW if d in days[i]],
                            'label': day_text(days[i]) if days[i] else '', 'why': why})
        ok = all(e['days'] for e in entries)
        found += 1
        unresolved += 0 if ok else 1
        picks.setdefault(dist, {}).setdefault(day.capitalize(), {})[run] = entries
        print('%-24s %-8s run %-4s %s' % (dist, day, run, ' | '.join(
            '%s pay %s -> %s' % (e['key'].split('|')[0], e['key'].split('|')[2], e['label'] or '?') for e in entries)))

    json.dump({'generated': datetime.date.today().isoformat(), 'gtfs_version': feed.get('feed_version', ''),
               'districts': picks}, open(out_path, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print('\n%d doubled runs with different versions, %d without a day match -> %s' % (found, unresolved, out_path))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
