import assert from "node:assert/strict";
import { test } from "node:test";

import { loadChatTurns } from "../src/chat-turns.js";
import { listChatSummaries } from "../src/history-store.js";

test("loadChatTurns returns raw thoughts without scoring fields", (t) => {
  let sessions;
  try {
    sessions = listChatSummaries({ limit: 5, offset: 0 }).sessions;
  } catch {
    t.skip("Cursor history unavailable");
    return;
  }
  const target = sessions.find((s) => s.id);
  if (!target) {
    t.skip("no sessions");
    return;
  }

  const result = loadChatTurns({
    sessionId: target.id,
    limit: 3,
    includeThoughts: true,
    maxThoughtsPerTurn: 5,
    maxThoughtChars: 200,
  });

  assert.ok(result.turnCount >= 0);
  assert.equal(Object.hasOwn(result, "summary"), false);
  for (const turn of result.turns) {
    assert.ok(typeof turn.turn === "number");
    assert.ok(Array.isArray(turn.thoughts));
    assert.ok(Array.isArray(turn.toolBuckets));
    assert.equal("quality" in turn, false);
    assert.equal("signals" in turn, false);
    for (const thought of turn.thoughts) {
      assert.ok(typeof thought.text === "string");
      assert.ok(typeof thought.charCount === "number");
    }
  }
});

test("loadChatTurns turn= returns chronological timeline with tools", (t) => {
  let sessions;
  try {
    sessions = listChatSummaries({ limit: 20, offset: 0 }).sessions;
  } catch {
    t.skip("Cursor history unavailable");
    return;
  }

  let found: { sessionId: string; turn: number } | null = null;
  for (const session of sessions) {
    const overview = loadChatTurns({
      sessionId: session.id,
      limit: 30,
      includeThoughts: false,
      includeTimeline: false,
      minTools: 1,
      minThoughts: 1,
    });
    const candidate = overview.turns.find((turn) => turn.toolCount >= 1 && turn.thoughtCount >= 1);
    if (candidate) {
      found = { sessionId: session.id, turn: candidate.turn };
      break;
    }
  }
  if (!found) {
    t.skip("no turn with thoughts+tools");
    return;
  }

  const result = loadChatTurns({
    sessionId: found.sessionId,
    turn: found.turn,
    maxResultChars: 200,
  });
  assert.equal(result.returned, 1);
  const turn = result.turns[0]!;
  assert.ok(Array.isArray(turn.timeline));
  assert.ok(turn.timeline!.length >= 2);
  assert.ok(turn.timeline!.some((e) => e.kind === "thought"));
  assert.ok(turn.timeline!.some((e) => e.kind === "tool"));
  const tool = turn.timeline!.find((e) => e.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.ok(typeof tool.name === "string");
  assert.ok("params" in tool);
});
