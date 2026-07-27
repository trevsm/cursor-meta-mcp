import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

// plan-budget and process-lock run for real against temp paths; mocking them
// zeroes their coverage attribution for the whole suite.
const budgetDir = mkdtempSync(join(tmpdir(), "fleet-life-budget-"));
process.env.CURSOR_META_BUDGET_PATH = join(budgetDir, "budget.json");

const stopFleetProcesses = mock.fn(() => ({ killed: [123], manifest: null }));
const launchSelfImproveFleet = mock.fn(async (params: { freshStart?: boolean; resumeWorkers?: boolean }) => ({
  at: new Date().toISOString(),
  freshStart: params.freshStart,
  resumeWorkers: params.resumeWorkers,
  experiments: [],
}));

mock.module("../src/fleet-control.js", {
  namedExports: { stopFleetProcesses },
});
mock.module("../src/fleet-preflight.js", {
  namedExports: {
    runFleetPreflight: async () => ({ ok: true, failures: [], warnings: [], auth: { apiKey: true, sdk: true, cli: true } }),
  },
});
const {
  inspectFleetResumeState,
  resumeFleet,
  startFleet,
  stopFleet,
} = await import("../src/fleet-lifecycle.js");
const { loadBudgetState, resolveBudgetStatePath, saveBudgetState } = await import(
  "../src/plan-budget.js"
);

test("inspectFleetResumeState finds sdk worker checkpoint with ticks", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "fleet-life-"));
  const experimentsDir = join(metaDir, "experiments");
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(
    join(experimentsDir, "sdk-worker-1.json"),
    JSON.stringify({ ticks: [{ tick: 1 }, { tick: 2 }], stoppedBecause: "duration" }),
  );

  const state = inspectFleetResumeState(metaDir);
  assert.equal(state.ok, true);
  assert.equal(state.tickCount, 2);
  assert.equal(state.stoppedBecause, "duration");
});

test("stopFleet stops processes without resetting budget clock", () => {
  stopFleetProcesses.mock.resetCalls();

  const budgetPath = resolveBudgetStatePath();
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  const before = loadBudgetState(budgetPath);
  before.fleetStartedAt = startedAt;
  saveBudgetState(before, budgetPath);

  const result = stopFleet({ metaDir: mkdtempSync(join(tmpdir(), "fleet-stop-")) });
  assert.deepEqual(result.stoppedPids, [123]);
  assert.equal(stopFleetProcesses.mock.callCount(), 1);
  assert.equal(loadBudgetState(budgetPath).fleetStartedAt, startedAt);
});

test("startFleet launches with freshStart", async () => {
  launchSelfImproveFleet.mock.resetCalls();
  await startFleet({ cwd: "/repo", metaDir: "/tmp/exp" }, launchSelfImproveFleet);
  assert.equal(launchSelfImproveFleet.mock.callCount(), 1);
  const params = launchSelfImproveFleet.mock.calls[0]?.arguments[0] as {
    freshStart?: boolean;
    resumeWorkers?: boolean;
  };
  assert.equal(params.freshStart, true);
  assert.equal(params.resumeWorkers, false);
});

test("resumeFleet requires checkpoint and passes resumeWorkers", async () => {
  const metaDir = mkdtempSync(join(tmpdir(), "fleet-resume-"));
  const experimentsDir = join(metaDir, "experiments");
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(join(experimentsDir, "sdk-worker-1.json"), JSON.stringify({ ticks: [{ tick: 3 }] }));

  launchSelfImproveFleet.mock.resetCalls();
  await resumeFleet({ cwd: "/repo", metaDir: experimentsDir }, launchSelfImproveFleet);
  const params = launchSelfImproveFleet.mock.calls[0]?.arguments[0] as {
    freshStart?: boolean;
    resumeWorkers?: boolean;
  };
  assert.equal(params.freshStart, false);
  assert.equal(params.resumeWorkers, true);

  await assert.rejects(
    () =>
      resumeFleet(
        { cwd: "/repo", metaDir: mkdtempSync(join(tmpdir(), "empty-")) },
        launchSelfImproveFleet,
      ),
    /No SDK checkpoint/,
  );
});
