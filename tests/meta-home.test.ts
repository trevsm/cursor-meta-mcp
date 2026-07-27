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

const { experimentsDir, metaHome, metaPath } = await import("../src/meta-home.js");

test("metaHome respects CURSOR_META_HOME", () => {
  assert.equal(metaHome(), tempHome);
});

test("metaPath joins under meta home", () => {
  assert.equal(metaPath("experiments", "manifest.json"), join(tempHome, "experiments", "manifest.json"));
});

test("experimentsDir is under meta home", () => {
  assert.equal(experimentsDir(), join(tempHome, "experiments"));
});
