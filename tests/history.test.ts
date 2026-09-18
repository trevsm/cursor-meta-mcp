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
  assert.ok(Array.isArray(results.hits));
  if (results.hits.length > 0) {
    assert.ok(results.hits[0].sessionIndex != null);
    assert.equal(typeof results.hits[0].hasFixOrigin, "boolean");
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

test("workspace-filtered sessionIndex still resolves to the same chat", async (t) => {
  const unfiltered = await listChats({ limit: 20, offset: 0 });
  const withWorkspace = unfiltered.sessions.find((s) => s.workspace.startsWith("/"));
  if (!withWorkspace) {
    t.skip("no workspace-backed chats available");
    return;
  }

  const filtered = await listChats({ limit: 5, offset: 0, workspace: withWorkspace.workspace });
  assert.ok(filtered.sessions.length > 0);

  for (const session of filtered.sessions) {
    const resolved = await showChat({ sessionIndex: session.sessionIndex, maxMessages: 1 });
    assert.equal(resolved.id, session.id);
  }
});

test("listChats reports a real total when offset is omitted", async () => {
  const withOffset = await listChats({ limit: 3, offset: 0 });
  const withoutOffset = await listChats({ limit: 3 });
  assert.equal(withoutOffset.pagination.total, withOffset.pagination.total);
  assert.ok((withoutOffset.pagination.total ?? 0) >= withoutOffset.sessions.length);
});

test("listChats hides empty chats by default", async () => {
  const page = await listChats({ limit: 10 });
  for (const session of page.sessions) {
    assert.ok(session.bubbleCount > 0);
  }
});

test("showChat honours maxMessages and flags truncation", async (t) => {
  const page = await listChats({ limit: 20 });
  const longest = page.sessions.sort((a, b) => b.bubbleCount - a.bubbleCount)[0];
  if (!longest || longest.bubbleCount < 20) {
    t.skip("no sufficiently long chat available");
    return;
  }

  const small = await showChat({ sessionId: longest.id, maxMessages: 2 });
  assert.equal(small.messages.length, 2);
  assert.equal(small.truncated, true);
  assert.equal(small.window, "latest");

  const opening = await showChat({ sessionId: longest.id, maxMessages: 2, fromStart: true });
  assert.equal(opening.window, "earliest");
  assert.notDeepEqual(opening.messages, small.messages);
});

test("historyErrorMessage delegates to describeError", () => {
  assert.equal(historyErrorMessage(new Error("nope")), "nope");
});
