#!/usr/bin/env node
/**
 * agentprof CLI
 *
 *   agentprof                 profile the latest session of the current project
 *   agentprof <file.jsonl>    profile one session log
 *   agentprof <dir>           summarize every session in a directory
 *   agentprof --all           summarize every session on this machine
 *   agentprof --list          list recent sessions
 *
 * Options: --out <file>  --open  --json  --top <n>
 */

import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profileSession } from "./analyze.js";
import { parseClaudeCodeLog } from "./parsers/claudeCode.js";
import { renderReport } from "./report.js";
import { startWebServer } from "./web.js";
import { VERSION } from "./version.js";
import type { SessionProfile } from "./types.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const usd = (n: number): string =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

const compact = (n: number): string => {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function findJsonl(dir: string): string[] {
  const out: string[] = [];
  const mtimes = new Map<string, number>();
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) {
        out.push(p);
        mtimes.set(p, st.mtimeMs);
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0));
}

function openInBrowser(target: string): void {
  if (process.platform === "darwin") execFile("open", [target], () => {});
  else if (process.platform === "win32")
    execFile("cmd", ["/c", "start", "", target], () => {});
  else execFile("xdg-open", [target], () => {});
}

function latestSessionForCwd(): string | undefined {
  const dir = join(projectsRoot(), encodeProjectDir(process.cwd()));
  if (!existsSync(dir)) return undefined;
  return findJsonl(dir)[0];
}

function profileFile(file: string): SessionProfile {
  return profileSession(parseClaudeCodeLog(file));
}

function printSummary(p: SessionProfile): void {
  const t = p.trajectory;
  const wastePct = (p.wasteRatio * 100).toFixed(1);
  console.log("");
  console.log(
    `${C.bold}agentprof${C.reset} ${C.dim}·${C.reset} ${t.sessionId.slice(0, 8)} ${C.dim}${t.cwd ?? ""}${C.reset}`,
  );
  if (t.firstUserMessage) {
    console.log(`${C.dim}“${t.firstUserMessage.slice(0, 100)}”${C.reset}`);
  }
  console.log("");
  console.log(
    `  Total cost      ${C.bold}${usd(p.totalCost.total)}${C.reset}  ${C.dim}(${p.stepCosts.length} requests, cache-aware list price)${C.reset}`,
  );
  console.log(
    `  Estimated waste ${C.red}${C.bold}${usd(p.wastedCost)}${C.reset}  ${C.red}${wastePct}% of total${C.reset}`,
  );
  const byKind: Record<string, number> = {};
  for (const f of p.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + f.wastedCost;
  const kinds = [
    ["reread", "rereads", C.yellow],
    ["duplicate-call", "duplicate calls", C.cyan],
    ["retry", "retry tax", C.red],
  ] as const;
  for (const [k, label, color] of kinds) {
    if (byKind[k]) {
      console.log(`    ${color}▸${C.reset} ${label.padEnd(16)} ${usd(byKind[k])}`);
    }
  }
  console.log("");
  const top = p.findings.slice(0, 5);
  if (top.length) {
    console.log(`  ${C.bold}Top leaks${C.reset}`);
    for (const f of top) {
      const tag =
        f.kind === "reread" ? "reread" : f.kind === "retry" ? "retry" : "dup";
      console.log(
        `    ${C.dim}${tag.padEnd(7)}${C.reset}${f.label.slice(0, 70).padEnd(72)} ${f.occurrences}× ${C.bold}${usd(f.wastedCost)}${C.reset}`,
      );
    }
  }
  if (p.unknownModels.length) {
    console.log(
      `\n  ${C.yellow}⚠ unknown model pricing (counted as $0): ${p.unknownModels.join(", ")}${C.reset}`,
    );
  }
}

function printTable(profiles: SessionProfile[], top: number): void {
  const rows = profiles
    .filter((p) => p.totalCost.total > 0)
    .sort((a, b) => b.wastedCost - a.wastedCost)
    .slice(0, top);
  const total = profiles.reduce((n, p) => n + p.totalCost.total, 0);
  const waste = profiles.reduce((n, p) => n + p.wastedCost, 0);
  console.log("");
  console.log(
    `${C.bold}agentprof${C.reset} — ${profiles.length} sessions · total ${C.bold}${usd(total)}${C.reset} · estimated waste ${C.red}${C.bold}${usd(waste)} (${total ? ((waste / total) * 100).toFixed(1) : 0}%)${C.reset}`,
  );
  console.log("");
  console.log(
    `  ${"session".padEnd(10)}${"cost".padStart(9)}${"waste".padStart(9)}${"%".padStart(7)}  ${"steps".padStart(5)}  first prompt`,
  );
  for (const p of rows) {
    const t = p.trajectory;
    const pctS = (p.wasteRatio * 100).toFixed(0) + "%";
    console.log(
      `  ${t.sessionId.slice(0, 8).padEnd(10)}${usd(p.totalCost.total).padStart(9)}${C.red}${usd(p.wastedCost).padStart(9)}${pctS.padStart(7)}${C.reset}  ${String(p.stepCosts.length).padStart(5)}  ${C.dim}${(p.trajectory.firstUserMessage ?? "").slice(0, 48)}${C.reset}`,
    );
  }
  console.log(
    `\n  ${C.dim}Run ${C.reset}agentprof <path-to-session.jsonl>${C.dim} for a full HTML report of one session.${C.reset}`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const getOpt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
      ? args[i + 1]
      : undefined;
  };
  const VALUE_OPTS = new Set(["--out", "--top", "--port"]);
  const positional = args.filter(
    (a, i) => !a.startsWith("-") && !VALUE_OPTS.has(args[i - 1]),
  );

  if (flags.has("--version") || flags.has("-v")) {
    console.log(`agentprof ${VERSION}`);
    return;
  }

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`agentprof — profiler for AI agent sessions

Usage:
  agentprof                    profile the latest session of the current project
  agentprof --project          summarize every session of the current project
  agentprof <file.jsonl>       profile one session log (writes an HTML report)
  agentprof <dir>              summarize every session in a directory
  agentprof --all              summarize every session on this machine
  agentprof init               install the /agentprof skill into this project
  agentprof web                live local dashboard (optional, machine-wide)
  agentprof web <dir>          monitor a specific directory only
  agentprof --list             list recent sessions

Options:
  --out <file>   where to write the HTML report (default: ./agentprof-report.html)
  --open         open the report/dashboard in your browser
  --json         print the profile as JSON instead
  --port <n>     web monitor port (default 4040)
  --top <n>      rows to show in summary tables (default 20)`);
    return;
  }

  if (positional[0] === "init") {
    // Locate the packaged skill folder (SKILL.md + bundled engine). Works from
    // the npm package (dist/cli.js → ../skills/agentprof) and from a copy of
    // the bundled engine already living inside a skill folder (scripts/ → ..).
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", "skills", "agentprof"), join(here, "..")];
    const source = candidates.find((d) => existsSync(join(d, "SKILL.md")));
    if (!source) {
      console.error(`${C.red}could not locate the skill source folder${C.reset}`);
      process.exitCode = 1;
      return;
    }
    const dir = resolve(".claude", "skills", "agentprof");
    mkdirSync(dir, { recursive: true });
    cpSync(source, dir, { recursive: true });
    console.log(
      `${C.green}✓${C.reset} installed skill (with bundled engine) → ${dir}\n` +
        `  In Claude Code, run ${C.bold}/agentprof usage${C.reset} or ${C.bold}/agentprof waste${C.reset}.\n` +
        `  Commit the folder to share it with your team.`,
    );
    return;
  }

  if (positional[0] === "web") {
    const scope = positional[1] ? resolve(positional[1]) : projectsRoot();
    if (!existsSync(scope)) {
      console.error(`${C.red}not found:${C.reset} ${scope}`);
      process.exitCode = 1;
      return;
    }
    const port = Number(getOpt("--port") ?? 4040);
    startWebServer(() => findJsonl(scope), port);
    if (flags.has("--open")) openInBrowser(`http://localhost:${port}`);
    return;
  }

  if (flags.has("--list")) {
    const files = findJsonl(projectsRoot()).slice(0, Number(getOpt("--top") ?? 20));
    for (const f of files) {
      const st = statSync(f);
      console.log(`${st.mtime.toISOString().slice(0, 16)}  ${f}`);
    }
    return;
  }

  let targets: string[] = [];
  let aggregate = false;
  if (flags.has("--all")) {
    aggregate = true;
    targets = findJsonl(projectsRoot());
  } else if (flags.has("--project")) {
    aggregate = true;
    const dir = join(projectsRoot(), encodeProjectDir(process.cwd()));
    if (!existsSync(dir)) {
      console.error(
        `${C.yellow}No session logs found for this project.${C.reset}\nLooked in ${dir}`,
      );
      process.exitCode = 1;
      return;
    }
    targets = findJsonl(dir);
  } else if (positional.length > 0) {
    for (const arg of positional) {
      const p = resolve(arg);
      if (!existsSync(p)) {
        console.error(`${C.red}not found:${C.reset} ${p}`);
        process.exitCode = 1;
        return;
      }
      if (statSync(p).isDirectory()) {
        aggregate = true;
        targets.push(...findJsonl(p));
      } else targets.push(p);
    }
  } else {
    const latest = latestSessionForCwd();
    if (!latest) {
      console.error(
        `${C.yellow}No session logs found for this project.${C.reset}\n` +
          `Looked in ${join(projectsRoot(), encodeProjectDir(process.cwd()))}\n` +
          `Try: agentprof --all   or   agentprof <path-to-session.jsonl>`,
      );
      process.exitCode = 1;
      return;
    }
    targets = [latest];
  }

  if (targets.length === 0) {
    console.error(`${C.yellow}No .jsonl session logs found.${C.reset}`);
    process.exitCode = 1;
    return;
  }

  if (targets.length === 1 && !aggregate) {
    const profile = profileFile(targets[0]);
    if (flags.has("--json")) {
      console.log(
        JSON.stringify(
          {
            sessionId: profile.trajectory.sessionId,
            totalCost: profile.totalCost,
            wastedCost: profile.wastedCost,
            wasteRatio: profile.wasteRatio,
            findings: profile.findings,
            toolStats: profile.toolStats,
          },
          null,
          2,
        ),
      );
      return;
    }
    printSummary(profile);
    const out = resolve(getOpt("--out") ?? "agentprof-report.html");
    writeFileSync(out, renderReport(profile));
    console.log(`\n  ${C.green}⤷ report:${C.reset} ${out}\n`);
    if (flags.has("--open")) openInBrowser(out);
  } else {
    const profiles: SessionProfile[] = [];
    for (const f of targets) {
      try {
        profiles.push(profileFile(f));
      } catch {
        // unreadable/foreign log — skip
      }
    }
    if (flags.has("--json")) {
      const totalCost = profiles.reduce((n, p) => n + p.totalCost.total, 0);
      const wastedCost = profiles.reduce((n, p) => n + p.wastedCost, 0);
      console.log(
        JSON.stringify(
          {
            sessions: profiles.length,
            totalCost,
            wastedCost,
            wasteRatio: totalCost > 0 ? wastedCost / totalCost : 0,
            perSession: profiles.map((p) => ({
              sessionId: p.trajectory.sessionId,
              file: p.trajectory.filePath,
              firstUserMessage: p.trajectory.firstUserMessage,
              steps: p.stepCosts.length,
              totalCost: p.totalCost.total,
              wastedCost: p.wastedCost,
              wasteRatio: p.wasteRatio,
              topFindings: p.findings.slice(0, 3),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    printTable(profiles, Number(getOpt("--top") ?? 20));
  }
}

main();
