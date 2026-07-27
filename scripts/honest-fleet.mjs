#!/usr/bin/env node
/**
 * Honest loop fleet — one locked SDK worker in an isolated worktree.
 * Requires CURSOR_API_KEY; exits before spawn when the key is missing.
 *
 * Env: CURSOR_META_FLEET_CWD, CURSOR_META_FLEET_FILTER (@faciliq/web),
 *      CURSOR_META_FLEET_VERIFY (test,lint), CURSOR_META_FLEET_GOAL
 *      CURSOR_META_CI_VALIDATOR (local|github, default local on external repos)
 *      CURSOR_META_CI_WATCH (1|0, default 1 on external — watch-only, never gates ticks)
 */
import {
  FLEET_FILTER_ENV,
  FLEET_VERIFY_SCRIPTS_ENV,
  fleetTargetWarning,
  resolveFleetTargetCwd,
} from "../src/fleet-target.js";
import { defaultHonestFleetGoal } from "../src/fleet-commit-policy.js";
import { launchSelfImproveFleet } from "../src/self-improve.js";
import { runFleetPreflight } from "../src/fleet-preflight.js";
import { resolveHonestWorkerMode, workerAuthHint } from "../src/worker-auth.js";

const cwd = resolveFleetTargetCwd(process.argv[2]);
const goal =
  process.env.CURSOR_META_FLEET_GOAL?.trim() ||
  process.argv.slice(3).join(" ").trim() ||
  defaultHonestFleetGoal(cwd);
const targetWarning = fleetTargetWarning(cwd);
if (targetWarning) console.error(`[honest-fleet] warn: ${targetWarning}`);

const preflight = await runFleetPreflight({ cwd, skipSmokeTest: true });
for (const warning of preflight.warnings) console.error(`[honest-fleet] warn: ${warning}`);
if (!preflight.ok) {
  for (const failure of preflight.failures) console.error(`[honest-fleet] ${failure}`);
  process.exit(1);
}

const auth = preflight.auth;
const mode = await resolveHonestWorkerMode("sdk");
console.error(`[honest-fleet] preflight auth=${JSON.stringify(auth)} resolvedMode=${mode}`);
console.error(`[honest-fleet] target=${cwd}`);
if (process.env[FLEET_FILTER_ENV]?.trim()) {
  console.error(`[honest-fleet] filter=${process.env[FLEET_FILTER_ENV].trim()}`);
}
if (process.env[FLEET_VERIFY_SCRIPTS_ENV]?.trim()) {
  console.error(`[honest-fleet] verify=${process.env[FLEET_VERIFY_SCRIPTS_ENV].trim()}`);
}
console.error(`[honest-fleet] ${workerAuthHint(auth)}`);
if (!auth.apiKey) {
  console.error(
    "[honest-fleet] CURSOR_API_KEY is required for SDK workers. Uncomment and set it in ~/.cursor/.env",
  );
  console.error("[honest-fleet] Create a key: https://cursor.com/dashboard/integrations?tab=api-keys");
  process.exit(1);
}

const manifest = await launchSelfImproveFleet({
  cwd,
  excludeSessionIndex: 1,
  workerSessionIndexes: [],
  workerMode: "sdk",
  parallelWorkers: 1,
  durationMs: 2 * 60 * 60 * 1000,
  goal,
  withOrchestrator: false,
  withWatcher: true,
  withStrategyReviewer: true,
});

console.log(JSON.stringify(manifest, null, 2));
