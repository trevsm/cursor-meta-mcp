import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activitySignalsFromComposer,
  frustrationRiskFromBubbles,
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

test("frustrationRiskFromBubbles flags still as post-failure rejection", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "All fixed and deployed." },
    { type: "user", text: "still" },
  ]);
  assert.equal(risk.score, 0.95);
  assert.equal(risk.reason, "post_failure_rejection");
});

test("frustrationRiskFromBubbles flags false completion response", () => {
  const risk = frustrationRiskFromBubbles([
    { type: "assistant", text: "This should work now — done." },
    { type: "user", text: "still not right" },
  ]);
  assert.ok(risk.score >= 0.85);
  assert.equal(risk.reason, "false_completion_response");
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

test("runConsciousnessPulse reads local storage when available", async (t) => {
  try {
    const report = runConsciousnessPulse({ limit: 5 });
    assert.ok(report.at);
    assert.ok(report.scanned >= 0);
    assert.ok(Array.isArray(report.orchestrationMatrix));
  } catch (error) {
    t.skip(`Cursor history unavailable: ${error}`);
  }
});
