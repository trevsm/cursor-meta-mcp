import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

mock.module("../src/agent-cli.js", {
  namedExports: { isAgentCliLoggedIn: async () => false },
});

const { parseDotenv, hasCursorApiKey, findNvmNodeBin, resolveWorkerNodeBin } = await import(
  "../src/load-env.js"
);
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

test("findNvmNodeBin picks newest matching major", () => {
  const home = mkdtempSync(join(tmpdir(), "nvm-home-"));
  const older = join(home, ".nvm/versions/node/v22.11.0/bin");
  const newer = join(home, ".nvm/versions/node/v22.22.3/bin");
  mkdirSync(older, { recursive: true });
  mkdirSync(newer, { recursive: true });
  writeFileSync(join(older, "node"), "#!/bin/sh\n");
  writeFileSync(join(newer, "node"), "#!/bin/sh\n");
  chmodSync(join(older, "node"), 0o755);
  chmodSync(join(newer, "node"), 0o755);
  assert.equal(findNvmNodeBin(22, home), join(newer, "node"));
  assert.equal(findNvmNodeBin(20, home), null);
});

test("resolveWorkerNodeBin falls back to nvm when not on Node 22", () => {
  const home = mkdtempSync(join(tmpdir(), "nvm-resolve-"));
  const binDir = join(home, ".nvm/versions/node/v22.22.3/bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "node");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  const major = Number(process.version.slice(1).split(".")[0]);
  if (major === 22) {
    assert.equal(resolveWorkerNodeBin({}, home), process.execPath);
  } else {
    assert.equal(resolveWorkerNodeBin({}, home), bin);
  }
});
