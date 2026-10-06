/* Chokepoint Ledger dashboard logic. Reads window.DATA (data/data.js) and window.WORLD (data/world.js). */
(() => {
  const D = window.DATA;
  const $ = (s) => document.querySelector(s);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmt = d3.format(",.2~f");
  const pct = d3.format(".0%");

  const GROUPS = [
    { k: "Energy", v: "--g-energy" }, { k: "Fertiliser", v: "--g-fert" },
    { k: "Food", v: "--g-food" }, { k: "Metals", v: "--g-metals" }
  ];
  const gColor = (g) => css((GROUPS.find((x) => x.k === g) || GROUPS[0]).v);

  const state = {
    layer: "none", group: "All", commodity: "All", scen: 0, sel: null, tab: "lines",
    sortKey: "v", sortDir: -1, highlight: null, crop: "Rice",
    rw: { choke: 0.25, conc: 0.15, subst: 0.15, buffer: 0.15, disr: 0.3 },
    cw: { choke: 0.2, conc: 0.12, lead: 0.15, buffer: 0.15, policy: 0.1, inel: 0.1, now: 0.18 }
  };
  const CW_LABEL = { choke: "Chokepoint exposure", conc: "Exporter concentration", lead: "Supply lead time", buffer: "Thin inventories", policy: "Policy / export controls", inel: "Inelastic demand", now: "Stress today" };
  const RW_LABEL = { choke: "Chokepoint risk", conc: "Concentration", subst: "Hard to substitute", buffer: "Thin stock cover", disr: "Stopped now" };

  const chokeById = Object.fromEntries(D.chokepoints.map((c) => [c.id, c]));

  // ---------- scoring ----------
  function chokeRisk(id) {
    const c = chokeById[id];
    return id === "hormuz" ? c.risk * (1 - state.scen) + 0.1 * state.scen : c.risk;
  }
  function chokeStatus(c) {
    if (c.id !== "hormuz") return c.status;
    const r = chokeRisk("hormuz");
    return r > 0.7 ? "severe" : r > 0.45 ? "elevated" : r > 0.25 ? "watch" : "open";
  }
  const routeDisr = (r) => (r.hormuz ? r.disruption * (1 - state.scen) : r.disruption);
  function routeV(r) {
    const w = state.rw;
    const parts = {
      choke: r.chokes.length ? Math.max(...r.chokes.map(chokeRisk)) : 0,
      conc: r.conc, subst: 1 - r.subst, buffer: Math.max(0, 1 - r.buffer / 180), disr: routeDisr(r)
    };
    let v = 0, sw = 0;
    for (const k in w) { v += w[k] * parts[k]; sw += w[k]; }
    return { v: sw ? v / sw : 0, parts };
  }
  function comScore(c, scen = state.scen) {
    const f = { ...c, choke: c.choke * (1 - scen * c.hz), now: c.now * (1 - 0.6 * scen * c.hz) };
    let v = 0, sw = 0;
    for (const k in state.cw) { v += state.cw[k] * f[k]; sw += state.cw[k]; }
    return { v: sw ? v / sw : 0, f };
  }
  const visibleRoute = (r) => (state.highlight ? state.highlight.lanes.includes(r.id) : (state.group === "All" || r.g === state.group) && (state.commodity === "All" || r.c === state.commodity));

  // ---------- tooltip ----------
  const tip = $("#tip");
  function showTip(e, html) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- header ----------
  $("#asof").textContent = D.asOf;
  function drawTape(live) {
    $("#tape").innerHTML = D.headline.map((h) => {
      const s = live && h.live && live.byId[h.live];
      if (s && !s.stale) {
        return `<div><span class="k">${h.label}<span class="livetag">LIVE</span></span><span class="v">${d3.format(",.0f")(s.latest)}<small>${h.unit}</small></span><span class="n">${s.note.split(" (")[0]}, ${s.date}. ${d3.format("+.0%")(s.chg_prewar)} since closure</span></div>`;
      }
      return `<div><span class="k">${h.label}</span><span class="v">${h.value}<small>${h.unit}</small></span><span class="n">${h.note}</span></div>`;
    }).join("");
  }
  drawTape(null);

  // ---------- live price feed (data/live.json, rebuilt daily by GitHub Actions) ----------
  function drawLive(L) {
    const pctF = d3.format("+.0%"), num = (v) => d3.format(v >= 1000 ? ",.0f" : v >= 100 ? ".0f" : ".2f")(v);
    $("#liveStamp").textContent = `Feed updated ${L.updated.replace("T", " ").replace("Z", " UTC")}`;
    $("#liveGrid").innerHTML = L.series.map((s) => `<div class="lcard">
      <span class="k"><i class="gdot" style="background:${gColor(s.group)}"></i>${s.label}${s.stale ? ' <span class="stale">STALE</span>' : ""}</span>
      <span class="v">${num(s.latest)}<small>${s.unit}</small></span>
      <span class="d">since closure <b>${s.chg_prewar == null ? "n/a" : s.absolute_change ? d3.format("+.0f")(s.chg_prewar) : pctF(s.chg_prewar)}</b>${s.chg_1m != null ? `, 1 mo ${pctF(s.chg_1m)}` : ""}</span>
      <svg data-id="${s.id}" role="img" aria-label="${s.label} price history"></svg>
      <span class="d" style="color:var(--muted)">${s.date}</span></div>`).join("");
    const closure = new Date(L.closure);
    L.series.forEach((s) => {
      const svgEl = document.querySelector(`#liveGrid svg[data-id="${s.id}"]`);
      const w = svgEl.clientWidth || 200, h = 38;
      const pts = s.points.map(([d, v]) => [new Date(d), v]);
      const x = d3.scaleTime().domain(d3.extent(pts, (p) => p[0])).range([1, w - 3]);
      const y = d3.scaleLinear().domain(d3.extent(pts, (p) => p[1])).nice().range([h - 2, 3]);
      const g = d3.select(svgEl).attr("viewBox", `0 0 ${w} ${h}`);
      g.append("path").attr("class", "area").attr("d", d3.area().x((p) => x(p[0])).y0(h).y1((p) => y(p[1]))(pts));
      if (closure >= x.domain()[0]) g.append("line").attr("class", "war").attr("x1", x(closure)).attr("x2", x(closure)).attr("y1", 0).attr("y2", h);
      g.append("path").attr("class", "spark").attr("d", d3.line().x((p) => x(p[0])).y((p) => y(p[1]))(pts));
      const last = pts[pts.length - 1];
      g.append("circle").attr("class", "end").attr("r", 2.5).attr("cx", x(last[0])).attr("cy", y(last[1]));
    });
    $("#liveNote").textContent = `Source: ${L.source}. Dashed line marks the Hormuz closure (${L.closure}). Monthly IMF series lag by about one to two months. Not investment advice.`;
    $("#live").hidden = false;
  }
  fetch("data/live.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((L) => { L.byId = Object.fromEntries(L.series.map((s) => [s.id, s])); window.LIVE = L; drawTape(L); drawLive(L); drawCrops(); if (typeof drawLand === "function") drawLand(); })
    .catch(() => {}); // no feed (opened from disk, or first deploy pending): page uses the curated figures

  // ---------- map ----------
  const W = 960, H = 470;
  const svg = d3.select("#map").attr("viewBox", `0 0 ${W} ${H}`);
  const proj = d3.geoNaturalEarth1().fitExtent([[4, 4], [W - 4, H - 4]], { type: "MultiPoint", coordinates: [[-170, -56], [170, 80], [0, -56], [0, 80], [-180, 10], [180, 10]] });
  const gpath = d3.geoPath(proj);
  const root = svg.append("g");
  root.append("path").attr("class", "grat").attr("d", gpath(d3.geoGraticule10()));
  const countries = topojson.feature(WORLD, WORLD.objects.countries).features.filter((f) => f.id !== "010");
  const land = root.append("g").selectAll("path").data(countries).join("path")
    .attr("class", "land").attr("d", gpath)
    .on("mousemove", (e, d) => countryTip(e, d)).on("mouseleave", hideTip);
  const routeG = root.append("g");
  const chokeG = root.append("g");
  const siteG = root.append("g");

  const coord = (p) => (typeof p === "string" ? D.nodes[p] : p);
  const routeGeo = (r) => ({ type: "LineString", coordinates: r.path.map(coord) });

  let zoomK = 1;
  const zoom = d3.zoom().scaleExtent([1, 9]).translateExtent([[0, 0], [W, H]]).on("zoom", (e) => {
    zoomK = e.transform.k;
    root.attr("transform", e.transform);
    chokeG.selectAll("circle").attr("r", 5.5 / zoomK);
    siteG.selectAll("circle").attr("r", 5 / zoomK);
    siteG.selectAll("text").style("font-size", 10 / zoomK + "px").attr("dx", (d) => (d.lab === "left" ? -7 : 7) / zoomK).attr("dy", 3.5 / zoomK);
    chokeG.selectAll("text").style("font-size", 10 / zoomK + "px").attr("dx", 8 / zoomK).attr("dy", 3.5 / zoomK);
  });
  svg.call(zoom);
  function zoomTo(lonlat, k, ms = 1200) {
    const [x, y] = proj(lonlat);
    const t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-x, -y);
    return svg.transition().duration(ms).call(zoom.transform, t).end().catch(() => {});
  }
  const zoomReset = (ms = 1000) => svg.transition().duration(ms).call(zoom.transform, d3.zoomIdentity).end().catch(() => {});
  $("#zoomReset").onclick = () => zoomReset();
  $("#zoomGulf").onclick = () => zoomTo([53, 22], 3.6);

  const riskColor = () => d3.scaleLinear().domain([0.15, 0.75]).range([css("--risk-lo"), css("--risk-hi")]).interpolate(d3.interpolateLab).clamp(true);

  function drawRoutes() {
    const rc = riskColor();
    const data = D.routes.map((r) => ({ r, s: routeV(r) })).sort((a, b) => a.s.v - b.s.v);
    const sel = routeG.selectAll("g.rt").data(data, (d) => d.r.id).join((enter) => {
      const g = enter.append("g").attr("class", "rt");
      g.append("path").attr("class", "route");
      g.append("path").attr("class", "route-hit").attr("tabindex", 0).attr("role", "button");
      return g;
    }).order();
    sel.select(".route")
      .attr("d", (d) => gpath(routeGeo(d.r)))
      .attr("stroke", (d) => rc(d.s.v))
      .attr("stroke-width", (d) => (state.sel === d.r.id ? 2.5 : 0) + 1.3 + 7 * Math.sqrt(d.r.share))
      .attr("stroke-opacity", (d) => (state.sel === d.r.id ? 1 : 0.82))
      .attr("stroke-dasharray", (d) => (d.r.land ? "4 3" : null))
      .classed("dim", (d) => !visibleRoute(d.r) || (state.sel && state.sel.startsWith("r") && state.sel !== d.r.id));
    sel.select(".route-hit")
      .attr("d", (d) => gpath(routeGeo(d.r)))
      .attr("aria-label", (d) => `${d.r.c}, ${d.r.from} to ${d.r.to}`)
      .style("display", (d) => (visibleRoute(d.r) ? null : "none"))
      .on("mousemove", (e, d) => showTip(e, `<b>${d.r.c}</b><br>${d.r.from} to ${d.r.to}<br><span class="mono">${fmt(d.r.vol)} ${d.r.unit} pre-war, ${pct(routeDisr(d.r))} stopped<br>vulnerability ${d.s.v.toFixed(2)}</span>`))
      .on("mouseleave", hideTip)
      .on("click", (e, d) => select(d.r.id))
      .on("keydown", (e, d) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(d.r.id); } });
  }

  const STATUS_VAR = { severe: "--s-severe", elevated: "--s-elevated", watch: "--s-watch", open: "--s-open", bypass: "--s-bypass" };
  function drawChokes() {
    const sel = chokeG.selectAll("g.choke").data(D.chokepoints, (d) => d.id).join((enter) => {
      const g = enter.append("g").attr("class", "choke");
      g.append("circle"); g.append("text");
      return g;
    });
    sel.attr("transform", (d) => `translate(${proj(d.at)})`)
      .on("mousemove", (e, d) => showTip(e, `<b>${d.name}</b><br><span class="mono">status ${chokeStatus(d)}, risk ${chokeRisk(d.id).toFixed(2)}</span><br>${d.note}`))
      .on("mouseleave", hideTip).on("click", (e, d) => select(d.id));
    sel.select("circle").attr("r", 5.5 / zoomK).attr("fill", (d) => css(STATUS_VAR[chokeStatus(d)]));
    sel.select("text").text((d) => d.name.replace(" / SUMED", "").replace("East-West Pipeline / ", ""))
      .style("font-size", 10 / zoomK + "px").attr("dx", 8 / zoomK).attr("dy", 3.5 / zoomK)
      .style("display", (d) => (["hormuz", "bab", "malacca", "suez", "panama", "turkish", "cape", "yanbu"].includes(d.id) ? null : "none"));
  }

  // ---------- country layer ----------
  const LAYERS = {
    prod: { get: (c) => c.prod, dom: [0, 20], to: "--seq-oil", sqrt: true, title: "Crude and liquids production, mb/d", ends: ["0", "20"] },
    ref: { get: (c) => c.ref, dom: [0, 20], to: "--seq-oil", sqrt: true, title: "Refinery capacity, mb/d", ends: ["0", "20"] },
    cons: { get: (c) => c.cons, dom: [0, 20], to: "--seq-oil", sqrt: true, title: "Oil consumption, mb/d", ends: ["0", "20"] },
    bal: { get: (c) => c.ref - c.cons, div: [-4, 0, 4], title: "Refining capacity minus consumption, mb/d", ends: ["-4 import need", "+4 export"] },
    shutin: { get: (c) => c.shutin || 0, dom: [0, 3.2], to: "--seq-vul", title: "Crude shut in now, mb/d (est.)", ends: ["0", "3.2"] },
    soil: { get: (c) => c.soil, dom: [0, 90], to: "--seq-soil", title: "Soil fertility index, 0 to 100 (est.)", ends: ["poor", "rich"] },
    foodvul: { get: foodVul, dom: [0.1, 0.8], to: "--seq-vul", title: "Food input vulnerability (est.)", ends: ["low", "high"] }
  };
  function foodVul(c) { return 0.4 * (1 - c.soil / 100) + 0.3 * c.fertImp + 0.3 * c.fertHz; }
  function layerScale(L) {
    if (L.div) return d3.scaleLinear().domain(L.div).range([css("--div-neg"), css("--div-mid"), css("--div-pos")]).interpolate(d3.interpolateLab).clamp(true);
    const s = (L.sqrt ? d3.scaleSqrt() : d3.scaleLinear()).domain(L.dom).range([css("--seq-lo"), css(L.to)]).interpolate(d3.interpolateLab).clamp(true);
    return s;
  }
  function drawLayer() {
    const L = LAYERS[state.layer];
    if (!L) { land.attr("fill", null).style("fill", null); return drawLegend(); }
    const sc = layerScale(L);
    land.style("fill", (d) => { const c = D.countries[d.id]; return c ? sc(L.get(c)) : null; });
    drawLegend();
  }
  function rampCss(sc, dom) {
    const stops = d3.range(0, 1.0001, 0.125).map((t) => sc(dom[0] + t * (dom[dom.length - 1] - dom[0])));
    return `linear-gradient(90deg, ${stops.join(",")})`;
  }
  function drawLegend() {
    const rc = riskColor();
    let html = `<div><b>Supply line vulnerability</b></div><div class="ramp" style="background:${rampCss(rc, [0.15, 0.75])}"></div><div class="ends"><span>lower</span><span>higher</span></div><div class="note" style="font-size:.7rem">Line width = share of world trade in that commodity</div>`;
    const L = LAYERS[state.layer];
    if (L) {
      const sc = layerScale(L);
      html += `<div style="margin-top:4px"><b>${L.title}</b></div><div class="ramp" style="background:${rampCss(sc, L.div || L.dom)}"></div><div class="ends"><span>${L.ends[0]}</span><span>${L.ends[1]}</span></div>`;
    }
    $("#legend").innerHTML = html;
  }
  function countryTip(e, d) {
    const c = D.countries[d.id];
    if (!c) return showTip(e, `<b>${d.properties.name}</b><br><span class="mono">no data in model</span>`);
    showTip(e, `<b>${c.n}</b><br><span class="mono">production ${fmt(c.prod)} mb/d<br>refining ${fmt(c.ref)} mb/d<br>consumption ${fmt(c.cons)} mb/d<br>balance ${d3.format("+.2f")(c.ref - c.cons)} mb/d${c.shutin ? `<br>shut in now ~${fmt(c.shutin)} mb/d (est.)` : ""}<br>soil index ${c.soil} (est.)<br>fertiliser imported ${pct(c.fertImp)}, via Hormuz ${pct(c.fertHz)}<br>food input vulnerability ${foodVul(c).toFixed(2)}</span>`);
  }

  // ---------- side panel ----------
  const groupsEl = $("#groups");
  function drawGroups() {
    groupsEl.innerHTML = [{ k: "All" }, ...GROUPS].map((g) => `<button type="button" class="chip" data-g="${g.k}" aria-pressed="${state.group === g.k}">${g.v ? `<i style="background:${css(g.v)}"></i>` : ""}${g.k}</button>`).join("");
    groupsEl.querySelectorAll(".chip").forEach((b) => (b.onclick = () => { state.group = b.dataset.g; state.commodity = "All"; state.sel = null; state.highlight = null; refresh(); }));
  }
  function drawCommoditySelect() {
    const list = [...new Set(D.routes.filter((r) => state.group === "All" || r.g === state.group).map((r) => r.c))];
    $("#commodity").innerHTML = `<option value="All">All in group</option>` + list.map((c) => `<option ${c === state.commodity ? "selected" : ""}>${c}</option>`).join("");
  }
  $("#commodity").onchange = (e) => { state.commodity = e.target.value; state.sel = null; state.highlight = null; refresh(); };
  $("#layer").onchange = (e) => { state.layer = e.target.value; drawLayer(); };
  $("#scen").oninput = (e) => { state.scen = +e.target.value / 100; refresh(); };

  function drawDetail() {
    const el = $("#detail");
    const id = state.sel;
    if (state.highlight && !id && !state.highlight.lanes.length) {
      el.innerHTML = soilState.sites === "projects" ? `<span class="eyebrow">Land restoration projects</span><p class="note">Blue diamonds mark restoration and land conversion projects with measured results. Click one to read about it. Supply lines and chokepoints are faded while they are shown.</p><button class="btn" type="button" id="clearHl">Show supply lines again</button>` : `<span class="eyebrow">Soil methods</span><p class="note">Green dots mark where each fertiliser-free method was developed or proven. Click one to read about it. Supply lines and chokepoints are faded while the dots are shown.</p><button class="btn" type="button" id="clearHl">Show supply lines again</button>`;
      $("#clearHl").onclick = () => { soilState.sites = false; drawSites(); state.highlight = null; refresh(); };
      return;
    }
    if (state.highlight && !id) {
      const lanes = D.routes.filter((r) => state.highlight.lanes.includes(r.id)).map((r) => ({ r, v: routeV(r).v })).sort((a, b) => b.v - a.v);
      el.innerHTML = `<span class="eyebrow">Input lanes for ${state.highlight.crop}</span>
        ${lanes.map((x) => `<button type="button" class="btn" style="text-align:left" data-r="${x.r.id}"><b>${x.r.c}</b> <span class="mono">${x.v.toFixed(2)}</span><br><span class="note">${x.r.from} to ${x.r.to}</span></button>`).join("")}
        <button class="btn" type="button" id="clearHl">Show all supply lines</button>`;
      el.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => select(b.dataset.r)));
      $("#clearHl").onclick = () => { state.highlight = null; refresh(); };
      return;
    }
    if (id && id.startsWith("r") && D.routes.find((r) => r.id === id)) {
      const r = D.routes.find((x) => x.id === id), s = routeV(r);
      const rc = riskColor();
      el.innerHTML = `<span class="eyebrow">Supply line ${r.est ? '<span class="est">EST</span>' : ""}</span>
        <h3>${r.c}</h3><p>${r.from} to ${r.to}</p>
        <div class="vbar" title="vulnerability"><span style="width:${(s.v * 100).toFixed(0)}%;background:${rc(s.v)}"></span></div>
        <dl><dt>Vulnerability</dt><dd>${s.v.toFixed(2)}</dd>
        <dt>Pre-war volume</dt><dd>${fmt(r.vol)} ${r.unit}</dd>
        <dt>Share of trade</dt><dd>${pct(r.share)}</dd>
        <dt>Stopped now</dt><dd>${pct(routeDisr(r))}</dd>
        <dt>Chokepoints</dt><dd>${r.chokes.map((c) => chokeById[c].name).join(", ") || "none"}</dd>
        ${Object.keys(RW_LABEL).map((k) => `<dt>${RW_LABEL[k]}</dt><dd>${s.parts[k].toFixed(2)}</dd>`).join("")}</dl>
        ${r.note ? `<p class="note">${r.note}</p>` : ""}
        <button class="btn" type="button" id="clearSel">Clear selection</button>`;
    } else if (id && chokeById[id]) {
      const c = chokeById[id];
      const lanes = D.routes.filter((r) => r.chokes.includes(c.id));
      el.innerHTML = `<span class="eyebrow">Chokepoint ${c.est ? '<span class="est">EST</span>' : ""}</span><h3>${c.name}</h3>
        <span class="pill st-${chokeStatus(c)}">${chokeStatus(c)}</span>
        <p>${c.note}</p><p class="note">Pre-war: ${c.prewar}</p>
        <p class="note">${lanes.length} modelled lanes pass here: ${[...new Set(lanes.map((l) => l.c))].join(", ") || "none"}.</p>
        <button class="btn" type="button" id="clearSel">Clear selection</button>`;
    } else {
      const vis = D.routes.filter(visibleRoute).map((r) => ({ r, v: routeV(r).v })).sort((a, b) => b.v - a.v);
      el.innerHTML = `<span class="eyebrow">Most exposed lanes in view</span>
        ${vis.slice(0, 5).map((x) => `<button type="button" class="btn" style="text-align:left" data-r="${x.r.id}"><b>${x.r.c}</b> <span class="mono">${x.v.toFixed(2)}</span><br><span class="note">${x.r.from} to ${x.r.to}</span></button>`).join("")}
        <p class="note">Click a line or chokepoint on the map for detail.</p>`;
      el.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => select(b.dataset.r)));
    }
    const cl = $("#clearSel"); if (cl) cl.onclick = () => select(null);
  }
  function select(id) { state.sel = id; drawRoutes(); drawDetail(); drawTable(); }

  // ---------- route table ----------
  function drawTable() {
    const rc = riskColor();
    const rows = D.routes.filter(visibleRoute).map((r) => ({ r, v: routeV(r).v, d: routeDisr(r) }));
    const key = state.sortKey, dir = state.sortDir;
    const get = { c: (x) => x.r.c, lane: (x) => x.r.from, vol: (x) => x.r.share, ch: (x) => x.r.chokes.length, d: (x) => x.d, v: (x) => x.v }[key];
    rows.sort((a, b) => d3.ascending(get(a), get(b)) * dir);
    const th = (k, t, cls = "") => `<th data-k="${k}" class="${cls}" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${t}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
    $("#routeTable").innerHTML = `<thead><tr>${th("c", "Commodity")}${th("lane", "Lane")}${th("vol", "Volume (pre-war)", "num")}${th("ch", "Chokepoints")}${th("d", "Stopped now", "num")}${th("v", "Vulnerability")}</tr></thead><tbody>${rows.map((x) => `<tr data-r="${x.r.id}" class="${state.sel === x.r.id ? "sel" : ""}"><td><span class="gdot" style="background:${gColor(x.r.g)}"></span>${x.r.c}</td><td>${x.r.from} to ${x.r.to} ${x.r.est ? '<span class="est">EST</span>' : ""}</td><td class="num">${fmt(x.r.vol)} ${x.r.unit}</td><td>${x.r.chokes.map((c) => chokeById[c].name.split(" /")[0]).join(", ") || "none"}</td><td class="num">${pct(x.d)}</td><td><div class="scorecell"><span class="mono">${x.v.toFixed(2)}</span><div class="vbar"><span style="width:${(x.v * 100).toFixed(0)}%;background:${rc(x.v)}"></span></div></div></td></tr>`).join("")}</tbody>`;
    $("#routeTable").querySelectorAll("th").forEach((h) => (h.onclick = () => { const k = h.dataset.k; state.sortDir = state.sortKey === k ? -state.sortDir : -1; state.sortKey = k; drawTable(); }));
    $("#routeTable").querySelectorAll("tbody tr").forEach((tr) => (tr.onclick = () => { select(tr.dataset.r); document.querySelector(".desk").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  }

  // ---------- constraint ranking ----------
  function drawWeights() {
    $("#weights").innerHTML = `<span class="eyebrow">Factor weights (normalised)</span>` + Object.keys(state.cw).map((k) => `<div class="wrow"><label for="w-${k}">${CW_LABEL[k]}</label><input type="range" id="w-${k}" min="0" max="0.4" step="0.01" value="${state.cw[k]}"><output id="o-${k}">${state.cw[k].toFixed(2)}</output></div>`).join("") + `<button class="btn" type="button" id="wReset" style="justify-self:start">Reset weights</button>`;
    Object.keys(state.cw).forEach((k) => ($("#w-" + k).oninput = (e) => { state.cw[k] = +e.target.value; $("#o-" + k).textContent = state.cw[k].toFixed(2); drawRank(); }));
    $("#wReset").onclick = () => { Object.assign(state.cw, { choke: 0.2, conc: 0.12, lead: 0.15, buffer: 0.15, policy: 0.1, inel: 0.1, now: 0.18 }); drawWeights(); drawRank(); };
  }
  function drawRank() {
    const rows = D.commodities.map((c) => ({ c, s: comScore(c), open: comScore(c, 1) })).sort((a, b) => b.s.v - a.s.v);
    const rowH = 28, left = 200, right = 44, top = 26, w = 680, h = top + rows.length * rowH + 24;
    const x = d3.scaleLinear().domain([0, 1]).range([left, w - right]);
    const host = d3.select("#rankChart").html("");
    host.append("h3").text("Which commodities run out of slack first").style("margin-bottom", "4px");
    host.append("p").attr("class", "note").html(`Bar = constraint score at the current scenario (Hormuz ${pct(state.scen)} reopened). Tick = score if Hormuz fully reopens.`);
    const s = host.append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img").attr("aria-label", "Commodity constraint ranking bar chart");
    s.append("g").attr("class", "grid").selectAll("line").data([0.2, 0.4, 0.6, 0.8]).join("line").attr("x1", x).attr("x2", x).attr("y1", top - 6).attr("y2", h - 22);
    s.append("g").selectAll("text").data([0, 0.2, 0.4, 0.6, 0.8, 1]).join("text").attr("x", x).attr("y", h - 6).attr("text-anchor", "middle").text((d) => d.toFixed(1));
    const g = s.append("g").selectAll("g").data(rows).join("g").attr("transform", (d, i) => `translate(0,${top + i * rowH})`);
    g.append("text").attr("class", "lbl").attr("x", left - 10).attr("y", rowH / 2 + 4).attr("text-anchor", "end").text((d) => d.c.c);
    g.append("rect").attr("x", x(0)).attr("y", 5).attr("height", rowH - 10).attr("rx", 3).attr("width", (d) => x(d.s.v) - x(0)).attr("fill", (d) => gColor(d.c.g));
    g.append("line").attr("x1", (d) => x(d.open.v)).attr("x2", (d) => x(d.open.v)).attr("y1", 2).attr("y2", rowH - 2).attr("stroke", css("--ink")).attr("stroke-width", 2);
    g.append("text").attr("x", (d) => Math.max(x(d.s.v), x(d.open.v)) + 6).attr("y", rowH / 2 + 4).text((d) => d.s.v.toFixed(2));
    g.append("rect").attr("x", 0).attr("y", 0).attr("width", w).attr("height", rowH).attr("fill", "transparent")
      .on("mousemove", (e, d) => showTip(e, `<b>${d.c.c}</b><br>${d.c.why}<br><span class="mono">${Object.keys(CW_LABEL).map((k) => `${CW_LABEL[k]}: ${d.s.f[k].toFixed(2)}`).join("<br>")}<br>if reopened: ${d.open.v.toFixed(2)}</span>`))
      .on("mouseleave", hideTip);
    // legend
    const lg = s.append("g").attr("transform", `translate(${left},8)`);
    GROUPS.forEach((gr, i) => { lg.append("rect").attr("x", i * 100).attr("y", -6).attr("width", 10).attr("height", 10).attr("rx", 2).attr("fill", css(gr.v)); lg.append("text").attr("x", i * 100 + 14).attr("y", 3).text(gr.k); });

    // narrative
    const top3 = rows.slice(0, 3).map((r) => r.c.c);
    const structural = rows.slice(0, 9).map((r) => ({ c: r.c.c, keep: r.open.v / r.s.v, v: r.open.v })).sort((a, b) => b.v - a.v).slice(0, 3);
    $("#rankRead").innerHTML = `<p><strong>Most constrained now:</strong> ${top3.join(", ")}.</p><p style="margin-top:8px"><strong>Still constrained if Hormuz reopens:</strong> ${structural.map((s) => `${s.c} (${s.v.toFixed(2)})`).join(", ")}. These depend on mine lead times, processing concentration or damaged capacity, not on the strait.</p><p style="margin-top:8px">Crude ranks below diesel. The barrel shortage is being absorbed by stocks and the Americas, while refining capacity and Gulf product exports are the real bottleneck.</p>`;
  }

  // ---------- staple crop sensitivity ----------
  const C = D.crops;
  const STATUS_TXT = { severe: "severe", elevated: "elevated", watch: "watch", eased: "eased", open: "open" };
  function cropScore(c) {
    let v = 0, sw = 0;
    for (const k in C.weights) { v += C.weights[k] * c[k]; sw += C.weights[k]; }
    return v / sw;
  }
  function liveSeries(id) { return window.LIVE && window.LIVE.byId[id]; }
  function monthlyIndex(id) {
    // monthly values indexed to Feb 2026 = 100, from the live feed or the embedded fallback
    const s = liveSeries(id);
    const pts = s ? s.points.map(([d, v]) => [d.slice(0, 7), v]) : (C.fallback[id] || []);
    const base = (pts.find((p) => p[0] === "2026-02") || [])[1];
    if (!base) return [];
    return pts.filter((p) => p[0] >= "2026-01").map(([m, v]) => ({ m: (+m.slice(0, 4) - 2026) * 12 + (+m.slice(5, 7) - 1), v: (v / base) * 100, raw: v }));
  }
  function showCropOnMap(crop) {
    const c = C.list.find((x) => x.c === crop);
    state.highlight = { crop, lanes: c.lanes }; state.sel = null; state.group = "All"; state.commodity = "All";
    refresh();
    document.querySelector(".desk").scrollIntoView({ behavior: "smooth", block: "start" });
    // frame the highlighted lanes
    const pts = D.routes.filter((r) => c.lanes.includes(r.id)).flatMap((r) => r.path.map(coord)).map((p) => proj(p));
    const [x0, x1] = d3.extent(pts, (p) => p[0]), [y0, y1] = d3.extent(pts, (p) => p[1]);
    const k = Math.max(1, Math.min(4, 0.8 * Math.min(W / (x1 - x0 || 1), H / (y1 - y0 || 1))));
    const t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(1200).call(zoom.transform, t);
  }
  function drawCrops() {
    const rows = C.list.map((c) => ({ c, v: cropScore(c) })).sort((a, b) => b.v - a.v);
    const top = rows[0].c;
    const keys = Object.keys(C.weights);
    const heat = (v) => `color-mix(in srgb, var(--seq-vul) ${Math.round(v * 72)}%, transparent)`;
    const sc = d3.scaleLinear().domain([0, 1]).range([0, 100]);
    const npkPerT = (c) => (c.npkShare * 181.9 * 1000) / c.prod;
    const nPerT = (c) => (c.nShare * 102.5 * 1000) / c.prod;
    const chg = (c) => { const s = liveSeries(c.live); return s && s.chg_prewar != null ? d3.format("+.0%")(s.chg_prewar) : "n/a"; };

    $("#cropAnswer").innerHTML = `<strong>${top.c} is the staple most sensitive to the input shock</strong> (score ${rows[0].v.toFixed(2)}, next ${rows[1].c.c} at ${rows[1].v.toFixed(2)}). It uses the most fertiliser per tonne of food, almost 90% of it grows in Asia on Gulf urea and DAP, Bangladesh's boro crop was top-dressed during the price peak, and only about 11% of rice is traded, so small losses move prices. <strong>The bottleneck has moved.</strong> In March to May it was urea through Hormuz. Urea is now back near pre-war, but DAP keeps climbing because phosphate needs Gulf sulphur. Rabi sowing in India and Bangladesh from October is the next pinch point.`;

    $("#cropTable").innerHTML = `<table class="heat"><thead><tr><th>Crop</th>${keys.map((k) => `<th class="num" title="weight ${C.weights[k]}">${C.labels[k]}</th>`).join("")}<th>Sensitivity</th><th class="num">kg N / t</th><th class="num">Price since closure</th></tr></thead>
      <tbody>${rows.map(({ c, v }) => `<tr data-c="${c.c}" class="${state.crop === c.c ? "sel" : ""}"><td><b>${c.c}</b></td>${keys.map((k) => `<td class="num hc" style="background:${heat(c[k])}">${c[k].toFixed(2)}</td>`).join("")}
        <td><div class="scorecell"><span class="mono"><b>${v.toFixed(2)}</b></span><div class="vbar"><span style="width:${sc(v)}%;background:var(--seq-vul)"></span></div></div></td>
        <td class="num">${nPerT(c).toFixed(0)}</td><td class="num">${chg(c)}</td></tr>`).join("")}</tbody></table>`;
    $("#cropTable").querySelectorAll("tbody tr").forEach((tr) => (tr.onclick = () => { state.crop = tr.dataset.c; drawCrops(); }));

    const c = C.list.find((x) => x.c === state.crop);
    $("#cropDetail").innerHTML = `<span class="eyebrow">${c.c}</span><p>${c.why}</p>
      <dl><dt>Bottleneck</dt><dd>${c.where}</dd>
      <dt>Share of world N</dt><dd>${pct(c.nShare)} (IFA 2014/15)</dd>
      <dt>Fertiliser per tonne</dt><dd>${npkPerT(c).toFixed(0)} kg N+P+K, ${nPerT(c).toFixed(0)} kg N</dd>
      <dt>Traded share</dt><dd>${pct(c.trade)} of output</dd></dl>
      <button class="btn" type="button" id="cropMap">Show ${c.c.toLowerCase()} input lanes on the map</button>`;
    $("#cropMap").onclick = () => showCropOnMap(c.c);

    // input chain
    const urea = monthlyIndex("UREA"), dap = monthlyIndex("DAP");
    const peak = (arr) => arr.reduce((m, p) => (p.raw > m.raw ? p : m), arr[0] || { raw: 0 });
    const liveNote = (id) => {
      const s = id === "UREA" ? urea : dap; if (!s.length) return "";
      const last = s[s.length - 1], pk = peak(s);
      return `<span class="mono chain-live">${id === "UREA" ? "Urea" : "DAP"} $${d3.format(",.0f")(last.raw)}/t${pk.m !== last.m ? `, peak $${d3.format(",.0f")(pk.raw)}` : ", at its high"}. ${d3.format("+.0f")(last.v - 100)}% vs Feb</span>`;
    };
    $("#cropChain").innerHTML = C.chain.map((s, i) => `<li class="node st-${s.status}">
      <span class="pill st-${s.status}">${STATUS_TXT[s.status]}</span>${s.binding ? `<span class="binding">binding ${s.binding}</span>` : ""}
      <b>${s.n}</b><span class="nd">${s.d}</span>${s.live ? liveNote(s.live) : ""}${s.est ? ' <span class="est">EST</span>' : ""}</li>`).join("");

    drawCalendar(urea, dap);
  }

  function drawCalendar(urea, dap) {
    const host = d3.select("#cropCal").html("");
    host.append("h3").text("Who bought fertiliser at the peak").style("margin-bottom", "4px");
    host.append("p").attr("class", "note").text("Lines: World Bank monthly prices indexed to Feb 2026 = 100. Bars: fertiliser windows, shaded by the average price index paid in that window. Hatched months have not happened yet.");
    const months = 15, w = 1000, left = 250, right = 60, top = 16, lineH = 140, rowH = 24, gap = 20;
    const rows = C.windows;
    const h = top + lineH + gap + rows.length * rowH + 30;
    const x = d3.scaleLinear().domain([0, months]).range([left, w - right]);
    const all = urea.concat(dap);
    const y = d3.scaleLinear().domain([Math.min(80, d3.min(all, (d) => d.v) || 80), Math.max(200, d3.max(all, (d) => d.v) || 200)]).nice().range([top + lineH, top]);
    const s = host.append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img").attr("aria-label", "Fertiliser price index and crop application windows");
    const defs = s.append("defs");
    defs.append("pattern").attr("id", "ahead").attr("width", 6).attr("height", 6).attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)")
      .append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6).attr("stroke", css("--muted")).attr("stroke-width", 1.5);
    const lastM = d3.max(all, (d) => d.m) ?? 8;
    // future shading
    s.append("rect").attr("x", x(lastM + 1)).attr("y", top).attr("width", x(months) - x(lastM + 1)).attr("height", h - top - 30).attr("fill", "url(#ahead)").attr("opacity", 0.18);
    // grid and month labels
    const mNames = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
    s.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", left).attr("x2", w - right).attr("y1", y).attr("y2", y);
    s.append("g").selectAll("text").data(y.ticks(4)).join("text").attr("x", left - 6).attr("y", (d) => y(d) + 4).attr("text-anchor", "end").text((d) => d);
    s.append("g").selectAll("text").data(d3.range(months)).join("text").attr("x", (m) => x(m + 0.5)).attr("y", h - 14).attr("text-anchor", "middle").text((m) => mNames[m % 12]);
    s.append("text").attr("x", x(0)).attr("y", h - 1).text("2026");
    s.append("text").attr("x", x(12)).attr("y", h - 1).text("2027");
    s.append("line").attr("x1", x(12)).attr("x2", x(12)).attr("y1", top).attr("y2", h - 26).attr("stroke", css("--line"));
    // closure marker
    s.append("line").attr("x1", x(1.9)).attr("x2", x(1.9)).attr("y1", top).attr("y2", top + lineH).attr("stroke", css("--s-severe")).attr("stroke-dasharray", "3 3");
    s.append("text").attr("x", x(1.9) + 4).attr("y", top + 10).text("Hormuz closes").style("fill", css("--s-severe"));
    // price lines
    const line = d3.line().x((d) => x(d.m + 0.5)).y((d) => y(d.v)).curve(d3.curveMonotoneX);
    [[urea, "--ink", "Urea"], [dap, "--accent", "DAP"]].forEach(([arr, col, name]) => {
      if (!arr.length) return;
      s.append("path").attr("d", line(arr)).attr("fill", "none").attr("stroke", css(col)).attr("stroke-width", 2);
      const l = arr[arr.length - 1];
      s.append("circle").attr("cx", x(l.m + 0.5)).attr("cy", y(l.v)).attr("r", 3.5).attr("fill", css(col));
      s.append("text").attr("class", "lbl").attr("x", x(l.m + 0.5) + 7).attr("y", y(l.v) + 4).text(`${name} ${l.v.toFixed(0)}`);
    });
    // hover points
    s.append("g").selectAll("rect").data(d3.range(lastM + 1)).join("rect").attr("x", (m) => x(m)).attr("width", x(1) - x(0)).attr("y", top).attr("height", lineH).attr("fill", "transparent")
      .on("mousemove", (e, m) => { const u = urea.find((d) => d.m === m), p = dap.find((d) => d.m === m); showTip(e, `<b>${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m % 12]} ${2026 + Math.floor(m / 12)}</b><br><span class="mono">${u ? `urea $${u.raw.toFixed(0)}/t (index ${u.v.toFixed(0)})` : ""}<br>${p ? `DAP $${p.raw.toFixed(0)}/t (index ${p.v.toFixed(0)})` : ""}</span>`); })
      .on("mouseleave", hideTip);
    // window rows
    const pay = d3.scaleLinear().domain([95, 180]).range([css("--seq-lo"), css("--seq-vul")]).interpolate(d3.interpolateLab).clamp(true);
    const y0 = top + lineH + gap;
    const g = s.append("g").selectAll("g").data(rows).join("g").attr("transform", (d, i) => `translate(0,${y0 + i * rowH})`);
    g.each(function (d) {
      const series = /DAP|P and K/.test(d.n) ? dap : urea;
      const seen = series.filter((p) => p.m >= d.m[0] && p.m <= d.m[1]);
      d.idx = seen.length ? d3.mean(seen, (p) => p.v) : null;
      d.input = series === dap ? "DAP" : "urea";
      d.partial = seen.length && d.m[1] > lastM;
    });
    g.append("text").attr("class", "lbl").attr("x", left - 8).attr("y", rowH / 2 + 4).attr("text-anchor", "end").style("font-size", "11px").text((d) => d.n);
    g.append("rect").attr("x", (d) => x(d.m[0])).attr("width", (d) => x(d.m[1] + 1) - x(d.m[0])).attr("y", 3).attr("height", rowH - 6).attr("rx", 3)
      .attr("fill", (d) => (d.idx == null ? "url(#ahead)" : pay(d.idx))).attr("stroke", (d) => (d.idx == null ? css("--muted") : "none"))
      .on("mousemove", (e, d) => showTip(e, `<b>${d.n}</b><br><span class="mono">${d.idx == null ? "ahead: price not known yet" : `average ${d.input} index ${d.idx.toFixed(0)}${d.partial ? " so far" : ""} (Feb 2026 = 100)`}</span>`))
      .on("mouseleave", hideTip);
    g.append("text").attr("x", (d) => x(d.m[1] + 1) + 5).attr("y", rowH / 2 + 4).text((d) => (d.idx == null ? "ahead" : `${d.idx.toFixed(0)}${d.partial ? "*" : ""}`));
  }

  // ---------- soil without fertiliser ----------
  const S = window.SOIL;
  const NUT_LABEL = { N: "Nitrogen", P: "Phosphorus", K: "Potassium", OM: "Organic matter", pH: "Fixes acidity", water: "Water" };
  const CL_LABEL = { humid: "Humid tropics", dry: "Dry and semi-arid", temperate: "Temperate", highland: "Highland" };
  const soilState = { nut: "All", cl: "All", sites: false, land: "All" };
  const srcLinks = (ids) => ids.map((k) => S.sources[k] || D.sources[k]).filter(Boolean).map((s) => `<a href="${s.u}" target="_blank" rel="noopener">${s.t}</a>`).join(" · ");

  function drawBalance() {
    const r = S.removal, max = r.N;
    const groups = {
      N: { fix: ["rotation", "intercrop", "inoculant", "azolla", "trees", "pushpull"], rec: ["manure", "excreta", "ricefish", "chinampa"] },
      P: { fix: [], rec: ["manure", "excreta", "chinampa"] },
      K: { fix: [], rec: ["manure", "excreta", "chinampa"] }
    };
    const name = (id) => S.methods.find((m) => m.id === id).name.split(" (")[0];
    $("#soilBalance").innerHTML = `<div>
        <h3>What biology can and cannot replace</h3>
        <p class="note">Every harvest carries nutrients off the field. ${r.crop} removes roughly this much (typical removal rates):</p>
        <div style="margin-top:12px">${["N", "P", "K"].map((k) => `<div class="brow"><span class="bn">${k}</span>
          <div class="bbar"><span style="width:${(r[k] / max) * 100}%;background:${k === "N" ? "var(--s-open)" : "var(--s-elevated)"}"></span></div>
          <span class="mono">${r[k]} kg/ha</span>
          <span class="bsrc">${k === "N" ? "Can come from the air. Legumes, Azolla and fertiliser trees fix it biologically." : "Cannot be made biologically. Has to be recycled back (manure, excreta, sediment) or mined."}</span></div>`).join("")}</div>
      </div>
      <div class="note" style="display:grid;gap:10px;align-content:start;font-size:0.86rem">
        <p><strong style="color:var(--ink)">Nitrogen is the easy part.</strong> ${groups.N.fix.map(name).join(", ")} all pull nitrogen from the air, which is exactly the nutrient the Strait of Hormuz cut off.</p>
        <p><strong style="color:var(--ink)">Phosphorus and potassium have to be moved, not made.</strong> Chinampas dredge them up from the whole lake catchment. Manure moves them from pasture to cropland. Night soil moved them from Edo's kitchens back to its fields. A system that exports grain for years without returning P and K is mining its soil.</p>
        <p>That is why the phosphate leg in the Staple crops tab is the harder bottleneck. There is no biological shortcut for sulphur-limited DAP, only recycling.</p>
      </div>`;
  }

  function drawSoilFilters() {
    $("#soilNut").innerHTML = ["All", "N", "P", "K", "OM", "pH", "water"].map((k) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${soilState.nut === k}">${k === "All" ? "All" : NUT_LABEL[k]}</button>`).join("");
    $("#soilClim").innerHTML = ["All", "humid", "dry", "temperate", "highland"].map((k) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${soilState.cl === k}">${k === "All" ? "All" : CL_LABEL[k]}</button>`).join("");
    $("#soilNut").querySelectorAll(".chip").forEach((b) => (b.onclick = () => { soilState.nut = b.dataset.k; drawSoil(); }));
    $("#soilClim").querySelectorAll(".chip").forEach((b) => (b.onclick = () => { soilState.cl = b.dataset.k; drawSoil(); }));
  }

  function drawSoil() {
    drawSoilFilters();
    const list = S.methods.filter((m) => (soilState.nut === "All" || m.provides[soilState.nut] >= 2) && (soilState.cl === "All" || m.climates.includes(soilState.cl)))
      .sort((a, b) => (soilState.nut === "All" ? 0 : b.provides[soilState.nut] - a.provides[soilState.nut]));
    const yrs = { 0: "Works this season", 1: "1 to 3 years to establish", 5: "5+ years to establish" };
    $("#soilCards").innerHTML = list.length ? list.map((m) => `<article class="mcard" id="m-${m.id}">
      <div class="mhead"><div><h3>${m.name}</h3><div class="origin">${m.origin}</div></div><span class="strength ${m.strength}" title="evidence strength">${m.strength}</span></div>
      <div class="mstat">${m.stat}<small>${m.statNote}</small></div>
      <p>${m.how}</p>
      <p>${m.evidence}</p>
      <div class="nuts">${Object.keys(NUT_LABEL).filter((k) => m.provides[k] > 0).map((k) => `<span class="nut l${m.provides[k]}" title="${["", "some", "good", "main source"][m.provides[k]]}">${NUT_LABEL[k]}</span>`).join("")}<span class="nut">${yrs[m.years]}</span></div>
      <div class="lim"><b>Limits.</b> ${m.limits}</div>
      ${m.src.length ? `<div class="srcs">${srcLinks(m.src)}</div>` : ""}
    </article>`).join("") : `<p class="note">No method in the catalogue is a main source of that nutrient in that climate. Try another filter.</p>`;
    drawSites();
  }

  const PROJ_SHORT = { loess: "Loess Plateau", fmnr: "Niger FMNR", abreha: "Abreha We Atsbeha", ggw: ["Great Green Wall", "left"], kubuqi: ["Kubuqi", "left"], baydha: "Al Baydha",
    sodicIndia: "Gypsum reclamation", waSalt: ["WA saltland", "left"], icba: "ICBA", sundrop: "Sundrop Farms", albania: "Albania agromining", sabah: "Sabah metal crops", saltPotato: ["Salt potatoes", "left"] };
  S.projects.forEach((p) => { const s = PROJ_SHORT[p.id]; p.short = Array.isArray(s) ? s[0] : s; p.lab = Array.isArray(s) ? s[1] : null; p.kind = "project"; });
  S.methods.forEach((m) => (m.kind = "method"));
  function flashCard(id) {
    setTab("soil");
    const el = document.getElementById(id); if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
  }
  function drawSites() {
    const data = soilState.sites === "methods" ? S.methods.filter((m) => m.at) : soilState.sites === "projects" ? S.projects : [];
    const sel = siteG.selectAll("g.site").data(data, (d) => d.kind + d.id).join((enter) => {
      const g = enter.append("g").attr("class", (d) => "site " + d.kind);
      g.append((d) => document.createElementNS("http://www.w3.org/2000/svg", d.kind === "project" ? "rect" : "circle")); g.append("text");
      return g;
    });
    sel.attr("transform", (d) => `translate(${proj(d.at)})`)
      .on("mousemove", (e, d) => showTip(e, d.kind === "project" ? `<b>${d.name}</b><br>${d.where}, ${d.years}<br><span class="mono">${d.stat}</span>` : `<b>${d.name}</b><br>${d.origin}<br><span class="mono">${d.stat}</span>`))
      .on("mouseleave", hideTip)
      .on("click", (e, d) => flashCard((d.kind === "project" ? "p-" : "m-") + d.id));
    sel.select("circle").attr("r", 5 / zoomK);
    sel.select("rect").attr("x", -5 / zoomK).attr("y", -5 / zoomK).attr("width", 10 / zoomK).attr("height", 10 / zoomK).attr("transform", "rotate(45)");
    sel.select("text").text((d) => d.short || d.name).attr("text-anchor", (d) => (d.lab === "left" ? "end" : "start")).style("font-size", 10 / zoomK + "px").attr("dx", (d) => (d.lab === "left" ? -8 : 8) / zoomK).attr("dy", 3.5 / zoomK);
    chokeG.style("display", soilState.sites ? "none" : null);
    $("#soilSites").textContent = soilState.sites === "methods" ? "Hide method origins" : "Show where each method comes from";
    $("#projSites").textContent = soilState.sites === "projects" ? "Hide projects on the map" : "Show the projects on the map";
  }
  function toggleSites(kind) {
    soilState.sites = soilState.sites === kind ? false : kind; drawSites();
    if (soilState.sites) { state.highlight = { crop: "soil " + kind, lanes: [] }; refresh(); zoomReset(); document.querySelector(".desk").scrollIntoView({ behavior: "smooth", block: "start" }); }
    else { state.highlight = null; refresh(); }
  }
  $("#soilSites").onclick = () => toggleSites("methods");
  $("#projSites").onclick = () => toggleSites("projects");

  // restoration projects
  function drawProjects() {
    const f = soilState.land;
    const list = S.projects.filter((p) => f === "All" || p.land.includes(f));
    $("#projCards").innerHTML = list.map((p) => `<article class="pcard" id="p-${p.id}">
      <div class="mhead"><div><h3>${p.name}</h3><div class="origin">${p.where} · ${p.years}</div></div></div>
      <div class="mstat proj">${p.stat}<small>${p.statNote}</small></div>
      <dl class="pdl"><dt>Scale</dt><dd>${p.scale}</dd><dt>Cost</dt><dd>${p.cost}</dd></dl>
      <ul class="how">${p.how.map((h) => `<li>${h}</li>`).join("")}</ul>
      <p class="lesson"><b>Lesson.</b> ${p.lesson}</p>
      <div class="nuts">${p.land.map((l) => `<button type="button" class="nut landlink" data-l="${l}">${S.land.find((x) => x.id === l).name}</button>`).join("")}</div>
      <div class="srcs">${srcLinks(p.src)}</div></article>`).join("");
    $("#projCards").querySelectorAll(".landlink").forEach((b) => (b.onclick = () => { soilState.land = b.dataset.l; drawLand(); drawProjects(); document.getElementById("landBox").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  }

  // marginal land conversion
  function nickelPrice() {
    const s = window.LIVE && window.LIVE.byId && window.LIVE.byId.NICKEL;
    return s ? { v: s.latest, d: s.date, live: true } : { v: 16324, d: "2026-09", live: false };
  }
  function drawLand() {
    $("#landChips").innerHTML = [["All", "All land types"], ...S.land.map((l) => [l.id, l.name])].map(([k, t]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${soilState.land === k}">${t}</button>`).join("");
    $("#landChips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => { soilState.land = b.dataset.k; drawLand(); drawProjects(); }));
    const el = $("#landDetail");
    if (soilState.land === "All") {
      el.innerHTML = `<div class="landgrid">${S.land.map((l) => `<button type="button" class="landtile" data-k="${l.id}"><b>${l.name}</b><span>${l.stages[1].d}</span><span class="go">Open pathway</span></button>`).join("")}</div>`;
      el.querySelectorAll(".landtile").forEach((b) => (b.onclick = () => { soilState.land = b.dataset.k; drawLand(); drawProjects(); }));
      return;
    }
    const l = S.land.find((x) => x.id === soilState.land);
    const ex = l.projects.map((id) => S.projects.find((p) => p.id === id)).filter(Boolean);
    let econ = "";
    if (l.id === "ultramafic") {
      const np = nickelPrice(), perKg = np.v / 1000;
      const rows = [["Basic management", 25], ["Break-even zone", 22.5], ["Optimised (Albania)", 105], ["Best plot (Albania)", 139]];
      const max = 139 * perKg;
      econ = `<div class="econ"><h4>Agromining value per hectare at today's nickel price</h4>
        <p class="note">Nickel ${np.live ? "World Bank monthly average" : "reference price"}: $${d3.format(",.0f")(np.v)}/t (${np.d}). Value of contained nickel only, before harvest, burning and refining costs. Break-even in the literature is about 15 to 30 kg Ni/ha a year.</p>
        ${rows.map(([n, kg]) => `<div class="erow"><span>${n}</span><div class="bbar"><span style="width:${(kg * perKg / max) * 100}%;background:${kg < 30 ? "var(--s-watch)" : "var(--s-open)"}"></span></div><span class="mono">${kg} kg · $${d3.format(",.0f")(kg * perKg)}</span></div>`).join("")}
      </div>`;
    }
    el.innerHTML = `<div class="landpanel">
      <div class="lp-head"><div><span class="eyebrow">Conversion pathway</span><h3>${l.name}</h3></div><p class="note">${l.scale}</p></div>
      <div class="lp-grid">
        <div><p><b>How to recognise it.</b> ${l.test}</p><p style="margin-top:8px"><b>Why it fails.</b> ${l.constraint}</p></div>
        <div><b>Products</b><p>${l.products}</p></div>
      </div>
      <ol class="stagesrow">${l.stages.map((s, i) => `<li><span class="sn">${i + 1}</span><b>${s.t}</b><span>${s.d}</span></li>`).join("")}</ol>
      <div class="lp-grid">
        <div><b>Plants that work</b><table class="plants"><tbody>${l.plants.map(([p, r]) => `<tr><td>${p}</td><td>${r}</td></tr>`).join("")}</tbody></table></div>
        <div>${econ}<p class="lim" style="margin-top:10px"><b>Watch for.</b> ${l.warn}</p></div>
      </div>
      ${ex.length ? `<div><b>Proven at</b> <span class="nuts">${ex.map((p) => `<button type="button" class="nut l2 projlink" data-p="${p.id}">${p.name}</button>`).join("")}</span></div>` : ""}
      <a class="btn btn-go" href="soil.html#land-${l.id}" style="justify-self:start">Plan for this land type</a>
    </div>`;
    el.querySelectorAll(".projlink").forEach((b) => (b.onclick = () => flashCard("p-" + b.dataset.p)));
  }
  drawBalance(); drawSoil(); drawProjects(); drawLand();

  // ---------- refining balance ----------
  function drawBal() {
    const rows = Object.values(D.countries).map((c) => ({ n: c.n, v: c.ref - c.cons })).filter((r) => Math.abs(r.v) >= 0.2).sort((a, b) => b.v - a.v);
    const rowH = 20, left = 130, w = 640, top = 10, h = top + rows.length * rowH + 26;
    const ext = d3.max(rows, (r) => Math.abs(r.v));
    const x = d3.scaleLinear().domain([-ext, ext]).nice().range([left, w - 40]);
    const host = d3.select("#balChart").html("");
    host.append("h3").text("Who can refine more than they burn").style("margin-bottom", "4px");
    host.append("p").attr("class", "note").text("Refinery capacity minus oil consumption, mb/d, approximate pre-war. Right of zero = product exporter.");
    const s = host.append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img").attr("aria-label", "Refining balance by country");
    s.append("g").attr("class", "grid").selectAll("line").data(x.ticks(6)).join("line").attr("x1", x).attr("x2", x).attr("y1", top).attr("y2", h - 22);
    s.append("g").selectAll("text").data(x.ticks(6)).join("text").attr("x", x).attr("y", h - 6).attr("text-anchor", "middle").text((d) => d3.format("+")(d));
    const g = s.append("g").selectAll("g").data(rows).join("g").attr("transform", (d, i) => `translate(0,${top + i * rowH})`);
    g.append("rect").attr("x", (d) => x(Math.min(0, d.v))).attr("width", (d) => Math.abs(x(d.v) - x(0))).attr("y", 3).attr("height", rowH - 6).attr("rx", 2)
      .attr("fill", (d) => (d.v < 0 ? css("--div-neg") : css("--div-pos")));
    g.append("text").attr("class", "lbl").attr("x", left - 8).attr("y", rowH / 2 + 4).attr("text-anchor", "end").style("font-size", "11px").text((d) => d.n);
    g.append("text").attr("x", (d) => (d.v < 0 ? x(d.v) - 4 : x(d.v) + 4)).attr("y", rowH / 2 + 4).attr("text-anchor", (d) => (d.v < 0 ? "end" : "start")).text((d) => d3.format("+.1f")(d.v));
    s.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", top).attr("y2", h - 22).attr("stroke", css("--ink"));
    $("#balRead").innerHTML = `<p><strong>Refining is where crude becomes useful.</strong> A country can be a big crude producer and still import diesel. The US, Brazil and Mexico consume roughly what they refine. Australia refines about 0.2 mb/d against 1.1 mb/d of use and imports the rest from Asian refineries that run on Gulf crude.</p><p style="margin-top:8px">The swing exporters of product are China, South Korea, India, Russia and the Gulf. With Gulf product exports about 60% below pre-war (IEA), import-dependent countries bid against each other, which is why diesel rose 94% while crude rose far less.</p>`;
  }

  // ---------- divergence ledger ----------
  const LEAN = { metal: "Price beats producer", refiner: "Refiners capture it", split: "Winners and losers split", trader: "Traders capture it", miner: "Ex-China miners gain", lagged: "Risk is lagged" };
  $("#ledger").innerHTML = D.divergence.map((d) => `<article class="entry"><h3>${d.c}</h3><span class="lean">${LEAN[d.lean]}</span>
    <div class="row"><b>Spot</b><span>${d.spot}</span></div>
    <div class="row"><b>Producers</b><span>${d.producer}</span></div>
    <div class="row"><b>Gap</b><span>${d.gap}</span></div>
    <div class="row"><b>Watch</b><span>${d.watch}</span></div></article>`).join("");

  // ---------- sources ----------
  $("#sources").innerHTML = Object.values(D.sources).map((s) => `<li><a href="${s.u}" target="_blank" rel="noopener">${s.t}</a></li>`).join("") + `<li>Country oil balances: Energy Institute Statistical Review of World Energy (approximate, pre-war)</li><li>Soil reference for refinement: FAO Status of the World's Soil Resources, ISRIC SoilGrids</li>`;

  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll(".tab")];
  function setTab(id) {
    state.tab = id;
    tabs.forEach((t) => { const on = t.id === "tab-" + id; t.setAttribute("aria-selected", on); document.getElementById(t.getAttribute("aria-controls")).hidden = !on; });
  }
  tabs.forEach((t) => (t.onclick = () => setTab(t.id.replace("tab-", ""))));

  // ---------- refresh ----------
  function refresh() {
    $("#scenVal").textContent = pct(state.scen);
    $("#scenNote").textContent = state.scen === 0 ? "Current state, early Oct 2026" : state.scen === 1 ? "Strait fully reopened, damage and lead times unchanged" : "Partial reopening";
    drawGroups(); drawCommoditySelect(); drawRoutes(); drawChokes(); drawDetail(); drawTable(); drawRank(); drawLayer();
  }
  drawWeights(); drawBal(); refresh(); drawCrops();
  if (location.hash === "#capture") document.body.classList.add("capture");
  const tabHash = location.hash.replace("#", "");
  if (["lines", "rank", "crops", "soil", "div", "bal", "method"].includes(tabHash)) setTab(tabHash);

  // Repaint colours when the theme changes
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawBal(); refresh(); drawCrops(); });
  new MutationObserver(() => { drawBal(); refresh(); drawCrops(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- scene API used by the video pipeline (video/capture.py) ----------
  window.setScene = async (o = {}) => {
    if (o.capture !== undefined) document.body.classList.toggle("capture", !!o.capture);
    if (o.portrait !== undefined) {
      document.body.classList.toggle("portrait", !!o.portrait);
      svg.attr("preserveAspectRatio", o.portrait ? "xMidYMid slice" : null);
    }
    if (o.theme) document.documentElement.setAttribute("data-theme", o.theme);
    if (o.layer !== undefined) { state.layer = o.layer; $("#layer").value = o.layer; }
    if (o.group !== undefined) { state.group = o.group; state.commodity = "All"; }
    if (o.commodity !== undefined) state.commodity = o.commodity;
    if (o.scen !== undefined) { state.scen = o.scen; $("#scen").value = Math.round(o.scen * 100); }
    if (o.select !== undefined) state.sel = o.select;
    if (o.highlightCrop !== undefined) state.highlight = o.highlightCrop ? { crop: o.highlightCrop, lanes: C.list.find((c) => c.c === o.highlightCrop).lanes } : null;
    if (o.crop) state.crop = o.crop;
    if (o.sites !== undefined) { soilState.sites = o.sites === true ? "methods" : o.sites; drawSites(); }
    if (o.land !== undefined) { soilState.land = o.land; drawLand(); drawProjects(); }
    if (o.tab) setTab(o.tab);
    if (o.view !== undefined) document.body.classList.toggle("view-panel", o.view === "panel");
    else if (o.tab) document.body.classList.add("view-panel");
    if (o.view === "map") document.body.classList.remove("view-panel");
    refresh();
    if (o.zoom === "reset") await zoomReset(o.ms ?? 1200);
    else if (Array.isArray(o.zoom)) await zoomTo([o.zoom[0], o.zoom[1]], o.zoom[2], o.ms ?? 1600);
    return true;
  };
  window.dashboardReady = true;
})();
