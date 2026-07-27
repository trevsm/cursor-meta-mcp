import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

const budgetDir = mkdtempSync(join(tmpdir(), "self-improve-budget-"));
process.env.CURSOR_META_BUDGET_PATH = join(budgetDir, "budget.json");

const createIdeChat = mock.fn(async () => ({ sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }));
const waitForChatSession = mock.fn(async () => undefined);
const spawnLongSession = mock.fn((params: { checkpointPath?: string; sessionId?: string; sessionIndex?: number }) => ({
  pid: 1000 + (params.sessionIndex ?? 0),
  checkpointPath: params.checkpointPath ?? "/tmp/checkpoint.json",
  logPath: "/tmp/checkpoint.log",
  command: ["node", "scripts/long-session.mjs"],
}));
const getSessionIndexForId = mock.fn(() => 9);
const getGitSyncStatus = mock.fn(() => ({
  available: true,
  branch: "main",
  ahead: 0,
  behind: 0,
  dirty: false,
  unpushed: false,
  uncommittedSummary: "(clean working tree)",
}));

mock.module("../src/fleet-control.js", {
  namedExports: {
    stopFleetProcesses: mock.fn(() => ({ killed: [], manifest: null })),
    collectFleetPids: mock.fn(() => []),
    readDedicatedWorker: mock.fn(() => null),
    stopKnownFleetProcesses: mock.fn(() => []),
  },
});
mock.module("../src/ide-chat-control.js", {
  namedExports: {
    createIdeChat,
    sendToIdeChat: mock.fn(async () => ({ sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })),
    abortIdeChat: mock.fn(async () => ({ sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })),
    interceptIdeChat: mock.fn(async () => ({ sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })),
    listActiveIdeChats: mock.fn(() => []),
    getIdeChatActivity: mock.fn(),
  },
});
mock.module("../src/chat-activity.js", {
  namedExports: {
    waitForChatSession,
    getChatActivity: mock.fn(),
    getChatActivityByIndex: mock.fn(),
    listActiveChats: mock.fn(() => []),
    abortIdeChatInStorage: mock.fn(() => ({ aborted: false })),
  },
});
mock.module("../src/long-session.js", {
  namedExports: {
    DEFAULT_LONG_SESSION_PROMPT: "DEFAULT PROMPT",
    spawnLongSession,
  },
});
mock.module("../src/history-store.js", {
  namedExports: {
    getSessionIndexForId,
    exportChatMarkdown: mock.fn(() => "# mock"),
    getChatById: mock.fn(),
    getChatByIndex: mock.fn(),
    listChatSummaries: mock.fn(() => ({ total: 0, sessions: [] })),
    searchChats: mock.fn(() => []),
    summarizeSessionForPrompt: mock.fn(() => ""),
    getDefaultDataPath: mock.fn(() => "/tmp"),
  },
});
mock.module("../src/git-sync.js", {
  namedExports: {
    getGitSyncStatus,
    gitFetch: mock.fn(() => ({ ok: true })),
    formatGitSyncStatusForPrompt: mock.fn(
      () => "Git state: branch=main — clean and synced with origin.",
    ),
    SELF_IMPROVE_GIT_RULES:
      "Each tick: one high-value improvement → verify with npm test. Do not create git commits unless explicitly asked.",
  },
});
mock.module("../src/consciousness-pulse.js", {
  namedExports: {
    runConsciousnessPulse: mock.fn(() => ({
      frustrationEvents: [],
      parallelWorkspaces: [],
    })),
  },
});

const { buildSelfImprovePrompt, launchSelfImproveFleet } = await import("../src/self-improve.js");

after(() => mock.restoreAll());

test("buildSelfImprovePrompt includes base rules", () => {
  const prompt = buildSelfImprovePrompt("/Users/me/Projects/cursor-meta-mcp", "Custom base");
  assert.match(prompt, /Custom base/);
  assert.match(prompt, /no user questions/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Do not create git commits unless explicitly asked/);
  assert.match(prompt, /Git state:/);
});

test("buildSelfImprovePrompt uses SELF_IMPROVE_BASE_PROMPT when base omitted", () => {
  const prompt = buildSelfImprovePrompt("/Users/me/Projects/cursor-meta-mcp");
  assert.match(prompt, /Self-improve this codebase autonomously/);
  assert.match(prompt, /Rules:/);
  assert.match(prompt, /npm test/);
});

test("launchSelfImproveFleet waits for dedicated chat before spawning", async () => {
  createIdeChat.mock.resetCalls();
  waitForChatSession.mock.resetCalls();
  spawnLongSession.mock.resetCalls();
  getSessionIndexForId.mock.resetCalls();

  const manifest = await launchSelfImproveFleet({
    cwd: "/tmp/project",
    metaDir: "/tmp/self-improve-test",
    workerSessionIndexes: [2],
    withOrchestrator: false,
    withWatcher: false,
    withStrategyReviewer: false,
    stopExisting: false,
  });

  assert.equal(createIdeChat.mock.callCount(), 1);
  assert.ok(waitForChatSession.mock.callCount() >= 1);
  assert.ok(manifest.experiments.length >= 1);
  assert.equal(manifest.dedicatedWorker.sessionId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  assert.equal(manifest.dedicatedWorker.sessionIndex, 9);
});

test("launchSelfImproveFleet requires cwd", async () => {
  await assert.rejects(() => launchSelfImproveFleet({ cwd: "  " }), /cwd is required/);
});
