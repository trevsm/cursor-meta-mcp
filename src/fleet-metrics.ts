import { existsSync, readFileSync, statSync } from "node:fs";

export interface FleetTickMetrics {
  ticks: number;
  productiveTicks: number;
  productiveRatio: number;
  commits: number;
  filesChanged: number;
  errors: number;
  softSkips: number;
  testFailures: number;
  stoppedBecause?: string;
  lastTickAt?: string;
  lastError?: string;
  /** True when the most recent tick produced a commit (merge gate). */
  lastCommitted: boolean;
}

export interface WorkerCheckpointState {
  ticks?: Array<{
    at?: string;
    error?: string;
    skipped?: string;
    outcome?: {
      producedWork?: boolean;
      committed?: boolean;
      commits?: number;
      filesChanged?: number;
      tests?: { passed?: boolean };
    };
  }>;
  stoppedBecause?: string;
  startedAt?: string;
}

export function analyzeWorkerCheckpoint(path: string | undefined): FleetTickMetrics | null {
  if (!path || !existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as WorkerCheckpointState;
    const ticks = state.ticks ?? [];
    const outcomes = ticks
      .map((tick) => tick.outcome)
      .filter((outcome): outcome is NonNullable<typeof outcome> => outcome != null);
    const productiveTicks = outcomes.filter((outcome) => outcome.producedWork).length;
    const errors = ticks.filter((tick) => tick.error && tick.skipped == null).length;
    const softSkips = ticks.filter((tick) => tick.skipped != null).length;
    const last = ticks.at(-1);
    return {
      ticks: ticks.length,
      productiveTicks,
      productiveRatio: ticks.length > 0 ? productiveTicks / ticks.length : 0,
      commits: outcomes.reduce((sum, outcome) => sum + (outcome.commits ?? 0), 0),
      filesChanged: outcomes.reduce((sum, outcome) => sum + (outcome.filesChanged ?? 0), 0),
      errors,
      softSkips,
      testFailures: outcomes.filter((outcome) => outcome.tests && outcome.tests.passed === false).length,
      stoppedBecause: state.stoppedBecause,
      lastTickAt: last?.at,
      lastError: last?.error,
      lastCommitted: last?.outcome?.committed === true,
    };
  } catch {
    return null;
  }
}

/** Minimum productive tick ratio before scaling or aggressive relaunch (honest loop gate). */
export const PRODUCTIVE_TICK_GATE = 0.3;

export function meetsProductiveTickGate(metrics: FleetTickMetrics | null, minTicks = 3): boolean {
  if (!metrics || metrics.ticks < minTicks) return false;
  return metrics.productiveRatio >= PRODUCTIVE_TICK_GATE;
}

export function isWorkerStalled(params: {
  pidAlive: boolean;
  checkpointPath?: string;
  stallMs?: number;
}): boolean {
  if (!params.pidAlive || !params.checkpointPath || !existsSync(params.checkpointPath)) {
    return false;
  }
  const metrics = analyzeWorkerCheckpoint(params.checkpointPath);
  const stallMs = params.stallMs ?? 90 * 60_000;
  const mtime = statSync(params.checkpointPath).mtimeMs;
  const lastTickMs = metrics?.lastTickAt ? Date.parse(metrics.lastTickAt) : NaN;
  const silentMs = Date.now() - Math.max(mtime, Number.isFinite(lastTickMs) ? lastTickMs : 0);
  if (silentMs < stallMs) return false;
  return !metrics || metrics.productiveRatio === 0;
}

export function relaunchBlockedReason(metrics: FleetTickMetrics | null, relaunchCount = 0): string | null {
  if (!metrics) return null;
  if (relaunchCount >= 2 && metrics.ticks >= 2 && metrics.productiveRatio === 0) {
    return "Zero productive ticks after repeated relaunches — fix auth/infra before relaunch";
  }
  if (metrics.ticks >= 5 && !meetsProductiveTickGate(metrics)) {
    return `Productive tick ratio ${(metrics.productiveRatio * 100).toFixed(0)}% below ${PRODUCTIVE_TICK_GATE * 100}% gate`;
  }
  return null;
}
