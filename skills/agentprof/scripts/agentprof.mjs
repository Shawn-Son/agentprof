#!/usr/bin/env node
/**
 * agentprof — token-waste tracker for Claude Code.
 * Single-file engine: this IS the source code (plain Node, zero dependencies).
 *
 *   node agentprof.mjs on         show usage + waste in the Claude Code status line
 *   node agentprof.mjs off        remove it again (restores your previous status line)
 *   node agentprof.mjs report     usage, waste (W1–W7), per-project breakdown: today / 7d / 30d
 *   node agentprof.mjs refresh    re-index transcripts now (the status line does this in the background)
 *   node agentprof.mjs init       install this skill into the current project
 *
 * Options: --json  --top <n>  --version
 *
 * Nothing runs over the network. Everything is derived from the transcripts
 * Claude Code already writes to ~/.claude/projects/**\/*.jsonl.
 *
 * https://github.com/Shawn-Son/agentprof — MIT license
 */

import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Pricing. USD per million tokens, Anthropic list prices.
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Cache multipliers per Anthropic docs: 5m write = 1.25x input, 1h write = 2x
// input, cache read = 0.1x input. Unknown models are surfaced, never priced $0
// silently. Override/extend with ~/.claude/agentprof/pricing.json
// ({ "model-id": { "input": n, "output": n } }).
// ---------------------------------------------------------------------------

const PRICING_REVISED = "2026-08-18";

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
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
};

const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const CACHE_READ_MULT = 0.1;

/**
 * Resolve a model id (possibly date-suffixed, e.g. "claude-haiku-4-5-20251001")
 * to a price entry. Returns undefined for unknown/synthetic models.
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
// Paths, config, small helpers.
// ---------------------------------------------------------------------------

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const DATA_DIR = join(CLAUDE_DIR, "agentprof");
const STATE_DIR = join(DATA_DIR, "state");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const SUMMARY_FILE = join(DATA_DIR, "summary.json");
const INDEX_FILE = join(STATE_DIR, "index.json");
const LOCK_FILE = join(STATE_DIR, "refresh.lock");
const LOCK_TTL_MS = 120_000;
const PREV_STATUSLINE_FILE = join(DATA_DIR, "prev-statusline.json");
const SETTINGS_BACKUP_FILE = join(DATA_DIR, "settings.backup.json");
const INSTALLED_ENGINE = join(DATA_DIR, "agentprof.mjs");
const MODE_FILE = join(DATA_DIR, "mode.json"); // { subscription: true } once rate_limits was seen
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const PROJECTS_ROOT = join(CLAUDE_DIR, "projects");

const DEFAULT_CONFIG = {
  stale_turns: 20, // W3: tool results unreferenced for this many requests count as stale
  tool_output_threshold: 4000, // W4: tokens of a single tool result above which the excess is waste
  window_days: 30, // longest reporting window; transcripts untouched for longer are not indexed
  refresh_seconds: 15, // the status line triggers a background re-index at most this often
  stale_hint_ratio: 0.3, // status line hint "/clear" when stale share of this session's waste >= this
  mcp_hint_tokens: 10000, // status line hint "prune MCP" when unused MCP definitions >= this
  cache_ttl_default_ms: 5 * 60 * 1000, // used when a request carries no 5m/1h split
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJson(join(DATA_DIR, "config.json"), {}) };
  const override = readJson(join(DATA_DIR, "pricing.json"), null);
  if (override && typeof override === "object") {
    for (const [k, v] of Object.entries(override)) {
      if (v && typeof v.input === "number" && typeof v.output === "number") PRICES[k] = v;
    }
  }
  return cfg;
}

/** Local-timezone calendar day, "YYYY-MM-DD". */
function dayOf(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayOf(d);
}

/** Synchronous sleep (used only by the foreground `report` while an index runs). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const CHARS_PER_TOKEN = 4;
/** Rough per-image visual-token estimate (typical screenshot). */
const IMAGE_TOKENS = 1600;

const tok = (chars) => Math.round(chars / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// Parser: one Claude Code transcript file → one "chain" (a main conversation or
// one subagent run). ~/.claude/projects/<project>/<session>.jsonl is the main
// chain; <session>/subagents/agent-*.jsonl are sidechains with their own
// context, so each file is analyzed as its own chain.
//
// Format notes (empirically verified; the format is not a documented contract):
// - Each line is a JSON event; `type` is "user" | "assistant" | "attachment" | ...
// - One API response is often split across SEVERAL assistant lines sharing the
//   same `requestId`/`message.id`, repeating the identical `usage`. Count once.
// - Tool results arrive as user lines whose message.content[] contains
//   `tool_result` blocks keyed by `tool_use_id`. Only that block's content
//   entered the model context (large Bash output is persisted to a file and
//   truncated in context) — the sibling `toolUseResult` field is NOT context.
// - attachment.type === "prompt_snapshot" carries the system prompt and the
//   full tool definitions sent to the API (`tools`). Deferred tools (loaded on
//   demand via ToolSearch) are NOT in it and cost nothing.
// - Compaction, when present, is marked by `isCompactSummary` on a user line
//   or a system line with subtype "compact_boundary".
// - Older Claude Code versions inlined sidechain lines (isSidechain: true)
//   into the main file; those run in a different context and are skipped.
// ---------------------------------------------------------------------------

function contentSize(content) {
  if (content == null) return { chars: 0, images: 0 };
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (Array.isArray(content)) {
    let chars = 0;
    let images = 0;
    for (const block of content) {
      if (block && typeof block === "object") {
        if (block.type === "image") images += 1;
        else if (typeof block.text === "string") chars += block.text.length;
        else if (typeof block.content === "string") chars += block.content.length;
        else {
          const nested = contentSize(block.content);
          if (nested.chars > 0 || nested.images > 0) {
            chars += nested.chars;
            images += nested.images;
          } else chars += JSON.stringify(block).length;
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

/** Every string inside a tool input, raw (for reference matching). */
function inputStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) inputStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) inputStrings(v, out);
  return out;
}

function normalizeUsage(u) {
  const cc = u?.cache_creation;
  const write5m = cc?.ephemeral_5m_input_tokens;
  const write1h = cc?.ephemeral_1h_input_tokens;
  const totalWrite = u?.cache_creation_input_tokens ?? 0;
  const hasSplit = typeof write5m === "number" || typeof write1h === "number";
  const cacheWrite5m = hasSplit ? (write5m ?? 0) : totalWrite; // no split → 5m tier (cheaper; conservative)
  const cacheWrite1h = hasSplit ? (write1h ?? 0) : 0;
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: cacheWrite5m + cacheWrite1h,
    cacheWrite5m,
    cacheWrite1h,
  };
}

function parseChain(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const stepsByKey = new Map();
  const steps = [];
  const callsById = new Map();
  const usageSeen = new Set();
  const compactionsBeforeStep = new Set(); // step index at which a fresh context begins
  let toolDefs; // last prompt_snapshot with tools: [{name, tokens}]
  let sessionId = basename(filePath).replace(/\.jsonl$/, "");
  let cwd;
  let isSidechain; // decided by the first line that says so
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
    if (typeof o.isSidechain === "boolean") {
      if (isSidechain === undefined) isSidechain = o.isSidechain;
      else if (o.isSidechain !== isSidechain) continue; // inlined sidechain line in a main file (legacy)
    }
    if (o.sessionId) sessionId = o.sessionId;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.timestamp) {
      if (!startTime) startTime = o.timestamp;
      endTime = o.timestamp;
    }

    if (o.type === "attachment" && o.attachment?.type === "prompt_snapshot" && Array.isArray(o.attachment.tools)) {
      toolDefs = o.attachment.tools
        .filter((t) => t && typeof t.name === "string")
        .map((t) => ({ name: t.name, tokens: tok(JSON.stringify(t).length) }));
      continue;
    }
    if (o.isCompactSummary === true || (o.type === "system" && o.subtype === "compact_boundary")) {
      compactionsBeforeStep.add(steps.length);
      continue;
    }

    if (o.type === "assistant" && o.message) {
      const m = o.message;
      const key = o.requestId ?? m.id ?? o.uuid ?? String(steps.length);
      let step = stepsByKey.get(key);
      if (!step) {
        step = {
          index: steps.length,
          timestamp: o.timestamp ?? "",
          model: m.model ?? "unknown",
          usage: normalizeUsage(undefined),
          toolCalls: [],
          texts: [],
        };
        stepsByKey.set(key, step);
        steps.push(step);
      }
      if (m.usage && !usageSeen.has(step)) {
        step.usage = normalizeUsage(m.usage);
        usageSeen.add(step);
      }
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") step.texts.push(block.text);
          else if (block.type === "tool_use" && typeof block.id === "string" && !callsById.has(block.id)) {
            const call = {
              id: block.id,
              name: typeof block.name === "string" ? block.name : "unknown",
              input: block.input,
              inputKey: canonicalJson(block.input ?? null),
              step,
              result: undefined,
            };
            callsById.set(block.id, call);
            step.toolCalls.push(call);
          }
        }
      }
    } else if (o.type === "user" && o.message && Array.isArray(o.message.content)) {
      for (const block of o.message.content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        const call = callsById.get(block.tool_use_id);
        if (!call) continue;
        const size = contentSize(block.content);
        call.result = {
          isError: block.is_error === true,
          tokens: tok(size.chars) + size.images * IMAGE_TOKENS,
        };
      }
    }
  }

  return {
    filePath,
    sessionId,
    isSidechain: isSidechain === true,
    cwd,
    startTime,
    endTime,
    steps,
    toolDefs,
    compactionsBeforeStep,
  };
}

// ---------------------------------------------------------------------------
// Analyzer.
//
// Cost model for context tokens ("carry"): a tool result of T tokens produced
// at request i enters the prompt of request i+1, where it is written to the
// cache, and is then re-read (0.1x) by every later request of the same context
// (until compaction; a fresh context re-writes it). Each token is owned by
// exactly ONE waste kind, chosen by precedence, so the kinds never overlap and
// their sum cannot exceed the real cost. Costs are booked on the day of the
// request that actually paid them.
//
//   W1 cache miss (confirmed)    prefix broken inside the cache TTL → rewrite
//                                 (the write-minus-read premium)
//   W2 duplicate read (confirmed) same file range Read again unchanged;
//                                 identical read-only calls repeated
//   W3 stale context (estimated) useful tool results unreferenced for
//                                 stale_turns requests, still carried
//   W4 tool output (estimated)   the part of one result above threshold
//   W5 filler text (estimated)   greetings / progress narration / closing
//                                 offers in assistant prose (output tokens)
//   W6 unused tools (confirmed)  MCP tool definitions carried in every
//                                 request but never called in the chain
//   W7 retry tax (confirmed)     failed tool calls: error output + the output
//                                 tokens spent emitting the doomed call
//
// Precedence per result: W7 > W2 > W4 (excess part) > useful; W3 applies to
// the useful part only. Confirmed = W1 + W2 + W6 + W7. Estimated = W3 + W4 + W5.
// Not waste: natural cache expiry after the TTL (tracked as expiryCost).
// ---------------------------------------------------------------------------

const WASTE = {
  W1: { label: "cache miss", short: "cache-miss", confirmed: true },
  W2: { label: "duplicate read", short: "reread", confirmed: true },
  W3: { label: "stale context", short: "stale", confirmed: false },
  W4: { label: "tool output", short: "tool-out", confirmed: false },
  W5: { label: "filler text", short: "filler", confirmed: false },
  W6: { label: "unused MCP tools", short: "MCP", confirmed: true },
  W7: { label: "retry tax", short: "retry", confirmed: true },
};
const WASTE_KINDS = Object.keys(WASTE);
const CONFIRMED_KINDS = WASTE_KINDS.filter((k) => WASTE[k].confirmed);
const ESTIMATED_KINDS = WASTE_KINDS.filter((k) => !WASTE[k].confirmed);

const READONLY_TOOLS = new Set(["Glob", "Grep", "WebFetch", "WebSearch", "LS", "NotebookRead"]);
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const FILLER_PATTERNS = [
  /^(sure|certainly|of course|great|got it|absolutely|okay|ok|understood|good question)\b/i,
  /^(i'?ll|i will|let me|i'?m going to|i am going to|now i'?ll|next,? i'?ll|first,? i'?ll|i'?m now)\b/i,
  /^(in summary|to summarize|summary:|here'?s what i did|here'?s a summary|i'?ve (now )?(completed|finished|updated|fixed|implemented))\b/i,
  /^(let me know|feel free|if you (want|need|'?d like|have)|would you like|want me to|shall i|happy to)\b/i,
];

const PER_DAY_TOP = 30;

function emptyBucket() {
  const waste = {};
  for (const k of WASTE_KINDS) waste[k] = { tokens: 0, cost: 0 };
  return {
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    requests: 0,
    waste,
    expiryCost: 0,
    expiryTokens: 0,
    misses: 0,
    errors: 0,
    rereads: {}, // label -> {count, cost}
    bigOutputs: [], // {label, tokens, cost}
  };
}

function addBucket(into, from) {
  into.cost += from.cost;
  into.requests += from.requests;
  for (const k of Object.keys(into.tokens)) into.tokens[k] += from.tokens[k] ?? 0;
  for (const k of WASTE_KINDS) {
    into.waste[k].tokens += from.waste[k]?.tokens ?? 0;
    into.waste[k].cost += from.waste[k]?.cost ?? 0;
  }
  into.expiryCost += from.expiryCost ?? 0;
  into.expiryTokens += from.expiryTokens ?? 0;
  into.misses += from.misses ?? 0;
  into.errors += from.errors ?? 0;
  for (const [label, e] of Object.entries(from.rereads ?? {})) tally(into.rereads, label, e.count, e.cost);
  into.bigOutputs.push(...(from.bigOutputs ?? []));
  return into;
}

function tally(map, label, count, cost) {
  const e = (map[label] ??= { count: 0, cost: 0 });
  e.count += count;
  e.cost += cost;
}

const wasteCost = (bucket, kinds = WASTE_KINDS) => kinds.reduce((n, k) => n + bucket.waste[k].cost, 0);
const wasteTokens = (bucket, kinds = WASTE_KINDS) => kinds.reduce((n, k) => n + bucket.waste[k].tokens, 0);
const topN = (items, key, n) => [...items].sort((a, b) => b[key] - a[key]).slice(0, n);

/** Keep only the top entries of the per-day lists so records stay small. */
function trimBucket(b, n = PER_DAY_TOP) {
  b.rereads = Object.fromEntries(topN(Object.entries(b.rereads).map(([label, e]) => ({ label, ...e })), "cost", n).map((e) => [e.label, { count: e.count, cost: e.cost }]));
  b.bigOutputs = topN(b.bigOutputs, "cost", n);
  return b;
}

function inputFilePath(call) {
  const p = call.input?.file_path ?? call.input?.path ?? call.input?.notebook_path;
  return typeof p === "string" ? p : undefined;
}

function analyzeChain(chain, cfg) {
  const { steps } = chain;
  const days = {}; // day -> bucket
  const unknownModels = new Set();
  const dayBucket = (step) => (days[dayOf(step.timestamp) ?? "unknown"] ??= emptyBucket());

  // Per-step unit prices ($ per token). Cache-write price follows the TTL the
  // request actually used; TTL also decides W1 vs natural expiry.
  const unit = steps.map((s) => {
    const p = priceFor(s.model);
    if (!p) {
      if (s.model !== "<synthetic>" && s.model !== "unknown") unknownModels.add(s.model);
      return null;
    }
    const uses1h = s.usage.cacheWrite1h > 0;
    return {
      input: p.input / 1e6,
      output: p.output / 1e6,
      read: (p.input * CACHE_READ_MULT) / 1e6,
      write: (p.input * (uses1h ? CACHE_WRITE_1H_MULT : CACHE_WRITE_5M_MULT)) / 1e6,
      ttlMs: uses1h ? 60 * 60 * 1000 : s.usage.cacheWrite5m > 0 ? 5 * 60 * 1000 : cfg.cache_ttl_default_ms,
    };
  });
  const hasUsage = (s) => s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite > 0;

  // ---- usage ----
  for (const s of steps) {
    const u = unit[s.index];
    const b = dayBucket(s);
    b.requests += 1;
    for (const k of Object.keys(b.tokens)) b.tokens[k] += s.usage[k];
    if (u) b.cost += s.usage.input * u.input + s.usage.output * u.output + s.usage.cacheRead * u.read + s.usage.cacheWrite * u.write;
  }

  const addWaste = (kind, step, tokens, cost) => {
    const b = dayBucket(step);
    b.waste[kind].tokens += tokens;
    b.waste[kind].cost += cost;
  };

  // Steps sharing the context of step i: until the next compaction.
  const ctxEnd = new Array(steps.length);
  for (let i = steps.length - 1, end = steps.length; i >= 0; i--) {
    if (chain.compactionsBeforeStep.has(i + 1)) end = i + 1;
    ctxEnd[i] = end;
  }
  const fresh = (j) => j === 0 || chain.compactionsBeforeStep.has(j);
  /** Price paid at request j for a token that entered the context at request `entered`. */
  const carry = (j, entered) => {
    const u = unit[j];
    if (!u) return 0;
    return j === entered || fresh(j) ? u.write : u.read;
  };
  /** Book T tokens produced at step i for every later request of the same context, per day. */
  const chargeSpan = (kind, i, tokens, from = i + 1) => {
    const end = ctxEnd[i];
    for (let j = Math.max(from, i + 1); j < end; j++) {
      const c = tokens * carry(j, i + 1);
      if (c > 0) addWaste(kind, steps[j], 0, c);
    }
  };

  // ---- W1: cache miss vs natural expiry (same model, priced, non-empty requests) ----
  let prev = -1;
  for (let i = 0; i < steps.length; i++) {
    const cur = steps[i];
    const u = unit[i];
    if (!u || !hasUsage(cur)) continue;
    const p = prev;
    prev = i;
    if (p < 0 || steps[p].model !== cur.model || ctxEnd[p] <= i) continue;
    const prevPrefix = steps[p].usage.cacheRead + steps[p].usage.cacheWrite;
    if (prevPrefix === 0 || cur.usage.cacheWrite === 0 || cur.usage.cacheRead >= prevPrefix) continue;
    const rewritten = Math.min(cur.usage.cacheWrite, prevPrefix - cur.usage.cacheRead);
    const dt = Date.parse(cur.timestamp) - Date.parse(steps[p].timestamp);
    const premium = rewritten * (u.write - u.read); // paid write price where a read would have done
    const b = dayBucket(cur);
    if (Number.isFinite(dt) && dt >= 0 && dt < unit[p].ttlMs) {
      addWaste("W1", cur, rewritten, premium);
      b.misses += 1;
    } else {
      b.expiryTokens += rewritten;
      b.expiryCost += premium;
    }
  }

  // ---- results: W7 > W2 > W4 > useful; W3 on the useful part ----
  const lastModified = new Map();
  const seenReads = new Map();
  const seenCalls = new Set();
  const useful = []; // {call, i, tokens}
  const stepRefText = steps.map((s) => [...s.texts, ...s.toolCalls.flatMap((c) => inputStrings(c.input))].join("\n"));

  for (const s of steps) {
    const i = s.index;
    const b = dayBucket(s);
    for (const call of s.toolCalls) {
      if (FILE_MUTATING_TOOLS.has(call.name)) {
        const p = inputFilePath(call);
        if (p) lastModified.set(p, i);
      }
      const t = call.result?.tokens ?? 0;
      let label;
      let duplicate = false;
      if (call.name === "Read") {
        const p = inputFilePath(call);
        if (p) {
          const key = `${p}#${call.input?.offset ?? ""}:${call.input?.limit ?? ""}`;
          const prevRead = seenReads.get(key);
          seenReads.set(key, i);
          duplicate = prevRead !== undefined && (lastModified.get(p) ?? -1) <= prevRead;
          label = p;
        }
      } else if (READONLY_TOOLS.has(call.name)) {
        const key = `${call.name}:${call.inputKey}`;
        duplicate = seenCalls.has(key);
        seenCalls.add(key);
        label = `${call.name} ${summarizeInput(call)}`;
      }

      if (call.result?.isError) {
        b.errors += 1;
        const share = Math.round(s.usage.output / s.toolCalls.length);
        addWaste("W7", s, t + share, share * (unit[i]?.output ?? 0));
        chargeSpan("W7", i, t);
      } else if (duplicate && t > 0) {
        addWaste("W2", s, t, 0);
        chargeSpan("W2", i, t);
        // Attribute the whole span cost to this label for the report.
        const end = ctxEnd[i];
        let cost = 0;
        for (let j = i + 1; j < end; j++) cost += t * carry(j, i + 1);
        tally(b.rereads, label, 1, cost);
      } else if (t > 0) {
        let keep = t;
        if (t > cfg.tool_output_threshold) {
          const excess = t - cfg.tool_output_threshold;
          keep = cfg.tool_output_threshold;
          addWaste("W4", s, excess, 0);
          chargeSpan("W4", i, excess);
          const end = ctxEnd[i];
          let cost = 0;
          for (let j = i + 1; j < end; j++) cost += excess * carry(j, i + 1);
          b.bigOutputs.push({ label: `${call.name} ${summarizeInput(call)}`, tokens: t, cost });
        }
        useful.push({ call, i, tokens: keep });
      }
    }
  }

  // ---- W3: useful results unreferenced for stale_turns requests, still carried ----
  // "Referenced" = the file path (or the call's primary input) appears again in a
  // later tool input or assistant text.
  for (const { call, i, tokens } of useful) {
    const end = ctxEnd[i];
    if (end - i <= cfg.stale_turns + 1) continue;
    const ref = inputFilePath(call) ?? refKey(call);
    let lastRef = i;
    if (ref) for (let j = i + 1; j < end; j++) if (stepRefText[j].includes(ref)) lastRef = j;
    const from = lastRef + cfg.stale_turns + 1;
    if (from >= end) continue;
    addWaste("W3", steps[from], tokens, 0);
    chargeSpan("W3", i, tokens, from);
  }

  // ---- W5: filler prose in assistant output ----
  for (const s of steps) {
    const u = unit[s.index];
    if (!u || !s.texts.length) continue;
    let chars = 0;
    for (const text of s.texts) {
      const prose = text.replace(/```[\s\S]*?```/g, " ");
      for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
        const st = sentence.trim();
        if (st.length >= 8 && FILLER_PATTERNS.some((re) => re.test(st))) chars += st.length;
      }
    }
    if (chars) addWaste("W5", s, tok(chars), tok(chars) * u.output);
  }

  // ---- W6: MCP tool definitions never called (carried in every request) ----
  let unusedMcp = [];
  if (chain.toolDefs && steps.length) {
    const used = new Set(steps.flatMap((s) => s.toolCalls.map((c) => c.name)));
    unusedMcp = topN(
      chain.toolDefs.filter((t) => t.name.startsWith("mcp__") && !used.has(t.name)).map((t) => ({ label: t.name, tokens: t.tokens })),
      "tokens",
      50,
    );
    const tokens = unusedMcp.reduce((n, t) => n + t.tokens, 0);
    if (tokens > 0) {
      for (const s of steps) {
        const j = s.index;
        addWaste("W6", s, fresh(j) ? tokens : 0, tokens * carry(j, 0));
      }
    }
  }

  for (const b of Object.values(days)) trimBucket(b);

  return {
    version: VERSION,
    key: chainKey(chain.filePath),
    file: chain.filePath,
    sessionId: chain.sessionId,
    isSidechain: chain.isSidechain,
    project: chain.cwd ?? projectFromPath(chain.filePath),
    models: [...new Set(steps.map((s) => s.model))].filter((m) => m !== "<synthetic>"),
    startTime: chain.startTime,
    endTime: chain.endTime,
    requests: steps.length,
    days,
    unusedMcp,
    unknownModels: [...unknownModels],
  };
}

function refKey(call) {
  const input = call.input;
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["pattern", "query", "url"]) if (typeof input[key] === "string" && input[key].length >= 4) return input[key];
  return undefined;
}

function summarizeInput(call) {
  const input = call.input;
  if (!input || typeof input !== "object") return "";
  for (const key of ["pattern", "query", "url", "file_path", "path", "command", "description"]) {
    if (typeof input[key] === "string") return truncate(input[key].replace(/\s+/g, " "), 70);
  }
  return truncate(JSON.stringify(input), 70);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function chainKey(file) {
  // Stable, filesystem-safe id for a transcript file.
  return file.replace(PROJECTS_ROOT, "").replace(/^[\\/]/, "").replace(/[\\/]/g, "__").replace(/\.jsonl$/, "");
}

function projectFromPath(file) {
  const rel = file.slice(PROJECTS_ROOT.length + 1);
  return rel.split(/[\\/]/)[0] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Store + refresh: incremental index of every transcript touched in the last
// window_days, one record per chain, summed into summary.json.
// ---------------------------------------------------------------------------

function findJsonl(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function lockIsFresh() {
  const lock = readJson(LOCK_FILE, null);
  return !!lock && Date.now() - lock.time < LOCK_TTL_MS;
}

/** Atomic (O_EXCL) lock; a lock older than LOCK_TTL_MS is treated as abandoned. */
function acquireLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (lockIsFresh()) return false;
      try {
        unlinkSync(LOCK_FILE);
      } catch {}
    }
  }
  return false;
}

function touchLock() {
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, time: Date.now() }));
  } catch {}
}

function releaseLock() {
  try {
    if (readJson(LOCK_FILE, null)?.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

function refresh({ quiet = false } = {}) {
  const cfg = loadConfig();
  if (!acquireLock()) {
    if (!quiet) console.error("another refresh is running");
    return null;
  }
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    let index = readJson(INDEX_FILE, null);
    if (!index || index.version !== VERSION || !index.files) {
      // Schema changed (or first run): rebuild every record.
      rmSync(SESSIONS_DIR, { recursive: true, force: true });
      mkdirSync(SESSIONS_DIR, { recursive: true });
      index = { version: VERSION, files: {} };
    }
    const cutoff = Date.now() - (cfg.window_days + 1) * 86_400_000;
    const files = findJsonl(PROJECTS_ROOT);
    const live = new Set();
    let parsed = 0;
    let failed = 0;
    let n = 0;
    for (const file of files) {
      if (++n % 25 === 0) touchLock();
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const key = chainKey(file);
      live.add(key);
      const prev = index.files[key];
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
      try {
        writeJsonAtomic(join(SESSIONS_DIR, `${key}.json`), analyzeChain(parseChain(file), cfg));
        index.files[key] = { size: st.size, mtime: st.mtimeMs, file };
        parsed += 1;
      } catch (err) {
        // Remember the failure so the file is retried only when it changes.
        index.files[key] = { size: st.size, mtime: st.mtimeMs, file, error: String(err.message ?? err).slice(0, 200) };
        failed += 1;
        if (!quiet) console.error(`skip ${file}: ${err.message}`);
      }
    }
    for (const key of Object.keys(index.files)) {
      if (!live.has(key)) {
        delete index.files[key];
        try {
          unlinkSync(join(SESSIONS_DIR, `${key}.json`));
        } catch {}
      }
    }
    writeJsonAtomic(INDEX_FILE, index);
    const summary = buildSummary(cfg);
    summary.files = live.size;
    summary.failedFiles = Object.values(index.files).filter((f) => f.error).length;
    summary.parsedNow = parsed;
    writeJsonAtomic(SUMMARY_FILE, summary);
    return summary;
  } finally {
    releaseLock();
  }
}

function loadRecords() {
  let names;
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const r = readJson(join(SESSIONS_DIR, n), null);
    if (r && r.version === VERSION && r.days) out.push(r);
  }
  return out;
}

function summarizeBucket(b) {
  const confirmedCost = wasteCost(b, CONFIRMED_KINDS);
  const estimatedCost = wasteCost(b, ESTIMATED_KINDS);
  const usageTokens = Object.values(b.tokens).reduce((n, v) => n + v, 0);
  return {
    confirmedCost,
    estimatedCost,
    wasteCost: confirmedCost + estimatedCost,
    wasteRatioConfirmed: b.cost > 0 ? confirmedCost / b.cost : 0,
    wasteRatioTotal: b.cost > 0 ? (confirmedCost + estimatedCost) / b.cost : 0,
    wasteRatioTokens: usageTokens > 0 ? wasteTokens(b) / usageTokens : 0,
  };
}

function buildSummary(cfg) {
  const records = loadRecords();
  const today = daysAgo(0);
  const windows = { today: [today, today], d7: [daysAgo(6), today], d30: [daysAgo(cfg.window_days - 1), today] };
  const out = { generatedAt: new Date().toISOString(), version: VERSION, pricingRevised: PRICING_REVISED, windows: {}, sessions: {}, unknownModels: [] };
  const unknown = new Set();
  for (const r of records) for (const m of r.unknownModels) unknown.add(m);

  for (const [name, [from, to]] of Object.entries(windows)) {
    const total = emptyBucket();
    const projects = new Map();
    const sessions = new Map();
    const unusedMcp = new Map();
    for (const r of records) {
      let touched = false;
      for (const [day, b] of Object.entries(r.days)) {
        if (day < from || day > to) continue;
        touched = true;
        addBucket(total, b);
        addBucket(projects.get(r.project) ?? projects.set(r.project, emptyBucket()).get(r.project), b);
        let sess = sessions.get(r.sessionId);
        if (!sess) sessions.set(r.sessionId, (sess = { bucket: emptyBucket(), sessionId: r.sessionId, project: r.project, models: new Set(), endTime: r.endTime ?? "" }));
        addBucket(sess.bucket, b);
        for (const m of r.models) sess.models.add(m);
        if ((r.endTime ?? "") > sess.endTime) sess.endTime = r.endTime;
      }
      if (!touched) continue;
      for (const e of r.unusedMcp) {
        const x = unusedMcp.get(e.label) ?? { label: e.label, tokens: 0, chains: 0 };
        x.tokens = Math.max(x.tokens, e.tokens);
        x.chains += 1;
        unusedMcp.set(e.label, x);
      }
    }
    const rereads = Object.entries(total.rereads).map(([label, e]) => ({ label, ...e }));
    out.windows[name] = {
      from,
      to,
      cost: total.cost,
      requests: total.requests,
      tokens: total.tokens,
      waste: total.waste,
      expiryCost: total.expiryCost,
      expiryTokens: total.expiryTokens,
      misses: total.misses,
      errors: total.errors,
      ...summarizeBucket(total),
      sessions: sessions.size,
      projects: topN(
        [...projects.entries()].map(([project, b]) => ({ project, cost: b.cost, wasteCost: wasteCost(b) })),
        "cost",
        15,
      ),
      topSessions: topN(
        [...sessions.values()].map((s) => ({ sessionId: s.sessionId, project: s.project, models: [...s.models], endTime: s.endTime, cost: s.bucket.cost, wasteCost: wasteCost(s.bucket) })),
        "cost",
        10,
      ),
      topRereads: topN(rereads, "cost", 10),
      unusedMcp: topN([...unusedMcp.values()], "tokens", 15),
      unusedMcpTokens: [...unusedMcp.values()].reduce((n, e) => n + e.tokens, 0),
      bigOutputs: topN(total.bigOutputs, "cost", 10),
    };
  }

  // Per-session figures for the status line hints (main chains active in the last 2 days).
  const recent = daysAgo(1);
  for (const r of records) {
    if (r.isSidechain || (dayOf(r.endTime) ?? "") < recent) continue;
    const b = emptyBucket();
    for (const day of Object.keys(r.days)) if (day >= recent) addBucket(b, r.days[day]);
    const wc = wasteCost(b);
    out.sessions[r.sessionId] = {
      cost: b.cost,
      wasteCost: wc,
      staleShare: wc > 0 ? b.waste.W3.cost / wc : 0,
      unusedMcpTokens: r.unusedMcp.reduce((n, e) => n + e.tokens, 0),
      requests: r.requests,
    };
  }
  out.unknownModels = [...unknown];
  // Savings schema (reserved for interventions in a later version).
  out.savings = { baseline: null, interventions: [], measured: {}, estimated: null, holdoutRatio: 0 };
  return out;
}

/** A summary this engine version can render. */
function validSummary(s) {
  return !!s && s.version === VERSION && !!s.windows?.today && !!s.windows?.d7 && !!s.windows?.d30 && Number.isFinite(Date.parse(s.generatedAt));
}

function summaryIsStale(summary, cfg) {
  return !validSummary(summary) || Date.now() - Date.parse(summary.generatedAt) > cfg.refresh_seconds * 1000;
}

function spawnRefresh() {
  if (lockIsFresh()) return; // an index is already running
  const engine = fileURLToPath(import.meta.url);
  try {
    const child = spawn(process.execPath, [engine, "refresh", "--quiet"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {}
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

function palette(enabled) {
  const c = (code) => (enabled ? `\x1b[${code}m` : "");
  return { reset: c(0), bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33) };
}
// Terminal output honours isTTY; the status line is always coloured (Claude
// Code renders ANSI there even though stdout is a pipe).
const C = palette(process.stdout.isTTY || process.env.AGENTPROF_COLOR === "1");

const usd = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const compact = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};

function shortModel(id) {
  if (!id) return "Claude";
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? "." + m[3] : ""}`;
}

// ---------------------------------------------------------------------------
// Status line. Reads summary.json only (never parses transcripts); kicks a
// background refresh when the summary is stale and no index is running.
// Chains the status line that was configured before `on`, if any.
// ---------------------------------------------------------------------------

function readStdin() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {}
  let json = {};
  try {
    json = raw.trim() ? JSON.parse(raw) : {};
  } catch {}
  return { raw, json };
}

function runPreviousStatusLine(prev, rawStdin) {
  return new Promise((done) => {
    const cmd = prev?.value?.command;
    if (!cmd) return done("");
    const win = process.platform === "win32";
    const child = execFile(win ? "cmd" : "sh", [win ? "/c" : "-c", cmd], { timeout: 1500, maxBuffer: 1 << 20, windowsVerbatimArguments: win, windowsHide: true }, (_err, stdout) => done(stdout ?? ""));
    child.stdin?.on("error", () => {});
    child.stdin?.end(rawStdin);
  });
}

async function statusLine() {
  const cfg = loadConfig();
  const { raw, json: input } = readStdin();

  const prevOut = await runPreviousStatusLine(readJson(PREV_STATUSLINE_FILE, null), raw);
  if (prevOut.trim()) process.stdout.write(prevOut.endsWith("\n") ? prevOut : prevOut + "\n");

  const summary = readJson(SUMMARY_FILE, null);
  if (summaryIsStale(summary, cfg)) spawnRefresh();

  const S = palette(true);
  const sep = `${S.dim} │ ${S.reset}`;
  const model = shortModel(input.model?.id);
  const ctx = typeof input.context_window?.used_percentage === "number" ? `ctx ${Math.round(input.context_window.used_percentage)}%` : null;
  const rl = input.rate_limits;
  const five = typeof rl?.five_hour?.used_percentage === "number" ? rl.five_hour.used_percentage : null;
  const seven = typeof rl?.seven_day?.used_percentage === "number" ? rl.seven_day.used_percentage : null;
  // rate_limits only exists for Pro/Max and only after the first API response;
  // remember it so a fresh session renders the subscription layout from the start.
  let subscription = five !== null || seven !== null;
  if (subscription) {
    if (!readJson(MODE_FILE, null)?.subscription) writeJsonAtomic(MODE_FILE, { subscription: true });
  } else subscription = readJson(MODE_FILE, null)?.subscription === true;

  if (!validSummary(summary)) {
    console.log([`${S.bold}◆ ${model}${S.reset}`, ctx, `${S.dim}agentprof: indexing…${S.reset}`].filter(Boolean).join(sep));
    return;
  }

  const t = summary.windows.today;
  const line1 = [`${S.bold}◆ ${model}${S.reset}`, ctx];
  if (subscription) line1.push([five !== null ? `5h ${Math.round(five)}%` : null, seven !== null ? `7d ${Math.round(seven)}%` : null].filter(Boolean).join(" · "));
  line1.push(`${subscription ? `${S.dim}≈ ${S.reset}` : ""}today ${usd(t.cost)} · 7d ${usd(summary.windows.d7.cost)} · 30d ${usd(summary.windows.d30.cost)}`);
  console.log(line1.filter(Boolean).join(sep));

  const ratio = t.wasteRatioTotal;
  const tone = ratio >= 0.4 ? S.red : ratio >= 0.2 ? S.yellow : S.green;
  const parts = topN(
    WASTE_KINDS.map((k) => ({ k, cost: t.waste[k].cost })).filter((x) => x.cost > 0),
    "cost",
    3,
  ).map((x) => `${WASTE[x.k].short} ${pct(t.cost > 0 ? x.cost / t.cost : 0)}`);
  let head = `◇ waste ${tone}${usd(t.wasteCost)}${S.reset} (${pct(ratio)}: confirmed ${pct(t.wasteRatioConfirmed)} + est ${pct(ratio - t.wasteRatioConfirmed)})`;
  if (subscription && five !== null) head += ` ≈ 5h ${pct((ratio * five) / 100)}`;
  // Hints are about THIS session (that is where /clear or an MCP change acts).
  const hints = [];
  const sess = input.session_id ? summary.sessions?.[input.session_id] : undefined;
  if (sess && sess.requests >= cfg.stale_turns && sess.staleShare >= cfg.stale_hint_ratio) hints.push("/clear recommended");
  if (sess && sess.unusedMcpTokens >= cfg.mcp_hint_tokens) hints.push("prune unused MCP");
  if (summary.unknownModels.length) hints.push(`unpriced model: ${summary.unknownModels.map(shortModel).join(",")}`);
  const line2 = [head, parts.length ? parts.join(" · ") : `${S.dim}no waste detected${S.reset}`];
  if (hints.length) line2.push(`${S.yellow}${hints.join(" · ")}${S.reset}`);
  console.log(line2.join(sep));
}

// ---------------------------------------------------------------------------
// Report (plain text; the skill prints it verbatim).
// ---------------------------------------------------------------------------

function table(headers, rows, aligns) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cells) => cells.map((v, i) => (aligns[i] === "r" ? String(v).padStart(widths[i]) : String(v).padEnd(widths[i]))).join("  ");
  return [fmt(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)].map((l) => "  " + l).join("\n");
}

function report(summary, top) {
  const W = summary.windows;
  const out = [];
  out.push(`${C.bold}agentprof ${VERSION}${C.reset} — usage & waste  ${C.dim}(refreshed ${summary.generatedAt.replace("T", " ").slice(0, 19)}, prices as of ${summary.pricingRevised}, ${summary.files ?? 0} transcripts)${C.reset}`);
  if (!summary.files) out.push(`${C.yellow}⚠ No transcripts found under ${PROJECTS_ROOT} in the last ${DEFAULT_CONFIG.window_days} days.${C.reset}`);
  out.push("");
  out.push(
    table(
      ["window", "cost", "requests", "confirmed", "estimated", "waste %", "cache expiry", "sessions"],
      [
        ["today", W.today],
        ["7d", W.d7],
        ["30d", W.d30],
      ].map(([n, w]) => [n, usd(w.cost), w.requests, usd(w.confirmedCost), usd(w.estimatedCost), `${pct(w.wasteRatioTotal, 1)} (${pct(w.wasteRatioConfirmed, 1)} confirmed)`, usd(w.expiryCost), w.sessions]),
      ["l", "r", "r", "r", "r", "r", "r", "r"],
    ),
  );
  out.push("");
  out.push(`${C.bold}Tokens (30d)${C.reset}  input ${compact(W.d30.tokens.input)} · output ${compact(W.d30.tokens.output)} · cache read ${compact(W.d30.tokens.cacheRead)} · cache write ${compact(W.d30.tokens.cacheWrite)}`);
  out.push("");
  out.push(`${C.bold}Waste by kind${C.reset}`);
  out.push(
    table(
      ["id", "kind", "status", "today", "7d", "30d", "30d tokens", "share of 30d cost"],
      WASTE_KINDS.map((k) => [k, WASTE[k].label, WASTE[k].confirmed ? "confirmed" : "estimated", usd(W.today.waste[k].cost), usd(W.d7.waste[k].cost), usd(W.d30.waste[k].cost), compact(W.d30.waste[k].tokens), pct(W.d30.cost > 0 ? W.d30.waste[k].cost / W.d30.cost : 0, 1)]),
      ["l", "l", "l", "r", "r", "r", "r", "r"],
    ),
  );
  out.push("");
  out.push(`${C.dim}Not counted as waste: natural cache expiry (TTL elapsed between requests) — 30d ${usd(W.d30.expiryCost)}. Cache misses inside the TTL: ${W.d30.misses}; failed tool calls: ${W.d30.errors}. "tokens" = context tokens flagged once (W3: at the moment they went stale; W6: per fresh context).${C.reset}`);
  out.push("");
  if (W.d30.projects.length) {
    out.push(`${C.bold}Projects (30d)${C.reset}`);
    out.push(table(["project", "cost", "waste", "waste %"], W.d30.projects.slice(0, top).map((p) => [truncate(p.project, 60), usd(p.cost), usd(p.wasteCost), pct(p.cost > 0 ? p.wasteCost / p.cost : 0, 1)]), ["l", "r", "r", "r"]));
    out.push("");
  }
  if (W.d30.topSessions.length) {
    out.push(`${C.bold}Most expensive sessions (30d)${C.reset}`);
    out.push(table(["session", "last active", "model", "cost", "waste"], W.d30.topSessions.slice(0, top).map((s) => [s.sessionId.slice(0, 8), (s.endTime ?? "").slice(0, 10), s.models.map(shortModel).join(","), usd(s.cost), usd(s.wasteCost)]), ["l", "l", "l", "r", "r"]));
    out.push("");
  }
  if (W.d30.topRereads.length) {
    out.push(`${C.bold}Top duplicate reads (30d)${C.reset}`);
    out.push(table(["what", "times", "cost"], W.d30.topRereads.slice(0, top).map((r) => [truncate(r.label, 70), r.count, usd(r.cost)]), ["l", "r", "r"]));
    out.push("");
  }
  if (W.d30.unusedMcp.length) {
    out.push(`${C.bold}MCP tools defined but never called (30d)${C.reset}  ${C.dim}~${compact(W.d30.unusedMcpTokens)} tokens carried in every request${C.reset}`);
    out.push(table(["tool", "tokens", "sessions"], W.d30.unusedMcp.slice(0, top).map((r) => [truncate(r.label, 60), compact(r.tokens), r.chains]), ["l", "r", "r"]));
    out.push("");
  }
  if (W.d30.bigOutputs.length) {
    out.push(`${C.bold}Largest tool outputs (30d)${C.reset}`);
    out.push(table(["call", "tokens", "cost of excess"], W.d30.bigOutputs.slice(0, top).map((r) => [truncate(r.label, 70), compact(r.tokens), usd(r.cost)]), ["l", "r", "r"]));
    out.push("");
  }
  if (summary.unknownModels.length) out.push(`${C.yellow}⚠ unknown model pricing (not converted to $): ${summary.unknownModels.join(", ")} — add them to ~/.claude/agentprof/pricing.json${C.reset}`);
  if (summary.failedFiles) out.push(`${C.yellow}⚠ ${summary.failedFiles} transcript(s) could not be parsed (see state/index.json).${C.reset}`);
  const names = (kinds) => kinds.map((k) => WASTE[k].label).join(" + ");
  out.push(`${C.dim}Confirmed = ${names(CONFIRMED_KINDS)}. Estimated = ${names(ESTIMATED_KINDS)}. Tokens for tool results/text are ~chars/4; images ~${IMAGE_TOKENS} each.${C.reset}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// on / off: install the engine user-wide and wire the status line.
// ---------------------------------------------------------------------------

function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    throw new Error(`${SETTINGS_FILE} is not valid JSON — fix it first, nothing was changed`);
  }
}

function saveSettings(settings, { backup = false } = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  // One backup of the user's original settings, taken the first time `on` changes them.
  if (backup && existsSync(SETTINGS_FILE)) copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE);
  writeJsonAtomic(SETTINGS_FILE, settings);
}

/** The status line command. Prefer `node` from PATH (survives nvm upgrades); fall back to this Node binary. */
function ourCommand() {
  const engine = INSTALLED_ENGINE;
  if (process.platform === "win32") return `node "${engine}" status`;
  return `node "${engine}" status 2>/dev/null || "${process.execPath}" "${engine}" status`;
}

const isOurStatusLine = (sl) => typeof sl?.command === "string" && sl.command.includes(`"${INSTALLED_ENGINE}" status`);

function turnOn() {
  mkdirSync(DATA_DIR, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  if (resolve(self) !== resolve(INSTALLED_ENGINE)) copyFileSync(self, INSTALLED_ENGINE);
  const settings = loadSettings();
  const current = settings.statusLine;
  const firstTime = !isOurStatusLine(current);
  if (firstTime) writeJsonAtomic(PREV_STATUSLINE_FILE, { had: current !== undefined, value: current ?? null });
  settings.statusLine = { type: "command", command: ourCommand(), padding: 0 };
  saveSettings(settings, { backup: firstTime });
  spawnRefresh();
  const prev = readJson(PREV_STATUSLINE_FILE, null);
  console.log(`${C.green}✓${C.reset} agentprof status line on${prev?.had ? " (your previous status line is kept and shown above ours)" : ""}.\n  Engine: ${INSTALLED_ENGINE}\n  Data:   ${DATA_DIR}\n  Indexing transcripts in the background; the status line updates on the next response.`);
}

function turnOff() {
  const settings = loadSettings();
  const prev = readJson(PREV_STATUSLINE_FILE, null);
  if (isOurStatusLine(settings.statusLine)) {
    if (prev?.had && prev.value) settings.statusLine = prev.value;
    else delete settings.statusLine;
    saveSettings(settings);
  }
  try {
    unlinkSync(PREV_STATUSLINE_FILE);
  } catch {}
  console.log(`${C.green}✓${C.reset} agentprof status line off${prev?.had ? " (previous status line restored)" : ""}. Indexed data kept in ${DATA_DIR}; run \`off\` before deleting that folder.`);
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const HELP = `agentprof ${VERSION} — token-waste tracker for Claude Code

Usage:
  agentprof on              show usage + waste in the Claude Code status line
  agentprof off             remove it (restores your previous status line)
  agentprof report          usage, waste (W1–W7) and per-project breakdown: today / 7d / 30d
  agentprof refresh         re-index transcripts now
  agentprof init            install the /agentprof skill into the current project

Options:
  --json          print the summary as JSON (report)
  --top <n>       rows per table (default 10)
  --version, -v   print the version

Data lives in ~/.claude/agentprof (config.json, pricing.json override, daily index).`;

const VALUE_OPTS = new Set(["--top"]);

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const cmd = args.find((a, i) => !a.startsWith("-") && !VALUE_OPTS.has(args[i - 1]));

  if (flags.has("--version") || flags.has("-v")) return console.log(`agentprof ${VERSION}`);
  if (flags.has("--help") || flags.has("-h") || !cmd) return console.log(HELP);

  switch (cmd) {
    case "status":
      return statusLine();
    case "on":
      return turnOn();
    case "off":
      return turnOff();
    case "refresh": {
      const s = refresh({ quiet: flags.has("--quiet") });
      if (!flags.has("--quiet") && s) console.log(`${C.green}✓${C.reset} indexed ${s.parsedNow} changed transcript(s); 30d cost ${usd(s.windows.d30.cost)}, waste ${usd(s.windows.d30.wasteCost)}`);
      return;
    }
    case "report": {
      const cfg = loadConfig();
      let summary = readJson(SUMMARY_FILE, null);
      if (summaryIsStale(summary, cfg)) {
        summary = refresh({ quiet: true }) ?? summary;
        // Another process is indexing: wait for it rather than reporting stale/empty data.
        for (let waited = 0; !validSummary(summary) && waited < 20_000 && lockIsFresh(); waited += 250) {
          sleepMs(250);
          summary = readJson(SUMMARY_FILE, null);
        }
        if (!validSummary(summary)) summary = refresh({ quiet: true }) ?? summary;
      }
      if (!validSummary(summary)) {
        console.error(`${C.yellow}Indexing is still in progress — run \`agentprof report\` again in a few seconds.${C.reset}`);
        process.exitCode = 1;
        return;
      }
      if (flags.has("--json")) return console.log(JSON.stringify(summary, null, 2));
      return console.log(report(summary, Number(opt("--top", 10)) || 10));
    }
    case "init": {
      const source = join(dirname(fileURLToPath(import.meta.url)), "..");
      if (!existsSync(join(source, "SKILL.md"))) {
        console.error(`${C.red}could not locate SKILL.md next to this script${C.reset} — run init from the repo or via npx, not from ${INSTALLED_ENGINE}`);
        process.exitCode = 1;
        return;
      }
      const dir = resolve(".claude", "skills", "agentprof");
      if (resolve(source) === dir) {
        console.log(`${C.green}✓${C.reset} skill already installed at ${dir}`);
        return;
      }
      mkdirSync(dir, { recursive: true });
      cpSync(source, dir, { recursive: true });
      console.log(`${C.green}✓${C.reset} installed skill → ${dir}\n  In Claude Code: ${C.bold}/agentprof on${C.reset} (status line), ${C.bold}/agentprof report${C.reset} (details).\n  Commit the folder to share it with your team.`);
      return;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${C.red}agentprof:${C.reset} ${err.message}`);
  process.exitCode = 1;
});
