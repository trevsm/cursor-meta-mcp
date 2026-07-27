import assert from "node:assert/strict";
import { mock, test } from "node:test";

const getIdeChatActivity = mock.fn(() => ({
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  sessionIndex: 1,
  activityLevel: "idle",
}));

const sendToIdeChat = mock.fn(async () => ({ sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }));
const waitForChatIdle = mock.fn(async () => ({
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  activityLevel: "idle",
}));

mock.module("../src/ide-chat-control.js", {
  namedExports: { getIdeChatActivity, sendToIdeChat },
});
mock.module("../src/relentless-loop.js", { namedExports: { waitForChatIdle } });
mock.module("../src/watch-chat.js", {
  namedExports: {
    isChatActive: (activity: { activityLevel: string }) => activity.activityLevel === "active",
    lastAssistantTail: () => "done",
  },
});

const {
  DEFAULT_LONG_SESSION_PROMPT,
  countsTowardConsecutiveErrors,
  readCheckpoint,
  runLongSession,
  runLongSessionTick,
  shouldStopLongSession,
  summarizeLongSession,
  writeCheckpoint,
} = await import("../src/long-session.js");

test("shouldStopLongSession respects duration and max ticks", () => {
  const startedAt = Date.now() - 1000;
  assert.equal(shouldStopLongSession(startedAt, 0, { durationMs: 500, maxTicks: 10 }), "duration");
  assert.equal(shouldStopLongSession(startedAt, 10, { durationMs: 60_000, maxTicks: 10 }), "max_ticks");
  assert.equal(shouldStopLongSession(startedAt, 1, { durationMs: 60_000, maxTicks: 10 }), null);
});

test("writeCheckpoint and readCheckpoint round-trip", () => {
  const path = `/tmp/long-session-test-${Date.now()}.json`;
  const state = {
    startedAt: new Date().toISOString(),
    cwd: "/tmp",
    sessionIndex: 1,
    durationMs: 1000,
    maxTicks: 3,
    prompt: DEFAULT_LONG_SESSION_PROMPT,
    ticks: [],
  };
  writeCheckpoint(state, path);
  const loaded = readCheckpoint(path);
  assert.equal(loaded.sessionIndex, 1);
  assert.equal(loaded.cwd, "/tmp");
});

test("runLongSessionTick skips busy chats", async () => {
  getIdeChatActivity.mock.mockImplementationOnce(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "active",
  }));

  const tick = await runLongSessionTick(
    { cwd: "/tmp", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionIndex: 1 },
    1,
    "go",
  );
  assert.equal(tick.skipped, "busy");
  assert.equal(sendToIdeChat.mock.callCount(), 0);
});

test("runLongSession executes ticks until duration budget", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 50,
    tickIntervalMs: 1,
    maxTicks: 100,
    checkpointPath: `/tmp/long-session-run-${Date.now()}.json`,
  });

  assert.ok(result.ticks.length >= 1);
  assert.equal(result.stoppedBecause, "duration");
  assert.ok(sendToIdeChat.mock.callCount() >= 1);
});

test("runLongSession continues through soft timeout failures", async () => {
  waitForChatIdle.mock.mockImplementationOnce(async () => {
    throw new Error("Timed out waiting for chat a to become idle.");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 50,
    tickIntervalMs: 1,
    maxTicks: 100,
    checkpointPath: `/tmp/long-session-soft-${Date.now()}.json`,
  });

  assert.ok(result.ticks.some((tick) => tick.skipped === "timeout"));
  assert.notEqual(result.stoppedBecause, "error");
});

test("runLongSession stops on hard errors", async () => {
  sendToIdeChat.mock.mockImplementationOnce(async () => {
    throw new Error("CLI not logged in");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 60_000,
    tickIntervalMs: 1,
    maxTicks: 5,
    checkpointPath: `/tmp/long-session-error-${Date.now()}.json`,
  });

  assert.equal(result.stoppedBecause, "error");
  assert.match(result.ticks[0]?.error ?? "", /CLI not logged in/);
});

test("summarizeLongSession aggregates tick stats", () => {
  const summary = summarizeLongSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    elapsedMs: 600_000,
    stoppedBecause: "duration",
    cwd: "/tmp",
    sessionIndex: 1,
    durationMs: 600_000,
    maxTicks: 10,
    prompt: "go",
    checkpointPath: "/tmp/custom-checkpoint.json",
    ticks: [
      { tick: 1, at: "t", watchedMs: 100, wasAlreadyIdle: true },
      { tick: 2, at: "t", watchedMs: 300, wasAlreadyIdle: false },
      { tick: 3, at: "t", watchedMs: 50, wasAlreadyIdle: false, skipped: "busy", error: "chat_busy" },
      {
        tick: 4,
        at: "t",
        watchedMs: 50,
        wasAlreadyIdle: true,
        skipped: "timeout",
        error: "Timed out waiting for chat",
      },
    ],
  });
  assert.equal(summary.ticks, 4);
  assert.equal(summary.avgWatchMs, 125);
  assert.equal(summary.errors, 0);
  assert.equal(summary.busySkips, 1);
  assert.equal(summary.timeouts, 1);
  assert.equal(summary.checkpointPath, "/tmp/custom-checkpoint.json");
});

test("countsTowardConsecutiveErrors ignores busy skips", () => {
  assert.equal(
    countsTowardConsecutiveErrors({
      tick: 1,
      at: "t",
      watchedMs: 1,
      wasAlreadyIdle: false,
      skipped: "busy",
      error: "chat_busy",
    }),
    false,
  );
  assert.equal(
    countsTowardConsecutiveErrors({
      tick: 2,
      at: "t",
      watchedMs: 1,
      wasAlreadyIdle: true,
      skipped: "timeout",
      error: "Timed out waiting for chat",
    }),
    true,
  );
  assert.equal(
    countsTowardConsecutiveErrors({
      tick: 3,
      at: "t",
      watchedMs: 1,
      wasAlreadyIdle: true,
    }),
    false,
  );
});

test("buildLongSessionArgs maps params to CLI flags", async () => {
  const { buildLongSessionArgs } = await import("../src/long-session.js");
  const args = buildLongSessionArgs({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 1_800_000,
    maxTicks: 50,
    prompt: "keep going",
  });
  assert.deepEqual(args, [
    "scripts/long-session.mjs",
    "--cwd",
    "/tmp/project",
    "--session",
    "1",
    "--duration",
    "1800000",
    "--max-ticks",
    "50",
    "--prompt",
    "keep going",
  ]);
});

test("runLongSession requires session target", async () => {
  await assert.rejects(() => runLongSession({ cwd: "/tmp" }), /sessionIndex or sessionId/);
});

test("runLongSession does not stop after repeated busy skips", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "active",
  }));

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 80,
    tickIntervalMs: 1,
    maxTicks: 20,
    maxConsecutiveErrors: 3,
    checkpointPath: `/tmp/long-session-busy-${Date.now()}.json`,
  });

  assert.ok(result.ticks.length >= 3);
  assert.ok(result.ticks.every((tick) => tick.skipped === "busy"));
  assert.notEqual(result.stoppedBecause, "consecutive_errors");
  assert.notEqual(result.stoppedBecause, "error");

  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));
});

test("runLongSession stops after consecutive soft timeouts", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));
  waitForChatIdle.mock.mockImplementation(async () => {
    throw new Error("Timed out waiting for chat a to become idle.");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 60_000,
    tickIntervalMs: 1,
    maxTicks: 20,
    maxConsecutiveErrors: 3,
    checkpointPath: `/tmp/long-session-consec-${Date.now()}.json`,
  });

  assert.equal(result.stoppedBecause, "consecutive_errors");
  assert.equal(result.ticks.length, 3);
  assert.ok(result.ticks.every((tick) => tick.skipped === "timeout"));

  waitForChatIdle.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    activityLevel: "idle",
  }));
});
