import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  FLEET_AGENT_MODEL,
  FLEET_AGENT_MODEL_FALLBACK,
  downgradeFleetModel,
  fleetAgentModel,
  fleetModelRequiresCli,
  isModelRejectedError,
  resetFleetModelForTests,
} from "../src/fleet-model.js";

afterEach(() => {
  resetFleetModelForTests();
  delete process.env.CURSOR_META_FLEET_MODEL;
});

test("fleetAgentModel defaults to composer-2.5-fast and ignores caller overrides", () => {
  assert.equal(FLEET_AGENT_MODEL, "composer-2.5-fast");
  assert.equal(fleetAgentModel(), "composer-2.5-fast");
  assert.equal(fleetAgentModel("claude-opus-5-thinking-high"), "composer-2.5-fast");
});

test("fleetAgentModel honors CURSOR_META_FLEET_MODEL env override", () => {
  process.env.CURSOR_META_FLEET_MODEL = "composer-2.5";
  assert.equal(fleetAgentModel(), "composer-2.5");
  assert.equal(fleetAgentModel("claude-opus-5"), "composer-2.5");
});

test("fleetModelRequiresCli tracks the active model family", () => {
  assert.equal(fleetModelRequiresCli(), true);
  process.env.CURSOR_META_FLEET_MODEL = "gpt-5.5";
  assert.equal(fleetModelRequiresCli(), false);
});

test("isModelRejectedError matches CLI model rejection messages", () => {
  assert.equal(
    isModelRejectedError("Cannot use this model: composer-2.5-fast. Available models: default"),
    true,
  );
  assert.equal(isModelRejectedError("Unknown model composer-9"), true);
  assert.equal(isModelRejectedError("Connection lost, reconnecting"), false);
  assert.equal(isModelRejectedError(undefined), false);
});

test("downgradeFleetModel switches to the fallback once", () => {
  assert.equal(downgradeFleetModel(), FLEET_AGENT_MODEL_FALLBACK);
  assert.equal(fleetAgentModel(), FLEET_AGENT_MODEL_FALLBACK);
  // Already on the fallback — no further downgrade available.
  assert.equal(downgradeFleetModel(), null);
});
