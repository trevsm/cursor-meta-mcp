import assert from "node:assert/strict";
import { test } from "node:test";

import {
  friendlyEpisodeActor,
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
  assert.equal(friendlyExperimentName("worker-session-2"), "IDE worker #2");
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

test("friendlyEpisodeActor maps sdk agent ids to worker labels", () => {
  const index = indexWorkerAgents([
    { name: "sdk-worker-1", agentId: "agent-abc", checkpoint: { ticks: 2, lastTick: { tick: 2 } } },
  ]);
  assert.equal(friendlyEpisodeActor("agent-abc", index), "Self-improve worker #1 · tick 2");
  assert.equal(friendlyEpisodeActor("sdk-worker"), "Self-improve worker");
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

test("indexWorkerAgents reads agentId from last tick when row omits it", () => {
  const map = indexWorkerAgents([
    {
      name: "sdk-worker-2",
      checkpoint: { ticks: 4, lastTick: { tick: 4, agentId: "agent-from-tick" } },
    },
  ]);
  assert.deepEqual(map.get("agent-from-tick"), {
    workerName: "sdk-worker-2",
    tick: 4,
    agentName: "self-improve-fleet",
  });
});
