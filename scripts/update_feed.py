#!/usr/bin/env python3
"""
Pull the live price feed for the dashboard into data/live.json.

Source: FRED (Federal Reserve Bank of St. Louis) public CSV downloads. No API key, standard library only.
Daily series come from the EIA, monthly series from the IMF Primary Commodity Prices release.
Runs daily in GitHub Actions (see .github/workflows/pages.yml). If a series fails to download,
the previous values are kept and flagged as stale, so one outage never blanks the page.

  python scripts/update_feed.py
"""
import csv, io, json, sys, time, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "live.json"
START = "2024-07-01"
CLOSURE = "2026-02-27"  # last trading day before the Strait of Hormuz closure

# id, label, unit, group, multiplier, note
SERIES = [
    ("DCOILBRENTEU", "Brent crude", "$/bbl", "Energy", 1, "EIA spot, daily"),
    ("DCOILWTICO", "WTI crude", "$/bbl", "Energy", 1, "EIA spot, daily"),
    ("DDFUELNYH", "Diesel (NY Harbor ULSD)", "$/bbl", "Energy", 42, "EIA spot, daily, converted from $/gal"),
    ("DHHNGSP", "Henry Hub gas", "$/MMBtu", "Energy", 1, "EIA spot, daily"),
    ("PNGASJPUSDM", "LNG Asia", "$/MMBtu", "Energy", 1, "IMF, monthly"),
    ("PNGASEUUSDM", "European gas", "$/MMBtu", "Energy", 1, "IMF, monthly"),
    ("PCOPPUSDM", "Copper", "$/t", "Metals", 1, "IMF, monthly average"),
    ("PNICKUSDM", "Nickel", "$/t", "Metals", 1, "IMF, monthly average"),
    ("PWHEAMTUSDM", "Wheat", "$/t", "Food", 1, "IMF, monthly"),
    ("PMAIZMTUSDM", "Maize", "$/t", "Food", 1, "IMF, monthly"),
    ("PRICENPQUSDM", "Rice", "$/t", "Food", 1, "IMF, monthly"),
    ("PSOYBUSDM", "Soybeans", "$/t", "Food", 1, "IMF, monthly"),
]


def fetch(sid, tries=3):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={START}"
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "chokepoint-ledger/1.0 (educational dashboard)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # network hiccup, retry with backoff
            err = e
            time.sleep(2 * (k + 1))
    raise err


def parse(text, mult):
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2 or not row[0][:4].isdigit():
            continue  # header ("DATE" or "observation_date") or blank
        try:
            rows.append((row[0], round(float(row[1]) * mult, 3)))
        except ValueError:
            continue  # FRED marks missing days with "."
    return rows


def thin(points, max_points=160):
    """Keep sparklines light: weekly for daily series, all points for monthly."""
    if len(points) <= max_points:
        return points
    out, last = [], None
    for d, v in points:
        wk = datetime.fromisoformat(d).isocalendar()[:2]
        if wk != last:
            out.append([d, v]); last = wk
        else:
            out[-1] = [d, v]
    return out[-max_points:]


def value_on_or_before(points, day):
    prior = [v for d, v in points if d <= day]
    return prior[-1] if prior else None


def summarise(sid, label, unit, group, note, points):
    latest_d, latest_v = points[-1]
    pre = value_on_or_before(points, CLOSURE)
    month_ago = (date.fromisoformat(latest_d) - timedelta(days=30)).isoformat()
    m1 = value_on_or_before(points, month_ago)
    return {
        "id": sid, "label": label, "unit": unit, "group": group, "note": note,
        "latest": latest_v, "date": latest_d, "prewar": pre,
        "chg_prewar": round(latest_v / pre - 1, 4) if pre else None,
        "chg_1m": round(latest_v / m1 - 1, 4) if m1 else None,
        "points": thin(points), "stale": False,
    }


def main():
    old = {}
    if OUT.exists():
        try:
            old = {s["id"]: s for s in json.loads(OUT.read_text())["series"]}
        except Exception:
            pass
    out, ok = [], 0
    for sid, label, unit, group, mult, note in SERIES:
        try:
            pts = parse(fetch(sid), mult)
            if not pts:
                raise ValueError("no observations")
            out.append(summarise(sid, label, unit, group, note, pts)); ok += 1
            print(f"  {sid:<14} {pts[-1][0]}  {pts[-1][1]}")
        except Exception as e:
            print(f"  {sid:<14} FAILED ({e})", file=sys.stderr)
            if sid in old:
                out.append(old[sid] | {"stale": True})
    # derived: diesel crack versus Brent, the refining margin signal discussed in the analysis
    by = {s["id"]: s for s in out}
    if "DDFUELNYH" in by and "DCOILBRENTEU" in by:
        b = dict(by["DCOILBRENTEU"]["points"])
        pts = [[d, round(v - b[d], 2)] for d, v in by["DDFUELNYH"]["points"] if d in b]
        if pts:
            s = summarise("CRACK", "Diesel crack vs Brent", "$/bbl", "Energy", "Derived: NY Harbor ULSD minus Brent", pts)
            s["chg_prewar"] = round(s["latest"] - s["prewar"], 2) if s["prewar"] is not None else None
            s["chg_1m"] = None
            s["absolute_change"] = True
            out.insert(3, s)
    if ok == 0 and old:
        print("All downloads failed. Keeping the previous feed.", file=sys.stderr)
        return 0
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "closure": CLOSURE,
        "source": "FRED, Federal Reserve Bank of St. Louis (EIA and IMF data)",
        "series": out,
    }, separators=(",", ":")))
    print(f"Wrote data/{OUT.name}: {ok}/{len(SERIES)} series fresh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
