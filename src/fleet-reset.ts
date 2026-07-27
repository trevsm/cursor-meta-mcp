import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { saveFleetManifest } from "./budget-supervisor.js";
import { stopFleetProcesses } from "./fleet-control.js";
import { metaHome } from "./meta-home.js";
import { recordBudgetEvent, resetFleetBudgetUsage, resolveBudgetStatePath } from "./plan-budget.js";
import { pruneStaleLocks } from "./process-lock.js";

export interface FleetResetResult {
  stoppedPids: number[];
  removedFiles: string[];
  budgetReset: boolean;
}

function shouldRemoveExperimentArtifact(name: string): boolean {
  if (name.endsWith(".log")) return true;
  if (name === "watch-status.json" || name === "strategy-status.json") return true;
  if (/^sdk-worker.*\.json$/i.test(name)) return true;
  return false;
}

/** Stop fleet processes and clear dashboard-visible experiment artifacts. */
export function wipeFleetDashboardState(options?: {
  metaDir?: string;
  root?: string;
}): FleetResetResult {
  const meta = options?.metaDir ?? metaHome();
  const experimentsDir = join(meta, "experiments");
  const budgetPath = resolveBudgetStatePath(meta);
  const { killed: stoppedPids } = stopFleetProcesses(experimentsDir);

  resetFleetBudgetUsage(budgetPath);
  recordBudgetEvent(
    {
      at: new Date().toISOString(),
      action: "fleet_stop",
      source: "dashboard_reset",
      detail: "Dashboard reset wiped fleet experiment artifacts",
    },
    undefined,
    budgetPath,
  );
  pruneStaleLocks(["watch-experiments", "strategy-review-loop", "fleet-launch"], experimentsDir);

  const removedFiles: string[] = [];
  if (existsSync(experimentsDir)) {
    for (const name of readdirSync(experimentsDir)) {
      if (!shouldRemoveExperimentArtifact(name)) continue;
      const path = join(experimentsDir, name);
      try {
        unlinkSync(path);
        removedFiles.push(name);
      } catch {
        /* skip locked files */
      }
    }
  }

  saveFleetManifest(
    {
      at: new Date().toISOString(),
      root: options?.root,
      experiments: [],
      watcherPid: -1,
      strategyReviewerPid: -1,
      budgetBlocked: false,
    },
    experimentsDir,
  );

  return { stoppedPids, removedFiles, budgetReset: true };
}
