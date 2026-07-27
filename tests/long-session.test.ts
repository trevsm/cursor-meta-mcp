import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

const budgetDir = mkdtempSync(join(tmpdir(), "long-session-budget-"));
process.env.CURSOR_META_BUDGET_PATH = join(budgetDir, "budget.json");
process.env.CURSOR_META_HOME = mkdtempSync(join(tmpdir(), "long-session-meta-"));
process.env.CURSOR_META_SKIP_TICK_TESTS = "1";

const createIdeChat = mock.fn(async () => ({ sessionId: "cccccccc-cccc-cccc-cccc-cccccccccccc" }));

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

const waitForChatSession = mock.fn(async () => undefined);

mock.module("../src/ide-chat-control.js", {
  namedExports: { getIdeChatActivity, sendToIdeChat, createIdeChat },
});
mock.module("../src/relentless-loop.js", { namedExports: { waitForChatIdle } });
mock.module("../src/chat-activity.js", {
  namedExports: {
    waitForChatSession,
  },
});
mock.module("../src/watch-chat.js", {
  namedExports: {
    isChatActive: (activity: { activityLevel: string }) => activity.activityLevel === "active",
    lastAssistantTail: () => "done",
  },
});

const {
  DEFAULT_LONG_SESSION_PROMPT,
  buildLongSessionArgs,
  coerceStopReason,
  countsTowardConsecutiveErrors,
  isTransientSessionMissing,
  nextTickWaitMs,
  parseDurationMs,
  readCheckpoint,
  runLongSession,
  runLongSessionTick,
  shouldStopLongSession,
  spawnLongSession,
  summarizeLongSession,
  writeCheckpoint,
  defaultCheckpointPath,
} = await import("../src/long-session.js");

after(() => mock.restoreAll());

test("coerceStopReason keeps known reasons and defaults unknown", () => {
  assert.equal(coerceStopReason("error"), "error");
  assert.equal(coerceStopReason("consecutive_errors"), "consecutive_errors");
  assert.equal(coerceStopReason("bogus"), "duration");
  assert.equal(coerceStopReason(undefined), "duration");
});

test("shouldStopLongSession respects duration and max ticks", () => {
  const startedAt = Date.now() - 1000;
  assert.equal(shouldStopLongSession(startedAt, 0, { durationMs: 500, maxTicks: 10 }), "duration");
  assert.equal(shouldStopLongSession(startedAt, 10, { durationMs: 60_000, maxTicks: 10 }), "max_ticks");
  assert.equal(shouldStopLongSession(startedAt, 1, { durationMs: 60_000, maxTicks: 10 }), null);
});

test("isTransientSessionMissing matches common not-found shapes", () => {
  assert.equal(
    isTransientSessionMissing("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found."),
    true,
  );
  assert.equal(
    isTransientSessionMissing("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found after 45000ms."),
    true,
  );
  assert.equal(isTransientSessionMissing("Session #3 not found"), true);
  assert.equal(isTransientSessionMissing("CLI not logged in"), false);
});

test("parseDurationMs accepts human units", () => {
  assert.equal(parseDurationMs("10m"), 600_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs("500"), 500);
  assert.equal(parseDurationMs("1.5m"), 90_000);
  assert.equal(parseDurationMs("1d"), 86_400_000);
  assert.equal(parseDurationMs("600000ms"), 600_000);
  assert.throws(() => parseDurationMs("nope"), /Invalid duration/);
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

test("defaultCheckpointPath uses session slug", () => {
  const path = defaultCheckpointPath("abcd1234-0000-0000-0000-000000000000", 7);
  assert.match(path, /abcd1234\.json$/);
  const byIndex = defaultCheckpointPath(undefined, 3);
  assert.match(byIndex, /session-3\.json$/);
});

test("runLongSession waits for sessionId before ticking", async () => {
  waitForChatSession.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();

  await runLongSession({
    cwd: "/tmp/project",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    durationMs: 50,
    tickIntervalMs: 1,
    maxTicks: 100,
    checkpointPath: `/tmp/long-session-session-id-${Date.now()}.json`,
  });

  assert.equal(waitForChatSession.mock.callCount(), 1);
  assert.equal(waitForChatSession.mock.calls[0]?.arguments[0], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
});

test("runLongSessionTick skips busy chats", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
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

test("runLongSessionTick waits through busy when continueOnBusy is false", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementationOnce(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "active",
  }));

  const tick = await runLongSessionTick(
    {
      cwd: "/tmp",
      sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      sessionIndex: 1,
      continueOnBusy: false,
    },
    1,
    "go",
  );
  assert.equal(tick.skipped, undefined);
  assert.equal(tick.wasAlreadyIdle, false);
  assert.equal(sendToIdeChat.mock.callCount(), 0);
  assert.equal(waitForChatIdle.mock.callCount(), 1);
});

test("runLongSessionTick tolerates activity lookup failures", async () => {
  getIdeChatActivity.mock.mockImplementationOnce(() => {
    throw new Error("history unavailable");
  });

  const tick = await runLongSessionTick(
    { cwd: "/tmp", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionIndex: 1 },
    1,
    "go",
  );
  assert.equal(tick.wasAlreadyIdle, true);
  assert.equal(tick.skipped, undefined);
  assert.equal(sendToIdeChat.mock.callCount(), 1);
});

test("runLongSessionTick returns skipped missing when sendToIdeChat throws session not found", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  sendToIdeChat.mock.mockImplementationOnce(async () => {
    throw new Error("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found.");
  });

  const tick = await runLongSessionTick(
    { cwd: "/tmp", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionIndex: 1 },
    1,
    "go",
  );
  assert.equal(tick.skipped, "missing");
  assert.match(tick.error ?? "", /not found/i);
  assert.equal(waitForChatIdle.mock.callCount(), 0);
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
    durationMs: 200,
    tickIntervalMs: 1,
    maxTicks: 5,
    checkpointPath: `/tmp/long-session-error-${Date.now()}.json`,
  });

  assert.equal(result.stoppedBecause, "error");
  assert.match(result.ticks[0]?.error ?? "", /CLI not logged in/);
});

test("runLongSessionTick soft-skips when session is missing", async () => {
  sendToIdeChat.mock.resetCalls();
  sendToIdeChat.mock.mockImplementationOnce(async () => {
    throw new Error("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found.");
  });

  const tick = await runLongSessionTick(
    { cwd: "/tmp", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionIndex: 1 },
    1,
    "go",
  );
  assert.equal(tick.skipped, "missing");
  assert.match(tick.error ?? "", /not found/);
});

test("runLongSession soft-skips missing sessions without hard-stopping as error", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));
  sendToIdeChat.mock.mockImplementation(async () => {
    throw new Error("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found.");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 80,
    tickIntervalMs: 1,
    maxTicks: 10_000,
    maxConsecutiveErrors: 2,
    checkpointPath: `/tmp/long-session-missing-${Date.now()}.json`,
  });

  assert.ok(result.ticks.length >= 2);
  assert.ok(result.ticks.every((tick) => tick.skipped === "missing"));
  assert.notEqual(result.stoppedBecause, "error");
  assert.notEqual(result.stoppedBecause, "consecutive_errors");

  sendToIdeChat.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }));
});

test("runLongSession continues when waitForChatSession times out as missing", async () => {
  waitForChatSession.mock.resetCalls();
  waitForChatSession.mock.mockImplementationOnce(async () => {
    throw new Error("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found after 45000ms.");
  });
  sendToIdeChat.mock.resetCalls();
  sendToIdeChat.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }));

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    durationMs: 50,
    tickIntervalMs: 1,
    maxTicks: 5,
    checkpointPath: `/tmp/long-session-wait-missing-${Date.now()}.json`,
  });

  assert.equal(waitForChatSession.mock.callCount(), 1);
  assert.notEqual(result.stoppedBecause, "error");
  assert.ok(sendToIdeChat.mock.callCount() >= 1);
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
      {
        tick: 5,
        at: "t",
        watchedMs: 10,
        wasAlreadyIdle: true,
        skipped: "missing",
        error: "Chat session missing",
      },
    ],
  });
  assert.equal(summary.ticks, 5);
  assert.equal(summary.avgWatchMs, 102);
  assert.equal(summary.errors, 0);
  assert.equal(summary.busySkips, 1);
  assert.equal(summary.timeouts, 1);
  assert.equal(summary.missingSkips, 1);
  assert.equal(summary.checkpointPath, "/tmp/custom-checkpoint.json");
});

test("summarizeLongSession falls back to default checkpoint path", () => {
  const summary = summarizeLongSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    elapsedMs: 600_000,
    stoppedBecause: "duration",
    cwd: "/tmp",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    durationMs: 600_000,
    maxTicks: 10,
    prompt: "go",
    ticks: [],
  });
  assert.match(summary.checkpointPath, /long-sessions\/aaaaaaaa\.json$/);
});

test("runLongSession invokes onTick after each tick", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));

  const seen: number[] = [];
  await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 30,
    tickIntervalMs: 1,
    maxTicks: 5,
    checkpointPath: `/tmp/long-session-ontick-${Date.now()}.json`,
    onTick: (tick) => {
      seen.push(tick.tick);
    },
  });

  assert.ok(seen.length >= 1);
  assert.deepEqual(seen, seen.toSorted((a, b) => a - b));
});

test("summarizeLongSession handles empty ticks", () => {
  const summary = summarizeLongSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    elapsedMs: 1000,
    stoppedBecause: "duration",
    cwd: "/tmp",
    sessionIndex: 1,
    durationMs: 1000,
    maxTicks: 10,
    prompt: "go",
    ticks: [],
  });
  assert.equal(summary.ticks, 0);
  assert.equal(summary.avgWatchMs, 0);
  assert.equal(summary.errors, 0);
});

test("countsTowardConsecutiveErrors ignores busy and missing skips", () => {
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
      skipped: "missing",
      error: "Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found.",
    }),
    false,
  );
  assert.equal(
    countsTowardConsecutiveErrors({
      tick: 4,
      at: "t",
      watchedMs: 1,
      wasAlreadyIdle: true,
    }),
    false,
  );
});

test("nextTickWaitMs shortens wait after busy skips", () => {
  assert.equal(
    nextTickWaitMs(
      { tick: 1, at: "t", watchedMs: 1, wasAlreadyIdle: false, skipped: "busy", error: "chat_busy" },
      15_000,
      2_000,
    ),
    2_000,
  );
  assert.equal(
    nextTickWaitMs(
      {
        tick: 3,
        at: "t",
        watchedMs: 1,
        wasAlreadyIdle: false,
        skipped: "missing",
        error: "Session not found",
      },
      15_000,
      2_000,
    ),
    2_000,
  );
  assert.equal(
    nextTickWaitMs({ tick: 2, at: "t", watchedMs: 1, wasAlreadyIdle: true }, 15_000, 2_000),
    15_000,
  );
});

test("buildLongSessionArgs maps params to CLI flags", () => {
  const args = buildLongSessionArgs({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 1_800_000,
    maxTicks: 50,
    prompt: "keep going",
    continueOnBusy: false,
    continueOnTimeout: false,
    maxConsecutiveErrors: 4,
  });
  assert.deepEqual(args, [
    "--import",
    "tsx",
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
    "--no-continue-on-busy",
    "--no-continue-on-timeout",
    "--max-consecutive-errors",
    "4",
  ]);
});

test("runLongSession requires session target", async () => {
  await assert.rejects(() => runLongSession({ cwd: "/tmp" }), /sessionIndex or sessionId/);
});

test("runLongSession continues through session-not-found soft skips", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));

  let sendCalls = 0;
  sendToIdeChat.mock.mockImplementation(async () => {
    sendCalls += 1;
    if (sendCalls <= 2) {
      throw new Error("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found.");
    }
    return { sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    durationMs: 200,
    tickIntervalMs: 1,
    maxTicks: 10,
    maxConsecutiveErrors: 5,
    checkpointPath: `/tmp/long-session-missing-continue-${Date.now()}.json`,
  });

  assert.ok(result.ticks.length >= 3);
  assert.ok(result.ticks.slice(0, 2).every((tick) => tick.skipped === "missing"));
  assert.notEqual(result.stoppedBecause, "error");
  assert.notEqual(result.stoppedBecause, "consecutive_errors");

  sendToIdeChat.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }));
});

test("runLongSession does not stop after consecutive missing session skips", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));
  sendToIdeChat.mock.mockImplementation(async () => {
    throw new Error("Chat session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa not found.");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    durationMs: 80,
    tickIntervalMs: 1,
    maxTicks: 10_000,
    maxConsecutiveErrors: 3,
    checkpointPath: `/tmp/long-session-missing-consec-${Date.now()}.json`,
  });

  assert.ok(result.ticks.length >= 3);
  assert.ok(result.ticks.every((tick) => tick.skipped === "missing"));
  assert.notEqual(result.stoppedBecause, "consecutive_errors");
  assert.notEqual(result.stoppedBecause, "error");

  sendToIdeChat.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }));
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
  sendToIdeChat.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }));
  waitForChatIdle.mock.mockImplementation(async () => {
    throw new Error("Timed out waiting for chat a to become idle.");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 200,
    tickIntervalMs: 1,
    maxTicks: 10,
    maxConsecutiveErrors: 3,
    checkpointPath: `/tmp/long-session-consec-${Date.now()}.json`,
  });

  assert.equal(result.stoppedBecause, "consecutive_errors");
  assert.equal(result.ticks.length, 3);
  assert.ok(result.ticks.every((tick) => tick.skipped === "timeout"));
  assert.equal(result.checkpointPath?.includes("long-session-consec"), true);

  waitForChatIdle.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    activityLevel: "idle",
  }));
});

test("runLongSession stops at maxTicks", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));
  waitForChatIdle.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    activityLevel: "idle",
  }));

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 200,
    tickIntervalMs: 1,
    maxTicks: 2,
    checkpointPath: `/tmp/long-session-maxticks-${Date.now()}.json`,
  });

  assert.equal(result.stoppedBecause, "max_ticks");
  assert.equal(result.ticks.length, 2);
});

test("runLongSession requires cwd", async () => {
  await assert.rejects(
    () => runLongSession({ cwd: "   ", sessionIndex: 1 }),
    /cwd is required/,
  );
});

test("runLongSession hard-stops when continueOnTimeout is false", async () => {
  getIdeChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  waitForChatIdle.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionIndex: 1,
    activityLevel: "idle",
  }));
  sendToIdeChat.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }));
  waitForChatIdle.mock.mockImplementation(async () => {
    throw new Error("Timed out waiting for chat a to become idle.");
  });

  const result = await runLongSession({
    cwd: "/tmp/project",
    sessionIndex: 1,
    durationMs: 200,
    tickIntervalMs: 1,
    maxTicks: 10_000,
    continueOnTimeout: false,
    checkpointPath: `/tmp/long-session-hard-timeout-${Date.now()}.json`,
  });

  assert.equal(result.stoppedBecause, "error");
  assert.equal(result.ticks.length, 1);
  assert.match(result.ticks[0]?.error ?? "", /Timed out waiting for chat/);
  assert.equal(result.ticks[0]?.skipped, undefined);

  waitForChatIdle.mock.mockImplementation(async () => ({
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    activityLevel: "idle",
  }));
});
