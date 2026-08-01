import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../src/agent-cli.js", {
  namedExports: { isAgentCliLoggedIn: async () => true },
});

const { probeWorkerAuth, resolveHonestWorkerMode, sdkWorkerLaunchable } = await import(
  "../src/worker-auth.js"
);

/** Run fn with the fleet model pinned to an SDK-routed (non-composer) model. */
async function withSdkRoutedModel<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.CURSOR_META_FLEET_MODEL;
  process.env.CURSOR_META_FLEET_MODEL = "gpt-5.5";
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.CURSOR_META_FLEET_MODEL;
    else process.env.CURSOR_META_FLEET_MODEL = prev;
  }
}

test("probeWorkerAuth treats api key as sufficient for sdk", async () => {
  const auth = await probeWorkerAuth({ CURSOR_API_KEY: "test-key" });
  assert.deepEqual(auth, { apiKey: true, cli: true, sdk: true });
});

test("probeWorkerAuth falls back to cli login without api key", async () => {
  const auth = await probeWorkerAuth({});
  assert.deepEqual(auth, { apiKey: false, cli: true, sdk: true });
});

test("sdkWorkerLaunchable accepts CLI-only auth when fleet model is CLI-routed", () => {
  assert.equal(sdkWorkerLaunchable({ apiKey: false, cli: true, sdk: true }), true);
});

test("sdkWorkerLaunchable rejects CLI-only auth for SDK-routed models", async () => {
  await withSdkRoutedModel(() => {
    assert.equal(sdkWorkerLaunchable({ apiKey: false, cli: true, sdk: true }), false);
    assert.equal(sdkWorkerLaunchable({ apiKey: true, cli: true, sdk: true }), true);
  });
});

test("resolveHonestWorkerMode keeps sdk with CLI-only auth on CLI-routed model", async () => {
  const mode = await resolveHonestWorkerMode("sdk", {});
  assert.equal(mode, "sdk");
});

test("resolveHonestWorkerMode falls back to ide with CLI-only auth on SDK-routed model", async () => {
  await withSdkRoutedModel(async () => {
    assert.equal(await resolveHonestWorkerMode("sdk", {}), "ide");
    assert.equal(await resolveHonestWorkerMode("hybrid", {}), "ide");
    assert.equal(await resolveHonestWorkerMode(undefined, {}), "ide");
  });
});

test("resolveHonestWorkerMode hybrid works with CLI-only auth on CLI-routed model", async () => {
  const mode = await resolveHonestWorkerMode("hybrid", {});
  assert.equal(mode, "hybrid");
});

test("resolveHonestWorkerMode defaults to sdk when api key present", async () => {
  const mode = await resolveHonestWorkerMode(undefined, { CURSOR_API_KEY: "test-key" });
  assert.equal(mode, "sdk");
});

test("resolveHonestWorkerMode defaults to sdk with CLI-only auth on CLI-routed model", async () => {
  const mode = await resolveHonestWorkerMode(undefined, {});
  assert.equal(mode, "sdk");
});

test("resolveHonestWorkerMode honors explicit ide mode even with api key", async () => {
  const mode = await resolveHonestWorkerMode("ide", { CURSOR_API_KEY: "test-key" });
  assert.equal(mode, "ide");
});
