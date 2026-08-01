import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureLaunchMission,
  finalizeOrbitTick,
  orbitEnabled,
  prepareOrbitTick,
  workerIdFromCheckpoint,
} from "../src/orbit-worker.js";
import {
  fileMission,
  landVerifiedMission,
  readMissions,
  summarizeStation,
} from "../src/orbit-ledger.js";

function freshMeta(): string {
  return mkdtempSync(join(tmpdir(), "orbit-worker-"));
}

const station = "faciliq-platform-core";
const ctx = (metaDir: string) => ({ station, workerId: "sdk-worker-1", metaDir });

test("workerIdFromCheckpoint derives experiment name from path", () => {
  assert.equal(workerIdFromCheckpoint("/tmp/experiments/sdk-worker-1.json"), "sdk-worker-1");
  assert.equal(workerIdFromCheckpoint(undefined), "sdk-worker-main");
});

test("orbitEnabled follows env and existing ledger", () => {
  const metaDir = freshMeta();
  const prev = process.env.CURSOR_META_ORBIT;
  process.env.CURSOR_META_ORBIT = "1";
  try {
    assert.equal(orbitEnabled(metaDir, `/Users/me/Desktop/${station}`), true);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_META_ORBIT;
    else process.env.CURSOR_META_ORBIT = prev;
  }

  delete process.env.CURSOR_META_ORBIT;
  assert.equal(orbitEnabled(metaDir, `/Users/me/Desktop/${station}`), false);

  fileMission(
    { station, title: "t", intent: "why" },
    metaDir,
  );
  assert.equal(orbitEnabled(metaDir, `/Users/me/Desktop/${station}`), true);
});

test("ensureLaunchMission files goal once and reuses existing ledger", () => {
  const metaDir = freshMeta();
  const cwd = `/Users/me/Desktop/${station}`;
  const first = ensureLaunchMission({ cwd, goal: "Drive lint to zero", verify: "pnpm test", metaDir });
  assert.ok(first);
  assert.match(first!.intent, /Drive lint to zero/);

  const second = ensureLaunchMission({ cwd, goal: "Different goal", metaDir });
  assert.equal(second!.id, first!.id);
  assert.match(second!.intent, /Drive lint to zero/);
});

test("prepareOrbitTick claims mission and marks it active", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);

  const prep = prepareOrbitTick(ctx(metaDir));
  assert.equal(prep.exitDrained, false);
  assert.equal(prep.mission?.id, mission.id);
  assert.equal(prep.mission?.status, "active");
});

test("prepareOrbitTick signals drained queue", () => {
  const metaDir = freshMeta();
  const prep = prepareOrbitTick(ctx(metaDir));
  assert.equal(prep.mission, null);
  assert.equal(prep.exitDrained, true);
});

test("finalizeOrbitTick blocks mission on SDK rate limit", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));

  finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    error: "SDK run rate 20/20 per hour",
  });

  const stored = readMissions(station, metaDir).find((row) => row.id === mission.id);
  assert.equal(stored?.status, "blocked");
});

test("finalizeOrbitTick verifies but does not land — landing waits on the merge", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));

  const result = finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    outcome: {
      commits: 0,
      tests: { passed: true, command: "pnpm test" },
    },
    tickReportDone: true,
  });

  assert.equal(result?.status, "verified");
  assert.equal(
    summarizeStation(station, metaDir).landed,
    0,
    "a coder proves its own worktree; only the watcher can see the work reach the base branch",
  );
});

test("landVerifiedMission promotes verified work once the branch merges", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));
  finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    outcome: { commits: 0, tests: { passed: true, command: "pnpm test" } },
    tickReportDone: true,
  });

  const promoted = landVerifiedMission(station, mission.id, metaDir);
  assert.equal(promoted.error, undefined);
  assert.equal(promoted.mission?.status, "landed");
  assert.equal(summarizeStation(station, metaDir).landed, 1);
});

test("landVerifiedMission refuses to promote work that was never verified", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);

  const promoted = landVerifiedMission(station, mission.id, metaDir);
  assert.match(promoted.error ?? "", /Cannot land/);
  assert.equal(summarizeStation(station, metaDir).landed, 0);
});

test("finalizeOrbitTick refuses to verify a tick the ground-truth gate blocked", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));

  const result = finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    outcome: { commits: 1, tests: { passed: true, command: "pnpm test" } },
    tickReportDone: true,
    gateBlocked: true,
  });

  assert.notEqual(
    result?.status,
    "verified",
    "green tests do not override a gate rejection — that would ship what the gate just refused",
  );
  assert.equal(summarizeStation(station, metaDir).landed, 0);
});

test("finalizeOrbitTick will not verify work that exists only in the worktree", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));

  const result = finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    outcome: {
      commits: 0,
      producedWork: true,
      committed: false,
      tests: { passed: true, command: "pnpm test" },
    },
    tickReportDone: true,
  });

  assert.notEqual(
    result?.status,
    "verified",
    "an uncommitted tree has nothing to merge; verifying it lands a mission with no code in the base branch",
  );
});

test("finalizeOrbitTick still verifies a mission that legitimately needed no code change", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Confirm", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));

  const result = finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    outcome: {
      commits: 0,
      producedWork: false,
      committed: false,
      tests: { passed: true, command: "pnpm test" },
    },
    tickReportDone: true,
  });

  assert.equal(result?.status, "verified");
});
