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
import { fileMission, readMissions, summarizeStation } from "../src/orbit-ledger.js";

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

test("finalizeOrbitTick lands when verify passes and tick report claims done", () => {
  const metaDir = freshMeta();
  const mission = fileMission({ station, title: "Lint", intent: "why" }, metaDir);
  prepareOrbitTick(ctx(metaDir));

  finalizeOrbitTick({
    ctx: ctx(metaDir),
    mission,
    outcome: {
      commits: 0,
      tests: { passed: true, command: "pnpm test" },
    },
    tickReportDone: true,
  });

  assert.equal(summarizeStation(station, metaDir).landed, 1);
});
