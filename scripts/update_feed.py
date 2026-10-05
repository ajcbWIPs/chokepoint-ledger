#!/usr/bin/env python3
"""
Build the dashboard's live price feed, data/live.json. Runs daily in GitHub Actions.

Sources (both free):
  1. World Bank Commodity Price Data ("Pink Sheet"), monthly averages, no key. Updated early each month.
     Covers crude, gas, LNG, fertilisers (urea, DAP, potash, phosphate rock), metals and grains.
  2. EIA Open Data API v2, daily spot prices for Brent, WTI, NY Harbor diesel and Henry Hub.
     Optional: only used when an EIA_API_KEY secret is set (free key: https://www.eia.gov/opendata/register.php).
     Daily series replace the monthly ones for the same commodity and enable the diesel crack.

If a source fails, the previous values are kept and flagged STALE, so the page never goes blank.
Needs: pip install openpyxl
"""
import io, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "live.json"
START = "2024-07-01"
CLOSURE = "2026-02-27"  # last trading day before the Strait of Hormuz closure
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"
WB_PAGE = "https://www.worldbank.org/en/research/commodity-markets"

# key, label, group, World Bank column name (prefix match), EIA daily spec (route, series, multiplier) or None, unit
SERIES = [
    ("BRENT", "Brent crude", "Energy", "Crude oil, Brent", ("petroleum/pri/spt", "RBRTE", 1), "$/bbl"),
    ("WTI", "WTI crude", "Energy", "Crude oil, WTI", ("petroleum/pri/spt", "RWTC", 1), "$/bbl"),
    ("DIESEL", "Diesel (NY Harbor ULSD)", "Energy", None, ("petroleum/pri/spt", "EER_EPD2DXL0_PF4_Y35NY_DPG", 42), "$/bbl"),
    ("HH", "Henry Hub gas", "Energy", "Natural gas, US", ("natural-gas/pri/fut", "RNGWHHD", 1), "$/MMBtu"),
    ("EUGAS", "European gas", "Energy", "Natural gas, Europe", None, "$/MMBtu"),
    ("LNGASIA", "LNG Asia (Japan)", "Energy", "Liquefied natural gas", None, "$/MMBtu"),
    ("UREA", "Urea", "Fertiliser", "Urea", None, "$/t"),
    ("DAP", "DAP", "Fertiliser", "DAP", None, "$/t"),
    ("POTASH", "Potash (KCl)", "Fertiliser", "Potassium chloride", None, "$/t"),
    ("PROCK", "Phosphate rock", "Fertiliser", "Phosphate rock", None, "$/t"),
    ("COPPER", "Copper", "Metals", "Copper", None, "$/t"),
    ("NICKEL", "Nickel", "Metals", "Nickel", None, "$/t"),
    ("WHEAT", "Wheat (US HRW)", "Food", "Wheat, US HRW", None, "$/t"),
    ("MAIZE", "Maize", "Food", "Maize", None, "$/t"),
    ("RICE", "Rice (Thai 5%)", "Food", "Rice, Thai 5%", None, "$/t"),
    ("SOY", "Soybeans", "Food", "Soybeans", None, "$/t"),
]


def get(url, timeout=30, tries=2, binary=False):
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                return data if binary else data.decode("utf-8", "replace")
        except Exception as e:
            err = e
            time.sleep(2 * (k + 1))
    raise err


# ---------------------------------------------------------------- World Bank Pink Sheet (monthly)
def parse_pink_sheet(rows):
    hdr_i = next(i for i, r in enumerate(rows) if any(isinstance(c, str) and c.strip().startswith("Crude oil, Brent") for c in r))
    names = [re.sub(r"\*+", "", str(c or "")).strip() for c in rows[hdr_i]]
    stamp = next((str(r[0]) for r in rows[:hdr_i] if r and r[0] and "Updated" in str(r[0])), "")
    cols = {}
    for r in rows[hdr_i + 2:]:
        m = re.match(r"^(\d{4})M(\d{2})$", str(r[0] or ""))
        if not m:
            continue
        d = f"{m.group(1)}-{m.group(2)}-01"
        if d < START:
            continue
        for j, name in enumerate(names):
            if not name or j >= len(r):
                continue
            try:
                cols.setdefault(name, []).append((d, round(float(r[j]), 3)))
            except (TypeError, ValueError):
                pass  # "…" marks missing values
    return cols, stamp


def world_bank():
    import openpyxl
    page = get(WB_PAGE)
    links = re.findall(r'https://thedocs\.worldbank\.org[^"\']*CMO-Historical-Data-Monthly\.xlsx', page)
    if not links:
        raise RuntimeError("Pink Sheet link not found on the World Bank page")
    wb = openpyxl.load_workbook(io.BytesIO(get(links[0], timeout=60, binary=True)), read_only=True, data_only=True)
    return parse_pink_sheet(list(wb["Monthly Prices"].iter_rows(values_only=True)))


def wb_series(cols, prefix):
    for name, pts in cols.items():
        if name.lower().startswith(prefix.lower()):
            return pts
    return None


# ---------------------------------------------------------------- EIA API v2 (daily, optional key)
def eia(route, series, mult, key):
    q = urllib.parse.urlencode({
        "api_key": key, "frequency": "daily", "data[0]": "value", "facets[series][]": series,
        "start": START, "sort[0][column]": "period", "sort[0][direction]": "asc", "length": 5000,
    })
    j = json.loads(get(f"https://api.eia.gov/v2/{route}/data/?{q}"))
    return [(r["period"], round(float(r["value"]) * mult, 3)) for r in j["response"]["data"] if r.get("value") is not None]


# ---------------------------------------------------------------- summaries
def thin(points, max_points=160):
    if len(points) <= max_points:
        return [list(p) for p in points]
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


def summarise(key, label, unit, group, note, points, freq):
    latest_d, latest_v = points[-1]
    pre = value_on_or_before(points, CLOSURE if freq == "daily" else "2026-02-01")
    back = (date.fromisoformat(latest_d) - timedelta(days=30 if freq == "daily" else 28)).isoformat()
    m1 = value_on_or_before(points, back)
    return {
        "id": key, "label": label, "unit": unit, "group": group, "note": note, "freq": freq,
        "latest": latest_v, "date": latest_d if freq == "daily" else latest_d[:7], "prewar": pre,
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
    try:
        cols, stamp = world_bank()
        print(f"World Bank Pink Sheet: {len(cols)} columns. {stamp}", flush=True)
    except Exception as e:
        cols, stamp = {}, ""
        print(f"World Bank Pink Sheet failed: {e}", flush=True)
    key = os.environ.get("EIA_API_KEY", "").strip()
    if not key:
        print("No EIA_API_KEY secret, so daily prices are skipped (monthly World Bank data still used).", flush=True)

    out, fresh, sources = [], 0, set()
    for k, label, group, wb_name, eia_spec, unit in SERIES:
        got = None
        if key and eia_spec:
            try:
                pts = eia(*eia_spec, key)
                if len(pts) > 5:
                    got = summarise(k, label, unit, group, "EIA daily spot", pts, "daily"); sources.add("EIA")
            except Exception as e:
                print(f"  {k}: EIA failed ({str(e)[:80]})", flush=True)
        if not got and wb_name and cols:
            pts = wb_series(cols, wb_name)
            if pts and len(pts) > 3:
                got = summarise(k, label, unit, group, "World Bank monthly average", pts, "monthly"); sources.add("World Bank")
        if got:
            out.append(got); fresh += 1
            print(f"  {k:<8} {got['date']}  {got['latest']}  ({got['note']})", flush=True)
        elif k in old:
            out.append(old[k] | {"stale": True})

    by = {s["id"]: s for s in out}
    if all(i in by and by[i]["freq"] == "daily" and not by[i]["stale"] for i in ("DIESEL", "BRENT")):
        b = dict(map(tuple, by["BRENT"]["points"]))
        pts = [(d, round(v - b[d], 2)) for d, v in by["DIESEL"]["points"] if d in b]
        if len(pts) > 5:
            s = summarise("CRACK", "Diesel crack vs Brent", "$/bbl", "Energy", "Derived: ULSD minus Brent", pts, "daily")
            s["chg_prewar"] = round(s["latest"] - s["prewar"], 2) if s["prewar"] is not None else None
            s["chg_1m"], s["absolute_change"] = None, True
            out.insert(3, s)

    if fresh == 0:
        print("Nothing downloaded. Keeping the previous feed.", flush=True)
        return 0
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "closure": CLOSURE,
        "source": " and ".join(sorted(sources, reverse=True)) + (f" ({stamp.strip()})" if stamp else ""),
        "series": out,
    }, separators=(",", ":")))
    print(f"Wrote data/{OUT.name}: {fresh}/{len(SERIES)} series fresh", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
