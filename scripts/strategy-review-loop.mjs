#!/usr/bin/env node
/**
 * Strategy review loop — dimension-4 critic for self-improve fleet.
 *
 * Usage:
 *   node scripts/strategy-review-loop.mjs --cwd /path/to/project --exclude-session 1
 *   node scripts/strategy-review-loop.mjs --interval 5m --use-llm
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { isWorkerExperiment } from "../src/budget-supervisor.js";
import { CursorLocalService } from "../src/cursor-local.js";
import { interceptIdeChat } from "../src/ide-chat-control.js";
import { killExperimentBySessionIndex, killExperimentsByName } from "../src/fleet-control.js";
import { experimentsDir } from "../src/meta-home.js";
import { appendExperimentLog, formatStrategyLogLine } from "../src/experiment-log.js";
import { acquireLockWithCleanup } from "../src/process-lock.js";
import {
  DEFAULT_SELF_IMPROVE_CRITERIA,
  DEFAULT_SELF_IMPROVE_GOAL,
  runStrategyReview,
} from "../src/strategy-review.js";
import { fleetAgentModel } from "../src/fleet-model.js";

const META_DIR = argValue("--meta-dir") ?? experimentsDir();
const STATUS_PATH = join(META_DIR, "strategy-status.json");
const LOG_PATH = join(META_DIR, "strategy-review.log");

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseDuration(raw, fallbackMs) {
  if (!raw) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(amount * mult[unit]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(line) {
  appendExperimentLog(LOG_PATH, line);
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
  return readJson(join(META_DIR, "manifest.json"));
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

/** True when the manifest lists workers and none of them is running. */
function fleetWorkersDead(manifest) {
  const workers = (manifest?.experiments ?? []).filter((exp) => isWorkerExperiment(exp.name));
  if (workers.length === 0) return false;
  return workers.every((exp) => !pidAlive(exp.pid));
}

function workerCheckpointsFromManifest(manifest) {
  return (manifest?.experiments ?? [])
    .filter((exp) => exp.name.startsWith("worker") || exp.name.startsWith("sdk-worker"))
    .map((exp) => ({
      name: exp.name,
      sessionIndex: exp.sessionIndex,
      checkpointPath: exp.checkpointPath,
    }));
}

async function applyVerdict(verdict, manifest, cwd, excludeSession) {
  const actions = [];

  if (verdict.pivot) {
    for (const exp of manifest?.experiments ?? []) {
      if (!exp.sessionId || exp.sessionIndex === excludeSession) continue;
      if (exp.name.startsWith("worker")) {
        try {
          await interceptIdeChat({
            sessionId: exp.sessionId,
            prompt: `[Strategy pivot] ${verdict.pivot}`,
            cwd,
          });
          actions.push({ type: "pivot", sessionIndex: exp.sessionIndex, sessionId: exp.sessionId });
        } catch (error) {
          actions.push({
            type: "pivot_error",
            sessionIndex: exp.sessionIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  for (const sessionIndex of verdict.kill ?? []) {
    if (sessionIndex === excludeSession) continue;
    const exp = (manifest?.experiments ?? []).find((row) => row.sessionIndex === sessionIndex);
    if (manifest) {
      const killed = killExperimentBySessionIndex(manifest, sessionIndex);
      if (killed.killed) {
        actions.push({ type: "kill_pid", sessionIndex, pid: killed.pid, name: killed.name });
      }
    }
    if (!exp?.sessionId) continue;
    try {
      await interceptIdeChat({
        sessionId: exp.sessionId,
        prompt:
          "Strategy review: this branch is stale. Stop current approach. Pick a fresh, small, test-verified improvement.",
        cwd,
      });
      actions.push({ type: "kill_intercept", sessionIndex, sessionId: exp.sessionId });
    } catch (error) {
      actions.push({
        type: "kill_error",
        sessionIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (manifest && verdict.killExperiments?.length) {
    const killedPids = killExperimentsByName(manifest, verdict.killExperiments);
    for (const pid of killedPids) {
      actions.push({ type: "kill_experiment_pid", pid });
    }
  }

  return actions;
}

async function reviewOnce(params) {
  const manifest = loadManifest();
  const cwd = params.cwd;
  const workspace = basename(cwd);
  const service = params.useLlm ? new CursorLocalService({ apiKey: process.env.CURSOR_API_KEY }) : undefined;

  const result = await runStrategyReview(service, {
    goal: params.goal,
    cwd,
    successCriteria: params.successCriteria,
    workspace,
    workerCheckpoints: workerCheckpointsFromManifest(manifest),
    useLlm: params.useLlm && Boolean(process.env.CURSOR_API_KEY),
    model: params.model,
  });

  const actions =
    !result.verdict.onTrack && manifest
      ? await applyVerdict(result.verdict, manifest, cwd, params.excludeSession)
      : [];

  const snapshot = {
    at: result.reviewedAt,
    source: result.source,
    onTrack: result.verdict.onTrack,
    score: result.verdict.score,
    issues: result.verdict.issues,
    recommendation: result.verdict.recommendation,
    pivot: result.verdict.pivot,
    spawn: result.verdict.spawn,
    kill: result.verdict.kill,
    killExperiments: result.verdict.killExperiments,
    actions,
  };

  writeFileSync(STATUS_PATH, JSON.stringify(snapshot, null, 2));
  appendLog(formatStrategyLogLine(snapshot));
  console.error(JSON.stringify(snapshot));
  return snapshot;
}

const cwd = argValue("--cwd") ?? process.cwd();
const excludeSession = argValue("--exclude-session") ? Number(argValue("--exclude-session")) : 1;
const intervalMs = parseDuration(argValue("--interval"), 5 * 60_000);
const useLlm = flag("--use-llm");
const once = flag("--once");
const goal = argValue("--goal") ?? DEFAULT_SELF_IMPROVE_GOAL;
const successCriteria = DEFAULT_SELF_IMPROVE_CRITERIA;

appendLog(
  `[${new Date().toISOString()}] strategy-review-loop start cwd=${cwd} interval=${intervalMs} useLlm=${useLlm}`,
);

const params = { cwd, excludeSession, useLlm, goal, successCriteria, model: fleetAgentModel(argValue("--model")) };

if (once) {
  await reviewOnce(params);
  process.exit(0);
}

if (!flag("--no-lock")) {
  const lock = acquireLockWithCleanup("strategy-review-loop", META_DIR);
  if (!lock.acquired) {
    appendLog(
      `[${new Date().toISOString()}] strategy-review-loop already running (pid ${lock.heldBy?.pid}) — exiting`,
    );
    process.exit(0);
  }
}

/** Reviewing a fleet with no live workers is pure spend — wait briefly, then exit. */
const MAX_DEAD_FLEET_CYCLES = 2;
const MAX_CONSECUTIVE_ERRORS = 5;

let deadFleetCycles = 0;
let errorStreak = 0;
while (true) {
  const manifest = loadManifest();
  if (manifest?.fleetCompletedAt) {
    appendLog(
      `[${new Date().toISOString()}] fleet completed at ${manifest.fleetCompletedAt} — exiting`,
    );
    process.exit(0);
  }
  if (fleetWorkersDead(manifest)) {
    deadFleetCycles += 1;
    appendLog(
      `[${new Date().toISOString()}] no live workers (${deadFleetCycles}/${MAX_DEAD_FLEET_CYCLES}) — skipping review`,
    );
    if (deadFleetCycles >= MAX_DEAD_FLEET_CYCLES) {
      appendLog(`[${new Date().toISOString()}] fleet has no live workers — exiting`);
      process.exit(0);
    }
    await sleep(intervalMs);
    continue;
  }
  deadFleetCycles = 0;

  try {
    await reviewOnce(params);
    errorStreak = 0;
  } catch (error) {
    errorStreak += 1;
    appendLog(
      `[${new Date().toISOString()}] error (${errorStreak}/${MAX_CONSECUTIVE_ERRORS}) ${error instanceof Error ? error.message : String(error)}`,
    );
    if (errorStreak >= MAX_CONSECUTIVE_ERRORS) {
      appendLog(`[${new Date().toISOString()}] persistent errors — exiting`);
      process.exit(1);
    }
  }
  await sleep(intervalMs);
}
