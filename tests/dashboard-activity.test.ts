import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { extractWorkSummary, buildWorkerActivity } = await import("../src/dashboard-activity.js");
import type { DashboardExperimentRow } from "../src/dashboard.js";
import { appendRunEvent } from "../src/run-events.js";

test("extractWorkSummary prefers tick summary lines", () => {
  const tail = [
    "# heading",
    "- minor",
    "Tick 11 — hardened sdk-worker auth preflight",
    "Ground truth: npm test passed",
  ].join("\n");
  assert.equal(extractWorkSummary(tail), "Tick 11 — hardened sdk-worker auth preflight");
});

test("extractWorkSummary skips empty and markdown noise", () => {
  assert.equal(extractWorkSummary("  \n**bold**\n"), undefined);
  assert.equal(extractWorkSummary("Shipped fleet metrics gate"), "Shipped fleet metrics gate");
  assert.equal(extractWorkSummary("Ground truth: npm test passed"), undefined);
});

test("buildWorkerActivity includes live sdk run events", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-live-"));
  const agentId = "agent-live-test";
  appendRunEvent(
    "run-live",
    { type: "thinking", message: "Planning tick improvement" },
    { metaDir, agentId, label: "self-improve-fleet" },
  );

  const rows = buildWorkerActivity(
    [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        pid: 1,
        alive: true,
        agentId,
        checkpoint: { exists: true, ticks: 1, lastTick: { tick: 1 } },
      },
    ],
    { metaDir },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "active");
  assert.equal(rows[0]?.liveEvents.length, 1);
  assert.equal(rows[0]?.liveEvents[0]?.kind, "thinking");
  assert.match(rows[0]?.statusText ?? "", /Planning tick improvement/);
});

test("buildWorkerActivity maps sdk worker ticks and strategy status", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-"));
  const cpDir = join(metaDir, "experiments");
  mkdirSync(cpDir, { recursive: true });
  const checkpointPath = join(cpDir, "sdk-worker-1.json");
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      ticks: [
        {
          tick: 2,
          at: "2026-07-27T16:00:00.000Z",
          watchedMs: 45_000,
          lastAssistantTail: "Tick 2 — added dashboard activity breakdown",
          outcome: {
            producedWork: true,
            committed: true,
            pushed: true,
            commits: 1,
            filesChanged: 2,
            insertions: 40,
            deletions: 3,
            tests: { passed: true, total: 210 },
          },
        },
      ],
    }),
  );

  const experiments: DashboardExperimentRow[] = [
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 123,
      alive: true,
      agentId: "agent-test",
      checkpointPath,
      checkpoint: {
        exists: true,
        ticks: 2,
        productiveTicks: 2,
        productiveRatio: 1,
        lastTick: { tick: 2, skipped: undefined },
      },
    },
    {
      name: "strategy-review-loop",
      displayName: "Strategy critic",
      pid: 456,
      alive: true,
      checkpoint: { exists: false },
    },
    {
      name: "watch-experiments",
      displayName: "Fleet watcher",
      pid: 789,
      alive: true,
      checkpoint: { exists: false },
    },
  ];

  const rows = buildWorkerActivity(experiments, {
    metaDir,
    strategyStatus: { recommendation: "Force a code change with npm test verification this tick." },
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.name, "sdk-worker-1");
  assert.match(rows[0]?.displayName ?? "", /Self-improve worker/i);
  assert.equal(rows[0]?.recentTicks.length, 1);
  assert.equal(rows[0]?.recentTicks[0]?.workSummary, "Tick 2 — added dashboard activity breakdown");
  assert.match(rows[0]?.recentTicks[0]?.outcomeSummary ?? "", /commit/i);

  const strategy = rows.find((row) => row.name === "strategy-review-loop");
  assert.equal(strategy?.statusText, "Force a code change with npm test verification this tick.");
});
