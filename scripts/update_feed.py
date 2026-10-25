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
    ("COAL", "Coal (Newcastle)", "Energy", "Coal, Australian", None, "$/t"),
    ("URANIUM", "Uranium (U3O8)", "Energy", "imf:PURAN", None, "$/lb"),
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
UNITS = {}  # Pink Sheet column name -> unit string from the row under the header


def parse_pink_sheet(rows):
    """Every monthly observation back to 1960. Callers trim to START for the live strip."""
    hdr_i = next(i for i, r in enumerate(rows) if any(isinstance(c, str) and c.strip().startswith("Crude oil, Brent") for c in r))
    names = [re.sub(r"\*+", "", str(c or "")).strip() for c in rows[hdr_i]]
    for j, u in enumerate(rows[hdr_i + 1]):
        if j < len(names) and names[j] and u:
            UNITS[names[j]] = str(u).strip().strip("()")
    stamp = next((str(r[0]) for r in rows[:hdr_i] if r and r[0] and "Updated" in str(r[0])), "")
    cols = {}
    for r in rows[hdr_i + 2:]:
        m = re.match(r"^(\d{4})M(\d{2})$", str(r[0] or ""))
        if not m:
            continue
        d = f"{m.group(1)}-{m.group(2)}-01"
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


def wb_series(cols, prefix, full=False):
    for name, pts in cols.items():
        if name.lower().startswith(prefix.lower()):
            return pts if full else [p for p in pts if p[0] >= START]
    return None


def wb_name(cols, prefix):
    return next((n for n in cols if n.lower().startswith(prefix.lower())), None)


# ---------------------------------------------------------------- IMF Primary Commodity Prices (monthly, no key)
IMF_URL = "https://api.imf.org/external/sdmx/2.1/data/IMF.RES,PCPS/G001.{ids}.USD.M?startPeriod=1960"


def imf(ids):
    import csv
    req = urllib.request.Request(IMF_URL.format(ids="+".join(ids)), headers={"User-Agent": UA, "Accept": "application/vnd.sdmx.data+csv;version=1.0.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8", "replace")
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        m = re.match(r"^(\d{4})-M(\d{2})$", row.get("TIME_PERIOD") or "")
        try:
            v = float(row["OBS_VALUE"])
        except (TypeError, ValueError, KeyError):
            continue
        if m:
            out.setdefault(row["INDICATOR"], []).append((f"{m.group(1)}-{m.group(2)}-01", v))
    return {k: sorted(v) for k, v in out.items()}


# ---------------------------------------------------------------- US CPI for inflation-adjusted views
def imf_cpi():
    """US all-items CPI from the IMF CPI dataset (no key). BLS is the fallback."""
    import csv
    url = "https://api.imf.org/external/sdmx/2.1/data/IMF.STA,CPI/USA.CPI._T.IX.M?startPeriod=1955"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.sdmx.data+csv;version=1.0.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        text = r.read().decode("utf-8", "replace")
    pts = []
    for row in csv.DictReader(io.StringIO(text)):
        m = re.match(r"^(\d{4})-M(\d{2})$", row.get("TIME_PERIOD") or "")
        try:
            v = float(row["OBS_VALUE"])
        except (TypeError, ValueError, KeyError):
            continue
        if m:
            pts.append((f"{m.group(1)}-{m.group(2)}-01", v))
    if len(pts) < 100:
        raise RuntimeError(f"IMF CPI returned {len(pts)} months")
    return sorted(pts)


CPI_SRC = ["US CPI, all items (IMF CPI dataset)"]


def us_cpi():
    try:
        return imf_cpi()
    except Exception as e:
        print(f"IMF CPI failed ({e}), trying BLS", flush=True)
    CPI_SRC[0] = "US CPI-U, all items (BLS)"
    return bls_cpi()


def bls_cpi():
    pts = []
    this_year = date.today().year
    for y0 in range(1960, this_year + 1, 10):
        body = json.dumps({"seriesid": ["CUUR0000SA0"], "startyear": str(y0), "endyear": str(min(y0 + 9, this_year))}).encode()
        req = urllib.request.Request("https://api.bls.gov/publicAPI/v1/timeseries/data/", data=body, headers={"Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=40) as r:
            j = json.loads(r.read())
        for o in j["Results"]["series"][0]["data"]:
            if o["period"].startswith("M") and o["period"] != "M13":
                pts.append((f"{o['year']}-{o['period'][1:]}-01", float(o["value"])))
        time.sleep(1)
    return sorted(pts)


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


# ---------------------------------------------------------------- long history (data/history.json)
HIST_OUT = ROOT / "data" / "history.json"
# id, label, group, source ("wb:<Pink Sheet column prefix>" or "imf:<PCPS code>"), unit override or None
HISTORY = [
    ("BRENT", "Brent crude", "Energy", "wb:Crude oil, Brent", "$/bbl"),
    ("WTI", "WTI crude", "Energy", "wb:Crude oil, WTI", "$/bbl"),
    ("DUBAI", "Dubai crude", "Energy", "wb:Crude oil, Dubai", "$/bbl"),
    ("CRUDEAVG", "Crude oil, average of three", "Energy", "wb:Crude oil, average", "$/bbl"),
    ("HH", "Henry Hub gas", "Energy", "wb:Natural gas, US", "$/MMBtu"),
    ("EUGAS", "European gas (TTF)", "Energy", "wb:Natural gas, Europe", "$/MMBtu"),
    ("LNGASIA", "LNG Japan", "Energy", "wb:Liquefied natural gas", "$/MMBtu"),
    ("COAL", "Coal, Newcastle", "Energy", "wb:Coal, Australian", "$/t"),
    ("COALSA", "Coal, Richards Bay", "Energy", "wb:Coal, South African", "$/t"),
    ("URANIUM", "Uranium (U3O8 spot)", "Energy", "imf:PURAN", "$/lb"),
    ("PROPANE", "Propane (Mont Belvieu)", "Energy", "imf:PPROPANE", "$/gal"),
    ("UREA", "Urea", "Fertiliser", "wb:Urea", "$/t"),
    ("DAP", "DAP", "Fertiliser", "wb:DAP", "$/t"),
    ("TSP", "Triple superphosphate", "Fertiliser", "wb:TSP", "$/t"),
    ("POTASH", "Potash (KCl)", "Fertiliser", "wb:Potassium chloride", "$/t"),
    ("PROCK", "Phosphate rock", "Fertiliser", "wb:Phosphate rock", "$/t"),
    ("COPPER", "Copper", "Metals", "wb:Copper", "$/t"),
    ("NICKEL", "Nickel", "Metals", "wb:Nickel", "$/t"),
    ("ALUMINIUM", "Aluminium", "Metals", "wb:Aluminum", "$/t"),
    ("IRONORE", "Iron ore", "Metals", "wb:Iron ore", "$/dmt"),
    ("ZINC", "Zinc", "Metals", "wb:Zinc", "$/t"),
    ("LEAD", "Lead", "Metals", "wb:Lead", "$/t"),
    ("TIN", "Tin", "Metals", "wb:Tin", "$/t"),
    ("COBALT", "Cobalt", "Metals", "imf:PCOBA", "$/t"),
    ("LITHIUM", "Lithium (IMF benchmark)", "Metals", "imf:PLITH", "$/t"),
    ("MOLY", "Molybdenum", "Metals", "imf:PLMMODY", "$/t"),
    ("REE", "Rare earths (IMF basket)", "Metals", "imf:PREODOM", "$/t"),
    ("GOLD", "Gold", "Precious", "wb:Gold", "$/troy oz"),
    ("SILVER", "Silver", "Precious", "wb:Silver", "$/troy oz"),
    ("PLATINUM", "Platinum", "Precious", "wb:Platinum", "$/troy oz"),
    ("WHEAT", "Wheat (US HRW)", "Food", "wb:Wheat, US HRW", "$/t"),
    ("MAIZE", "Maize", "Food", "wb:Maize", "$/t"),
    ("RICE", "Rice (Thai 5%)", "Food", "wb:Rice, Thai 5%", "$/t"),
    ("SOY", "Soybeans", "Food", "wb:Soybeans", "$/t"),
    ("SOYOIL", "Soybean oil", "Food", "wb:Soybean oil", "$/t"),
    ("PALMOIL", "Palm oil", "Food", "wb:Palm oil", "$/t"),
    ("SUGAR", "Sugar (world)", "Food", "wb:Sugar, world", "$/kg"),
    ("OATS", "Oats", "Food", "imf:POATS", "$/bu"),
]


def sig(v, n=5):
    if v == 0:
        return 0
    from math import floor, log10
    return round(v, max(0, n - 1 - int(floor(log10(abs(v))))))


def to_vector(pts):
    """[(YYYY-MM-01, v), ...] -> start month and a dense list with None gaps."""
    pts = sorted(pts)
    y0, m0 = int(pts[0][0][:4]), int(pts[0][0][5:7])
    d = {p[0][:7]: p[1] for p in pts}
    y1, m1 = int(pts[-1][0][:4]), int(pts[-1][0][5:7])
    out, y, m = [], y0, m0
    while (y, m) <= (y1, m1):
        v = d.get(f"{y}-{m:02d}")
        out.append(None if v is None else sig(v))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return f"{y0}-{m0:02d}", out


def build_history(cols, imfd, cpi):
    old = {}
    if HIST_OUT.exists():
        try:
            old = {s["id"]: s for s in json.loads(HIST_OUT.read_text())["series"]}
        except Exception:
            pass
    series, fresh = [], 0
    for hid, label, group, src, unit in HISTORY:
        kind, code = src.split(":", 1)
        pts, note = None, None
        if kind == "wb" and cols:
            name = wb_name(cols, code)
            if name:
                pts, note = cols[name], "World Bank Pink Sheet"
                unit = unit or UNITS.get(name, "")
        elif kind == "imf" and imfd:
            pts, note = imfd.get(code), "IMF Primary Commodity Prices"
        if pts and len(pts) > 12:
            start, v = to_vector(pts)
            series.append({"id": hid, "label": label, "group": group, "unit": unit, "src": note, "start": start, "v": v})
            fresh += 1
            print(f"  history {hid:<9} {start} to {pts[-1][0][:7]}  {len(v)} months  ({note})", flush=True)
        elif hid in old:
            series.append(old[hid] | {"stale": True})
            print(f"  history {hid:<9} kept previous (source failed)", flush=True)
    if not fresh:
        print("History: nothing downloaded, keeping the previous file.", flush=True)
        return
    doc = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "closure": CLOSURE, "series": series}
    if cpi:
        doc["cpi"] = dict(zip(("start", "v"), to_vector(cpi)))
        doc["cpi"]["src"] = CPI_SRC[0]
    elif HIST_OUT.exists():
        try:
            prev = json.loads(HIST_OUT.read_text()).get("cpi")
            if prev:
                doc["cpi"] = prev
        except Exception:
            pass
    HIST_OUT.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"Wrote data/{HIST_OUT.name}: {fresh}/{len(HISTORY)} series fresh, {HIST_OUT.stat().st_size/1e3:.0f} kB", flush=True)


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
    imf_ids = sorted({h[3][4:] for h in HISTORY if h[3].startswith("imf:")} | {x[3][4:] for x in SERIES if x[3] and x[3].startswith("imf:")})
    try:
        imfd = imf(imf_ids)
        print(f"IMF PCPS: {len(imfd)} series", flush=True)
    except Exception as e:
        imfd = {}
        print(f"IMF PCPS failed: {e}", flush=True)
    try:
        cpi = us_cpi()
        print(f"US CPI: {len(cpi)} months to {cpi[-1][0][:7]}", flush=True)
    except Exception as e:
        cpi = None
        print(f"US CPI failed: {e}", flush=True)
    build_history(cols, imfd, cpi)

    key = os.environ.get("EIA_API_KEY", "").strip()
    if not key:
        print("No EIA_API_KEY secret, so daily prices are skipped (monthly World Bank data still used).", flush=True)

    out, fresh, sources = [], 0, set()
    for k, label, group, wb_col, eia_spec, unit in SERIES:
        got = None
        if key and eia_spec:
            try:
                pts = eia(*eia_spec, key)
                if len(pts) > 5:
                    got = summarise(k, label, unit, group, "EIA daily spot", pts, "daily"); sources.add("EIA")
            except Exception as e:
                print(f"  {k}: EIA failed ({str(e)[:80]})", flush=True)
        if not got and wb_col and wb_col.startswith("imf:") and imfd.get(wb_col[4:]):
            pts = [p for p in imfd[wb_col[4:]] if p[0] >= START]
            if len(pts) > 3:
                got = summarise(k, label, unit, group, "IMF monthly average", [(d, round(v, 3)) for d, v in pts], "monthly"); sources.add("IMF")
        elif not got and wb_col and cols:
            pts = wb_series(cols, wb_col)
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
