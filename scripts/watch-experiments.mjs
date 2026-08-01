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
import { basename, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { runConsciousnessPulse } from "../src/consciousness-pulse.js";
import {
  countActiveWorkers,
  enforceSupervisorDecision,
  evaluateFleetSupervisor,
  isTerminalSuccessStop,
  isWorkerExperiment,
  loadFleetManifest,
  saveFleetManifest,
  shouldAllowRelaunch,
} from "../src/budget-supervisor.js";
import { collectFleetPids } from "../src/fleet-control.js";
import {
  analyzeWorkerCheckpoint,
  isWorkerStalled,
  relaunchBlockedReason,
} from "../src/fleet-metrics.js";
import { appendExperimentLog, formatWatchLogLine } from "../src/experiment-log.js";
import { mergeWorkerBranch } from "../src/git-worktree.js";
import { blockMission, landVerifiedMission, readMissions, stationId } from "../src/orbit-ledger.js";
import { orbitMetaDirForFleet } from "../src/orbit-worker.js";
import { resolveFleetCiPolicy } from "../src/fleet-ci-policy.js";
import { watchGithubCi } from "../src/github-ci-watch.js";
import { envForWorkers, resolveWorkerNodeBin } from "../src/load-env.js";
import { experimentsDir } from "../src/meta-home.js";
import { recordBudgetEvent, recordSpawn } from "../src/plan-budget.js";
import { acquireLockWithCleanup } from "../src/process-lock.js";
import { fleetSupervisorArgs } from "../src/self-improve.js";
import { spawnSdkWorker } from "../src/sdk-worker.js";

const META_DIR = argValue("--meta-dir") ?? experimentsDir();
const ROOT = argValue("--root") ?? process.cwd();
const WORKSPACE = argValue("--workspace") ?? basename(ROOT);
const STATUS_PATH = join(META_DIR, "watch-status.json");
const WATCH_LOG = join(META_DIR, "watch.log");

/** Merge failures are sticky; only park the mission once per worker per run. */
const mergeBlockNotified = new Set();

function conflictingFiles(repoRoot, branch) {
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", branch], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const raw = execFileSync("git", ["diff", "--name-only", base, branch], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    return raw.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Park whatever missions this worker is holding so the stall is visible. */
function blockMissionsHeldBy(repoRoot, workerName, reason, metaDir) {
  try {
    const station = stationId(repoRoot);
    const orbitMeta = orbitMetaDirForFleet(metaDir);
    const held = readMissions(station, orbitMeta).filter(
      (m) => m.claimedBy === workerName && ["claimed", "active", "verified"].includes(m.status),
    );
    for (const mission of held) blockMission(station, mission.id, reason, orbitMeta);
    return held.map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Promotes a coder's verified missions to landed once its branch is merged.
 *
 * A coder can only prove things about its own worktree, so it stops at
 * `verified`. Whether that work reached the base branch is observable only
 * here — this is the step that makes "landed" mean "in the branch you have
 * checked out" rather than "committed somewhere with green tests".
 */
function landVerifiedMissionsHeldBy(repoRoot, workerName, metaDir) {
  try {
    const station = stationId(repoRoot);
    const orbitMeta = orbitMetaDirForFleet(metaDir);
    const verified = readMissions(station, orbitMeta).filter(
      (m) => m.claimedBy === workerName && m.status === "verified",
    );
    const landed = [];
    for (const mission of verified) {
      const result = landVerifiedMission(station, mission.id, orbitMeta);
      if (!result.error) landed.push(mission.id);
    }
    return landed;
  } catch {
    return [];
  }
}

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
    const report = runConsciousnessPulse({ limit: 30, workspace: WORKSPACE });
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
    metaDir: META_DIR,
    prompt: checkpoint?.prompt,
    durationMs: checkpoint?.durationMs,
    maxTicks: checkpoint?.maxTicks,
    // Station stays keyed on the fleet root even when the worker runs in a worktree.
    stationCwd: manifest?.root ?? ROOT,
  });
  return spawned.pid;
}

/** Relaunch a supervisor loop with canonical args (never as a worker). */
function relaunchSupervisor(exp, manifest) {
  const env = envForWorkers();
  const supervisorArgs = fleetSupervisorArgs({
    cwd: manifest?.root ?? ROOT,
    metaDir: META_DIR,
    excludeSessionIndex: manifest?.conductorExcluded?.[0] ?? 1,
    strategyIntervalMs: 5 * 60_000,
    goal: manifest?.goal ?? "Ship verified improvements",
    useLlm: Boolean(env.CURSOR_API_KEY),
  });
  const args =
    exp.name === "orchestrator-loop"
      ? supervisorArgs.orchestrator
      : exp.name === "strategy-review-loop"
        ? supervisorArgs.strategyReview
        : null;
  if (!args) {
    appendLog(`[${new Date().toISOString()}] cannot relaunch ${exp.name}: unknown supervisor`);
    return -1;
  }
  const child = spawn(resolveWorkerNodeBin(), args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  return child.pid ?? -1;
}

function relaunchExperiment(exp, manifest) {
  appendLog(`[${new Date().toISOString()}] relaunch ${exp.name}`);

  if (exp.name.startsWith("sdk-worker")) {
    recordSpawn("relaunch_worker", exp.name);
    return relaunchSdkWorker(exp, manifest);
  }

  // Supervisors restart with canonical supervisor args and do not consume the
  // worker relaunch budget. Falling through to the IDE branch previously
  // relaunched strategy-review-loop as a long-session worker.
  if (!isWorkerExperiment(exp.name)) {
    return relaunchSupervisor(exp, manifest);
  }

  recordSpawn("relaunch_worker", exp.name);
  const args = [
    "--import",
    "tsx",
    "scripts/long-session.mjs",
    "--cwd",
    manifest?.root ?? ROOT,
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
    manifest?.goal
      ? `Autonomous worker: ${manifest.goal} Run npm test, no user questions. Keep going.`
      : "Autonomous worker: ship one verified improvement per tick, run npm test, no user questions. Keep going.",
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
  const ciPolicy = resolveFleetCiPolicy(manifest?.root ?? ROOT);
  // Skip GitHub polling once no worker is alive — a settled fleet must not
  // keep burning API calls while the teardown grace window counts down.
  const githubCi =
    ciPolicy.watchGithub && (manifest?.root ?? ROOT) && countActiveWorkers(manifest) > 0
      ? watchGithubCi(manifest?.root ?? ROOT)
      : null;

  const snapshot = {
    at: new Date().toISOString(),
    budget: decision.snapshot,
    ciPolicy,
    githubCi,
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

      // A failed merge used to be a field in a status file nobody reads, so the
      // work sat on the fleet branch looking finished. Park the mission the
      // commits belong to, with the conflicting files named, so the operator
      // sees it and no coder reclaims the lane behind it.
      if (entry.merge?.ok && entry.merge.merged) {
        const landed = landVerifiedMissionsHeldBy(manifest.root, exp.name, META_DIR);
        if (landed.length) {
          appendLog(
            `[${new Date().toISOString()}] landed after merge ${exp.name}: ${landed.join(", ")}`,
          );
        }
      }

      if (entry.merge && !entry.merge.ok && !mergeBlockNotified.has(exp.name)) {
        mergeBlockNotified.add(exp.name);
        const files = conflictingFiles(manifest.root, worktree.branch);
        const reason = `Merge into ${basename(manifest.root)} failed for ${worktree.branch}${
          files.length ? ` — conflicts: ${files.slice(0, 6).join(", ")}` : ""
        }. Resolve by hand; commits are safe on the branch.`;
        const parked = blockMissionsHeldBy(manifest.root, exp.name, reason, META_DIR);
        appendLog(`[${new Date().toISOString()}] merge-blocked ${exp.name}: ${reason}`);
        if (parked.length) {
          console.error(`[watch] parked mission(s) ${parked.join(", ")} — ${reason}`);
        }
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
    // A worker that finished cleanly (missions drained, duration or tick cap)
    // is done — relaunching it re-runs a completed mission on the clock. Read
    // the raw checkpoint: analyzed metrics mask stoppedBecause on 0-tick runs,
    // which turned instantly-drained workers into a relaunch loop.
    const rawStoppedBecause = exp.checkpointPath
      ? readJson(exp.checkpointPath)?.stoppedBecause
      : undefined;
    const terminal =
      isWorkerExperiment(exp.name) &&
      !alive &&
      isTerminalSuccessStop(rawStoppedBecause ?? checkpoint?.stoppedBecause);
    if (terminal) {
      entry.terminal = true;
    }
    const wantsRelaunch =
      relaunch &&
      !terminal &&
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

  // Fleet is settled when every worker is finished and none will restart:
  // terminal success, relaunch-blocked, or relaunching disabled. Supervisors
  // (including this watcher) do not keep a settled fleet "running".
  const workerEntries = snapshot.experiments.filter((entry) => isWorkerExperiment(entry.name));
  snapshot.fleetSettled =
    workerEntries.length === 0 ||
    workerEntries.every(
      (entry) =>
        !entry.relaunched &&
        !entry.alive &&
        (entry.terminal || entry.relaunchBlocked || !relaunch),
    );

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

function describeSettledWorkers(snapshot) {
  const rows = snapshot.experiments
    .filter((entry) => isWorkerExperiment(entry.name))
    .map((entry) => `${entry.name}=${entry.checkpoint?.stoppedBecause ?? "no_checkpoint"}`);
  return rows.length > 0 ? `workers settled: ${rows.join(", ")}` : "no workers in manifest";
}

/** Stop every remaining fleet process (except this watcher) and mark completion. */
function teardownFleet(manifest, reason) {
  appendLog(`[${new Date().toISOString()}] fleet complete — ${reason}; stopping supervisors`);
  recordBudgetEvent({
    at: new Date().toISOString(),
    action: "fleet_stop",
    source: "watch-experiments",
    detail: reason,
  });
  manifest.fleetCompletedAt = new Date().toISOString();
  manifest.fleetCompletedReason = reason;
  saveFleetManifest(manifest, META_DIR);
  for (const pid of collectFleetPids(manifest)) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
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
const teardownEnabled = !flag("--no-teardown");
/** Consecutive settled cycles before teardown — grace for slow checkpoint writes. */
const TEARDOWN_AFTER_SETTLED_CYCLES = 3;

appendLog(
  `[${new Date().toISOString()}] watch-experiments start interval=${intervalMs}ms relaunch=${relaunch} teardown=${teardownEnabled} (budget supervisor enabled)`,
);

let settledCycles = 0;
while (true) {
  const manifest = loadManifest();
  if (!manifest) {
    appendLog(`[${new Date().toISOString()}] no manifest — waiting`);
  } else if (
    teardownEnabled &&
    manifest.fleetCompletedAt &&
    countActiveWorkers(manifest) === 0
  ) {
    // Restarted against an already-completed fleet — nothing to watch.
    appendLog(
      `[${new Date().toISOString()}] fleet already completed at ${manifest.fleetCompletedAt} — exiting`,
    );
    process.exit(0);
  } else {
    const snapshot = await watchOnce(manifest, relaunch);
    if (teardownEnabled && snapshot.fleetSettled) {
      settledCycles += 1;
      if (settledCycles >= TEARDOWN_AFTER_SETTLED_CYCLES) {
        const fresh = loadManifest();
        if (fresh) teardownFleet(fresh, describeSettledWorkers(snapshot));
        process.exit(0);
      }
    } else {
      settledCycles = 0;
    }
  }
  await sleep(intervalMs);
}
