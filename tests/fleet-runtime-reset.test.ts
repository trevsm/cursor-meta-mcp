import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const metaDir = mkdtempSync(join(tmpdir(), "fleet-runtime-reset-"));
process.env.CURSOR_META_HOME = metaDir;

const { resetFleetRuntime } = await import("../src/fleet-lifecycle.js");
const { loadBudgetState, resetFleetRuntimeClock } = await import("../src/plan-budget.js");

test("resetFleetRuntimeClock clears only runtime fields", () => {
  const path = join(metaDir, "plan-budget.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...loadBudgetState(path),
      fleetStartedAt: new Date().toISOString(),
      fleetStoppedAt: new Date().toISOString(),
      fleetAccumulatedMs: 3_600_000,
      relaunchCount: 2,
      budgetBlocked: true,
      blockedReason: "max duration",
      ideTicks: 5,
    }),
  );

  resetFleetRuntimeClock(path);
  const budget = loadBudgetState(path);
  assert.equal(budget.fleetStartedAt, undefined);
  assert.equal(budget.fleetStoppedAt, undefined);
  assert.equal(budget.fleetAccumulatedMs, undefined);
  assert.equal(budget.relaunchCount, 2);
  assert.equal(budget.budgetBlocked, true);
  assert.equal(budget.ideTicks, 5);
});

test("resetFleetRuntime keeps checkpoints and logs", () => {
  const experimentsDir = join(metaDir, "experiments");
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(join(experimentsDir, "sdk-worker-1.json"), JSON.stringify({ ticks: [{ tick: 1 }] }));
  writeFileSync(join(experimentsDir, "watch.log"), "log data\n");

  const result = resetFleetRuntime();
  assert.equal(result.budgetReset, true);
  assert.ok(existsSync(join(experimentsDir, "sdk-worker-1.json")));
  assert.ok(existsSync(join(experimentsDir, "watch.log")));
  assert.equal(loadBudgetState(join(metaDir, "plan-budget.json")).fleetStartedAt, undefined);
});
