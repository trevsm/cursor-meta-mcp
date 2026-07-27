import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissionRubric,
  buildMissionTask,
  defaultSuccessCriteria,
} from "../src/mission.js";

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
