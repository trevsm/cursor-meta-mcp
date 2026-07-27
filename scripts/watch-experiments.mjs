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
import { homedir } from "node:os";
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
import { recordSpawn } from "../src/plan-budget.js";

const META_DIR = join(homedir(), ".cursor-meta", "experiments");
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
  writeFileSync(WATCH_LOG, `${line}\n`, { flag: "a" });
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

function summarizeCheckpoint(path) {
  const state = readJson(path);
  if (!state) return { exists: false };
  const ticks = state.ticks ?? [];
  const last = ticks.at(-1);
  return {
    exists: true,
    ticks: ticks.length,
    stoppedBecause: state.stoppedBecause ?? null,
    lastTick: last
      ? {
          tick: last.tick,
          at: last.at,
          skipped: last.skipped,
          error: last.error,
          watchedMs: last.watchedMs,
        }
      : null,
  };
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

function relaunchExperiment(exp) {
  appendLog(`[${new Date().toISOString()}] relaunch ${exp.name}`);
  recordSpawn("relaunch_worker", exp.name);
  if (exp.name === "orchestrator-loop") {
    const logPath = exp.logPath ?? join(META_DIR, "orchestrator.log");
    const child = spawn(
      process.execPath,
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
      { cwd: ROOT, detached: true, stdio: "ignore", env: process.env },
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

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: process.env,
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

    const staleError =
      checkpoint?.exists && checkpoint.stoppedBecause === "error" && checkpoint.lastTick?.at;
    const staleMs = staleError ? Date.now() - Date.parse(checkpoint.lastTick.at) : 0;
    const wantsRelaunch = relaunch && (!alive || (staleError && staleMs > 3 * 60_000));

    if (wantsRelaunch) {
      const gate = shouldAllowRelaunch(manifest, exp);
      if (!gate.allowed) {
        entry.relaunchBlocked = true;
        entry.relaunchBlockedReason = gate.reason;
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
      const newPid = relaunchExperiment(exp);
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
  appendLog(JSON.stringify(snapshot));
  console.error(JSON.stringify(snapshot));
  return snapshot;
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
