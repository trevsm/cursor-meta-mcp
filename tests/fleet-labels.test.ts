import assert from "node:assert/strict";
import { test } from "node:test";

import {
  friendlyExperimentName,
  friendlySdkAgentLabel,
  humanizeSlug,
  indexWorkerAgents,
  shortId,
} from "../src/fleet-labels.js";

test("friendlyExperimentName maps fleet roles", () => {
  assert.equal(friendlyExperimentName("sdk-worker-1"), "Self-improve worker #1");
  assert.equal(friendlyExperimentName("sdk-worker-main"), "Self-improve worker");
  assert.equal(friendlyExperimentName("strategy-review-loop"), "Strategy critic");
  assert.equal(friendlyExperimentName("watch-experiments"), "Fleet watcher");
  assert.equal(friendlyExperimentName("worker-dedicated"), "Dedicated IDE worker");
});

test("friendlySdkAgentLabel prefers worker context over raw ids", () => {
  assert.equal(
    friendlySdkAgentLabel({
      workerExperiment: "sdk-worker-1",
      tick: 5,
      agentId: "agent-aa63128c-95ef-443b-8b99-a8e80203316a",
    }),
    "Self-improve worker #1 · tick 5",
  );
  assert.equal(friendlySdkAgentLabel({ agentName: "self-improve-fleet" }), "Self Improve Fleet");
});

test("humanizeSlug and shortId format SDK identifiers", () => {
  assert.equal(humanizeSlug("self-improve-fleet"), "Self Improve Fleet");
  assert.equal(shortId("agent-aa63128c-95ef-443b-8b99-a8e80203316a"), "aa63128c");
});

test("indexWorkerAgents links agentId to worker experiment", () => {
  const map = indexWorkerAgents([
    {
      name: "sdk-worker-1",
      agentId: "agent-abc",
      checkpoint: { ticks: 3, lastTick: { tick: 3 } },
    },
    { name: "strategy-review-loop" },
  ]);
  assert.deepEqual(map.get("agent-abc"), {
    workerName: "sdk-worker-1",
    tick: 3,
    agentName: "self-improve-fleet",
  });
});
