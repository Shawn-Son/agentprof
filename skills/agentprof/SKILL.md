---
name: agentprof
description: Check this project's Claude Code usage cost and waste. Use when the user invokes /agentprof with a subcommand (usage, waste, report), or asks where their tokens or money went, how expensive this project or session has been, or whether the agent wasted tokens (re-reads, retries, duplicate calls).
---

# agentprof — project usage & waste profiler

agentprof analyzes THIS project's Claude Code session logs and reports where
money went and how much was wasted. Scope is always the current project (the
logs under ~/.claude/projects that belong to this working directory) — never
the whole machine. Everything runs locally.

The full profiler engine ships inside this skill at
`scripts/agentprof.mjs` (zero dependencies, plain Node). Run it with `node`;
no install or network is required.

## Subcommands

The skill is invoked with a subcommand: `/agentprof <subcommand>`.

| Subcommand | What to do |
|---|---|
| `/agentprof usage` | Report project spend: total cost, cost breakdown (input / output / cache read / cache write), tokens, per-session costs. |
| `/agentprof waste` | Report estimated waste: waste $ and % of total, top leaks (rereads, duplicate calls, retry tax) with dollar amounts, and concrete advice. |
| `/agentprof report` | Generate the HTML report for the latest session and open it: `node .claude/skills/agentprof/scripts/agentprof.mjs --open` |
| `/agentprof` (bare) or anything else | Briefly list the subcommands above, then give a one-line combined summary (total cost + waste %). |

Natural-language questions map to the same flows: "how much has this project
cost?" → usage; "did the agent waste tokens?" → waste.

## Commands

```bash
node .claude/skills/agentprof/scripts/agentprof.mjs --project --json    # every session of THIS project (default data source)
node .claude/skills/agentprof/scripts/agentprof.mjs --json              # latest session only
node .claude/skills/agentprof/scripts/agentprof.mjs --open              # latest session → HTML report in the browser
```

Run from the project root (where `.claude/` lives).

## Workflow

1. Run the `--project --json` command above (use the latest-session form only
   when the user explicitly asks about the current/latest session).
2. Read the JSON. Key fields:
   - `totalCost`, `sessions`, `perSession[]` — cost per session with `firstUserMessage`, `steps`.
   - `wastedCost`, `wasteRatio` — estimated waste and its share of total.
   - `perSession[].topFindings[]` — each leak: `kind` (`reread` | `duplicate-call` | `retry`), `label` (file/tool), `occurrences`, `wastedTokens`, `wastedCost`.
3. Answer with the headline first, then details. Keep it short.
   - **usage**: total project cost, then the 3-5 most expensive sessions (cost, steps, first prompt).
   - **waste**: waste $ and %, then the top 3 leaks with dollar amounts and one-line fixes.

## Interpreting results honestly

- Waste figures are **estimates with a published formula**: tokens × input
  price × (1.25 cache-write + 0.1 × each later request re-reading them).
  Say "estimated" when quoting them.
- Low waste % is common — the dominant cost in long sessions is usually the
  context snowball (context carried into every request), not discrete mistakes.
  If one session dominates cost with modest waste, say that.
- The currently running session's numbers grow as it continues.

## Actionable advice to pair with findings

- Big `reread` findings → keep notes in a scratchpad instead of re-reading
  large files; read specific line ranges.
- High `retry` tax on Bash → record failing command patterns in CLAUDE.md so
  future sessions avoid them.
- One giant expensive session → start fresh sessions per task; use subagents
  for exploration so results don't bloat the main context.
