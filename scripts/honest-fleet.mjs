#!/usr/bin/env node
/**
 * Honest loop fleet — one locked SDK worker in an isolated worktree.
 * Requires CURSOR_API_KEY; exits before spawn when the key is missing.
 */
import { launchSelfImproveFleet } from "../src/self-improve.js";
import { runFleetPreflight } from "../src/fleet-preflight.js";
import { resolveHonestWorkerMode, workerAuthHint } from "../src/worker-auth.js";

const cwd = process.argv[2] ?? process.cwd();

const preflight = await runFleetPreflight({ cwd, skipSmokeTest: true });
for (const warning of preflight.warnings) console.error(`[honest-fleet] warn: ${warning}`);
if (!preflight.ok) {
  for (const failure of preflight.failures) console.error(`[honest-fleet] ${failure}`);
  process.exit(1);
}

const auth = preflight.auth;
const mode = await resolveHonestWorkerMode("sdk");
console.error(`[honest-fleet] preflight auth=${JSON.stringify(auth)} resolvedMode=${mode}`);
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
  goal: "One verified diff per tick: npm run test:fast → commit → push. No false completion claims.",
  withOrchestrator: false,
  withWatcher: true,
  withStrategyReviewer: true,
});

console.log(JSON.stringify(manifest, null, 2));
