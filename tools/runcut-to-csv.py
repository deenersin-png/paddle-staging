"""Turn SEPTA runcut PDFs into Paddle App CSVs.

    python tools/runcut-to-csv.py "C:/Users/deene/Documents/APP/Runcuts"
    python tools/runcut-to-csv.py IN_FOLDER --out OUT_FOLDER

Reads every *.pdf in IN_FOLDER (text PDFs made with Print To PDF) and writes
one CSV per PDF to OUT_FOLDER (default: IN_FOLDER/csv), named
District-Signup-EffDate-Day as printed (spaces -> dashes), in exactly the
format of the existing data/<depot>-<pick>/<day>.csv files:

  * same header, same 10 piece column sets (r1, b1, potype1, pot1, ...)
  * codes split from times: "O/A 119" -> potype O, pot "01:19 AM"
  * start / finish carry the fixed base date 2023-10-11 (start the day
    before when it falls before midnight, finish the day after when the
    run ends after midnight); start2N / leave / arrive are "H:MM" as printed
  * pullout2 / swingdur / swingdursec = first real break between pieces
    (gap after a piece that does not end in L or CG)

Layout family is read from each page: "R U N C U T R E P O R T" = City,
"R U N R E P O R T" with dotted labels = Suburban (extra COM columns,
dropped). Words are read by position, row by row, never as plain text.

Needs: pip install pdfplumber
"""

import argparse
import collections
import csv
import datetime as dt
import glob
import os
import re
import sys

import pdfplumber

BASE = dt.date(2023, 10, 11)   # the date every existing Paddle App CSV uses

HEADER_LINE = (
    "myid,depot,eff_date,day,pullout2,swingdur,swingdursec,runno,start,arrive,finish,"
    "worktime,pay,leave,"
    + ",".join(
        ("r1,b1,potype1,pot1,pitype1,pit1,stime1,stimeint1" if i == 1 else
         "start2%d,r%d,b%d,potype%d,pot%d,pitype%d,pit%d,stime%d,stimeint%d" % ((i,) * 9))
        for i in range(1, 11))
    + "," + "".join("sum%d, sum%d2," % (i, i) for i in range(1, 11))
)
HEADER = HEADER_LINE.split(",")        # last field is '' (trailing comma), as in the app's files
MAX_PIECES = 10

# Printed district -> the depot name the app already uses (myid is built from it).
# Anything not listed is written in title case, keeping short all-caps words (MSH, NHSL).
DEPOT_NAMES = {
    "ALLEGHENY": "Allegheny", "CALLOWHILL": "Callowhill", "COMLY": "Comly",
    "ELMWOOD": "Elmwood", "FRANKFORD": "Frankford", "FRANKFORD RAIL": "Frankford Rail",
    "FRONTIER": "Frontier", "MIDVALE": "Midvale", "SOUTHERN": "Southern",
    "VICTORY": "Victory Bus", "VICTORY BUS": "Victory Bus",
}

CITY_LEFT = ["run", "start", "leave", "route", "block", "po", "pi", "sched"]
CITY_RIGHT = ["start", "route", "block", "po", "pi", "sched", "arrive", "finish", "work", "pay"]
SUB_LEFT = CITY_LEFT + ["com"]
SUB_RIGHT = ["start", "route", "block", "po", "pi", "sched", "com", "arrive", "finish", "work", "pay"]

CODE_RE = re.compile(r"^([A-Za-z]+)\s*/\s*([A-Za-z]+)\s+(\d{1,4})$")


# ---------------------------------------------------------------- helpers
def depot_name(printed):
    p = " ".join(printed.split()).upper()
    if p in DEPOT_NAMES:
        return DEPOT_NAMES[p]
    return " ".join(w if (len(w) <= 4 and w not in ("RAIL", "BUS")) else w.capitalize()
                    for w in p.split())


def day_name(printed):
    d = printed.replace("*", "").strip().lower().split()
    if not d:
        return ""
    if d[0] == "alternate":
        rest = [w for w in d[1:] if w != "weekday"]
        return "-".join(["alternate"] + rest)
    return d[0]


def hm(raw):
    """'739' -> (7, 39). None when not a number."""
    raw = raw.strip()
    if not raw.isdigit():
        return None
    return int(raw[:-2] or 0), int(raw[-2:])


def hm_text(raw):
    v = hm(raw)
    return "%d:%02d" % v if v else ""


def clock12(mins):
    """minutes of day -> '01:19 AM'."""
    mins %= 1440
    h, m = divmod(mins, 60)
    return "%02d:%02d %s" % (h % 12 or 12, m, "AM" if h < 12 else "PM")


def stamp(absmin, pad):
    day = BASE + dt.timedelta(days=absmin // 1440)
    mins = absmin % 1440
    h, m = divmod(mins, 60)
    hh = h % 12 or 12
    return "%s %s:%02d %s" % (day.isoformat(), ("%02d" % hh) if pad else str(hh), m,
                              "AM" if h < 12 else "PM")


def parse_code(cell, side):
    """'O/A 119' (pullout) or 'A/ I 858' (pullin) -> (code, minutes-of-day, ampm_ok)."""
    m = CODE_RE.match(" ".join(cell.split()))
    if not m:
        return None
    a, b, t = m.group(1).upper(), m.group(2).upper(), m.group(3)
    code, ap = (a, b) if side == "po" else (b, a)
    h, mi = hm(t)
    if ap not in ("A", "P") or not (1 <= h <= 12) or mi > 59:
        return code, None, "%s (AM/PM letter %r)" % (cell.strip(), ap)
    return code, (h % 12) * 60 + mi + (720 if ap == "P" else 0), None


def nearest_back(raw, anchor):
    """Clock without AM/PM just before `anchor` (minutes): returns minutes before it."""
    v = hm(raw)
    if not v or not (1 <= v[0] <= 12):
        return None
    base = (v[0] % 12) * 60 + v[1]
    return min((anchor - c) % 1440 for c in (base, base + 720))


def nearest_fwd(raw, anchor):
    v = hm(raw)
    if not v or not (1 <= v[0] <= 12):
        return None
    base = (v[0] % 12) * 60 + v[1]
    return min((c - anchor) % 1440 for c in (base, base + 720))


# ---------------------------------------------------------------- page reading
def page_rows(page):
    """Rows of the table as lists of cell strings (split on the printed '|')."""
    lines = collections.defaultdict(list)
    for c in page.chars:
        lines[round(c["top"])].append(c)
    out = []
    for y in sorted(lines):
        cs = sorted(lines[y], key=lambda c: c["x0"])
        text = "".join(c["text"] for c in cs)
        if not text.startswith("|"):
            continue
        cells, cur = [], None
        for c in cs:
            if c["text"] == "|":
                if cur is not None:
                    cells.append(cur)
                cur = ""
            elif cur is not None:
                cur += c["text"]
        out.append((y, [x.strip() for x in cells]))
    return out


def header_fields(text):
    def grab(pat):
        m = re.search(pat, text, re.M)
        return " ".join(m.group(1).split()) if m else ""
    return {
        "route": grab(r"ROUTE[.\s]*:\s*(.+?)\s+SCHED"),
        "line": grab(r"LINE[.\s]*:\s*(.+?)\s+DAY"),
        "day": grab(r"DAY[.\s]*:\s*(.+?)\s+SUPERSED"),
        "district": grab(r"DISTRICT[.\s]*:\s*(.+?)\s+EFF"),
        "eff": grab(r"EFF[.\s]DATE[.\s]*:\s*(.+?)\s+(?:REVISION|CHANGE)"),
        "signup": grab(r"SIGNUP[.\s]*:\s*(.+?)(?:\s+RELIEF POINT.*)?$"),
    }


def family(text):
    head = "\n".join(text.splitlines()[:4])
    if "R U N C U T R E P O R T" in head and re.search(r"ROUTE\s+:", head):
        return "City"
    if "R U N R E P O R T" in head and re.search(r"ROUTE\.+:", head):
        return "Suburban"
    return None


# ---------------------------------------------------------------- one PDF
class Report:
    def __init__(self):
        self.lines = []
        self.by_rows = 0

    def add(self, s):
        self.lines.append(s)


def read_pdf(path, rep):
    name = os.path.basename(path)
    pdf = pdfplumber.open(path)
    info = None          # first header found
    fam_seen = set()
    runs = []            # ordered list of run dicts
    printed_runnos = []  # independent count of run-number cells
    issues = []
    cur = None
    cur_route = None
    for pno, page in enumerate(pdf.pages, 1):
        text = page.extract_text() or ""
        fam = family(text)
        if not fam:
            rep.add("  skipped page %d: unknown layout" % pno)
            continue
        h = header_fields(text)
        rows = page_rows(page)
        left, right = (CITY_LEFT, CITY_RIGHT) if fam == "City" else (SUB_LEFT, SUB_RIGHT)
        ncells = len(left) + 1 + len(right)
        # header row check
        if not rows or not any(len(c) == ncells and c[0] == "RUN" for _, c in rows):
            rep.add("  skipped page %d (route %s): table columns do not match the %s layout"
                    % (pno, h["route"], fam))
            continue
        data = [(y, c) for y, c in rows
                if (len(c) == ncells and c[0] not in ("RUN", "NO.")) or len(c) == 1]
        # report / notes pages
        lettered = any(re.fullmatch(r"[a-z]", c[left.index("com")] or "")
                       or re.fullmatch(r"[a-z]", c[len(left) + 1 + right.index("com")] or "")
                       for _, c in data) if fam == "Suburban" else False
        if "REPORT" in h["line"].upper() or "REPORT" in h["route"].upper() or lettered:
            why = "route line says REPORT" if "REPORT" in (h["line"] + h["route"]).upper() \
                else "lettered notes"
            rep.add("  skipped page %d (route %s): %s" % (pno, h["route"], why))
            continue
        fam_seen.add(fam)
        if info is None:
            info = dict(h, family=fam)
        else:
            for k in ("district", "signup", "eff", "day"):
                if h[k] != info[k]:
                    issues.append("page %d has %s %r (first page: %r)" % (pno, k, h[k], info[k]))
        if h["route"] != cur_route:
            cur, cur_route = None, h["route"]
        banner = ""
        for y, c in data:
            if len(c) == 1:                             # full-width note, e.g. FRIDAY ONLY
                if c[0] and not set(c[0]) <= set("-="):
                    banner = c[0]
                continue
            if all(set(x) <= set("-") for x in c):     # separator line ends a block
                cur = None
                continue
            L = dict(zip(left, c[:len(left)]))
            R = dict(zip(right, c[len(left) + 1:]))
            if not any(c):
                continue
            if any(x.upper() == "BY" for x in c):
                rep.by_rows += 1
                continue
            if L["run"]:
                printed_runnos.append(L["run"])
                cur = {"runno": L["run"], "route": h["route"], "page": pno,
                       "left": [], "right": [], "start": "", "leave": "",
                       "arrive": "", "finish": "", "work": "", "pay": "", "note": banner}
                banner = ""
                runs.append(cur)
            elif cur is None:
                if any(c):
                    issues.append("page %d: row without run number dropped: %s" % (pno, "|".join(c)))
                continue
            if L["start"] and not cur["start"]:
                cur["start"] = L["start"]
            if L["leave"] and not cur["leave"]:
                cur["leave"] = L["leave"]
            for k in ("arrive", "finish", "work", "pay"):
                if R[k]:
                    cur[k] = R[k]
            if L["po"] or L["pi"]:
                cur["left"].append(dict(L, start2=""))
            if R["po"] or R["pi"]:
                cur["right"].append(dict(R, start2=R["start"]))
            elif R["start"] and not (L["po"] or L["pi"]) and not cur["start"]:
                cur["start"] = R["start"]
    return info, sorted(fam_seen), runs, printed_runnos, issues


def build_row(run, info, depot, day, warn):
    pieces = run["left"] + run["right"]
    rn = run["runno"]
    if not pieces:
        warn("run %s: no pieces" % rn)
        return None
    if len(pieces) > MAX_PIECES:
        warn("run %s: %d pieces, only %d fit" % (rn, len(pieces), MAX_PIECES))
        pieces = pieces[:MAX_PIECES]
    out = {k: "" for k in HEADER}
    out.update(myid="%s%s%s" % (depot, day, rn), depot=depot, eff_date=info["eff"],
               day=day, runno=rn)
    # timeline: first pullout sits on the base date; every later time moves forward
    pos = []
    prev = None
    first_po = None
    for i, p in enumerate(pieces, 1):
        po = parse_code(p["po"], "po") if p["po"] else None
        pi = parse_code(p["pi"], "pi") if p["pi"] else None
        for side, v, cell in (("pullout", po, p["po"]), ("pullin", pi, p["pi"])):
            if cell and v is None:
                warn("run %s piece %d: %s %r not read" % (rn, i, side, cell))
            elif v and v[2]:
                warn("run %s piece %d: %s %s" % (rn, i, side, v[2]))
        rec = {"p": p, "po": po, "pi": pi}
        for key in ("po", "pi"):
            v = rec[key]
            if v and v[1] is not None:
                if prev is None:
                    a = v[1]
                else:
                    a = prev + (v[1] - prev) % 1440
                rec[key + "abs"] = a
                prev = a
                if first_po is None:
                    first_po = a
        pos.append(rec)
    if first_po is None:
        warn("run %s: no readable pullout/pullin time" % rn)
        return None
    # start
    if run["start"]:
        back = nearest_back(run["start"], first_po)
        if back is None:
            warn("run %s: start %r not read" % (rn, run["start"]))
        else:
            if back > 60:
                warn("run %s: start %s is %d min before first pullout" % (rn, hm_text(run["start"]), back))
            out["start"] = stamp(first_po - back, pad=True)
    else:
        warn("run %s: no start" % rn)
    # finish
    if run["finish"]:
        fwd = nearest_fwd(run["finish"], prev)
        if fwd is None:
            warn("run %s: finish %r not read" % (rn, run["finish"]))
        else:
            if fwd > 90:
                warn("run %s: finish %s is %d min after last pullin" % (rn, hm_text(run["finish"]), fwd))
            out["finish"] = stamp(prev + fwd, pad=False)
    else:
        warn("run %s: no finish" % rn)
    out["arrive"] = hm_text(run["arrive"])
    out["leave"] = hm_text(run["leave"])
    w = run["work"]
    out["worktime"] = w if "." in w else hm_text(w)
    out["pay"] = run["pay"]
    # pieces
    for i, rec in enumerate(pos, 1):
        p = rec["p"]
        s = hm(p["sched"])
        # "*" marks a note (e.g. "run contains work on PCC Trolley for RT G1"), not a route
        out["r%d" % i] = p["route"].replace("*", "").strip() or run["route"]
        out["b%d" % i] = p["block"]
        if rec["po"]:
            out["potype%d" % i] = rec["po"][0]
            if rec["po"][1] is not None:
                out["pot%d" % i] = clock12(rec["po"][1])
        if rec["pi"]:
            out["pitype%d" % i] = rec["pi"][0]
            if rec["pi"][1] is not None:
                out["pit%d" % i] = clock12(rec["pi"][1])
        out["stime%d" % i] = "%d:%02d" % s if s else ""
        out["stimeint%d" % i] = str(s[0] * 60 + s[1]) if s else ""
        if i > 1:
            out["start2%d" % i] = hm_text(p["start2"])
        out["sum%d" % i] = "RTE: %s SCHD: %s" % (out["r%d" % i], out["stime%d" % i])
        out[" sum%d2" % i] = "--> %s: %s > %s: %s" % (out["potype%d" % i], out["pot%d" % i],
                                                      out["pitype%d" % i], out["pit%d" % i])
        if s and "poabs" in rec and "piabs" in rec:
            length = rec["piabs"] - rec["poabs"]
            if abs(length - (s[0] * 60 + s[1])) > 5:
                warn("run %s piece %d: %s to %s is %d min, sched time says %d"
                     % (rn, i, out["pot%d" % i], out["pit%d" % i], length, s[0] * 60 + s[1]))
    # first real break
    for i in range(len(pos) - 1):
        a, b = pos[i], pos[i + 1]
        if a["pi"] and a["pi"][0] in ("L", "CG"):
            continue
        if "piabs" in a and "poabs" in b:
            gap = b["poabs"] - a["piabs"]
            if gap > 0:
                out["pullout2"] = clock12(b["poabs"])
                out["swingdur"] = "%dHrs %dMin" % divmod(gap, 60)
                out["swingdursec"] = str(gap * 60)
                break
    # pay sanity
    try:
        pay = float(run["pay"])
        if pay <= 0 or pay > 16:
            warn("run %s: pay hours %s look wrong" % (rn, run["pay"]))
        if w:
            wv = float(w) if "." in w else (lambda v: v[0] + v[1] / 60)(hm(w))
            if pay + 0.05 < wv:
                warn("run %s: pay %s is less than work time %s" % (rn, run["pay"], out["worktime"]))
    except (ValueError, TypeError):
        warn("run %s: pay hours %r not a number" % (rn, run["pay"]))
    return out


def safe_name(s):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s)
    return re.sub(r"\s+", "-", s.strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder")
    ap.add_argument("--out")
    a = ap.parse_args()
    out_dir = a.out or os.path.join(a.folder, "csv")
    os.makedirs(out_dir, exist_ok=True)
    rep = Report()
    unknown, names = [], collections.defaultdict(list)
    results = []
    for path in sorted(glob.glob(os.path.join(a.folder, "*.pdf"))):
        name = os.path.basename(path)
        sub = Report()
        info, fams, runs, printed, issues = read_pdf(path, sub)
        rep.by_rows += sub.by_rows
        if info is None:
            unknown.append(name)
            results.append((name, None, sub.lines, [], issues, None))
            continue
        depot, day = depot_name(info["district"]), day_name(info["day"])
        warns = list(issues)
        rows = [r for r in (build_row(run, info, depot, day, warns.append) for run in runs) if r]
        seen_rows, kept, same = set(), [], []
        for r in rows:                      # a copy printed again with the same times adds nothing
            k = tuple(r[h] for h in HEADER)
            if k in seen_rows:
                same.append(r["runno"])
                continue
            seen_rows.add(k)
            kept.append(r)
        rows = kept
        if same:
            warns.append("identical second copy dropped for run(s): %s" % ", ".join(same))
        cnt = collections.Counter(r["runno"] for r in rows)
        notes = {run["runno"]: run["note"] for run in runs if run["note"]}
        dup = ["%s%s" % (k, " (%s)" % notes[k] if k in notes else "") for k, v in cnt.items() if v > 1]
        if dup:
            warns.append("run versions (run listed more than once, all kept): %s" % ", ".join(dup))
        for k, n in notes.items():
            if cnt[k] == 1:
                warns.append("run %s has note %r" % (k, n))
        if len(set(printed)) != len(set(r["runno"] for r in rows)):
            warns.append("run count mismatch: %d run numbers printed, %d in CSV"
                         % (len(set(printed)), len(set(r["runno"] for r in rows))))
        fname = safe_name("%s-%s-%s-%s" % (info["district"], info["signup"], info["eff"],
                                           info["day"].replace("*", ""))) + ".csv"
        names[fname].append(name)
        results.append((name, info, sub.lines, rows, warns, fname, fams, depot, day))
    clash = {f: v for f, v in names.items() if len(v) > 1}
    print("RUNCUT EXTRACT REPORT  (%s -> %s)" % (a.folder, out_dir))
    for res in results:
        name, info = res[0], res[1]
        if info is None:
            print("\n%s: UNKNOWN LAYOUT, not processed" % name)
            for l in res[2]:
                print(l)
            continue
        _, info, skipped, rows, warns, fname, fams, depot, day = res
        print("\n%s: %s | district %s (depot %s) | day %s (%s) | eff %s | %d runs -> %s"
              % (name, "/".join(fams), info["district"], depot, info["day"], day,
                 info["eff"], len(rows), fname if fname not in clash else "NOT WRITTEN (name clash)"))
        for l in skipped:
            print(l)
        for w in warns:
            print("  ! " + w)
        if fname in clash:      # never overwrite: two PDFs with the same name are not written
            continue
        with open(os.path.join(out_dir, fname), "w", encoding="utf-8", newline="") as f:
            f.write(HEADER_LINE + "\n")
            wr = csv.writer(f, lineterminator="\n")
            for r in rows:
                wr.writerow([r[k] for k in HEADER])
    if unknown:
        print("\nUnknown layout (check by hand): " + ", ".join(unknown))
    for f, v in clash.items():
        print("\nNAME CLASH, nothing written for %s: %s" % (f, ", ".join(v)))
    print("\nBY rows dropped: %d" % rep.by_rows)


if __name__ == "__main__":
    main()
