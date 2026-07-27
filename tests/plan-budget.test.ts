import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertBudgetAllowed,
  BudgetExceededError,
  checkBudgetGate,
  defaultBudgetLimits,
  getBudgetSnapshot,
  loadBudgetState,
  recordBudgetEvent,
  recordSpawn,
  saveBudgetState,
  setPlanUsage,
  resetFleetBudgetClock,
} from "../src/plan-budget.js";

function tempBudgetPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-budget-"));
  return join(dir, "budget.json");
}

test("defaultBudgetLimits reads env overrides", () => {
  const prev = process.env.CURSOR_META_MAX_CONCURRENT_WORKERS;
  process.env.CURSOR_META_MAX_CONCURRENT_WORKERS = "2";
  try {
    assert.equal(defaultBudgetLimits().maxConcurrentWorkers, 2);
  } finally {
    if (prev == null) delete process.env.CURSOR_META_MAX_CONCURRENT_WORKERS;
    else process.env.CURSOR_META_MAX_CONCURRENT_WORKERS = prev;
  }
});

test("recordSpawn tracks hourly spawn rate", () => {
  const path = tempBudgetPath();
  recordSpawn("spawn_sdk", "test", path);
  recordSpawn("spawn_sdk", "test", path);
  const state = loadBudgetState(path);
  const snapshot = getBudgetSnapshot(state);
  assert.equal(snapshot.local.spawnsLastHour, 2);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("plan usage percent blocks spawns at threshold", () => {
  const path = tempBudgetPath();
  const state = loadBudgetState(path);
  state.limits.blockAtPercent = 90;
  state.planRequestLimit = 100;
  state.planUsedRequests = 95;
  saveBudgetState(state, path);

  const gate = checkBudgetGate("spawn_sdk", loadBudgetState(path));
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /90|95|limit/i);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("setPlanUsage updates snapshot plan section", () => {
  const path = tempBudgetPath();
  process.env.CURSOR_META_BUDGET_PATH = path;
  try {
    setPlanUsage(42, 500, "manual");
    const snapshot = getBudgetSnapshot(loadBudgetState(path));
    assert.deepEqual(snapshot.plan, {
      used: 42,
      limit: 500,
      percent: 8.4,
      source: "manual",
    });
  } finally {
    delete process.env.CURSOR_META_BUDGET_PATH;
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("assertBudgetAllowed throws BudgetExceededError when blocked", () => {
  const path = tempBudgetPath();
  const state = loadBudgetState(path);
  state.budgetBlocked = true;
  state.blockedReason = "supervisor stop";
  saveBudgetState(state, path);

  assert.throws(
    () => assertBudgetAllowed("spawn_sdk", loadBudgetState(path)),
    (error: unknown) => {
      assert.ok(error instanceof BudgetExceededError);
      assert.match(error.message, /supervisor stop/);
      return true;
    },
  );
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("run_complete accumulates duration and estimated cents", () => {
  const path = tempBudgetPath();
  recordBudgetEvent(
    {
      at: new Date().toISOString(),
      action: "run_complete",
      durationMs: 12_000,
      estimatedCents: 7,
    },
    undefined,
    path,
  );
  const snapshot = getBudgetSnapshot(loadBudgetState(path));
  assert.equal(snapshot.local.sdkRuns, 1);
  assert.equal(snapshot.local.sdkDurationMs, 12_000);
  assert.equal(snapshot.local.estimatedCents, 7);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("resetFleetBudgetClock clears fleet clock and block flags", () => {
  const path = tempBudgetPath();
  const state = loadBudgetState(path);
  state.fleetStartedAt = new Date().toISOString();
  state.relaunchCount = 3;
  state.budgetBlocked = true;
  state.blockedReason = "max duration";
  state.events.push(
    { at: new Date().toISOString(), action: "spawn_sdk", source: "test" },
    { at: new Date().toISOString(), action: "relaunch_worker", source: "test" },
  );
  saveBudgetState(state, path);

  const reset = resetFleetBudgetClock(path);
  assert.equal(reset.fleetStartedAt, undefined);
  assert.equal(reset.relaunchCount, 0);
  assert.equal(reset.budgetBlocked, false);
  assert.equal(reset.blockedReason, undefined);
  assert.equal(
    reset.events.filter((event) => event.action === "spawn_sdk" || event.action === "relaunch_worker").length,
    0,
  );
  rmSync(join(path, ".."), { recursive: true, force: true });
});
