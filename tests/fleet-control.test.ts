import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectFleetPids,
  readDedicatedWorker,
  stopFleetProcesses,
  stopKnownFleetProcesses,
} from "../src/fleet-control.js";
import type { FleetManifest } from "../src/budget-supervisor.js";

test("collectFleetPids dedupes strategyReviewerPid also listed in experiments", () => {
  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [
      { name: "worker-dedicated", pid: 111 },
      { name: "strategy-review-loop", pid: 222 },
    ],
    watcherPid: 333,
    strategyReviewerPid: 222,
  };
  assert.deepEqual(collectFleetPids(manifest), [111, 222, 333]);
});

test("collectFleetPids skips non-positive pids", () => {
  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [{ name: "worker-dedicated", pid: -1 }],
    watcherPid: 0,
  };
  assert.deepEqual(collectFleetPids(manifest), []);
});

test("stopFleetProcesses returns empty when no manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-stop-"));
  const result = stopFleetProcesses(dir);
  assert.equal(result.manifest, null);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(stopKnownFleetProcesses(dir), []);
});

test("stopFleetProcesses loads manifest and skips already-dead pids", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-stop-alive-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [{ name: "worker-dedicated", pid: 99_999_999 }],
      watcherPid: 99_999_998,
      strategyReviewerPid: 99_999_999,
    }),
  );
  const result = stopFleetProcesses(dir);
  assert.ok(result.manifest);
  assert.equal(result.manifest?.experiments.length, 1);
  // Dead pids: kill returns false, so killed stays empty
  assert.deepEqual(result.killed, []);
});

test("readDedicatedWorker returns null for missing or invalid json", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-dedicated-"));
  assert.equal(readDedicatedWorker(dir), null);

  const badDir = mkdtempSync(join(tmpdir(), "fleet-dedicated-bad-"));
  writeFileSync(join(badDir, "dedicated-worker.json"), "{not-json");
  assert.equal(readDedicatedWorker(badDir), null);
});

test("readDedicatedWorker parses dedicated worker file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-dedicated-ok-"));
  writeFileSync(
    join(dir, "dedicated-worker.json"),
    JSON.stringify({ sessionId: "abc", sessionIndex: 7 }),
  );
  assert.deepEqual(readDedicatedWorker(dir), { sessionId: "abc", sessionIndex: 7 });
});

test("stopFleetProcesses finds manifest under experiments-style metaDir", () => {
  const meta = mkdtempSync(join(tmpdir(), "fleet-meta-"));
  mkdirSync(meta, { recursive: true });
  writeFileSync(
    join(meta, "manifest.json"),
    JSON.stringify({ at: new Date().toISOString(), experiments: [] }),
  );
  const result = stopFleetProcesses(meta);
  assert.ok(result.manifest);
  assert.deepEqual(result.killed, []);
});
