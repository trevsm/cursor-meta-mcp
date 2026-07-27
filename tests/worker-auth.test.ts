import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../src/agent-cli.js", {
  namedExports: { isAgentCliLoggedIn: async () => true },
});

const { resolveHonestWorkerMode } = await import("../src/worker-auth.js");

test("resolveHonestWorkerMode ignores CLI-only auth for detached SDK fleet", async () => {
  const mode = await resolveHonestWorkerMode("sdk", {});
  assert.equal(mode, "ide");
});

test("resolveHonestWorkerMode hybrid requires api key not CLI alone", async () => {
  const mode = await resolveHonestWorkerMode("hybrid", {});
  assert.equal(mode, "ide");
});
