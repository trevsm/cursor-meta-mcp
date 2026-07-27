import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyActionRisk,
  idempotencyKeyForAction,
  listPendingApprovals,
  requestHumanApproval,
  requiresHumanApproval,
  resolveHumanApproval,
} from "../src/human-gate.js";

test("classifyActionRisk flags force push as critical", () => {
  const result = classifyActionRisk("git push origin main --force");
  assert.equal(result.risk, "critical");
  assert.equal(result.action, "git_force_push");
});

test("requiresHumanApproval respects gate mode", () => {
  const cmd = "git push origin main --force";
  assert.equal(requiresHumanApproval(cmd, "yolo").required, false);
  assert.equal(requiresHumanApproval(cmd, "standard").required, true);
  assert.equal(requiresHumanApproval(cmd, "strict").required, true);
  assert.equal(requiresHumanApproval("npm test", "strict").required, false);
});

test("request and resolve approval with idempotency", () => {
  process.env.CURSOR_META_HOME = `/tmp/human-gate-${Date.now()}`;
  const sessionId = "00000000-0000-4000-8000-000000000001";

  const first = requestHumanApproval({
    question: "Force push?",
    action: "git_force_push",
    sessionId,
    cwd: "/Users/me/Projects/app",
    idempotencyKey: idempotencyKeyForAction("git_force_push", sessionId),
  });

  const second = requestHumanApproval({
    question: "Force push?",
    action: "git_force_push",
    sessionId,
    cwd: "/Users/me/Projects/app",
    idempotencyKey: idempotencyKeyForAction("git_force_push", sessionId),
  });

  assert.equal(first.id, second.id);
  assert.equal(listPendingApprovals("/Users/me/Projects/app").length, 1);

  const resolved = resolveHumanApproval({
    id: first.id,
    approved: false,
    feedback: "Use a PR instead",
    cwd: "/Users/me/Projects/app",
  });
  assert.equal(resolved.status, "denied");
  assert.equal(listPendingApprovals("/Users/me/Projects/app").length, 0);
});

test("human_as_tool defaults to free_text format", () => {
  process.env.CURSOR_META_HOME = `/tmp/human-gate-tool-${Date.now()}`;
  const req = requestHumanApproval({
    question: "Which API design do you prefer?",
    action: "design_advice",
    kind: "human_as_tool",
    cwd: "/repo",
  });
  assert.equal(req.kind, "human_as_tool");
  assert.equal(req.format, "free_text");
});
