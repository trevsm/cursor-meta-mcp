import type { HumanGateMode } from "./human-gate.js";

export type { HumanGateMode };

/** Runtime orchestration topology for AGI mode on one project. */
export interface AgiArchitecture {
  workerMode: "ide" | "sdk" | "hybrid";
  parallelWorkers: number;
  withOrchestrator: boolean;
  withWatcher: boolean;
  withStrategyReviewer: boolean;
  strategyReviewIntervalMs: number;
  /** Conductor may patch cursor-meta-mcp / fleet infra when that layer is the blocker. */
  allowMetaToolingChanges: boolean;
  /** Cap topology mutations per hour (ATM-style bounded mutation). */
  maxAdaptationsPerHour: number;
  /** Human-in-the-loop gate strictness (HumanLayer / CodeLayer). */
  humanGateMode: HumanGateMode;
}

export interface AgiAdaptationRecord {
  at: string;
  trigger: string;
  layer: "mission" | "worker" | "orchestration" | "verification" | "meta_tooling";
  summary: string;
  before: Partial<AgiArchitecture>;
  after: Partial<AgiArchitecture>;
  missionPivot?: string;
}

export type AgiAdaptationLayer = AgiAdaptationRecord["layer"];

export const DEFAULT_AGI_ARCHITECTURE: AgiArchitecture = {
  workerMode: "sdk",
  parallelWorkers: 1,
  withOrchestrator: true,
  withWatcher: true,
  withStrategyReviewer: true,
  strategyReviewIntervalMs: 5 * 60_000,
  allowMetaToolingChanges: true,
  maxAdaptationsPerHour: 6,
  humanGateMode: "standard",
};

export function mergeAgiArchitecture(
  base: AgiArchitecture,
  patch?: Partial<AgiArchitecture>,
): AgiArchitecture {
  if (!patch) return { ...base };
  return {
    ...base,
    ...patch,
    parallelWorkers: Math.max(0, Math.min(8, patch.parallelWorkers ?? base.parallelWorkers)),
    strategyReviewIntervalMs: Math.max(
      60_000,
      Math.min(3_600_000, patch.strategyReviewIntervalMs ?? base.strategyReviewIntervalMs),
    ),
  };
}
