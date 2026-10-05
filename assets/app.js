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
    sortKey: "v", sortDir: -1,
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
  const visibleRoute = (r) => (state.group === "All" || r.g === state.group) && (state.commodity === "All" || r.c === state.commodity);

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
        return `<div><span class="k">${h.label}<span class="livetag">LIVE</span></span><span class="v">${d3.format(",.0f")(s.latest)}<small>${h.unit}</small></span><span class="n">${s.note.split(",")[0]} spot, ${s.date}. ${d3.format("+.0%")(s.chg_prewar)} since closure</span></div>`;
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
    .then((L) => { L.byId = Object.fromEntries(L.series.map((s) => [s.id, s])); drawTape(L); drawLive(L); window.LIVE = L; })
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

  const coord = (p) => (typeof p === "string" ? D.nodes[p] : p);
  const routeGeo = (r) => ({ type: "LineString", coordinates: r.path.map(coord) });

  let zoomK = 1;
  const zoom = d3.zoom().scaleExtent([1, 9]).translateExtent([[0, 0], [W, H]]).on("zoom", (e) => {
    zoomK = e.transform.k;
    root.attr("transform", e.transform);
    chokeG.selectAll("circle").attr("r", 5.5 / zoomK);
    chokeG.selectAll("text").attr("font-size", 10 / zoomK).attr("dx", 8 / zoomK).attr("dy", 3.5 / zoomK);
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
      .attr("font-size", 10 / zoomK).attr("dx", 8 / zoomK).attr("dy", 3.5 / zoomK)
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
    groupsEl.querySelectorAll(".chip").forEach((b) => (b.onclick = () => { state.group = b.dataset.g; state.commodity = "All"; state.sel = null; refresh(); }));
  }
  function drawCommoditySelect() {
    const list = [...new Set(D.routes.filter((r) => state.group === "All" || r.g === state.group).map((r) => r.c))];
    $("#commodity").innerHTML = `<option value="All">All in group</option>` + list.map((c) => `<option ${c === state.commodity ? "selected" : ""}>${c}</option>`).join("");
  }
  $("#commodity").onchange = (e) => { state.commodity = e.target.value; state.sel = null; refresh(); };
  $("#layer").onchange = (e) => { state.layer = e.target.value; drawLayer(); };
  $("#scen").oninput = (e) => { state.scen = +e.target.value / 100; refresh(); };

  function drawDetail() {
    const el = $("#detail");
    const id = state.sel;
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
  drawWeights(); drawBal(); refresh();
  if (location.hash === "#capture") document.body.classList.add("capture");
  const tabHash = location.hash.replace("#", "");
  if (["lines", "rank", "div", "bal", "method"].includes(tabHash)) setTab(tabHash);

  // Repaint colours when the theme changes
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawBal(); refresh(); });
  new MutationObserver(() => { drawBal(); refresh(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
