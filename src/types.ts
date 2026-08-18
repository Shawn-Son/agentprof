/**
 * Trajectory IR — the neutral intermediate representation every log adapter
 * produces. Analyzers and reporters only ever see this shape, never the raw
 * log format, so new agent CLIs (Codex, Gemini CLI, ...) plug in as adapters.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export interface ToolResult {
  isError: boolean;
  /** Character length of the TEXT result content (token estimate = chars/4). */
  contentChars: number;
  /** Number of image blocks in the result (estimated ~1600 tokens each). */
  imageCount: number;
  timestamp?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Canonical JSON of input, used for duplicate detection. */
  inputKey: string;
  result?: ToolResult;
}

/** One model request (one API call in the agent loop). */
export interface Step {
  id: string;
  index: number;
  requestId?: string;
  timestamp: string;
  model: string;
  usage: Usage;
  toolCalls: ToolCall[];
  /** Character length of assistant text in this step. */
  textChars: number;
  isSidechain: boolean;
}

export interface Trajectory {
  sessionId: string;
  source: string; // adapter name, e.g. "claude-code"
  filePath: string;
  cwd?: string;
  version?: string;
  firstUserMessage?: string;
  startTime?: string;
  endTime?: string;
  steps: Step[];
}

/** Dollar cost breakdown for a step or a whole session. */
export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type WasteKind = "reread" | "duplicate-call" | "retry";

export interface WasteFinding {
  kind: WasteKind;
  /** Human-readable label, e.g. the re-read file path or failing command. */
  label: string;
  /** Number of wasteful occurrences (e.g. 3 = file read 4x, 3 of them wasted). */
  occurrences: number;
  /** Estimated wasted tokens pushed into context. */
  wastedTokens: number;
  /** Estimated wasted dollars (conservative, see analyze.ts for the formula). */
  wastedCost: number;
  /** Step indices where the waste happened. */
  stepIndices: number[];
}

export interface StepCost {
  step: Step;
  cost: Cost;
}

export interface SessionProfile {
  trajectory: Trajectory;
  stepCosts: StepCost[];
  totalCost: Cost;
  totalUsage: Usage;
  durationMs: number;
  findings: WasteFinding[];
  wastedCost: number;
  wastedTokens: number;
  /** wastedCost / totalCost.total (0..1) */
  wasteRatio: number;
  toolStats: ToolStat[];
  unknownModels: string[];
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  /** Estimated result tokens (text chars/4 + ~1600 per image). */
  resultTokens: number;
  /** Estimated context cost of this tool's results over the session. */
  estContextCost: number;
}
