import { execFileSync } from "node:child_process";

/**
 * Detects new runtime exports that nothing in production imports.
 *
 * The tick gate asks whether the repo changed and whether tests pass. Both are
 * true for a module that is complete, well tested, and wired to nothing — the
 * tests are its only callers. That is how a finished outbox dispatcher landed
 * with zero production callers while the outbox stayed write-only.
 *
 * Deliberately textual rather than AST-based: it runs every tick, needs no
 * compile, and the failure mode we care about (nobody imports this at all) does
 * not need type resolution to spot.
 */

export interface UnreachableExport {
  /** Repo-relative file that declares the symbol. */
  file: string;
  symbol: string;
  /** Non-test, non-re-export references found elsewhere in the repo. */
  productionRefs: number;
  testRefs: number;
  /**
   * `unwired` — tests exercise it, production never calls it. This is the
   * dead-module signature and it is worth blocking on.
   *
   * `unused` — nothing references it by name anywhere. Usually benign: a schema
   * composed in its own file, or a framework convention consumed reflectively
   * (drizzle `*Relations`). Reported, never blocking.
   */
  severity: "unwired" | "unused";
}

/** Runtime exports only — an unused type is a lint concern, not a wiring bug. */
const EXPORT_PATTERN =
  /^\s*export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;

const TEST_FILE = /(?:\.test\.[cm]?tsx?|\.spec\.[cm]?tsx?)$/;
const SOURCE_FILE = /\.[cm]?tsx?$/;

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8_000_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function isTestPath(path: string): boolean {
  return TEST_FILE.test(path) || /(^|\/)(tests?|__tests__|e2e)\//.test(path);
}

/** Files a tick added or modified, excluding deletions. */
export function changedSourceFiles(cwd: string, sinceRef: string): string[] {
  const raw = git(cwd, ["diff", "--name-only", "--diff-filter=AM", `${sinceRef}..HEAD`]);
  if (raw == null) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && SOURCE_FILE.test(line) && !isTestPath(line));
}

export function parseExportedSymbols(source: string): string[] {
  const names = new Set<string>();
  EXPORT_PATTERN.lastIndex = 0;
  let match = EXPORT_PATTERN.exec(source);
  while (match != null) {
    if (match[1]) names.add(match[1]);
    match = EXPORT_PATTERN.exec(source);
  }
  return [...names];
}

/**
 * A barrel re-export (`export * from "./x.js"`, `export { y } from "./x.js"`)
 * forwards a symbol without consuming it. Counting those as usage would mark
 * every dead export in a package with an index.ts as reachable.
 */
function isReExportLine(line: string): boolean {
  return /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+/.test(line);
}

/** True when any non-test file imports this module by path. */
function moduleHasProductionImporter(cwd: string, file: string): boolean {
  const stem = file.replace(/\.[cm]?tsx?$/, "").split("/").pop();
  if (!stem) return false;

  const raw = git(cwd, [
    "grep",
    "--fixed-strings",
    "--files-with-matches",
    `/${stem}`,
    "--",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
  ]);
  if (raw == null) return false;

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== file)
    .some((importer) => !isTestPath(importer));
}

/** True when the declaring module itself calls the symbol beyond declaring it. */
function usedWithinOwnFile(cwd: string, symbol: string, file: string): boolean {
  const raw = git(cwd, ["show", `HEAD:${file}`]);
  if (raw == null) return false;

  const declaration = new RegExp(
    `^\\s*export\\s+(?:async\\s+)?(?:function|const|class|let|var)\\s+${symbol}\\b`,
  );
  const usage = new RegExp(`\\b${symbol}\\b`);

  return raw
    .split("\n")
    .filter((line) => !declaration.test(line))
    .some((line) => usage.test(line));
}

function referencesOutside(
  cwd: string,
  symbol: string,
  declaringFile: string,
): { productionRefs: number; testRefs: number } {
  const raw = git(cwd, [
    "grep",
    "--fixed-strings",
    "--line-number",
    "--word-regexp",
    symbol,
    "--",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
  ]);
  if (raw == null) return { productionRefs: 0, testRefs: 0 };

  let productionRefs = 0;
  let testRefs = 0;

  for (const entry of raw.split("\n")) {
    if (!entry.trim()) continue;
    const firstColon = entry.indexOf(":");
    if (firstColon < 0) continue;
    const file = entry.slice(0, firstColon);
    if (file === declaringFile) continue;

    const secondColon = entry.indexOf(":", firstColon + 1);
    const text = secondColon >= 0 ? entry.slice(secondColon + 1) : "";
    if (isReExportLine(text)) continue;

    if (isTestPath(file)) testRefs += 1;
    else productionRefs += 1;
  }

  return { productionRefs, testRefs };
}

/**
 * Returns exports introduced since `sinceRef` that no production file imports.
 *
 * Only reports symbols the tick actually added, so pre-existing dead code in the
 * target repo is not the worker's problem.
 */
export function findUnreachableExports(
  cwd: string,
  sinceRef: string,
  limit = 25,
): UnreachableExport[] {
  const found: UnreachableExport[] = [];

  for (const file of changedSourceFiles(cwd, sinceRef)) {
    if (found.length >= limit) break;

    const added = git(cwd, ["diff", "--unified=0", `${sinceRef}..HEAD`, "--", file]);
    if (added == null) continue;

    const addedExports = parseExportedSymbols(
      added
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n"),
    );
    if (addedExports.length === 0) continue;

    for (const symbol of addedExports) {
      if (found.length >= limit) break;
      const refs = referencesOutside(cwd, symbol, file);
      // A symbol its own module consumes is reachable through whatever wraps it;
      // flagging it would fail the very refactor the gate is trying to provoke —
      // extract a wrapper, wire the wrapper, keep the helper exported for tests.
      // Same-file use only rescues a symbol if the module itself is reachable.
      // A helper chain inside a module nobody imports is still entirely dead.
      const internallyReachable =
        usedWithinOwnFile(cwd, symbol, file) && moduleHasProductionImporter(cwd, file);
      if (refs.productionRefs === 0 && !internallyReachable) {
        found.push({
          file,
          symbol,
          ...refs,
          severity: refs.testRefs > 0 ? "unwired" : "unused",
        });
      }
    }
  }

  return found;
}

/** Only the `unwired` rows — the ones worth failing a tick over. */
export function unwiredExports(rows: UnreachableExport[]): UnreachableExport[] {
  return rows.filter((row) => row.severity === "unwired");
}

export function describeUnreachableExports(rows: UnreachableExport[]): string[] {
  return rows.map(
    (row) =>
      `new export ${row.symbol} in ${row.file} is exercised by ${row.testRefs} test(s) but called by no production code — wire it up or remove it`,
  );
}
