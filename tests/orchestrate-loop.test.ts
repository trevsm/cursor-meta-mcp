import assert from "node:assert/strict";
import { test } from "node:test";

import { filterOrchestrationMatrix } from "../src/orchestrate-pulse.js";
import { summarizeLoop } from "../src/orchestrate-loop.js";

const sampleMatrix = [
  {
    sessionId: "aaaa",
    sessionIndex: 1,
    title: "Self",
    workspace: "/proj",
    signals: ["generating"],
    frustrationRisk: { score: 0, reason: null },
    plays: [{ action: "WATCH" as const, tool: "meta_watch_chat", why: "wait" }],
  },
  {
    sessionId: "bbbb",
    sessionIndex: 2,
    title: "Worker",
    workspace: "/proj",
    signals: ["generating"],
    frustrationRisk: { score: 0, reason: null },
    plays: [
      { action: "CONTINUE" as const, tool: "meta_watch_chat", why: "go", prompt: "Continue." },
    ],
  },
];

test("filterOrchestrationMatrix removes conductor chat", () => {
  const filtered = filterOrchestrationMatrix(sampleMatrix, { excludeSessionIndexes: [1] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.sessionIndex, 2);
});

test("summarizeLoop aggregates executed actions", () => {
  const summary = summarizeLoop({
    cycles: 1,
    stoppedBecause: "idle",
    history: [
      {
        cycle: 1,
        at: "2026-01-01T00:00:00.000Z",
        liveCount: 0,
        matrixCount: 0,
        executedCount: 1,
        errorCount: 0,
        result: {
          pulse: {
            at: "2026-01-01T00:00:00.000Z",
            scanned: 1,
            live: [],
            frustrationEvents: [],
            orchestrationMatrix: [],
            parallelWorkspaces: [],
          },
          planned: 1,
          executed: [
            {
              sessionId: "bbbb",
              sessionIndex: 2,
              title: "Worker",
              workspace: "/proj",
              action: "CONTINUE",
              tool: "meta_watch_chat",
              why: "go",
              dryRun: false,
            },
          ],
          skipped: [],
        },
      },
    ],
  });
  assert.equal(summary.totalExecuted, 1);
  assert.equal(summary.totalErrors, 0);
});
