#!/usr/bin/env python3
"""
Pull the live price feed for the dashboard into data/live.json.

Sources, no API keys, standard library only: front-month exchange futures via Yahoo Finance (daily),
falling back to FRED public CSVs (EIA daily spot, IMF monthly prices).
Runs daily in GitHub Actions (see .github/workflows/pages.yml). If a series fails to download,
the previous values are kept and flagged as stale, so one outage never blanks the page.

  python scripts/update_feed.py
"""
import csv, io, json, sys, time, urllib.parse, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "live.json"
START = "2024-07-01"
CLOSURE = "2026-02-27"  # last trading day before the Strait of Hormuz closure

# Each series lists providers in order of preference. The first that answers wins.
#   ("yahoo", symbol, multiplier, unit, note)  front-month futures, daily, no key
#   ("fred", series id, multiplier, unit, note) FRED public CSV, no key (EIA daily, IMF monthly)
SERIES = [
    ("BRENT", "Brent crude", "Energy", [("yahoo", "BZ=F", 1, "$/bbl", "ICE Brent futures"), ("fred", "DCOILBRENTEU", 1, "$/bbl", "EIA spot")]),
    ("WTI", "WTI crude", "Energy", [("yahoo", "CL=F", 1, "$/bbl", "NYMEX WTI futures"), ("fred", "DCOILWTICO", 1, "$/bbl", "EIA spot")]),
    ("DIESEL", "Diesel (NY Harbor ULSD)", "Energy", [("yahoo", "HO=F", 42, "$/bbl", "NYMEX ULSD futures"), ("fred", "DDFUELNYH", 42, "$/bbl", "EIA spot")]),
    ("HH", "Henry Hub gas", "Energy", [("yahoo", "NG=F", 1, "$/MMBtu", "NYMEX futures"), ("fred", "DHHNGSP", 1, "$/MMBtu", "EIA spot")]),
    ("TTF", "European gas (TTF)", "Energy", [("yahoo", "TTF=F", 1, "EUR/MWh", "ICE TTF futures"), ("fred", "PNGASEUUSDM", 1, "$/MMBtu", "IMF monthly")]),
    ("LNGASIA", "LNG Asia", "Energy", [("fred", "PNGASJPUSDM", 1, "$/MMBtu", "IMF monthly")]),
    ("COPPER", "Copper", "Metals", [("yahoo", "HG=F", 2204.62, "$/t", "COMEX futures"), ("fred", "PCOPPUSDM", 1, "$/t", "IMF monthly")]),
    ("NICKEL", "Nickel", "Metals", [("fred", "PNICKUSDM", 1, "$/t", "IMF monthly")]),
    ("WHEAT", "Wheat", "Food", [("yahoo", "ZW=F", 0.367437, "$/t", "CBOT futures"), ("fred", "PWHEAMTUSDM", 1, "$/t", "IMF monthly")]),
    ("MAIZE", "Maize", "Food", [("yahoo", "ZC=F", 0.393679, "$/t", "CBOT futures"), ("fred", "PMAIZMTUSDM", 1, "$/t", "IMF monthly")]),
    ("RICE", "Rice", "Food", [("yahoo", "ZR=F", 22.0462, "$/t", "CBOT rough rice futures"), ("fred", "PRICENPQUSDM", 1, "$/t", "IMF monthly")]),
    ("SOY", "Soybeans", "Food", [("yahoo", "ZS=F", 0.367437, "$/t", "CBOT futures"), ("fred", "PSOYBUSDM", 1, "$/t", "IMF monthly")]),
]

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"


def get(url, timeout=12, tries=2):
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            err = e
            time.sleep(1.5 * (k + 1))
    raise err


def from_fred(sid, mult):
    text = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={START}")
    return parse(text, mult)


def from_yahoo(sym, mult):
    j = json.loads(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=2y&interval=1d"))
    res = j["chart"]["result"][0]
    out = {}
    for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if c is not None:
            out[datetime.fromtimestamp(t, timezone.utc).date().isoformat()] = round(c * mult, 3)
    return sorted(out.items())


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
    for key, label, group, providers in SERIES:
        got = None
        for src, sym, mult, unit, note in providers:
            try:
                pts = from_yahoo(sym, mult) if src == "yahoo" else from_fred(sym, mult)
                if len(pts) < 5:
                    raise ValueError("too few observations")
                got = summarise(key, label, unit, group, f"{note} ({sym})", pts)
                print(f"  {key:<8} {src:<5} {sym:<13} {pts[-1][0]}  {pts[-1][1]}", flush=True)
                break
            except Exception as e:
                print(f"  {key:<8} {src:<5} {sym:<13} failed: {str(e)[:80]}", flush=True)
        if got:
            out.append(got); ok += 1
        elif key in old:
            out.append(old[key] | {"stale": True})
    by = {s["id"]: s for s in out}
    if "DIESEL" in by and "BRENT" in by and not by["DIESEL"]["stale"] and not by["BRENT"]["stale"]:
        b = dict(map(tuple, by["BRENT"]["points"]))
        pts = [(d, round(v - b[d], 2)) for d, v in by["DIESEL"]["points"] if d in b]
        if len(pts) >= 5:
            s = summarise("CRACK", "Diesel crack vs Brent", "$/bbl", "Energy", "Derived: ULSD minus Brent", pts)
            s["chg_prewar"] = round(s["latest"] - s["prewar"], 2) if s["prewar"] is not None else None
            s["chg_1m"] = None
            s["absolute_change"] = True
            out.insert(3, s)
    if ok == 0:
        print("All downloads failed. Keeping the previous feed.", flush=True)
        return 0
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "closure": CLOSURE,
        "source": "Exchange futures via Yahoo Finance and FRED (EIA, IMF)",
        "series": out,
    }, separators=(",", ":")))
    print(f"Wrote data/{OUT.name}: {ok}/{len(SERIES)} series fresh", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
