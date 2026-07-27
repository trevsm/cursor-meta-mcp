import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRunResult, LocalAgentService, RunLocalAgentParams, RunHooks } from "../src/cursor-local.js";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  runRelentlessLoop,
} from "../src/relentless-loop.js";

class RelentlessFakeService implements LocalAgentService {
  calls = 0;

  constructor(
    private readonly workerResults: string[],
    private readonly judgeResults: string[],
  ) {}

  async whoami() {
    return { apiKeyName: "test" };
  }

  async listModels() {
    return [];
  }

  private nextWorkerResult(): AgentRunResult {
    this.calls += 1;
    return {
      agentId: "agent-worker",
      runId: `run-${this.calls}`,
      status: "finished",
      result: this.workerResults.shift() ?? "worker done",
    };
  }

  async runLocalAgent(params: RunLocalAgentParams, hooks?: RunHooks) {
    void hooks;
    if (params.name?.startsWith("relentless-critic")) {
      this.calls += 1;
      return {
        agentId: `critic-${this.calls}`,
        runId: `run-${this.calls}`,
        status: "finished",
        result:
          this.judgeResults.shift() ??
          '{"approved":true,"score":95,"issues":[],"nextPrompt":""}',
      };
    }
    return this.nextWorkerResult();
  }

  async followUp(_params: unknown, hooks?: RunHooks) {
    void hooks;
    return this.nextWorkerResult();
  }

  async interceptAgent() {
    throw new Error("not implemented");
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

test("buildJudgePrompt includes task and rubric", () => {
  const prompt = buildJudgePrompt("ship feature", "partial output", "must test");
  assert.match(prompt, /ship feature/);
  assert.match(prompt, /partial output/);
  assert.match(prompt, /must test/);
  assert.match(prompt, /ONLY valid JSON/);
});

test("parseJudgeVerdict accepts fenced JSON", () => {
  const verdict = parseJudgeVerdict(
    'Review complete.\n{"approved":false,"score":40,"issues":["no tests"],"nextPrompt":"Add tests and rerun."}',
    85,
  );
  assert.equal(verdict.approved, false);
  assert.equal(verdict.score, 40);
  assert.deepEqual(verdict.issues, ["no tests"]);
  assert.match(verdict.nextPrompt, /Add tests/);
});

test("parseJudgeVerdict approves high score", () => {
  const verdict = parseJudgeVerdict(
    '{"approved":true,"score":92,"issues":[],"nextPrompt":""}',
    85,
  );
  assert.equal(verdict.approved, true);
});

test("runRelentlessLoop stops after approval", async () => {
  const service = new RelentlessFakeService(
    ["first attempt"],
    [
      '{"approved":false,"score":50,"issues":["missing tests"],"nextPrompt":"Add tests."}',
      '{"approved":true,"score":95,"issues":[],"nextPrompt":""}',
    ],
  );

  const result = await runRelentlessLoop(service, {
    task: "implement feature",
    cwd: "/tmp/project",
    target: "sdk",
    maxIterations: 5,
  });

  assert.equal(result.approved, true);
  assert.equal(result.iterations, 2);
  assert.equal(result.history.filter((entry) => entry.phase === "judge").length, 2);
});

test("runRelentlessLoop keeps going when rejected", async () => {
  const service = new RelentlessFakeService(
    ["attempt 1", "attempt 2"],
    [
      '{"approved":false,"score":30,"issues":["bad"],"nextPrompt":"Fix it."}',
      '{"approved":false,"score":60,"issues":["still bad"],"nextPrompt":"Fix again."}',
    ],
  );

  const result = await runRelentlessLoop(service, {
    task: "fix bug",
    cwd: "/tmp/project",
    target: "sdk",
    maxIterations: 2,
  });

  assert.equal(result.approved, false);
  assert.equal(result.iterations, 2);
  assert.equal(result.history.filter((entry) => entry.phase === "work").length, 2);
});
