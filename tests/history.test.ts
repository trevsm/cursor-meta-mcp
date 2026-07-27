import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exportChat,
  historyErrorMessage,
  listChats,
  loadSessionSummary,
  loadSessionSummaryById,
  searchChats,
  showChat,
} from "../src/history.js";

test("history tools read local Cursor database", async (t) => {
  const page = await listChats({ limit: 3, offset: 0 });
  if (page.pagination.total === 0) {
    t.skip("no local Cursor chat sessions found on this machine");
    return;
  }

  assert.ok(page.sessions.length > 0);
  assert.ok(page.defaultDataPath.length > 0);
  assert.equal(typeof page.pagination.hasMore, "boolean");

  const first = page.sessions[0];
  const full = await showChat({ sessionIndex: first.sessionIndex });
  assert.equal(full.id, first.id);

  const byId = await showChat({ sessionId: first.id });
  assert.equal(byId.id, first.id);

  const results = await searchChats({ query: "MCP", limit: 3 });
  assert.ok(Array.isArray(results));
  if (results.length > 0) {
    assert.ok(results[0].sessionIndex != null);
  }

  const markdown = await exportChat({ sessionIndex: first.sessionIndex, format: "markdown" });
  assert.equal(markdown.format, "markdown");
  assert.ok(markdown.content.length > 0);

  const json = await exportChat({ sessionIndex: first.sessionIndex, format: "json" });
  assert.equal(json.format, "json");
  assert.ok(json.content.includes(first.id));

  const summary = await loadSessionSummary(first.sessionIndex, 2);
  assert.ok(summary.includes(first.title));

  const summaryById = await loadSessionSummaryById(first.id, 2);
  assert.ok(summaryById.includes(first.title));
});

test("showChat requires session selector", async () => {
  await assert.rejects(() => showChat({}), /Provide sessionIndex or sessionId/);
});

test("historyErrorMessage delegates to describeError", () => {
  assert.equal(historyErrorMessage(new Error("nope")), "nope");
});
