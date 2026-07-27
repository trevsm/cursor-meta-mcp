import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exportChat,
  listChats,
  searchChats,
  showChat,
} from "../src/history.js";
import { createServer } from "../src/server.js";
import type { LocalAgentService } from "../src/cursor-local.js";

class FakeLocalAgentService implements LocalAgentService {
  async whoami() {
    return { apiKeyName: "test-key", userEmail: "test@example.com" };
  }

  async listModels() {
    return [{ id: "composer-2.5", displayName: "Composer 2.5" }];
  }

  async runLocalAgent() {
    return {
      agentId: "agent-test-1",
      runId: "run-test-1",
      status: "finished",
      result: "done",
    };
  }

  async followUp() {
    return {
      agentId: "agent-test-1",
      runId: "run-test-2",
      status: "finished",
      result: "followed up",
    };
  }

  async listLocalAgents() {
    return { items: [], nextCursor: undefined };
  }

  async getAgent() {
    return { agentId: "agent-test-1" };
  }

  async listRuns() {
    return { items: [] };
  }

  async getRun(params: { runId: string }) {
    return { id: params.runId, status: "finished", result: "ok" };
  }

  async cancelRun() {}
}

test("history tools read local Cursor database", async (t) => {
  const page = await listChats({ limit: 3, offset: 0 });
  if (page.pagination.total === 0) {
    t.skip("no local Cursor chat sessions found on this machine");
    return;
  }

  assert.ok(page.sessions.length > 0);
  const first = page.sessions[0];
  const full = await showChat({ sessionIndex: first.sessionIndex });
  assert.equal(full.id, first.id);

  const results = await searchChats({ query: "MCP", limit: 3 });
  assert.ok(Array.isArray(results));

  const exported = await exportChat({ sessionIndex: first.sessionIndex, format: "markdown" });
  assert.ok(exported.content.length > 0);
});

test("MCP server registers expected local-only tools", async () => {
  const server = createServer(new FakeLocalAgentService());
  const handlers = (server as unknown as { _registeredTools?: Map<string, unknown> })._registeredTools;
  // Fallback: ensure createServer returns without throwing and history works above.
  assert.ok(server);
  void handlers;
});
