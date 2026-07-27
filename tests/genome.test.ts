import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_GENOME, ensureGenome, formatGenomeForPrompt, genomePath } from "../src/genome.js";

test("ensureGenome writes default constitution", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "genome-"));
  ensureGenome(metaDir);
  const body = readFileSync(genomePath(metaDir), "utf8");
  assert.match(body, /test:fast/);
  assert.match(formatGenomeForPrompt(metaDir), /Operating constitution/);
  assert.match(DEFAULT_GENOME, /architecture theater/);
  // Second call is a no-op when file already exists.
  ensureGenome(metaDir);
  assert.equal(readFileSync(genomePath(metaDir), "utf8"), body);
});

test("formatGenomeForPrompt falls back to default when missing", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "genome-missing-"));
  assert.match(formatGenomeForPrompt(metaDir), /minimize scope/i);
});
