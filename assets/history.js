/* Price history tab for the Chokepoint Ledger.
   Reads data/history.json (monthly World Bank and IMF series back to 1960, plus US CPI),
   which scripts/update_feed.py rebuilds every day. D3 v7. */
(() => {
  const $ = (s) => document.querySelector(s);
  const RANGES = [["1y", "1Y", 12], ["5y", "5Y", 60], ["10y", "10Y", 120], ["25y", "25Y", 300], ["max", "Max", 99999]];
  const MODES = [["price", "Price"], ["index", "Indexed to 100"], ["real", "Inflation adjusted"]];
  const GROUP_ORDER = ["Energy", "Fertiliser", "Metals", "Precious", "Food"];
  const SLOTS = 6;
  // Events drawn on the chart. g limits an event to series groups or ids.
  const EVENTS = [
    ["1973-10", "Arab oil embargo"],
    ["1979-01", "Iranian revolution"],
    ["1986-01", "Saudi netback price war"],
    ["1990-08", "Iraq invades Kuwait"],
    ["2003-03", "Iraq war"],
    ["2007-06", "Uranium spot peak", ["URANIUM"]],
    ["2008-07", "Commodity supercycle peak"],
    ["2011-03", "Fukushima", ["URANIUM", "LNGASIA", "COAL"]],
    ["2014-11", "OPEC market share war", ["Energy"]],
    ["2016-05", "Lithium boom begins", ["LITHIUM", "COBALT"]],
    ["2020-04", "COVID demand collapse"],
    ["2022-02", "Russia invades Ukraine"],
    ["2026-03", "Strait of Hormuz closed"]
  ];
  const st = { range: "10y", mode: "price", log: false, events: true, sel: ["BRENT"], slot: { BRENT: 0 }, sort: null };
  let H = null, BY = {}, LAST = null, cpi = null;

  // ---------- month helpers ----------
  const mIdx = (ym) => +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1);
  const mStr = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
  const mDate = (i) => new Date(Date.UTC(Math.floor(i / 12), i % 12, 15));
  const valAt = (s, i) => { const k = i - s.i0; return k >= 0 && k < s.v.length ? s.v[k] : null; };
  const lastIdx = (s) => { for (let k = s.v.length - 1; k >= 0; k--) if (s.v[k] != null) return s.i0 + k; return null; };
  function cpiAt(i) {
    if (!cpi) return null;
    const k = Math.min(i - cpi.i0, cpi.lastK);
    return k >= 0 ? cpi.v[k] : null;
  }

  // ---------- public helpers for the live strip ----------
  function changes(id) {
    const s = BY[id];
    if (!s) return null;
    const li = lastIdx(s), v = valAt(s, li);
    const ch = (m) => { const b = valAt(s, li - m); return b ? v / b - 1 : null; };
    return { y1: ch(12), y5: ch(60), y10: ch(120), y25: ch(300), last: mStr(li) };
  }
  window.histChanges = changes;

  // ---------- colours: categorical slots, the slot follows the series ----------
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const slotColor = (id) => css(`--series-${(st.slot[id] ?? 0) + 1}`);

  // ---------- controls ----------
  function chips(el, items, cur, on) {
    el.innerHTML = items.map(([k, t]) => `<button type="button" class="chip" role="radio" aria-checked="${k === cur}" aria-pressed="${k === cur}" data-k="${k}">${t}</button>`).join("");
    el.querySelectorAll(".chip").forEach((b) => (b.onclick = () => on(b.dataset.k)));
  }
  function drawControls() {
    chips($("#hRange"), RANGES.map(([k, t]) => [k, t]), st.range, (k) => { st.range = k; drawAll(); });
    chips($("#hMode"), MODES, st.mode, (k) => { st.mode = k; drawAll(); });
    $("#hLog").checked = st.log;
    $("#hEvents").checked = st.events;
  }
  $("#hLog").onchange = (e) => { st.log = e.target.checked; drawChart(); };
  $("#hEvents").onchange = (e) => { st.events = e.target.checked; drawChart(); };

  function toggle(id) {
    if (st.sel.includes(id)) {
      if (st.sel.length === 1) return;
      st.sel = st.sel.filter((x) => x !== id);
      delete st.slot[id];
    } else {
      if (st.sel.length >= SLOTS) { flash(`Up to ${SLOTS} series at once. Remove one first.`); return; }
      const used = new Set(Object.values(st.slot));
      let k = 0; while (used.has(k)) k++;
      st.slot[id] = k;
      st.sel = [...st.sel, id];
    }
    drawAll();
  }
  function flash(msg) { $("#hNote").textContent = msg; }

  function drawPicker() {
    const groups = GROUP_ORDER.filter((g) => H.series.some((s) => s.group === g));
    $("#hPick").innerHTML = groups.map((g) => `<div class="hgroup"><span class="lab">${g}</span><div class="chips">` +
      H.series.filter((s) => s.group === g).map((s) => {
        const on = st.sel.includes(s.id);
        return `<button type="button" class="chip hchip" aria-pressed="${on}" data-id="${s.id}">${on ? `<i style="background:${slotColor(s.id)}"></i>` : ""}${s.label}</button>`;
      }).join("") + "</div></div>").join("");
    $("#hPick").querySelectorAll(".hchip").forEach((b) => (b.onclick = () => toggle(b.dataset.id)));
  }

  // ---------- chart ----------
  function effectiveMode() {
    if (st.mode !== "price") return st.mode;
    const units = new Set(st.sel.map((id) => BY[id].unit));
    return units.size > 1 ? "index" : "price";
  }
  function seriesData(id, i0, i1, mode) {
    const s = BY[id], base = cpiAt(LAST);
    const pts = [];
    for (let i = Math.max(i0, s.i0); i <= i1; i++) {
      let v = valAt(s, i);
      if (v == null) { pts.push([i, null]); continue; }
      if (mode === "real" && base) { const c = cpiAt(i); v = c ? (v * base) / c : null; }
      pts.push([i, v]);
    }
    if (mode === "index") {
      const first = pts.find((p) => p[1] != null);
      const b0 = first ? first[1] : null;
      if (b0) pts.forEach((p) => { if (p[1] != null) p[1] = (p[1] / b0) * 100; });
    }
    return pts;
  }
  const fmtV = (v) => (v == null ? "n/a" : Math.abs(v) >= 1000 ? d3.format(",.0f")(v) : Math.abs(v) >= 100 ? d3.format(".0f")(v) : Math.abs(v) >= 10 ? d3.format(".1f")(v) : d3.format(".2f")(v));

  function drawLegend(mode) {
    $("#hLegend").innerHTML = st.sel.map((id) => {
      const s = BY[id];
      return `<button type="button" class="hleg" data-id="${id}" title="Remove ${s.label}"><svg width="18" height="8" aria-hidden="true"><line x1="0" x2="18" y1="4" y2="4" stroke="${slotColor(id)}" stroke-width="2.5" stroke-linecap="round"/></svg><span></span><small>${mode === "index" ? "index" : s.unit}${mode === "real" ? ", today's $" : ""}</small>${st.sel.length > 1 ? "<b aria-hidden=\"true\">×</b>" : ""}</button>`;
    }).join("");
    $("#hLegend").querySelectorAll(".hleg").forEach((b) => { b.querySelector("span").textContent = BY[b.dataset.id].label; b.onclick = () => toggle(b.dataset.id); });
  }

  function drawChart() {
    if (!H) return;
    const svgEl = $("#hSvg");
    const W = Math.max(320, svgEl.clientWidth || svgEl.parentNode.clientWidth || 900);
    const Hh = Math.round(Math.min(460, Math.max(260, W * 0.42)));
    const m = { t: 40, r: 64, b: 26, l: 56 };
    const mode = effectiveMode();
    const months = RANGES.find((r) => r[0] === st.range)[2];
    const earliest = Math.min(...st.sel.map((id) => BY[id].i0));
    const i1 = LAST, i0 = Math.max(earliest, i1 - months + 1);
    const data = st.sel.map((id) => ({ id, pts: seriesData(id, i0, i1, mode) }));
    const all = data.flatMap((d) => d.pts.map((p) => p[1])).filter((v) => v != null && v > 0);
    const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${Hh}`).attr("height", Hh);
    svg.selectAll("*").remove();
    if (!all.length) { flash("No data in this range for the selected series."); return; }
    const x = d3.scaleUtc().domain([mDate(i0), mDate(i1)]).range([m.l, W - m.r]);
    const lo = d3.min(all), hi = d3.max(all);
    const y = st.log ? d3.scaleLog().domain([lo * 0.9, hi * 1.1]).range([Hh - m.b, m.t])
                     : d3.scaleLinear().domain([Math.min(0, lo), hi * 1.05]).range([Hh - m.b, m.t]).nice();
    const g = svg.append("g");
    // grid and axes
    const yt = st.log ? y.ticks(6).filter((t, k, a) => a.length < 9 || [1, 2, 5].includes(+String(t)[0])) : y.ticks(6);
    g.append("g").attr("class", "hgrid").selectAll("line").data(yt).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "haxis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickSize(0).tickPadding(8).tickFormat((v) => fmtV(v))).call((a) => a.select(".domain").remove());
    const span = i1 - i0;
    g.append("g").attr("class", "haxis").attr("transform", `translate(0,${Hh - m.b})`)
      .call(d3.axisBottom(x).ticks(Math.min(span <= 14 ? 12 : 10, Math.floor(W / 80))).tickSize(4).tickFormat(span <= 14 ? d3.utcFormat("%b %y") : d3.utcFormat("%Y")));
    if (mode === "index") g.append("line").attr("class", "hbase").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(100)).attr("y2", y(100));
    // events
    if (st.events) {
      const groups = new Set(st.sel.map((id) => BY[id].group));
      const ev = EVENTS.filter(([d, , only]) => { const i = mIdx(d); return i >= i0 && i <= i1 && (!only || only.some((o) => st.sel.includes(o) || groups.has(o))); });
      const eg = g.append("g").attr("class", "hevents");
      const rows = [[], [], []];
      ev.forEach(([d, label]) => {
        const ex = x(mDate(mIdx(d)));
        const w = label.length * 5.4 + 6;
        const right = ex + w > W - 4;
        const span = right ? [ex - w, ex] : [ex, ex + w];
        const r = rows.findIndex((row) => row.every(([a, b]) => span[1] < a || span[0] > b));
        eg.append("line").attr("x1", ex).attr("x2", ex).attr("y1", r < 0 ? m.t : m.t - 30 + r * 11).attr("y2", Hh - m.b).append("title").text(label);
        if (r < 0) return; // no free row: keep the line, drop the label
        rows[r].push(span);
        eg.append("text").attr("x", right ? ex - 3 : ex + 3).attr("y", m.t - 32 + r * 11 + 9).attr("text-anchor", right ? "end" : "start").text(label);
      });
    }
    // lines
    const line = d3.line().defined((p) => p[1] != null && (!st.log || p[1] > 0)).x((p) => x(mDate(p[0]))).y((p) => y(p[1]));
    data.forEach((d) => g.append("path").attr("class", "hline").attr("stroke", slotColor(d.id)).attr("d", line(d.pts)));
    // end labels (direct labels for up to four series)
    if (data.length <= 4) {
      const ends = data.map((d) => { const p = [...d.pts].reverse().find((q) => q[1] != null); return p ? { id: d.id, y: y(p[1]), v: p[1] } : null; }).filter(Boolean).sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
      ends.forEach((e) => g.append("text").attr("class", "hend").attr("x", W - m.r + 6).attr("y", e.y + 4).text(fmtV(e.v)));
    }
    // crosshair
    const hover = g.append("g").attr("class", "hhover").style("display", "none");
    hover.append("line").attr("y1", m.t).attr("y2", Hh - m.b);
    const dots = data.map((d) => hover.append("circle").attr("r", 4).attr("fill", slotColor(d.id)));
    const tip = d3.select("#tip");
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (e) => {
        const [px] = d3.pointer(e);
        const t = x.invert(px);
        const i = Math.max(i0, Math.min(i1, t.getUTCFullYear() * 12 + t.getUTCMonth() + (t.getUTCDate() > 15 ? 1 : 0)));
        const hx = x(mDate(i));
        hover.style("display", null).select("line").attr("x1", hx).attr("x2", hx);
        const rows = data.map((d, k) => {
          const p = d.pts.find((q) => q[0] === i);
          const v = p ? p[1] : null;
          dots[k].attr("cx", hx).attr("cy", v == null ? -99 : y(v)).style("display", v == null ? "none" : null);
          return { id: d.id, v };
        }).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
        const box = tip.node();
        box.innerHTML = `<span class="mono">${d3.utcFormat("%b %Y")(mDate(i))}</span>` + rows.map((r) =>
          `<div class="trow"><svg width="12" height="6" aria-hidden="true"><line x1="0" x2="12" y1="3" y2="3" stroke="${slotColor(r.id)}" stroke-width="2.5"/></svg><b>${fmtV(r.v)}</b> <span></span></div>`).join("");
        box.querySelectorAll(".trow span").forEach((sp, k) => (sp.textContent = BY[rows[k].id].label + (mode === "index" ? "" : " " + BY[rows[k].id].unit)));
        box.hidden = false;
        const pad = 14, w = box.offsetWidth, h = box.offsetHeight;
        let tx = e.clientX + pad, ty = e.clientY + pad;
        if (tx + w > innerWidth - 8) tx = e.clientX - w - pad;
        if (ty + h > innerHeight - 8) ty = e.clientY - h - pad;
        box.style.left = tx + "px"; box.style.top = ty + "px";
      })
      .on("pointerleave", () => { hover.style("display", "none"); tip.node().hidden = true; });

    drawLegend(mode);
    const srcs = [...new Set(st.sel.map((id) => BY[id].src))].join(" and ");
    const notes = [];
    if (st.mode === "price" && mode === "index") notes.push("Units differ, so the chart is indexed to 100 at the start of the range. Pick one series, or series with the same unit, to see prices.");
    if (mode === "real") notes.push(`Inflation adjusted to ${mStr(LAST)} US dollars with ${H.cpi ? H.cpi.src : "US CPI"}.`);
    if (mode === "index") notes.push(`Each line is 100 at its first month in the range.`);
    const short = st.sel.filter((id) => BY[id].i0 > i1 - months + 1 && st.range !== "1y");
    if (short.length) notes.push(`${short.map((id) => BY[id].label).join(", ")} ${short.length > 1 ? "start" : "starts"} later than the range (${short.map((id) => mStr(BY[id].i0).slice(0, 4)).join(", ")}).`);
    notes.push(`Monthly averages, latest ${mStr(LAST)}. Source: ${srcs}.`);
    $("#hNote").textContent = notes.join(" ");
  }

  // ---------- horizon table ----------
  function stats(s) {
    const li = lastIdx(s), v = valAt(s, li);
    const ch = (mo) => { const b = valAt(s, li - mo); return b ? v / b - 1 : null; };
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0, hiI = null;
    const base = cpiAt(li);
    for (let i = li - 299; i <= li; i++) {
      const x = valAt(s, i);
      if (x == null) continue;
      if (x < lo) lo = x;
      if (x > hi) { hi = x; hiI = i; }
      const c = cpiAt(i);
      if (c && base) { sum += (x * base) / c; n++; }
    }
    return { li, v, y1: ch(12), y5: ch(60), y10: ch(120), y25: ch(300), lo, hi, hiI, pos: hi > lo ? (v - lo) / (hi - lo) : null, real: n ? v / (sum / n) - 1 : null };
  }
  const COLS = [
    ["label", "Series", (r) => r.s.label], ["v", "Latest", (r) => r.v, true], ["y1", "1y", (r) => r.y1, true], ["y5", "5y", (r) => r.y5, true],
    ["y10", "10y", (r) => r.y10, true], ["y25", "25y", (r) => r.y25, true], ["pos", "25y range", (r) => r.pos, true], ["real", "Real vs 25y avg", (r) => r.real, true]
  ];
  function drawTable() {
    const rows = H.series.map((s) => ({ s, ...stats(BY[s.id]) }));
    if (st.sort) {
      const c = COLS.find((x) => x[0] === st.sort.k);
      rows.sort((a, b) => { const va = c[2](a), vb = c[2](b); if (va == null) return 1; if (vb == null) return -1; return (va < vb ? -1 : va > vb ? 1 : 0) * st.sort.dir; });
    } else rows.sort((a, b) => GROUP_ORDER.indexOf(a.s.group) - GROUP_ORDER.indexOf(b.s.group));
    const pc = (v) => (v == null ? `<span class="muted">n/a</span>` : Math.abs(v) < 0.005 ? "0%" : d3.format("+.0%")(v));
    let lastG = null;
    $("#hTable").innerHTML = `<thead><tr>${COLS.map(([k, t, , num]) => `<th class="${num ? "num" : ""}" data-k="${k}" aria-sort="${st.sort && st.sort.k === k ? (st.sort.dir > 0 ? "ascending" : "descending") : "none"}">${t}</th>`).join("")}<th>Since</th></tr></thead><tbody>` +
      rows.map((r) => {
        const sep = !st.sort && r.s.group !== lastG ? `<tr class="gsep"><td colspan="9">${(lastG = r.s.group)}</td></tr>` : "";
        return sep + `<tr data-id="${r.s.id}" class="${st.sel.includes(r.s.id) ? "sel" : ""}"><td>${st.sel.includes(r.s.id) ? `<i class="gdot" style="background:${slotColor(r.s.id)}"></i>` : ""}${r.s.label}<small class="u">${r.s.unit}</small></td>
          <td class="num">${fmtV(r.v)} <small class="u">${mStr(r.li)}</small></td><td class="num">${pc(r.y1)}</td><td class="num">${pc(r.y5)}</td><td class="num">${pc(r.y10)}</td><td class="num">${pc(r.y25)}</td>
          <td class="num"><span class="rbar" title="25y low ${fmtV(r.lo)}, high ${fmtV(r.hi)} (${r.hiI != null ? mStr(r.hiI) : ""})"><span style="left:${Math.round((r.pos ?? 0) * 100)}%"></span></span></td>
          <td class="num">${pc(r.real)}</td><td class="num"><small class="u">${mStr(BY[r.s.id].i0).slice(0, 4)}</small></td></tr>`;
      }).join("") + "</tbody>";
    $("#hTable").querySelectorAll("tbody tr[data-id]").forEach((tr) => (tr.onclick = () => toggle(tr.dataset.id)));
    $("#hTable").querySelectorAll("th[data-k]").forEach((th) => (th.onclick = () => {
      const k = th.dataset.k;
      st.sort = st.sort && st.sort.k === k ? (st.sort.dir < 0 ? { k, dir: 1 } : null) : { k, dir: k === "label" ? 1 : -1 };
      drawTable();
    }));
  }

  function drawAll() { drawControls(); drawPicker(); drawChart(); drawTable(); }

  // ---------- load ----------
  fetch("data/history.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((j) => {
      H = j;
      H.series.forEach((s) => { s.i0 = mIdx(s.start); BY[s.id] = s; });
      LAST = Math.max(...H.series.map(lastIdx));
      if (H.cpi) {
        cpi = { i0: mIdx(H.cpi.start), v: H.cpi.v.slice() };
        let lk = cpi.v.length - 1; while (lk > 0 && cpi.v[lk] == null) lk--;
        for (let k = 1; k <= lk; k++) if (cpi.v[k] == null) cpi.v[k] = cpi.v[k - 1];
        cpi.lastK = lk; // months after the last CPI print reuse it
      } else MODES.splice(2, 1);
      $("#hStamp").textContent = `Updated ${H.updated.slice(0, 10)}. ${H.series.length} series.`;
      window.HIST = H;
      document.dispatchEvent(new Event("hist-ready"));
      if (!$("#p-hist").hidden) drawAll();
    })
    .catch(() => { $("#hNote").textContent = "Price history is not available yet. It is built by the daily feed workflow."; });

  window.histShow = () => { if (H) drawAll(); };
  window.histSet = (o) => {
    if (o.range) st.range = o.range;
    if (o.mode) st.mode = o.mode;
    if (o.log !== undefined) st.log = !!o.log;
    if (o.ids) { st.sel = o.ids.slice(0, SLOTS); st.slot = Object.fromEntries(st.sel.map((id, k) => [id, k])); }
    if (H) drawAll();
  };
  let rw = 0;
  new ResizeObserver(() => { const w = $("#hSvg").clientWidth; if (H && w && Math.abs(w - rw) > 20 && !$("#p-hist").hidden) { rw = w; drawChart(); } }).observe($("#p-hist"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => H && !$("#p-hist").hidden && drawAll());
  new MutationObserver(() => H && !$("#p-hist").hidden && drawAll()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
