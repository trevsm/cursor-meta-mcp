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
  assert.match(errorOverview.paragraph, /Latest tick failed:/i);

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

test("buildFleetOverview normalizes raw sdk stream status text", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "active",
        statusText: "tool grep: completed",
        ticksCompleted: 2,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.headline, /tick 3 in progress/i);
  assert.match(overview.paragraph, /running tick 3/i);
});

test("buildFleetOverview normalizes thinking stream status text", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "active",
        statusText: "thinking…",
        ticksCompleted: 5,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.headline, /tick 6 in progress/i);
  assert.match(overview.paragraph, /running tick 6/i);
});

test("buildFleetOverview normalizes status stream text", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "active",
        statusText: "status running: executing npm test",
        ticksCompleted: 8,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.headline, /tick 9 in progress/i);
  assert.match(overview.paragraph, /running tick 9/i);
});

test("buildFleetOverview reports productivity gate misses", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "idle",
        statusText: "Tick 8 complete, awaiting next interval",
        ticksCompleted: 8,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: {
      workerCount: 1,
      totalTicks: 8,
      attemptedTicks: 8,
      productiveTicks: 1,
      productiveRatio: 0.125,
      meetsGate: false,
      gatePercent: 30,
    },
  });

  assert.match(overview.paragraph, /Only 1 of 8 attempted ticks were productive \(13%, below the 30% gate\)/);
});

test("buildFleetOverview headlines idle worker with latest shipped tick", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "idle",
        statusText: "Tick 7 complete, awaiting next interval",
        ticksCompleted: 7,
        recentTicks: [
          {
            tick: 7,
            producedWork: true,
            commits: 2,
            testsPassed: true,
            testTotal: 380,
            workSummary: "Ground-truth finished phrasing fix",
          },
        ],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.headline, /Tick 7 shipped · 2 commits · 380 tests passed/);
  assert.match(overview.paragraph, /idle between ticks \(7 completed\)/i);
});

test("buildFleetOverview uses tick summary lines as active headlines", () => {
  const overview = buildFleetOverview({
    fleetHealth: { ...healthyFleet, total: 1, alive: 1 },
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "active",
        statusText: "Tick 11 — hardened sdk-worker auth preflight",
        ticksCompleted: 11,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.equal(overview.headline, "Tick 11 — hardened sdk-worker auth preflight");
  assert.match(overview.paragraph, /The fleet worker is up and healthy/i);
});

test("buildFleetOverview humanShippedTick omits test count when only pass flag set", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "idle",
        statusText: "Tick 3 complete",
        ticksCompleted: 3,
        recentTicks: [
          {
            tick: 3,
            producedWork: true,
            commits: 1,
            filesChanged: 2,
            testsPassed: true,
            workSummary: "Ground-truth heuristic tightening",
          },
        ],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.paragraph, /Latest work: Tick 3 shipped 1 commit, 2 files changed, tests passed/);
});

test("buildFleetOverview uses fleet needs attention when degraded without sdk worker", () => {
  const overview = buildFleetOverview({
    fleetHealth: { ...healthyFleet, total: 3, alive: 2 },
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "watch-experiments",
        displayName: "Fleet watcher",
        alive: true,
        role: "Patrols workers",
        status: "idle",
        statusText: "Supervisor running",
        ticksCompleted: 0,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.equal(overview.status, "warn");
  assert.equal(overview.headline, "Fleet needs attention");
});

test("buildFleetOverview uses verified changes when shipped tick lacks metrics", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: null,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "idle",
        statusText: "Tick 2 complete",
        ticksCompleted: 2,
        recentTicks: [
          {
            tick: 2,
            producedWork: true,
            workSummary: "Dashboard overview fallback headline",
          },
        ],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.paragraph, /Latest work: Tick 2 shipped verified changes — Dashboard overview fallback headline/);
});
