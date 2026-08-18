---
name: agentprof
description: Profile Claude Code session cost and waste. Use when the user asks where their tokens or money went, how expensive a session was, whether the agent wasted tokens (re-reads, retries, duplicate calls), asks to "profile this session", or invokes /agentprof. Also use to start the live cost monitor dashboard.
---

# agentprof — session cost & waste profiler

agentprof analyzes Claude Code session logs (`~/.claude/projects/**/*.jsonl`) and reports where money went and how much was wasted. Everything runs locally.

## Commands

Run via npx (no install needed):

```bash
npx -y agentprof --json          # latest session of the current project, machine-readable
npx -y agentprof --all           # summary table of every session on this machine
npx -y agentprof <file.jsonl>    # one session → terminal summary + HTML report
npx -y agentprof web --open      # live dashboard at http://localhost:4040
```

If npx cannot find the package (offline / not yet published), clone and build:
`git clone https://github.com/Shawn-Son/agentprof && cd agentprof && npm i && npm run build && node dist/cli.js --json`

## Workflow

1. Decide the scope from the user's request: current/latest session (default), a specific session, or all sessions.
2. Run with `--json` and read the output. Key fields:
   - `totalCost` — dollars at list price, cache-aware (input / output / cacheRead / cacheWrite).
   - `wastedCost`, `wasteRatio` — estimated waste and its share of total.
   - `findings[]` — each leak: `kind` (`reread` | `duplicate-call` | `retry`), `label` (file/tool), `occurrences`, `wastedTokens`, `wastedCost`.
   - `toolStats[]` — per-tool calls, errors, and estimated context cost.
3. Report to the user, leading with the headline: total cost, waste $ and %, and the top 3 concrete leaks with dollar amounts. Keep it short; offer the HTML report (`--out`, `--open`) or the web monitor for a visual view.
4. When asked for the dashboard/monitor, run `npx -y agentprof web --open` in the background and tell the user the URL.

## Interpreting results honestly

- Waste figures are **estimates with a published formula**: tokens × input price × (1.25 cache-write + 0.1 × each later request re-reading them). Say "estimated" when quoting them.
- Low waste % is common and fine — the dominant cost in long sessions is usually the context snowball (visible in the HTML report), not discrete mistakes.
- If the profiled session is the *currently running* one, note that numbers grow as the session continues.

## Actionable advice to pair with findings

- Big `reread` findings → suggest keeping notes in a scratchpad instead of re-reading large files, or reading specific line ranges.
- High `retry` tax on Bash → suggest verifying commands (paths, flags) before running, or adding project docs/CLAUDE.md notes for failing patterns.
- A steep context snowball with a costly tail → suggest starting fresh sessions for new tasks instead of continuing one giant session, and using subagents for exploration so results don't bloat the main context.
