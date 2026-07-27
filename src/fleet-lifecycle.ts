import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { experimentsDir } from "./meta-home.js";
import { runFleetPreflight } from "./fleet-preflight.js";
import { stopFleetProcesses } from "./fleet-control.js";
import {
  FLEET_LOCK_NAMES,
  launchSelfImproveFleet,
  type FleetLauncher,
  type SelfImproveParams,
} from "./self-improve.js";
import { recordBudgetEvent, resetFleetRuntimeClock, resolveBudgetStatePath } from "./plan-budget.js";
import { pruneStaleLocks } from "./process-lock.js";
import type { SdkWorkerState } from "./sdk-worker.js";
import { readActiveAgiSession } from "./agi-mission.js";
import { resolveProjectRoot } from "./project-meta.js";

export const DEFAULT_FLEET_GOAL =
  "Autonomously ship verified progress toward the active mission. npm test on every tick. No architecture theater.";

export const DEFAULT_FLEET_DURATION_MS = 2 * 60 * 60 * 1000;

export interface FleetStopResult {
  stoppedPids: number[];
}

export interface FleetRuntimeResetResult {
  budgetReset: boolean;
}

export interface FleetResumeState {
  ok: boolean;
  checkpointPath?: string;
  tickCount?: number;
  stoppedBecause?: string;
}

const SDK_CHECKPOINT_RE = /^sdk-worker(-\d+)?\.json$/i;

function resolveExperimentsDir(metaDir?: string): string {
  if (!metaDir) return experimentsDir();
  return metaDir.endsWith("/experiments") || metaDir.endsWith("\\experiments")
    ? metaDir
    : join(metaDir, "experiments");
}

export function listSdkCheckpointPaths(experimentsDirPath: string): string[] {
  if (!existsSync(experimentsDirPath)) return [];
  return readdirSync(experimentsDirPath)
    .filter((name) => SDK_CHECKPOINT_RE.test(name))
    .map((name) => join(experimentsDirPath, name))
    .sort();
}

export function inspectFleetResumeState(metaDir?: string): FleetResumeState {
  const dir = resolveExperimentsDir(metaDir);
  for (const path of listSdkCheckpointPaths(dir)) {
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as SdkWorkerState;
      const tickCount = state.ticks?.length ?? 0;
      if (tickCount > 0) {
        return {
          ok: true,
          checkpointPath: path,
          tickCount,
          stoppedBecause: state.stoppedBecause,
        };
      }
    } catch {
      /* skip invalid checkpoint */
    }
  }
  return { ok: false };
}

export function defaultDashboardFleetParams(cwd: string, experimentsDirPath: string): SelfImproveParams {
  const active = readActiveAgiSession();
  const resolvedCwd = resolveProjectRoot(cwd);
  const goal =
    active && resolveProjectRoot(active.cwd) === resolvedCwd ? active.task : undefined;
  return {
    cwd,
    metaDir: experimentsDirPath,
    excludeSessionIndex: 1,
    workerSessionIndexes: [],
    workerMode: "sdk",
    parallelWorkers: 1,
    durationMs: DEFAULT_FLEET_DURATION_MS,
    goal: goal ?? DEFAULT_FLEET_GOAL,
    withOrchestrator: true,
    withWatcher: true,
    withStrategyReviewer: true,
    stopExisting: true,
  };
}

/** Stop fleet processes without wiping checkpoints or resetting the budget clock. */
export function stopFleet(options?: { metaDir?: string; source?: string }): FleetStopResult {
  const dir = resolveExperimentsDir(options?.metaDir);
  const { killed } = stopFleetProcesses(dir);
  recordBudgetEvent({
    at: new Date().toISOString(),
    action: "fleet_stop",
    source: options?.source ?? "dashboard_stop",
    detail: `Stopped ${killed.length} fleet process(es)`,
  });
  pruneStaleLocks(FLEET_LOCK_NAMES, dir);
  return { stoppedPids: killed };
}

/** Clear fleet runtime clock only — keeps checkpoints, logs, and manifest. */
export function resetFleetRuntime(_options?: { source?: string }): FleetRuntimeResetResult {
  resetFleetRuntimeClock(resolveBudgetStatePath());
  return { budgetReset: true };
}

async function assertPreflight(cwd: string): Promise<void> {
  const preflight = await runFleetPreflight({ cwd, skipSmokeTest: true });
  if (!preflight.ok) {
    throw new Error(preflight.failures.join("; "));
  }
}

/** Fresh fleet launch — stops prior processes, resets budget clock, new checkpoints. */
export async function startFleet(params: SelfImproveParams, launch: FleetLauncher = launchSelfImproveFleet) {
  await assertPreflight(params.cwd);
  return launch({
    ...params,
    stopExisting: true,
    freshStart: true,
    resumeWorkers: false,
  });
}

/** Relaunch watcher/strategy/worker from existing SDK checkpoint(s). */
export async function resumeFleet(params: SelfImproveParams, launch: FleetLauncher = launchSelfImproveFleet) {
  const resume = inspectFleetResumeState(params.metaDir);
  if (!resume.ok) {
    throw new Error("No SDK checkpoint to resume — use Start for a fresh fleet.");
  }
  await assertPreflight(params.cwd);
  return launch({
    ...params,
    stopExisting: true,
    freshStart: false,
    resumeWorkers: true,
  });
}
