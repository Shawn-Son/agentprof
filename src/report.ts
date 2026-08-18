/**
 * Self-contained HTML report renderer. No external assets, no CDN, no JS
 * frameworks — the output is a single file you can open, share, or attach.
 */

import type { SessionProfile, WasteFinding } from "./types.js";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const usd = (n: number): string =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

const compact = (n: number): string => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

const pct = (x: number): string => (x * 100).toFixed(1) + "%";

const KIND_LABEL: Record<WasteFinding["kind"], string> = {
  reread: "Reread",
  "duplicate-call": "Duplicate call",
  retry: "Retry Tax",
};

const KIND_COLOR: Record<WasteFinding["kind"], string> = {
  reread: "#f59e0b",
  "duplicate-call": "#a78bfa",
  retry: "#ef4444",
};

export function renderReport(profile: SessionProfile): string {
  const t = profile.trajectory;
  const durationMin = profile.durationMs / 60000;
  const models = [...new Set(t.steps.map((s) => s.model))].filter(
    (m) => m !== "<synthetic>",
  );
  const toolCallCount = t.steps.reduce((n, s) => n + s.toolCalls.length, 0);

  const wasteStepSet = new Set<number>(
    profile.findings.flatMap((f) => f.stepIndices),
  );

  // ---- timeline bars ----
  // sqrt scale so one giant request (e.g. a compaction cache-write) doesn't
  // flatten every other bar
  const maxStepCost = Math.max(...profile.stepCosts.map((sc) => sc.cost.total), 1e-9);
  const bars = profile.stepCosts
    .map((sc) => {
      const c = sc.cost;
      const scale = Math.sqrt(c.total / maxStepCost);
      const h = (seg: number) =>
        c.total > 0 ? Math.max((seg / c.total) * scale * 100, 0) : 0;
      const wasted = wasteStepSet.has(sc.step.index);
      const tip = `Step ${sc.step.index + 1} — ${esc(sc.step.model)}\n${usd(c.total)} total\ncache read ${usd(c.cacheRead)} · cache write ${usd(c.cacheWrite)}\ninput ${usd(c.input)} · output ${usd(c.output)}\n${sc.step.toolCalls.map((x) => x.name).join(", ") || "no tools"}`;
      return `<div class="bar${wasted ? " wasted" : ""}${sc.step.isSidechain ? " side" : ""}" data-tip="${esc(tip)}">
        <i class="s-cw" style="height:${h(c.cacheWrite)}%"></i>
        <i class="s-cr" style="height:${h(c.cacheRead)}%"></i>
        <i class="s-in" style="height:${h(c.input)}%"></i>
        <i class="s-out" style="height:${h(c.output)}%"></i>
      </div>`;
    })
    .join("");

  // ---- context snowball (context size ≈ input + cacheRead + cacheWrite per request) ----
  const ctxSizes = profile.stepCosts.map(
    (sc) =>
      sc.step.usage.inputTokens +
      sc.step.usage.cacheReadTokens +
      sc.step.usage.cacheWrite5mTokens +
      sc.step.usage.cacheWrite1hTokens,
  );
  const maxCtx = Math.max(...ctxSizes, 1);
  const W = 1000;
  const H = 120;
  const pts = ctxSizes
    .map((v, i) => {
      const x = ctxSizes.length > 1 ? (i / (ctxSizes.length - 1)) * W : 0;
      const y = H - (v / maxCtx) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const contextChart = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:120px;display:block">
    <polygon points="0,${H} ${pts} ${W},${H}" fill="#3b82f622"/>
    <polyline points="${pts}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
  </svg>
  <div class="legend"><span>peak context ${compact(maxCtx)} tokens · every request re-pays its full context (cached tokens at 0.1× input price)</span></div>`;

  // ---- findings rows ----
  const findingRows = profile.findings
    .slice(0, 60)
    .map(
      (f) => `<tr>
      <td><span class="badge" style="background:${KIND_COLOR[f.kind]}22;color:${KIND_COLOR[f.kind]}">${KIND_LABEL[f.kind]}</span></td>
      <td class="mono label">${esc(f.label)}</td>
      <td class="num">${f.occurrences}×</td>
      <td class="num">${compact(f.wastedTokens)}</td>
      <td class="num cost">${usd(f.wastedCost)}</td>
    </tr>`,
    )
    .join("");

  const wasteByKind = (["reread", "duplicate-call", "retry"] as const).map((k) => {
    const fs = profile.findings.filter((f) => f.kind === k);
    return {
      kind: k,
      cost: fs.reduce((n, f) => n + f.wastedCost, 0),
      count: fs.reduce((n, f) => n + f.occurrences, 0),
    };
  });

  const wasteKindBar = wasteByKind
    .filter((w) => w.cost > 0)
    .map(
      (w) =>
        `<div style="flex:${Math.max(w.cost, 1e-9)};background:${KIND_COLOR[w.kind]}" title="${KIND_LABEL[w.kind]}: ${usd(w.cost)}"></div>`,
    )
    .join("");

  const toolRows = profile.toolStats
    .slice(0, 20)
    .map(
      (s) => `<tr>
      <td class="mono">${esc(s.name)}</td>
      <td class="num">${s.calls}</td>
      <td class="num">${s.errors > 0 ? `<span class="err">${s.errors}</span>` : "0"}</td>
      <td class="num">${compact(s.resultTokens)}</td>
      <td class="num cost">${usd(s.estContextCost)}</td>
    </tr>`,
    )
    .join("");

  const unknownNote = profile.unknownModels.length
    ? `<p class="note warn">⚠ Unknown model pricing for: ${profile.unknownModels.map(esc).join(", ")} — their cost is counted as $0.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentprof — ${esc(t.sessionId.slice(0, 8))}</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #12161f; --border: #1f2633;
    --text: #e6e9ef; --dim: #8b94a7;
    --cr: #3b82f6; --cw: #22d3ee; --in: #34d399; --out: #f472b6;
    --waste: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 32px 24px 64px; max-width: 1080px; margin: 0 auto; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
  header { margin-bottom: 24px; }
  header h1 { font-size: 20px; letter-spacing: -0.02em; }
  header h1 b { color: #60a5fa; }
  header .meta { color: var(--dim); margin-top: 6px; font-size: 13px; }
  .prompt { color: var(--dim); font-style: italic; margin-top: 8px; border-left: 3px solid var(--border); padding-left: 10px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .k { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .card .v { font-size: 24px; font-weight: 650; margin-top: 4px; letter-spacing: -0.02em; }
  .card.waste .v { color: var(--waste); }
  .card .sub { color: var(--dim); font-size: 12px; margin-top: 2px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin: 16px 0; }
  section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin-bottom: 12px; }
  .timeline { display: flex; align-items: flex-end; gap: 2px; height: 140px; overflow-x: auto; padding-bottom: 4px; }
  .bar { position: relative; flex: 1 0 6px; max-width: 22px; height: 100%; display: flex; flex-direction: column-reverse; cursor: default; border-radius: 2px 2px 0 0; overflow: visible; }
  .bar i { display: block; width: 100%; }
  .bar .s-cr { background: var(--cr); } .bar .s-cw { background: var(--cw); }
  .bar .s-in { background: var(--in); } .bar .s-out { background: var(--out); }
  .bar.wasted::after { content: ""; position: absolute; top: -8px; left: 50%; transform: translateX(-50%); width: 5px; height: 5px; border-radius: 50%; background: var(--waste); }
  .bar.side { opacity: 0.55; }
  .bar:hover { outline: 1px solid #ffffff55; }
  .bar:hover::before { content: attr(data-tip); position: absolute; bottom: 105%; left: 0; z-index: 10; white-space: pre; background: #000000ee; border: 1px solid var(--border); color: var(--text); font-size: 11.5px; padding: 8px 10px; border-radius: 8px; pointer-events: none; }
  .legend { display: flex; gap: 16px; color: var(--dim); font-size: 12px; margin-top: 10px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .wastebar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; gap: 2px; margin: 6px 0 14px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cost { font-weight: 600; }
  .label { word-break: break-all; color: #c9d1de; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .err { color: var(--waste); font-weight: 600; }
  .note { color: var(--dim); font-size: 12.5px; margin-top: 10px; }
  .note.warn { color: #f59e0b; }
  footer { color: var(--dim); font-size: 12px; margin-top: 28px; }
  footer a { color: #60a5fa; text-decoration: none; }
</style>
</head>
<body>
<header>
  <h1><b>agentprof</b> · session profile</h1>
  <div class="meta mono">${esc(t.sessionId)} · ${esc(t.cwd ?? "")} · ${models.map(esc).join(", ")} · ${t.steps.length} steps · ${toolCallCount} tool calls · ${durationMin > 90 ? (durationMin / 60).toFixed(1) + " h" : durationMin.toFixed(0) + " min"}</div>
  ${t.firstUserMessage ? `<div class="prompt">“${esc(t.firstUserMessage)}”</div>` : ""}
</header>

<div class="cards">
  <div class="card"><div class="k">Total cost</div><div class="v">${usd(profile.totalCost.total)}</div><div class="sub">list price, cache-aware</div></div>
  <div class="card waste"><div class="k">Estimated waste</div><div class="v">${usd(profile.wastedCost)}</div><div class="sub">${pct(profile.wasteRatio)} of total</div></div>
  <div class="card"><div class="k">Tokens in</div><div class="v">${compact(profile.totalUsage.inputTokens + profile.totalUsage.cacheReadTokens + profile.totalUsage.cacheWrite5mTokens + profile.totalUsage.cacheWrite1hTokens)}</div><div class="sub">${compact(profile.totalUsage.cacheReadTokens)} from cache</div></div>
  <div class="card"><div class="k">Tokens out</div><div class="v">${compact(profile.totalUsage.outputTokens)}</div><div class="sub">across ${t.steps.length} requests</div></div>
</div>

<section>
  <h2>Cost per request</h2>
  <div class="timeline">${bars}</div>
  <div class="legend">
    <span><i style="background:var(--cw)"></i>cache write</span>
    <span><i style="background:var(--cr)"></i>cache read</span>
    <span><i style="background:var(--in)"></i>input</span>
    <span><i style="background:var(--out)"></i>output</span>
    <span><i style="background:var(--waste);border-radius:50%"></i>waste detected in step</span>
  </div>
</section>

<section>
  <h2>Context snowball — tokens carried into each request</h2>
  ${contextChart}
</section>

<section>
  <h2>Where money leaked — ${usd(profile.wastedCost)} (${pct(profile.wasteRatio)})</h2>
  ${wasteKindBar ? `<div class="wastebar">${wasteKindBar}</div>` : ""}
  <table>
    <thead><tr><th>Kind</th><th>What</th><th>Repeats</th><th>Tokens</th><th>Est. cost</th></tr></thead>
    <tbody>${findingRows || `<tr><td colspan="5" class="note">No waste detected 🎉</td></tr>`}</tbody>
  </table>
  <p class="note">Waste cost = tokens × input price × (1.25 cache-write + 0.1 × each later request that re-reads them from cache). Tokens estimated at 4 chars/token. Re-reads after the file was edited are <em>not</em> counted.</p>
</section>

<section>
  <h2>Context cost by tool</h2>
  <table>
    <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Result tokens</th><th>Est. context cost</th></tr></thead>
    <tbody>${toolRows}</tbody>
  </table>
</section>

${unknownNote}
<footer>Generated by <a href="https://github.com/Shawn-Son/agentprof">agentprof</a> — measure, optimize, prove.</footer>
</body>
</html>`;
}
