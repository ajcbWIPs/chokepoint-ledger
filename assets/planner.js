/* Soil Resilience Planner. Reads window.DATA (countries) and window.SOIL (methods, system moves, country defaults). */
(() => {
  const D = window.DATA, S = window.SOIL;
  const $ = (s) => document.querySelector(s);
  const pct = (v) => `${Math.round(v * 100)}%`;

  const OPTS = {
    cl: { humid: "Humid tropics", dry: "Dry or semi-arid", temperate: "Temperate", highland: "Highland" },
    water: { rainfed: "Rainfed", irrigated: "Irrigated", paddy: "Flooded paddy", wetland: "Lake or wetland edge" },
    scale: { small: "Under 5 ha", mid: "5 to 100 ha", large: "Over 100 ha" },
    live: { 1: "Yes", 0: "No" },
    prob: { lowN: "Nitrogen-poor", lowP: "Phosphorus-poor", lowK: "Potassium-poor", acid: "Acidic", lowOM: "Low organic matter or eroded", drought: "Dry or crusted" }
  };
  const PROB_NUT = { lowN: "N", lowP: "P", lowK: "K", acid: "pH", lowOM: "OM", drought: "water" };
  const NUT_LABEL = { N: "Nitrogen", P: "Phosphorus", K: "Potassium", OM: "Organic matter", pH: "Acidity", water: "Water" };
  const CROP_LABEL = { rice: "rice", maize: "maize", wheat: "wheat", millet: "sorghum and millet", soy: "soy and pulses", roots: "roots and tubers", veg: "vegetables" };
  const STAGES = [
    { y: 0, t: "This season", d: "Works from the next planting" },
    { y: 1, t: "Next 1 to 3 years", d: "Needs setting up or a first cycle" },
    { y: 5, t: "Five years and beyond", d: "Long-lived systems that compound" }
  ];

  const ctx = { country: "356", cl: "humid", crop: "rice", water: "paddy", scale: "small", live: 1, prob: new Set(["lowN", "lowP", "acid"]) };

  // ---------- country defaults ----------
  const countries = Object.entries(D.countries).filter(([id]) => S.context[id]).sort((a, b) => a[1].n.localeCompare(b[1].n));
  const foodVul = (c) => 0.4 * (1 - c.soil / 100) + 0.3 * c.fertImp + 0.3 * c.fertHz;

  function defaultsFor(id) {
    const c = D.countries[id], k = S.context[id];
    const prob = new Set();
    if (c.fertImp >= 0.3 || c.fertHz >= 0.2) prob.add("lowN");
    if (k.cl === "humid" || c.soil < 45) prob.add("lowP");
    if (k.cl === "humid") prob.add("acid");
    if (k.cl === "dry" || c.soil < 40) prob.add("lowOM");
    if (k.cl === "dry") prob.add("drought");
    if (!prob.size) prob.add("lowN");
    return { cl: k.cl, crop: k.crop, water: k.water, scale: k.scale, live: k.live, prob };
  }

  // ---------- form ----------
  $("#country").innerHTML = `<option value="">Custom (no country)</option>` + countries.map(([id, c]) => `<option value="${id}">${c.n}</option>`).join("");

  function chips(el, key, multi = false) {
    const box = $(el);
    box.innerHTML = Object.entries(OPTS[key]).map(([v, t]) => {
      const on = multi ? ctx.prob.has(v) : String(ctx[key]) === v;
      return `<button type="button" class="chip" data-v="${v}" ${multi ? `aria-pressed="${on}"` : `role="radio" aria-checked="${on}" aria-pressed="${on}"`}>${t}</button>`;
    }).join("");
    box.querySelectorAll(".chip").forEach((b) => (b.onclick = () => {
      if (multi) { ctx.prob.has(b.dataset.v) ? ctx.prob.delete(b.dataset.v) : ctx.prob.add(b.dataset.v); }
      else ctx[key] = key === "live" ? +b.dataset.v : b.dataset.v;
      render();
    }));
  }
  function drawForm() {
    $("#country").value = ctx.country;
    $("#crop").value = ctx.crop;
    chips("#f-cl", "cl"); chips("#f-water", "water"); chips("#f-scale", "scale"); chips("#f-live", "live"); chips("#f-prob", "prob", true);
  }
  $("#country").onchange = (e) => {
    ctx.country = e.target.value;
    if (ctx.country) Object.assign(ctx, defaultsFor(ctx.country));
    try { history.replaceState(null, "", ctx.country ? `#c${ctx.country}` : location.pathname); } catch (err) { /* sandboxed viewers */ }
    render();
  };
  $("#crop").onchange = (e) => { ctx.crop = e.target.value; render(); };

  // ---------- scoring ----------
  const STRENGTH = { strong: 1, moderate: 0.85, mixed: 0.6 };
  function scoreMethod(m) {
    const needs = m.needs || [];
    if (needs.includes("wetland") && ctx.water !== "wetland") return null;
    if (needs.includes("paddy") && ctx.water !== "paddy") return null;
    if (needs.includes("livestock") && !ctx.live) return null;
    const fitCl = m.climates.includes(ctx.cl) ? 1 : 0.35;
    const fitCrop = m.crops.includes(ctx.crop) ? 1 : 0.4;
    const fitWater = m.water.includes(ctx.water) ? 1 : 0.5;
    const fitScale = m.scale.includes(ctx.scale) ? 1 : ctx.scale === "large" && m.labour === 3 ? 0.2 : 0.55;
    const probs = [...ctx.prob];
    const need = probs.length ? probs.reduce((s, p) => s + m.provides[PROB_NUT[p]] / 3, 0) / probs.length : (m.provides.N + m.provides.P + m.provides.OM) / 9;
    const v = Math.pow(need, 0.8) * fitCl * fitCrop * fitWater * fitScale * STRENGTH[m.strength];
    const reasons = [];
    probs.filter((p) => m.provides[PROB_NUT[p]] >= 2).forEach((p) => reasons.push(`${m.provides[PROB_NUT[p]] === 3 ? "Main fix" : "Helps"} for ${OPTS.prob[p].toLowerCase()} soil`));
    if (fitCrop === 1 && m.crops.length < 7) reasons.push(`Proven with ${CROP_LABEL[ctx.crop]}`);
    if (needs.includes("paddy")) reasons.push("Built for flooded paddies");
    if (needs.includes("wetland")) reasons.push("Uses your wetland water");
    if (fitCl < 1) reasons.push(`Less proven in ${OPTS.cl[ctx.cl].toLowerCase()} conditions`);
    if (fitScale < 1) reasons.push(ctx.scale === "large" ? "Labour heavy at this scale" : "Usually used at another farm size");
    return { m, v, reasons };
  }

  // ---------- exposure ----------
  function drawExposure() {
    const el = $("#exposure");
    if (!ctx.country) { el.innerHTML = `<p class="note">Custom farm. Pick a country to see its fertiliser import exposure.</p>`; return; }
    const c = D.countries[ctx.country];
    const fv = foodVul(c);
    const gauge = (label, v, txt, hi) => `<div class="gauge"><span class="k">${label}</span><span class="v">${txt}</span><div class="vbar"><span style="width:${Math.min(100, v * 100)}%;background:${hi ? "var(--seq-vul)" : "var(--seq-soil)"}"></span></div></div>`;
    const level = fv >= 0.5 ? ["High", "severe"] : fv >= 0.35 ? ["Moderate", "elevated"] : ["Low", "open"];
    el.innerHTML = `<div class="ex-head"><div><span class="eyebrow">Fertiliser supply risk</span><h2>${c.n}</h2></div><span class="pill st-${level[1]}">${level[0]} food input vulnerability</span></div>
      <div class="gauges">
        ${gauge("Soil fertility index", c.soil / 100, `${c.soil}/100`, false)}
        ${gauge("Fertiliser imported", c.fertImp, pct(c.fertImp), true)}
        ${gauge("Of imports via Hormuz", c.fertHz, pct(c.fertHz), true)}
        ${gauge("Food input vulnerability", fv, fv.toFixed(2), true)}
      </div>
      <p class="note">${riskSentence(c)} Soil and fertiliser figures are the Ledger's teaching estimates.</p>`;
  }
  function riskSentence(c) {
    const parts = [];
    if (c.fertImp >= 0.6) parts.push(`${c.n} imports most of its fertiliser (${pct(c.fertImp)})`);
    else if (c.fertImp >= 0.3) parts.push(`${c.n} imports a large share of its fertiliser (${pct(c.fertImp)})`);
    else parts.push(`${c.n} makes most of its own fertiliser`);
    if (c.fertHz >= 0.3) parts.push(`and ${pct(c.fertHz)} of those imports pass through the Strait of Hormuz`);
    if (c.soil < 45) parts.push(`on soils that start poor (index ${c.soil})`);
    return parts.join(" ") + ".";
  }

  // ---------- plan ----------
  function drawPlan(scored) {
    const yrs = { 0: "Works this season", 1: "1 to 3 years", 5: "5+ years" };
    $("#planNote").textContent = `${OPTS.cl[ctx.cl]}, ${CROP_LABEL[ctx.crop]}, ${OPTS.water[ctx.water].toLowerCase()}, ${OPTS.scale[ctx.scale].toLowerCase()}`;
    $("#stages").innerHTML = STAGES.map((st) => {
      const picks = scored.filter((s) => s.m.years === st.y).slice(0, 4);
      return `<div class="stage"><div class="st-head"><h3>${st.t}</h3><span class="note">${st.d}</span></div>
        ${picks.length ? picks.map((s, i) => `<article class="pick${i === 0 ? " top" : ""}">
          <div class="mhead"><h4>${s.m.name}</h4><span class="strength ${s.m.strength}">${s.m.strength}</span></div>
          <div class="fit"><div class="vbar"><span style="width:${Math.round(s.v * 100)}%;background:var(--s-open)"></span></div><span class="mono">${s.v.toFixed(2)}</span></div>
          <div class="mstat">${s.m.stat}<small>${s.m.statNote}</small></div>
          ${s.reasons.length ? `<ul class="why">${s.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>` : ""}
          <p class="lim"><b>Watch for.</b> ${s.m.limits}</p>
          ${s.m.bridge ? `<p class="note">Bridge method: still uses a small amount of fertiliser.</p>` : ""}
        </article>`).join("") : `<p class="note empty">Nothing in the catalogue fits well at this stage for this context.</p>`}
      </div>`;
    }).join("");
  }

  // ---------- coverage ----------
  function drawCoverage(scored) {
    const top = STAGES.flatMap((st) => scored.filter((s) => s.m.years === st.y).slice(0, 4));
    const nuts = ["N", "P", "K", "OM", "pH", "water"];
    const mark = (v) => `<span class="cv c${Math.max(0, v)}" role="img" aria-label="${["none", "some", "good", "main source"][Math.max(0, v)]}" title="${["none", "some", "good", "main source"][Math.max(0, v)]}"></span>`;
    const best = Object.fromEntries(nuts.map((n) => [n, Math.max(0, ...top.map((s) => s.m.provides[n]))]));
    $("#covTable").innerHTML = `<caption class="note" style="caption-side:bottom;text-align:left;padding-top:8px"><span class="cv c3"></span> main source <span class="cv c2"></span> good <span class="cv c1"></span> some <span class="cv c0"></span> none</caption><thead><tr><th>Method</th>${nuts.map((n) => `<th class="num">${NUT_LABEL[n]}</th>`).join("")}</tr></thead>
      <tbody>${top.map((s) => `<tr><td>${s.m.name}</td>${nuts.map((n) => `<td class="num">${mark(s.m.provides[n])}</td>`).join("")}</tr>`).join("")}
      <tr class="sum"><td><b>Plan covers</b></td>${nuts.map((n) => `<td class="num">${mark(best[n])}</td>`).join("")}</tr></tbody>`;
    const needed = [...ctx.prob].map((p) => PROB_NUT[p]);
    const gaps = [];
    if (best.P < 2) gaps.push(["P", "No strong phosphorus source in this plan. Biology cannot make phosphorus. Add manure, composted crop residues, urine or treated excreta, or local rock phosphate on acidic soils, and keep a small mineral P reserve."]);
    if (best.K < 2 && (needed.includes("K") || ctx.cl === "humid")) gaps.push(["K", "Potassium is thin. Return straw and ash to the field rather than burning or selling it, and add manure where possible."]);
    if (needed.includes("pH") && best.pH < 2) gaps.push(["pH", "Acidity is not addressed. Lime, wood ash or biochar lift pH, and phosphorus and nitrogen fixation both work poorly in acidic soil."]);
    if (needed.includes("water") && best.water < 2) gaps.push(["water", "Water is the limit. Nutrients do little in dry or crusted soil until water harvesting (pits, bunds, mulch) holds rain where the roots are."]);
    if (needed.includes("N") && best.N < 2) gaps.push(["N", "Nitrogen is not well covered. A legume in the rotation or intercrop is the cheapest fix in almost every system."]);
    $("#gaps").innerHTML = gaps.length ? gaps.map(([n, t]) => `<p class="gap"><b>${NUT_LABEL[n]} gap.</b> ${t}</p>`).join("") : `<p class="gap ok"><b>No major gaps.</b> The top picks cover the problems you selected. Re-test soil every few seasons, because recycled systems can still drift.</p>`;
  }

  // ---------- system moves ----------
  function drawSystem() {
    const c = ctx.country ? D.countries[ctx.country] : null;
    const fire = {
      imports: c && c.fertImp >= 0.4, hormuz: c && c.fertHz >= 0.2, legume: ctx.crop === "soy" || ctx.prob.has("lowN"),
      smallholder: ctx.scale === "small", always: true, acid: ctx.prob.has("acid"), largeImporter: c && c.fertImp >= 0.6
    };
    const why = {
      imports: c ? `${c.n} imports ${pct(c.fertImp)} of its fertiliser, so a late cargo is a lost season.` : "",
      hormuz: c ? `${pct(c.fertHz)} of ${c.n}'s fertiliser imports come through the Strait of Hormuz.` : "",
      legume: ctx.crop === "soy" ? "Your main crop is a legume, so the gain is immediate." : "Nitrogen is a listed problem, and fixation is the only way to make it without imports.",
      smallholder: "Small farms are where these methods have the strongest evidence.",
      always: "Every town is a nutrient source.",
      acid: "Acidic soils were selected.",
      largeImporter: c ? `Imports make up ${pct(c.fertImp)} of supply.` : ""
    };
    const list = S.system.filter((s) => fire[s.when]);
    $("#sys").innerHTML = list.map((s) => `<li><b>${s.name}</b><span>${s.why}</span>${why[s.when] ? `<span class="here">Here: ${why[s.when]}</span>` : ""}</li>`).join("");
  }

  function drawSources() {
    const used = new Set(S.methods.flatMap((m) => m.src));
    $("#psources").innerHTML = "Sources: " + [...used].map((k) => S.sources[k]).filter(Boolean).map((s) => `<a href="${s.u}" target="_blank" rel="noopener">${s.t}</a>`).join(" · ");
  }

  function render() {
    drawForm();
    drawExposure();
    const scored = S.methods.map(scoreMethod).filter((s) => s && s.v >= 0.12).sort((a, b) => b.v - a.v);
    drawPlan(scored);
    drawCoverage(scored);
    drawSystem();
  }

  // ---------- start ----------
  const h = (location.hash || "").replace("#c", "");
  if (h && D.countries[h] && S.context[h]) ctx.country = h;
  Object.assign(ctx, defaultsFor(ctx.country));
  drawSources();
  render();
  window.plannerReady = true;
})();
