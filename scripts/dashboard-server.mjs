#!/usr/bin/env node
/**
 * Local fleet visibility dashboard.
 *
 *   npm run dashboard
 *   npm run dashboard -- --port 3847 --workspace cursor-meta-mcp
 */
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectDashboardLiveSnapshot,
  collectDashboardSnapshot,
  defaultExperimentsDir,
  tailFile,
} from "../src/dashboard.js";
import { tailRunEvents } from "../src/run-events.js";
import { wipeFleetDashboardState } from "../src/fleet-reset.js";
import { launchSelfImproveFleet } from "../src/self-improve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(__dirname, "..", "dashboard");

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf("."));
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function dashboardIndex() {
  return join(dashboardDir, "index.html");
}

function parseRequestUrl(req) {
  const raw = req.url?.trim();
  if (!raw || raw === "//") {
    return new URL("/", `http://${host}:${port}`);
  }
  try {
    return new URL(raw, `http://${host}:${port}`);
  } catch {
    const path = raw.split("?")[0] || "/";
    const safePath = path.startsWith("/") ? path : `/${path}`;
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    return new URL(`${safePath}${query}`, `http://${host}:${port}`);
  }
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = parseRequestUrl(req);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveStatic(res, dashboardIndex());
  }

  if (url.pathname === "/styles.css") {
    return serveStatic(res, join(dashboardDir, "styles.css"));
  }

  if (url.pathname === "/app.js") {
    return serveStatic(res, join(dashboardDir, "app.js"));
  }

  if (url.pathname === "/api/live") {
    try {
      return json(
        res,
        200,
        collectDashboardLiveSnapshot({ metaDir, workspace }),
      );
    } catch (error) {
      return json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (runEventsMatch) {
    const runId = decodeURIComponent(runEventsMatch[1]);
    const since = url.searchParams.get("since") ?? undefined;
    return json(res, 200, {
      runId,
      events: tailRunEvents(runId, { metaDir, since }),
    });
  }

  const logMatch = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
  if (logMatch) {
    const name = decodeURIComponent(logMatch[1]);
    const path = join(experimentsDir, `${name}.log`);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(tailFile(path, 120));
    return;
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    try {
      const result = wipeFleetDashboardState({ metaDir, root: fleetCwd });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

server.on("clientError", (_err, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(port, host, () => {
  if (!existsSync(dashboardIndex())) {
    console.error(`warning: dashboard assets missing at ${dashboardDir}`);
  }
  console.error(`cursor-meta dashboard → http://${host}:${port}`);
  console.error(`meta dir: ${metaDir}`);
});
