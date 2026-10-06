/* Land Conversion Atlas. ArcGIS Maps SDK for JavaScript 4.34 (AMD), SoilGrids 2.0, Open-Meteo. Reads window.SOIL and window.ATLAS. */
(() => {
  const S = window.SOIL, A = window.ATLAS;
  const $ = (s) => document.querySelector(s);
  const fmt1 = (v) => (v == null || isNaN(v) ? "n/a" : (Math.round(v * 10) / 10).toString());
  const LAND_NAME = Object.fromEntries([["farm", "Ordinary cropland"], ...S.land.map((l) => [l.id, l.name])]);
  const USE_LABEL = { food: "Food", forage: "Forage", oil: "Oil and biomass", fibre: "Fibre", tree: "Tree crop", metal: "Metal crop" };

  const st = { pt: null, name: "", zone: null, soil: null, clim: null, land: "farm", ec: 1, water: "rainfed", landAuto: "farm", landReason: "", treated: true };

  // ---------- form ----------
  $("#landSel").innerHTML = Object.entries(LAND_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("#landSel").onchange = (e) => { st.land = e.target.value; analyse(); };
  $("#ecIn").oninput = (e) => { st.ec = +e.target.value; $("#ecVal").textContent = `${st.ec} dS/m`; analyse(); };
  function drawWater() {
    $("#waterChips").innerHTML = [["rainfed", "Rainfed"], ["irrigated", "Irrigated or groundwater"], ["seawater", "Seawater on hand"]]
      .map(([k, t]) => `<button type="button" class="chip" role="radio" aria-checked="${st.water === k}" aria-pressed="${st.water === k}" data-k="${k}">${t}</button>`).join("");
    $("#waterChips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => { st.water = b.dataset.k; drawWater(); analyse(); }));
  }
  drawWater();
  $("#treated").onchange = (e) => { st.treated = e.target.checked; analyse(); };
  $("#ecVal").textContent = `${st.ec} dS/m`;
  $("#maplegend").innerHTML = Object.entries(A.colors).map(([k, c]) => `<span><i style="background:${c}"></i>${LAND_NAME[k]}</span>`).join("") + `<span><i class="dia"></i>Restoration project</span>`;
  $("#asources").innerHTML = "Data: " + Object.values(A.sources).map((s) => `<a href="${s.u}" target="_blank" rel="noopener">${s.t}</a>`).join(" · ");

  // ---------- geometry helpers ----------
  const R = 6371;
  function distKm(a, b) {
    const toR = Math.PI / 180, dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function zoneAt(pt) {
    const hits = A.zones.map((z) => ({ z, d: distKm(pt, z.at) })).filter((x) => x.d <= x.z.r).sort((a, b) => a.d / a.z.r - b.d / b.z.r);
    return hits.length ? hits[0].z : null;
  }

  // ---------- data fetch ----------
  async function getSoil(lon, lat) {
    const props = ["phh2o", "soc", "clay", "sand", "nitrogen"].map((p) => `property=${p}`).join("&");
    const r = await fetch(`https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}&${props}&depth=0-5cm&value=mean`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("SoilGrids " + r.status);
    const j = await r.json(), out = {};
    for (const l of j.properties.layers) {
      const v = l.depths[0].values.mean;
      out[l.name] = v == null ? null : v / l.unit_measure.d_factor;
    }
    return out; // phh2o pH, soc g/kg, clay %, sand %, nitrogen g/kg
  }
  async function getClimate(lon, lat) {
    const y = new Date().getUTCFullYear() - 1;
    const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&start_date=${y}-01-01&end_date=${y}-12-31&daily=precipitation_sum,temperature_2m_mean&timezone=UTC`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("Open-Meteo " + r.status);
    const j = await r.json();
    const p = j.daily.precipitation_sum.filter((v) => v != null), t = j.daily.temperature_2m_mean.filter((v) => v != null);
    return { rain: p.reduce((a, b) => a + b, 0), temp: t.reduce((a, b) => a + b, 0) / t.length, year: y, elev: j.elevation };
  }

  // ---------- land inference ----------
  function inferLand() {
    const z = st.zone, s = st.soil || {}, c = st.clim || {};
    if (z) return [z.land, `Inside the mapped ${z.name} zone.`];
    if (s.phh2o != null && s.phh2o < 4.6 && c.elev != null && c.elev < 15) return ["acid", "Very acid topsoil near sea level. Check for acid sulfate soil before draining."];
    if (s.phh2o != null && s.phh2o > 8.4) return ["sodic", `Topsoil pH ${fmt1(s.phh2o)}. Alkaline, possibly sodic. A sodium test (ESP) will confirm.`];
    if (s.sand != null && s.sand > 80 && c.rain != null && c.rain < 300) return ["dune", `${Math.round(s.sand)}% sand with ${Math.round(c.rain)} mm of rain.`];
    if (c.rain != null && c.rain < 200) return ["dune", `Only ${Math.round(c.rain)} mm of rain last year. Desert conditions, so nothing grows without water harvesting or irrigation.`];
    if (s.soc != null && s.soc < 6 && c.rain != null && c.rain < 600) return ["degraded", `Low organic carbon (${fmt1(s.soc)} g/kg) in a dry climate.`];
    return ["farm", "No marginal-land flags at this point."];
  }

  // ---------- crop scoring ----------
  function salinityYield(c, ec) { return ec <= c.T ? 1 : Math.max(0, 1 - (c.b * (ec - c.T)) / 100); }
  function rangeFit(v, [lo, hi], soft) {
    if (v == null) return 1;
    if (v >= lo && v <= hi) return 1;
    const d = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - d / soft);
  }
  function scoreCrops() {
    const s = st.soil || {}, c = st.clim || {};
    const ph0 = st.zone && st.zone.ph ? st.zone.ph : s.phh2o;
    let ph = ph0;
    if (st.treated && ph0 != null && st.land === "sodic") ph = Math.min(ph0, 8.2);
    if (st.treated && ph0 != null && st.land === "acid") ph = Math.max(ph0, 4.8);
    const watered = st.water !== "rainfed";
    return A.crops.map((cr) => {
      const why = [], warn = [];
      const ys = salinityYield(cr, st.ec);
      let fRain = 1;
      if (cr.irrig && !watered) { fRain = 0.15; warn.push("Needs irrigation or groundwater"); }
      else if (!watered) { fRain = c.rain == null ? 1 : rangeFit(c.rain, cr.rain, Math.max(150, cr.rain[0] * 0.6)); }
      else if (cr.id === "salicornia" && st.water !== "seawater") { fRain = 0.7; }
      if (cr.id === "salicornia" && st.water === "seawater") why.push("Grows on seawater");
      const fPh = rangeFit(ph, cr.ph, 1.5);
      const coolSeason = cr.cool && c.temp != null && c.temp > cr.temp[1] && c.temp <= 29;
      const fT = rangeFit(c.temp, coolSeason ? [cr.temp[0], cr.temp[1] + 7] : cr.temp, 6);
      if (coolSeason) why.push("Grow it in the cool season");
      if (watered && c.rain != null && cr.rain[1] > 0 && c.rain > cr.rain[1] * 2.5) { warn.push(`Climate too wet (${Math.round(c.rain)} mm) for good quality`); }
      let f = ys * fRain * fPh * fT;
      if (watered && c.rain != null && cr.rain[1] > 0 && c.rain > cr.rain[1] * 2.5) f *= 0.45;
      if (st.land === "ultramafic" || st.land === "tailings") {
        const pen = { metal: 1.25, food: 0.15, oil: 0.35, fibre: 0.4, forage: 0.45, tree: 0.6 }[cr.use];
        f *= pen;
        if (cr.use === "metal") why.push("Mines nickel from the soil");
        else if (cr.use === "food") warn.push("Food crops may take up nickel and chromium");
        else if (cr.use === "forage") warn.push("Test forage for nickel before grazing");
        else warn.push("Low calcium and high magnesium limit growth");
      } else if (cr.use === "metal") f *= 0.05;
      if (st.land === "tailings" && cr.use !== "metal" && cr.use !== "forage" && cr.use !== "tree") f *= 0.5;
      if (st.land === "acid" && (cr.id === "melaleuca" || cr.id === "rice" || cr.id === "ricest")) { f *= 1.15; why.push("Copes with acid sulfate conditions when kept wet"); }
      if (st.land === "wetland" && cr.wet) f *= 1.1;
      if (cr.wet && !watered && c.rain != null && c.rain < 1000) f *= 0.4;
      if (st.ec > cr.T) why.push(`About ${Math.round(ys * 100)}% of full yield at ${st.ec} dS/m`);
      else if (st.ec >= 4) why.push(`Tolerates ${st.ec} dS/m with no yield loss`);
      if (ph != null && fPh === 1) why.push(`pH ${fmt1(ph)} in range`);
      if (ph != null && fPh < 1) warn.push(`pH ${fmt1(ph)} outside ${cr.ph[0]} to ${cr.ph[1]}`);
      if (!watered && c.rain != null && !cr.irrig) (fRain >= 1 ? why : warn).push(`${Math.round(c.rain)} mm rain ${fRain >= 1 ? "suits it" : `vs ${cr.rain[0]} to ${cr.rain[1]} needed`}`);
      if (c.temp != null && fT < 1) warn.push(`Mean ${fmt1(c.temp)}°C outside ${cr.temp[0]} to ${cr.temp[1]}`);
      if (st.treated && ph0 != null && ph !== ph0 && fPh > rangeFit(ph0, cr.ph, 1.5)) why.push(`after ${st.land === "sodic" ? "gypsum" : "liming"} brings pH to about ${fmt1(ph)}`);
      return { cr, raw: f, f: Math.min(1, f), ys, why, warn };
    }).sort((a, b) => b.raw - a.raw);
  }

  // ---------- render ----------
  function drawReadouts() {
    const s = st.soil || {}, c = st.clim || {};
    const ro = (k, v, u, note) => `<div class="ro"><span class="k">${k}</span><span class="v">${v}<small>${u}</small></span>${note ? `<span class="n">${note}</span>` : ""}</div>`;
    $("#readouts").innerHTML = st.pt ? [
      ro("Topsoil pH", st.zone && st.zone.ph ? fmt1(st.zone.ph) : fmt1(s.phh2o), "", st.zone && st.zone.ph ? "zone typical" : "SoilGrids"),
      ro("Organic carbon", fmt1(s.soc), "g/kg", "SoilGrids"),
      ro("Clay / sand", `${s.clay == null ? "n/a" : Math.round(s.clay)} / ${s.sand == null ? "n/a" : Math.round(s.sand)}`, "%", "SoilGrids"),
      ro("Rainfall", c.rain == null ? "n/a" : Math.round(c.rain), "mm", c.year ? `${c.year}, Open-Meteo` : ""),
      ro("Mean temp", fmt1(c.temp), "°C", c.year ? `${c.year}` : ""),
      ro("Salinity used", st.ec, "dS/m", st.zone ? "zone typical" : "set below")
    ].join("") : "";
  }

  function drawCrops(list) {
    const top = list.filter((x) => x.f >= 0.25).slice(0, 7);
    if (!st.pt) { $("#cropList").innerHTML = `<p class="note">Pick a location to see ranked crops.</p>`; return; }
    if (!top.length) { $("#cropList").innerHTML = `<p class="gap"><b>Nothing scores well here as it stands.</b> Start with the stabilise stage of the pathway below, or add water.</p>`; return; }
    $("#cropList").innerHTML = top.map((x, i) => `<div class="croprow${i === 0 ? " top" : ""}">
      <div class="cr-head"><b>${x.cr.name}</b><span class="usechip u-${x.cr.use}">${USE_LABEL[x.cr.use]}</span></div>
      <div class="fit"><div class="vbar"><span style="width:${Math.round(x.f * 100)}%;background:${x.f >= 0.7 ? "var(--s-open)" : x.f >= 0.45 ? "var(--s-watch)" : "var(--s-elevated)"}"></span></div><span class="mono">${Math.round(x.f * 100)}</span></div>
      ${x.why.length ? `<p class="why2">${x.why.join(" · ")}</p>` : ""}
      ${x.warn.length ? `<p class="warn2">${x.warn.join(" · ")}</p>` : ""}
      ${x.cr.est ? `<span class="est">EST</span>` : ""}
    </div>`).join("");
  }

  function drawPathway() {
    const el = $("#pathway");
    if (!st.pt) { el.innerHTML = ""; return; }
    if (st.land === "farm") {
      el.innerHTML = `<p class="note">No conversion needed. For fertiliser-free ways to keep this soil productive, open the <a href="soil.html">Soil Resilience Planner</a>.</p>`;
      return;
    }
    const l = S.land.find((x) => x.id === st.land);
    const near = S.projects.filter((p) => p.land.includes(st.land)).map((p) => ({ p, d: distKm(st.pt, p.at) })).sort((a, b) => a.d - b.d)[0];
    el.innerHTML = `<p class="note">${l.constraint}</p>
      <ol class="stagesrow vertical">${l.stages.map((s, i) => `<li><span class="sn">STAGE ${i + 1}</span><b>${s.t}</b><span>${s.d}</span></li>`).join("")}</ol>
      <p class="lim"><b>Watch for.</b> ${l.warn}</p>
      ${near ? `<p class="lesson"><b>Nearest proven project:</b> ${near.p.name}, ${near.p.where} (${Math.round(near.d).toLocaleString()} km away). ${near.p.stat}.</p>` : ""}
      <a class="btn" href="soil.html#land-${l.id}">Full plan in the Soil Resilience Planner</a>`;
  }

  let lastList = [];
  function analyse() {
    if (st.pt) {
      $("#landSel").value = st.land;
      $("#landWhy").textContent = st.land === st.landAuto ? st.landReason : `Set by you. The data suggested: ${LAND_NAME[st.landAuto]}.`;
    }
    drawReadouts();
    lastList = scoreCrops();
    drawCrops(lastList);
    drawPathway();
    $("#dlSpot").disabled = !st.pt;
    if (window.__atlasMark) window.__atlasMark();
  }

  async function pick(lon, lat, label, zoneId) {
    st.pt = [lon, lat];
    st.zone = zoneId ? A.zones.find((z) => z.id === zoneId) : zoneAt(st.pt);
    st.name = label || (st.zone ? st.zone.name : "Selected point");
    $("#spotName").textContent = st.name;
    $("#spotCoords").textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°${st.zone ? ` · ${st.zone.note}` : ""} · loading soil and climate…`;
    if (st.zone) { st.ec = st.zone.ec; $("#ecIn").value = st.ec; $("#ecVal").textContent = `${st.ec} dS/m`; }
    st.water = st.zone && st.zone.land === "saline" && /coast|sabkha|Gulf/i.test(st.zone.name) ? "seawater" : st.zone && ["saline", "sodic"].includes(st.zone.land) && /Punjab|Indo-Gangetic|Murray|Mesopotamian|Aral/.test(st.zone.name) ? "irrigated" : "rainfed";
    drawWater();
    st.soil = null; st.clim = null;
    const [soil, clim] = await Promise.allSettled([getSoil(lon, lat), getClimate(lon, lat)]);
    st.soil = soil.status === "fulfilled" ? soil.value : null;
    st.clim = clim.status === "fulfilled" ? clim.value : null;
    const fails = [soil.status !== "fulfilled" && "SoilGrids", clim.status !== "fulfilled" && "Open-Meteo"].filter(Boolean);
    $("#spotCoords").textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°${st.zone ? ` · ${st.zone.note}` : ""}${fails.length ? ` · ${fails.join(" and ")} did not respond in time, so those values are missing. SoilGrids limits how many requests it answers per minute, so try again shortly or set the land type by hand.` : ""}`;
    [st.landAuto, st.landReason] = inferLand();
    st.land = st.landAuto;
    analyse();
    try { history.replaceState(null, "", `#${st.zone && zoneId ? "z-" + zoneId : `p${lat.toFixed(3)}_${lon.toFixed(3)}`.replace(/\./g, "d").replace(/-/g, "m")}`); } catch (e) { /* sandboxed */ }
  }

  // ---------- GeoJSON export ----------
  $("#dlSpot").onclick = () => {
    const top = lastList.filter((x) => x.f >= 0.25).slice(0, 7);
    const gj = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: st.pt }, properties: {
      name: st.name, land_type: LAND_NAME[st.land], ece_dSm: st.ec, water: st.water,
      ph: st.soil && st.soil.phh2o, soc_gkg: st.soil && st.soil.soc, clay_pct: st.soil && st.soil.clay, sand_pct: st.soil && st.soil.sand,
      rain_mm: st.clim && Math.round(st.clim.rain), temp_c: st.clim && +fmt1(st.clim.temp),
      crop_1: top[0] && top[0].cr.name, crop_2: top[1] && top[1].cr.name, crop_3: top[2] && top[2].cr.name,
      crops_ranked: top.map((x) => `${x.cr.name} (${Math.round(x.f * 100)})`).join("; "),
      stage_1: st.land !== "farm" ? S.land.find((l) => l.id === st.land).stages[0].d : "", source: "Land Conversion Atlas, Chokepoint Ledger"
    } }] };
    const blob = new Blob([JSON.stringify(gj, null, 1)], { type: "application/geo+json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `land-atlas-${st.pt[1].toFixed(2)}_${st.pt[0].toFixed(2)}.geojson`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  // ---------- presets ----------
  $("#presets").innerHTML = A.presets.map((id) => { const z = A.zones.find((x) => x.id === id); return `<button type="button" class="chip" data-z="${id}"><i style="background:${A.colors[z.land]}"></i>${z.name.split(",")[0]}</button>`; }).join("");

  // ---------- ArcGIS map ----------
  require([
    "esri/Map", "esri/views/MapView", "esri/Basemap", "esri/layers/TileLayer", "esri/layers/WMSLayer", "esri/layers/GraphicsLayer",
    "esri/Graphic", "esri/geometry/Circle", "esri/geometry/Point", "esri/widgets/LayerList", "esri/widgets/Expand", "esri/widgets/BasemapToggle", "esri/widgets/ScaleBar"
  ], (Map, MapView, Basemap, TileLayer, WMSLayer, GraphicsLayer, Graphic, Circle, Point, LayerList, Expand, BasemapToggle, ScaleBar) => {
    const AGOL = "https://services.arcgisonline.com/ArcGIS/rest/services/";
    const imagery = new Basemap({ baseLayers: [new TileLayer({ url: AGOL + "World_Imagery/MapServer" })], referenceLayers: [new TileLayer({ url: AGOL + "Reference/World_Boundaries_and_Places/MapServer" })], title: "Imagery", id: "img",
      thumbnailUrl: AGOL + "World_Imagery/MapServer/tile/2/1/2" });
    const topo = new Basemap({ baseLayers: [new TileLayer({ url: AGOL + "World_Topo_Map/MapServer" })], title: "Topographic", id: "topo", thumbnailUrl: AGOL + "World_Topo_Map/MapServer/tile/2/1/2" });

    const ph = new WMSLayer({ url: "https://maps.isric.org/mapserv?map=/map/phh2o.map", sublayers: [{ name: "phh2o_0-5cm_mean" }], title: "Soil pH, 0 to 5 cm (SoilGrids)", opacity: 0.6, visible: false });
    const soc = new WMSLayer({ url: "https://maps.isric.org/mapserv?map=/map/soc.map", sublayers: [{ name: "soc_0-5cm_mean" }], title: "Soil organic carbon, 0 to 5 cm (SoilGrids)", opacity: 0.6, visible: false });
    const zonesL = new GraphicsLayer({ title: "Mapped marginal land zones" });
    const projL = new GraphicsLayer({ title: "Restoration projects" });
    const markL = new GraphicsLayer({ title: "Selected location", listMode: "hide" });

    const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]; };
    A.zones.forEach((z) => {
      zonesL.add(new Graphic({
        geometry: new Circle({ center: new Point({ longitude: z.at[0], latitude: z.at[1] }), radius: z.r, radiusUnit: "kilometers", geodesic: true, numberOfPoints: 72 }),
        symbol: { type: "simple-fill", color: hexA(A.colors[z.land], 0.22), outline: { color: hexA(A.colors[z.land], 0.95), width: 1.5 } },
        attributes: { id: z.id, name: z.name, land: LAND_NAME[z.land], ec: z.ec, note: z.note },
        popupTemplate: { title: "{name}", content: "<b>{land}</b><br>{note}<br>Typical ECe about {ec} dS/m" }
      }));
    });
    S.projects.forEach((p) => projL.add(new Graphic({
      geometry: new Point({ longitude: p.at[0], latitude: p.at[1] }),
      symbol: { type: "simple-marker", style: "diamond", size: 11, color: [10, 88, 117, 1], outline: { color: [255, 255, 255, 1], width: 1.2 } },
      attributes: { name: p.name, where: p.where, years: p.years, stat: p.stat, lesson: p.lesson },
      popupTemplate: { title: "{name}", content: "{where}, {years}<br><b>{stat}</b><br>{lesson}" }
    })));

    const map = new Map({ basemap: imagery, layers: [ph, soc, zonesL, projL, markL] });
    const view = new MapView({ container: "viewDiv", map, center: [80, 10], zoom: 2, constraints: { minZoom: 2, snapToZoom: false }, popupEnabled: false });
    view.ui.add(new ScaleBar({ view, unit: "metric" }), "bottom-left");
    view.ui.add(new BasemapToggle({ view, nextBasemap: topo }), "bottom-right");
    view.ui.add(new Expand({ view, content: new LayerList({ view }), expandTooltip: "Layers", expanded: false }), "top-right");

    window.__atlasMark = () => {
      markL.removeAll();
      if (!st.pt) return;
      markL.add(new Graphic({ geometry: new Point({ longitude: st.pt[0], latitude: st.pt[1] }),
        symbol: { type: "simple-marker", style: "circle", size: 14, color: [255, 255, 255, 0.9], outline: { color: [16, 32, 42, 1], width: 3 } } }));
    };

    view.on("click", async (e) => {
      const hit = await view.hitTest(e, { include: [projL] });
      if (hit.results.length) { view.openPopup({ features: [hit.results[0].graphic], location: e.mapPoint }); return; }
      view.closePopup();
      pick(e.mapPoint.longitude, e.mapPoint.latitude);
    });

    document.querySelectorAll("#presets .chip").forEach((b) => (b.onclick = () => {
      const z = A.zones.find((x) => x.id === b.dataset.z);
      view.goTo({ center: z.at, zoom: z.r > 200 ? 6 : z.r > 100 ? 7 : 8 }, { duration: 1200 }).catch(() => {});
      pick(z.at[0], z.at[1], z.name, z.id);
    }));

    // deep link: #z-<zone id> or #p<lat>_<lon> with d for . and m for -
    const h = location.hash.replace("#", "");
    if (h.startsWith("z-") && A.zones.find((z) => z.id === h.slice(2))) {
      const z = A.zones.find((x) => x.id === h.slice(2));
      view.when(() => view.goTo({ center: z.at, zoom: z.r > 200 ? 6 : 7 }).catch(() => {}));
      pick(z.at[0], z.at[1], z.name, z.id);
    } else if (/^p/.test(h)) {
      const [la, lo] = h.slice(1).split("_").map((t) => +t.replace(/m/g, "-").replace(/d/g, "."));
      if (!isNaN(la) && !isNaN(lo)) { view.when(() => view.goTo({ center: [lo, la], zoom: 7 }).catch(() => {})); pick(lo, la); }
    }
    view.when(() => { window.atlasReady = true; });
  });

  window.atlasPick = pick; // used by tests and the video pipeline
  analyse();
})();
