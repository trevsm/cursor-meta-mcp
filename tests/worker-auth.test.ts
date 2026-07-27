import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../src/agent-cli.js", {
  namedExports: { isAgentCliLoggedIn: async () => true },
});

const { probeWorkerAuth, resolveHonestWorkerMode } = await import("../src/worker-auth.js");

test("probeWorkerAuth treats api key as sufficient for sdk", async () => {
  const auth = await probeWorkerAuth({ CURSOR_API_KEY: "test-key" });
  assert.deepEqual(auth, { apiKey: true, cli: true, sdk: true });
});

test("probeWorkerAuth falls back to cli login without api key", async () => {
  const auth = await probeWorkerAuth({});
  assert.deepEqual(auth, { apiKey: false, cli: true, sdk: true });
});

test("resolveHonestWorkerMode ignores CLI-only auth for detached SDK fleet", async () => {
  const mode = await resolveHonestWorkerMode("sdk", {});
  assert.equal(mode, "ide");
});

test("resolveHonestWorkerMode hybrid requires api key not CLI alone", async () => {
  const mode = await resolveHonestWorkerMode("hybrid", {});
  assert.equal(mode, "ide");
});

test("resolveHonestWorkerMode defaults to sdk when api key present", async () => {
  const mode = await resolveHonestWorkerMode(undefined, { CURSOR_API_KEY: "test-key" });
  assert.equal(mode, "sdk");
});

test("resolveHonestWorkerMode defaults to ide without api key", async () => {
  const mode = await resolveHonestWorkerMode(undefined, {});
  assert.equal(mode, "ide");
});

test("resolveHonestWorkerMode honors explicit ide mode even with api key", async () => {
  const mode = await resolveHonestWorkerMode("ide", { CURSOR_API_KEY: "test-key" });
  assert.equal(mode, "ide");
});
