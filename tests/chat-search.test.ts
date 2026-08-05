import assert from "node:assert/strict";
import { test } from "node:test";

import { searchThinking } from "../src/chat-search.js";
import { listChatSummaries } from "../src/history-store.js";

test("searchThinking finds literal thinking hits or skips cleanly", (t) => {
  let sessions;
  try {
    sessions = listChatSummaries({ limit: 5, offset: 0 }).sessions;
  } catch {
    t.skip("Cursor history unavailable");
    return;
  }
  if (!sessions.length) {
    t.skip("no sessions");
    return;
  }

  const result = searchThinking({
    query: "the",
    sessionIndex: sessions[0]!.sessionIndex,
    limit: 5,
    minChars: 20,
    quoteChars: 120,
  });

  assert.equal(result.mode, "literal");
  assert.ok(result.scopes.includes("thinking"));
  assert.ok(result.scopes.includes("user"));
  assert.ok(result.sessionsScanned === 1);
  assert.ok(typeof result.elapsedMs === "number");
  for (const hit of result.hits) {
    assert.ok(hit.scope === "thinking" || hit.scope === "user");
    assert.ok(typeof hit.quote === "string");
    assert.ok(typeof hit.turn === "number");
    assert.ok(hit.sessionId);
  }
});

test("searchThinking OR queries and regex compile", () => {
  assert.throws(() => searchThinking({ query: "[", regex: true, maxSessions: 1 }), /Invalid regex/);

  let sessions;
  try {
    sessions = listChatSummaries({ limit: 3, offset: 0 }).sessions;
  } catch {
    return;
  }
  if (!sessions[0]) return;

  const any = searchThinking({
    query: "zzzz_unlikely_token_aaaa",
    queries: ["zzzz_unlikely_token_bbbb"],
    sessionIndex: sessions[0].sessionIndex,
    limit: 3,
  });
  assert.equal(any.mode, "any");
  assert.equal(any.hitCount, 0);
});
