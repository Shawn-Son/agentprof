#!/usr/bin/env node
/**
 * agentprof — profiler for Claude Code sessions.
 * Single-file engine: this IS the source code (plain Node, zero dependencies).
 *
 *   node agentprof.mjs                profile the latest session of the current project
 *   node agentprof.mjs --project      summarize every session of the current project
 *   node agentprof.mjs <file.jsonl>   profile one session log (writes an HTML report)
 *   node agentprof.mjs init           install this skill into the current project
 *
 * Options: --json  --out <file>  --open  --top <n>  --version
 *
 * https://github.com/Shawn-Son/agentprof — MIT license
 */

import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Pricing (USD per million tokens, Anthropic list prices; synced 2026-08-18).
// Cache multipliers per Anthropic docs: 5m write = 1.25x input,
// 1h write = 2x input, cache read = 0.1x input.
// ---------------------------------------------------------------------------

const PRICES = {
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
  "claude-3-haiku": { input: 0.25, output: 1.25 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

/**
 * Resolve a model id (possibly date-suffixed, e.g. "claude-haiku-4-5-20251001")
 * to a price entry. Returns undefined for unknown/synthetic models so callers
 * can surface them instead of silently pricing at zero.
 */
function priceFor(model) {
  if (!model || model === "<synthetic>") return undefined;
  if (PRICES[model]) return PRICES[model];
  const stripped = model.replace(/-\d{8}$/, "");
  if (PRICES[stripped]) return PRICES[stripped];
  let best;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? PRICES[best] : undefined;
}

// ---------------------------------------------------------------------------
// Parser: Claude Code session logs (~/.claude/projects/<project>/<id>.jsonl)
// → a neutral trajectory shape { sessionId, steps[], ... }.
//
// Format notes (empirically verified; the format is not a documented contract):
// - Each line is a JSON event; `type` is "user" | "assistant" | others we skip.
// - One API response is often split across SEVERAL assistant lines sharing the
//   same `requestId`/`message.id`, each repeating the identical `usage` object.
//   Usage must be counted once per request or costs double-count.
// - Tool results arrive as user lines whose message.content[] contains
//   `tool_result` blocks keyed by `tool_use_id`.
// ---------------------------------------------------------------------------

/**
 * Measure result content. Image blocks are counted separately — their base64
 * payload is NOT text tokens (images bill at a roughly fixed visual-token
 * cost), so counting base64 chars/4 would overstate waste by 10-100x.
 */
function contentSize(content) {
  if (content == null) return { chars: 0, images: 0 };
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (Array.isArray(content)) {
    let chars = 0;
    let images = 0;
    for (const block of content) {
      if (block && typeof block === "object") {
        if (block.type === "image") {
          images += 1;
        } else if (typeof block.text === "string") {
          chars += block.text.length;
        } else if (typeof block.content === "string") {
          chars += block.content.length;
        } else {
          const nested = contentSize(block.content);
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

/** Stable JSON so identical tool inputs get identical keys. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** Trim, drop command/meta noise, cap length. Returns undefined for noise. */
function cleanPrompt(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return undefined;
  return trimmed.slice(0, 300);
}

function normalizeUsage(u) {
  const cc = u?.cache_creation;
  const write5m = cc?.ephemeral_5m_input_tokens;
  const write1h = cc?.ephemeral_1h_input_tokens;
  const totalWrite = u?.cache_creation_input_tokens ?? 0;
  // If the split is absent, attribute all cache-writes to the 5m tier
  // (the cheaper multiplier — keeps the estimate conservative).
  const has5m = typeof write5m === "number" || typeof write1h === "number";
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: has5m ? (write5m ?? 0) : totalWrite,
    cacheWrite1hTokens: has5m ? (write1h ?? 0) : 0,
  };
}

function parseClaudeCodeLog(filePath) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  const stepsByKey = new Map(); // request key -> step under construction
  const stepOrder = [];
  const callsById = new Map();
  const usageSeen = new Set(); // steps whose usage has been captured

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
            cacheWrite1hTokens: 0,
          },
          toolCalls: [],
          textChars: 0,
          isSidechain: o.isSidechain === true,
        };
        stepsByKey.set(key, step);
        stepOrder.push(step);
      }
      // Usage is identical on every line of the same request — capture it once,
      // from whichever line of the request carries it first.
      if (m.usage && !usageSeen.has(step)) {
        step.usage = normalizeUsage(m.usage);
        usageSeen.add(step);
      }
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            step.textChars += block.text.length;
          } else if (block.type === "tool_use" && typeof block.id === "string") {
            if (!callsById.has(block.id)) {
              const call = {
                id: block.id,
                name: typeof block.name === "string" ? block.name : "unknown",
                input: block.input,
                inputKey: canonicalJson(block.input ?? null),
                result: undefined,
              };
              callsById.set(block.id, call);
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
          if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
            hasToolResult = true;
            const call = callsById.get(block.tool_use_id);
            if (call) {
              const size = contentSize(block.content);
              call.result = {
                isError: block.is_error === true,
                contentChars: size.chars,
                imageCount: size.images,
                timestamp: o.timestamp,
              };
            }
          } else if (block.type === "text" && typeof block.text === "string" && !firstText) {
            firstText = block.text;
          }
        }
        // A real user turn can arrive as content blocks (e.g. with attachments).
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
    steps: stepOrder,
  };
}

// ---------------------------------------------------------------------------
// Analyzer: cost attribution + waste detection.
//
// Waste-cost model: when a tool result of ~T tokens enters the context at
// step i, the session pays for it roughly as
//
//   T x inputPrice x 1.25            (written to cache once)
// + T x inputPrice x 0.1 x L        (re-read from cache in each of the L later
//                                    requests of the same chain)
//
// This is what persistenceCost computes. It is an estimate (tokens are
// approximated as chars/4, and context compaction may drop old content), but
// it reflects the real mechanics of prompt-cached agent loops: everything you
// put in context is paid for again on every subsequent request.
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;
/** Rough per-image visual-token estimate (typical screenshot at the old cap). */
const IMAGE_TOKENS = 1600;

/** Read-only tools whose exact duplicates are always redundant. */
const READONLY_TOOLS = new Set(["Glob", "Grep", "WebFetch", "WebSearch", "LS", "NotebookRead"]);

/** Tools that modify a file at input.file_path (invalidate earlier reads). */
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function resultTokens(result) {
  if (!result) return 0;
  return Math.round(result.contentChars / CHARS_PER_TOKEN) + result.imageCount * IMAGE_TOKENS;
}

function stepCost(step) {
  const p = priceFor(step.model);
  if (!p) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const u = step.usage;
  const input = (u.inputTokens / 1e6) * p.input;
  const output = (u.outputTokens / 1e6) * p.output;
  const cacheRead = (u.cacheReadTokens / 1e6) * p.input * CACHE_READ_MULT;
  const cacheWrite =
    (u.cacheWrite5mTokens / 1e6) * p.input * CACHE_WRITE_5M_MULT +
    (u.cacheWrite1hTokens / 1e6) * p.input * CACHE_WRITE_1H_MULT;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function allCalls(steps) {
  const out = [];
  let ordinal = 0;
  for (const step of steps) {
    for (const call of step.toolCalls) out.push({ step, call, ordinal: ordinal++ });
  }
  return out;
}

function inputFilePath(call) {
  const p = call.input?.file_path ?? call.input?.path ?? call.input?.notebook_path;
  return typeof p === "string" ? p : undefined;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function summarizeInput(call) {
  const input = call.input;
  if (!input || typeof input !== "object") return "";
  for (const key of ["pattern", "query", "url", "file_path", "path", "command"]) {
    if (typeof input[key] === "string") return truncate(input[key], 80);
  }
  return truncate(JSON.stringify(input), 80);
}

/**
 * Reread Ratio: the same file Read more than once with no modification of that
 * file in between. The repeated read's actual result size is counted as waste
 * (so partial re-reads are only partially penalized). Keys are chain-scoped
 * ("m:" main / "s:" sidechain): a read repeated in a DIFFERENT chain runs in a
 * separate context and is not redundant there.
 */
function detectRereads(steps, persistenceCost) {
  const calls = allCalls(steps);
  const lastModified = new Map(); // chain:path -> ordinal of last modification
  const lastRead = new Map(); // chain:path -> ordinal of last read
  const wasteByFile = new Map();

  for (const { call, step, ordinal } of calls) {
    if (FILE_MUTATING_TOOLS.has(call.name)) {
      const p = inputFilePath(call);
      // A modification invalidates earlier reads in every chain (the file on
      // disk changed for both), so record it under both chain keys.
      if (p) {
        lastModified.set(`m:${p}`, ordinal);
        lastModified.set(`s:${p}`, ordinal);
      }
      continue;
    }
    if (call.name !== "Read") continue;
    const p = inputFilePath(call);
    if (!p) continue;
    const key = `${step.isSidechain ? "s" : "m"}:${p}`;
    const prevRead = lastRead.get(key);
    lastRead.set(key, ordinal);
    if (prevRead === undefined) continue;
    if ((lastModified.get(key) ?? -1) > prevRead) continue; // legitimate re-read after an edit
    const tokens = resultTokens(call.result);
    if (tokens === 0) continue;
    const entry = wasteByFile.get(p) ?? {
      occurrences: 0,
      wastedTokens: 0,
      wastedCost: 0,
      stepIndices: [],
    };
    entry.occurrences += 1;
    entry.wastedTokens += tokens;
    entry.wastedCost += persistenceCost(tokens, step);
    entry.stepIndices.push(step.index);
    wasteByFile.set(p, entry);
  }

  return [...wasteByFile.entries()].map(([file, e]) => ({ kind: "reread", label: file, ...e }));
}

/**
 * Duplicate calls: exact same read-only tool + identical input, repeated in the
 * same chain. Stateful tools (Bash etc.) are deliberately excluded — repeating
 * them can be legitimate. Read has its own detector above.
 */
function detectDuplicateCalls(steps, persistenceCost) {
  const calls = allCalls(steps);
  const seen = new Set();
  const wasteByKey = new Map();

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
      stepIndices: [],
    };
    entry.occurrences += 1;
    entry.wastedTokens += tokens;
    entry.wastedCost += persistenceCost(tokens, step);
    entry.stepIndices.push(step.index);
    wasteByKey.set(key, entry);
  }

  return [...wasteByKey.values()].map((e) => ({ kind: "duplicate-call", ...e }));
}

/**
 * Retry Tax: failed tool calls. Waste counted = the error output that entered
 * context, plus the share of the step's output tokens spent emitting the
 * failed call(s).
 */
function detectRetries(steps, stepCosts, persistenceCost) {
  const wasteByTool = new Map();

  for (const { step, cost } of stepCosts) {
    const failed = step.toolCalls.filter((c) => c.result?.isError);
    if (failed.length === 0) continue;
    const share = failed.length / step.toolCalls.length;
    for (const call of failed) {
      const tokens = resultTokens(call.result);
      const entry = wasteByTool.get(call.name) ?? {
        occurrences: 0,
        wastedTokens: 0,
        wastedCost: 0,
        stepIndices: [],
      };
      entry.occurrences += 1;
      entry.wastedTokens += tokens;
      entry.wastedCost += persistenceCost(tokens, step);
      entry.stepIndices.push(step.index);
      wasteByTool.set(call.name, entry);
    }
    // spread the step's output cost share over its failed calls (added once)
    const entry = wasteByTool.get(failed[0].name);
    if (entry) entry.wastedCost += cost.output * share;
  }

  return [...wasteByTool.entries()].map(([tool, e]) => ({ kind: "retry", label: tool, ...e }));
}

function computeToolStats(steps, persistenceCost) {
  const stats = new Map();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const s = stats.get(call.name) ?? {
        name: call.name,
        calls: 0,
        errors: 0,
        resultTokens: 0,
        estContextCost: 0,
      };
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

function profileSession(trajectory) {
  const steps = trajectory.steps;
  const stepCosts = steps.map((s) => ({ step: s, cost: stepCost(s) }));

  const totalCost = stepCosts.reduce(
    (acc, sc) => ({
      input: acc.input + sc.cost.input,
      output: acc.output + sc.cost.output,
      cacheRead: acc.cacheRead + sc.cost.cacheRead,
      cacheWrite: acc.cacheWrite + sc.cost.cacheWrite,
      total: acc.total + sc.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );

  const totalUsage = steps.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.usage.inputTokens,
      outputTokens: acc.outputTokens + s.usage.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + s.usage.cacheReadTokens,
      cacheWrite5mTokens: acc.cacheWrite5mTokens + s.usage.cacheWrite5mTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens + s.usage.cacheWrite1hTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
  );

  const unknownModels = [
    ...new Set(
      steps.filter((s) => !priceFor(s.model) && s.model !== "<synthetic>").map((s) => s.model),
    ),
  ];

  // How many later requests re-read context added at a given step. Precomputed
  // per chain (main vs sidechain) so persistenceCost is O(1) per call.
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

  const persistenceCost = (tokens, step) => {
    const p = priceFor(step.model);
    if (!p) return 0;
    return (
      (tokens / 1e6) *
      p.input *
      (CACHE_WRITE_5M_MULT + CACHE_READ_MULT * (laterCount[step.index] ?? 0))
    );
  };

  const findings = [
    ...detectRereads(steps, persistenceCost),
    ...detectDuplicateCalls(steps, persistenceCost),
    ...detectRetries(steps, stepCosts, persistenceCost),
  ].sort((a, b) => b.wastedCost - a.wastedCost);

  const wastedCost = findings.reduce((n, f) => n + f.wastedCost, 0);
  const wastedTokens = findings.reduce((n, f) => n + f.wastedTokens, 0);

  const durationMs =
    trajectory.startTime && trajectory.endTime
      ? Date.parse(trajectory.endTime) - Date.parse(trajectory.startTime)
      : 0;

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
    toolStats: computeToolStats(steps, persistenceCost),
    unknownModels,
  };
}

// ---------------------------------------------------------------------------
// HTML report: a single self-contained file. No external assets, no CDN, no
// JS frameworks — open it, share it, attach it.
// ---------------------------------------------------------------------------

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const usd = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

const compact = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

const pct = (x) => (x * 100).toFixed(1) + "%";

const KIND_LABEL = { reread: "Reread", "duplicate-call": "Duplicate call", retry: "Retry Tax" };
const KIND_COLOR = { reread: "#f59e0b", "duplicate-call": "#a78bfa", retry: "#ef4444" };

function renderReport(profile) {
  const t = profile.trajectory;
  const durationMin = profile.durationMs / 60000;
  const models = [...new Set(t.steps.map((s) => s.model))].filter((m) => m !== "<synthetic>");
  const toolCallCount = t.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  const wasteStepSet = new Set(profile.findings.flatMap((f) => f.stepIndices));

  // ---- timeline bars (sqrt scale so one giant request doesn't flatten the rest) ----
  const maxStepCost = Math.max(...profile.stepCosts.map((sc) => sc.cost.total), 1e-9);
  const bars = profile.stepCosts
    .map((sc) => {
      const c = sc.cost;
      const scale = Math.sqrt(c.total / maxStepCost);
      const h = (seg) => (c.total > 0 ? Math.max((seg / c.total) * scale * 100, 0) : 0);
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

  const wasteByKind = ["reread", "duplicate-call", "retry"].map((k) => {
    const fs = profile.findings.filter((f) => f.kind === k);
    return {
      kind: k,
      cost: fs.reduce((n, f) => n + f.wastedCost, 0),
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function projectsRoot() {
  return join(homedir(), ".claude", "projects");
}

function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function findJsonl(dir) {
  const out = [];
  const mtimes = new Map();
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
        st = statSync(p);
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
  if (process.platform === "darwin") execFile("open", [target], () => {});
  else if (process.platform === "win32") execFile("cmd", ["/c", "start", "", target], () => {});
  else execFile("xdg-open", [target], () => {});
}

function latestSessionForCwd() {
  const dir = join(projectsRoot(), encodeProjectDir(process.cwd()));
  if (!existsSync(dir)) return undefined;
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
    `${C.bold}agentprof${C.reset} ${C.dim}·${C.reset} ${t.sessionId.slice(0, 8)} ${C.dim}${t.cwd ?? ""}${C.reset}`,
  );
  if (t.firstUserMessage) console.log(`${C.dim}“${t.firstUserMessage.slice(0, 100)}”${C.reset}`);
  console.log("");
  console.log(
    `  Total cost      ${C.bold}${usd(p.totalCost.total)}${C.reset}  ${C.dim}(${p.stepCosts.length} requests, cache-aware list price)${C.reset}`,
  );
  console.log(
    `  Estimated waste ${C.red}${C.bold}${usd(p.wastedCost)}${C.reset}  ${C.red}${wastePct}% of total${C.reset}`,
  );
  const byKind = {};
  for (const f of p.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + f.wastedCost;
  const kinds = [
    ["reread", "rereads", C.yellow],
    ["duplicate-call", "duplicate calls", C.cyan],
    ["retry", "retry tax", C.red],
  ];
  for (const [k, label, color] of kinds) {
    if (byKind[k]) console.log(`    ${color}▸${C.reset} ${label.padEnd(16)} ${usd(byKind[k])}`);
  }
  console.log("");
  const top = p.findings.slice(0, 5);
  if (top.length) {
    console.log(`  ${C.bold}Top leaks${C.reset}`);
    for (const f of top) {
      const tag = f.kind === "reread" ? "reread" : f.kind === "retry" ? "retry" : "dup";
      console.log(
        `    ${C.dim}${tag.padEnd(7)}${C.reset}${f.label.slice(0, 70).padEnd(72)} ${f.occurrences}× ${C.bold}${usd(f.wastedCost)}${C.reset}`,
      );
    }
  }
  if (p.unknownModels.length) {
    console.log(
      `\n  ${C.yellow}⚠ unknown model pricing (counted as $0): ${p.unknownModels.join(", ")}${C.reset}`,
    );
  }
}

function printTable(profiles, top) {
  const rows = profiles
    .filter((p) => p.totalCost.total > 0)
    .sort((a, b) => b.wastedCost - a.wastedCost)
    .slice(0, top);
  const total = profiles.reduce((n, p) => n + p.totalCost.total, 0);
  const waste = profiles.reduce((n, p) => n + p.wastedCost, 0);
  console.log("");
  console.log(
    `${C.bold}agentprof${C.reset} — ${profiles.length} sessions · total ${C.bold}${usd(total)}${C.reset} · estimated waste ${C.red}${C.bold}${usd(waste)} (${total ? ((waste / total) * 100).toFixed(1) : 0}%)${C.reset}`,
  );
  console.log("");
  console.log(
    `  ${"session".padEnd(10)}${"cost".padStart(9)}${"waste".padStart(9)}${"%".padStart(7)}  ${"steps".padStart(5)}  first prompt`,
  );
  for (const p of rows) {
    const t = p.trajectory;
    const pctS = (p.wasteRatio * 100).toFixed(0) + "%";
    console.log(
      `  ${t.sessionId.slice(0, 8).padEnd(10)}${usd(p.totalCost.total).padStart(9)}${C.red}${usd(p.wastedCost).padStart(9)}${pctS.padStart(7)}${C.reset}  ${String(p.stepCosts.length).padStart(5)}  ${C.dim}${(t.firstUserMessage ?? "").slice(0, 48)}${C.reset}`,
    );
  }
  console.log(
    `\n  ${C.dim}Run ${C.reset}agentprof <path-to-session.jsonl>${C.dim} for a full HTML report of one session.${C.reset}`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
  };
  const VALUE_OPTS = new Set(["--out", "--top"]);
  const positional = args.filter((a, i) => !a.startsWith("-") && !VALUE_OPTS.has(args[i - 1]));

  if (flags.has("--version") || flags.has("-v")) {
    console.log(`agentprof ${VERSION}`);
    return;
  }

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`agentprof — profiler for AI agent sessions

Usage:
  agentprof init               install the /agentprof skill into this project
  agentprof                    profile the latest session of the current project
  agentprof --project          summarize every session of the current project
  agentprof <file.jsonl>       profile one session log (writes an HTML report)
  agentprof <dir>              summarize every session in a directory

Options:
  --out <file>   where to write the HTML report (default: ./agentprof-report.html)
  --open         open the report in your browser
  --json         print the profile as JSON instead
  --top <n>      rows to show in summary tables (default 20)`);
    return;
  }

  if (positional[0] === "init") {
    // This script lives inside the skill folder (scripts/agentprof.mjs), so the
    // skill source is our parent directory. Copy it into the target project.
    const source = join(dirname(fileURLToPath(import.meta.url)), "..");
    if (!existsSync(join(source, "SKILL.md"))) {
      console.error(`${C.red}could not locate SKILL.md next to this script${C.reset}`);
      process.exitCode = 1;
      return;
    }
    const dir = resolve(".claude", "skills", "agentprof");
    mkdirSync(dir, { recursive: true });
    cpSync(source, dir, { recursive: true });
    console.log(
      `${C.green}✓${C.reset} installed skill (with bundled engine) → ${dir}\n` +
        `  In Claude Code, run ${C.bold}/agentprof usage${C.reset} or ${C.bold}/agentprof waste${C.reset}.\n` +
        `  Commit the folder to share it with your team.`,
    );
    return;
  }

  let targets = [];
  let aggregate = false;
  if (flags.has("--project")) {
    aggregate = true;
    const dir = join(projectsRoot(), encodeProjectDir(process.cwd()));
    if (!existsSync(dir)) {
      console.error(`${C.yellow}No session logs found for this project.${C.reset}\nLooked in ${dir}`);
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
      if (statSync(p).isDirectory()) {
        aggregate = true;
        targets.push(...findJsonl(p));
      } else targets.push(p);
    }
  } else {
    const latest = latestSessionForCwd();
    if (!latest) {
      console.error(
        `${C.yellow}No session logs found for this project.${C.reset}\n` +
          `Looked in ${join(projectsRoot(), encodeProjectDir(process.cwd()))}\n` +
          `Try: agentprof <path-to-session.jsonl>`,
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
            toolStats: profile.toolStats,
          },
          null,
          2,
        ),
      );
      return;
    }
    printSummary(profile);
    const out = resolve(getOpt("--out") ?? "agentprof-report.html");
    writeFileSync(out, renderReport(profile));
    console.log(`\n  ${C.green}⤷ report:${C.reset} ${out}\n`);
    if (flags.has("--open")) openInBrowser(out);
  } else {
    const profiles = [];
    for (const f of targets) {
      try {
        profiles.push(profileFile(f));
      } catch {
        // unreadable/foreign log — skip
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
              topFindings: p.findings.slice(0, 3),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    printTable(profiles, Number(getOpt("--top") ?? 20));
  }
}

main();
