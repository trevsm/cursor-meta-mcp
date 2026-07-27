#!/usr/bin/env node
/**
 * Local fleet visibility dashboard.
 *
 *   npm run dashboard
 *   npm run dashboard -- --port 3847 --workspace cursor-meta-mcp
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  collectDashboardSnapshot,
  defaultExperimentsDir,
  tailFile,
} from "../src/dashboard.js";
import { launchSelfImproveFleet } from "../src/self-improve.js";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number.parseInt(argValue("--port") ?? process.env.CURSOR_META_DASHBOARD_PORT ?? "3847", 10);
const host = argValue("--host") ?? "127.0.0.1";
const workspace = argValue("--workspace") ?? "cursor-meta-mcp";
const metaDir = argValue("--meta-dir") ?? join(homedir(), ".cursor-meta");
const experimentsDir = join(metaDir, "experiments");
const fleetCwd = argValue("--cwd") ?? join(homedir(), "Projects", "cursor-meta-mcp");

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function dashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>cursor-meta fleet</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1117;
      --panel: #171a22;
      --border: #2a3140;
      --text: #e6eaf2;
      --muted: #93a0b5;
      --ok: #3ecf8e;
      --warn: #f5c451;
      --bad: #ff6b6b;
      --accent: #6ea8fe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      background: #12151c;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    .sub { color: var(--muted); font-size: 12px; }
    main { padding: 20px; display: grid; gap: 16px; max-width: 1400px; margin: 0 auto; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .card h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .stat { font-size: 28px; font-weight: 700; }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .pill.ok, .pill.alive { background: rgba(62,207,142,.15); color: var(--ok); }
    .pill.warn { background: rgba(245,196,81,.15); color: var(--warn); }
    .pill.bad, .pill.dead { background: rgba(255,107,107,.15); color: var(--bad); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 360px;
      overflow: auto;
      background: #0b0d12;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    select, button {
      background: #0b0d12;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
    }
    button { cursor: pointer; }
    button:hover { border-color: var(--accent); }
    .muted { color: var(--muted); }
    .list { margin: 0; padding-left: 18px; }
    .banner {
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #12151c;
    }
    .banner.warn { border-color: rgba(245,196,81,.35); }
    .banner.bad { border-color: rgba(255,107,107,.35); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>cursor-meta fleet</h1>
      <div class="sub" id="updated">loading…</div>
    </div>
    <div class="row">
      <span id="budget-pill" class="pill ok">budget</span>
      <button id="relaunch">Relaunch fleet</button>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <section class="banner" id="fleet-banner">Checking fleet…</section>
    <section class="grid" id="summary"></section>

    <section class="card">
      <h2>Processes</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th><th>PID</th><th>Status</th><th>Ticks</th><th>Last activity</th><th>Notes</th>
          </tr>
        </thead>
        <tbody id="processes"></tbody>
      </table>
    </section>

    <section class="grid">
      <div class="card">
        <h2>Live IDE chats</h2>
        <ul class="list" id="live-chats"></ul>
      </div>
      <div class="card">
        <h2>Strategy review</h2>
        <div id="strategy"></div>
      </div>
      <div class="card">
        <h2>Frustration signals</h2>
        <ul class="list" id="frustration"></ul>
      </div>
    </section>

    <section class="card">
      <h2>Logs</h2>
      <div class="row" style="margin-bottom:12px">
        <select id="log-select"></select>
      </div>
      <pre id="log-view">Select a log…</pre>
    </section>
  </main>
  <script>
    const fmtTime = (iso) => iso ? new Date(iso).toLocaleString() : "—";
    const pill = (status) => {
      const cls =
        status === "alive" || status === "ok" ? status === "alive" ? "alive" : "ok"
        : status === "warn" ? "warn"
        : status === "dead" || status === "bad" ? "dead"
        : "warn";
      return \`<span class="pill \${cls}">\${status}</span>\`;
    };

    async function loadLog(name) {
      if (!name) return;
      const res = await fetch("/api/logs/" + encodeURIComponent(name));
      document.getElementById("log-view").textContent = await res.text();
    }

    function render(data) {
      document.getElementById("updated").textContent =
        "Updated " + fmtTime(data.at) + " · meta dir " + data.metaDir;
      const budgetStatus = data.budget?.status ?? "ok";
      const pillEl = document.getElementById("budget-pill");
      pillEl.className = "pill " + budgetStatus;
      pillEl.textContent = "budget " + budgetStatus;

      const fh = data.fleetHealth ?? {};
      const fleetBanner = document.getElementById("fleet-banner");
      const fleetLabel = fh.alive + " / " + fh.total + " processes alive";
      const watcherLabel = fh.watcherAlive ? "watcher running" : "watcher stopped";
      const reviewerLabel = fh.strategyReviewerAlive ? "strategy reviewer running" : "strategy reviewer stopped";
      const healthExtras = watcherLabel + ", " + reviewerLabel;
      if (!fh.total) {
        fleetBanner.className = "banner warn";
        fleetBanner.textContent = "No fleet running. Click Relaunch fleet or run: npm run experiments";
      } else if (fh.alive === 0) {
        fleetBanner.className = "banner bad";
        const staleNote = fh.staleManifest
          ? " Stale manifest (>5m with no live workers)."
          : "";
        fleetBanner.textContent =
          "Fleet stopped (" + fleetLabel + ", " + healthExtras + ")." + staleNote + " Manifest from " + fmtTime(fh.manifestAt) + ". Relaunch to resume.";
      } else if (fh.alive < fh.total) {
        fleetBanner.className = "banner warn";
        fleetBanner.textContent = "Fleet degraded: " + fleetLabel + ", " + healthExtras + ". Watcher should relaunch dead workers.";
      } else {
        fleetBanner.className = "banner";
        fleetBanner.textContent = "Fleet healthy: " + fleetLabel + ", " + healthExtras + ".";
      }

      const goal = data.manifest?.goal ?? "—";
      const blocked = data.manifest?.budgetBlocked ? "YES" : "no";
      const spawns = data.budget?.local?.spawnsLastHour ?? 0;
      const cents = data.budget?.local?.estimatedCents ?? 0;
      const ticks = data.budget?.local?.ideTicks ?? 0;
      const fleetPct = data.budget?.fleet?.percentOfMaxDuration;
      const planPct = data.budget?.plan?.percent;

      document.getElementById("summary").innerHTML = [
        card("Goal", goal.slice(0, 120) + (goal.length > 120 ? "…" : "")),
        card("Spend (est.)", "$" + (cents / 100).toFixed(2), data.budget?.warnings?.[0] ?? ""),
        card("Spawns / hr", String(spawns), "cap " + (data.budget?.limits?.maxSpawnsPerHour ?? "?")),
        card("IDE ticks", String(ticks)),
        card("Fleet runtime", fleetPct != null ? fleetPct.toFixed(1) + "%" : "—"),
        card("Plan usage", planPct != null ? planPct.toFixed(1) + "%" : "not set"),
        card("Blocked", blocked, (data.manifest?.budgetBlockedReason ?? data.supervisor?.reasons?.[0] ?? "")),
      ].join("");

      document.getElementById("processes").innerHTML = (data.experiments ?? []).map((exp) => {
        const cp = exp.checkpoint ?? {};
        const last = cp.lastTick;
        const notes = [
          exp.relaunchCount ? "relaunches " + exp.relaunchCount : "",
          cp.stoppedBecause ? "stopped: " + cp.stoppedBecause : "",
          last?.error ? String(last.error).slice(0, 80) : "",
        ].filter(Boolean).join(" · ");
        return \`<tr>
          <td><code>\${exp.name}</code></td>
          <td>\${exp.pid > 0 ? exp.pid : "—"}</td>
          <td>\${exp.alive ? pill("alive") : pill("dead")}</td>
          <td>\${cp.ticks ?? "—"}</td>
          <td class="muted">\${last?.at ? fmtTime(last.at) : "—"}</td>
          <td class="muted">\${notes || "—"}</td>
        </tr>\`;
      }).join("") || '<tr><td colspan="6" class="muted">No fleet manifest — run npm run experiments</td></tr>';

      const pulse = data.pulse?.error ? null : data.pulse;
      const live = pulse?.live ?? [];
      document.getElementById("live-chats").innerHTML = live.length ? live.map((c) =>
        \`<li><strong>#$\{c.sessionIndex ?? "?"} \${c.title}</strong> — $\{c.signals.join(", ") || "idle"}\${c.orchestrationExempt ? " (exempt)" : ""}</li>\`
      ).join("") : '<li class="muted">No in-flight chats</li>';

      const strat = data.strategyStatus ?? {};
      document.getElementById("strategy").innerHTML = strat.onTrack != null ? \`
        <div class="row">\${strat.onTrack ? pill("ok") : pill("warn")} score \${strat.score ?? "?"}</div>
        <p class="muted">\${strat.recommendation ?? ""}</p>
        <p class="muted">Issues: \${(strat.issues ?? []).join(", ") || "none"}</p>
        <p class="muted">At \${fmtTime(strat.at)}</p>
      \` : '<p class="muted">No strategy review yet</p>';

      const fr = pulse?.frustrationEvents ?? [];
      document.getElementById("frustration").innerHTML = fr.length ? fr.slice(0, 8).map((e) =>
        \`<li>#$\{e.sessionIndex ?? "?"} \${e.title}: \${e.frustrationRisk?.reason ?? "risk"} ($\{e.frustrationRisk?.score ?? 0})</li>\`
      ).join("") : '<li class="muted">None flagged</li>';

      const sel = document.getElementById("log-select");
      const prev = sel.value;
      sel.innerHTML = (data.logs ?? []).map((l) =>
        \`<option value="\${l.name}">\${l.name} (\${Math.round(l.bytes/1024)}kb)</option>\`
      ).join("");
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else if (sel.options.length) sel.value = sel.options[0].value;
      loadLog(sel.value);
    }

    function card(title, value, hint = "") {
      return \`<div class="card"><h2>\${title}</h2><div class="stat">\${value}</div>\${hint ? \`<div class="muted">\${hint}</div>\` : ""}</div>\`;
    }

    async function relaunchFleet() {
      const btn = document.getElementById("relaunch");
      btn.disabled = true;
      btn.textContent = "Launching…";
      try {
        const res = await fetch("/api/relaunch", { method: "POST" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Launch failed");
        await refresh();
      } catch (error) {
        alert(error.message ?? String(error));
      } finally {
        btn.disabled = false;
        btn.textContent = "Relaunch fleet";
      }
    }

    async function refresh() {
      const res = await fetch("/api/status");
      render(await res.json());
    }

    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("relaunch").addEventListener("click", relaunchFleet);
    document.getElementById("log-select").addEventListener("change", (e) => loadLog(e.target.value));
    refresh();
    setInterval(refresh, 4000);
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return html(res, dashboardPage());
  }

  if (url.pathname === "/api/status") {
    try {
      return json(res, 200, collectDashboardSnapshot({ metaDir, workspace }));
    } catch (error) {
      return json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const logMatch = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
  if (logMatch) {
    const name = decodeURIComponent(logMatch[1]);
    const path = join(experimentsDir, `${name}.log`);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(tailFile(path, 120));
    return;
  }

  if (url.pathname === "/api/relaunch" && req.method === "POST") {
    try {
      const manifest = await launchSelfImproveFleet({
        cwd: fleetCwd,
        metaDir: experimentsDir,
        excludeSessionIndex: 1,
        workerSessionIndexes: [],
        durationMs: 2 * 60 * 60 * 1000,
        goal: "Autonomously improve cursor-meta-mcp with verified npm test on every tick. No architecture theater.",
        withOrchestrator: true,
        withWatcher: true,
        withStrategyReviewer: true,
        stopExisting: true,
      });
      return json(res, 200, { ok: true, manifest });
    } catch (error) {
      return json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  json(res, 404, { error: "Not found" });
});

server.listen(port, host, () => {
  console.error(`cursor-meta dashboard → http://${host}:${port}`);
  console.error(`meta dir: ${metaDir}`);
});
