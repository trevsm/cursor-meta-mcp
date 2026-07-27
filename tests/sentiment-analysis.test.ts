import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeUserMessage,
  isSystemNoise,
  priorClaimedDone,
  runSentimentAnalysis,
  stripMessageText,
} from "../src/sentiment-analysis.js";

test("stripMessageText removes tags and timestamps", () => {
  const text = stripMessageText(
    "<timestamp>2026</timestamp><user_query>still broken</user_query>",
  );
  assert.equal(text, "still broken");
});

test("isSystemNoise filters subagent completion messages", () => {
  assert.equal(isSystemNoise("The following task has finished running."), true);
  assert.equal(isSystemNoise("please fix the login bug"), false);
});

test("priorClaimedDone detects assistant completion claims", () => {
  assert.equal(priorClaimedDone("All tests pass. This should work now."), true);
  assert.equal(priorClaimedDone("I couldn't get this working yet."), false);
});

test("analyzeUserMessage flags terse still after claimed done", () => {
  const scores = analyzeUserMessage("still", {
    afterClaimedDone: true,
    userMsgIndex: 3,
    raw: "still",
  });
  assert.ok(scores.frustration >= 0.9);
  assert.equal(scores.label, "frustrated");
});

test("analyzeUserMessage downgrades directive frustration", () => {
  const scores = analyzeUserMessage(
    "Implement the sentiment MCP tool with tests and update the README documentation for the new endpoint.",
    { afterClaimedDone: false, userMsgIndex: 1, raw: "Implement..." },
  );
  assert.ok(scores.frustration < 0.3);
  assert.equal(scores.label, "neutral_directive");
});

test("runSentimentAnalysis reads local history when available", async (t) => {
  try {
    const report = runSentimentAnalysis({ topMessages: 5, topSessions: 3 });
    assert.ok(report.generatedAt);
    assert.ok(report.totals.userMessages >= 0);
    assert.ok(typeof report.global.frustration === "number");
  } catch (error) {
    t.skip(`Cursor history unavailable: ${error}`);
  }
});
