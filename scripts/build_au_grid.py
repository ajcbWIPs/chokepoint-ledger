"""Build the 0.05 degree (about 5 km) Australian soil, climate and land grid.

Runs on a GitHub runner (the data hosts are not reachable from everywhere).
Outputs:
  data/au/grid.bin.gz   gzip of packed Uint8 layers, row-major, north row first
  data/au/meta.json     grid geometry, layer encodings, sources, build log

Soil comes from the TERN Soil and Landscape Grid of Australia (90 m) when a
TERN_API_KEY is available, otherwise from ISRIC SoilGrids 2.0 (250 m). Both are
averaged to the 5 km grid with GDAL so every cell is a mean of many pixels.
"""
import gzip, io, json, os, subprocess, sys, time, zipfile, datetime
import numpy as np
import requests
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling
from rasterio.features import rasterize

W, S, E, N = 112.9, -44.0, 154.0, -9.0
RES = 0.05
NX = int(round((E - W) / RES))
NY = int(round((N - S) / RES))
TF = from_origin(W, N, RES, RES)
OUT = "data/au"
TMP = "/tmp/au"
os.makedirs(OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def warp(src, dst, extra=()):
    """gdalwarp a remote raster onto the grid with averaging."""
    cmd = ["gdalwarp", "-q", "-overwrite", "-t_srs", "EPSG:4326", "-te", str(W), str(S), str(E), str(N),
           "-ts", str(NX), str(NY), "-r", "average", "-ot", "Float32", "-dstnodata", "-9999",
           "-wo", "NUM_THREADS=ALL_CPUS", "-multi", *extra, src, dst]
    t = time.time()
    subprocess.run(cmd, check=True, timeout=1500)
    with rasterio.open(dst) as d:
        a = d.read(1).astype("float32")
    a[a == -9999] = np.nan
    log(f"  warped {src.split('/')[-1]} in {time.time()-t:.0f}s, valid={np.isfinite(a).mean():.2f}, median={np.nanmedian(a):.2f}")
    return a


# ---------------------------------------------------------------- soil
def soil_slga(key):
    env = dict(os.environ, GDAL_HTTP_USERPWD=f"apikey:{key}", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
               CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif")
    os.environ.update(env)
    base = "/vsicurl/https://data.tern.org.au/model-derived/slga/NationalMaps/SoilAndLandscapeGrid/"
    files = {
        "ph": "PHW/v1/PHW_005_015_EV_N_P_AU_TRN_N_20220520.tif",
        "clay": "CLY/v2/CLY_005_015_EV_N_P_AU_TRN_N_20210902.tif",
        "sand": "SND/v2/SND_005_015_EV_N_P_AU_TRN_N_20210902.tif",
        "soc": "SOC/90m/v2/SOC_000_005_EV_N_P_AU_TRN_N_20220727.tif",
        "cec": "CEC/v1/CEC_005_015_EV_N_P_AU_TRN_N_20220826.tif",
    }
    out = {}
    for k, f in files.items():
        a = warp(base + f, f"{TMP}/{k}.tif")
        if k == "soc":
            a = a * 10  # % to g/kg
        out[k] = a
    return out


def soil_soilgrids():
    base = "/vsicurl/https://files.isric.org/soilgrids/latest/data/"
    spec = {"ph": ("phh2o", "5-15cm", 0.1), "clay": ("clay", "5-15cm", 0.1), "sand": ("sand", "5-15cm", 0.1),
            "soc": ("soc", "0-5cm", 0.1), "cec": ("cec", "5-15cm", 0.1)}
    out = {}
    for k, (p, d, f) in spec.items():
        a = warp(f"{base}{p}/{p}_{d}_mean.vrt", f"{TMP}/{k}.tif")
        out[k] = a * f
    return out


# ---------------------------------------------------------------- climate
def climate():
    out = {}
    for var in ["prec", "tavg"]:
        z = f"{TMP}/wc_{var}.zip"
        if not os.path.exists(z):
            url = f"https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_2.5m_{var}.zip"
            with requests.get(url, stream=True, timeout=600) as r:
                r.raise_for_status()
                with open(z, "wb") as fh:
                    for ch in r.iter_content(1 << 20):
                        fh.write(ch)
        months = []
        for m in range(1, 13):
            src = f"/vsizip/{z}/wc2.1_2.5m_{var}_{m:02d}.tif"
            with rasterio.open(src) as d:
                dst = np.full((NY, NX), np.nan, "float32")
                reproject(rasterio.band(d, 1), dst, dst_transform=TF, dst_crs="EPSG:4326",
                          resampling=Resampling.bilinear, dst_nodata=np.nan)
                months.append(dst)
        out[var] = np.stack(months)
        log(f"  worldclim {var} ok, median Jan={np.nanmedian(out[var][0]):.1f}")
    p, t = out["prec"], out["tavg"]
    win = [3, 4, 5, 6, 7, 8, 9]          # Apr..Oct (0-based months)
    summ = [10, 11, 0, 1, 2]              # Nov..Mar
    return {
        "rain": p.sum(0),
        "rainW": p[win].sum(0),
        "rainS": p[summ].sum(0),
        "tW": t[[4, 5, 6, 7, 8, 9]].mean(0),   # May..Oct
        "tS": t[summ].mean(0),
        "tCold": t.min(0),
    }


# ---------------------------------------------------------------- salinity
def salinity():
    """NLWRA (2001) dryland salinity assessment: high risk or hazard polygons."""
    import geopandas as gpd
    url = ("https://data.gov.au/data/dataset/d86b702b-73ad-4a7e-96ef-4e17fd0240cd/resource/"
           "fde3434d-1fd4-41f0-be3f-51352fa670ab/download/dsa__r9nnd_00211a00es_geo___.zip")
    z = f"{TMP}/dsa.zip"
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    open(z, "wb").write(r.content)
    names = zipfile.ZipFile(z).namelist()
    log("  dsa zip:", names[:12])
    shp = [n for n in names if n.lower().endswith(".shp")]
    grid = np.zeros((NY, NX), "uint8")
    for s in shp:
        g = gpd.read_file(f"zip://{z}!{s}")
        if g.crs is None:
            g = g.set_crs(4283)  # NLWRA data are GDA94 geographic
        g = g.to_crs(4326)
        log(f"    bounds {g.total_bounds.round(2).tolist()}")
        log(f"  {s}: {len(g)} features, columns={list(g.columns)}")
        for c in g.columns:
            if c != "geometry" and g[c].dtype == object and g[c].nunique() < 30:
                log(f"    {c}: {g[c].value_counts().to_dict()}")
        # Code 2 = mapped in 2000 (already at risk), 1 = projected by 2050.
        code = np.full(len(g), 2, "uint8")
        for c in g.columns:
            if c == "geometry":
                continue
            vals = g[c].astype(str).str.lower()
            if vals.str.contains("2050").any() or vals.str.contains("2020").any():
                code = np.where(vals.str.contains("2000"), 2, 1).astype("uint8")
                log(f"    using {c} for year coding")
                break
        shapes = [(geom, int(v)) for geom, v in zip(g.geometry, code) if geom is not None]
        # Draw 2050 first so 2000 overwrites.
        shapes.sort(key=lambda x: x[1])
        lay = rasterize(shapes, out_shape=(NY, NX), transform=TF, fill=0, all_touched=False, dtype="uint8",
                        merge_alg=rasterio.enums.MergeAlg.replace)
        grid = np.maximum(grid, lay)
    log(f"  salinity cells: risk2000={(grid==2).sum()} by2050={(grid==1).sum()}")
    return grid


# ---------------------------------------------------------------- land cover
LC = {1: "water", 2: "trees", 4: "flooded", 5: "crops", 7: "built", 8: "bare", 11: "range"}


def landcover():
    """Esri / Impact Observatory Sentinel-2 10 m land cover, sampled at 0.01 deg and tallied per cell."""
    svc = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/exportImage"
    f = 5  # 0.01 deg samples per 0.05 cell side
    fine = np.zeros((NY * f, NX * f), "uint8")
    step = 1000  # samples per request side (10 degrees)
    for y0 in range(0, NY * f, step):
        for x0 in range(0, NX * f, step):
            h = min(step, NY * f - y0)
            w = min(step, NX * f - x0)
            bbox = (W + x0 * RES / f, N - (y0 + h) * RES / f, W + (x0 + w) * RES / f, N - y0 * RES / f)
            params = {"bbox": ",".join(f"{v:.4f}" for v in bbox), "bboxSR": 4326, "imageSR": 4326,
                      "size": f"{w},{h}", "format": "tiff", "pixelType": "U8", "interpolation": "RSP_NearestNeighbor",
                      "f": "image"}
            for attempt in range(3):
                try:
                    r = requests.get(svc, params=params, timeout=180)
                    if r.ok and r.content[:2] in (b"II", b"MM"):
                        with rasterio.MemoryFile(r.content) as m, m.open() as d:
                            fine[y0:y0 + h, x0:x0 + w] = d.read(1)[:h, :w]
                        break
                    log("  lc bad response", r.status_code, r.text[:200])
                except Exception as e:
                    log("  lc error", e)
                time.sleep(3)
    blocks = fine.reshape(NY, f, NX, f)
    frac = {}
    for code, name in LC.items():
        frac[name] = ((blocks == code).sum(axis=(1, 3)) * (100 / (f * f))).astype("uint8")
    log("  land cover cells with crops>20%:", int((frac["crops"] > 20).sum()))
    return frac


# ---------------------------------------------------------------- states
STATES = ["", "NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"]


def states():
    import geopandas as gpd
    url = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"
    z = f"{TMP}/ne1.zip"
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    open(z, "wb").write(r.content)
    g = gpd.read_file(f"zip://{z}")
    g = g[g["adm0_a3"] == "AUS"]
    abbr = {"New South Wales": "NSW", "Victoria": "VIC", "Queensland": "QLD", "South Australia": "SA",
            "Western Australia": "WA", "Tasmania": "TAS", "Northern Territory": "NT",
            "Australian Capital Territory": "ACT"}
    shapes = [(geom, STATES.index(abbr[n])) for geom, n in zip(g.geometry, g["name"]) if n in abbr]
    lay = rasterize(shapes, out_shape=(NY, NX), transform=TF, fill=0, all_touched=True, dtype="uint8")
    log("  states cells:", {s: int((lay == i).sum()) for i, s in enumerate(STATES) if i})
    return lay


# ---------------------------------------------------------------- ultramafic and known zones
# Mapped ultramafic and serpentinite belts, simplified to boxes from state geological survey maps.
ULTRA = [
    ("Eastern Goldfields greenstones (Kambalda to Leinster)", [(121.2, -31.6), (122.2, -31.6), (121.9, -27.3), (120.6, -27.3), (120.9, -29.5)]),
    ("Forrestania and Ravensthorpe belts", [(119.6, -32.6), (120.2, -32.6), (120.4, -33.8), (119.8, -33.8)]),
    ("Great Serpentinite Belt (Barraba to Port Macquarie)", [(150.3, -30.0), (150.8, -30.0), (152.3, -31.6), (152.0, -31.9), (150.6, -30.9)]),
    ("Coolac and Tumut serpentinites", [(148.0, -34.7), (148.3, -34.7), (148.4, -35.5), (148.1, -35.5)]),
    ("Marlborough serpentinite", [(149.6, -22.5), (150.1, -22.5), (150.2, -23.1), (149.7, -23.1)]),
    ("Greenvale and Kalkadoon ultramafics", [(144.7, -18.7), (145.2, -18.7), (145.2, -19.2), (144.7, -19.2)]),
    ("Heazlewood and Adamsfield (Tasmania)", [(145.1, -41.1), (145.5, -41.1), (146.4, -42.8), (146.2, -42.9)]),
]


def ultramafic():
    from shapely.geometry import Polygon
    shapes = [(Polygon(p), i + 1) for i, (_, p) in enumerate(ULTRA)]
    return rasterize(shapes, out_shape=(NY, NX), transform=TF, fill=0, all_touched=True, dtype="uint8")


# ---------------------------------------------------------------- pack
def enc(a, lo, scale, nodata=255):
    """Encode float array to Uint8: v = round((a-lo)*scale), 255 = no data."""
    v = np.round((a - lo) * scale)
    v = np.where(np.isfinite(v), np.clip(v, 0, 254), nodata)
    return v.astype("uint8")


def main():
    t0 = time.time()
    key = os.environ.get("TERN_API_KEY", "").strip()
    soil, soil_src = None, None
    if key:
        try:
            log("soil: TERN SLGA")
            soil, soil_src = soil_slga(key), "slga"
        except Exception as e:
            log("  SLGA failed:", e)
    if soil is None:
        log("soil: SoilGrids 2.0")
        soil, soil_src = soil_soilgrids(), "soilgrids"
    log("climate: WorldClim 2.1")
    cl = climate()
    try:
        log("salinity: NLWRA 2001")
        sal = salinity()
    except Exception as e:
        log("  salinity failed:", repr(e))
        sal = np.zeros((NY, NX), "uint8")
    try:
        log("land cover: Esri Sentinel-2 10 m")
        lc = landcover()
    except Exception as e:
        log("  land cover failed:", repr(e))
        lc = {n: np.zeros((NY, NX), "uint8") for n in LC.values()}
    try:
        log("states: Natural Earth")
        st = states()
    except Exception as e:
        log("  states failed:", repr(e))
        st = np.zeros((NY, NX), "uint8")
    ul = ultramafic()

    land = np.isfinite(cl["rain"]) & (st > 0) if (st > 0).any() else np.isfinite(cl["rain"])
    layers = [
        ("ph", enc(soil["ph"], 3, 25), "pH (water) = v/25+3"),
        ("clay", enc(soil["clay"], 0, 2.5), "clay % = v/2.5"),
        ("sand", enc(soil["sand"], 0, 2.5), "sand % = v/2.5"),
        ("soc", enc(soil["soc"], 0, 4), "organic carbon g/kg = v/4"),
        ("cec", enc(soil.get("cec", np.full((NY, NX), np.nan)), 0, 4), "CEC cmol/kg = v/4"),
        ("rain", enc(cl["rain"], 0, 0.1), "annual rain mm = v*10"),
        ("rainW", enc(cl["rainW"], 0, 0.2), "Apr-Oct rain mm = v*5"),
        ("rainS", enc(cl["rainS"], 0, 0.2), "Nov-Mar rain mm = v*5"),
        ("tW", enc(cl["tW"], -5, 5), "May-Oct mean temp C = v/5-5"),
        ("tS", enc(cl["tS"], -5, 5), "Nov-Mar mean temp C = v/5-5"),
        ("tCold", enc(cl["tCold"], -10, 5), "coldest month mean C = v/5-10"),
        ("sal", sal, "dryland salinity: 2 mapped 2000, 1 forecast 2050"),
        ("ultra", ul, "ultramafic belt index (1-based, 0 none)"),
        ("state", st, "state index into states[]"),
    ] + [(f"lc_{n}", lc[n], f"{n} cover % of cell") for n in LC.values()]
    buf = io.BytesIO()
    for name, a, _ in layers:
        a = np.where(land, a, 255 if name not in ("sal", "ultra", "state") and not name.startswith("lc_") else 0)
        buf.write(a.astype("uint8").tobytes())
    raw = buf.getvalue()
    with gzip.open(f"{OUT}/grid.bin.gz", "wb", compresslevel=9) as fh:
        fh.write(raw)
    meta = {
        "built": datetime.datetime.utcnow().strftime("%Y-%m-%d"),
        "west": W, "north": N, "res": RES, "nx": NX, "ny": NY,
        "layers": [n for n, _, _ in layers], "notes": {n: d for n, _, d in layers},
        "soil": soil_src, "states": STATES, "ultra": [n for n, _ in ULTRA],
        "ultraPoly": [p for _, p in ULTRA], "landCells": int(land.sum()), "log": LOG,
    }
    json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)
    log(f"done in {time.time()-t0:.0f}s, raw {len(raw)/1e6:.1f} MB, gz {os.path.getsize(OUT+'/grid.bin.gz')/1e6:.2f} MB")
    json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)


if __name__ == "__main__":
    main()
