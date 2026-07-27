import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  analyzeWorkerCheckpoint,
  isWorkerStalled,
  meetsProductiveTickGate,
  PRODUCTIVE_TICK_GATE,
  relaunchBlockedReason,
} from "../src/fleet-metrics.js";

test("analyzeWorkerCheckpoint computes productive ratio", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      ticks: [
        {
          at: "2026-07-27T00:00:00.000Z",
          outcome: { producedWork: true, committed: true, commits: 1, filesChanged: 1 },
        },
        { at: "2026-07-27T00:01:00.000Z", error: "auth" },
        { at: "2026-07-27T00:02:00.000Z", skipped: "session_busy", outcome: { producedWork: false, filesChanged: 0 } },
      ],
    }),
  );

  const metrics = analyzeWorkerCheckpoint(path);
  assert.ok(metrics);
  assert.equal(metrics.ticks, 3);
  assert.equal(metrics.productiveTicks, 1);
  assert.equal(metrics.productiveRatio, 1 / 2);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.softSkips, 1);
  assert.equal(metrics.lastCommitted, false);
});

test("productive ratio ignores soft-skip-only sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-soft-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      ticks: [
        { at: "2026-07-27T00:00:00.000Z", skipped: "busy" },
        { at: "2026-07-27T00:01:00.000Z", skipped: "missing" },
      ],
    }),
  );
  const metrics = analyzeWorkerCheckpoint(path);
  assert.equal(metrics?.ticks, 2);
  assert.equal(metrics?.softSkips, 2);
  assert.equal(metrics?.productiveRatio, 0);
  assert.equal(meetsProductiveTickGate(metrics), false);
  const past = (Date.now() - 2 * 60 * 60_000) / 1000;
  utimesSync(path, past, past);
  // Soft-skip-only workers are waiting, not stalled zero-productivity loops.
  assert.equal(isWorkerStalled({ pidAlive: true, checkpointPath: path, stallMs: 60_000 }), false);
});

test("analyzeWorkerCheckpoint sets lastCommitted from latest tick", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-commit-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      ticks: [
        { at: "2026-07-27T00:00:00.000Z", outcome: { producedWork: false, committed: false } },
        { at: "2026-07-27T00:01:00.000Z", outcome: { producedWork: true, committed: true, commits: 1 } },
      ],
    }),
  );
  assert.equal(analyzeWorkerCheckpoint(path)?.lastCommitted, true);
});

test("analyzeWorkerCheckpoint returns null for missing or invalid files", () => {
  assert.equal(analyzeWorkerCheckpoint(undefined), null);
  assert.equal(analyzeWorkerCheckpoint("/tmp/does-not-exist-fleet-metrics.json"), null);
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-bad-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "{not-json");
  assert.equal(analyzeWorkerCheckpoint(path), null);
});

test("analyzeWorkerCheckpoint counts testFailures", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-fail-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      stoppedBecause: "error",
      ticks: [
        {
          at: "2026-07-27T00:00:00.000Z",
          outcome: { producedWork: true, committed: true, commits: 1, tests: { passed: false } },
        },
      ],
    }),
  );
  const metrics = analyzeWorkerCheckpoint(path);
  assert.equal(metrics?.testFailures, 1);
  assert.equal(metrics?.stoppedBecause, "error");
});

test("meetsProductiveTickGate requires enough ticks", () => {
  assert.equal(meetsProductiveTickGate(null), false);
  assert.equal(
    meetsProductiveTickGate({
      ticks: 2,
      productiveTicks: 2,
      productiveRatio: 1,
      commits: 2,
      filesChanged: 2,
      errors: 0,
      softSkips: 0,
      testFailures: 0,
      lastCommitted: true,
    }),
    false,
  );
  assert.equal(
    meetsProductiveTickGate({
      ticks: 10,
      productiveTicks: 3,
      productiveRatio: 0.3,
      commits: 3,
      filesChanged: 3,
      errors: 0,
      softSkips: 0,
      testFailures: 0,
      lastCommitted: false,
    }),
    true,
  );
  // Soft skips don't count toward minTicks — 2 attempts + 5 busy waits is still too few.
  assert.equal(
    meetsProductiveTickGate({
      ticks: 7,
      productiveTicks: 2,
      productiveRatio: 1,
      commits: 2,
      filesChanged: 2,
      errors: 0,
      softSkips: 5,
      testFailures: 0,
      lastCommitted: true,
    }),
    false,
  );
  assert.equal(PRODUCTIVE_TICK_GATE, 0.3);
});

test("relaunchBlockedReason stops zero-productivity relaunch loops", () => {
  const metrics = {
    ticks: 4,
    productiveTicks: 0,
    productiveRatio: 0,
    commits: 0,
    filesChanged: 0,
    errors: 4,
    softSkips: 0,
    testFailures: 0,
    lastCommitted: false,
  };
  assert.match(relaunchBlockedReason(metrics, 2) ?? "", /Zero productive ticks/i);
  assert.match(
    relaunchBlockedReason({ ...metrics, ticks: 5, productiveRatio: 0.1, productiveTicks: 0 }, 0) ?? "",
    /below 30% gate/i,
  );
  assert.equal(relaunchBlockedReason(null), null);
});

test("isWorkerStalled detects silent zero-productivity workers", () => {
  assert.equal(isWorkerStalled({ pidAlive: false, checkpointPath: "/tmp/x" }), false);
  assert.equal(isWorkerStalled({ pidAlive: true }), false);

  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-stall-"));
  const path = join(dir, "worker.json");
  const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  writeFileSync(
    path,
    JSON.stringify({
      ticks: [{ at: old, outcome: { producedWork: false, committed: false } }],
    }),
  );
  // Backdate mtime so stall window is exceeded even if lastTickAt parse fails.
  const past = (Date.now() - 2 * 60 * 60_000) / 1000;
  utimesSync(path, past, past);

  assert.equal(isWorkerStalled({ pidAlive: true, checkpointPath: path, stallMs: 60_000 }), true);
  assert.equal(isWorkerStalled({ pidAlive: true, checkpointPath: path, stallMs: 10 * 60 * 60_000 }), false);
});

test("analyzeWorkerCheckpoint ignores ticks before session start", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-session-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      startedAt: "2026-07-27T15:00:00.000Z",
      stoppedBecause: "duration",
      ticks: [
        { at: "2026-07-27T11:00:00.000Z", error: "stale" },
        {
          at: "2026-07-27T15:01:00.000Z",
          outcome: { producedWork: true, committed: true, commits: 1, filesChanged: 1 },
        },
      ],
    }),
  );
  const metrics = analyzeWorkerCheckpoint(path);
  assert.equal(metrics?.ticks, 1);
  assert.equal(metrics?.productiveTicks, 1);
  assert.equal(metrics?.stoppedBecause, "duration");
});

test("isWorkerStalled ignores fresh workers with no session ticks yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-metrics-fresh-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      startedAt: new Date().toISOString(),
      ticks: [],
    }),
  );
  assert.equal(isWorkerStalled({ pidAlive: true, checkpointPath: path, stallMs: 60_000 }), false);
});
