import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { OrchestrationPlay } from "../src/consciousness-pulse.js";

const entry = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  sessionIndex: 2,
  title: "Feature chat",
  workspace: "/Users/you/project",
  signals: [],
  frustrationRisk: { score: 0.9, reason: "terse_still" },
  plays: [
    {
      action: "WATCH" as const,
      tool: "meta_watch_chat",
      why: "wait",
    },
    {
      action: "INTERCEPT" as const,
      tool: "meta_intercept_chat",
      why: "frustration",
      prompt: "Stop and verify.",
    },
    {
      action: "CONTINUE" as const,
      tool: "meta_watch_chat",
      why: "continue",
      prompt: "Keep going.",
    },
  ],
};

const watchIdeChat = mock.fn(async () => ({ watchedMs: 10, wasAlreadyIdle: true }));
const interceptIdeChat = mock.fn(async () => ({ result: "steered" }));

mock.module("../src/watch-chat.js", { namedExports: { watchIdeChat } });
mock.module("../src/ide-chat-control.js", { namedExports: { interceptIdeChat } });

const { executeOrchestrationPlay, filterOrchestrationMatrix, selectPlaysForSession } =
  await import("../src/orchestrate-pulse.js");

test("filterOrchestrationMatrix excludes session ids and indexes", () => {
  const matrix = [
    {
      sessionId: "aaaa",
      sessionIndex: 1,
      title: "A",
      workspace: "/p",
      signals: [],
      frustrationRisk: { score: 0, reason: null },
      plays: [{ action: "WATCH" as const, tool: "meta_watch_chat", why: "w" }],
    },
    {
      sessionId: "bbbb",
      sessionIndex: 2,
      title: "B",
      workspace: "/p",
      signals: [],
      frustrationRisk: { score: 0, reason: null },
      plays: [{ action: "WATCH" as const, tool: "meta_watch_chat", why: "w" }],
    },
  ];
  assert.equal(filterOrchestrationMatrix(matrix, { excludeSessionIndexes: [1] }).length, 1);
  assert.equal(filterOrchestrationMatrix(matrix, { excludeSessionIds: ["bbbb"] }).length, 1);
});

test("selectPlaysForSession prioritizes intercept over watch", () => {
  const selected = selectPlaysForSession(entry, { allowIntercept: true, allowWatch: true });
  assert.equal(selected[0]?.action, "INTERCEPT");
});

test("selectPlaysForSession filters disallowed actions", () => {
  const selected = selectPlaysForSession(entry, { allowIntercept: false, allowContinue: true });
  assert.deepEqual(
    selected.map((play) => play.action),
    ["CONTINUE", "WATCH"],
  );
});

test("executeOrchestrationPlay dry-run does not call IDE tools", async () => {
  watchIdeChat.mock.resetCalls();
  interceptIdeChat.mock.resetCalls();

  const result = await executeOrchestrationPlay(
    entry,
    entry.plays[1] as OrchestrationPlay,
    { dryRun: true },
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.result, undefined);
  assert.equal(interceptIdeChat.mock.callCount(), 0);
});

test("executeOrchestrationPlay runs intercept when not dry-run", async () => {
  watchIdeChat.mock.resetCalls();
  interceptIdeChat.mock.resetCalls();

  const result = await executeOrchestrationPlay(
    entry,
    entry.plays[1] as OrchestrationPlay,
    { dryRun: false },
  );
  assert.equal(result.action, "INTERCEPT");
  assert.equal(interceptIdeChat.mock.callCount(), 1);
  assert.equal(watchIdeChat.mock.callCount(), 0);
});

test("executeOrchestrationPlay runs continue via watch chat", async () => {
  watchIdeChat.mock.resetCalls();
  interceptIdeChat.mock.resetCalls();

  const result = await executeOrchestrationPlay(
    entry,
    entry.plays[2] as OrchestrationPlay,
    { dryRun: false },
  );
  assert.equal(result.action, "CONTINUE");
  assert.equal(watchIdeChat.mock.callCount(), 1);
});

test("executeOrchestrationPlay errors on unknown workspace", async () => {
  const result = await executeOrchestrationPlay(
    { ...entry, workspace: "unknown" },
    entry.plays[1] as OrchestrationPlay,
    { dryRun: false },
  );
  assert.match(result.error ?? "", /Workspace unknown/);
});

test("executeOrchestrationPlay errors when continue play has no prompt", async () => {
  const result = await executeOrchestrationPlay(
    entry,
    { action: "CONTINUE", tool: "meta_watch_chat", why: "continue" },
    { dryRun: false },
  );
  assert.match(result.error ?? "", /missing prompt/);
});

test("executeOrchestrationPlay errors when spawn requested without SDK service", async () => {
  const result = await executeOrchestrationPlay(
    entry,
    {
      action: "SPAWN_SPECIALIST",
      tool: "meta_spawn_local_agent",
      why: "verify",
      prompt: "Check tests.",
    },
    { dryRun: false, allowSpawn: true },
  );
  assert.match(result.error ?? "", /requires SDK agent service/);
});

test("executeOrchestrationPlay runs spawn with SDK service", async () => {
  watchIdeChat.mock.resetCalls();
  interceptIdeChat.mock.resetCalls();

  const fakeService = {
    runLocalAgent: mock.fn(async () => ({ agentId: "verifier", runId: "r1", status: "finished" })),
  };

  const result = await executeOrchestrationPlay(
    entry,
    {
      action: "SPAWN_SPECIALIST",
      tool: "meta_spawn_local_agent",
      why: "verify",
      prompt: "Check tests.",
    },
    { dryRun: false, allowSpawn: true },
    fakeService as never,
  );
  assert.equal(result.action, "SPAWN_SPECIALIST");
  assert.equal(fakeService.runLocalAgent.mock.callCount(), 1);
});

test("executeOrchestrationPlay errors when intercept play has no prompt", async () => {
  const result = await executeOrchestrationPlay(
    entry,
    { action: "INTERCEPT", tool: "meta_intercept_chat", why: "frustration" },
    { dryRun: false },
  );
  assert.match(result.error ?? "", /missing prompt/);
});

test("executeOrchestrationPlay surfaces tool errors", async () => {
  interceptIdeChat.mock.mockImplementationOnce(async () => {
    throw new Error("IDE unavailable");
  });

  const result = await executeOrchestrationPlay(
    entry,
    entry.plays[1] as OrchestrationPlay,
    { dryRun: false },
  );
  assert.equal(result.error, "IDE unavailable");
});

test("executeOrchestrationPlay runs watch when not dry-run", async () => {
  watchIdeChat.mock.resetCalls();

  const result = await executeOrchestrationPlay(
    entry,
    entry.plays[0] as OrchestrationPlay,
    { dryRun: false },
  );
  assert.equal(result.action, "WATCH");
  assert.equal(watchIdeChat.mock.callCount(), 1);
});
