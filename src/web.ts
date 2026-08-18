/**
 * `agentprof web` — local live dashboard. Zero dependencies: a plain
 * node:http server that re-scans session logs on demand (cached by mtime),
 * serves an aggregate index and per-session reports, and auto-refreshes.
 * Binds to 127.0.0.1 only; nothing ever leaves the machine.
 */

import { createServer } from "node:http";
import { statSync } from "node:fs";
import { profileSession } from "./analyze.js";
import { parseClaudeCodeLog } from "./parsers/claudeCode.js";
import { renderReport } from "./report.js";
import type { SessionProfile } from "./types.js";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const usd = (n: number): string =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

const compact = (n: number): string => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

interface CacheEntry {
  mtimeMs: number;
  profile: SessionProfile;
}

const cache = new Map<string, CacheEntry>();

function profileCached(file: string): SessionProfile | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.profile;
  try {
    const profile = profileSession(parseClaudeCodeLog(file));
    cache.set(file, { mtimeMs, profile });
    return profile;
  } catch {
    return undefined;
  }
}

interface SessionRow {
  file: string;
  mtimeMs: number;
  profile: SessionProfile;
}

function collectRows(discover: () => string[]): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const file of discover()) {
    const profile = profileCached(file);
    if (!profile || profile.totalCost.total === 0) continue;
    rows.push({ file, mtimeMs: statSync(file).mtimeMs, profile });
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function stateStamp(rows: SessionRow[]): string {
  return rows.map((r) => `${r.file}:${r.mtimeMs}`).join("|");
}

function renderIndex(rows: SessionRow[]): string {
  const total = rows.reduce((n, r) => n + r.profile.totalCost.total, 0);
  const waste = rows.reduce((n, r) => n + r.profile.wastedCost, 0);
  const tokensIn = rows.reduce(
    (n, r) =>
      n +
      r.profile.totalUsage.inputTokens +
      r.profile.totalUsage.cacheReadTokens +
      r.profile.totalUsage.cacheWrite5mTokens +
      r.profile.totalUsage.cacheWrite1hTokens,
    0,
  );
  const now = Date.now();

  const tr = rows
    .map((r) => {
      const p = r.profile;
      const t = p.trajectory;
      const live = now - r.mtimeMs < 5 * 60 * 1000;
      const age = now - r.mtimeMs;
      const ageStr =
        age < 3600e3
          ? Math.max(1, Math.round(age / 60e3)) + "m ago"
          : age < 86400e3
            ? Math.round(age / 3600e3) + "h ago"
            : Math.round(age / 86400e3) + "d ago";
      const wastePct =
        p.totalCost.total > 0 ? ((p.wasteRatio * 100).toFixed(0) + "%") : "—";
      return `<tr onclick="location='/session?f=${encodeURIComponent(r.file)}'">
        <td>${live ? '<span class="live"></span>' : ""}<span class="mono">${esc(t.sessionId.slice(0, 8))}</span></td>
        <td class="proj mono">${esc((t.cwd ?? "").split("/").slice(-2).join("/"))}</td>
        <td class="prompt-cell">${esc((t.firstUserMessage ?? "").slice(0, 72))}</td>
        <td class="num">${p.stepCosts.length}</td>
        <td class="num">${compact(p.totalUsage.outputTokens)}</td>
        <td class="num cost">${usd(p.totalCost.total)}</td>
        <td class="num waste">${usd(p.wastedCost)} <span class="dim">${wastePct}</span></td>
        <td class="num dim">${ageStr}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentprof monitor</title>
<style>
  :root { --bg:#0b0e14; --panel:#12161f; --border:#1f2633; --text:#e6e9ef; --dim:#8b94a7; --waste:#ef4444; --live:#22c55e; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; padding:32px 24px 64px; max-width:1160px; margin:0 auto; }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:12.5px; }
  h1 { font-size:20px; letter-spacing:-0.02em; } h1 b { color:#60a5fa; }
  .sub { color:var(--dim); margin-top:4px; font-size:13px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:20px 0; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:0.06em; }
  .card .v { font-size:24px; font-weight:650; margin-top:4px; }
  .card.w .v { color:var(--waste); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th { text-align:left; color:var(--dim); font-size:11.5px; text-transform:uppercase; letter-spacing:0.05em; padding:10px 10px; border-bottom:1px solid var(--border); }
  td { padding:9px 10px; border-bottom:1px solid var(--border); }
  tr:last-child td { border-bottom:none; }
  tbody tr { cursor:pointer; } tbody tr:hover { background:#ffffff08; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .cost { font-weight:600; } .waste { color:var(--waste); }
  .dim { color:var(--dim); font-size:12px; }
  .proj { color:var(--dim); white-space:nowrap; }
  .prompt-cell { color:#c9d1de; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .live { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--live); margin-right:7px; animation:pulse 1.6s infinite; vertical-align:1px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  footer { color:var(--dim); font-size:12px; margin-top:20px; }
</style>
</head>
<body>
<h1><b>agentprof</b> · live monitor</h1>
<div class="sub">${rows.length} sessions · auto-refreshes when logs change · <span class="live"></span>= active in the last 5 min</div>
<div class="cards">
  <div class="card"><div class="k">Total spend</div><div class="v">${usd(total)}</div></div>
  <div class="card w"><div class="k">Estimated waste</div><div class="v">${usd(waste)}</div></div>
  <div class="card"><div class="k">Tokens in</div><div class="v">${compact(tokensIn)}</div></div>
  <div class="card"><div class="k">Sessions</div><div class="v">${rows.length}</div></div>
</div>
<table>
  <thead><tr><th>Session</th><th>Project</th><th>First prompt</th><th>Steps</th><th>Out tok</th><th>Cost</th><th>Waste</th><th>Last active</th></tr></thead>
  <tbody>${tr}</tbody>
</table>
<footer>agentprof — measure, optimize, prove. Data never leaves this machine.</footer>
<script>
  let stamp = null;
  async function poll() {
    try {
      const r = await fetch("/api/stamp");
      const s = await r.text();
      if (stamp === null) stamp = s;
      else if (s !== stamp) location.reload();
    } catch {}
    setTimeout(poll, 5000);
  }
  poll();
</script>
</body>
</html>`;
}

export function startWebServer(discover: () => string[], port: number): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderIndex(collectRows(discover)));
      } else if (url.pathname === "/api/stamp") {
        const rows = discover().map((f) => {
          try {
            return `${f}:${statSync(f).mtimeMs}`;
          } catch {
            return f;
          }
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(rows.join("|"));
      } else if (url.pathname === "/session") {
        const file = url.searchParams.get("f") ?? "";
        const allowed = new Set(discover());
        if (!allowed.has(file)) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("unknown session");
          return;
        }
        const profile = profileCached(file);
        if (!profile) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("could not parse session");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          renderReport(profile).replace(
            "<header>",
            `<header><div style="margin-bottom:10px"><a href="/" style="color:#60a5fa;text-decoration:none;font-size:13px">← all sessions</a></div>`,
          ),
        );
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`agentprof monitor → http://localhost:${port}`);
  });
}

export function stateStampFor(discover: () => string[]): string {
  return stateStamp(collectRows(discover));
}
