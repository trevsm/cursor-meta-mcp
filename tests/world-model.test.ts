import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  activeGoals,
  addBelief,
  appendEpisode,
  applyWorldRecord,
  completeGoal,
  formatWorldModelForPrompt,
  listSkills,
  loadWorldModel,
  pushGoal,
  recentEpisodes,
  recordFailure,
  setNorthStar,
  worldStatus,
} from "../src/world-model.js";

test("world model persists north star, goals, beliefs, failures, episodes", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "world-model-"));

  setNorthStar("Build persistent autonomous intelligence", metaDir);
  const goal = pushGoal("Add world model store", metaDir);
  const dup = pushGoal("Add world model store", metaDir);
  assert.equal(dup.id, goal.id);
  addBelief("Dashboard polls /api/live every 2s", metaDir, "test");
  recordFailure("npm test on Node 24", "better-sqlite3 ABI mismatch", metaDir);
  appendEpisode(
    {
      at: new Date().toISOString(),
      actor: "worker-a",
      observe: "fleet idle",
      action: "implemented world-model.ts",
      verify: "npm test pass",
      outcome: "success",
    },
    metaDir,
  );

  const model = loadWorldModel(metaDir);
  assert.equal(model.northStar, "Build persistent autonomous intelligence");
  assert.equal(activeGoals(model).length, 1);
  assert.equal(model.beliefs.length, 1);
  assert.equal(model.failures.length, 1);

  completeGoal(goal.id, metaDir);
  assert.equal(activeGoals(loadWorldModel(metaDir)).length, 0);

  const episodes = recentEpisodes(metaDir);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.outcome, "success");

  const prompt = formatWorldModelForPrompt(model, episodes);
  assert.match(prompt, /North star/);
  assert.match(prompt, /Recent episodes/);
});

test("extractSkillFromEpisode saves successful procedures", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "world-skill-"));
  const episode = appendEpisode(
    {
      at: new Date().toISOString(),
      actor: "worker-a",
      observe: "chat idle",
      action: "fixed dashboard URL parser",
      verify: "npm test passes and dashboard verify-deliverable OK",
      outcome: "success",
    },
    metaDir,
  );
  const skills = listSkills(metaDir);
  assert.equal(skills.length, 1);
  assert.match(skills[0]?.procedure ?? "", /dashboard URL parser/);
  assert.equal(skills[0]?.sourceEpisodeId, episode.id);
});

test("worldStatus returns summary bundle", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "world-status-"));
  setNorthStar("Build AGI", metaDir);
  const status = worldStatus(metaDir);
  assert.equal(status.model.northStar, "Build AGI");
  assert.match(status.summary, /North star/);
});

test("applyWorldRecord push_goal and add_belief", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "world-record-"));
  const goal = applyWorldRecord("push_goal", { text: "Ship skill extraction" }, metaDir) as { text: string };
  assert.equal(goal.text, "Ship skill extraction");
  const belief = applyWorldRecord(
    "add_belief",
    { text: "Use Node 22 for tests", source: "npm test" },
    metaDir,
  ) as { text: string };
  assert.equal(belief.text, "Use Node 22 for tests");
});
