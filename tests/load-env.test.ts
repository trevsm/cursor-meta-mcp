import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

mock.module("../src/agent-cli.js", {
  namedExports: { isAgentCliLoggedIn: async () => false },
});

const { parseDotenv, hasCursorApiKey, resolveWorkerNodeBin } = await import("../src/load-env.js");
const { resolveHonestWorkerMode } = await import("../src/worker-auth.js");

test("parseDotenv reads KEY=VALUE lines", () => {
  const parsed = parseDotenv("# comment\nCURSOR_API_KEY=test_key\nFOO=\"bar\"\n");
  assert.equal(parsed.CURSOR_API_KEY, "test_key");
  assert.equal(parsed.FOO, "bar");
});

test("hasCursorApiKey detects non-empty key", () => {
  assert.equal(hasCursorApiKey({ CURSOR_API_KEY: "x" }), true);
  assert.equal(hasCursorApiKey({ CURSOR_API_KEY: "  " }), false);
});

test("resolveHonestWorkerMode falls back to ide without auth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-auth-"));
  writeFileSync(join(dir, ".env"), "# empty\n");
  const mode = await resolveHonestWorkerMode("sdk");
  assert.equal(mode, "ide");
});

test("resolveWorkerNodeBin prefers explicit override", () => {
  assert.equal(resolveWorkerNodeBin({ CURSOR_META_NODE: "/custom/node" }), "/custom/node");
});
