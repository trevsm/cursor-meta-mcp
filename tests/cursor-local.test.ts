import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const budgetDir = mkdtempSync(join(tmpdir(), "cursor-local-budget-"));
process.env.CURSOR_META_BUDGET_PATH = join(budgetDir, "budget.json");

const agentCreate = mock.fn();
const agentResume = mock.fn();
const agentList = mock.fn();
const agentGet = mock.fn();
const agentListRuns = mock.fn();
const agentGetRun = mock.fn();
const cursorMe = mock.fn();
const cursorModelsList = mock.fn();
const isAgentCliLoggedIn = mock.fn<() => Promise<boolean>>();
const runAgentCliPrompt = mock.fn();
const agentCliWhoami = mock.fn();
const shouldUseAgentCliFallback = mock.fn<(apiKey?: string) => boolean>();

mock.module("@cursor/sdk", {
  namedExports: {
    Agent: {
      create: agentCreate,
      resume: agentResume,
      list: agentList,
      get: agentGet,
      listRuns: agentListRuns,
      getRun: agentGetRun,
    },
    Cursor: {
      me: cursorMe,
      models: { list: cursorModelsList },
    },
  },
});

mock.module("../src/agent-cli.js", {
  namedExports: {
    isAgentCliLoggedIn,
    runAgentCliPrompt,
    agentCliWhoami,
    shouldUseAgentCliFallback,
  },
});

const { CursorLocalService, summarizeSdkMessage } = await import("../src/cursor-local.js");

function makeRun(result: {
  id?: string;
  status?: string;
  result?: string;
  durationMs?: number;
  requestId?: string;
  model?: { id: string };
}) {
  const streamMessages = [
    { type: "system", model: { id: "composer-2.5" } },
    { type: "tool_call", name: "grep", status: "completed" },
    { type: "thinking" },
    { type: "status", status: "running", message: "Working" },
    { type: "task", text: "Review files" },
    { type: "assistant", message: { content: [{ type: "text", text: "Done now." }] } },
    { type: "unknown-type" },
  ];

  return {
    id: result.id ?? "run-1",
    supports: (feature: string) => feature === "stream",
    stream: async function* () {
      for (const message of streamMessages) yield message;
    },
    wait: mock.fn(async () => ({
      status: result.status ?? "finished",
      result: result.result ?? "all good",
      durationMs: result.durationMs ?? 12,
      requestId: result.requestId ?? "req-1",
      model: result.model ?? { id: "composer-2.5" },
    })),
    cancel: mock.fn(async () => {}),
  };
}

test("summarizeSdkMessage covers SDK event shapes", () => {
  assert.deepEqual(summarizeSdkMessage({ type: "system", model: { id: "composer-2.5" } }), {
    type: "system",
    message: "Agent initialized (model composer-2.5).",
  });
  assert.deepEqual(summarizeSdkMessage({ type: "tool_call", name: "read", status: "started" }), {
    type: "tool_call",
    message: "tool read: started",
  });
  assert.deepEqual(summarizeSdkMessage({ type: "thinking" }), {
    type: "thinking",
    message: "thinking…",
  });
  assert.deepEqual(summarizeSdkMessage({ type: "thinking", text: "Need to inspect dashboard.ts first." }), {
    type: "thinking",
    message: "Need to inspect dashboard.ts first.",
  });
  assert.deepEqual(summarizeSdkMessage({ type: "status", status: "running", message: "Working" }), {
    type: "status",
    message: "status running: Working",
  });
  assert.deepEqual(summarizeSdkMessage({ type: "task", text: "Review files" }), {
    type: "task",
    message: "task: Review files",
  });
  assert.deepEqual(summarizeSdkMessage({ type: "task", status: "done" }), {
    type: "task",
    message: "task: done",
  });
  assert.equal(summarizeSdkMessage({ type: "unknown-type" }), undefined);
});

test("CursorLocalService uses SDK auth when api key is configured", async () => {
  isAgentCliLoggedIn.mock.mockImplementation(async () => false);
  shouldUseAgentCliFallback.mock.mockImplementation((apiKey?: string) => !apiKey);
  cursorMe.mock.mockImplementation(async () => ({
    apiKeyName: "prod-key",
    userId: 1,
    userEmail: "sdk@example.com",
  }));
  cursorModelsList.mock.mockImplementation(async () => [
    { id: "composer-2.5", displayName: "Composer 2.5", description: "default" },
  ]);

  const send = mock.fn(async () => makeRun({ id: "run-sdk-1", result: "sdk ok" }));
  const close = mock.fn();
  agentCreate.mock.mockImplementation(async () => ({
    agentId: "agent-sdk-1",
    send,
    close,
  }));
  agentResume.mock.mockImplementation(async () => ({
    agentId: "agent-sdk-1",
    send,
    close,
  }));
  agentList.mock.mockImplementation(async () => ({ items: [{ agentId: "agent-sdk-1" }] }));
  agentGet.mock.mockImplementation(async () => ({ agentId: "agent-sdk-1" }));
  agentListRuns.mock.mockImplementation(async () => ({
    items: [{ id: "run-sdk-1", agentId: "agent-sdk-1", status: "finished", result: "ok" }],
  }));
  agentGetRun.mock.mockImplementation(async () => ({
    id: "run-sdk-1",
    agentId: "agent-sdk-1",
    status: "finished",
    result: "sdk ok",
    requestId: "req-1",
    model: { id: "composer-2.5" },
    durationMs: 12,
    createdAt: "2026-01-01T00:00:00.000Z",
    cancel: mock.fn(async () => {}),
  }));

  const service = new CursorLocalService({ apiKey: "cursor_test_key", defaultModel: "composer-2.5" });

  assert.deepEqual(await service.whoami(), {
    apiKeyName: "prod-key",
    userId: 1,
    userEmail: "sdk@example.com",
  });
  assert.equal((await service.listModels())[0]?.id, "composer-2.5");

  const progress: string[] = [];
  const controller = new AbortController();
  const run = await service.runLocalAgent(
    {
      prompt: "ship it",
      cwd: process.cwd(),
      mode: "ask",
      name: "test-agent",
      agents: {
        helper: {
          description: "helper",
          prompt: "help",
          model: "inherit",
        },
      },
    },
    {
      signal: controller.signal,
      onProgress: (event) => progress.push(event.message),
    },
  );
  assert.equal(run.agentId, "agent-sdk-1");
  assert.equal(run.result, "sdk ok");
  assert.ok(progress.some((message) => message.includes("Agent initialized")));
  assert.ok(progress.some((message) => message.includes("Done now.")));

  const followUp = await service.followUp({
    agentId: "agent-sdk-1",
    prompt: "again",
    cwd: process.cwd(),
    model: "composer-2.5",
  });
  assert.equal(followUp.result, "sdk ok");

  assert.deepEqual(await service.listLocalAgents({ cwd: process.cwd(), limit: 5 }), {
    items: [{ agentId: "agent-sdk-1" }],
  });
  assert.deepEqual(await service.getAgent({ agentId: "agent-sdk-1", cwd: process.cwd() }), {
    agentId: "agent-sdk-1",
  });
  assert.equal((await service.listRuns({ agentId: "agent-sdk-1", cwd: process.cwd() })).items[0]?.id, "run-sdk-1");
  assert.equal((await service.getRun({ agentId: "agent-sdk-1", runId: "run-sdk-1", cwd: process.cwd() })).result, "sdk ok");

  await service.cancelRun({ agentId: "agent-sdk-1", runId: "run-sdk-1", cwd: process.cwd() });
  assert.equal(agentGetRun.mock.callCount(), 2);
});

test("CursorLocalService rejects cloud agent ids", async () => {
  const service = new CursorLocalService({ apiKey: "cursor_test_key" });
  await assert.rejects(
    () => service.followUp({ agentId: "bc-cloud", prompt: "nope" }),
    /Cloud agents are not supported/,
  );
  await assert.rejects(
    () => service.getAgent({ agentId: "bc-cloud" }),
    /Cloud agents are not supported/,
  );
  await assert.rejects(
    () => service.listRuns({ agentId: "bc-cloud" }),
    /Cloud agents are not supported/,
  );
});

test("CursorLocalService uses CLI fallback when no api key is configured", async () => {
  shouldUseAgentCliFallback.mock.mockImplementation((apiKey?: string) => !apiKey);
  isAgentCliLoggedIn.mock.mockImplementation(async () => true);
  agentCliWhoami.mock.mockImplementation(async () => ({
    apiKeyName: "cursor-agent-cli",
    userEmail: "cli@example.com",
  }));
  runAgentCliPrompt.mock.mockImplementation(async () => ({
    status: "finished",
    result: "cli ok",
  }));

  const service = new CursorLocalService();
  assert.deepEqual(await service.whoami(), {
    apiKeyName: "cursor-agent-cli",
    userEmail: "cli@example.com",
  });

  const run = await service.runLocalAgent({
    prompt: "hello",
    cwd: [process.cwd(), "/tmp/other"],
    mode: "plan",
  });
  assert.equal(run.agentId, "cli-session");
  assert.match(run.runId, /^cli-/);
  assert.equal(run.result, "cli ok");

  const followUp = await service.followUp({
    agentId: "cli-session",
    prompt: "again",
    cwd: process.cwd(),
  });
  assert.equal(followUp.result, "cli ok");
});

test("CursorLocalService reports missing auth clearly", async () => {
  shouldUseAgentCliFallback.mock.mockImplementation((apiKey?: string) => !apiKey);
  isAgentCliLoggedIn.mock.mockImplementation(async () => false);

  const service = new CursorLocalService();
  await assert.rejects(() => service.runLocalAgent({ prompt: "x", cwd: process.cwd() }), /No auth available/);
  await assert.rejects(() => service.listModels(), /CURSOR_API_KEY is not set/);
  await assert.rejects(
    () => service.followUp({ agentId: "cli-session", prompt: "x" }),
    /CLI follow-up requires/,
  );

  isAgentCliLoggedIn.mock.mockImplementation(async () => true);
  await assert.rejects(
    () => service.followUp({ agentId: "cli-session", prompt: "x" }),
    /cwd is required for CLI follow-up/,
  );
});

test("CursorLocalService aborts in-flight SDK runs", async () => {
  const run = makeRun({ id: "run-abort" });
  agentCreate.mock.mockImplementation(async () => ({
    agentId: "agent-sdk-1",
    send: mock.fn(async () => run),
    close: mock.fn(),
  }));

  const service = new CursorLocalService({ apiKey: "cursor_test_key" });
  const controller = new AbortController();
  controller.abort();

  await service.runLocalAgent(
    { prompt: "abort me", cwd: process.cwd() },
    { signal: controller.signal },
  );
  assert.equal(run.cancel.mock.callCount(), 1);
});

test("CursorLocalService ignores stream failures while waiting for completion", async () => {
  const run = {
    id: "run-stream-fail",
    supports: () => true,
    stream: async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "Partial" }] } };
      throw new Error("stream failed");
    },
    wait: mock.fn(async () => ({
      status: "finished",
      result: "still finished",
    })),
    cancel: mock.fn(async () => {}),
  };

  agentCreate.mock.mockImplementation(async () => ({
    agentId: "agent-sdk-1",
    send: mock.fn(async () => run),
    [Symbol.asyncDispose]: mock.fn(async () => {}),
  }));

  const service = new CursorLocalService({ apiKey: "cursor_test_key" });
  const progress: string[] = [];
  const result = await service.runLocalAgent(
    { prompt: "stream", cwd: process.cwd() },
    { onProgress: (event) => progress.push(event.message) },
  );

  assert.equal(result.result, "still finished");
  assert.ok(progress.length > 0);
});

test("CursorLocalService interceptAgent cancels active runs before follow-up", async () => {
  const runningRun = {
    id: "run-active",
    agentId: "agent-sdk-1",
    status: "running",
    cancel: mock.fn(async () => {}),
  };
  const send = mock.fn(async () => makeRun({ id: "run-followup", result: "steered" }));

  agentList.mock.mockImplementation(async () => ({ items: [{ agentId: "agent-sdk-1", cwd: process.cwd() }] }));
  agentListRuns.mock.mockImplementation(async () => ({
    items: [runningRun, { id: "run-old", agentId: "agent-sdk-1", status: "finished" }],
  }));
  agentGetRun.mock.mockImplementation(async () => runningRun);
  agentResume.mock.mockImplementation(async () => ({
    agentId: "agent-sdk-1",
    send,
    [Symbol.asyncDispose]: mock.fn(async () => {}),
  }));

  const service = new CursorLocalService({ apiKey: "cursor_test_key" });
  const result = await service.interceptAgent({
    agentId: "agent-sdk-1",
    prompt: "steer instead",
    cwd: process.cwd(),
    cancelFirst: true,
  });

  assert.equal(result.result, "steered");
  assert.equal(runningRun.cancel.mock.callCount(), 1);
});

test("CursorLocalService listActiveRuns returns running SDK runs", async () => {
  agentList.mock.mockImplementation(async () => ({ items: [{ agentId: "agent-sdk-1", cwd: process.cwd() }] }));
  agentListRuns.mock.mockImplementation(async () => ({
    items: [
      { id: "run-active", agentId: "agent-sdk-1", status: "running", createdAt: 1 },
      { id: "run-done", agentId: "agent-sdk-1", status: "finished", createdAt: 2 },
    ],
  }));

  const service = new CursorLocalService({ apiKey: "cursor_test_key" });
  const active = await service.listActiveRuns({ cwd: process.cwd() });
  assert.deepEqual(active.items, [
    {
      agentId: "agent-sdk-1",
      runId: "run-active",
      status: "running",
      cwd: process.cwd(),
      createdAt: 1,
    },
  ]);
});
