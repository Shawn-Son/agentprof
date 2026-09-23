# agentprof

**Token-waste tracker for Claude Code. Usage and waste in your status line — today, 7 days, 30 days.**

Cost trackers tell you *how much* you spent. `agentprof` tells you *where it leaked*: context that went stale and got re-sent on every request, files read twice, tool output nobody needed, MCP tool definitions you never called, cache misses. Every number is priced in dollars, split into **confirmed** and **estimated**, and rolled up per day.

A real status line, from the author's machine on a Claude Max subscription (2026-09-23):

```
◆ Fable 5.1 │ ctx 4% · avg 37.0K/req │ 5h 76% · resets 12:10pm · 7d 16% │ ≈ today $86.0 · 7d $357 · 30d $1280
◇ waste $14.6 (17%: confirmed 4% + est 13%) ≈ 5h 13% │ tool-out 7% · stale 6% · MCP 3%
```

Read it left to right: this session re-reads 37K tokens per request; the 5h window is 76% used and, at the current burn rate, resets at 12:10pm before it runs out (when it would run out first you see `5h 76% → ~11:30am` instead); today's usage is worth $86 at API prices, of which $14.6 (17%) was waste, 13 points of the 5h window. The three biggest leaks today: oversized tool output, stale context, unused MCP tool definitions. When the current session needs a `/clear` or has unused MCP servers, a hint appears at the end of the second line.

Subscription users see the 5h/7d window as the main indicator; dollars are the API-equivalent reference. API-key users see dollars.

## Install

From any project where you use Claude Code, copy the two files straight from this repo:

```bash
mkdir -p .claude/skills/agentprof/scripts && curl -fsSL https://raw.githubusercontent.com/Shawn-Son/agentprof/main/skills/agentprof/SKILL.md -o .claude/skills/agentprof/SKILL.md && curl -fsSL https://raw.githubusercontent.com/Shawn-Son/agentprof/main/skills/agentprof/scripts/agentprof.mjs -o .claude/skills/agentprof/scripts/agentprof.mjs
```

The skill is **fully self-contained**: the whole engine is one zero-dependency Node script inside the skill folder. Nothing else to install, nothing runs over the network. Requirements: Node 18+ (which Claude Code already needs).

Then, inside Claude Code:

```
/agentprof on        # usage + waste in the status line (two lines, updates after every response)
/agentprof off       # remove it; your previous status line is restored
/agentprof report    # full breakdown: W1–W7, projects, sessions, top leaks
```

`on` copies the engine to `~/.claude/agentprof/` so the status line keeps working in every project. If you already had a status line (ccusage, ccstatusline, your own script), it is kept and shown above agentprof's lines.

Prefer the terminal? The same commands work directly:

```bash
node .claude/skills/agentprof/scripts/agentprof.mjs report
```

## What is counted as waste

| ID | Kind | Rule | Status |
|---|---|---|---|
| W1 | Cache miss | The cached prefix broke *inside* the cache TTL and had to be rewritten (e.g. CLAUDE.md edited or an MCP server toggled mid-session). Counted as the write-minus-read premium, same model only (a deliberate `/model` switch is not a miss). Natural TTL expiry is **not** waste and is reported separately. | confirmed |
| W2 | Duplicate read | The same file range `Read` again with no edit in between (different `offset`/`limit` ranges are not duplicates); identical read-only calls (Grep/Glob/WebFetch…) repeated verbatim. | confirmed |
| W3 | Stale context | Tool results not referenced again for 20 requests, yet re-sent (as cache reads) with every later request until compaction. | estimated |
| W4 | Tool output | The part of a single tool result above 4,000 tokens. | estimated |
| W5 | Filler text | Greetings, progress narration, closing summaries and offers in the assistant's prose. | estimated |
| W6 | Unused MCP tools | MCP tool definitions sent with every request but never called in the session. Deferred tools (loaded on demand) cost nothing and are not counted. | confirmed |
| W7 | Retry tax | Failed tool calls: the error output that entered context plus the output tokens spent emitting the call. | confirmed |

### Habits (reported, not counted as waste)

The harness can tell you how much you spent. It cannot tell you *which of your own habits* drive it. The report adds:

- **Files you read whole** — the share of `Read` calls with no `offset`/`limit`, and the files you read whole most often with the cost of carrying each one in every later request. A whole read is often the right call (editing needs the exact text); the lever is *timing*: read right before you need it, and `/clear` or hand exploration to a subagent once it has served its purpose.
- **Top leak per project** — the waste kind that dominates each project, so the fix can be project-specific (a `CLAUDE.md` rule, an MCP server to disable there).
- **Context per request** — the average prompt size each request re-reads, its distribution (<50K / 50–200K / 200–400K / >400K), the peak, and the number of compactions. On a subscription this is the number that decides when you hit the 5h limit: every request re-reads its whole context as cache reads. The status line shows the current session's average (`avg 185K/req`). Zero compactions is normal on 1M-context models.
- **Rate-limit hits** — every time your 5h/7d window actually ran out, with local time, project and session (Claude Code logs the 429 in the transcript). Together with the projects table this answers "why did I hit the limit yesterday?".
- **Current window forecast** — for subscription users, the 5h/7d burn rate (%/hour, %/day) and the projected time the window runs out. Computed from the usage percentages Claude Code hands the status line after each response; a sample is appended to `state/limits.jsonl` only when the value changes, and samples older than 7 days are pruned on the next refresh.

Each context token belongs to exactly **one** kind (precedence: retry > duplicate > tool output > useful; stale applies to the useful part only), so the kinds never overlap and their sum cannot exceed what you actually paid. Costs are booked on the day of the request that paid them. Waste ratio is **cost-based**: `waste $ / total $`. Confirmed and estimated are always shown separately. Thresholds live in `~/.claude/agentprof/config.json` (`stale_turns`, `tool_output_threshold`, `window_days`, `refresh_seconds`).

## How it works (and why it doesn't slow Claude Code down)

- **No hooks.** Nothing runs in the tool-call path and nothing is injected into the model context. Zero extra tokens per turn.
- **The status line only reads one cached JSON file** (`~/.claude/agentprof/summary.json`) plus the tail of the small limits log. It never parses transcripts. About 25 ms per call.
- **Indexing runs in a detached background process**, at most once every 15 seconds, and only re-parses transcript files whose size or mtime changed. A full first index of 30 days (hundreds of MB) takes a second or two; after that it is milliseconds.
- **Pricing is cache-aware**: input, output, cache writes at 1.25× (5-minute TTL) or 2× (1-hour TTL), cache reads at 0.1×. The TTL is read from each request, since Claude Code uses 1h for subscription sessions and 5m for API-key, subagent and compaction requests. Duplicate log lines per request are deduplicated.

Data layout:

```
~/.claude/agentprof/
├── agentprof.mjs          # engine copy used by the status line
├── summary.json           # today / 7d / 30d rollups (what the status line reads)
├── sessions/<chain>.json  # one record per transcript, with per-day buckets
├── state/index.json       # file → size/mtime, for incremental refresh
├── state/limits.jsonl     # 5h/7d usage samples (subscription only, 7 days, a few KB)
├── config.json            # optional thresholds
└── pricing.json           # optional price overrides: { "model-id": { "input": 5, "output": 25 } }
```

## Honesty policy

Estimated waste depends on thresholds and on ~4 chars/token (images ~1,600 tokens each). Confirmed waste is measured directly from the logs. Prices carry a revision date and can be overridden; unknown model ids are listed, never silently priced at $0. If we can't defend a number, we label it estimated or don't show it.

## Roadmap

`agentprof` is layer one of a three-layer plan:

1. **Profile** *(this repo, today)* — measure, price, and name the waste.
2. **Optimize** — interventions (context pruning, MCP hygiene, output compression) with their savings measured against a baseline. The summary already reserves the schema.
3. **Verify** — every optimization must pass an outcome-equivalence gate: *cost −X%, quality Δ0*, or it auto-reverts.

## What's in this repo

The repo **is** the skill:

```
skills/agentprof/
├── SKILL.md               # the prompt: subcommands, interpretation rules, advice
└── scripts/agentprof.mjs  # the engine: one readable zero-dependency file (source = executable)
package.json               # metadata only; not published to npm yet
```

No build system. To contribute, edit that one file and test with `node skills/agentprof/scripts/agentprof.mjs report`. MIT license.
