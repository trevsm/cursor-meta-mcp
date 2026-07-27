import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSdkWorkerArgs, defaultSdkCheckpointPath, runSdkWorker, runSdkWorkerTick, SDK_FLEET_AGENT_NAME, summarizeSdkWorker, writeSdkCheckpoint } from "../src/sdk-worker.js";
import { FakeLocalAgentService } from "./helpers/fake-service.js";

test("summarizeSdkWorker aggregates tick outcomes", () => {
  const summary = summarizeSdkWorker({
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    elapsedMs: 1000,
    cwd: "/tmp/project",
    durationMs: 60_000,
    maxTicks: 10,
    prompt: "work",
    stoppedBecause: "duration",
    checkpointPath: "/tmp/sdk-worker.json",
    ticks: [
      {
        tick: 1,
        at: "2026-07-27T00:00:00.000Z",
        watchedMs: 100,
        outcome: {
          committed: true,
          pushed: false,
          commits: 1,
          filesChanged: 1,
          insertions: 2,
          deletions: 0,
          dirtyFiles: 0,
          producedWork: true,
          tests: { ran: true, passed: true, total: 10, durationMs: 50, command: "npm run test:fast" },
        },
      },
      { tick: 2, at: "2026-07-27T00:01:00.000Z", watchedMs: 50, error: "transport" },
      {
        tick: 3,
        at: "2026-07-27T00:02:00.000Z",
        watchedMs: 80,
        outcome: {
          committed: false,
          pushed: false,
          commits: 0,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
          dirtyFiles: 1,
          producedWork: true,
          tests: { ran: true, passed: false, failed: 2, durationMs: 50, command: "npm run test:fast" },
        },
      },
    ],
  });

  assert.equal(summary.ticks, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.productiveTicks, 2);
  assert.equal(summary.commits, 1);
  assert.equal(summary.filesChanged, 2);
  assert.equal(summary.testFailures, 1);
  assert.equal(summary.checkpointPath, "/tmp/sdk-worker.json");
});

test("summarizeSdkWorker defaults checkpoint path when result omits it", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "sdk-summary-default-"));
  const prev = process.env.CURSOR_META_HOME;
  process.env.CURSOR_META_HOME = metaDir;
  try {
    const summary = summarizeSdkWorker({
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      elapsedMs: 0,
      cwd: "/repo",
      durationMs: 60_000,
      maxTicks: 1,
      prompt: "work",
      stoppedBecause: "duration",
      ticks: [],
    });
    assert.equal(summary.checkpointPath, defaultSdkCheckpointPath());
  } finally {
    if (prev === undefined) delete process.env.CURSOR_META_HOME;
    else process.env.CURSOR_META_HOME = prev;
  }
});

test("buildSdkWorkerArgs forwards worker options", () => {
  const args = buildSdkWorkerArgs({
    cwd: "/repo",
    durationMs: 120_000,
    maxTicks: 5,
    tickIntervalMs: 30_000,
    checkpointPath: "/tmp/worker.json",
    prompt: "ship",
    model: "composer",
    metaDir: "/meta",
  });
  assert.deepEqual(args.slice(0, 4), ["--import", "tsx", "scripts/sdk-worker.mjs", "--cwd"]);
  assert.ok(args.includes("/repo"));
  assert.ok(args.includes("--duration"));
  assert.ok(args.includes("120000"));
  assert.ok(args.includes("--max-ticks"));
  assert.ok(args.includes("--tick-interval"));
  assert.ok(args.includes("--checkpoint"));
  assert.ok(args.includes("/tmp/worker.json"));
  assert.ok(args.includes("--prompt"));
  assert.ok(args.includes("ship"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("composer"));
  assert.ok(args.includes("--meta-dir"));
  assert.ok(args.includes("/meta"));
});

test("writeSdkCheckpoint persists worker state to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdk-worker-checkpoint-"));
  const path = join(dir, "worker.json");
  const state = {
    startedAt: "2026-07-27T00:00:00.000Z",
    cwd: "/repo",
    durationMs: 60_000,
    maxTicks: 3,
    prompt: "work",
    ticks: [{ tick: 1, at: "2026-07-27T00:00:01.000Z", watchedMs: 10 }],
    stoppedBecause: "duration" as const,
  };
  assert.equal(writeSdkCheckpoint(state, path), path);
  const saved = JSON.parse(readFileSync(path, "utf8")) as typeof state;
  assert.equal(saved.cwd, "/repo");
  assert.equal(saved.ticks.length, 1);
  assert.equal(saved.stoppedBecause, "duration");
});

test("runSdkWorkerTick tags SDK runs with fleet agent name", async () => {
  const service = new FakeLocalAgentService();
  const first = await runSdkWorkerTick(service, { cwd: "/repo" }, 1, "work");
  assert.equal(service.lastRunParams?.name, SDK_FLEET_AGENT_NAME);
  assert.equal(first.agentId, "agent-test-1");

  const followUp = await runSdkWorkerTick(
    service,
    { cwd: "/repo", agentId: "agent-test-1" },
    2,
    "continue",
  );
  assert.equal(service.lastFollowUpParams?.name, SDK_FLEET_AGENT_NAME);
  assert.equal(followUp.agentId, "agent-test-1");
});

test("runSdkWorkerTick preserves agentId on transport errors", async () => {
  const service = new FakeLocalAgentService();
  service.followUpError = new Error("Connection lost");
  const entry = await runSdkWorkerTick(
    service,
    { cwd: "/repo", agentId: "agent-test-1" },
    2,
    "continue",
  );
  assert.match(entry.error ?? "", /Connection lost/);
  assert.equal(entry.agentId, "agent-test-1");
});

test("runSdkWorkerTick tags initial runLocalAgent with fleet agent name", async () => {
  const service = new FakeLocalAgentService();
  service.runError = new Error("No auth available");
  const entry = await runSdkWorkerTick(service, { cwd: "/repo" }, 1, "work");
  assert.equal(service.lastRunParams?.name, SDK_FLEET_AGENT_NAME);
  assert.match(entry.error ?? "", /No auth available/);
  assert.equal(entry.agentId, undefined);
});

test("runSdkWorker stops after eight consecutive transport errors", async () => {
  const metaDir = mkdtempSync(join(tmpdir(), "sdk-worker-consec-"));
  const checkpointPath = join(metaDir, "worker.json");
  const service = new FakeLocalAgentService();
  service.runError = new Error("Connection lost");
  service.followUpError = new Error("Connection lost");

  const prevKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "test-key";
  try {
    const result = await runSdkWorker({
      cwd: process.cwd(),
      metaDir,
      checkpointPath,
      service,
      tickIntervalMs: 0,
      durationMs: 60_000,
      maxTicks: 20,
      verifyTests: () => undefined,
    });

    assert.equal(result.stoppedBecause, "consecutive_errors");
    assert.equal(result.ticks.length, 8);
    assert.ok(result.ticks.every((tick) => /Connection lost/.test(tick.error ?? "")));
    const saved = JSON.parse(readFileSync(checkpointPath, "utf8")) as { stoppedBecause?: string };
    assert.equal(saved.stoppedBecause, "consecutive_errors");
  } finally {
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
  }
});
