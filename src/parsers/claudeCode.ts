/**
 * Adapter: Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl)
 * → Trajectory IR.
 *
 * Format notes (empirically verified, the format is not a documented contract):
 * - Each line is a JSON event; `type` is "user" | "assistant" | others we skip.
 * - One API response is often split across SEVERAL assistant lines sharing the
 *   same `requestId` / `message.id`, each repeating the identical `usage`
 *   object. Usage must be counted once per request or costs double-count.
 * - Tool results arrive as user lines whose message.content[] contains
 *   `tool_result` blocks keyed by `tool_use_id`.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Step, ToolCall, Trajectory, Usage } from "../types.js";

interface RawLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

interface ContentSize {
  chars: number;
  images: number;
}

/**
 * Measure result content. Image blocks are counted separately — their base64
 * payload is NOT text tokens (images bill at a roughly fixed visual-token
 * cost), so counting base64 chars/4 would overstate waste by 10-100x.
 */
function contentSize(content: unknown): ContentSize {
  if (content == null) return { chars: 0, images: 0 };
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (Array.isArray(content)) {
    let chars = 0;
    let images = 0;
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "image") {
          images += 1;
        } else if (typeof b.text === "string") {
          chars += b.text.length;
        } else if (typeof b.content === "string") {
          chars += (b.content as string).length;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function canParse(firstLines: string[]): boolean {
  return firstLines.some((l) => {
    try {
      const o = JSON.parse(l);
      return (
        typeof o.sessionId === "string" &&
        (o.type === "user" || o.type === "assistant" || o.type === "queue-operation")
      );
    } catch {
      return false;
    }
  });
}

export function parseClaudeCodeLog(filePath: string): Trajectory {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  // request key -> step under construction
  const stepsByKey = new Map<string, Step>();
  const stepOrder: Step[] = [];
  const callsById = new Map<string, ToolCall>();

  let sessionId = basename(filePath).replace(/\.jsonl$/, "");
  let cwd: string | undefined;
  let version: string | undefined;
  let firstUserMessage: string | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: RawLine;
    try {
      o = JSON.parse(line) as RawLine;
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
        // Usage is identical on every line of the same request — set once.
        const u = m.usage;
        if (u) {
          step.usage = normalizeUsage(u);
        }
        stepsByKey.set(key, step);
        stepOrder.push(step);
      }
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            step.textChars += b.text.length;
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            if (!callsById.has(b.id)) {
              const call: ToolCall = {
                id: b.id,
                name: typeof b.name === "string" ? b.name : "unknown",
                input: b.input,
                inputKey: canonicalJson(b.input ?? null),
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
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const call = callsById.get(b.tool_use_id);
            if (call) {
              const size = contentSize(b.content);
              call.result = {
                isError: b.is_error === true,
                contentChars: size.chars,
                imageCount: size.images,
                timestamp: o.timestamp,
              };
            }
          }
        }
      } else if (typeof content === "string" && !firstUserMessage) {
        const trimmed = content.trim();
        // skip command/meta noise
        if (trimmed && !trimmed.startsWith("<")) {
          firstUserMessage = trimmed.slice(0, 300);
        }
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

function normalizeUsage(u: NonNullable<RawLine["message"]>["usage"]): Usage {
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
