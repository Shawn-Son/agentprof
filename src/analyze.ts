/**
 * Cost attribution + waste detection over the Trajectory IR.
 *
 * Waste-cost model
 * ----------------
 * When a tool result of ~T tokens enters the context at step i, the session
 * pays for it roughly as:
 *
 *   T x inputPrice x CACHE_WRITE_5M_MULT          (written to cache once)
 * + T x inputPrice x CACHE_READ_MULT x L          (re-read from cache in each
 *                                                  of the L later requests of
 *                                                  the same chain)
 *
 * This is what `persistenceCost` computes. It is an estimate (tokens are
 * approximated as chars/4, and context compaction may drop old content), but
 * it reflects the real mechanics of prompt-cached agent loops: everything you
 * put in context is paid for again on every subsequent request.
 */

import {
  CACHE_READ_MULT,
  CACHE_WRITE_5M_MULT,
  CACHE_WRITE_1H_MULT,
  priceFor,
} from "./pricing.js";
import type {
  Cost,
  SessionProfile,
  Step,
  StepCost,
  ToolCall,
  ToolStat,
  Trajectory,
  Usage,
  WasteFinding,
} from "./types.js";

const CHARS_PER_TOKEN = 4;
/** Rough per-image visual-token estimate (typical screenshot at the old cap). */
const IMAGE_TOKENS = 1600;

function resultTokens(result: { contentChars: number; imageCount: number } | undefined): number {
  if (!result) return 0;
  return Math.round(result.contentChars / CHARS_PER_TOKEN) + result.imageCount * IMAGE_TOKENS;
}

/** Read-only tools whose exact duplicates are always redundant. */
const READONLY_TOOLS = new Set([
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "LS",
  "NotebookRead",
]);

/** Tools that modify a file at input.file_path (invalidate earlier reads). */
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

export function stepCost(step: Step): Cost {
  const p = priceFor(step.model);
  if (!p) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const u = step.usage;
  const input = (u.inputTokens / 1e6) * p.input;
  const output = (u.outputTokens / 1e6) * p.output;
  const cacheRead = (u.cacheReadTokens / 1e6) * p.input * CACHE_READ_MULT;
  const cacheWrite =
    (u.cacheWrite5mTokens / 1e6) * p.input * CACHE_WRITE_5M_MULT +
    (u.cacheWrite1hTokens / 1e6) * p.input * CACHE_WRITE_1H_MULT;
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

export function profileSession(trajectory: Trajectory): SessionProfile {
  const steps = trajectory.steps;
  const stepCosts: StepCost[] = steps.map((s) => ({ step: s, cost: stepCost(s) }));

  const totalCost = stepCosts.reduce<Cost>(
    (acc, sc) => ({
      input: acc.input + sc.cost.input,
      output: acc.output + sc.cost.output,
      cacheRead: acc.cacheRead + sc.cost.cacheRead,
      cacheWrite: acc.cacheWrite + sc.cost.cacheWrite,
      total: acc.total + sc.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );

  const totalUsage = steps.reduce<Usage>(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.usage.inputTokens,
      outputTokens: acc.outputTokens + s.usage.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + s.usage.cacheReadTokens,
      cacheWrite5mTokens: acc.cacheWrite5mTokens + s.usage.cacheWrite5mTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens + s.usage.cacheWrite1hTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
  );

  const unknownModels = [
    ...new Set(
      steps
        .filter((s) => !priceFor(s.model) && s.model !== "<synthetic>")
        .map((s) => s.model),
    ),
  ];

  // How many later requests re-read context added at a given step. Precomputed
  // per chain (main vs sidechain) so persistenceCost is O(1) per call.
  const totalMain = steps.filter((s) => !s.isSidechain).length;
  const totalSide = steps.length - totalMain;
  const laterCount = new Array<number>(steps.length).fill(0);
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
  const laterSteps = (step: Step): number => laterCount[step.index] ?? 0;

  const persistenceCost = (tokens: number, step: Step): number => {
    const p = priceFor(step.model);
    if (!p) return 0;
    return (
      (tokens / 1e6) *
      p.input *
      (CACHE_WRITE_5M_MULT + CACHE_READ_MULT * laterSteps(step))
    );
  };

  const findings: WasteFinding[] = [
    ...detectRereads(steps, persistenceCost),
    ...detectDuplicateCalls(steps, persistenceCost),
    ...detectRetries(steps, stepCosts, persistenceCost),
  ].sort((a, b) => b.wastedCost - a.wastedCost);

  const wastedCost = findings.reduce((n, f) => n + f.wastedCost, 0);
  const wastedTokens = findings.reduce((n, f) => n + f.wastedTokens, 0);

  const toolStats = computeToolStats(steps, persistenceCost);

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
    toolStats,
    unknownModels,
  };
}

interface CallSite {
  step: Step;
  call: ToolCall;
  /** Global ordinal across the session, used for "what happened in between". */
  ordinal: number;
}

function allCalls(steps: Step[]): CallSite[] {
  const out: CallSite[] = [];
  let ordinal = 0;
  for (const step of steps) {
    for (const call of step.toolCalls) {
      out.push({ step, call, ordinal: ordinal++ });
    }
  }
  return out;
}

function inputFilePath(call: ToolCall): string | undefined {
  const input = call.input as Record<string, unknown> | null | undefined;
  const p = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof p === "string" ? p : undefined;
}

/**
 * Reread Ratio: the same file Read more than once with no modification of that
 * file in between. The repeated read's actual result size is counted as waste
 * (so partial re-reads are only partially penalized).
 */
function detectRereads(
  steps: Step[],
  persistenceCost: (tokens: number, step: Step) => number,
): WasteFinding[] {
  const calls = allCalls(steps);
  // Keys are chain-scoped ("m:" main / "s:" sidechain): a read repeated in a
  // DIFFERENT chain runs in a separate context and is not redundant there.
  const chainKey = (step: Step, p: string): string =>
    `${step.isSidechain ? "s" : "m"}:${p}`;
  // chain:path -> ordinal of last modification
  const lastModified = new Map<string, number>();
  // chain:path -> ordinal of last read
  const lastRead = new Map<string, number>();
  const wasteByFile = new Map<
    string,
    { occurrences: number; wastedTokens: number; wastedCost: number; stepIndices: number[] }
  >();

  for (const site of calls) {
    const { call, step, ordinal } = site;
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
    const key = chainKey(step, p);
    const prevRead = lastRead.get(key);
    lastRead.set(key, ordinal);
    if (prevRead === undefined) continue;
    const modifiedSince = (lastModified.get(key) ?? -1) > prevRead;
    if (modifiedSince) continue; // legitimate re-read after an edit
    const tokens = resultTokens(call.result);
    if (tokens === 0) continue;
    const entry =
      wasteByFile.get(p) ??
      { occurrences: 0, wastedTokens: 0, wastedCost: 0, stepIndices: [] };
    entry.occurrences += 1;
    entry.wastedTokens += tokens;
    entry.wastedCost += persistenceCost(tokens, step);
    entry.stepIndices.push(step.index);
    wasteByFile.set(p, entry);
  }

  return [...wasteByFile.entries()].map(([file, e]) => ({
    kind: "reread" as const,
    label: file,
    ...e,
  }));
}

/**
 * Duplicate calls: exact same read-only tool + identical input, repeated.
 * Stateful tools (Bash etc.) are deliberately excluded — repeating them can be
 * legitimate. Read has its own detector above.
 */
function detectDuplicateCalls(
  steps: Step[],
  persistenceCost: (tokens: number, step: Step) => number,
): WasteFinding[] {
  const calls = allCalls(steps);
  const seen = new Set<string>();
  const wasteByKey = new Map<
    string,
    {
      label: string;
      occurrences: number;
      wastedTokens: number;
      wastedCost: number;
      stepIndices: number[];
    }
  >();

  for (const { call, step } of calls) {
    if (!READONLY_TOOLS.has(call.name)) continue;
    // Chain-scoped: an identical call in a different chain (main vs sidechain)
    // runs in a separate context and is not a redundant repeat there.
    const key = `${step.isSidechain ? "s" : "m"}:${call.name} ${call.inputKey}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    const tokens = resultTokens(call.result);
    const entry =
      wasteByKey.get(key) ??
      {
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

  return [...wasteByKey.values()].map((e) => ({
    kind: "duplicate-call" as const,
    ...e,
  }));
}

/**
 * Retry Tax: failed tool calls. Waste counted = the error output that entered
 * context, plus the share of the step's output tokens spent emitting the
 * failed call(s).
 */
function detectRetries(
  steps: Step[],
  stepCosts: StepCost[],
  persistenceCost: (tokens: number, step: Step) => number,
): WasteFinding[] {
  const wasteByTool = new Map<
    string,
    { occurrences: number; wastedTokens: number; wastedCost: number; stepIndices: number[] }
  >();

  for (const sc of stepCosts) {
    const { step, cost } = sc;
    const failed = step.toolCalls.filter((c) => c.result?.isError);
    if (failed.length === 0) continue;
    const share = failed.length / step.toolCalls.length;
    for (const call of failed) {
      const tokens = resultTokens(call.result);
      const entry =
        wasteByTool.get(call.name) ??
        { occurrences: 0, wastedTokens: 0, wastedCost: 0, stepIndices: [] };
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

  return [...wasteByTool.entries()].map(([tool, e]) => ({
    kind: "retry" as const,
    label: tool,
    ...e,
  }));
}

function computeToolStats(
  steps: Step[],
  persistenceCost: (tokens: number, step: Step) => number,
): ToolStat[] {
  const stats = new Map<string, ToolStat>();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const s =
        stats.get(call.name) ??
        { name: call.name, calls: 0, errors: 0, resultTokens: 0, estContextCost: 0 };
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

function summarizeInput(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== "object") return "";
  for (const key of ["pattern", "query", "url", "file_path", "path", "command"]) {
    const v = input[key];
    if (typeof v === "string") return truncate(v, 80);
  }
  return truncate(JSON.stringify(input), 80);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
