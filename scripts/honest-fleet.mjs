#!/usr/bin/env node
/**
 * Honest loop fleet — one locked SDK worker in an isolated worktree.
 *
 * Phase 1: prove ground-truth ticks (git + test:fast) before scaling parallelism.
 */
import { launchSelfImproveFleet } from "../src/self-improve.js";

const cwd = process.argv[2] ?? process.cwd();

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
