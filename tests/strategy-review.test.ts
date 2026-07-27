import assert from "node:assert/strict";
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
  transcriptTail: "Let's discuss the mental model and architecture vision.",
  pulseSummary: "live=2 frustration=0 matrix=1",
  workerSummary: "worker-session-2 #2: ticks=3 errors=0 stopped=running last=ok",
};

test("parseStrategyVerdict parses full JSON", () => {
  const verdict = parseStrategyVerdict(
    '{"onTrack":false,"score":55,"issues":["no progress"],"recommendation":"Ship code","pivot":"Fix tests","spawn":null,"kill":[2]}',
  );
  assert.equal(verdict.onTrack, false);
  assert.equal(verdict.score, 55);
  assert.equal(verdict.pivot, "Fix tests");
  assert.deepEqual(verdict.kill, [2]);
});

test("buildStrategyReviewPrompt includes mission and git diff", () => {
  const prompt = buildStrategyReviewPrompt(baseContext, "transcript tail");
  assert.match(prompt, /strategy critic/i);
  assert.match(prompt, /Autonomously improve/);
  assert.match(prompt, /transcript tail/);
  assert.match(prompt, /"onTrack"/);
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
