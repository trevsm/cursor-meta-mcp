import assert from "node:assert/strict";
import { mock, test } from "node:test";

const activityActive = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  sessionIndex: 2,
  title: "Active chat",
  workspace: process.cwd(),
  updatedAt: new Date().toISOString(),
  activityLevel: "active" as const,
  generatingBubbleCount: 1,
  loadingToolCount: 0,
  hasBlockingPendingActions: false,
  signals: ["generating_bubbles"],
};

const activityIdle = {
  ...activityActive,
  activityLevel: "idle" as const,
  generatingBubbleCount: 0,
  signals: [],
};

const getChatActivity = mock.fn(() => activityActive);
const getIdeChatActivity = mock.fn(() => activityActive);
const sendToIdeChat = mock.fn(async () => ({
  status: "finished" as const,
  result: "continued",
  sessionId: activityActive.sessionId,
}));

mock.module("../src/chat-activity.js", {
  namedExports: { getChatActivity },
});

mock.module("../src/ide-chat-control.js", {
  namedExports: {
    getIdeChatActivity,
    sendToIdeChat,
  },
});

mock.module("../src/history-store.js", {
  namedExports: {
    getChatById: mock.fn(() => ({
      id: activityActive.sessionId,
      workspace: process.cwd(),
      messages: [{ role: "assistant", content: "All tests pass. Done." }],
    })),
    getChatByIndex: mock.fn(() => ({
      id: activityActive.sessionId,
      workspace: process.cwd(),
      messages: [{ role: "assistant", content: "All tests pass. Done." }],
    })),
  },
});

const { isChatActive, lastAssistantTail, watchIdeChat } = await import("../src/watch-chat.js");

test("isChatActive reflects activity level", () => {
  assert.equal(isChatActive(activityActive), true);
  assert.equal(isChatActive(activityIdle), false);
});

test("lastAssistantTail returns trailing assistant text", () => {
  assert.match(lastAssistantTail(2)!, /All tests pass/);
});

test("watchIdeChat waits then sends follow-up when chat was active", async () => {
  getChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => activityActive);
  getChatActivity.mock.mockImplementation(() => activityIdle);

  const result = await watchIdeChat({
    sessionIndex: 2,
    followUpPrompt: "Continue.",
    cwd: process.cwd(),
    pollIntervalMs: 10,
    idleStableMs: 10,
  });

  assert.equal(result.wasAlreadyIdle, false);
  assert.ok(getChatActivity.mock.callCount() >= 1);
  assert.equal(sendToIdeChat.mock.callCount(), 1);
  assert.equal(result.followUp?.result, "continued");
});

test("watchIdeChat sends immediately when already idle", async () => {
  getChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => activityIdle);

  const result = await watchIdeChat({
    sessionIndex: 2,
    followUpPrompt: "Continue.",
    cwd: process.cwd(),
  });

  assert.equal(result.wasAlreadyIdle, true);
  assert.equal(getChatActivity.mock.callCount(), 0);
  assert.equal(sendToIdeChat.mock.callCount(), 1);
});

test("watchIdeChat only waits when no follow-up and already idle", async () => {
  getChatActivity.mock.resetCalls();
  sendToIdeChat.mock.resetCalls();
  getIdeChatActivity.mock.mockImplementation(() => activityIdle);

  const result = await watchIdeChat({
    sessionIndex: 2,
    cwd: process.cwd(),
  });

  assert.equal(result.wasAlreadyIdle, true);
  assert.equal(getChatActivity.mock.callCount(), 0);
  assert.equal(sendToIdeChat.mock.callCount(), 0);
});
