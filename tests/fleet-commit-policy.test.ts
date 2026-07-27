import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditBatchCommit,
  auditBatchPush,
  defaultHonestFleetGoal,
  formatBatchGitReminder,
  resolveCommitBatchPolicy,
} from "../src/fleet-commit-policy.js";
import { cursorMetaMcpRoot } from "../src/fleet-target.js";

test("resolveCommitBatchPolicy enables batching on external repos", () => {
  const external = resolveCommitBatchPolicy("/Users/me/Desktop/faciliq-platform-core");
  assert.equal(external.enabled, true);
  assert.equal(external.minCommitsBeforePush, 3);
  assert.equal(external.minTicksBetweenCommits, 3);

  const selfTarget = resolveCommitBatchPolicy(cursorMetaMcpRoot());
  assert.equal(selfTarget.enabled, false);
});

test("defaultHonestFleetGoal describes batch git for external repos", () => {
  const goal = defaultHonestFleetGoal("/Users/me/Desktop/faciliq-platform-core");
  assert.match(goal, /batch git/i);
  assert.match(goal, /uncommitted/i);
  assert.doesNotMatch(defaultHonestFleetGoal(cursorMetaMcpRoot()), /batch git/i);
});

test("auditBatchCommit blocks rapid small commits", () => {
  const policy = {
    enabled: true,
    minCommitsBeforePush: 3,
    minTicksBetweenPush: 4,
    minTicksBetweenCommits: 3,
    minFilesForCommit: 3,
    minLinesForCommit: 40,
    deferCommitUntilSliceGreen: true,
  };
  const prior = [
    { outcome: { committed: true, commits: 1, filesChanged: 2, tests: { ran: true, passed: true } } },
    { outcome: { committed: false } },
  ];
  const audit = auditBatchCommit(
    prior,
    { committed: true, commits: 1, filesChanged: 2, tests: { ran: true, passed: true } },
    policy,
  );
  assert.equal(audit.blocked, true);
  assert.match(audit.violations[0] ?? "", /batch commit policy/i);
});

test("auditBatchCommit allows large verified slice early", () => {
  const policy = {
    enabled: true,
    minCommitsBeforePush: 3,
    minTicksBetweenPush: 4,
    minTicksBetweenCommits: 3,
    minFilesForCommit: 3,
    minLinesForCommit: 40,
    deferCommitUntilSliceGreen: true,
  };
  const audit = auditBatchCommit(
    [{ outcome: { committed: true, commits: 1 } }],
    {
      committed: true,
      commits: 1,
      filesChanged: 4,
      insertions: 50,
      tests: { ran: true, passed: true },
    },
    policy,
  );
  assert.equal(audit.blocked, false);
});

test("auditBatchCommit blocks commit before verify green", () => {
  const policy = resolveCommitBatchPolicy("/Users/me/Desktop/faciliq-platform-core");
  const audit = auditBatchCommit(
    [],
    { committed: true, commits: 1, tests: { ran: true, passed: false } },
    policy,
  );
  assert.equal(audit.blocked, true);
  assert.match(audit.violations[0] ?? "", /fully green/i);
});

test("auditBatchPush blocks single-commit push after few ticks", () => {
  const policy = {
    enabled: true,
    minCommitsBeforePush: 3,
    minTicksBetweenPush: 4,
    minTicksBetweenCommits: 3,
    minFilesForCommit: 3,
    minLinesForCommit: 40,
    deferCommitUntilSliceGreen: true,
  };
  const prior = [
    { tick: 1, outcome: { pushed: true, commits: 1 } },
    { tick: 2, outcome: { committed: true, commits: 1 } },
    { tick: 3, outcome: { committed: true, commits: 1 } },
  ];
  const audit = auditBatchPush(prior, { pushed: true, commits: 1 }, policy);
  assert.equal(audit.blocked, true);
  assert.match(audit.violations[0] ?? "", /batch push policy/i);
});

test("formatBatchGitReminder tells worker to wait on commits and pushes", () => {
  const reminder = formatBatchGitReminder(
    [
      { outcome: { pushed: true, commits: 1 } },
      { outcome: { committed: true, commits: 1 } },
    ],
    {
      enabled: true,
      minCommitsBeforePush: 3,
      minTicksBetweenPush: 4,
      minTicksBetweenCommits: 3,
      minFilesForCommit: 3,
      minLinesForCommit: 40,
      deferCommitUntilSliceGreen: true,
    },
  );
  assert.match(reminder ?? "", /do NOT commit/i);
  assert.match(reminder ?? "", /do not push yet/i);
});
