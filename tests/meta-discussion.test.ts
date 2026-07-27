import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isMetaDiscussion,
  isOrchestrationExempt,
  isRepeatedFailureLoop,
  isStrategySessionTitle,
  isTerseRejection,
  isTerseStill,
} from "../src/meta-discussion.js";

test("isMetaDiscussion detects strategy and autonomy language", () => {
  assert.equal(isMetaDiscussion("this is still low level though?"), true);
  assert.equal(isMetaDiscussion("keep going, dont stop"), true);
  assert.equal(isMetaDiscussion("stay autonomous — no user moves"), true);
  assert.equal(isMetaDiscussion("run npm test until coverage is green"), false);
  assert.equal(isMetaDiscussion("still broken"), false);
  assert.equal(isMetaDiscussion("   "), false);
  assert.equal(isMetaDiscussion(""), false);
});

test("isStrategySessionTitle detects conductor-style chat titles", () => {
  assert.equal(isStrategySessionTitle("Conversation strategy review"), true);
  assert.equal(isStrategySessionTitle("Recent conversation alignment"), true);
  assert.equal(isStrategySessionTitle("Long-session worker 2"), true);
  assert.equal(isStrategySessionTitle("Autonomous worker tab"), true);
  assert.equal(isStrategySessionTitle("Conductor orchestrator"), true);
  assert.equal(isStrategySessionTitle("Fix login bug"), false);
  assert.equal(isStrategySessionTitle(""), false);
});

test("isOrchestrationExempt combines message and title signals", () => {
  assert.equal(isOrchestrationExempt("whatever you think", "Bug fix"), true);
  assert.equal(isOrchestrationExempt("deploy it", "Conversation strategy review"), true);
  assert.equal(isOrchestrationExempt("deploy it", "Fix login"), false);
  assert.equal(isOrchestrationExempt("", ""), false);
});

test("isTerseStill and isTerseRejection match short rejections", () => {
  assert.equal(isTerseStill("still"), true);
  assert.equal(isTerseStill("still."), true);
  assert.equal(isTerseStill("still broken"), false);
  assert.equal(isTerseRejection("nope"), true);
  assert.equal(isTerseRejection("bad"), true);
  assert.equal(isTerseRejection("nope, try again"), false);
});

test("isRepeatedFailureLoop detects same-error and circling language", () => {
  assert.equal(isRepeatedFailureLoop("same error again"), true);
  assert.equal(isRepeatedFailureLoop("we're going in circles"), true);
  assert.equal(isRepeatedFailureLoop("we're looping"), true);
  assert.equal(isRepeatedFailureLoop("tried that already"), true);
  assert.equal(isRepeatedFailureLoop("please fix the login"), false);
  assert.equal(isRepeatedFailureLoop("fixed it"), false);
  assert.equal(isRepeatedFailureLoop(""), false);
});
