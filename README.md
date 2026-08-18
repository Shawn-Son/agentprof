# agentprof

**A profiler for AI agent sessions. See where your money went — and how much of it was waste.**

Coding agents like Claude Code burn tokens in ways no dashboard shows you: the same file read twice, a failed command retried five times, a context window that snowballs until every single request re-pays for 800K tokens of history. Cost trackers tell you *how much* you spent. `agentprof` tells you *where it leaked*.

```bash
npx agentprof            # profile your latest Claude Code session
npx agentprof --all      # every session on this machine
npx agentprof web        # live dashboard of all sessions → http://localhost:4040
```

No account. No API key. No instrumentation. It reads the session logs already sitting on your disk (`~/.claude/projects/**/*.jsonl`) and produces a terminal summary plus a self-contained HTML report.

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
agentprof                          # latest session of the current project
agentprof path/to/session.jsonl    # one session → HTML report
agentprof ~/.claude/projects/…/    # every session in a directory (summary table)
agentprof --all                    # everything on this machine
agentprof --json                   # machine-readable output
agentprof --open                   # open the HTML report in your browser
agentprof web [--port 4040]        # live local dashboard (auto-refreshes)
```

## Live monitor

`agentprof web` serves a dashboard on `127.0.0.1` — every session on the machine, sorted by recency, with cost/waste columns, a green pulse on sessions active in the last 5 minutes, and click-through to full per-session reports. It auto-reloads when any session log changes, so you can keep it open on a second screen while your agents work. Nothing ever leaves your machine.

## Claude Code skill

Prefer asking Claude instead of running a CLI? Install the bundled skill:

```bash
mkdir -p ~/.claude/skills && cp -r skills/agentprof ~/.claude/skills/
```

Then, inside any Claude Code session: `/agentprof` — or just ask *"where did my money go this session?"* Claude runs the profiler and explains the leaks with concrete suggestions.

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
