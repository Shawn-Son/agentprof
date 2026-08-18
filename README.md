# agentprof

**A profiler for AI agent sessions. See where your money went — and how much of it was waste.**

Coding agents like Claude Code burn tokens in ways no dashboard shows you: the same file read twice, a failed command retried five times, a context window that snowballs until every single request re-pays for 800K tokens of history. Cost trackers tell you *how much* you spent. `agentprof` tells you *where it leaked*.

```bash
npx -y agentprof init         # install the /agentprof skill into your project
```

Then, inside Claude Code:

```
/agentprof usage     # how much has this project cost, per session
/agentprof waste     # where money leaked, with dollar amounts and fixes
/agentprof report    # full HTML report for the latest session
```

Claude profiles **this project's** sessions — never the whole machine — and answers with headline numbers first.

Prefer the terminal?

```bash
npx agentprof --project  # every session of the current project
npx agentprof            # just the latest session (+ HTML report)
```

No account. No API key. No instrumentation. It reads the session logs already sitting on your disk (`~/.claude/projects/**/*.jsonl`), scoped to your project, and produces a terminal summary plus a self-contained HTML report. Nothing leaves your machine.

## What you get

- **Cache-aware cost attribution** — every request priced with real list prices: input, output, cache writes (1.25×/2×), cache reads (0.1×). Duplicate log lines per request are deduped so nothing double-counts.
- **Context Snowball chart** — tokens carried into each request over the session, with compaction cliffs visible. This is usually where the money actually goes.
- **Waste detection** with dollars attached:
  - **Rereads** — the same file read again with no edit in between. Re-reads after the file changed are *not* counted.
  - **Duplicate calls** — identical read-only tool calls (Grep/Glob/WebFetch/…) repeated verbatim. Stateful tools like Bash are deliberately excluded.
  - **Retry Tax** — failed tool calls: the error output that entered context, plus the output tokens spent emitting the doomed call.

## Honesty policy

Every waste dollar is an **estimate with a published formula**, and the detectors are deliberately conservative:

```
waste($) = tokens × input_price × (1.25 cache-write + 0.1 × each later request that re-reads them)
```

Text tokens are estimated at 4 chars/token; images at a flat ~1,600 visual tokens (their base64 length is *not* counted — that would overstate waste 10–100×). Unknown models are surfaced, not silently priced at zero. If we can't defend a number, we don't show it.

## Usage

```bash
agentprof init                     # install the /agentprof skill into this project
agentprof --project                # every session of the current project
agentprof                          # latest session of the current project
agentprof path/to/session.jsonl    # one session → HTML report
agentprof ~/.claude/projects/…/    # every session in a directory (summary table)
agentprof --all                    # everything on this machine
agentprof --json                   # machine-readable output
agentprof --open                   # open the HTML report in your browser
agentprof web [--port 4040]        # optional: live local dashboard (auto-refreshes)
```

## The skill (recommended)

`agentprof init` drops `.claude/skills/agentprof/SKILL.md` into your project. From then on anyone on the project can run `/agentprof usage` or `/agentprof waste` (or just ask *"how much has this project cost?"*) — Claude runs the profiler (project-scoped), reads the JSON, and answers with the headline numbers, the top leaks, and what to do about them. Commit the skill file so your whole team gets it.

To install it user-wide instead (works in every project): `mkdir -p ~/.claude/skills && cp -r skills/agentprof ~/.claude/skills/`

## Live monitor (optional)

`agentprof web` serves a dashboard on `127.0.0.1` — sessions sorted by recency with cost/waste columns, a green pulse on sessions active in the last 5 minutes, and click-through to full per-session reports. It auto-reloads when any session log changes. Pass a directory to scope it (e.g. your project's log dir); default is machine-wide.

## Roadmap

`agentprof` is layer one of a three-layer plan:

1. **Profile** *(this repo, today)* — measure trajectories, attribute cost, name the waste.
2. **Optimize** — compiler-style passes: dedup caching, context pruning, step routing to smaller models, workflow distillation.
3. **Verify** — every optimization must pass an outcome-equivalence gate: *cost −X%, quality Δ0*, or it auto-reverts. Savings claims without quality proof are marketing; ours ship with receipts.

Trajectory parsing is adapter-based (Claude Code today; Codex/Gemini CLI/OpenTelemetry GenAI traces welcome — the analyzers only see a neutral IR).

## Development

```bash
npm install
npm run build
node dist/cli.js --all
```

Zero runtime dependencies. MIT license.
