import assert from "node:assert/strict";
import { test } from "node:test";

const { buildFleetOverview } = await import("../src/dashboard-overview.js");
import type { WorkerActivityBreakdown } from "../src/dashboard-activity.js";

const healthyFleet = {
  total: 2,
  alive: 2,
  watcherAlive: true,
  strategyReviewerAlive: true,
  manifestAt: null,
  staleManifest: false,
};

test("buildFleetOverview writes prose for active sdk worker", () => {
  const workerActivity: WorkerActivityBreakdown[] = [
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      alive: true,
      role: "Ships verified diffs",
      status: "active",
      statusText: "Running tests and committing",
      ticksCompleted: 12,
      productiveRatio: 1,
      recentTicks: [
        {
          tick: 12,
          producedWork: true,
          commits: 3,
          filesChanged: 10,
          insertions: 537,
          deletions: 7,
          testsPassed: true,
          testTotal: 364,
          workSummary: "Pulse orchestrator naming cleanup",
        },
      ],
      liveEvents: [],
    },
    {
      name: "strategy-review-loop",
      displayName: "Strategy critic",
      alive: true,
      role: "Reviews fleet health",
      status: "idle",
      statusText: "Continue current direction — verified progress detected.",
      ticksCompleted: 0,
      recentTicks: [],
      liveEvents: [],
    },
  ];

  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: { recommendation: "Continue current direction — verified progress detected." },
    workerActivity,
    productivity: {
      workerCount: 1,
      totalTicks: 12,
      attemptedTicks: 12,
      productiveTicks: 12,
      productiveRatio: 1,
      meetsGate: true,
      gatePercent: 30,
    },
  });

  assert.match(overview.headline, /tick 13 in progress|Running tests/i);
  assert.match(overview.paragraph, /running tick 13|Running tests/i);
  assert.match(overview.paragraph, /Tick 12 shipped 3 commits/i);
  assert.match(overview.paragraph, /12 of 12 attempted ticks/i);
  assert.match(overview.paragraph, /Strategy critic/i);
  assert.equal(overview.status, "ok");
});

test("buildFleetOverview handles budget block and idle fleet", () => {
  const blocked = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: { budgetBlocked: true, budgetBlockedReason: "spawn rate cap" },
    strategyStatus: null,
    workerActivity: [],
    productivity: null,
  });
  assert.equal(blocked.status, "bad");
  assert.match(blocked.headline, /budget/i);

  const idle = buildFleetOverview({
    fleetHealth: { ...healthyFleet, total: 0, alive: 0 },
    manifest: null,
    strategyStatus: null,
    workerActivity: [],
    productivity: null,
  });
  assert.equal(idle.status, "idle");
  assert.match(idle.paragraph, /No workers are running/i);
});

test("buildFleetOverview reports sdk worker errors and dead fleet", () => {
  const errorOverview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "error",
        statusText: "Agent transport dropped",
        ticksCompleted: 5,
        recentTicks: [{ tick: 5, error: "Agent transport dropped" }],
        liveEvents: [],
      },
    ],
    productivity: null,
  });
  assert.equal(errorOverview.status, "bad");
  assert.match(errorOverview.headline, /hit an error/i);
  assert.match(errorOverview.paragraph, /Agent transport dropped/i);

  const deadOverview = buildFleetOverview({
    fleetHealth: { ...healthyFleet, alive: 0 },
    manifest: null,
    strategyStatus: null,
    workerActivity: [],
    productivity: null,
  });
  assert.equal(deadOverview.status, "bad");
  assert.match(deadOverview.headline, /Fleet stopped/i);
});

test("buildFleetOverview warns when fleet is degraded", () => {
  const overview = buildFleetOverview({
    fleetHealth: { ...healthyFleet, total: 3, alive: 2 },
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "idle",
        statusText: "Tick 4 complete, awaiting next interval",
        ticksCompleted: 4,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.equal(overview.status, "warn");
  assert.match(overview.paragraph, /degraded — 2 of 3 workers are alive/i);
  assert.match(overview.headline, /idle after tick 4/i);
});
