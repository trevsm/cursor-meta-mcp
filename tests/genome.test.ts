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

test("the genome tells coders how to shape code, not only how to tick", () => {
  assert.match(DEFAULT_GENOME, /Make modules deep/);
  assert.match(
    DEFAULT_GENOME,
    /Extend the abstraction that already exists/,
    "two correlation-id modules and two escape-hatch helpers came from adding a parallel abstraction",
  );
  assert.match(
    DEFAULT_GENOME,
    /only forwards its arguments/,
    "a claim helper that dropped its lease token could never be used correctly",
  );
  assert.match(DEFAULT_GENOME, /Export the smallest surface/);
});
