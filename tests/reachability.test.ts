import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { findUnreachableExports, parseExportedSymbols, changedSourceFiles } = await import(
  "../src/reachability.js"
);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "reach-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  write(dir, "src/existing.ts", "export const seed = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: dir, encoding: "utf8" }).trim();
}

test("parseExportedSymbols picks up runtime exports and ignores types", () => {
  const symbols = parseExportedSymbols(
    [
      "export function runTick() {}",
      "export const LIMIT = 5;",
      "export class Dispatcher {}",
      "export async function drain() {}",
      "export type Options = { a: string };",
      "export interface Deps { b: number }",
    ].join("\n"),
  );
  assert.deepEqual(symbols.sort(), ["Dispatcher", "LIMIT", "drain", "runTick"]);
});

test("findUnreachableExports flags a new export whose only callers are tests", () => {
  const dir = initRepo();
  write(dir, "src/outbox/tick.ts", "export function runOutboxDispatcherTick() {\n  return 0;\n}\n");
  write(
    dir,
    "src/outbox/tick.test.ts",
    'import { runOutboxDispatcherTick } from "./tick.js";\nrunOutboxDispatcherTick();\n',
  );
  const before = commitAll(dir, "add dispatcher with tests only");

  const rows = findUnreachableExports(dir, before);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0]?.symbol, "runOutboxDispatcherTick");
  assert.equal(rows[0]?.productionRefs, 0);
  assert.equal(rows[0]?.severity, "unwired");
  assert.ok((rows[0]?.testRefs ?? 0) > 0, "test callers should still be counted, just not as wiring");
});

test("findUnreachableExports stays quiet when production code calls the new export", () => {
  const dir = initRepo();
  write(dir, "src/outbox/tick.ts", "export function runOutboxDispatcherTick() {\n  return 0;\n}\n");
  write(
    dir,
    "src/runner.ts",
    'import { runOutboxDispatcherTick } from "./outbox/tick.js";\n\nexport function startRunner() {\n  return runOutboxDispatcherTick();\n}\n',
  );
  write(
    dir,
    "src/main.ts",
    'import { startRunner } from "./runner.js";\nstartRunner();\n',
  );
  const before = commitAll(dir, "add dispatcher and wire it");

  assert.deepEqual(findUnreachableExports(dir, before), []);
});

test("a barrel re-export does not count as wiring", () => {
  const dir = initRepo();
  write(dir, "src/outbox/tick.ts", "export function runOutboxDispatcherTick() {\n  return 0;\n}\n");
  write(dir, "src/outbox/index.ts", 'export { runOutboxDispatcherTick } from "./tick.js";\n');
  const before = commitAll(dir, "add dispatcher behind a barrel");

  const rows = findUnreachableExports(dir, before);
  assert.equal(rows.length, 1, "forwarding a symbol is not consuming it");
  assert.equal(rows[0]?.symbol, "runOutboxDispatcherTick");
});

test("pre-existing dead exports are not attributed to this tick", () => {
  const dir = initRepo();
  write(dir, "src/legacy.ts", "export function neverCalled() {\n  return 1;\n}\n");
  commitAll(dir, "legacy dead code");

  write(dir, "src/fresh.ts", 'import { seed } from "./existing.js";\n\nexport const total = seed + 1;\n');
  write(dir, "src/consumer.ts", 'import { total } from "./fresh.js";\nconsole.log(total);\n');
  const before = commitAll(dir, "new wired export");

  const rows = findUnreachableExports(dir, before);
  assert.deepEqual(
    rows.map((row) => row.symbol),
    [],
    "only symbols added by the audited range should be reported",
  );
});

test("changedSourceFiles skips test files and deletions", () => {
  const dir = initRepo();
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/a.test.ts", "export const spec = 1;\n");
  const before = commitAll(dir, "add source and test");

  assert.deepEqual(changedSourceFiles(dir, before), ["src/a.ts"]);
});

test("an export its own module consumes is not reported as unwired", () => {
  const dir = initRepo();
  write(
    dir,
    "src/geo.ts",
    [
      "export function deriveFacts(id: string) {",
      "  return { id };",
      "}",
      "",
      "export function applyFacts(id: string) {",
      "  return { ...deriveFacts(id), applied: true };",
      "}",
    ].join("\n"),
  );
  write(dir, "src/panel.ts", 'import { applyFacts } from "./geo.js";\napplyFacts("p1");\n');
  write(dir, "src/geo.test.ts", 'import { deriveFacts } from "./geo.js";\nderiveFacts("p1");\n');
  const before = commitAll(dir, "extract a wrapper and wire it");

  assert.deepEqual(
    findUnreachableExports(dir, before).map((row) => row.symbol),
    [],
    "wrapping a helper and wiring the wrapper is the fix the gate asks for, not a new violation",
  );
});

test("an internal helper chain in a module nobody imports is still dead", () => {
  const dir = initRepo();
  write(
    dir,
    "src/orphan.ts",
    [
      "export function inner(id: string) {",
      "  return { id };",
      "}",
      "",
      "export function outer(id: string) {",
      "  return inner(id);",
      "}",
    ].join("\n"),
  );
  write(dir, "src/orphan.test.ts", 'import { inner, outer } from "./orphan.js";\ninner("a");\nouter("b");\n');
  const before = commitAll(dir, "module with an internal chain and no importer");

  const flagged = findUnreachableExports(dir, before).map((row) => row.symbol).sort();
  assert.deepEqual(
    flagged,
    ["inner", "outer"],
    "internal calls must not rescue a module that no production file imports",
  );
});
