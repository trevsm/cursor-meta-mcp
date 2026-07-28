import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const saved = process.env.CURSOR_META_HOME;
const tempHome = mkdtempSync(join(tmpdir(), "meta-home-test-"));
process.env.CURSOR_META_HOME = tempHome;

after(() => {
  if (saved === undefined) delete process.env.CURSOR_META_HOME;
  else process.env.CURSOR_META_HOME = saved;
});

const { metaHome, metaPath, runsDir } = await import("../src/meta-home.js");

test("metaHome respects CURSOR_META_HOME", () => {
  assert.equal(metaHome(), tempHome);
});

test("metaPath joins under meta home", () => {
  assert.equal(metaPath("runs", "run-1.jsonl"), join(tempHome, "runs", "run-1.jsonl"));
});

test("runsDir is under meta home", () => {
  assert.equal(runsDir(), join(tempHome, "runs"));
});
