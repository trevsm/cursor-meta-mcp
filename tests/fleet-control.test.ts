import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectFleetPids,
  killExperimentByName,
  killExperimentsByName,
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

test("killExperimentByName and killExperimentsByName handle missing and dead pids", () => {
  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [
      { name: "sdk-worker-a", pid: 99_999_997 },
      { name: "sdk-worker-b" },
    ],
  };
  assert.equal(killExperimentByName(manifest, "missing").killed, false);
  assert.equal(killExperimentByName(manifest, "sdk-worker-b").killed, false);
  assert.deepEqual(killExperimentsByName(manifest, ["sdk-worker-a", "missing"]), []);
});

test("killExperimentsByName SIGTERMs live experiment pids", () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  assert.ok(child.pid);
  const manifest: FleetManifest = {
    at: new Date().toISOString(),
    experiments: [{ name: "sdk-worker-live", pid: child.pid }],
  };
  try {
    assert.deepEqual(killExperimentsByName(manifest, ["sdk-worker-live"]), [child.pid]);
  } finally {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
});
