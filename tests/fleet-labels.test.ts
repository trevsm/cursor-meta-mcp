import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeFleetRoleCounts,
  fleetRoleKind,
  friendlyEpisodeActor,
  friendlyExperimentName,
  friendlySdkAgentLabel,
  fleetWorkerRoleDescription,
  humanizeSlug,
  indexWorkerAgents,
  shortId,
} from "../src/fleet-labels.js";

test("friendlyExperimentName maps fleet roles", () => {
  assert.equal(friendlyExperimentName("sdk-worker-1"), "Coder #1");
  assert.equal(friendlyExperimentName("sdk-worker-main"), "Coder");
  assert.equal(friendlyExperimentName("strategy-review-loop"), "Strategy critic");
  assert.equal(friendlyExperimentName("watch-experiments"), "Fleet watcher");
  assert.equal(friendlyExperimentName("worker-dedicated"), "Dedicated IDE coder");
  assert.equal(friendlyExperimentName("worker-session-2"), "IDE coder #2");
  assert.equal(friendlyExperimentName("worker-3"), "IDE coder #3");
});

test("fleetRoleKind classifies coders and supervisors", () => {
  assert.equal(fleetRoleKind("sdk-worker-1"), "coder");
  assert.equal(fleetRoleKind("sdk-worker-main"), "coder");
  assert.equal(fleetRoleKind("worker-dedicated"), "coder");
  assert.equal(fleetRoleKind("worker-session-2"), "coder");
  assert.equal(fleetRoleKind("worker-3"), "coder");
  assert.equal(fleetRoleKind("strategy-review-loop"), "supervisor");
  assert.equal(fleetRoleKind("watch-experiments"), "supervisor");
  assert.equal(fleetRoleKind("orchestrator-loop"), "supervisor");
});

test("computeFleetRoleCounts separates coders and supervisors", () => {
  const counts = computeFleetRoleCounts({
    experiments: [
      { name: "sdk-worker-1", alive: true },
      { name: "strategy-review-loop", alive: true },
    ],
    watcherAlive: true,
  });
  assert.deepEqual(counts, {
    codersTotal: 1,
    codersAlive: 1,
    supervisorsTotal: 2,
    supervisorsAlive: 2,
  });
});

test("computeFleetRoleCounts omits watcher when fleet is idle", () => {
  assert.deepEqual(
    computeFleetRoleCounts({ experiments: [], watcherAlive: false }),
    { codersTotal: 0, codersAlive: 0, supervisorsTotal: 0, supervisorsAlive: 0 },
  );
});

test("fleetWorkerRoleDescription maps role blurbs", () => {
  assert.equal(
    fleetWorkerRoleDescription("sdk-worker-1"),
    "Ships verified diffs: test → commit → push",
  );
  assert.equal(fleetWorkerRoleDescription("worker-dedicated"), "Dedicated IDE coding session");
  assert.equal(fleetWorkerRoleDescription("worker-2"), "IDE coding session");
  assert.equal(
    fleetWorkerRoleDescription("strategy-review-loop"),
    "Reviews fleet health every 5 minutes",
  );
});

test("friendlySdkAgentLabel prefers worker context over raw ids", () => {
  assert.equal(
    friendlySdkAgentLabel({
      workerExperiment: "sdk-worker-1",
      tick: 5,
      agentId: "agent-aa63128c-95ef-443b-8b99-a8e80203316a",
    }),
    "Coder #1 · tick 5",
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
  assert.equal(friendlyEpisodeActor("agent-abc", index), "Coder #1 · tick 2");
  assert.equal(friendlyEpisodeActor("sdk-worker"), "Coder");
});

test("friendlyEpisodeActor falls back for unknown agent ids", () => {
  assert.equal(friendlyEpisodeActor("agent-unknown"), "Self Improve Fleet");
  assert.equal(friendlyEpisodeActor("long-session"), "long-session");
});

test("friendlyExperimentName maps orchestrator-loop supervisor", () => {
  assert.equal(friendlyExperimentName("orchestrator-loop"), "Pulse orchestrator");
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
