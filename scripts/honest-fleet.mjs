#!/usr/bin/env node
/**
 * Honest loop fleet — one locked SDK worker in an isolated worktree.
 * Requires CURSOR_API_KEY; exits before spawn when the key is missing.
 *
 * Prefer an external repo: export CURSOR_META_FLEET_CWD=/path/to/your-app
 */
import { fleetTargetWarning, resolveFleetTargetCwd } from "../src/fleet-target.js";
import { launchSelfImproveFleet } from "../src/self-improve.js";
import { runFleetPreflight } from "../src/fleet-preflight.js";
import { resolveHonestWorkerMode, workerAuthHint } from "../src/worker-auth.js";

const cwd = resolveFleetTargetCwd(process.argv[2]);
const goal =
  process.env.CURSOR_META_FLEET_GOAL?.trim() ||
  process.argv.slice(3).join(" ").trim() ||
  "One verified diff per tick: verify → commit → push. Structured tick report required.";
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
