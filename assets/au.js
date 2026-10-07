/* Australian Soil Map. Reads window.AU (data/au_crops.js) and the packed 5 km grid in data/au/.
   ArcGIS Maps SDK for JavaScript 4.34. The grid is scored in the browser and painted to a
   Web Mercator canvas that sits on the map as a MediaLayer. */
(() => {
  const C = window.AU;
  const $ = (s) => document.querySelector(s);
  const CROPS = C.crops;
  const CI = Object.fromEntries(CROPS.map((c, i) => [c.id, i]));
  const st = { mode: "best", crop: "wheat", group: "all", irr: false, fix: false, farm: true, conv: true, ultra: false, cell: null, ec: null };
  let G = null, V = null, NC = 0;
  let best = null, bestScore = null, cropScore = null;
  let repaint = () => {}, markCell = () => {};

  const r1 = (v) => (v == null || isNaN(v) ? "n/a" : (Math.round(v * 10) / 10).toString());
  const r0 = (v) => (v == null || isNaN(v) ? "n/a" : Math.round(v).toLocaleString("en-AU"));

  // ---------- controls ----------
  $("#cropSel").innerHTML = Object.entries(C.groups).map(([g, t]) =>
    `<optgroup label="${t}">` + CROPS.filter((c) => c.g === g).map((c) => `<option value="${c.id}">${c.name}</option>`).join("") + "</optgroup>").join("");
  $("#groupSel").innerHTML = `<option value="all">All crops and land uses</option>` + Object.entries(C.groups).map(([g, t]) => `<option value="${g}">${t}</option>`).join("");
  $("#districts").innerHTML = C.districts.map((d) => `<button type="button" class="chip" data-d="${d.id}">${d.name}</button>`).join("");
  function syncForm() {
    $("#modeSel").value = st.mode;
    $("#cropSel").value = st.crop;
    $("#groupSel").value = st.group;
    $("#cropField").hidden = st.mode !== "crop";
    $("#groupField").hidden = st.mode !== "best";
  }
  $("#modeSel").onchange = (e) => { st.mode = e.target.value; syncForm(); refresh(); };
  $("#cropSel").onchange = (e) => { st.crop = e.target.value; refresh(); };
  $("#groupSel").onchange = (e) => { st.group = e.target.value; refresh(); };
  $("#irr").onchange = (e) => { st.irr = e.target.checked; refresh(); };
  $("#fix").onchange = (e) => { st.fix = e.target.checked; refresh(); };
  $("#farm").onchange = (e) => { st.farm = e.target.checked; refresh(); };
  $("#conv").onchange = (e) => { st.conv = e.target.checked; refresh(); };
  $("#ultra").onchange = (e) => { st.ultra = e.target.checked; refresh(); };
  $("#ecIn").oninput = (e) => { st.ec = +e.target.value; $("#ecVal").textContent = `${st.ec} dS/m`; drawCell(); };
  $("#ausources").innerHTML = "Data: " + Object.values(C.sources).map((s) => `<a href="${s.u}" target="_blank" rel="noopener">${s.t}</a>`).join(" · ");
  syncForm();

  // ---------- grid loading ----------
  async function gunzip(buf) {
    const b = new Uint8Array(buf);
    if (!(b[0] === 0x1f && b[1] === 0x8b)) return b; // server already decoded it
    const ds = new DecompressionStream("gzip");
    return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(ds)).arrayBuffer());
  }
  const DEC = {
    ph: (v) => v / 25 + 3, clay: (v) => v / 2.5, sand: (v) => v / 2.5, soc: (v) => v / 4, cec: (v) => v / 4,
    rain: (v) => v * 10, rainW: (v) => v * 5, rainS: (v) => v * 5, tW: (v) => v / 5 - 5, tS: (v) => v / 5 - 5, tCold: (v) => v / 5 - 10
  };
  async function load() {
    const [meta, bin] = await Promise.all([
      fetch("data/au/meta.json").then((r) => r.json()),
      fetch("data/au/grid.bin.gz").then((r) => r.arrayBuffer()).then(gunzip)
    ]);
    G = meta;
    NC = G.nx * G.ny;
    V = {};
    G.layers.forEach((name, k) => {
      const raw = bin.subarray(k * NC, (k + 1) * NC);
      if (DEC[name]) {
        const f = new Float32Array(NC);
        for (let i = 0; i < NC; i++) f[i] = raw[i] === 255 ? NaN : DEC[name](raw[i]);
        V[name] = f;
      } else V[name] = raw;
    });
    V.land = new Uint8Array(NC);
    V.nonfarm = new Uint8Array(NC);
    const hasLC = (V.hasLC = !!(V.lc_crops && V.lc_crops.some((x) => x > 0)));
    for (let i = 0; i < NC; i++) {
      V.land[i] = isFinite(V.rain[i]) && (G.states.length < 2 || V.state[i] > 0) ? 1 : 0;
      if (hasLC) V.nonfarm[i] = V.lc_trees[i] + V.lc_built[i] + V.lc_water[i] + V.lc_flooded[i] >= 60 ? 1 : 0;
    }
    const src = G.soil === "slga" ? C.sources.slga : C.sources.soilgrids;
    $("#built").innerHTML = `Grid built ${G.built}. Soil from <a href="${src.u}" target="_blank" rel="noopener">${src.t}</a>. ${r0(G.landCells)} land cells.`;
  }

  // ---------- scoring ----------
  const fit = (v, lo, hi, sLo, sHi) => (v !== v ? 1 : v < lo ? Math.max(0, 1 - (lo - v) / sLo) : v > hi ? Math.max(0, 1 - (v - hi) / sHi) : 1);
  const westBelt = (u) => u > 0 && G.ultraPoly[u - 1][0][0] < 129;
  // Rain needed rises with heat. Seasonal rain is scaled by an evaporation factor so the same
  // millimetres count for less in a hot season than a cool one.
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function effRain(c, i) {
    if (c.season === "w") return V.rainW[i] * clamp(1 - 0.04 * (V.tW[i] - 13), 0.75, 1.1);
    if (c.season === "s") return V.rainS[i] * clamp(1 - 0.05 * (V.tS[i] - 25), 0.6, 1.1);
    return V.rain[i] * clamp(1 - 0.04 * ((V.tW[i] + V.tS[i]) / 2 - 16), 0.55, 1.1);
  }
  const F = {};
  function factors(c, i, ecOverride, out = F) {
    const irrig = st.irr && c.irr;
    const rv = effRain(c, i);
    let rain;
    if (c.irrOnly && !irrig) rain = 0;
    else if (irrig) rain = fit(rv, 0, Math.max(c.rain[1], 1600), 1, Math.max(c.rain[1], 1600));
    else rain = fit(rv, c.rain[0], c.rain[1], c.rain[0] * 0.45, c.rain[1] * 0.8);
    let temp = 1;
    if (c.tw && c.season !== "s") temp *= fit(V.tW[i], c.tw[0], c.tw[1], 4, 4);
    if (c.ts && c.season !== "w") temp *= fit(V.tS[i], c.ts[0], c.ts[1], 4, 4);
    const frost = c.frost != null ? fit(V.tCold[i], c.frost, 99, 4, 1) : 1;
    let ph = V.ph[i];
    if (st.fix && ph === ph) ph = clamp(ph, 5.8, 8.3);
    const phf = fit(ph, c.ph[0], c.ph[1], 0.9, 0.9);
    const ec = ecOverride != null ? ecOverride : C.salEC[V.sal[i]] ?? 1;
    let salt = ec <= c.T ? 1 : Math.max(0, 1 - (c.b * (ec - c.T)) / 100);
    if (c.salt && ec < 4) salt = 0.2;
    if (c.saltPref && ec < 4) salt = 0.5;
    const cl = V.clay[i];
    let tex = 1;
    if (c.tex === "clay" && cl === cl) tex = clamp(0.5 + cl / 54, 0.5, 1);
    if (c.tex === "sand" && cl === cl && cl > 25) tex = Math.max(0.35, 1 - (cl - 25) / 30);
    const u = st.ultra || out.forceUltra ? V.ultra[i] : 0;
    let ultra = 1;
    if (c.ultra) ultra = u > 0 && (c.ultra === "west") === westBelt(u) ? 1 : 0;
    else if (u > 0) ultra = C.ultraPenalty[c.g] ?? 0.5;
    // Monsoonal north: one short wet season with an erratic start. CSIRO's northern water resource
    // assessments found dryland annual cropping there high risk, so rainfed annuals take a cut.
    if (!irrig && c.season === "s" && V.tS[i] > 26 && V.rainW[i] < 0.12 * V.rain[i]) rain *= 0.6;
    out.rain = rain; out.temp = temp; out.frost = frost; out.ph = phf; out.salt = salt; out.tex = tex; out.ultra = ultra; out.rv = rv; out.irrig = irrig;
    out.s = 100 * rain * temp * frost * phf * salt * tex * ultra;
    return out;
  }
  const score = (c, i, ec) => factors(c, i, ec).s;
  // Uncropped bush, rangeland or bare ground: annual crops carry a clearing and infrastructure cost.
  const uncropped = (i) => st.conv && V.hasLC && V.lc_crops[i] < 5 && V.lc_range[i] + V.lc_trees[i] + V.lc_bare[i] > 50;
  const valueOf = (c, i) => c.val * (uncropped(i) && c.id !== "rangeland" ? C.convert[c.g] ?? 1 : 1);
  const LIM = {
    rain: (c, f, i) => (f.rv < c.rain[0] ? (c.irrOnly ? "Needs irrigation" : "Too dry") : f.rv <= c.rain[1] ? "Short, erratic wet season" : "Too wet"),
    temp: () => "Season temperature", frost: () => "Frost", ph: (c, f, i) => (V.ph[i] < c.ph[0] ? "Too acid" : "Too alkaline"),
    salt: (c) => (c.salt ? "Only on salt land" : c.saltPref ? "Outcompeted off salt land" : "Salinity"), tex: (c) => (c.tex === "clay" ? "Soil too light" : "Soil too heavy"),
    ultra: (c) => (c.ultra ? "Needs ultramafic soil" : "Ultramafic soil (Ni, Mg)")
  };
  const FLABEL = { rain: "Rain", temp: "Temp", frost: "Frost", ph: "pH", salt: "Salt", tex: "Texture", ultra: "Geology" };

  let bestKey = "";
  function computeBest() {
    const key = [st.group, st.irr, st.fix, st.conv, st.ultra].join();
    if (best && key === bestKey) return;
    bestKey = key;
    best = new Uint8Array(NC).fill(255);
    bestScore = new Uint8Array(NC);
    const pool = CROPS.map((c, k) => k).filter((k) => st.group === "all" || CROPS[k].g === st.group);
    for (let i = 0; i < NC; i++) {
      if (!V.land[i]) continue;
      let bk = 255, bv = 0, bs = 0;
      for (const k of pool) {
        const s = score(CROPS[k], i);
        const w = s * valueOf(CROPS[k], i);
        if (w > bv) { bv = w; bk = k; bs = s; }
      }
      best[i] = bs >= 25 ? bk : 254;
      bestScore[i] = Math.round(bs);
    }
  }
  function computeCrop() {
    cropScore = new Uint8Array(NC);
    const c = CROPS[CI[st.crop]];
    for (let i = 0; i < NC; i++) if (V.land[i]) cropScore[i] = Math.round(score(c, i));
  }

  // ---------- colour ----------
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const CROPRGB = CROPS.map((c) => hex(c.col));
  function ramp(stops) {
    const s = stops.map(hex);
    return (t) => {
      t = Math.max(0, Math.min(1, t)) * (s.length - 1);
      const k = Math.min(s.length - 2, Math.floor(t)), f = t - k;
      return [0, 1, 2].map((j) => Math.round(s[k][j] + (s[k + 1][j] - s[k][j]) * f));
    };
  }
  const RAMPS = {
    crop: { f: ramp(["#f3eee6", "#e9d38c", "#9cc46a", "#3d9a50", "#145c3a"]), lo: 0, hi: 100, u: "score", stops: ["#f3eee6", "#e9d38c", "#9cc46a", "#3d9a50", "#145c3a"] },
    ph: { f: ramp(["#b2182b", "#ef8a62", "#f7e8a6", "#67a9cf", "#5e3c99"]), lo: 4, hi: 10, u: "pH", stops: ["#b2182b", "#ef8a62", "#f7e8a6", "#67a9cf", "#5e3c99"] },
    clay: { f: ramp(["#f6e8c3", "#d8b365", "#8c510a", "#543005"]), lo: 0, hi: 60, u: "% clay", stops: ["#f6e8c3", "#d8b365", "#8c510a", "#543005"] },
    soc: { f: ramp(["#f7f4e9", "#c2a46b", "#6b4f2a", "#1f1a12"]), lo: 0, hi: 60, u: "g/kg", stops: ["#f7f4e9", "#c2a46b", "#6b4f2a", "#1f1a12"] },
    rain: { f: ramp(["#f1e2c4", "#b9d7a8", "#4aa3a2", "#1f5f99", "#0b2a5b"]), lo: 0, hi: 2000, u: "mm", stops: ["#f1e2c4", "#b9d7a8", "#4aa3a2", "#1f5f99", "#0b2a5b"] },
    rainW: { f: ramp(["#f1e2c4", "#b9d7a8", "#4aa3a2", "#1f5f99", "#0b2a5b"]), lo: 0, hi: 900, u: "mm", stops: ["#f1e2c4", "#b9d7a8", "#4aa3a2", "#1f5f99", "#0b2a5b"] },
    rainS: { f: ramp(["#f1e2c4", "#b9d7a8", "#4aa3a2", "#1f5f99", "#0b2a5b"]), lo: 0, hi: 1500, u: "mm", stops: ["#f1e2c4", "#b9d7a8", "#4aa3a2", "#1f5f99", "#0b2a5b"] },
    crops: { f: ramp(["#f3eee6", "#f2d51e", "#d8a31a", "#8a5a00"]), lo: 0, hi: 100, u: "% of cell cropped", stops: ["#f3eee6", "#f2d51e", "#d8a31a", "#8a5a00"] }
  };
  const SALC = { 1: [240, 160, 64], 2: [180, 35, 24] };
  function cellRGBA(i) {
    if (!V.land[i]) return null;
    if (st.farm && V.nonfarm[i] && (st.mode === "best" || st.mode === "crop")) return [120, 120, 120, 60];
    switch (st.mode) {
      case "best": {
        const b = best[i];
        if (b === 254) return [150, 150, 150, 150];
        if (b === 255) return null;
        return [...CROPRGB[b], 215];
      }
      case "crop": return [...RAMPS.crop.f(cropScore[i] / 100), 210];
      case "sal": return V.sal[i] ? [...SALC[V.sal[i]], 220] : [235, 235, 230, 70];
      case "crops": return [...RAMPS.crops.f(V.lc_crops[i] / 100), 200];
      default: {
        const R = RAMPS[st.mode], v = V[st.mode][i];
        if (v !== v) return null;
        return [...R.f((v - R.lo) / (R.hi - R.lo)), 205];
      }
    }
  }

  // ---------- canvas in Web Mercator ----------
  const D2R = Math.PI / 180, RE = 6378137;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
  let geo = null;
  function geometry() {
    const S = G.north - G.ny * G.res, E = G.west + G.nx * G.res;
    const W = G.nx * 2, yN = mercY(G.north), yS = mercY(S);
    const H = Math.round((W * (yN - yS)) / ((E - G.west) * D2R));
    const rowOf = new Int32Array(H);
    for (let r = 0; r < H; r++) {
      const y = yN - ((r + 0.5) / H) * (yN - yS);
      const lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R;
      rowOf[r] = Math.min(G.ny - 1, Math.max(0, Math.floor((G.north - lat) / G.res)));
    }
    geo = { W, H, rowOf, ext: { xmin: G.west * D2R * RE, xmax: E * D2R * RE, ymin: yS * RE, ymax: yN * RE } };
  }
  function paint() {
    const cv = document.createElement("canvas");
    cv.width = geo.W; cv.height = geo.H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(geo.W, geo.H);
    const px = img.data;
    const rowCache = new Map();
    for (let r = 0; r < geo.H; r++) {
      const gr = geo.rowOf[r];
      let row = rowCache.get(gr);
      if (!row) {
        row = new Array(G.nx);
        for (let x = 0; x < G.nx; x++) row[x] = cellRGBA(gr * G.nx + x);
        rowCache.set(gr, row);
      }
      for (let x = 0; x < geo.W; x++) {
        const c = row[x >> 1];
        if (!c) continue;
        const o = (r * geo.W + x) * 4;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // ---------- legend and tallies ----------
  const cellArea = (i) => 30.9 * Math.cos((G.north - (Math.floor(i / G.nx) + 0.5) * G.res) * D2R);
  function drawLegend() {
    const L = $("#legend");
    if (st.mode === "best") {
      const area = new Float64Array(256);
      let tot = 0;
      for (let i = 0; i < NC; i++) {
        if (!V.land[i] || (st.farm && V.nonfarm[i])) continue;
        const a = cellArea(i); area[best[i]] += a; tot += a;
      }
      const items = CROPS.map((c, k) => [k, area[k]]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
      const pct = (a) => { const p = (100 * a) / tot; return p < 1 ? "<1%" : Math.round(p) + "%"; };
      L.innerHTML = items.map(([k, a]) => `<button type="button" data-c="${CROPS[k].id}" title="Show suitability for ${CROPS[k].name}"><i style="background:${CROPS[k].col}"></i>${CROPS[k].name} <small>${pct(a)}</small></button>`).join("") +
        `<span><i style="background:#969696"></i>Nothing scores 25+ <small>${pct(area[254])}</small></span>` +
        (st.farm ? `<span><i style="background:rgba(120,120,120,.3)"></i>Forest, towns, water</span>` : "");
      L.querySelectorAll("button").forEach((b) => (b.onclick = () => { st.mode = "crop"; st.crop = b.dataset.c; syncForm(); refresh(); }));
    } else if (st.mode === "sal") {
      L.innerHTML = `<span><i style="background:rgb(180,35,24)"></i>Salt-affected or high risk in 2000 (scored at 8 dS/m)</span><span><i style="background:rgb(240,160,64)"></i>Forecast high risk by 2050 (4 dS/m)</span>`;
    } else {
      const R = st.mode === "crop" ? RAMPS.crop : RAMPS[st.mode];
      const title = st.mode === "crop" ? `${CROPS[CI[st.crop]].name} suitability` : $("#modeSel").selectedOptions[0].text;
      L.innerHTML = `<div class="rampwrap"><span>${title} (${R.u})</span><div class="ramp" style="background:linear-gradient(90deg,${R.stops.join(",")})"></div><div class="ends"><span>${R.lo}</span><span>${R.hi}+</span></div></div>` +
        (st.mode === "crop" ? `<span class="note">${CROPS[CI[st.crop]].note}</span>` : "");
    }
  }
  function drawTally() {
    const ns = G.states.length;
    const T = $("#tally");
    const skip = (i) => !V.land[i] || (st.farm && V.nonfarm[i]);
    if (st.mode === "crop") {
      const c = CROPS[CI[st.crop]];
      const a = Array.from({ length: ns }, () => [0, 0, 0]);
      for (let i = 0; i < NC; i++) {
        if (skip(i)) continue;
        const s = cropScore[i], k = V.state[i], ar = cellArea(i);
        if (s >= 70) a[k][0] += ar; else if (s >= 40) a[k][1] += ar;
        if (s >= 70 && V.lc_crops[i] >= 20) a[k][2] += ar;
      }
      $("#tallyHead").textContent = `Where ${c.name.toLowerCase()} suits, by state`;
      $("#tallyNote").textContent = "Areas in thousand square kilometres. Strong means a score of 70 or more, workable 40 to 69. The last column is the strong area that is already mostly cropped, which is where the crop is most likely to fit an existing farm system.";
      T.innerHTML = `<thead><tr><th>State</th><th class="num">Strong</th><th class="num">Workable</th><th class="num">Strong and already cropped</th></tr></thead><tbody>` +
        a.map((v, k) => [k, v]).filter(([k, v]) => k > 0 && v[0] + v[1] > 0).sort((x, y) => y[1][0] - x[1][0])
          .map(([k, v]) => `<tr><td>${G.states[k]}</td><td class="num">${r1(v[0] / 1000)}</td><td class="num">${r1(v[1] / 1000)}</td><td class="num">${r1(v[2] / 1000)}</td></tr>`).join("") + "</tbody>";
      return;
    }
    const by = Array.from({ length: ns }, () => new Float64Array(256));
    computeBest();
    const bestNow = best;
    for (let i = 0; i < NC; i++) if (!skip(i)) by[V.state[i]][bestNow[i]] += cellArea(i);
    $("#tallyHead").textContent = "Where the best suggestions land, by state";
    $("#tallyNote").textContent = "Top suggestions by area within each state, in thousand square kilometres, with the current options and filters. Cropped share is the part of those cells that satellite land cover shows as cropland today.";
    T.innerHTML = `<thead><tr><th>State</th><th>First</th><th>Second</th><th>Third</th><th class="num">Land counted</th></tr></thead><tbody>` +
      by.map((arr, k) => [k, arr]).filter(([k]) => k > 0).map(([k, arr]) => {
        const tot = arr.reduce((a, b) => a + b, 0);
        if (!tot) return "";
        const top = CROPS.map((c, j) => [j, arr[j]]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const cells = top.map(([j, v]) => `<td><span class="sw" style="background:${CROPS[j].col}"></span>${CROPS[j].name}<small>${r1(v / 1000)}</small></td>`);
        while (cells.length < 3) cells.push("<td></td>");
        return `<tr><td>${G.states[k]}</td>${cells.join("")}<td class="num">${r0(tot / 1000)}k km²</td></tr>`;
      }).join("") + "</tbody>";
  }

  // ---------- cell detail ----------
  function cellAt(lon, lat) {
    const x = Math.floor((lon - G.west) / G.res), y = Math.floor((G.north - lat) / G.res);
    if (x < 0 || y < 0 || x >= G.nx || y >= G.ny) return -1;
    return y * G.nx + x;
  }
  function pickCell(lon, lat, label) {
    if (!G) return;
    const i = cellAt(lon, lat);
    if (i < 0 || !V.land[i]) { $("#cellName").textContent = "Outside the land grid"; $("#cellCrops").innerHTML = ""; return; }
    st.cell = { i, lon, lat, label };
    st.ec = C.salEC[V.sal[i]] ?? 1;
    $("#ecIn").value = st.ec;
    $("#ecVal").textContent = `${st.ec} dS/m`;
    const tag = (v) => (v < 0 ? "m" : "") + Math.abs(v).toFixed(2).replace(".", "d");
    history.replaceState(null, "", `#p${tag(lat)}_${tag(lon)}`);
    drawCell();
    markCell(lon, lat);
  }
  const LC_COL = { crops: "#d8a31a", range: "#c2a878", bare: "#e6d8b8", trees: "#2f6b2a", flooded: "#4aa3a2", water: "#1f5f99", built: "#b42318" };
  function drawCell() {
    if (!st.cell) return;
    const { i, lon, lat, label } = st.cell;
    const state = G.states[V.state[i]] || "";
    const belt = V.ultra[i] ? G.ultra[V.ultra[i] - 1] : null;
    $("#cellName").textContent = label || `${state} cell`;
    $("#cellCoords").textContent = `${Math.abs(lat).toFixed(2)}° S, ${lon.toFixed(2)}° E · 5 km cell${state ? " in " + state : ""}${belt ? " · " + belt : ""}`;
    const salTxt = ["Not mapped", "Risk by 2050", "Affected in 2000"][V.sal[i]];
    const ro = [
      ["pH (water)", r1(V.ph[i]), ""], ["Clay", r0(V.clay[i]), "%"], ["Sand", r0(V.sand[i]), "%"],
      ["Organic C", r1(V.soc[i]), "g/kg"], ["Annual rain", r0(V.rain[i]), "mm"], ["Apr to Oct", r0(V.rainW[i]), "mm"],
      ["Nov to Mar", r0(V.rainS[i]), "mm"], ["Winter temp", r1(V.tW[i]), "°C"], ["Summer temp", r1(V.tS[i]), "°C"],
      ["Salinity", salTxt, ""], ["CEC", r1(V.cec[i]), "cmol/kg"], ["Cropped", r0(V.lc_crops[i]), "%"]
    ];
    const lc = Object.keys(LC_COL).map((k) => [k, V["lc_" + k] ? V["lc_" + k][i] : 0]).filter((x) => x[1] > 0);
    $("#cellRo").innerHTML = ro.map(([k, v, u]) => `<div class="ro"><span class="k">${k}</span><span class="v">${v}${u && v !== "n/a" ? `<small>${u}</small>` : ""}</span></div>`).join("") +
      (lc.length ? `<div class="ro" style="grid-column:1/-1"><span class="k">Land cover now: ${lc.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}%`).join(", ")}</span><div class="lcbar">${lc.map(([k, v]) => `<span style="width:${v}%;background:${LC_COL[k]}"></span>`).join("")}</div></div>` : "");
    $("#ecBox").hidden = false;
    const conv = uncropped(i);
    const rows = CROPS.map((c) => {
      const f = factors(c, i, st.ec, {});
      const s = f.s;
      const worst = Object.keys(FLABEL).reduce((a, k) => (f[k] < f[a] ? k : a), "rain");
      return { c, f, s, w: s * valueOf(c, i), lim: f[worst] < 0.95 ? LIM[worst](c, f, i) : null, conv: conv && c.id !== "rangeland" && C.convert[c.g] };
    }).sort((a, b) => b.w - a.w);
    const top = rows.filter((r) => r.s >= 25).slice(0, 8);
    const none = !top.length ? `<p class="note">Nothing in the list scores 25 or more here. ${V.rain[i] < 200 ? "With under 200 mm of rain this is desert, so leave it to native vegetation unless water is brought in." : "The main limits are listed below."}</p>` : "";
    const show = top.length ? top : rows.slice(0, 4);
    $("#cellCrops").innerHTML = none + show.map((r, k) => `
      <div class="croprow${k === 0 && top.length ? " top" : ""}">
        <div class="cr-head"><b>${r.c.name}</b><span class="usechip">${C.groups[r.c.g]}</span></div>
        <div class="fit"><div class="vbar"><span style="width:${r.s}%;background:${r.c.col}"></span></div><span class="mono">${Math.round(r.s)}</span></div>
        ${r.lim ? `<span class="lim">Held back by: ${r.lim}</span>` : ""}
        <div class="facs">${Object.entries(FLABEL).map(([k, t]) => `<span>${t}<span class="vbar"><span style="width:${Math.round(r.f[k] * 100)}%;background:${r.f[k] < 0.6 ? "var(--s-elevated)" : "var(--s-open)"}"></span></span></span>`).join("")}</div>
        <span class="why2">${r.c.note}${r.f.irrig ? " Scored as irrigated." : ""}${r.conv ? " Ranked lower here because the cell is uncleared or uncropped today." : ""}</span>
      </div>`).join("");
    if (belt && !st.ultra) {
      const alt = CROPS.map((c) => ({ c, s: factors(c, i, st.ec, { forceUltra: true }).s })).filter((r) => r.s >= 25).sort((a, b) => b.s * b.c.val - a.s * a.c.val).slice(0, 3);
      $("#cellCrops").insertAdjacentHTML("afterbegin", `<p class="callout">This cell sits in the ${belt}. Ultramafic rock is patchy inside the belt, so the ranking below assumes ordinary soil. If a soil test shows serpentine soil (nickel above about 1,000 mg/kg, more magnesium than calcium), the order becomes: ${alt.map((r) => `<b>${r.c.name}</b> ${Math.round(r.s)}`).join(", ")}.</p>`);
    }
    const tag = (v) => (v < 0 ? "m" : "") + Math.abs(v).toFixed(2).replace(".", "d");
    $("#cellLinks").hidden = false;
    $("#cellLinks").innerHTML = `<a class="btn" href="land.html#p${tag(lat)}_${tag(lon)}">Open this point in the Land Atlas for live 250 m soil data</a><a class="btn" href="soil.html#c036">Soil fertility strategies for Australia</a>`;
  }

  // ---------- refresh ----------
  function refresh() {
    if (!G) return;
    $("#status").textContent = "Scoring cells…";
    setTimeout(() => {
      const t = performance.now();
      if (st.mode === "best") computeBest();
      if (st.mode === "crop") computeCrop();
      drawLegend();
      drawTally();
      repaint();
      drawCell();
      $("#status").textContent = `Scored ${r0(G.landCells)} cells in ${Math.round(performance.now() - t)} ms. ${G.soil === "slga" ? "Soil: TERN SLGA 90 m." : "Soil: SoilGrids 250 m."} Hover to read a cell, click to rank crops.`;
    }, 20);
  }

  // ---------- map ----------
  require([
    "esri/Map", "esri/views/MapView", "esri/Basemap", "esri/layers/TileLayer", "esri/layers/MediaLayer", "esri/layers/support/ImageElement",
    "esri/layers/support/ExtentAndRotationGeoreference", "esri/geometry/Extent", "esri/layers/GraphicsLayer", "esri/Graphic", "esri/geometry/Point",
    "esri/geometry/Polygon", "esri/widgets/BasemapToggle", "esri/widgets/ScaleBar", "esri/widgets/Expand", "esri/widgets/LayerList"
  ], (Map, MapView, Basemap, TileLayer, MediaLayer, ImageElement, ExtentAndRotationGeoreference, Extent, GraphicsLayer, Graphic, Point, Polygon, BasemapToggle, ScaleBar, Expand, LayerList) => {
    const AGOL = "https://services.arcgisonline.com/ArcGIS/rest/services/";
    const topo = new Basemap({ baseLayers: [new TileLayer({ url: AGOL + "World_Topo_Map/MapServer" })], title: "Topographic", id: "topo", thumbnailUrl: AGOL + "World_Topo_Map/MapServer/tile/2/1/2" });
    const imagery = new Basemap({ baseLayers: [new TileLayer({ url: AGOL + "World_Imagery/MapServer" })], referenceLayers: [new TileLayer({ url: AGOL + "Reference/World_Boundaries_and_Places/MapServer" })], title: "Imagery", id: "img", thumbnailUrl: AGOL + "World_Imagery/MapServer/tile/2/1/2" });
    const ref = new TileLayer({ url: AGOL + "Reference/World_Boundaries_and_Places/MapServer", title: "Places and boundaries", opacity: 0.9 });
    const media = new MediaLayer({ title: "5 km suitability grid", opacity: 0.85 });
    const ultraL = new GraphicsLayer({ title: "Ultramafic belts", visible: true });
    const markL = new GraphicsLayer({ listMode: "hide" });
    const map = new Map({ basemap: imagery, layers: [media, ultraL, ref, markL] });
    const view = new MapView({ container: "viewDiv", map, center: [134, -28], zoom: 4, constraints: { minZoom: 3, snapToZoom: false }, popupEnabled: false });
    view.ui.add(new ScaleBar({ view, unit: "metric" }), "bottom-left");
    view.ui.add(new BasemapToggle({ view, nextBasemap: topo }), "bottom-right");
    view.ui.add(new Expand({ view, content: new LayerList({ view }), expandTooltip: "Layers", expanded: false }), "top-right");

    repaint = () => {
      if (!geo) geometry();
      const el = new ImageElement({ image: paint(), georeference: new ExtentAndRotationGeoreference({ extent: new Extent({ ...geo.ext, spatialReference: { wkid: 3857 } }) }) });
      media.source.elements.removeAll();
      media.source.elements.add(el);
    };
    markCell = (lon, lat) => {
      markL.removeAll();
      const h = G.res / 2, x0 = G.west + Math.floor((lon - G.west) / G.res) * G.res, y0 = G.north - Math.floor((G.north - lat) / G.res) * G.res;
      markL.add(new Graphic({ geometry: new Polygon({ rings: [[[x0, y0], [x0 + 2 * h, y0], [x0 + 2 * h, y0 - 2 * h], [x0, y0 - 2 * h], [x0, y0]]], spatialReference: { wkid: 4326 } }),
        symbol: { type: "simple-fill", color: [255, 255, 255, 0.15], outline: { color: [16, 32, 42, 1], width: 2.5 } } }));
      markL.add(new Graphic({ geometry: new Point({ longitude: lon, latitude: lat }), symbol: { type: "simple-marker", size: 9, color: [255, 255, 255, 1], outline: { color: [16, 32, 42, 1], width: 2 } } }));
    };

    // hover readout
    const tip = document.createElement("div");
    tip.className = "tip"; tip.hidden = true; document.body.appendChild(tip);
    view.on("pointer-move", (e) => {
      if (!G) return;
      const p = view.toMap({ x: e.x, y: e.y });
      const i = p ? cellAt(p.longitude, p.latitude) : -1;
      if (i < 0 || !V.land[i]) { tip.hidden = true; return; }
      let line;
      if (st.mode === "best") line = best[i] < 254 ? `<b>${CROPS[best[i]].name}</b> · score ${bestScore[i]}` : "Nothing scores 25+";
      else if (st.mode === "crop") line = `<b>${CROPS[CI[st.crop]].name}</b> · score ${cropScore[i]}`;
      else if (st.mode === "sal") line = ["No mapped salinity", "Salinity risk by 2050", "Salt-affected in 2000"][V.sal[i]];
      else if (st.mode === "crops") line = `${V.lc_crops[i]}% cropped`;
      else line = `${r1(V[st.mode][i])} ${RAMPS[st.mode].u}`;
      tip.innerHTML = `${line}<br><span class="mono">pH ${r1(V.ph[i])} · ${r0(V.rain[i])} mm · ${G.states[V.state[i]] || ""}</span>`;
      const r = view.container.getBoundingClientRect();
      tip.style.left = r.left + e.x + 14 + "px"; tip.style.top = r.top + e.y + 14 + "px"; tip.hidden = false;
    });
    view.container.addEventListener("pointerleave", () => (tip.hidden = true));
    view.on("click", (e) => pickCell(e.mapPoint.longitude, e.mapPoint.latitude));

    document.querySelectorAll("#districts .chip").forEach((b) => (b.onclick = () => {
      const d = C.districts.find((x) => x.id === b.dataset.d);
      view.goTo({ center: d.at, zoom: d.z }, { duration: 1100 }).catch(() => {});
      pickCell(d.at[0], d.at[1], d.name);
    }));

    load().then(() => {
      G.ultraPoly.forEach((ring, k) => ultraL.add(new Graphic({
        geometry: new Polygon({ rings: [[...ring, ring[0]]], spatialReference: { wkid: 4326 } }),
        symbol: { type: "simple-fill", style: "backward-diagonal", color: [176, 48, 96, 0.9], outline: { color: [176, 48, 96, 1], width: 1.2 } },
        attributes: { name: G.ultra[k] }
      })));
      refresh();
      // deep links: #p<lat>_<lon>, #d-<district>, #crop-<id>, #layer-<mode>
      const h = decodeURIComponent(location.hash.slice(1));
      const un = (s) => (s.startsWith("m") ? -1 : 1) * parseFloat(s.replace("m", "").replace("d", "."));
      if (h.startsWith("crop-") && CI[h.slice(5)] != null) { st.mode = "crop"; st.crop = h.slice(5); syncForm(); refresh(); }
      else if (h.startsWith("layer-") && $(`#modeSel option[value="${h.slice(6)}"]`)) { st.mode = h.slice(6); syncForm(); refresh(); }
      else if (h.startsWith("d-")) { const b = document.querySelector(`#districts .chip[data-d="${h.slice(2)}"]`); if (b) setTimeout(() => b.click(), 300); }
      else if (/^p[m\d]/.test(h)) {
        const [a, o] = h.slice(1).split("_").map(un);
        if (isFinite(a) && isFinite(o)) { view.goTo({ center: [o, a], zoom: 8 }).catch(() => {}); pickCell(o, a); }
      }
      window.auReady = true;
    }).catch((e) => { $("#status").textContent = "Could not load the grid: " + e.message; console.error(e); });

    window.auSet = (o) => {
      Object.assign(st, o);
      syncForm();
      ["irr", "fix", "farm", "conv", "ultra"].forEach((k) => ($("#" + k).checked = st[k]));
      refresh();
    };
    window.auPick = pickCell;
  });
})();
