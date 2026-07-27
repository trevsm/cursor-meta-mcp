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
    selfImproveGitRules: mock.fn(
      () => "Each tick: one high-value improvement → verify → git commit → push when ahead of origin.",
    ),
  },
});
const spawnSdkWorker = mock.fn((params: { checkpointPath?: string }) => ({
  pid: 2001,
  checkpointPath: params.checkpointPath ?? "/tmp/sdk-worker.json",
  logPath: "/tmp/sdk-worker.log",
  command: ["node", "scripts/sdk-worker.mjs"],
}));
const createWorkerWorktree = mock.fn(() => ({
  path: "/tmp/worktree-1",
  branch: "fleet/sdk-worker-1-1",
  head: "abc123",
}));

mock.module("../src/sdk-worker.js", {
  namedExports: {
    spawnSdkWorker,
    resolveTickIntervalMs: () => 60_000,
  },
});
mock.module("../src/git-worktree.js", {
  namedExports: { createWorkerWorktree },
});
const probeWorkerAuth = mock.fn(async () => ({ apiKey: true, cli: true, sdk: true }));
mock.module("../src/worker-auth.js", {
  namedExports: {
    probeWorkerAuth,
    resolveHonestWorkerMode: async (mode?: string) => (mode === "ide" ? "ide" : "sdk"),
    workerAuthHint: () => "mock auth ok",
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

const { buildSelfImprovePrompt, fleetSpawnPlan, fleetSupervisorArgs, launchSelfImproveFleet } =
  await import("../src/self-improve.js");

after(() => mock.restoreAll());

test("buildSelfImprovePrompt includes base rules", () => {
  const prompt = buildSelfImprovePrompt("/Users/me/Projects/cursor-meta-mcp", "Custom base");
  assert.match(prompt, /Custom base/);
  assert.match(prompt, /no user questions/);
  assert.match(prompt, /Tick report/);
  assert.match(prompt, /git commit → push/);
  assert.match(prompt, /Git state:/);
});

test("buildSelfImprovePrompt uses SELF_IMPROVE_BASE_PROMPT when base omitted", () => {
  const prompt = buildSelfImprovePrompt("/Users/me/Projects/cursor-meta-mcp");
  assert.match(prompt, /Self-improve this codebase autonomously/);
  assert.match(prompt, /Rules:/);
  assert.match(prompt, /Tick report/);
});

test("launchSelfImproveFleet spawns one sdk worker by default", async () => {
  spawnSdkWorker.mock.resetCalls();
  createWorkerWorktree.mock.resetCalls();
  probeWorkerAuth.mock.mockImplementation(async () => ({ apiKey: true, cli: true, sdk: true }));

  const manifest = await launchSelfImproveFleet({
    cwd: "/tmp/project",
    metaDir: "/tmp/self-improve-sdk-test",
    withOrchestrator: false,
    withWatcher: false,
    withStrategyReviewer: false,
    stopExisting: false,
  });

  assert.equal(spawnSdkWorker.mock.callCount(), 1);
  assert.ok(manifest.experiments.some((exp) => exp.name.startsWith("sdk-worker")));
});

test("launchSelfImproveFleet rejects SDK mode without CURSOR_API_KEY", async () => {
  probeWorkerAuth.mock.mockImplementation(async () => ({ apiKey: false, cli: true, sdk: true }));
  await assert.rejects(
    () =>
      launchSelfImproveFleet({
        cwd: "/tmp/project",
        metaDir: "/tmp/self-improve-no-key",
        withOrchestrator: false,
        withWatcher: false,
        withStrategyReviewer: false,
        stopExisting: false,
        workerMode: "sdk",
      }),
    /CURSOR_API_KEY/,
  );
  probeWorkerAuth.mock.mockImplementation(async () => ({ apiKey: true, cli: true, sdk: true }));
});

test("fleetSpawnPlan does not spawn sdk when mode is ide", () => {
  const plan = fleetSpawnPlan("ide", 1);
  assert.equal(plan.spawnIde, true);
  assert.equal(plan.spawnSdk, false);
});

test("fleetSpawnPlan spawns sdk only for sdk/hybrid modes", () => {
  assert.equal(fleetSpawnPlan("sdk", 1).spawnSdk, true);
  assert.equal(fleetSpawnPlan("sdk", 0).spawnSdk, false);
  assert.equal(fleetSpawnPlan("hybrid", 2).spawnSdk, true);
});

test("fleetSpawnPlan hybrid with zero parallel workers keeps ide only", () => {
  const plan = fleetSpawnPlan("hybrid", 0);
  assert.equal(plan.spawnIde, true);
  assert.equal(plan.spawnSdk, false);
});

test("launchSelfImproveFleet waits for dedicated chat when workerMode ide", async () => {
  createIdeChat.mock.resetCalls();
  waitForChatSession.mock.resetCalls();
  spawnLongSession.mock.resetCalls();
  getSessionIndexForId.mock.resetCalls();

  const manifest = await launchSelfImproveFleet({
    cwd: "/tmp/project",
    metaDir: "/tmp/self-improve-test",
    workerMode: "ide",
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

test("every supervisor loop receives the project meta dir", () => {
  const metaDir = "/home/me/.cursor-meta/projects/acme-api-abc123/experiments";
  const args = fleetSupervisorArgs({
    cwd: "/home/me/Projects/acme-api",
    metaDir,
    excludeSessionIndex: 1,
    strategyIntervalMs: 300_000,
    goal: "Ship checkout",
    useLlm: false,
  });

  for (const argv of [args.strategyReview, args.orchestrator, args.watcher]) {
    const index = argv.indexOf("--meta-dir");
    assert.notEqual(index, -1);
    assert.equal(argv[index + 1], metaDir);
  }
});

test("supervisor args carry project root and workspace, not the package root", () => {
  const args = fleetSupervisorArgs({
    cwd: "/home/me/Projects/acme-api",
    metaDir: "/tmp/experiments",
    excludeSessionIndex: 1,
    strategyIntervalMs: 300_000,
    goal: "Ship checkout",
    useLlm: true,
  });

  assert.equal(args.watcher[args.watcher.indexOf("--root") + 1], "/home/me/Projects/acme-api");
  assert.equal(args.watcher[args.watcher.indexOf("--workspace") + 1], "acme-api");
  assert.equal(args.orchestrator[args.orchestrator.indexOf("--workspace") + 1], "acme-api");
  assert.equal(args.strategyReview[args.strategyReview.indexOf("--cwd") + 1], "/home/me/Projects/acme-api");
  assert.ok(args.strategyReview.includes("--use-llm"));
});
