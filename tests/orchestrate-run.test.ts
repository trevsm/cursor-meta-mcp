import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConsciousnessPulseReport } from "../src/consciousness-pulse.js";
import { orchestratePulse } from "../src/orchestrate-pulse.js";
import { orchestrateLoop } from "../src/orchestrate-loop.js";

const pulseReport: ConsciousnessPulseReport = {
  at: "2026-01-01T00:00:00.000Z",
  scanned: 1,
  live: [],
  frustrationEvents: [],
  parallelWorkspaces: [],
  orchestrationMatrix: [
    {
      sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      sessionIndex: 2,
      title: "Worker chat",
      workspace: "/Users/you/project",
      signals: [],
      frustrationRisk: { score: 0.9, reason: "terse_still" },
      plays: [
        {
          action: "INTERCEPT",
          tool: "meta_intercept_chat",
          why: "frustration",
          prompt: "Stop and verify.",
        },
      ],
    },
  ],
};

test("orchestratePulse dry-run plans without executing", async () => {
  const result = await orchestratePulse(
    { dryRun: true, allowIntercept: true, maxActions: 1 },
    undefined,
    () => pulseReport,
  );
  assert.equal(result.planned, 1);
  assert.equal(result.executed[0]?.dryRun, true);
});

test("orchestratePulse skips disallowed actions", async () => {
  const result = await orchestratePulse(
    { dryRun: true, allowIntercept: false, maxActions: 1 },
    undefined,
    () => pulseReport,
  );
  assert.equal(result.executed.length, 0);
  assert.ok(result.skipped.some((entry) => entry.reason.includes("not allowed")));
});

test("orchestratePulse respects maxActions", async () => {
  const result = await orchestratePulse(
    { dryRun: true, allowIntercept: true, maxActions: 1 },
    undefined,
    () => ({
      ...pulseReport,
      orchestrationMatrix: [
        pulseReport.orchestrationMatrix[0]!,
        {
          ...pulseReport.orchestrationMatrix[0]!,
          sessionId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          sessionIndex: 3,
        },
      ],
    }),
  );
  assert.equal(result.executed.length, 1);
  assert.ok(result.skipped.some((entry) => entry.reason.includes("maxActions")));
});

test("orchestrateLoop stops when idle on first cycle", async () => {
  const result = await orchestrateLoop({ maxCycles: 5, intervalMs: 1, stopWhenIdle: true }, undefined, async () => ({
    pulse: { ...pulseReport, orchestrationMatrix: [] },
    planned: 0,
    executed: [],
    skipped: [],
  }));
  assert.equal(result.stoppedBecause, "idle");
  assert.equal(result.cycles, 1);
});

test("orchestrateLoop stops when all executions error", async () => {
  const result = await orchestrateLoop({ maxCycles: 5, intervalMs: 1 }, undefined, async () => ({
    pulse: pulseReport,
    planned: 1,
    executed: [
      {
        sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        title: "Worker chat",
        workspace: "/Users/you/project",
        action: "WATCH",
        tool: "meta_watch_chat",
        why: "wait",
        dryRun: false,
        error: "failed",
      },
    ],
    skipped: [],
  }));
  assert.equal(result.stoppedBecause, "errors");
});

test("orchestrateLoop stops when work exists but nothing executes", async () => {
  const result = await orchestrateLoop(
    { maxCycles: 5, intervalMs: 1, allowWatch: false },
    undefined,
    async () => ({
      pulse: pulseReport,
      planned: 1,
      executed: [],
      skipped: [{ sessionId: "bbbb", title: "Worker", action: "WATCH", reason: "not allowed" }],
    }),
  );
  assert.equal(result.stoppedBecause, "no_work");
});

test("orchestrateLoop runs until maxCycles when never idle", async () => {
  let calls = 0;
  const result = await orchestrateLoop(
    { maxCycles: 2, intervalMs: 1, stopWhenIdle: false },
    undefined,
    async () => {
      calls += 1;
      return {
        pulse: pulseReport,
        planned: 1,
        executed: [
          {
            sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            title: "Worker chat",
            workspace: "/Users/you/project",
            action: "WATCH",
            tool: "meta_watch_chat",
            why: "wait",
            dryRun: false,
          },
        ],
        skipped: [],
      };
    },
  );
  assert.equal(result.stoppedBecause, "max_cycles");
  assert.equal(result.cycles, 2);
  assert.equal(calls, 2);
});
