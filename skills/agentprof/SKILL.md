---
name: agentprof
description: Track Claude Code token waste. Use when the user invokes /agentprof with a subcommand (on, off, report), or asks where their tokens or money went, how much they spent today / this week / this month, or whether the agent wasted tokens (stale context, re-reads, oversized tool output, unused MCP tools, cache misses).
---

# agentprof — token-waste tracker for Claude Code

agentprof reads the transcripts Claude Code already writes to
`~/.claude/projects/**/*.jsonl`, prices every request, and separates
**waste** (W1–W7 below) from useful spend, rolled up per day for
**today / 7d / 30d** across all of the user's projects. Everything runs
locally; nothing leaves the machine.

The entire engine ships inside this skill at `scripts/agentprof.mjs`
(zero dependencies, plain Node). Run it with `node`.

**ENGINE path:** use whichever of these exists (check project first):

- `.claude/skills/agentprof/scripts/agentprof.mjs` (project install)
- `~/.claude/skills/agentprof/scripts/agentprof.mjs` (user-level install)
- `~/.claude/agentprof/agentprof.mjs` (the copy `on` installs; always present once the status line was turned on)

Every command below writes `<ENGINE>` for that path.

## Subcommands

| Subcommand | What to do |
|---|---|
| `/agentprof on` | Run `node <ENGINE> on`. Show its output verbatim. This adds two lines to the Claude Code status line (usage today/7d/30d and today's waste). The engine copies itself to `~/.claude/agentprof/` so the status line works in every project, and keeps any status line the user already had (shown above ours). |
| `/agentprof off` | Run `node <ENGINE> off`. Show its output verbatim. Restores the previous status line. |
| `/agentprof report` | Run `node <ENGINE> report`. Print the output **verbatim in a code block** — it is already formatted. Then add at most 3 short sentences: the single biggest waste source and the one action that fixes it. Do not re-summarize the tables. |
| `/agentprof` (bare) or anything else | List the three subcommands in one line each, then run `report`. |

Natural-language questions map to `report`: "how much did I spend this
week?", "where did my tokens go?", "did the agent waste tokens?".

Never read or summarize the raw JSON (`--json`) unless the user asks for
machine-readable output — the engine's text report exists so that this
skill costs almost no tokens.

## What the numbers mean

- **Confirmed waste** (W1 cache miss, W2 duplicate read, W6 unused MCP
  tool definitions, W7 retry tax) is measured directly from the logs.
- **Estimated waste** (W3 stale context, W4 oversized tool output, W5
  filler text) depends on thresholds (`stale_turns` 20, `tool_output_threshold`
  4,000 tokens) and on ~4 chars/token. Always say "estimated" when quoting it.
- **Cache expiry** is *not* waste: the cache TTL simply elapsed between
  requests. It is shown separately as an opportunity cost.
- For subscription users the dollar figures are the API-equivalent value,
  not a bill; the status line shows the 5h/7d limit percentages as the
  main indicator.
- Unknown model ids are listed, never priced at $0.

## Habits (shown in the report, not counted as waste)

- **Files you read whole**: how many `Read` calls had no `offset`/`limit`,
  and which files were read whole most often with what it cost to *carry*
  them in every later request. A whole read is often legitimate (editing
  needs the exact text). The lever is timing, not avoidance: read right
  before the file is needed, and `/clear` or delegate to a subagent once
  it has served its purpose. A one-line rule in the project's CLAUDE.md
  ("Grep first, then Read with offset/limit; whole-file exploration goes
  to a subagent") fixes the habit for good.
- **Projects table → top leak**: the waste kind that dominates each
  project, so the advice below can be given per project.
- **Context per request**: the average prompt size every request re-reads
  (input + cache read + cache write), its distribution, and how many
  compactions happened. For subscription users this is *the* number: the
  5h window drains in proportion to it. The status line shows the current
  session's average as `avg 185K/req`. Zero compactions is normal on 1M
  context models; a session with several compactions is one to split.

## Actionable advice to pair with findings

- **stale context** dominates → `/clear` (or a fresh session) after a task
  is finished; use subagents for exploration so results don't sit in the
  main context.
- **tool output** → read specific line ranges; pipe long commands through
  `head`/`grep`; ask for `--quiet` output.
- **unused MCP tools** → disable MCP servers you don't use in this project
  (their definitions are re-sent on every request).
- **duplicate read** → keep notes instead of re-reading large files.
- **cache miss** → avoid editing CLAUDE.md or toggling MCP servers
  mid-session; each breaks the cached prefix.
- **retry tax** → record failing command patterns in CLAUDE.md.

Configuration (optional): `~/.claude/agentprof/config.json` with any of
`stale_turns`, `tool_output_threshold`, `window_days`, `refresh_seconds`;
`~/.claude/agentprof/pricing.json` to add or override model prices.
