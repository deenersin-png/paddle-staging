"""Build a Paddle App pdfs.csv: which page of SEPTA's paddle PDF each run starts on.

The app opens the run's own paddle page from these links (see
loadPaddleLinks in assets/pa-schedule.js). Each paddle PDF page has a
header like

    Dist: CALLOWHILL   D R I V E R   P A D D L E   Page: 1 of 2
    Route : 21-42 ...                               Run #: 129
    Line  : ...                                     Service : SATURDAY

and the run's first page ("Page: 1 of N") is the one linked.

Easiest: give the pick and the district's folder on www4.septa.org, and the
script downloads weekday, saturday and sunday paddles itself:

    python tools/paddle-links.py --pick fall-a-2026 --district elmwood --out data/elmwood-fall-2026/pdfs.csv
    python tools/paddle-links.py --pick fall-a-2026 --district callowhill/bus --out data/callowhillb-fall-2026/pdfs.csv

Or give the paddle PDF links yourself (any number, any day):

    python tools/paddle-links.py --out pdfs.csv https://www4.septa.org/picking/pdf/fall-a-2026/elmwood/paddles/weekday-paddles.pdf

Already downloaded the PDFs? Put them in one folder, keep SEPTA's file names
(weekday-paddles.pdf ...) and add  --pdf-folder FOLDER : those files are read
instead of downloading, the links still point to SEPTA.

Needs: pip install pdfplumber
"""

import argparse
import collections
import csv
import os
import re
import sys
import tempfile
import urllib.request

import pdfplumber

SITE = "https://www4.septa.org/picking/pdf/"
DAYS = ("weekday", "saturday", "sunday")

# Printed district -> the depot name the app uses (myid and the depot column).
DEPOT_NAMES = {
    "ALLEGHENY": "Allegheny", "CALLOWHILL": "Callowhill", "COMLY": "Comly",
    "ELMWOOD": "Elmwood", "FRANKFORD": "Frankford", "FRANKFORD RAIL": "Frankford Rail",
    "FRONTIER": "Frontier", "MIDVALE": "Midvale", "SOUTHERN": "Southern",
    "VICTORY": "Victory Bus", "VICTORY BUS": "Victory Bus",
}
HEADER = ["myid", "runno", "depot", "page_1", "page", "day", "moblink", "pclink", "Trip Sheet"]


def depot_name(printed, override=None):
    if override:
        return override
    p = " ".join(printed.split()).upper()
    if p in DEPOT_NAMES:
        return DEPOT_NAMES[p]
    return " ".join(w if (len(w) <= 4 and w not in ("RAIL", "BUS")) else w.capitalize()
                    for w in p.split())


def day_label(service):
    """'SATURDAY' -> 'Saturday', '*ALTERNATE SUNDAY' -> 'Alternate-sunday' (matches the app's dayLabel)."""
    d = service.replace("*", "").strip().lower().split()
    if not d:
        return ""
    if d[0] == "alternate":
        d = ["alternate"] + [w for w in d[1:] if w != "weekday"]
    s = "-".join(d)
    return s[:1].upper() + s[1:]


def fetch(url, folder):
    """Local copy of the PDF at `url`: from --pdf-folder if there, else downloaded."""
    name = url.rsplit("/", 1)[-1]
    if folder:
        p = os.path.join(folder, name)
        if os.path.exists(p):
            return p, False
        print("  %s not in %s, downloading" % (name, folder))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (paddle-links)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if not data.startswith(b"%PDF"):
        raise ValueError("not a PDF (got %d bytes starting %r)" % (len(data), data[:20]))
    fd, p = tempfile.mkstemp(suffix=".pdf")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return p, True


def grab(pat, text):
    m = re.search(pat, text, re.M)
    return " ".join(m.group(1).split()) if m else ""


def read_paddles(path, url, depot_override, warn):
    """Rows for every run that starts in this paddle PDF."""
    rows, seen = [], {}
    pclink_base = url[:-4] if url.lower().endswith(".pdf") else url
    trip = re.sub(r"/paddles/([^/]+)-paddles\.pdf$", r"/trip-sheets/\1-trip-sheets.pdf", url)
    if trip == url:
        trip = ""
    with pdfplumber.open(path) as pdf:
        for pno, page in enumerate(pdf.pages, 1):
            text = page.extract_text() or ""
            run = grab(r"Run\s*#\s*:\s*(\w+)", text)
            pg = re.search(r"Page\s*:\s*(\d+)\s*of\s*(\d+)", text)
            if not run or not pg:
                if "P A D D L E" in text or "PADDLE" in text.upper():
                    warn("page %d: no Run # / Page found" % pno)
                continue
            if pg.group(1) != "1":
                continue
            service = grab(r"Service\s*:\s*(.+?)\s*$", text)
            dist = grab(r"Dist\s*:\s*(.+?)\s+D R I V E R", text) or grab(r"Dist\s*:\s*(\S+)", text)
            day, depot = day_label(service), depot_name(dist, depot_override)
            key = (day, run)
            if key in seen:
                warn("run %s (%s) starts again on page %d (first on page %d); the app links the first"
                     % (run, day, pno, seen[key]))
                continue
            seen[key] = pno
            rows.append({
                "myid": "%s%s%s" % (depot, day, run), "runno": run, "depot": depot,
                "page_1": "1 of %s" % pg.group(2), "page": str(pno), "day": day,
                "moblink": "%s#page=%d" % (url, pno),
                "pclink": "%s#page=%d.pdf" % (pclink_base, pno),
                "Trip Sheet": trip,
            })
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("urls", nargs="*", help="paddle PDF links on www4.septa.org")
    ap.add_argument("--pick", help="pick folder on SEPTA's site, e.g. fall-a-2026")
    ap.add_argument("--district", help="district folder, e.g. elmwood, callowhill/bus, frankford/rail")
    ap.add_argument("--days", default=",".join(DAYS), help="with --pick: days to fetch (default weekday,saturday,sunday)")
    ap.add_argument("--depot", help="depot name to write (default: from the PDF's Dist:, e.g. Allegheny)")
    ap.add_argument("--pdf-folder", help="read already-downloaded PDFs from here instead of downloading")
    ap.add_argument("--out", required=True, help="pdfs.csv to write")
    a = ap.parse_args()

    urls = list(a.urls)
    if a.pick or a.district:
        if not (a.pick and a.district):
            ap.error("--pick and --district go together")
        base = SITE + a.pick.strip("/") + "/" + a.district.strip("/") + "/paddles/"
        urls += [base + d.strip() + "-paddles.pdf" for d in a.days.split(",") if d.strip()]
    if not urls:
        ap.error("give paddle PDF links, or --pick and --district")

    all_rows, problems = [], 0
    for url in urls:
        print(url)
        warns = []
        try:
            path, temp = fetch(url, a.pdf_folder)
        except Exception as e:
            print("  ! could not get it: %s" % e)
            problems += 1
            continue
        try:
            rows = read_paddles(path, url, a.depot, warns.append)
        finally:
            if temp:
                os.remove(path)
        days = collections.Counter(r["day"] for r in rows)
        print("  %d runs (%s)" % (len(rows), ", ".join("%s %d" % kv for kv in days.items()) or "none"))
        for w in warns:
            print("  ! " + w)
        if not rows:
            problems += 1
        all_rows += rows

    if not all_rows:
        print("nothing found, %s not written" % a.out)
        sys.exit(1)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HEADER, lineterminator="\n")
        w.writeheader()
        w.writerows(all_rows)
    print("wrote %d rows to %s%s" % (len(all_rows), a.out, " (%d file(s) had problems)" % problems if problems else ""))


if __name__ == "__main__":
    main()
