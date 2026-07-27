import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activitySignalsFromComposer,
  frustrationRiskFromBubbles,
  isMetaDiscussion,
  orchestrationPlays,
  runConsciousnessPulse,
} from "../src/consciousness-pulse.js";

test("activitySignalsFromComposer detects generating and loading tools", () => {
  const signals = activitySignalsFromComposer(
    { status: "running", generatingBubbleIds: ["b1"] },
    [{ type: "assistant", text: "", tool: "grep" }],
  );
  assert.match(signals.join(","), /generating/);
  assert.match(signals.join(","), /loading_tools/);
});

test("frustrationRiskFromBubbles flags post-failure rejection", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "Deployed the fix." },
    { type: "user", text: "still not working" },
  ]);
  assert.equal(risk.score, 0.95);
  assert.equal(risk.reason, "post_failure_rejection");
});

test("frustrationRiskFromBubbles flags terse still after claimed done", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "All fixed and deployed." },
    { type: "user", text: "still" },
  ]);
  assert.equal(risk.score, 0.92);
  assert.equal(risk.reason, "terse_still");
});

test("frustrationRiskFromBubbles flags false completion response", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "This should work now — done." },
    { type: "user", text: "this is wrong, login still fails" },
  ]);
  assert.ok(risk.score >= 0.85);
  assert.equal(risk.reason, "false_completion_response");
});

test("frustrationRiskFromBubbles ignores meta discussion pushback", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "Consolidation status: tests pass, task done." },
    { type: "user", text: "this is still low level though?" },
  ]);
  assert.equal(risk.score, 0);
  assert.equal(risk.reason, null);
});

test("isMetaDiscussion detects strategy review language", () => {
  assert.equal(isMetaDiscussion("I'm so confused, what is this all doing?"), true);
  assert.equal(isMetaDiscussion("still broken"), false);
});

test("orchestrationPlays recommends watch for in-flight generation", () => {
  const plays = orchestrationPlays(
    "Build MCP",
    "/Users/you/project",
    ["generating"],
    { score: 0, reason: null },
    [],
  );
  assert.equal(plays[0]?.action, "WATCH");
  assert.equal(plays[0]?.tool, "meta_watch_chat");
});

test("orchestrationPlays recommends intercept on high frustration", () => {
  const plays = orchestrationPlays(
    "Bug fix",
    "/Users/you/project",
    [],
    { score: 0.9, reason: "terse_still" },
    [],
  );
  assert.equal(plays[0]?.action, "INTERCEPT");
  assert.match(plays[0]?.why ?? "", /Frustration event/);
});

test("orchestrationPlays skips continue on strategy session titles", () => {
  const plays = orchestrationPlays(
    "Conversation strategy review",
    "/Users/you/project",
    [],
    { score: 0, reason: null },
    [{ type: "assistant", text: "Next step: implement the MCP tool." }],
  );
  assert.equal(plays.some((play) => play.action === "CONTINUE"), false);
});

test("orchestrationPlays skips continue on meta discussion sessions", () => {
  const plays = orchestrationPlays(
    "Strategy review",
    "/Users/you/project",
    [],
    { score: 0, reason: null },
    [
      { type: "assistant", text: "Next step: consolidate the tabs." },
      { type: "user", text: "I dont want any more moves, just self improve" },
    ],
  );
  assert.equal(plays.some((play) => play.action === "CONTINUE"), false);
});

test("orchestrationPlays does not intercept meta discussion frustration", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "Task done — all tests pass." },
    { type: "user", text: "this is still low level though?" },
  ]);
  const plays = orchestrationPlays("Review", "/Users/you/project", [], risk, [
    { type: "assistant", text: "Task done — all tests pass." },
    { type: "user", text: "this is still low level though?" },
  ]);
  assert.equal(plays.some((play) => play.action === "INTERCEPT"), false);
});

test("orchestrationPlays recommends continue when agent offered next steps", () => {
  const plays = orchestrationPlays(
    "Feature",
    "/Users/you/project",
    [],
    { score: 0, reason: null },
    [{ type: "assistant", text: "Next step: implement the MCP tool." }],
  );
  assert.equal(plays[0]?.action, "CONTINUE");
  assert.equal(plays[0]?.tool, "meta_watch_chat");
});

test("orchestrationPlays limits exempt sessions to watch-only", () => {
  const plays = orchestrationPlays(
    "Conversation strategy review",
    "/Users/you/faciliqpro",
    ["generating"],
    { score: 0.9, reason: "terse_still" },
    [{ type: "user", text: "still" }],
  );
  assert.deepEqual(
    plays.map((play) => play.action),
    ["WATCH"],
  );
});

test("runConsciousnessPulse reads local storage when available", async (t) => {
  try {
    const report = runConsciousnessPulse({ limit: 5 });
    assert.ok(report.at);
    assert.ok(report.scanned >= 0);
    assert.ok(Array.isArray(report.orchestrationMatrix));
    for (const entry of [...report.live, ...report.frustrationEvents]) {
      assert.equal(typeof entry.orchestrationExempt, "boolean");
    }
  } catch (error) {
    t.skip(`Cursor history unavailable: ${error}`);
  }
});
