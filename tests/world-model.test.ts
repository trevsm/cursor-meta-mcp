import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  activeGoals,
  addBelief,
  appendEpisode,
  applyWorldRecord,
  compactGoals,
  completeGoal,
  dedupeActiveGoals,
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

test("dedupeActiveGoals abandons raced duplicate actives", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "world-dedupe-"));
  mkdirSync(join(metaDir, "world"), { recursive: true });
  writeFileSync(
    join(metaDir, "world", "goals.json"),
    JSON.stringify({
      northStar: "Build AGI",
      updatedAt: new Date().toISOString(),
      goals: [
        {
          id: "goal-a",
          text: "Ship one verified diff",
          status: "active",
          createdAt: "2026-07-27T05:00:00.000Z",
        },
        {
          id: "goal-b",
          text: "Ship one verified diff",
          status: "active",
          createdAt: "2026-07-27T05:01:00.000Z",
        },
        {
          id: "goal-c",
          text: "  Ship one verified DIFF  ",
          status: "active",
          createdAt: "2026-07-27T05:02:00.000Z",
        },
      ],
    }),
  );

  const compacted = compactGoals(metaDir);
  assert.equal(activeGoals(compacted).length, 1);
  assert.equal(activeGoals(compacted)[0]?.id, "goal-a");
  assert.equal(compacted.goals.filter((g) => g.status === "abandoned").length, 2);

  const rows = dedupeActiveGoals([
    { id: "1", text: "A", status: "active", createdAt: "t1" },
    { id: "2", text: "A", status: "active", createdAt: "t2" },
  ]);
  assert.equal(rows[0]?.status, "active");
  assert.equal(rows[1]?.status, "abandoned");

  const first = pushGoal("Normalize Goal Keys", metaDir);
  const again = pushGoal("  normalize   goal   keys ", metaDir);
  assert.equal(again.id, first.id);
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
  ) as { text: string; id: string };
  assert.equal(belief.text, "Use Node 22 for tests");
  const again = addBelief("  use   node 22 for tests ", metaDir, "retry");
  assert.equal(again.id, belief.id);
});
