import assert from "node:assert/strict";
import test from "node:test";

import { FLEET_AGENT_MODEL, fleetAgentModel } from "../src/fleet-model.js";

test("fleetAgentModel always returns composer-2.5-fast", () => {
  assert.equal(FLEET_AGENT_MODEL, "composer-2.5-fast");
  assert.equal(fleetAgentModel(), "composer-2.5-fast");
  assert.equal(fleetAgentModel("claude-opus-5-thinking-high"), "composer-2.5-fast");
});
