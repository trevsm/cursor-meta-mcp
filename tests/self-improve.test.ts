import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const budgetDir = mkdtempSync(join(tmpdir(), "self-improve-budget-"));
process.env.CURSOR_META_BUDGET_PATH = join(budgetDir, "budget.json");

const createIdeChat = mock.fn(async () => ({ sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }));
const waitForChatSession = mock.fn(async () => undefined);
const getSessionIndexForId = mock.fn(() => 42);
const spawnLongSession = mock.fn((params: { checkpointPath?: string; sessionId?: string; sessionIndex?: number }) => ({
  pid: 1000 + (params.sessionIndex ?? 0),
  checkpointPath: params.checkpointPath ?? "/tmp/checkpoint.json",
  logPath: "/tmp/checkpoint.log",
  command: ["node", "scripts/long-session.mjs"],
}));
const runConsciousnessPulse = mock.fn(() => ({
  frustrationEvents: [],
  parallelWorkspaces: [],
}));

mock.module("../src/ide-chat-control.js", { namedExports: { createIdeChat } });
mock.module("../src/chat-activity.js", { namedExports: { waitForChatSession } });
mock.module("../src/history-store.js", { namedExports: { getSessionIndexForId } });
mock.module("../src/long-session.js", {
  namedExports: {
    DEFAULT_LONG_SESSION_PROMPT: "DEFAULT PROMPT",
    spawnLongSession,
  },
});
mock.module("../src/consciousness-pulse.js", { namedExports: { runConsciousnessPulse } });
mock.module("../src/strategy-review.js", {
  namedExports: { DEFAULT_SELF_IMPROVE_GOAL: "Autonomous self-improve goal" },
});

const { buildSelfImprovePrompt, launchSelfImproveFleet } = await import("../src/self-improve.js");

test("buildSelfImprovePrompt includes base rules", () => {
  const prompt = buildSelfImprovePrompt("/Users/me/Projects/cursor-meta-mcp", "Custom base");
  assert.match(prompt, /Custom base/);
  assert.match(prompt, /no user questions/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Do not commit unless asked/);
});

test("buildSelfImprovePrompt adds pulse context when frustration events exist", () => {
  runConsciousnessPulse.mock.mockImplementationOnce(() => ({
    frustrationEvents: [
      {
        sessionIndex: 3,
        title: "Stuck chat",
        orchestrationExempt: false,
        frustrationRisk: { score: 0.9, reason: "false_completion_response" },
        signals: ["loading_tools"],
      },
    ],
    parallelWorkspaces: [{ workspace: "cursor-meta-mcp", concurrentSessions: 3, titles: ["a", "b"] }],
  }));

  const prompt = buildSelfImprovePrompt("/Users/me/Projects/cursor-meta-mcp");
  assert.match(prompt, /Pulse context/);
  assert.match(prompt, /false_completion_response/);
  assert.match(prompt, /3 concurrent tabs/);
});

test("launchSelfImproveFleet waits for dedicated chat before spawning", async () => {
  createIdeChat.mock.resetCalls();
  waitForChatSession.mock.resetCalls();
  spawnLongSession.mock.resetCalls();

  const manifest = await launchSelfImproveFleet({
    cwd: "/tmp/project",
    metaDir: "/tmp/self-improve-test",
    workerSessionIndexes: [2],
    withOrchestrator: false,
    withWatcher: false,
  });

  assert.equal(createIdeChat.mock.callCount(), 1);
  assert.equal(waitForChatSession.mock.callCount(), 1);
  assert.equal(waitForChatSession.mock.calls[0]?.arguments[0], "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  assert.ok(manifest.experiments.length >= 2);
  assert.equal(manifest.dedicatedWorker.sessionId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  assert.equal(manifest.dedicatedWorker.sessionIndex, 42);
});

test("launchSelfImproveFleet requires cwd", async () => {
  await assert.rejects(() => launchSelfImproveFleet({ cwd: "  " }), /cwd is required/);
});
