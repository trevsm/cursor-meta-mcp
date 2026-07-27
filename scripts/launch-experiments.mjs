#!/usr/bin/env node
/**
 * Launch autonomous experiment fleet for cursor-meta-mcp.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createIdeChat } from "../dist/ide-chat-control.js";
import { getSessionIndexForId } from "../dist/history-store.js";

const ROOT = "/Users/trevorsmith/Projects/cursor-meta-mcp";
const META_DIR = join(homedir(), ".cursor-meta", "experiments");
mkdirSync(META_DIR, { recursive: true });

const WORKER_PROMPT = [
  "You are an autonomous worker tab for cursor-meta-mcp long-session experiments.",
  "Do not ask the user questions. Do not stop early.",
  "Each tick: pick one high-value improvement (tests, pulse heuristics, long-session, docs), implement, run npm test.",
  "Start now.",
].join(" ");

function spawnDetached(name, args, logPath) {
  writeFileSync(logPath, `[${new Date().toISOString()}] starting ${name}\n`, { flag: "a" });
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return { name, pid: child.pid ?? -1, logPath, command: [process.execPath, ...args].join(" ") };
}

function launchLongSession(name, { sessionIndex, sessionId, duration, checkpoint, logPath }) {
  const args = [
    "scripts/long-session.mjs",
    "--cwd",
    ROOT,
    "--duration",
    duration,
    "--tick-interval",
    "60s",
    "--wait-timeout",
    "20m",
    "--max-ticks",
    "500",
    "--checkpoint",
    checkpoint,
    "--prompt",
    WORKER_PROMPT,
  ];
  if (sessionIndex != null) args.push("--session", String(sessionIndex));
  if (sessionId) args.push("--session-id", sessionId);
  return spawnDetached(name, args, logPath);
}

const launched = [];

launched.push(
  launchLongSession("worker-session-2", {
    sessionIndex: 2,
    duration: "2h",
    checkpoint: join(META_DIR, "worker-2.json"),
    logPath: join(META_DIR, "worker-2.log"),
  }),
);

launched.push(
  launchLongSession("worker-session-9", {
    sessionIndex: 9,
    duration: "2h",
    checkpoint: join(META_DIR, "worker-9.json"),
    logPath: join(META_DIR, "worker-9.log"),
  }),
);

const { sessionId } = await createIdeChat();
writeFileSync(
  join(META_DIR, "dedicated-worker.json"),
  JSON.stringify({ sessionId, createdAt: new Date().toISOString() }, null, 2),
);

launched.push(
  launchLongSession("worker-dedicated", {
    sessionId,
    duration: "2h",
    checkpoint: join(META_DIR, `dedicated-${sessionId.slice(0, 8)}.json`),
    logPath: join(META_DIR, `dedicated-${sessionId.slice(0, 8)}.log`),
  }),
);

await new Promise((resolve) => setTimeout(resolve, 2000));
const dedicatedIndex = getSessionIndexForId(sessionId);

launched.push(
  spawnDetached(
    "orchestrator-loop",
    [
      "scripts/orchestrate-loop.mjs",
      "--workspace",
      "cursor-meta-mcp",
      "--exclude-session",
      "1",
      "--max-cycles",
      "120",
      "--interval-ms",
      "60000",
      "--max-actions",
      "2",
      "--keep-running",
      "--allow-continue",
      "--allow-watch",
    ],
    join(META_DIR, "orchestrator.log"),
  ),
);

const manifest = {
  at: new Date().toISOString(),
  root: ROOT,
  dedicatedWorker: { sessionId, sessionIndex: dedicatedIndex ?? null },
  experiments: launched,
};
writeFileSync(join(META_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
