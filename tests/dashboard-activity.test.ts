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
  assert.equal(extractWorkSummary("Ground-truth: npm test passed"), undefined);
});

test("extractWorkSummary strips list markers and markdown emphasis", () => {
  assert.equal(
    extractWorkSummary("- Tick 3 — added dashboard overview prose"),
    "Tick 3 — added dashboard overview prose",
  );
  assert.equal(extractWorkSummary("* **Shipped** fleet metrics gate"), "Shipped fleet metrics gate");
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

test("buildWorkerActivity ignores stale sdk run events for active status", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-stale-"));
  const runsDir = join(metaDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const agentId = "agent-stale";
  writeFileSync(
    join(runsDir, "run-stale.jsonl"),
    `${JSON.stringify({
      type: "thinking",
      message: "Old planning",
      at: "2020-01-01T00:00:00.000Z",
      runId: "run-stale",
      agentId,
    })}\n`,
  );

  const rows = buildWorkerActivity(
    [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        pid: 1,
        alive: true,
        agentId,
        checkpoint: { exists: true, ticks: 3, lastTick: { tick: 3 } },
      },
    ],
    { metaDir },
  );

  assert.equal(rows[0]?.status, "idle");
  assert.equal(rows[0]?.liveEvents.length, 1);
});

test("buildWorkerActivity marks busy-skipped sdk worker as active", () => {
  const rows = buildWorkerActivity([
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 1,
      alive: true,
      checkpoint: {
        exists: true,
        ticks: 1,
        lastTick: { tick: 1, skipped: "busy" },
      },
    },
  ]);
  assert.equal(rows[0]?.status, "active");
});

test("buildWorkerActivity merges live events from multiple sdk runs", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-multi-"));
  const agentId = "agent-multi";
  appendRunEvent(
    "run-a",
    { type: "thinking", message: "First run thought" },
    { metaDir, agentId, label: "self-improve-fleet" },
  );
  appendRunEvent(
    "run-b",
    { type: "tool_call", message: "grep: completed" },
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

  assert.equal(rows[0]?.liveEvents.length, 2);
  const kinds = rows[0]?.liveEvents.map((event) => event.kind) ?? [];
  assert.ok(kinds.includes("thinking"));
  assert.ok(kinds.includes("tool"));
});

test("buildWorkerActivity maps assistant and status live event kinds", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-kinds-"));
  const agentId = "agent-kinds";
  appendRunEvent(
    "run-assistant",
    { type: "assistant", message: "Tick summary ready" },
    { metaDir, agentId, label: "self-improve-fleet" },
  );
  appendRunEvent(
    "run-status",
    { type: "status", message: "status running: executing" },
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

  const kinds = rows[0]?.liveEvents.map((event) => event.kind) ?? [];
  assert.ok(kinds.includes("assistant"));
  assert.ok(kinds.includes("status"));
});

test("buildWorkerActivity maps unknown live event types to other", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-other-kind-"));
  const agentId = "agent-other-kind";
  appendRunEvent(
    "run-system",
    { type: "system", message: "Agent initialized (model gpt-5)." },
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

  assert.equal(rows[0]?.liveEvents[0]?.kind, "other");
});

test("buildWorkerActivity caps live events at eight newest rows", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-cap-"));
  const runsDir = join(metaDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const agentId = "agent-cap";
  const lines = Array.from({ length: 10 }, (_, index) =>
    JSON.stringify({
      type: "thinking",
      message: `Thought ${index}`,
      at: new Date(Date.now() - (10 - index) * 1000).toISOString(),
      runId: "run-many",
      agentId,
    }),
  );
  writeFileSync(join(runsDir, "run-many.jsonl"), `${lines.join("\n")}\n`);

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

  assert.equal(rows[0]?.liveEvents.length, 8);
  assert.equal(rows[0]?.liveEvents[0]?.text, "Thought 9");
  assert.equal(rows[0]?.liveEvents.at(-1)?.text, "Thought 2");
});

test("buildWorkerActivity ignores live events from other agent ids", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-other-"));
  appendRunEvent(
    "run-shared",
    { type: "thinking", message: "Other worker thought" },
    { metaDir, agentId: "agent-other", label: "self-improve-fleet" },
  );
  appendRunEvent(
    "run-shared",
    { type: "thinking", message: "My worker thought" },
    { metaDir, agentId: "agent-mine", label: "self-improve-fleet" },
  );

  const rows = buildWorkerActivity(
    [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        pid: 1,
        alive: true,
        agentId: "agent-mine",
        checkpoint: { exists: true, ticks: 1, lastTick: { tick: 1 } },
      },
    ],
    { metaDir },
  );

  assert.equal(rows[0]?.liveEvents.length, 1);
  assert.match(rows[0]?.liveEvents[0]?.text ?? "", /My worker thought/);
});

test("buildWorkerActivity marks sdk worker error and dead states", () => {
  const errorRows = buildWorkerActivity([
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 1,
      alive: true,
      checkpoint: {
        exists: true,
        ticks: 1,
        lastTick: { tick: 1, error: "Agent transport dropped" },
      },
    },
  ]);
  assert.equal(errorRows[0]?.status, "error");
  assert.match(errorRows[0]?.statusText ?? "", /Agent transport dropped/);

  const deadRows = buildWorkerActivity([
    {
      name: "sdk-worker-2",
      displayName: "Self-improve worker #2",
      pid: 2,
      alive: false,
      checkpoint: { exists: true, ticks: 5 },
    },
  ]);
  assert.equal(deadRows[0]?.status, "dead");
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

  const watcher = rows.find((row) => row.name === "watch-experiments");
  assert.match(watcher?.role ?? "", /Patrols workers/);
  assert.equal(watcher?.statusText, "Supervisor running");
});

test("buildWorkerActivity tolerates malformed checkpoint files", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-bad-cp-"));
  const cpDir = join(metaDir, "experiments");
  mkdirSync(cpDir, { recursive: true });
  const checkpointPath = join(cpDir, "sdk-worker-1.json");
  writeFileSync(checkpointPath, "{not json");

  const rows = buildWorkerActivity([
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 1,
      alive: true,
      checkpointPath,
      checkpoint: { exists: true, ticks: 0 },
    },
  ]);

  assert.equal(rows[0]?.recentTicks.length, 0);
});

test("buildWorkerActivity surfaces tick errors in recent tick breakdown", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-tick-err-"));
  const cpDir = join(metaDir, "experiments");
  mkdirSync(cpDir, { recursive: true });
  const checkpointPath = join(cpDir, "sdk-worker-1.json");
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      ticks: [{ tick: 3, at: "2026-07-27T17:00:00.000Z", error: "spawn failed" }],
    }),
  );

  const rows = buildWorkerActivity([
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 1,
      alive: true,
      checkpointPath,
      checkpoint: {
        exists: true,
        ticks: 3,
        lastTick: { tick: 3, error: "spawn failed" },
      },
    },
  ]);

  assert.equal(rows[0]?.status, "error");
  assert.equal(rows[0]?.recentTicks[0]?.outcomeSummary, "error");
  assert.match(rows[0]?.statusText ?? "", /spawn failed/);
});

test("buildWorkerActivity maps orchestrator role and stopped strategy reviewer", () => {
  const rows = buildWorkerActivity([
    {
      name: "orchestrator-loop",
      displayName: "Pulse orchestrator",
      pid: 10,
      alive: true,
      checkpoint: { exists: false },
    },
    {
      name: "strategy-review-loop",
      displayName: "Strategy critic",
      pid: 11,
      alive: false,
      checkpoint: { exists: false },
    },
  ]);

  const orchestrator = rows.find((row) => row.name === "orchestrator-loop");
  assert.match(orchestrator?.role ?? "", /Pulse orchestrator/i);
  assert.equal(orchestrator?.statusText, "Supervisor running");

  const strategy = rows.find((row) => row.name === "strategy-review-loop");
  assert.equal(strategy?.status, "dead");
  assert.equal(strategy?.statusText, "Stopped");
});

test("buildWorkerActivity marks stopped fleet watcher as dead", () => {
  const rows = buildWorkerActivity([
    {
      name: "watch-experiments",
      displayName: "Fleet watcher",
      pid: 12,
      alive: false,
      checkpoint: { exists: true, ticks: 40 },
    },
  ]);

  assert.equal(rows[0]?.status, "dead");
  assert.equal(rows[0]?.statusText, "Stopped");
  assert.match(rows[0]?.role ?? "", /Patrols workers/);
});

test("buildWorkerActivity shows starting status for new sdk workers", () => {
  const rows = buildWorkerActivity([
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 1,
      alive: true,
      checkpoint: { exists: true, ticks: 0 },
    },
  ]);

  assert.equal(rows[0]?.status, "idle");
  assert.equal(rows[0]?.statusText, "Starting…");
  assert.equal(rows[0]?.ticksCompleted, 0);
});

test("buildWorkerActivity keeps only the five most recent checkpoint ticks", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-activity-recent-"));
  const cpDir = join(metaDir, "experiments");
  mkdirSync(cpDir, { recursive: true });
  const checkpointPath = join(cpDir, "sdk-worker-1.json");
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      ticks: Array.from({ length: 7 }, (_, index) => ({
        tick: index + 1,
        at: `2026-07-27T1${index}:00:00.000Z`,
        lastAssistantTail: `Tick ${index + 1} — work item ${index + 1}`,
        outcome: { producedWork: true, commits: 1 },
      })),
    }),
  );

  const rows = buildWorkerActivity([
    {
      name: "sdk-worker-1",
      displayName: "Self-improve worker #1",
      pid: 1,
      alive: true,
      checkpointPath,
      checkpoint: { exists: true, ticks: 7, lastTick: { tick: 7 } },
    },
  ]);

  assert.equal(rows[0]?.recentTicks.length, 5);
  assert.equal(rows[0]?.recentTicks[0]?.tick, 7);
  assert.equal(rows[0]?.recentTicks.at(-1)?.tick, 3);
});
