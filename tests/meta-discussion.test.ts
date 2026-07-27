import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isMetaDiscussion,
  isOrchestrationExempt,
  isStrategySessionTitle,
} from "../src/meta-discussion.js";

test("isMetaDiscussion detects strategy and autonomy language", () => {
  assert.equal(isMetaDiscussion("this is still low level though?"), true);
  assert.equal(isMetaDiscussion("keep going, dont stop"), true);
  assert.equal(isMetaDiscussion("still broken"), false);
});

test("isStrategySessionTitle detects conductor-style chat titles", () => {
  assert.equal(isStrategySessionTitle("Conversation strategy review"), true);
  assert.equal(isStrategySessionTitle("Recent conversation alignment"), true);
  assert.equal(isStrategySessionTitle("Fix login bug"), false);
});

test("isOrchestrationExempt combines message and title signals", () => {
  assert.equal(isOrchestrationExempt("whatever you think", "Bug fix"), true);
  assert.equal(isOrchestrationExempt("deploy it", "Conversation strategy review"), true);
  assert.equal(isOrchestrationExempt("deploy it", "Fix login"), false);
});
