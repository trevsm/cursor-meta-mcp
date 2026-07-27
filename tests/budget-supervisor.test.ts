import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  countActiveWorkers,
  evaluateFleetSupervisor,
  shouldAllowRelaunch,
  type FleetManifest,
} from "../src/budget-supervisor.js";
import { loadBudgetState, saveBudgetState } from "../src/plan-budget.js";

function tempMetaDir(): string {
  return mkdtempSync(join(tmpdir(), "budget-supervisor-"));
}

test("countActiveWorkers includes sdk-worker experiments", () => {
  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [
      { name: "sdk-worker-1", pid: process.pid },
      { name: "strategy-review-loop", pid: process.pid },
    ],
  };
  assert.equal(countActiveWorkers(manifest), 1);
});

test("countActiveWorkers ignores supervisors", () => {
  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [
      { name: "worker-session-2", pid: process.pid },
      { name: "orchestrator-loop", pid: process.pid },
    ],
  };
  assert.equal(countActiveWorkers(manifest), 1);
});

test("evaluateFleetSupervisor blocks relaunch when budget blocked", () => {
  const metaDir = tempMetaDir();
  const budgetPath = join(metaDir, "plan-budget.json");
  process.env.CURSOR_META_BUDGET_PATH = budgetPath;

  const state = loadBudgetState(budgetPath);
  state.budgetBlocked = true;
  state.blockedReason = "hard cap";
  saveBudgetState(state, budgetPath);

  const manifest: FleetManifest = {
    at: new Date(Date.now() - 60_000).toISOString(),
    experiments: [{ name: "worker-session-2", pid: -1 }],
    budgetBlocked: true,
    budgetBlockedReason: "hard cap",
  };

  const decision = evaluateFleetSupervisor(manifest);
  assert.equal(decision.relaunchAllowed, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("hard cap")));

  delete process.env.CURSOR_META_BUDGET_PATH;
  rmSync(metaDir, { recursive: true, force: true });
});

test("shouldAllowRelaunch respects per-worker relaunch cap", () => {
  const metaDir = tempMetaDir();
  const budgetPath = join(metaDir, "plan-budget.json");
  process.env.CURSOR_META_BUDGET_PATH = budgetPath;

  const state = loadBudgetState(budgetPath);
  state.limits.maxRelaunchesPerWorker = 2;
  saveBudgetState(state, budgetPath);

  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [],
  };
  const exp = { name: "worker-session-2", pid: -1, relaunchCount: 2 };

  const gate = shouldAllowRelaunch(manifest, exp);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /relaunch cap/i);

  delete process.env.CURSOR_META_BUDGET_PATH;
  rmSync(metaDir, { recursive: true, force: true });
});

test("evaluateFleetSupervisor kills workers when fleet max duration exceeded", () => {
  const metaDir = tempMetaDir();
  const budgetPath = join(metaDir, "plan-budget.json");
  process.env.CURSOR_META_BUDGET_PATH = budgetPath;

  const state = loadBudgetState(budgetPath);
  state.limits.maxFleetDurationMs = 60_000;
  saveBudgetState(state, budgetPath);

  const manifest: FleetManifest = {
    at: new Date(Date.now() - 120_000).toISOString(),
    experiments: [{ name: "worker-dedicated", pid: process.pid }],
  };

  const decision = evaluateFleetSupervisor(manifest);
  assert.equal(decision.killWorkers, true);
  assert.ok(decision.snapshot.fleet?.percentOfMaxDuration >= 100);

  delete process.env.CURSOR_META_BUDGET_PATH;
  rmSync(metaDir, { recursive: true, force: true });
});
