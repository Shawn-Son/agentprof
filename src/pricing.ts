/**
 * Per-token pricing (USD per million tokens), Anthropic list prices.
 * Cache multipliers per Anthropic docs: 5m write = 1.25x input,
 * 1h write = 2x input, cache read = 0.1x input.
 *
 * Prices last synced: 2026-08-18.
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
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

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

/**
 * Resolve a model id (possibly date-suffixed, e.g.
 * "claude-haiku-4-5-20251001") to a price entry. Returns undefined for
 * unknown/synthetic models so callers can surface them instead of silently
 * pricing at zero.
 */
export function priceFor(model: string): ModelPrice | undefined {
  if (!model || model === "<synthetic>") return undefined;
  if (PRICES[model]) return PRICES[model];
  // strip trailing date suffix like -20251001
  const stripped = model.replace(/-\d{8}$/, "");
  if (PRICES[stripped]) return PRICES[stripped];
  // longest-prefix match as a last resort
  let best: string | undefined;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? PRICES[best] : undefined;
}
