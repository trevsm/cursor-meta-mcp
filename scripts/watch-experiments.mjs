#!/usr/bin/env node
/**
 * Watch experiment fleet — poll PIDs, checkpoints, pulse, relaunch dead workers.
 * Top-level budget supervisor: blocks relaunches and kills runaway workers when
 * plan/budget thresholds are exceeded.
 *
 * Usage:
 *   node scripts/watch-experiments.mjs
 *   node scripts/watch-experiments.mjs --interval 30s --no-relaunch
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { runConsciousnessPulse } from "../src/consciousness-pulse.js";
import {
  enforceSupervisorDecision,
  evaluateFleetSupervisor,
  loadFleetManifest,
  saveFleetManifest,
  shouldAllowRelaunch,
} from "../src/budget-supervisor.js";
import {
  analyzeWorkerCheckpoint,
  isWorkerStalled,
  relaunchBlockedReason,
} from "../src/fleet-metrics.js";
import { appendExperimentLog, formatWatchLogLine } from "../src/experiment-log.js";
import { mergeWorkerBranch } from "../src/git-worktree.js";
import { envForWorkers, resolveWorkerNodeBin } from "../src/load-env.js";
import { experimentsDir, metaHome } from "../src/meta-home.js";
import { recordSpawn } from "../src/plan-budget.js";
import { acquireLockWithCleanup } from "../src/process-lock.js";
import { spawnSdkWorker } from "../src/sdk-worker.js";

const META_DIR = experimentsDir();
const ROOT = process.cwd();
const STATUS_PATH = join(META_DIR, "watch-status.json");
const WATCH_LOG = join(META_DIR, "watch.log");

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDuration(raw, fallbackMs) {
  if (!raw) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(amount * mult[unit]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(line) {
  appendExperimentLog(WATCH_LOG, line);
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function loadManifest() {
  return loadFleetManifest(META_DIR);
}

function pulseWorkers(excludeIndexes = [1]) {
  try {
    const report = runConsciousnessPulse({ limit: 30, workspace: "cursor-meta-mcp" });
    return report.live
      .filter((entry) => !excludeIndexes.includes(entry.sessionIndex ?? -1))
      .map((entry) => ({
        sessionIndex: entry.sessionIndex,
        title: entry.title,
        signals: entry.signals,
        orchestrationExempt: entry.orchestrationExempt,
        frustrationRisk: entry.frustrationRisk,
      }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeCheckpoint(path) {
  if (!path || !existsSync(path)) return { exists: false };
  const metrics = analyzeWorkerCheckpoint(path);
  if (!metrics) return { exists: true, ticks: 0, lastCommitted: false, lastPushed: false };
  return {
    exists: true,
    ticks: metrics.ticks,
    productiveTicks: metrics.productiveTicks,
    productiveRatio: metrics.productiveRatio,
    commits: metrics.commits,
    errors: metrics.errors,
    softSkips: metrics.softSkips,
    attemptedTicks: metrics.attemptedTicks,
    stoppedBecause: metrics.stoppedBecause ?? null,
    lastTickAt: metrics.lastTickAt ?? null,
    lastError: metrics.lastError ?? null,
    lastCommitted: metrics.lastCommitted,
    lastPushed: metrics.lastPushed,
  };
}

function relaunchSdkWorker(exp, manifest) {
  const checkpoint = readJson(exp.checkpointPath);
  const worktree = readJson(join(META_DIR, `${exp.name}.worktree.json`));
  const spawned = spawnSdkWorker({
    cwd: worktree?.path ?? manifest?.root ?? ROOT,
    checkpointPath: exp.checkpointPath,
    metaDir: metaHome(),
    prompt: checkpoint?.prompt,
    durationMs: checkpoint?.durationMs,
    maxTicks: checkpoint?.maxTicks,
  });
  return spawned.pid;
}

function relaunchExperiment(exp, manifest) {
  appendLog(`[${new Date().toISOString()}] relaunch ${exp.name}`);
  recordSpawn("relaunch_worker", exp.name);

  if (exp.name.startsWith("sdk-worker")) {
    return relaunchSdkWorker(exp, manifest);
  }

  if (exp.name === "orchestrator-loop") {
    const logPath = exp.logPath ?? join(META_DIR, "orchestrator.log");
    const child = spawn(
      resolveWorkerNodeBin(),
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
      { cwd: ROOT, detached: true, stdio: "ignore", env: envForWorkers() },
    );
    child.unref();
    return child.pid ?? -1;
  }

  const args = [
    "--import",
    "tsx",
    "scripts/long-session.mjs",
    "--cwd",
    ROOT,
    "--duration",
    "2h",
    "--tick-interval",
    "60s",
    "--wait-timeout",
    "20m",
    "--max-ticks",
    "500",
  ];
  if (exp.checkpointPath) args.push("--checkpoint", exp.checkpointPath);
  if (exp.sessionId) args.push("--session-id", exp.sessionId);
  else if (exp.sessionIndex != null) args.push("--session", String(exp.sessionIndex));
  else {
    const m = exp.command?.match(/--session(?:-id)?\s+(\S+)/);
    if (m) {
      if (exp.command.includes("--session-id")) args.push("--session-id", m[1]);
      else args.push("--session", m[1]);
    }
  }
  args.push(
    "--prompt",
    "Autonomous worker: improve cursor-meta-mcp, run npm test, no user questions. Keep going.",
  );

  const nodeBin = resolveWorkerNodeBin();
  const child = spawn(nodeBin, args, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: envForWorkers(),
  });
  child.unref();
  return child.pid ?? -1;
}

async function watchOnce(manifest, relaunch) {
  let decision = evaluateFleetSupervisor(manifest);
  if (decision.killWorkers) {
    decision = enforceSupervisorDecision(manifest, decision);
    manifest = loadManifest();
    appendLog(
      `[${new Date().toISOString()}] budget supervisor killed workers: ${decision.killedPids.join(",")}`,
    );
  }

  const experiments = manifest?.experiments ?? [];
  const snapshot = {
    at: new Date().toISOString(),
    budget: decision.snapshot,
    experiments: [],
    liveWorkers: pulseWorkers([1]),
    strategyReview: readJson(join(META_DIR, "strategy-status.json")),
  };

  for (const exp of experiments) {
    const alive = pidAlive(exp.pid);
    const checkpoint = exp.checkpointPath ? summarizeCheckpoint(exp.checkpointPath) : null;
    const entry = {
      name: exp.name,
      pid: exp.pid,
      alive,
      checkpoint,
    };

    const wtPath = join(META_DIR, `${exp.name}.worktree.json`);
    const worktree = readJson(wtPath);
    if (worktree && manifest?.root && checkpoint?.exists && checkpoint.lastCommitted) {
      try {
        entry.merge = mergeWorkerBranch(manifest.root, worktree);
      } catch (error) {
        entry.merge = {
          ok: false,
          merged: false,
          branch: worktree.branch,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const staleError =
      checkpoint?.exists && checkpoint.stoppedBecause === "error" && checkpoint.lastTickAt;
    const staleMs = staleError ? Date.now() - Date.parse(checkpoint.lastTickAt) : 0;
    const stalled = isWorkerStalled({
      pidAlive: alive,
      checkpointPath: exp.checkpointPath,
    });
    const productivityBlock = relaunchBlockedReason(
      analyzeWorkerCheckpoint(exp.checkpointPath),
      exp.relaunchCount ?? 0,
    );
    const wantsRelaunch =
      relaunch &&
      (!alive || (staleError && staleMs > 3 * 60_000) || stalled);

    if (productivityBlock) {
      entry.productivityGate = productivityBlock;
    }

    if (wantsRelaunch) {
      const gate = shouldAllowRelaunch(manifest, exp);
      if (!gate.allowed || productivityBlock) {
        entry.relaunchBlocked = true;
        entry.relaunchBlockedReason = productivityBlock ?? gate.reason;
        snapshot.experiments.push(entry);
        continue;
      }

      if (alive && exp.pid) {
        try {
          process.kill(exp.pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
      const newPid = relaunchExperiment(exp, manifest);
      exp.relaunchCount = (exp.relaunchCount ?? 0) + 1;
      entry.relaunched = true;
      entry.newPid = newPid;
      exp.pid = newPid;
    }

    snapshot.experiments.push(entry);
  }

  if (manifest) {
    manifest.at = snapshot.at;
    manifest.experiments = experiments;
    saveFleetManifest(manifest, META_DIR);
  }

  writeFileSync(STATUS_PATH, JSON.stringify(snapshot, null, 2));
  appendLog(formatWatchLogLine(snapshot));
  console.error(JSON.stringify(snapshot));
  return snapshot;
}

if (!flag("--no-lock")) {
  const lock = acquireLockWithCleanup("watch-experiments", META_DIR);
  if (!lock.acquired) {
    appendLog(
      `[${new Date().toISOString()}] watch-experiments already running (pid ${lock.heldBy?.pid}) — exiting`,
    );
    process.exit(0);
  }
}

const intervalMs = parseDuration(argValue("--interval"), 30_000);
const relaunch = !flag("--no-relaunch");

appendLog(
  `[${new Date().toISOString()}] watch-experiments start interval=${intervalMs}ms relaunch=${relaunch} (budget supervisor enabled)`,
);

while (true) {
  const manifest = loadManifest();
  if (!manifest) {
    appendLog(`[${new Date().toISOString()}] no manifest — waiting`);
  } else {
    await watchOnce(manifest, relaunch);
  }
  await sleep(intervalMs);
}
