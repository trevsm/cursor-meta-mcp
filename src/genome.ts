import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { metaHome } from "./meta-home.js";

export const DEFAULT_GENOME = [
  "# Fleet operating constitution",
  "",
  "Each tick:",
  "1. One small verified improvement only — minimize scope.",
  "2. Run `npm run test:fast` on touched areas before claiming success.",
  "3. Git commit verified slices; push batches only (see batch policy below).",
  "4. End with a structured tick report (JSON footer) — prose claims are ignored.",
  "5. No architecture theater, meta-discussion, or user questions.",
  "",
  "Product vs meta: prefer src/, dashboard/, docs/ over tests-only diffs.",
  "Test-only ticks count at most 1 per 3 feature ticks (mechanical cap).",
  "",
  "Design (Ousterhout, A Philosophy of Software Design) — complexity is the enemy:",
  "- Make modules deep: a small interface over real functionality. A module whose",
  "  interface is nearly as large as its implementation has earned nothing.",
  "- Extend the abstraction that already exists instead of adding a second one",
  "  beside it. Two ways to do the same thing is the cost, forever.",
  "- Export the smallest surface that works. If only this file needs it, keep it",
  "  in this file.",
  "- A function that only forwards its arguments to another one is a layer that",
  "  should not exist. Different layer, different abstraction.",
  "- Define errors out of existence where the design allows; where it does not,",
  "  handle them in one place rather than at every call site.",
  "- Comments carry what the code cannot: why this shape, what breaks otherwise.",
  "  Never restate the line below them.",
  "",
  "Do not scale parallelism until ≥30% of recent ticks show real repo changes.",
].join("\n");

export function genomePath(metaDir?: string): string {
  return join(metaDir ?? metaHome(), "world", "genome.md");
}

export function readGenome(metaDir?: string): string {
  const path = genomePath(metaDir);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

export function ensureGenome(metaDir?: string): void {
  const path = genomePath(metaDir);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${DEFAULT_GENOME}\n`);
}

export function formatGenomeForPrompt(metaDir?: string): string {
  const body = readGenome(metaDir) || DEFAULT_GENOME;
  return ["Operating constitution (follow every tick):", body, ""].join("\n");
}
