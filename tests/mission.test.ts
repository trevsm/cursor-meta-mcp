import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentRunResult,
  LocalAgentService,
  RunLocalAgentParams,
  RunHooks,
} from "../src/cursor-local.js";
import {
  buildMissionRubric,
  buildMissionTask,
  defaultSuccessCriteria,
  runMission,
} from "../src/mission.js";

class MissionFakeService implements LocalAgentService {
  calls = 0;

  async whoami() {
    return { apiKeyName: "test" };
  }

  async listModels() {
    return [];
  }

  async runLocalAgent(params: RunLocalAgentParams, _hooks?: RunHooks): Promise<AgentRunResult> {
    this.calls += 1;
    const isJudge = params.name?.startsWith("relentless-critic") ?? false;
    return {
      agentId: isJudge ? "critic" : "agent-mission",
      runId: `run-${this.calls}`,
      status: "finished",
      result: isJudge
        ? '{"approved":true,"score":95,"issues":[],"nextPrompt":""}'
        : "mission complete",
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

test("buildMissionTask embeds goal and numbered criteria", () => {
  const task = buildMissionTask("Ship meta_mission", ["Tests pass", "README updated"]);
  assert.match(task, /Ship meta_mission/);
  assert.match(task, /1\. Tests pass/);
  assert.match(task, /2\. README updated/);
});

test("buildMissionRubric requires all criteria", () => {
  const rubric = buildMissionRubric(["Tests pass"]);
  assert.match(rubric, /ALL of the following/);
  assert.match(rubric, /Tests pass/);
});

test("defaultSuccessCriteria returns three baseline checks", () => {
  assert.equal(defaultSuccessCriteria().length, 3);
});

test("runMission rejects empty goal", async () => {
  const service = new MissionFakeService();
  await assert.rejects(
    () => runMission(service, { goal: "  ", cwd: "/tmp/project" }),
    /goal is required/,
  );
});

test("runMission rejects empty cwd", async () => {
  const service = new MissionFakeService();
  await assert.rejects(
    () => runMission(service, { goal: "Ship", cwd: "  " }),
    /cwd is required/,
  );
});

test("runMission wraps relentless loop with mission metadata", async () => {
  const service = new MissionFakeService();
  const result = await runMission(service, {
    goal: "Ship feature",
    successCriteria: ["Tests pass"],
    cwd: "/tmp/project",
    target: "sdk",
    maxIterations: 2,
  });
  assert.equal(result.mission.goal, "Ship feature");
  assert.deepEqual(result.mission.successCriteria, ["Tests pass"]);
  assert.equal(result.approved, true);
  assert.ok(result.mission.startedAt);
  assert.ok(result.mission.completedAt);
});
