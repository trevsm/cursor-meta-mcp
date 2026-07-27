import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  countActiveWorkers,
  evaluateFleetSupervisor,
  loadFleetManifest,
  type FleetExperiment,
} from "./budget-supervisor.js";
import { runConsciousnessPulse } from "./consciousness-pulse.js";
import { readDedicatedWorker } from "./fleet-control.js";
import { getBudgetSnapshot, loadBudgetState } from "./plan-budget.js";
import { readCheckpoint, summarizeLongSession, type LongSessionState } from "./long-session.js";

export interface DashboardLogSource {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface DashboardExperimentRow {
  name: string;
  pid: number;
  alive: boolean;
  sessionId?: string;
  sessionIndex?: number;
  checkpointPath?: string;
  logPath?: string;
  relaunchCount?: number;
  checkpoint?: {
    exists: boolean;
    ticks?: number;
    stoppedBecause?: string | null;
    lastTick?: LongSessionState["ticks"][number] | null;
    summary?: ReturnType<typeof summarizeLongSession>;
  };
}

export interface DashboardSnapshot {
  at: string;
  metaDir: string;
  manifest: ReturnType<typeof loadFleetManifest>;
  fleetHealth: {
    total: number;
    alive: number;
    watcherAlive: boolean;
    strategyReviewerAlive: boolean;
    manifestAt: string | null;
    staleManifest: boolean;
  };
  supervisor: ReturnType<typeof evaluateFleetSupervisor>;
  budget: ReturnType<typeof getBudgetSnapshot>;
  watchStatus: Record<string, unknown> | null;
  strategyStatus: Record<string, unknown> | null;
  pulse: ReturnType<typeof runConsciousnessPulse> | { error: string };
  experiments: DashboardExperimentRow[];
  logs: DashboardLogSource[];
  dedicatedWorker: { sessionId?: string; sessionIndex?: number | null } | null;
}

export function defaultMetaDir(): string {
  return join(homedir(), ".cursor-meta");
}

export function defaultExperimentsDir(metaDir = defaultMetaDir()): string {
  return join(metaDir, "experiments");
}

export function readJsonSafe<T = Record<string, unknown>>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tailFile(path: string, maxLines = 80): string {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

export function listLogSources(experimentsDir: string): DashboardLogSource[] {
  if (!existsSync(experimentsDir)) return [];
  const entries: DashboardLogSource[] = [];
  for (const name of readdirSync(experimentsDir)) {
    if (!name.endsWith(".log")) continue;
    const path = join(experimentsDir, name);
    try {
      const stat = statSync(path);
      entries.push({
        name: basename(name, ".log"),
        path,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      /* skip */
    }
  }
  return entries.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

function summarizeCheckpoint(path?: string): DashboardExperimentRow["checkpoint"] {
  if (!path || !existsSync(path)) return { exists: false };
  try {
    const state = readCheckpoint(path);
    const lastTick = state.ticks.at(-1) ?? null;
    return {
      exists: true,
      ticks: state.ticks.length,
      stoppedBecause: state.stoppedBecause ?? null,
      lastTick,
      summary: summarizeLongSession({
        ...state,
        endedAt: lastTick?.at ?? state.startedAt,
        elapsedMs: 0,
        checkpointPath: path,
        stoppedBecause: state.stoppedBecause ?? "duration",
      }),
    };
  } catch {
    return { exists: true, ticks: 0, stoppedBecause: null, lastTick: null };
  }
}

export function buildExperimentRows(
  experiments: FleetExperiment[],
  watchStatus: Record<string, unknown> | null,
): DashboardExperimentRow[] {
  const watchByName = new Map<string, Record<string, unknown>>();
  const watchExperiments = Array.isArray(watchStatus?.experiments)
    ? (watchStatus!.experiments as Record<string, unknown>[])
    : [];
  for (const row of watchExperiments) {
    if (typeof row.name === "string") watchByName.set(row.name, row);
  }

  return experiments.map((exp) => {
    const watch = watchByName.get(exp.name);
    const alive = pidAlive(exp.pid);
    const checkpointFromWatch =
      watch?.checkpoint && typeof watch.checkpoint === "object"
        ? (watch.checkpoint as DashboardExperimentRow["checkpoint"])
        : undefined;

    return {
      name: exp.name,
      pid: exp.pid,
      alive,
      sessionId: exp.sessionId,
      sessionIndex: exp.sessionIndex,
      checkpointPath: exp.checkpointPath,
      logPath: exp.logPath,
      relaunchCount: exp.relaunchCount,
      checkpoint: checkpointFromWatch ?? summarizeCheckpoint(exp.checkpointPath),
    };
  });
}

export function collectDashboardSnapshot(options?: {
  metaDir?: string;
  workspace?: string;
  pulseLimit?: number;
}): DashboardSnapshot {
  const metaDir = options?.metaDir ?? defaultMetaDir();
  const experimentsDir = join(metaDir, "experiments");
  const manifest = loadFleetManifest(experimentsDir);
  const state = loadBudgetState(join(metaDir, "plan-budget.json"));
  const activeWorkers = countActiveWorkers(manifest);
  const fleetStartedAt = manifest?.at ?? state.fleetStartedAt;
  const budget = getBudgetSnapshot(state, { activeWorkers, fleetStartedAt });
  const supervisor = evaluateFleetSupervisor(manifest);
  const watchStatus = readJsonSafe(join(experimentsDir, "watch-status.json"));
  const strategyStatus = readJsonSafe(join(experimentsDir, "strategy-status.json"));

  let pulse: DashboardSnapshot["pulse"];
  try {
    pulse = runConsciousnessPulse({
      limit: options?.pulseLimit ?? 25,
      workspace: options?.workspace,
    });
  } catch (error) {
    pulse = { error: error instanceof Error ? error.message : String(error) };
  }

  const experiments = buildExperimentRows(manifest?.experiments ?? [], watchStatus);
  const dedicatedWorker = readDedicatedWorker(experimentsDir);

  const aliveCount = experiments.filter((row) => row.alive).length;
  const manifestAt = manifest?.at ?? null;
  const manifestAgeMs = manifestAt ? Date.now() - Date.parse(manifestAt) : null;
  const staleManifest = aliveCount === 0 && (manifestAgeMs ?? 0) > 5 * 60_000;

  return {
    at: new Date().toISOString(),
    metaDir,
    manifest,
    fleetHealth: {
      total: experiments.length,
      alive: aliveCount,
      watcherAlive: pidAlive(manifest?.watcherPid),
      strategyReviewerAlive: pidAlive(manifest?.strategyReviewerPid),
      manifestAt,
      staleManifest,
    },
    supervisor,
    budget,
    watchStatus,
    strategyStatus,
    pulse,
    experiments,
    logs: listLogSources(experimentsDir),
    dedicatedWorker,
  };
}
