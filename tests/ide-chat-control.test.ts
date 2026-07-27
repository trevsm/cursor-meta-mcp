import assert from "node:assert/strict";
import { mock, test } from "node:test";

const activity = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  sessionIndex: 1,
  title: "Test chat",
  workspace: process.cwd(),
  updatedAt: new Date().toISOString(),
  activityLevel: "active" as const,
  generatingBubbleCount: 1,
  loadingToolCount: 1,
  hasBlockingPendingActions: false,
  signals: ["loading_tools"],
};

mock.module("../src/chat-activity.js", {
  namedExports: {
    getChatActivity: mock.fn(() => activity),
    getChatActivityByIndex: mock.fn(() => activity),
    listActiveChats: mock.fn(() => [activity]),
    abortIdeChatInStorage: mock.fn(() => ({ aborted: true, previousStatus: "running" })),
  },
});

mock.module("../src/agent-cli.js", {
  namedExports: {
    isAgentCliLoggedIn: mock.fn(async () => true),
    runAgentCliResume: mock.fn(async () => ({ status: "finished", result: "steered" })),
    createAgentChat: mock.fn(async () => "22222222-2222-2222-2222-222222222222"),
  },
});

const {
  abortIdeChat,
  createIdeChat,
  getIdeChatActivity,
  interceptIdeChat,
  listActiveIdeChats,
  sendToIdeChat,
} = await import("../src/ide-chat-control.js");

test("sendToIdeChat resolves sessionIndex and sends via CLI resume", async () => {
  const result = await sendToIdeChat({
    sessionIndex: 1,
    prompt: "steer please",
    cwd: process.cwd(),
  });

  assert.equal(result.sessionId, activity.sessionId);
  assert.equal(result.result, "steered");
});

test("interceptIdeChat aborts then sends", async () => {
  const result = await interceptIdeChat({
    sessionId: activity.sessionId,
    prompt: "do this instead",
    cwd: process.cwd(),
    abortFirst: true,
  });

  assert.equal(result.abort?.aborted, true);
  assert.equal(result.result, "steered");
});

test("abortIdeChat returns abort metadata", async () => {
  const result = await abortIdeChat({ sessionIndex: 1 });
  assert.equal(result.sessionId, activity.sessionId);
  assert.equal(result.abort.aborted, true);
});

test("createIdeChat returns a new session id", async () => {
  assert.deepEqual(await createIdeChat(), {
    sessionId: "22222222-2222-2222-2222-222222222222",
  });
});

test("list and get activity helpers delegate to chat-activity", () => {
  assert.equal(listActiveIdeChats({ limit: 1 })[0]?.sessionId, activity.sessionId);
  assert.equal(getIdeChatActivity({ sessionIndex: 1 }).title, "Test chat");
});

test("sendToIdeChat requires session selector", async () => {
  await assert.rejects(() => sendToIdeChat({ prompt: "x", cwd: process.cwd() }), /sessionId or sessionIndex/);
});
