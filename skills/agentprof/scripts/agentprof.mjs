#!/usr/bin/env node

// src/cli.ts
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync as statSync2,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/pricing.ts
var PRICES = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-0": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 }
};
var CACHE_READ_MULT = 0.1;
var CACHE_WRITE_5M_MULT = 1.25;
var CACHE_WRITE_1H_MULT = 2;
function priceFor(model) {
  if (!model || model === "<synthetic>") return void 0;
  if (PRICES[model]) return PRICES[model];
  const stripped = model.replace(/-\d{8}$/, "");
  if (PRICES[stripped]) return PRICES[stripped];
  let best;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? PRICES[best] : void 0;
}

// src/analyze.ts
var CHARS_PER_TOKEN = 4;
var IMAGE_TOKENS = 1600;
function resultTokens(result) {
  if (!result) return 0;
  return Math.round(result.contentChars / CHARS_PER_TOKEN) + result.imageCount * IMAGE_TOKENS;
}
var READONLY_TOOLS = /* @__PURE__ */ new Set([
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "LS",
  "NotebookRead"
]);
var FILE_MUTATING_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function stepCost(step) {
  const p = priceFor(step.model);
  if (!p) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const u = step.usage;
  const input = u.inputTokens / 1e6 * p.input;
  const output = u.outputTokens / 1e6 * p.output;
  const cacheRead = u.cacheReadTokens / 1e6 * p.input * CACHE_READ_MULT;
  const cacheWrite = u.cacheWrite5mTokens / 1e6 * p.input * CACHE_WRITE_5M_MULT + u.cacheWrite1hTokens / 1e6 * p.input * CACHE_WRITE_1H_MULT;
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}
function profileSession(trajectory) {
  const steps = trajectory.steps;
  const stepCosts = steps.map((s) => ({ step: s, cost: stepCost(s) }));
  const totalCost = stepCosts.reduce(
    (acc, sc) => ({
      input: acc.input + sc.cost.input,
      output: acc.output + sc.cost.output,
      cacheRead: acc.cacheRead + sc.cost.cacheRead,
      cacheWrite: acc.cacheWrite + sc.cost.cacheWrite,
      total: acc.total + sc.cost.total
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  );
  const totalUsage = steps.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.usage.inputTokens,
      outputTokens: acc.outputTokens + s.usage.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + s.usage.cacheReadTokens,
      cacheWrite5mTokens: acc.cacheWrite5mTokens + s.usage.cacheWrite5mTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens + s.usage.cacheWrite1hTokens
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0
    }
  );
  const unknownModels = [
    ...new Set(
      steps.filter((s) => !priceFor(s.model) && s.model !== "<synthetic>").map((s) => s.model)
    )
  ];
  const totalMain = steps.filter((s) => !s.isSidechain).length;
  const totalSide = steps.length - totalMain;
  const laterCount = new Array(steps.length).fill(0);
  let seenMain = 0;
  let seenSide = 0;
  for (const s of steps) {
    if (s.isSidechain) {
      seenSide += 1;
      laterCount[s.index] = totalSide - seenSide;
    } else {
      seenMain += 1;
      laterCount[s.index] = totalMain - seenMain;
    }
  }
  const laterSteps = (step) => laterCount[step.index] ?? 0;
  const persistenceCost = (tokens, step) => {
    const p = priceFor(step.model);
    if (!p) return 0;
    return tokens / 1e6 * p.input * (CACHE_WRITE_5M_MULT + CACHE_READ_MULT * laterSteps(step));
  };
  const findings = [
    ...detectRereads(steps, persistenceCost),
    ...detectDuplicateCalls(steps, persistenceCost),
    ...detectRetries(steps, stepCosts, persistenceCost)
  ].sort((a, b) => b.wastedCost - a.wastedCost);
  const wastedCost = findings.reduce((n, f) => n + f.wastedCost, 0);
  const wastedTokens = findings.reduce((n, f) => n + f.wastedTokens, 0);
  const toolStats = computeToolStats(steps, persistenceCost);
  const durationMs = trajectory.startTime && trajectory.endTime ? Date.parse(trajectory.endTime) - Date.parse(trajectory.startTime) : 0;
  return {
    trajectory,
    stepCosts,
    totalCost,
    totalUsage,
    durationMs,
    findings,
    wastedCost,
    wastedTokens,
    wasteRatio: totalCost.total > 0 ? wastedCost / totalCost.total : 0,
    toolStats,
    unknownModels
  };
}
function allCalls(steps) {
  const out = [];
  let ordinal = 0;
  for (const step of steps) {
    for (const call of step.toolCalls) {
      out.push({ step, call, ordinal: ordinal++ });
    }
  }
  return out;
}
function inputFilePath(call) {
  const input = call.input;
  const p = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof p === "string" ? p : void 0;
}
function detectRereads(steps, persistenceCost) {
  const calls = allCalls(steps);
  const chainKey = (step, p) => `${step.isSidechain ? "s" : "m"}:${p}`;
  const lastModified = /* @__PURE__ */ new Map();
  const lastRead = /* @__PURE__ */ new Map();
  const wasteByFile = /* @__PURE__ */ new Map();
  for (const site of calls) {
    const { call, step, ordinal } = site;
    if (FILE_MUTATING_TOOLS.has(call.name)) {
      const p2 = inputFilePath(call);
      if (p2) {
        lastModified.set(`m:${p2}`, ordinal);
        lastModified.set(`s:${p2}`, ordinal);
      }
      continue;
    }
    if (call.name !== "Read") continue;
    const p = inputFilePath(call);
    if (!p) continue;
    const key = chainKey(step, p);
    const prevRead = lastRead.get(key);
    lastRead.set(key, ordinal);
    if (prevRead === void 0) continue;
    const modifiedSince = (lastModified.get(key) ?? -1) > prevRead;
    if (modifiedSince) continue;
    const tokens = resultTokens(call.result);
    if (tokens === 0) continue;
    const entry = wasteByFile.get(p) ?? { occurrences: 0, wastedTokens: 0, wastedCost: 0, stepIndices: [] };
    entry.occurrences += 1;
    entry.wastedTokens += tokens;
    entry.wastedCost += persistenceCost(tokens, step);
    entry.stepIndices.push(step.index);
    wasteByFile.set(p, entry);
  }
  return [...wasteByFile.entries()].map(([file, e]) => ({
    kind: "reread",
    label: file,
    ...e
  }));
}
function detectDuplicateCalls(steps, persistenceCost) {
  const calls = allCalls(steps);
  const seen = /* @__PURE__ */ new Set();
  const wasteByKey = /* @__PURE__ */ new Map();
  for (const { call, step } of calls) {
    if (!READONLY_TOOLS.has(call.name)) continue;
    const key = `${step.isSidechain ? "s" : "m"}:${call.name} ${call.inputKey}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    const tokens = resultTokens(call.result);
    const entry = wasteByKey.get(key) ?? {
      label: `${call.name} ${summarizeInput(call)}`,
      occurrences: 0,
      wastedTokens: 0,
      wastedCost: 0,
      stepIndices: []
    };
    entry.occurrences += 1;
    entry.wastedTokens += tokens;
    entry.wastedCost += persistenceCost(tokens, step);
    entry.stepIndices.push(step.index);
    wasteByKey.set(key, entry);
  }
  return [...wasteByKey.values()].map((e) => ({
    kind: "duplicate-call",
    ...e
  }));
}
function detectRetries(steps, stepCosts, persistenceCost) {
  const wasteByTool = /* @__PURE__ */ new Map();
  for (const sc of stepCosts) {
    const { step, cost } = sc;
    const failed = step.toolCalls.filter((c) => c.result?.isError);
    if (failed.length === 0) continue;
    const share = failed.length / step.toolCalls.length;
    for (const call of failed) {
      const tokens = resultTokens(call.result);
      const entry2 = wasteByTool.get(call.name) ?? { occurrences: 0, wastedTokens: 0, wastedCost: 0, stepIndices: [] };
      entry2.occurrences += 1;
      entry2.wastedTokens += tokens;
      entry2.wastedCost += persistenceCost(tokens, step);
      entry2.stepIndices.push(step.index);
      wasteByTool.set(call.name, entry2);
    }
    const entry = wasteByTool.get(failed[0].name);
    if (entry) entry.wastedCost += cost.output * share;
  }
  return [...wasteByTool.entries()].map(([tool, e]) => ({
    kind: "retry",
    label: tool,
    ...e
  }));
}
function computeToolStats(steps, persistenceCost) {
  const stats = /* @__PURE__ */ new Map();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const s = stats.get(call.name) ?? { name: call.name, calls: 0, errors: 0, resultTokens: 0, estContextCost: 0 };
      s.calls += 1;
      if (call.result?.isError) s.errors += 1;
      const tokens = resultTokens(call.result);
      s.resultTokens += tokens;
      s.estContextCost += persistenceCost(tokens, step);
      stats.set(call.name, s);
    }
  }
  return [...stats.values()].sort((a, b) => b.estContextCost - a.estContextCost);
}
function summarizeInput(call) {
  const input = call.input;
  if (!input || typeof input !== "object") return "";
  for (const key of ["pattern", "query", "url", "file_path", "path", "command"]) {
    const v = input[key];
    if (typeof v === "string") return truncate(v, 80);
  }
  return truncate(JSON.stringify(input), 80);
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

// src/parsers/claudeCode.ts
import { readFileSync } from "node:fs";
import { basename } from "node:path";
function contentSize(content) {
  if (content == null) return { chars: 0, images: 0 };
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (Array.isArray(content)) {
    let chars = 0;
    let images = 0;
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block;
        if (b.type === "image") {
          images += 1;
        } else if (typeof b.text === "string") {
          chars += b.text.length;
        } else if (typeof b.content === "string") {
          chars += b.content.length;
        } else {
          const nested = contentSize(b.content);
          if (nested.chars > 0 || nested.images > 0) {
            chars += nested.chars;
            images += nested.images;
          } else {
            chars += JSON.stringify(block).length;
          }
        }
      } else if (typeof block === "string") chars += block.length;
    }
    return { chars, images };
  }
  return { chars: JSON.stringify(content).length, images: 0 };
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
function parseClaudeCodeLog(filePath) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const stepsByKey = /* @__PURE__ */ new Map();
  const stepOrder = [];
  const callsById = /* @__PURE__ */ new Map();
  const usageSeen = /* @__PURE__ */ new Set();
  let sessionId = basename(filePath).replace(/\.jsonl$/, "");
  let cwd;
  let version;
  let firstUserMessage;
  let startTime;
  let endTime;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.sessionId) sessionId = o.sessionId;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.version && !version) version = o.version;
    if (o.timestamp) {
      if (!startTime) startTime = o.timestamp;
      endTime = o.timestamp;
    }
    if (o.type === "assistant" && o.message) {
      const m = o.message;
      const key = o.requestId ?? m.id ?? o.uuid ?? String(stepOrder.length);
      let step = stepsByKey.get(key);
      if (!step) {
        step = {
          id: m.id ?? o.uuid ?? key,
          index: stepOrder.length,
          requestId: o.requestId,
          timestamp: o.timestamp ?? "",
          model: m.model ?? "unknown",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0
          },
          toolCalls: [],
          textChars: 0,
          isSidechain: o.isSidechain === true
        };
        stepsByKey.set(key, step);
        stepOrder.push(step);
      }
      if (m.usage && !usageSeen.has(step)) {
        step.usage = normalizeUsage(m.usage);
        usageSeen.add(step);
      }
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block;
          if (b.type === "text" && typeof b.text === "string") {
            step.textChars += b.text.length;
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            if (!callsById.has(b.id)) {
              const call = {
                id: b.id,
                name: typeof b.name === "string" ? b.name : "unknown",
                input: b.input,
                inputKey: canonicalJson(b.input ?? null)
              };
              callsById.set(b.id, call);
              step.toolCalls.push(call);
            }
          }
        }
      }
    } else if (o.type === "user" && o.message) {
      const content = o.message.content;
      if (Array.isArray(content)) {
        let hasToolResult = false;
        let firstText;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block;
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            hasToolResult = true;
            const call = callsById.get(b.tool_use_id);
            if (call) {
              const size = contentSize(b.content);
              call.result = {
                isError: b.is_error === true,
                contentChars: size.chars,
                imageCount: size.images,
                timestamp: o.timestamp
              };
            }
          } else if (b.type === "text" && typeof b.text === "string" && !firstText) {
            firstText = b.text;
          }
        }
        if (!hasToolResult && firstText && !firstUserMessage) {
          firstUserMessage = cleanPrompt(firstText);
        }
      } else if (typeof content === "string" && !firstUserMessage) {
        firstUserMessage = cleanPrompt(content);
      }
    }
  }
  return {
    sessionId,
    source: "claude-code",
    filePath,
    cwd,
    version,
    firstUserMessage,
    startTime,
    endTime,
    steps: stepOrder
  };
}
function cleanPrompt(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return void 0;
  return trimmed.slice(0, 300);
}
function normalizeUsage(u) {
  const cc = u?.cache_creation;
  const write5m = cc?.ephemeral_5m_input_tokens;
  const write1h = cc?.ephemeral_1h_input_tokens;
  const totalWrite = u?.cache_creation_input_tokens ?? 0;
  const has5m = typeof write5m === "number" || typeof write1h === "number";
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: has5m ? write5m ?? 0 : totalWrite,
    cacheWrite1hTokens: has5m ? write1h ?? 0 : 0
  };
}

// src/report.ts
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var usd = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
var compact = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
var pct = (x) => (x * 100).toFixed(1) + "%";
var KIND_LABEL = {
  reread: "Reread",
  "duplicate-call": "Duplicate call",
  retry: "Retry Tax"
};
var KIND_COLOR = {
  reread: "#f59e0b",
  "duplicate-call": "#a78bfa",
  retry: "#ef4444"
};
function renderReport(profile) {
  const t = profile.trajectory;
  const durationMin = profile.durationMs / 6e4;
  const models = [...new Set(t.steps.map((s) => s.model))].filter(
    (m) => m !== "<synthetic>"
  );
  const toolCallCount = t.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  const wasteStepSet = new Set(
    profile.findings.flatMap((f) => f.stepIndices)
  );
  const maxStepCost = Math.max(...profile.stepCosts.map((sc) => sc.cost.total), 1e-9);
  const bars = profile.stepCosts.map((sc) => {
    const c = sc.cost;
    const scale = Math.sqrt(c.total / maxStepCost);
    const h = (seg) => c.total > 0 ? Math.max(seg / c.total * scale * 100, 0) : 0;
    const wasted = wasteStepSet.has(sc.step.index);
    const tip = `Step ${sc.step.index + 1} \u2014 ${esc(sc.step.model)}
${usd(c.total)} total
cache read ${usd(c.cacheRead)} \xB7 cache write ${usd(c.cacheWrite)}
input ${usd(c.input)} \xB7 output ${usd(c.output)}
${sc.step.toolCalls.map((x) => x.name).join(", ") || "no tools"}`;
    return `<div class="bar${wasted ? " wasted" : ""}${sc.step.isSidechain ? " side" : ""}" data-tip="${esc(tip)}">
        <i class="s-cw" style="height:${h(c.cacheWrite)}%"></i>
        <i class="s-cr" style="height:${h(c.cacheRead)}%"></i>
        <i class="s-in" style="height:${h(c.input)}%"></i>
        <i class="s-out" style="height:${h(c.output)}%"></i>
      </div>`;
  }).join("");
  const ctxSizes = profile.stepCosts.map(
    (sc) => sc.step.usage.inputTokens + sc.step.usage.cacheReadTokens + sc.step.usage.cacheWrite5mTokens + sc.step.usage.cacheWrite1hTokens
  );
  const maxCtx = Math.max(...ctxSizes, 1);
  const W = 1e3;
  const H = 120;
  const pts = ctxSizes.map((v, i) => {
    const x = ctxSizes.length > 1 ? i / (ctxSizes.length - 1) * W : 0;
    const y = H - v / maxCtx * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const contextChart = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:120px;display:block">
    <polygon points="0,${H} ${pts} ${W},${H}" fill="#3b82f622"/>
    <polyline points="${pts}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
  </svg>
  <div class="legend"><span>peak context ${compact(maxCtx)} tokens \xB7 every request re-pays its full context (cached tokens at 0.1\xD7 input price)</span></div>`;
  const findingRows = profile.findings.slice(0, 60).map(
    (f) => `<tr>
      <td><span class="badge" style="background:${KIND_COLOR[f.kind]}22;color:${KIND_COLOR[f.kind]}">${KIND_LABEL[f.kind]}</span></td>
      <td class="mono label">${esc(f.label)}</td>
      <td class="num">${f.occurrences}\xD7</td>
      <td class="num">${compact(f.wastedTokens)}</td>
      <td class="num cost">${usd(f.wastedCost)}</td>
    </tr>`
  ).join("");
  const wasteByKind = ["reread", "duplicate-call", "retry"].map((k) => {
    const fs = profile.findings.filter((f) => f.kind === k);
    return {
      kind: k,
      cost: fs.reduce((n, f) => n + f.wastedCost, 0),
      count: fs.reduce((n, f) => n + f.occurrences, 0)
    };
  });
  const wasteKindBar = wasteByKind.filter((w) => w.cost > 0).map(
    (w) => `<div style="flex:${Math.max(w.cost, 1e-9)};background:${KIND_COLOR[w.kind]}" title="${KIND_LABEL[w.kind]}: ${usd(w.cost)}"></div>`
  ).join("");
  const toolRows = profile.toolStats.slice(0, 20).map(
    (s) => `<tr>
      <td class="mono">${esc(s.name)}</td>
      <td class="num">${s.calls}</td>
      <td class="num">${s.errors > 0 ? `<span class="err">${s.errors}</span>` : "0"}</td>
      <td class="num">${compact(s.resultTokens)}</td>
      <td class="num cost">${usd(s.estContextCost)}</td>
    </tr>`
  ).join("");
  const unknownNote = profile.unknownModels.length ? `<p class="note warn">\u26A0 Unknown model pricing for: ${profile.unknownModels.map(esc).join(", ")} \u2014 their cost is counted as $0.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentprof \u2014 ${esc(t.sessionId.slice(0, 8))}</title>
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
  <h1><b>agentprof</b> \xB7 session profile</h1>
  <div class="meta mono">${esc(t.sessionId)} \xB7 ${esc(t.cwd ?? "")} \xB7 ${models.map(esc).join(", ")} \xB7 ${t.steps.length} steps \xB7 ${toolCallCount} tool calls \xB7 ${durationMin > 90 ? (durationMin / 60).toFixed(1) + " h" : durationMin.toFixed(0) + " min"}</div>
  ${t.firstUserMessage ? `<div class="prompt">\u201C${esc(t.firstUserMessage)}\u201D</div>` : ""}
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
  <h2>Context snowball \u2014 tokens carried into each request</h2>
  ${contextChart}
</section>

<section>
  <h2>Where money leaked \u2014 ${usd(profile.wastedCost)} (${pct(profile.wasteRatio)})</h2>
  ${wasteKindBar ? `<div class="wastebar">${wasteKindBar}</div>` : ""}
  <table>
    <thead><tr><th>Kind</th><th>What</th><th>Repeats</th><th>Tokens</th><th>Est. cost</th></tr></thead>
    <tbody>${findingRows || `<tr><td colspan="5" class="note">No waste detected \u{1F389}</td></tr>`}</tbody>
  </table>
  <p class="note">Waste cost = tokens \xD7 input price \xD7 (1.25 cache-write + 0.1 \xD7 each later request that re-reads them from cache). Tokens estimated at 4 chars/token. Re-reads after the file was edited are <em>not</em> counted.</p>
</section>

<section>
  <h2>Context cost by tool</h2>
  <table>
    <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Result tokens</th><th>Est. context cost</th></tr></thead>
    <tbody>${toolRows}</tbody>
  </table>
</section>

${unknownNote}
<footer>Generated by <a href="https://github.com/Shawn-Son/agentprof">agentprof</a> \u2014 measure, optimize, prove.</footer>
</body>
</html>`;
}

// src/web.ts
import { createServer } from "node:http";
import { statSync } from "node:fs";
var esc2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var usd2 = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
var compact2 = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
var cache = /* @__PURE__ */ new Map();
function profileCached(file) {
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return void 0;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.profile;
  try {
    const profile = profileSession(parseClaudeCodeLog(file));
    cache.set(file, { mtimeMs, profile });
    return profile;
  } catch {
    return void 0;
  }
}
function collectRows(discover) {
  const rows = [];
  for (const file of discover()) {
    const profile = profileCached(file);
    if (!profile || profile.totalCost.total === 0) continue;
    rows.push({ file, mtimeMs: statSync(file).mtimeMs, profile });
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function renderIndex(rows) {
  const total = rows.reduce((n, r) => n + r.profile.totalCost.total, 0);
  const waste = rows.reduce((n, r) => n + r.profile.wastedCost, 0);
  const tokensIn = rows.reduce(
    (n, r) => n + r.profile.totalUsage.inputTokens + r.profile.totalUsage.cacheReadTokens + r.profile.totalUsage.cacheWrite5mTokens + r.profile.totalUsage.cacheWrite1hTokens,
    0
  );
  const now = Date.now();
  const tr = rows.map((r) => {
    const p = r.profile;
    const t = p.trajectory;
    const live = now - r.mtimeMs < 5 * 60 * 1e3;
    const age = now - r.mtimeMs;
    const ageStr = age < 36e5 ? Math.max(1, Math.round(age / 6e4)) + "m ago" : age < 864e5 ? Math.round(age / 36e5) + "h ago" : Math.round(age / 864e5) + "d ago";
    const wastePct = p.totalCost.total > 0 ? (p.wasteRatio * 100).toFixed(0) + "%" : "\u2014";
    return `<tr onclick="location='/session?f=${encodeURIComponent(r.file)}'">
        <td>${live ? '<span class="live"></span>' : ""}<span class="mono">${esc2(t.sessionId.slice(0, 8))}</span></td>
        <td class="proj mono">${esc2((t.cwd ?? "").split("/").slice(-2).join("/"))}</td>
        <td class="prompt-cell">${esc2((t.firstUserMessage ?? "").slice(0, 72))}</td>
        <td class="num">${p.stepCosts.length}</td>
        <td class="num">${compact2(p.totalUsage.outputTokens)}</td>
        <td class="num cost">${usd2(p.totalCost.total)}</td>
        <td class="num waste">${usd2(p.wastedCost)} <span class="dim">${wastePct}</span></td>
        <td class="num dim">${ageStr}</td>
      </tr>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentprof monitor</title>
<style>
  :root { --bg:#0b0e14; --panel:#12161f; --border:#1f2633; --text:#e6e9ef; --dim:#8b94a7; --waste:#ef4444; --live:#22c55e; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; padding:32px 24px 64px; max-width:1160px; margin:0 auto; }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:12.5px; }
  h1 { font-size:20px; letter-spacing:-0.02em; } h1 b { color:#60a5fa; }
  .sub { color:var(--dim); margin-top:4px; font-size:13px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:20px 0; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:0.06em; }
  .card .v { font-size:24px; font-weight:650; margin-top:4px; }
  .card.w .v { color:var(--waste); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th { text-align:left; color:var(--dim); font-size:11.5px; text-transform:uppercase; letter-spacing:0.05em; padding:10px 10px; border-bottom:1px solid var(--border); }
  td { padding:9px 10px; border-bottom:1px solid var(--border); }
  tr:last-child td { border-bottom:none; }
  tbody tr { cursor:pointer; } tbody tr:hover { background:#ffffff08; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .cost { font-weight:600; } .waste { color:var(--waste); }
  .dim { color:var(--dim); font-size:12px; }
  .proj { color:var(--dim); white-space:nowrap; }
  .prompt-cell { color:#c9d1de; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .live { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--live); margin-right:7px; animation:pulse 1.6s infinite; vertical-align:1px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  footer { color:var(--dim); font-size:12px; margin-top:20px; }
</style>
</head>
<body>
<h1><b>agentprof</b> \xB7 live monitor</h1>
<div class="sub">${rows.length} sessions \xB7 auto-refreshes when logs change \xB7 <span class="live"></span>= active in the last 5 min</div>
<div class="cards">
  <div class="card"><div class="k">Total spend</div><div class="v">${usd2(total)}</div></div>
  <div class="card w"><div class="k">Estimated waste</div><div class="v">${usd2(waste)}</div></div>
  <div class="card"><div class="k">Tokens in</div><div class="v">${compact2(tokensIn)}</div></div>
  <div class="card"><div class="k">Sessions</div><div class="v">${rows.length}</div></div>
</div>
<table>
  <thead><tr><th>Session</th><th>Project</th><th>First prompt</th><th>Steps</th><th>Out tok</th><th>Cost</th><th>Waste</th><th>Last active</th></tr></thead>
  <tbody>${tr}</tbody>
</table>
<footer>agentprof \u2014 measure, optimize, prove. Data never leaves this machine.</footer>
<script>
  let stamp = null;
  async function poll() {
    try {
      const r = await fetch("/api/stamp");
      const s = await r.text();
      if (stamp === null) stamp = s;
      else if (s !== stamp) location.reload();
    } catch {}
    setTimeout(poll, 5000);
  }
  poll();
</script>
</body>
</html>`;
}
function startWebServer(discover, port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderIndex(collectRows(discover)));
      } else if (url.pathname === "/api/stamp") {
        const rows = discover().map((f) => {
          try {
            return `${f}:${statSync(f).mtimeMs}`;
          } catch {
            return f;
          }
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(rows.join("|"));
      } else if (url.pathname === "/session") {
        const file = url.searchParams.get("f") ?? "";
        const allowed = new Set(discover());
        if (!allowed.has(file)) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("unknown session");
          return;
        }
        const profile = profileCached(file);
        if (!profile) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("could not parse session");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          renderReport(profile).replace(
            "<header>",
            `<header><div style="margin-bottom:10px"><a href="/" style="color:#60a5fa;text-decoration:none;font-size:13px">\u2190 all sessions</a></div>`
          )
        );
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`agentprof monitor \u2192 http://localhost:${port}`);
  });
}

// src/version.ts
var VERSION = "0.1.0";

// src/cli.ts
var C = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  cyan: "\x1B[36m"
};
var usd3 = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
function projectsRoot() {
  return join(homedir(), ".claude", "projects");
}
function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
function findJsonl(dir) {
  const out = [];
  const mtimes = /* @__PURE__ */ new Map();
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try {
        st = statSync2(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) {
        out.push(p);
        mtimes.set(p, st.mtimeMs);
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0));
}
function openInBrowser(target) {
  if (process.platform === "darwin") execFile("open", [target], () => {
  });
  else if (process.platform === "win32")
    execFile("cmd", ["/c", "start", "", target], () => {
    });
  else execFile("xdg-open", [target], () => {
  });
}
function latestSessionForCwd() {
  const dir = join(projectsRoot(), encodeProjectDir(process.cwd()));
  if (!existsSync(dir)) return void 0;
  return findJsonl(dir)[0];
}
function profileFile(file) {
  return profileSession(parseClaudeCodeLog(file));
}
function printSummary(p) {
  const t = p.trajectory;
  const wastePct = (p.wasteRatio * 100).toFixed(1);
  console.log("");
  console.log(
    `${C.bold}agentprof${C.reset} ${C.dim}\xB7${C.reset} ${t.sessionId.slice(0, 8)} ${C.dim}${t.cwd ?? ""}${C.reset}`
  );
  if (t.firstUserMessage) {
    console.log(`${C.dim}\u201C${t.firstUserMessage.slice(0, 100)}\u201D${C.reset}`);
  }
  console.log("");
  console.log(
    `  Total cost      ${C.bold}${usd3(p.totalCost.total)}${C.reset}  ${C.dim}(${p.stepCosts.length} requests, cache-aware list price)${C.reset}`
  );
  console.log(
    `  Estimated waste ${C.red}${C.bold}${usd3(p.wastedCost)}${C.reset}  ${C.red}${wastePct}% of total${C.reset}`
  );
  const byKind = {};
  for (const f of p.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + f.wastedCost;
  const kinds = [
    ["reread", "rereads", C.yellow],
    ["duplicate-call", "duplicate calls", C.cyan],
    ["retry", "retry tax", C.red]
  ];
  for (const [k, label, color] of kinds) {
    if (byKind[k]) {
      console.log(`    ${color}\u25B8${C.reset} ${label.padEnd(16)} ${usd3(byKind[k])}`);
    }
  }
  console.log("");
  const top = p.findings.slice(0, 5);
  if (top.length) {
    console.log(`  ${C.bold}Top leaks${C.reset}`);
    for (const f of top) {
      const tag = f.kind === "reread" ? "reread" : f.kind === "retry" ? "retry" : "dup";
      console.log(
        `    ${C.dim}${tag.padEnd(7)}${C.reset}${f.label.slice(0, 70).padEnd(72)} ${f.occurrences}\xD7 ${C.bold}${usd3(f.wastedCost)}${C.reset}`
      );
    }
  }
  if (p.unknownModels.length) {
    console.log(
      `
  ${C.yellow}\u26A0 unknown model pricing (counted as $0): ${p.unknownModels.join(", ")}${C.reset}`
    );
  }
}
function printTable(profiles, top) {
  const rows = profiles.filter((p) => p.totalCost.total > 0).sort((a, b) => b.wastedCost - a.wastedCost).slice(0, top);
  const total = profiles.reduce((n, p) => n + p.totalCost.total, 0);
  const waste = profiles.reduce((n, p) => n + p.wastedCost, 0);
  console.log("");
  console.log(
    `${C.bold}agentprof${C.reset} \u2014 ${profiles.length} sessions \xB7 total ${C.bold}${usd3(total)}${C.reset} \xB7 estimated waste ${C.red}${C.bold}${usd3(waste)} (${total ? (waste / total * 100).toFixed(1) : 0}%)${C.reset}`
  );
  console.log("");
  console.log(
    `  ${"session".padEnd(10)}${"cost".padStart(9)}${"waste".padStart(9)}${"%".padStart(7)}  ${"steps".padStart(5)}  first prompt`
  );
  for (const p of rows) {
    const t = p.trajectory;
    const pctS = (p.wasteRatio * 100).toFixed(0) + "%";
    console.log(
      `  ${t.sessionId.slice(0, 8).padEnd(10)}${usd3(p.totalCost.total).padStart(9)}${C.red}${usd3(p.wastedCost).padStart(9)}${pctS.padStart(7)}${C.reset}  ${String(p.stepCosts.length).padStart(5)}  ${C.dim}${(p.trajectory.firstUserMessage ?? "").slice(0, 48)}${C.reset}`
    );
  }
  console.log(
    `
  ${C.dim}Run ${C.reset}agentprof <path-to-session.jsonl>${C.dim} for a full HTML report of one session.${C.reset}`
  );
}
function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : void 0;
  };
  const VALUE_OPTS = /* @__PURE__ */ new Set(["--out", "--top", "--port"]);
  const positional = args.filter(
    (a, i) => !a.startsWith("-") && !VALUE_OPTS.has(args[i - 1])
  );
  if (flags.has("--version") || flags.has("-v")) {
    console.log(`agentprof ${VERSION}`);
    return;
  }
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`agentprof \u2014 profiler for AI agent sessions

Usage:
  agentprof                    profile the latest session of the current project
  agentprof --project          summarize every session of the current project
  agentprof <file.jsonl>       profile one session log (writes an HTML report)
  agentprof <dir>              summarize every session in a directory
  agentprof --all              summarize every session on this machine
  agentprof init               install the /agentprof skill into this project
  agentprof web                live local dashboard (optional, machine-wide)
  agentprof web <dir>          monitor a specific directory only
  agentprof --list             list recent sessions

Options:
  --out <file>   where to write the HTML report (default: ./agentprof-report.html)
  --open         open the report/dashboard in your browser
  --json         print the profile as JSON instead
  --port <n>     web monitor port (default 4040)
  --top <n>      rows to show in summary tables (default 20)`);
    return;
  }
  if (positional[0] === "init") {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", "skills", "agentprof"), join(here, "..")];
    const source = candidates.find((d) => existsSync(join(d, "SKILL.md")));
    if (!source) {
      console.error(`${C.red}could not locate the skill source folder${C.reset}`);
      process.exitCode = 1;
      return;
    }
    const dir = resolve(".claude", "skills", "agentprof");
    mkdirSync(dir, { recursive: true });
    cpSync(source, dir, { recursive: true });
    console.log(
      `${C.green}\u2713${C.reset} installed skill (with bundled engine) \u2192 ${dir}
  In Claude Code, run ${C.bold}/agentprof usage${C.reset} or ${C.bold}/agentprof waste${C.reset}.
  Commit the folder to share it with your team.`
    );
    return;
  }
  if (positional[0] === "web") {
    const scope = positional[1] ? resolve(positional[1]) : projectsRoot();
    if (!existsSync(scope)) {
      console.error(`${C.red}not found:${C.reset} ${scope}`);
      process.exitCode = 1;
      return;
    }
    const port = Number(getOpt("--port") ?? 4040);
    startWebServer(() => findJsonl(scope), port);
    if (flags.has("--open")) openInBrowser(`http://localhost:${port}`);
    return;
  }
  if (flags.has("--list")) {
    const files = findJsonl(projectsRoot()).slice(0, Number(getOpt("--top") ?? 20));
    for (const f of files) {
      const st = statSync2(f);
      console.log(`${st.mtime.toISOString().slice(0, 16)}  ${f}`);
    }
    return;
  }
  let targets = [];
  let aggregate = false;
  if (flags.has("--all")) {
    aggregate = true;
    targets = findJsonl(projectsRoot());
  } else if (flags.has("--project")) {
    aggregate = true;
    const dir = join(projectsRoot(), encodeProjectDir(process.cwd()));
    if (!existsSync(dir)) {
      console.error(
        `${C.yellow}No session logs found for this project.${C.reset}
Looked in ${dir}`
      );
      process.exitCode = 1;
      return;
    }
    targets = findJsonl(dir);
  } else if (positional.length > 0) {
    for (const arg of positional) {
      const p = resolve(arg);
      if (!existsSync(p)) {
        console.error(`${C.red}not found:${C.reset} ${p}`);
        process.exitCode = 1;
        return;
      }
      if (statSync2(p).isDirectory()) {
        aggregate = true;
        targets.push(...findJsonl(p));
      } else targets.push(p);
    }
  } else {
    const latest = latestSessionForCwd();
    if (!latest) {
      console.error(
        `${C.yellow}No session logs found for this project.${C.reset}
Looked in ${join(projectsRoot(), encodeProjectDir(process.cwd()))}
Try: agentprof --all   or   agentprof <path-to-session.jsonl>`
      );
      process.exitCode = 1;
      return;
    }
    targets = [latest];
  }
  if (targets.length === 0) {
    console.error(`${C.yellow}No .jsonl session logs found.${C.reset}`);
    process.exitCode = 1;
    return;
  }
  if (targets.length === 1 && !aggregate) {
    const profile = profileFile(targets[0]);
    if (flags.has("--json")) {
      console.log(
        JSON.stringify(
          {
            sessionId: profile.trajectory.sessionId,
            totalCost: profile.totalCost,
            wastedCost: profile.wastedCost,
            wasteRatio: profile.wasteRatio,
            findings: profile.findings,
            toolStats: profile.toolStats
          },
          null,
          2
        )
      );
      return;
    }
    printSummary(profile);
    const out = resolve(getOpt("--out") ?? "agentprof-report.html");
    writeFileSync(out, renderReport(profile));
    console.log(`
  ${C.green}\u2937 report:${C.reset} ${out}
`);
    if (flags.has("--open")) openInBrowser(out);
  } else {
    const profiles = [];
    for (const f of targets) {
      try {
        profiles.push(profileFile(f));
      } catch {
      }
    }
    if (flags.has("--json")) {
      const totalCost = profiles.reduce((n, p) => n + p.totalCost.total, 0);
      const wastedCost = profiles.reduce((n, p) => n + p.wastedCost, 0);
      console.log(
        JSON.stringify(
          {
            sessions: profiles.length,
            totalCost,
            wastedCost,
            wasteRatio: totalCost > 0 ? wastedCost / totalCost : 0,
            perSession: profiles.map((p) => ({
              sessionId: p.trajectory.sessionId,
              file: p.trajectory.filePath,
              firstUserMessage: p.trajectory.firstUserMessage,
              steps: p.stepCosts.length,
              totalCost: p.totalCost.total,
              wastedCost: p.wastedCost,
              wasteRatio: p.wasteRatio,
              topFindings: p.findings.slice(0, 3)
            }))
          },
          null,
          2
        )
      );
      return;
    }
    printTable(profiles, Number(getOpt("--top") ?? 20));
  }
}
main();
