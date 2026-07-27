import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { experimentsDir } from "./meta-home.js";
import {
  blockBudget,
  getBudgetSnapshot,
  loadBudgetState,
  type BudgetSnapshot,
  writeBudgetStatus,
} from "./plan-budget.js";

export interface FleetExperiment {
  name: string;
  pid: number;
  sessionId?: string;
  sessionIndex?: number;
  checkpointPath?: string;
  logPath?: string;
  command?: string;
  relaunchCount?: number;
}

export interface FleetManifest {
  at: string;
  root?: string;
  goal?: string;
  experiments: FleetExperiment[];
  watcherPid?: number;
  /** Top-level strategy reviewer pid (also listed under experiments). */
  strategyReviewerPid?: number;
  budgetBlocked?: boolean;
  budgetBlockedAt?: string;
  budgetBlockedReason?: string;
}

export interface SupervisorDecision {
  snapshot: BudgetSnapshot;
  relaunchAllowed: boolean;
  killWorkers: boolean;
  killOrchestrator: boolean;
  reasons: string[];
  killedPids: number[];
}

const SUPERVISOR_NAMES = new Set(["orchestrator-loop", "strategy-review-loop", "watch-experiments"]);

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function isWorkerExperiment(name: string): boolean {
  return name.startsWith("worker-") || name.startsWith("sdk-worker");
}

export function loadFleetManifest(metaDir?: string): FleetManifest | null {
  const dir = metaDir ?? experimentsDir();
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FleetManifest;
  } catch {
    return null;
  }
}

export function saveFleetManifest(manifest: FleetManifest, metaDir?: string): void {
  const dir = metaDir ?? experimentsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

export function countActiveWorkers(manifest: FleetManifest | null): number {
  if (!manifest) return 0;
  return manifest.experiments.filter(
    (exp) => isWorkerExperiment(exp.name) && pidAlive(exp.pid),
  ).length;
}

export function evaluateFleetSupervisor(manifest: FleetManifest | null): SupervisorDecision {
  const state = loadBudgetState();
  const activeWorkers = countActiveWorkers(manifest);
  const fleetStartedAt = manifest?.at ?? state.fleetStartedAt;
  const snapshot = getBudgetSnapshot(state, { activeWorkers, fleetStartedAt });

  const reasons: string[] = [...snapshot.warnings];
  let relaunchAllowed = !snapshot.blockedActions.includes("relaunch_worker");
  let killWorkers = false;
  let killOrchestrator = false;

  if (manifest?.budgetBlocked || state.budgetBlocked) {
    relaunchAllowed = false;
    killWorkers = activeWorkers > 0;
    reasons.push(manifest?.budgetBlockedReason ?? state.blockedReason ?? "Budget already blocked");
  }

  if (snapshot.fleet && snapshot.fleet.percentOfMaxDuration >= 100) {
    relaunchAllowed = false;
    killWorkers = true;
    reasons.push("Fleet max duration reached");
  }

  if (snapshot.status === "blocked") {
    relaunchAllowed = false;
    if (activeWorkers > 0 && snapshot.blockedActions.includes("relaunch_worker")) {
      killWorkers = true;
      reasons.push("Budget hard block — stopping workers");
    }
  }

  const totalRelaunches = manifest?.experiments.reduce((sum, exp) => sum + (exp.relaunchCount ?? 0), 0) ?? 0;
  if (totalRelaunches >= state.limits.maxRelaunchesPerWorker * Math.max(1, activeWorkers)) {
    relaunchAllowed = false;
    reasons.push(`Per-worker relaunch cap exceeded (${totalRelaunches})`);
  }

  return {
    snapshot,
    relaunchAllowed,
    killWorkers,
    killOrchestrator,
    reasons: [...new Set(reasons)],
    killedPids: [],
  };
}

export function enforceSupervisorDecision(
  manifest: FleetManifest | null,
  decision: SupervisorDecision,
): SupervisorDecision {
  if (!manifest || (!decision.killWorkers && !decision.killOrchestrator)) {
    writeBudgetStatus(decision.snapshot);
    return decision;
  }

  const killed: number[] = [];
  for (const exp of manifest.experiments) {
    const isSupervisor = SUPERVISOR_NAMES.has(exp.name);
    const isWorker = isWorkerExperiment(exp.name);
    const shouldKill =
      (decision.killWorkers && isWorker) || (decision.killOrchestrator && isSupervisor);
    if (shouldKill && killPid(exp.pid)) {
      killed.push(exp.pid);
      exp.pid = -1;
    }
  }

  if (decision.killWorkers) {
    blockBudget(decision.reasons.join("; ") || "Budget supervisor killed workers");
    manifest.budgetBlocked = true;
    manifest.budgetBlockedAt = new Date().toISOString();
    manifest.budgetBlockedReason = decision.reasons.join("; ") || "Budget exceeded";
    saveFleetManifest(manifest);
  }

  const refreshed = evaluateFleetSupervisor(manifest);
  writeBudgetStatus(refreshed.snapshot);
  return { ...refreshed, killedPids: killed };
}

export function shouldAllowRelaunch(
  manifest: FleetManifest | null,
  experiment: FleetExperiment,
): { allowed: boolean; reason?: string; snapshot: BudgetSnapshot } {
  const decision = evaluateFleetSupervisor(manifest);
  if (!decision.relaunchAllowed) {
    return { allowed: false, reason: decision.reasons[0], snapshot: decision.snapshot };
  }

  const relaunches = experiment.relaunchCount ?? 0;
  if (relaunches >= loadBudgetState().limits.maxRelaunchesPerWorker) {
    return {
      allowed: false,
      reason: `Worker ${experiment.name} hit relaunch cap (${relaunches})`,
      snapshot: decision.snapshot,
    };
  }

  return { allowed: true, snapshot: decision.snapshot };
}
