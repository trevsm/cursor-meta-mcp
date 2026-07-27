#!/usr/bin/env node
/**
 * Launch autonomous experiment fleet for cursor-meta-mcp.
 */
import { launchSelfImproveFleet } from "../src/self-improve.js";

const ROOT = "/Users/trevorsmith/Projects/cursor-meta-mcp";

const manifest = await launchSelfImproveFleet({
  cwd: ROOT,
  excludeSessionIndex: 1,
  /** Dedicated worker only — do not attach to stale tab indexes (they shift every new chat). */
  workerSessionIndexes: [],
  durationMs: 2 * 60 * 60 * 1000,
  goal: "Autonomously improve cursor-meta-mcp with verified npm test on every tick. No architecture theater.",
  withOrchestrator: true,
  withWatcher: true,
  withStrategyReviewer: true,
});

console.log(JSON.stringify(manifest, null, 2));
