/**
 * The Claude Code skill installed into a user's project by `agentprof init`.
 * Keep in sync with skills/agentprof/SKILL.md (repo copy for browsing).
 */

export const SKILL_MD = `---
name: agentprof
description: Check this project's Claude Code usage cost and waste. Use when the user asks where their tokens or money went, how expensive this project or session has been, whether the agent wasted tokens (re-reads, retries, duplicate calls), says "usage", "cost", "waste", or invokes /agentprof.
---

# agentprof — project usage & waste profiler

agentprof analyzes THIS project's Claude Code session logs and reports where
money went and how much was wasted. Scope is always the current project (the
logs under ~/.claude/projects that belong to this working directory) — never
the whole machine. Everything runs locally.

## Commands

\`\`\`bash
npx -y agentprof --project --json    # every session of THIS project (default scope for questions about "this project")
npx -y agentprof --json              # latest session only
npx -y agentprof <file.jsonl>        # one specific session → terminal summary + HTML report
\`\`\`

## Workflow

1. Pick the scope from the user's question: whole project (\`--project\`) or
   just the latest/current session (no flag). Default to \`--project\` when
   they ask about "this project" or overall usage.
2. Run with \`--json\` and read the output. Key fields:
   - \`totalCost\` — dollars at list price, cache-aware (input / output / cacheRead / cacheWrite).
   - \`wastedCost\`, \`wasteRatio\` — estimated waste and its share of total.
   - \`findings[]\` / \`topFindings[]\` — each leak: \`kind\` (\`reread\` | \`duplicate-call\` | \`retry\`), \`label\` (file/tool), \`occurrences\`, \`wastedTokens\`, \`wastedCost\`.
   - \`toolStats[]\` — per-tool calls, errors, and estimated context cost.
3. Answer with the headline first: total project cost, waste $ and %, then the
   top 3 concrete leaks with dollar amounts. Keep it short. Offer the HTML
   report for a single session (\`agentprof <file> --open\`) if they want detail.

## Interpreting results honestly

- Waste figures are **estimates with a published formula**: tokens × input
  price × (1.25 cache-write + 0.1 × each later request re-reading them).
  Say "estimated" when quoting them.
- Low waste % is common — the dominant cost in long sessions is usually the
  context snowball (context carried into every request), not discrete mistakes.
  If one session dominates cost with modest waste, say that.
- The currently running session's numbers grow as it continues.

## Actionable advice to pair with findings

- Big \`reread\` findings → keep notes in a scratchpad instead of re-reading
  large files; read specific line ranges.
- High \`retry\` tax on Bash → record failing command patterns in CLAUDE.md so
  future sessions avoid them.
- One giant expensive session → start fresh sessions per task; use subagents
  for exploration so results don't bloat the main context.
`;
