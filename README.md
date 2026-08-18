# agentprof

**A profiler for AI agent sessions. See where your money went — and how much of it was waste.**

Coding agents like Claude Code burn tokens in ways no dashboard shows you: the same file read twice, a failed command retried five times, a context window that snowballs until every single request re-pays for 800K tokens of history. Cost trackers tell you *how much* you spent. `agentprof` tells you *where it leaked*.

## Install

From your project root (any project where you use Claude Code), run **one** of these — both produce the identical skill folder:

```bash
# with npm
npx -y agentprof init
```

```bash
# without npm — copy the two files straight from this repo
mkdir -p .claude/skills/agentprof/scripts && curl -fsSL https://raw.githubusercontent.com/Shawn-Son/agentprof/main/skills/agentprof/SKILL.md -o .claude/skills/agentprof/SKILL.md && curl -fsSL https://raw.githubusercontent.com/Shawn-Son/agentprof/main/skills/agentprof/scripts/agentprof.mjs -o .claude/skills/agentprof/scripts/agentprof.mjs
```

The skill is **fully self-contained** — the entire profiler engine (one zero-dependency 45KB script) ships inside the skill folder, so there is nothing else to install and nothing runs over the network. Requirements: Node 18+ (which Claude Code already needs).

Then, inside Claude Code:

```
/agentprof usage     # how much has this project cost, per session
/agentprof waste     # where money leaked, with dollar amounts and fixes
/agentprof report    # full HTML report for the latest session
```

Claude profiles **this project's** sessions — never the whole machine — and answers with headline numbers first.

**Share it with your team** by committing the folder — everyone who clones the project gets `/agentprof` automatically:

```bash
git add .claude/skills/agentprof && git commit -m "Add agentprof skill"
```

## Update

The skill never updates itself (no auto-update, no network calls). To update, **re-run the same install command you used above** — it overwrites the skill folder in place with the latest version. Your project code is untouched.

```bash
npx -y agentprof@latest init      # npm path
```

…or re-run the curl command from Install. Check which version you have:

```bash
node .claude/skills/agentprof/scripts/agentprof.mjs --version
```

On a team, one person updates and commits the folder; everyone else gets it on `git pull`. To uninstall, delete `.claude/skills/agentprof/`.

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

`agentprof init` drops the whole skill — instructions **and** the bundled engine — into `.claude/skills/agentprof/`:

```
.claude/skills/agentprof/
├── SKILL.md               # when to trigger + how Claude interprets results
└── scripts/agentprof.mjs  # the entire profiler, one zero-dependency script
```

From then on anyone on the project can run `/agentprof usage` or `/agentprof waste` (or just ask *"how much has this project cost?"*) — Claude runs the bundled engine (project-scoped, `node`-only, offline), reads the JSON, and answers with the headline numbers, the top leaks, and what to do about them. Commit the folder so your whole team gets it.

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
