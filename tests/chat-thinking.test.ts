import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeThinkingEfficiency } from "../src/chat-thinking.js";

test("analyzeThinkingEfficiency flags cache bloat and tool thrash", () => {
  const insights = analyzeThinkingEfficiency({
    stats: {
      bubbleCount: 1000,
      thinkingBlockCount: 200,
      totalThinkingChars: 600_000,
      totalThinkingDurationMs: 10_000,
      avgThinkingChars: 3000,
      avgDurationMs: 50,
      toolCallCount: 250,
      topTools: [{ name: "Grep", count: 80 }],
      longestBlocks: [],
    },
    thinkingTexts: Array.from({ length: 30 }, () => "searching again for the same error still broken"),
    usage: {
      chargedCents: 20000,
      eventCount: 150,
      cacheReadTokens: 80_000_000,
      models: ["composer-2.5-fast", "gpt-5.6-sol-high", "claude-opus-4-8-thinking-high"],
    },
  });

  const ids = insights.map((i) => i.id);
  assert.ok(ids.includes("tool-thrash"));
  assert.ok(ids.includes("long-cot"));
  assert.ok(ids.includes("cache-bloat"));
  assert.ok(ids.includes("many-requests"));
  assert.ok(ids.includes("retry-loop"));
  assert.ok(ids.includes("model-switch"));
});

test("analyzeThinkingEfficiency returns ok when quiet", () => {
  const insights = analyzeThinkingEfficiency({
    stats: {
      bubbleCount: 20,
      thinkingBlockCount: 5,
      totalThinkingChars: 1000,
      totalThinkingDurationMs: 100,
      avgThinkingChars: 200,
      avgDurationMs: 20,
      toolCallCount: 3,
      topTools: [{ name: "Read", count: 2 }],
      longestBlocks: [],
    },
    thinkingTexts: ["Implement the change.", "Verify lints."],
  });
  assert.equal(insights.some((i) => i.id === "ok"), true);
});
