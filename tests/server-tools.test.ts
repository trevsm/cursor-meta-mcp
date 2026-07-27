import assert from "node:assert/strict";
import { test } from "node:test";

import { callMetaTool, withMcpClient } from "./helpers/mcp-client.js";
import { FakeLocalAgentService } from "./helpers/fake-service.js";

function textResult(result: Awaited<ReturnType<typeof callMetaTool>>): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.text;
}

test("registers all meta_* tools", async () => {
  const service = new FakeLocalAgentService();
  await withMcpClient(service, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "meta_abort_chat",
      "meta_agi",
      "meta_agi_adapt",
      "meta_cancel_run",
      "meta_consciousness_pulse",
      "meta_continue_from_chat",
      "meta_create_chat",
      "meta_export_chat",
      "meta_follow_up",
      "meta_get_chat_activity",
      "meta_get_run",
      "meta_intercept_agent",
      "meta_intercept_chat",
      "meta_list_active_chats",
      "meta_list_active_runs",
      "meta_list_agent_runs",
      "meta_list_approvals",
      "meta_list_chats",
      "meta_list_local_agents",
      "meta_long_session",
      "meta_mission",
      "meta_orchestrate_loop",
      "meta_orchestrate_pulse",
      "meta_plan_budget",
      "meta_relentless_loop",
      "meta_request_approval",
      "meta_resolve_approval",
      "meta_search_chats",
      "meta_self_improve",
      "meta_send_to_chat",
      "meta_sentiment_analysis",
      "meta_show_chat",
      "meta_spawn_local_agent",
      "meta_strategy_review",
      "meta_watch_chat",
      "meta_whoami",
      "meta_world_record",
      "meta_world_status",
    ]);
  });
});

test("meta_list_chats returns paginated sessions", async (t) => {
  const result = await callMetaTool(new FakeLocalAgentService(), "meta_list_chats", { limit: 2 });
  if (result.isError) {
    t.skip("Cursor history unavailable");
    return;
  }

  const payload = JSON.parse(textResult(result));
  assert.ok(Array.isArray(payload.sessions));
  assert.equal(payload.pagination.limit, 2);
});

test("meta_show_chat validates input and loads a session", async (t) => {
  const service = new FakeLocalAgentService();

  const missing = await callMetaTool(service, "meta_show_chat", {});
  assert.equal(missing.isError, true);
  assert.match(textResult(missing), /Provide sessionIndex or sessionId/);

  const listed = await callMetaTool(service, "meta_list_chats", { limit: 1 });
  if (listed.isError) {
    t.skip("Cursor history unavailable");
    return;
  }
  const { sessions } = JSON.parse(textResult(listed));
  if (sessions.length === 0) {
    t.skip("no sessions available");
    return;
  }

  const shown = await callMetaTool(service, "meta_show_chat", {
    sessionIndex: sessions[0].sessionIndex,
  });
  assert.notEqual(shown.isError, true);
  const session = JSON.parse(textResult(shown));
  assert.equal(session.id, sessions[0].id);
});

test("meta_search_chats returns ranked hits", async (t) => {
  const result = await callMetaTool(new FakeLocalAgentService(), "meta_search_chats", {
    query: "MCP",
    limit: 2,
  });
  if (result.isError) {
    t.skip("Cursor search unavailable");
    return;
  }

  const hits = JSON.parse(textResult(result));
  assert.ok(Array.isArray(hits));
});

test("meta_export_chat exports markdown and json", async (t) => {
  const service = new FakeLocalAgentService();
  const listed = await callMetaTool(service, "meta_list_chats", { limit: 1 });
  if (listed.isError) {
    t.skip("Cursor history unavailable");
    return;
  }
  const { sessions } = JSON.parse(textResult(listed));
  if (sessions.length === 0) {
    t.skip("no sessions available");
    return;
  }

  const markdown = await callMetaTool(service, "meta_export_chat", {
    sessionIndex: sessions[0].sessionIndex,
    format: "markdown",
  });
  assert.notEqual(markdown.isError, true);
  assert.match(textResult(markdown), /"format": "markdown"/);

  const json = await callMetaTool(service, "meta_export_chat", {
    sessionIndex: sessions[0].sessionIndex,
    format: "json",
  });
  assert.notEqual(json.isError, true);
  assert.match(textResult(json), /"format": "json"/);
});

test("meta_spawn_local_agent runs through the injected service", async () => {
  const service = new FakeLocalAgentService();
  const result = await callMetaTool(service, "meta_spawn_local_agent", {
    cwd: process.cwd(),
    prompt: "do work",
    mode: "ask",
  });

  assert.notEqual(result.isError, true);
  assert.match(textResult(result), /agent-test-1 finished/);
  assert.equal(service.lastRunParams?.prompt, "do work");
});

test("meta_continue_from_chat composes prior chat context", async (t) => {
  const service = new FakeLocalAgentService();
  const listed = await callMetaTool(service, "meta_list_chats", { limit: 1 });
  if (listed.isError) {
    t.skip("Cursor history unavailable");
    return;
  }
  const { sessions } = JSON.parse(textResult(listed));
  if (sessions.length === 0) {
    t.skip("no sessions available");
    return;
  }

  const missing = await callMetaTool(service, "meta_continue_from_chat", {
    cwd: process.cwd(),
    prompt: "continue please",
  });
  assert.equal(missing.isError, true);

  const result = await callMetaTool(service, "meta_continue_from_chat", {
    sessionIndex: sessions[0].sessionIndex,
    cwd: process.cwd(),
    prompt: "continue please",
    maxContextMessages: 2,
  });
  assert.notEqual(result.isError, true);
  assert.match(service.lastRunParams?.prompt ?? "", /Prior Cursor chat/);
  assert.match(service.lastRunParams?.prompt ?? "", /continue please/);
});

test("meta_follow_up delegates to the service", async () => {
  const service = new FakeLocalAgentService();
  const result = await callMetaTool(service, "meta_follow_up", {
    agentId: "agent-test-1",
    prompt: "next step",
    cwd: process.cwd(),
  });

  assert.notEqual(result.isError, true);
  assert.equal(service.lastFollowUpParams?.agentId, "agent-test-1");
  assert.match(textResult(result), /followed up/);
});

test("meta_list_local_agents returns persisted agents", async () => {
  const service = new FakeLocalAgentService();
  const result = await callMetaTool(service, "meta_list_local_agents", { limit: 5 });
  assert.notEqual(result.isError, true);
  assert.match(textResult(result), /agent-test-1/);
});

test("meta_get_run and meta_cancel_run use the service", async () => {
  const service = new FakeLocalAgentService();

  const run = await callMetaTool(service, "meta_get_run", { runId: "run-test-1" });
  assert.notEqual(run.isError, true);
  assert.match(textResult(run), /run-test-1/);

  const cancelled = await callMetaTool(service, "meta_cancel_run", { runId: "run-test-1" });
  assert.notEqual(cancelled.isError, true);
  assert.match(textResult(cancelled), /"cancelled": true/);
});

test("meta_whoami returns auth details", async () => {
  const service = new FakeLocalAgentService();
  const result = await callMetaTool(service, "meta_whoami", {});
  assert.notEqual(result.isError, true);
  assert.match(textResult(result), /test-key/);
});

test("tool handlers surface service failures", async () => {
  const service = new FakeLocalAgentService();
  service.whoamiError = new Error("auth failed");
  service.runError = new Error("spawn failed");
  service.getRunError = new Error("missing run");

  const whoami = await callMetaTool(service, "meta_whoami", {});
  assert.equal(whoami.isError, true);
  assert.match(textResult(whoami), /auth failed/);

  const spawn = await callMetaTool(service, "meta_spawn_local_agent", {
    cwd: process.cwd(),
    prompt: "fail",
  });
  assert.equal(spawn.isError, true);
  assert.match(textResult(spawn), /spawn failed/);

  const run = await callMetaTool(service, "meta_get_run", { runId: "missing" });
  assert.equal(run.isError, true);
  assert.match(textResult(run), /missing run/);
});

test("meta_intercept_agent cancels then follows up", async () => {
  const service = new FakeLocalAgentService();
  const result = await callMetaTool(service, "meta_intercept_agent", {
    agentId: "agent-test-1",
    prompt: "steer instead",
    cwd: process.cwd(),
    cancelFirst: true,
  });

  assert.notEqual(result.isError, true);
  assert.equal(service.lastInterceptParams?.agentId, "agent-test-1");
  assert.equal(service.lastInterceptParams?.cancelFirst, true);
});

test("meta_list_active_runs and meta_list_agent_runs delegate to service", async () => {
  const service = new FakeLocalAgentService();

  const active = await callMetaTool(service, "meta_list_active_runs", { cwd: process.cwd() });
  assert.notEqual(active.isError, true);
  assert.match(textResult(active), /run-test-1/);

  const runs = await callMetaTool(service, "meta_list_agent_runs", {
    agentId: "agent-test-1",
    cwd: process.cwd(),
  });
  assert.notEqual(runs.isError, true);
  assert.match(textResult(runs), /run-test-1/);
});

test("meta_get_chat_activity validates session selector", async () => {
  const missing = await callMetaTool(new FakeLocalAgentService(), "meta_get_chat_activity", {});
  assert.equal(missing.isError, true);
  assert.match(textResult(missing), /Provide sessionIndex or sessionId/);
});

test("meta_watch_chat validates session selector", async () => {
  const missing = await callMetaTool(new FakeLocalAgentService(), "meta_watch_chat", {});
  assert.equal(missing.isError, true);
  assert.match(textResult(missing), /Provide sessionIndex or sessionId/);
});

test("meta_long_session schema exposes resilience knobs", async () => {
  const service = new FakeLocalAgentService();
  await withMcpClient(service, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "meta_long_session");
    assert.ok(tool);
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("continueOnBusy" in props);
    assert.ok("continueOnTimeout" in props);
    assert.ok("maxConsecutiveErrors" in props);
    assert.ok("readCheckpoint" in props);
  });
});

test("meta_long_session requires session target when spawning", async () => {
  const missing = await callMetaTool(new FakeLocalAgentService(), "meta_long_session", {
    cwd: process.cwd(),
    spawn: true,
  });
  assert.equal(missing.isError, true);
  assert.match(textResult(missing), /sessionIndex or sessionId/);
});

test("meta_agi schema requires cwd and task", async () => {
  const service = new FakeLocalAgentService();
  await withMcpClient(service, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "meta_agi");
    assert.ok(tool);
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("cwd" in props);
    assert.ok("task" in props);
    assert.ok("excludeSessionIndex" in props);
    assert.ok("withOrchestrator" in props);
  });
});

test("meta_self_improve schema includes fleet options", async () => {
  const service = new FakeLocalAgentService();
  await withMcpClient(service, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "meta_self_improve");
    assert.ok(tool);
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("cwd" in props);
    assert.ok("excludeSessionIndex" in props);
    assert.ok("workerSessionIndexes" in props);
    assert.ok("withOrchestrator" in props);
    assert.ok("withWatcher" in props);
    assert.ok("metaDir" in props);
  });
});

test("meta_list_active_chats reads local activity when available", async (t) => {
  const result = await callMetaTool(new FakeLocalAgentService(), "meta_list_active_chats", {
    limit: 3,
  });
  if (result.isError) {
    t.skip("Cursor history unavailable");
    return;
  }
  const payload = JSON.parse(textResult(result));
  assert.ok(Array.isArray(payload.sessions));
});

test("formatRun marks errored agent runs as tool errors", async () => {
  const service = new FakeLocalAgentService();
  service.runResult = {
    agentId: "agent-test-1",
    runId: "run-test-1",
    status: "error",
    result: "",
  };

  const result = await callMetaTool(service, "meta_spawn_local_agent", {
    cwd: process.cwd(),
    prompt: "fail softly",
  });
  assert.equal(result.isError, true);
  assert.match(textResult(result), /status "error"/);
});
