import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  activeGoals,
  addBelief,
  appendEpisode,
  completeGoal,
  formatWorldModelForPrompt,
  loadWorldModel,
  pushGoal,
  recentEpisodes,
  recordFailure,
  setNorthStar,
} from "../src/world-model.js";

test("world model persists north star, goals, beliefs, failures, episodes", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "world-model-"));

  setNorthStar("Build persistent autonomous intelligence", metaDir);
  const goal = pushGoal("Add world model store", metaDir);
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
