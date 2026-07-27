import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRunResult,
  LocalAgentService,
  RunHooks,
  RunLocalAgentParams,
} from "../src/cursor-local.js";
import {
  buildStrategyReviewPrompt,
  DEFAULT_SELF_IMPROVE_CRITERIA,
  DEFAULT_SELF_IMPROVE_GOAL,
  gatherStrategyContext,
  heuristicStrategyReview,
  parseStrategyVerdict,
  runStrategyReview,
  type StrategyContext,
} from "../src/strategy-review.js";

class StrategyFakeService implements LocalAgentService {
  async whoami() {
    return { apiKeyName: "test" };
  }

  async listModels() {
    return [];
  }

  async runLocalAgent(params: RunLocalAgentParams, _hooks?: RunHooks): Promise<AgentRunResult> {
    return {
      agentId: "strategy-critic",
      runId: "run-1",
      status: "finished",
      result: JSON.stringify({
        onTrack: false,
        score: 40,
        issues: ["wrong_problem"],
        recommendation: "Pivot to tests",
        pivot: "Run npm test and fix failures only.",
        spawn: null,
        kill: [9],
      }),
    };
  }

  async followUp() {
    throw new Error("not expected");
  }

  async interceptAgent() {
    throw new Error("not expected");
  }

  async listActiveRuns() {
    return { items: [] };
  }

  async listLocalAgents() {
    return { items: [] };
  }

  async getAgent(params: { agentId: string }) {
    return params;
  }

  async listRuns() {
    return { items: [] };
  }

  async getRun() {
    return {};
  }

  async cancelRun() {}
}

const baseContext: StrategyContext = {
  goal: DEFAULT_SELF_IMPROVE_GOAL,
  successCriteria: DEFAULT_SELF_IMPROVE_CRITERIA,
  cwd: "/tmp/project",
  gitDiffStat: "(no uncommitted changes)",
  gitSyncSummary: "Git state: branch=main — clean and synced with origin.",
  transcriptTail: "Let's discuss the mental model and architecture vision.",
  pulseSummary: "live=2 frustration=0 matrix=1",
  workerSummary: "worker-session-2 #2: ticks=3 errors=0 stopped=running last=ok",
  worldModelSummary: "North star: Build AGI. Active goals: improve tests.",
  recentFailures: [],
};

test("parseStrategyVerdict parses full JSON", () => {
  const verdict = parseStrategyVerdict(
    '{"onTrack":false,"score":55,"issues":["no progress"],"recommendation":"Ship code","pivot":"Fix tests","spawn":null,"kill":[2]}',
  );
  assert.equal(verdict.onTrack, false);
  assert.equal(verdict.score, 55);
  assert.equal(verdict.pivot, "Fix tests");
  assert.deepEqual(verdict.kill, [2]);
  assert.deepEqual(verdict.killExperiments, []);
});

test("buildStrategyReviewPrompt includes mission and git diff", () => {
  const prompt = buildStrategyReviewPrompt(baseContext, "transcript tail");
  assert.match(prompt, /strategy critic/i);
  assert.match(prompt, /Autonomously improve/);
  assert.match(prompt, /transcript tail/);
  assert.match(prompt, /Git sync/);
  assert.match(prompt, /World model/);
  assert.match(prompt, /"onTrack"/);
});

test("heuristicStrategyReview flags repeated failures from world model", () => {
  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      gitDiffStat: " src/foo.ts | 4 ++",
      transcriptTail: "Implemented fix and npm test passes.",
      recentFailures: [
        { context: "npm test", reason: "sqlite3 ABI" },
        { context: "npm test", reason: "sqlite3 ABI again" },
      ],
    },
    "Implemented fix and npm test passes.",
  );
  assert.ok(verdict.issues.includes("repeated_failure"));
  assert.ok(verdict.pivot?.includes("npm test"));
  assert.match(verdict.recommendation, /change approach|world-model skills/i);
});

test("heuristicStrategyReview flags architecture theater without code progress", () => {
  const verdict = heuristicStrategyReview(baseContext, baseContext.transcriptTail);
  assert.equal(verdict.onTrack, false);
  assert.ok(verdict.issues.includes("architecture_theater"));
  assert.ok(verdict.pivot);
});

test("heuristicStrategyReview stays on track with concrete progress signals", () => {
  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      gitDiffStat: " src/foo.ts | 12 +++++",
      transcriptTail: "Implemented fix and npm test passes.",
    },
    "Implemented fix and npm test passes.",
  );
  assert.equal(verdict.onTrack, true);
  assert.equal(verdict.pivot, null);
});

test("heuristicStrategyReview flags workers stopped with consecutive_errors", () => {
  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      gitDiffStat: " src/foo.ts | 4 ++",
      transcriptTail: "Implemented fix and npm test passes.",
      workerSummary:
        "worker-dedicated #42: ticks=1 errors=1 stopped=consecutive_errors last=timeout",
    },
    "Implemented fix and npm test passes.",
  );
  assert.equal(verdict.onTrack, false);
  assert.ok(verdict.issues.includes("stale_workers"));
  assert.deepEqual(verdict.kill, [42]);
  assert.match(verdict.pivot ?? "", /Relaunch|workers/i);
});

test("heuristicStrategyReview killExperiments targets stale sdk-workers", () => {
  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      gitDiffStat: " src/foo.ts | 4 ++",
      transcriptTail: "Implemented fix and npm test passes.",
      workerSummary:
        "sdk-worker-a #?: ticks=4 attempted=4 productive=0 ratio=0% errors=4 soft=0 stopped=error last=auth",
    },
    "Implemented fix and npm test passes.",
  );
  assert.ok(verdict.issues.includes("stale_workers"));
  assert.ok(verdict.issues.includes("low_productive_ratio"));
  assert.deepEqual(verdict.killExperiments, ["sdk-worker-a"]);
  assert.deepEqual(verdict.kill, []);
});

test("heuristicStrategyReview flags low productive ratio without hard errors", () => {
  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      gitDiffStat: " src/foo.ts | 4 ++",
      transcriptTail: "Implemented fix and npm test passes.",
      workerSummary:
        "worker-dedicated #7: ticks=6 attempted=5 productive=1 ratio=20% errors=0 soft=1 stopped=running last=ok",
    },
    "Implemented fix and npm test passes.",
  );
  assert.ok(verdict.issues.includes("low_productive_ratio"));
  assert.equal(verdict.issues.includes("stale_workers"), false);
  assert.match(verdict.pivot ?? "", /30% gate/i);
  assert.match(verdict.recommendation, /productive-tick ratio/i);
});

test("gatherStrategyContext uses default success criteria", () => {
  const context = gatherStrategyContext({
    goal: "Improve repo",
    cwd: "/tmp/project",
  });
  assert.equal(context.goal, "Improve repo");
  assert.ok(context.successCriteria.length >= 3);
});

test("runStrategyReview rejects empty goal", async () => {
  await assert.rejects(
    () => runStrategyReview(undefined, { goal: "  ", cwd: "/tmp" }),
    /goal is required/,
  );
});

test("runStrategyReview heuristic-only without service", async () => {
  const result = await runStrategyReview(undefined, {
    goal: DEFAULT_SELF_IMPROVE_GOAL,
    cwd: process.cwd(),
    useLlm: false,
  });
  assert.equal(result.source, "heuristic");
  assert.ok(result.verdict.recommendation);
  assert.ok(result.reviewedAt);
});

test("runStrategyReview merges heuristic and llm verdicts", async () => {
  const service = new StrategyFakeService();
  const result = await runStrategyReview(service, {
    goal: DEFAULT_SELF_IMPROVE_GOAL,
    cwd: process.cwd(),
    useLlm: true,
  });
  assert.equal(result.source, "heuristic+llm");
  assert.equal(result.verdict.onTrack, false);
  assert.ok(result.verdict.kill.includes(9));
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "strategy-review-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}

test("heuristicStrategyReview flags uncommitted work after concrete progress", () => {
  const cwd = initRepo();
  writeFileSync(join(cwd, "change.txt"), "done\n");
  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      cwd,
      gitDiffStat: " change.txt | 1 +",
      gitSyncSummary: "dirty",
    },
    "Implemented fix and npm test passes.",
  );
  assert.equal(verdict.onTrack, false);
  assert.ok(verdict.issues.includes("uncommitted_work"));
  assert.match(verdict.pivot ?? "", /commit/i);
});

test("heuristicStrategyReview flags unpushed commits", () => {
  const cwd = initRepo();
  // Simulate upstream tracking with a fake remote ref by creating a second commit locally
  // and pointing origin/main at the first commit via a bare remote.
  const bare = mkdtempSync(join(tmpdir(), "strategy-origin-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd });
  execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd });
  writeFileSync(join(cwd, "local-only.txt"), "ahead\n");
  execFileSync("git", ["add", "local-only.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "local ahead"], { cwd });

  const verdict = heuristicStrategyReview(
    {
      ...baseContext,
      cwd,
      gitDiffStat: "(no uncommitted changes)",
      gitSyncSummary: "ahead",
    },
    "Implemented fix and npm test passes. committed.",
  );
  assert.equal(verdict.onTrack, false);
  assert.ok(verdict.issues.includes("unpushed_commits"));
  assert.match(verdict.pivot ?? "", /Push/i);
});
