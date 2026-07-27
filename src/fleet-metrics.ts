import { existsSync, readFileSync, statSync } from "node:fs";

import {
  allowedTestOnlyProductiveTicks,
  type TickOutcome,
} from "./tick-outcome.js";

export interface FleetTickMetrics {
  ticks: number;
  /** ticks minus soft skips — used by productivity gates. Present on analyzed metrics. */
  attemptedTicks?: number;
  productiveTicks: number;
  productiveRatio: number;
  /** Feature (non-test-only) ticks that counted toward productivity. */
  featureTicks?: number;
  /** Test-only ticks that counted toward productivity (capped). */
  countedTestOnlyTicks?: number;
  /** Test-only ticks blocked by the 1:3 cap. */
  cappedTestOnlyTicks?: number;
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
  /** True when the most recent tick pushed to origin. */
  lastPushed: boolean;
}

export interface WorkerCheckpointState {
  ticks?: Array<{
    at?: string;
    error?: string;
    skipped?: string;
    outcome?: TickOutcome & {
      producedWork?: boolean;
      committed?: boolean;
      pushed?: boolean;
      commits?: number;
      filesChanged?: number;
      tests?: { passed?: boolean };
    };
  }>;
  stoppedBecause?: string;
  startedAt?: string;
}

/** Mark whether a tick counts toward productivity metrics (test-only cap). */
export function markTickProductivity(outcome: TickOutcome, priorOutcomes: TickOutcome[]): void {
  let featureTicks = 0;
  let countedTestOnly = 0;
  for (const prior of priorOutcomes) {
    if (!prior.producedWork || prior.countsAsProductive === false) continue;
    if (prior.testOnly) countedTestOnly += 1;
    else featureTicks += 1;
  }

  if (!outcome.producedWork) {
    outcome.countsAsProductive = false;
    return;
  }
  if (outcome.testOnly) {
    outcome.countsAsProductive =
      countedTestOnly < allowedTestOnlyProductiveTicks(featureTicks);
  } else {
    outcome.countsAsProductive = true;
  }
}

export function productivityBreakdown(outcomes: TickOutcome[]): {
  productiveTicks: number;
  featureTicks: number;
  countedTestOnlyTicks: number;
  cappedTestOnlyTicks: number;
} {
  let featureTicks = 0;
  let countedTestOnlyTicks = 0;
  let cappedTestOnlyTicks = 0;
  let productiveTicks = 0;

  for (const outcome of outcomes) {
    if (!outcome.producedWork) continue;
    if (outcome.testOnly) {
      if (countedTestOnlyTicks < allowedTestOnlyProductiveTicks(featureTicks)) {
        productiveTicks += 1;
        countedTestOnlyTicks += 1;
      } else {
        cappedTestOnlyTicks += 1;
      }
    } else {
      productiveTicks += 1;
      featureTicks += 1;
    }
  }

  return { productiveTicks, featureTicks, countedTestOnlyTicks, cappedTestOnlyTicks };
}

export function analyzeWorkerCheckpoint(
  path: string | undefined,
  options?: { sessionStartedAt?: string },
): FleetTickMetrics | null {
  if (!path || !existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as WorkerCheckpointState;
    const sessionStartMs = options?.sessionStartedAt
      ? Date.parse(options.sessionStartedAt)
      : state.startedAt
        ? Date.parse(state.startedAt)
        : NaN;
    let ticks = state.ticks ?? [];
    if (Number.isFinite(sessionStartMs)) {
      ticks = ticks.filter((tick) => !tick.at || Date.parse(tick.at) >= sessionStartMs);
    }
    const outcomes = ticks
      .map((tick) => tick.outcome)
      .filter((outcome): outcome is NonNullable<typeof outcome> => outcome != null);
    const productivity = productivityBreakdown(outcomes);
    const productiveTicks = productivity.productiveTicks;
    const errors = ticks.filter((tick) => tick.error && tick.skipped == null).length;
    const softSkips = ticks.filter((tick) => tick.skipped != null).length;
    // Soft skips (busy/missing/timeout) are waits, not failed attempts — exclude from ratio.
    const attemptedTicks = ticks.length - softSkips;
    const last = ticks.at(-1);
    const stoppedBecause =
      ticks.length === 0 && state.stoppedBecause ? undefined : state.stoppedBecause;
    return {
      ticks: ticks.length,
      attemptedTicks: Math.max(0, attemptedTicks),
      productiveTicks,
      productiveRatio: attemptedTicks > 0 ? productiveTicks / attemptedTicks : 0,
      featureTicks: productivity.featureTicks,
      countedTestOnlyTicks: productivity.countedTestOnlyTicks,
      cappedTestOnlyTicks: productivity.cappedTestOnlyTicks,
      commits: outcomes.reduce((sum, outcome) => sum + (outcome.commits ?? 0), 0),
      filesChanged: outcomes.reduce((sum, outcome) => sum + (outcome.filesChanged ?? 0), 0),
      errors,
      softSkips,
      testFailures: outcomes.filter((outcome) => outcome.tests && outcome.tests.passed === false).length,
      stoppedBecause,
      lastTickAt: last?.at,
      lastError: last?.error,
      lastCommitted: last?.outcome?.committed === true,
      lastPushed: last?.outcome?.pushed === true,
    };
  } catch {
    return null;
  }
}

/** Minimum productive tick ratio before scaling or aggressive relaunch (honest loop gate). */
export const PRODUCTIVE_TICK_GATE = 0.3;

export function attemptedTickCount(metrics: FleetTickMetrics): number {
  if (typeof metrics.attemptedTicks === "number") return Math.max(0, metrics.attemptedTicks);
  return Math.max(0, metrics.ticks - metrics.softSkips);
}

export function meetsProductiveTickGate(metrics: FleetTickMetrics | null, minTicks = 3): boolean {
  if (!metrics || attemptedTickCount(metrics) < minTicks) return false;
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
  let sessionStartedAt: string | undefined;
  try {
    const state = JSON.parse(readFileSync(params.checkpointPath, "utf8")) as WorkerCheckpointState;
    sessionStartedAt = state.startedAt;
  } catch {
    /* fall through */
  }
  const metrics = analyzeWorkerCheckpoint(params.checkpointPath, { sessionStartedAt });
  const stallMs = params.stallMs ?? 90 * 60_000;
  const mtime = statSync(params.checkpointPath).mtimeMs;
  const lastTickMs = metrics?.lastTickAt ? Date.parse(metrics.lastTickAt) : NaN;
  const sessionStartMs = sessionStartedAt ? Date.parse(sessionStartedAt) : NaN;
  const baselineMs = Math.max(
    mtime,
    Number.isFinite(lastTickMs) ? lastTickMs : 0,
    Number.isFinite(sessionStartMs) ? sessionStartMs : 0,
  );
  const silentMs = Date.now() - baselineMs;
  if (silentMs < stallMs) return false;
  if (!metrics || attemptedTickCount(metrics) === 0) return false;
  return metrics.productiveRatio === 0;
}

export function relaunchBlockedReason(metrics: FleetTickMetrics | null, relaunchCount = 0): string | null {
  if (!metrics) return null;
  const attempted = attemptedTickCount(metrics);
  if (relaunchCount >= 2 && attempted >= 2 && metrics.productiveRatio === 0) {
    return "Zero productive ticks after repeated relaunches — fix auth/infra before relaunch";
  }
  if (attempted >= 5 && !meetsProductiveTickGate(metrics)) {
    return `Productive tick ratio ${(metrics.productiveRatio * 100).toFixed(0)}% below ${PRODUCTIVE_TICK_GATE * 100}% gate`;
  }
  return null;
}
