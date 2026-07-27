import assert from "node:assert/strict";
import { test } from "node:test";

const { buildFleetOverview, humanShippedTick } = await import("../src/dashboard-overview.js");
import type { WorkerActivityBreakdown } from "../src/dashboard-activity.js";

const healthyFleet = {
  total: 2,
  alive: 2,
  watcherAlive: true,
  strategyReviewerAlive: true,
  manifestAt: null,
  staleManifest: false,
};

const lintMission = {
  goal: "Drive workflow-builder lint to zero before UX work. Local verify only — no GitHub CI pushes.",
};

test("buildFleetOverview leads with mission and strategy whys", () => {
  const workerActivity: WorkerActivityBreakdown[] = [
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      alive: true,
      role: "Ships verified diffs",
      status: "idle",
      statusText: "Tick 3 complete",
      ticksCompleted: 3,
      recentTicks: [{ tick: 3, producedWork: true, commits: 1, testsPassed: true }],
      liveEvents: [],
    },
  ];

  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: lintMission,
    strategyStatus: {
      onTrack: true,
      score: 74,
      recommendation: "Pivot to approval-overview UX now that lint is clean.",
      issues: ["World model still lists stale lint directives"],
    },
    workerActivity,
    productivity: {
      workerCount: 1,
      totalTicks: 3,
      attemptedTicks: 3,
      productiveTicks: 2,
      productiveRatio: 0.67,
      meetsGate: true,
      gatePercent: 30,
    },
  });

  assert.match(overview.paragraph, /Why we're here:.*workflow-builder lint/i);
  assert.match(overview.paragraph, /Why to watch:|Why we're off track:/);
  assert.match(overview.paragraph, /Why next:.*approval-overview/i);
  assert.doesNotMatch(overview.paragraph, /Tick 3 shipped/i);
  assert.match(overview.headline, /Pivot to approval-overview|Working on:/i);
});

test("buildFleetOverview explains SDK rate limit as why blocked", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: lintMission,
    strategyStatus: null,
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "error",
        statusText: "SDK run rate 20/20 per hour",
        ticksCompleted: 1,
        recentTicks: [{ tick: 2, error: "SDK run rate 20/20 per hour" }],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.headline, /Blocked — hourly SDK run cap/i);
  assert.match(overview.paragraph, /hourly SDK run cap/i);
  assert.match(overview.paragraph, /API budget limit/i);
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
  assert.match(blocked.paragraph, /Why work stopped/i);

  const idle = buildFleetOverview({
    fleetHealth: { ...healthyFleet, total: 0, alive: 0 },
    manifest: lintMission,
    strategyStatus: null,
    workerActivity: [],
    productivity: null,
  });
  assert.equal(idle.status, "idle");
  assert.match(idle.paragraph, /Why nothing is running/i);
});

test("buildFleetOverview explains low productivity when gate missed", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: lintMission,
    strategyStatus: { onTrack: false, issues: ["Repeated test-only churn"] },
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "idle",
        statusText: "Tick 8 complete",
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

  assert.match(overview.paragraph, /Why productivity matters/i);
  assert.match(overview.paragraph, /won't scale until/i);
});

test("buildFleetOverview warns when fleet is degraded", () => {
  const overview = buildFleetOverview({
    fleetHealth: { ...healthyFleet, total: 3, alive: 2 },
    manifest: lintMission,
    strategyStatus: null,
    workerActivity: [],
    productivity: null,
  });

  assert.equal(overview.status, "warn");
  assert.match(overview.headline, /Fleet needs attention/i);
});

test("buildFleetOverview uses pivot as headline when present", () => {
  const overview = buildFleetOverview({
    fleetHealth: healthyFleet,
    manifest: lintMission,
    strategyStatus: {
      pivot: "Next tick ONLY: fix chain-graph-preview.tsx react-hooks violations",
      recommendation: "Raise productive ratio",
    },
    workerActivity: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        alive: true,
        role: "Ships verified diffs",
        status: "active",
        statusText: "thinking…",
        ticksCompleted: 2,
        recentTicks: [],
        liveEvents: [],
      },
    ],
    productivity: null,
  });

  assert.match(overview.headline, /chain-graph-preview/i);
  assert.match(overview.paragraph, /Why next:.*chain-graph-preview/i);
});

test("humanShippedTick still formats shipped metrics for activity cards", () => {
  const text = humanShippedTick({
    tick: 3,
    producedWork: true,
    commits: 1,
    filesChanged: 2,
    testsPassed: true,
    workSummary: "Ground-truth heuristic tightening",
  });
  assert.match(text, /Tick 3 shipped 1 commit, 2 files changed, tests passed/);
});
