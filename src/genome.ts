import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { metaHome } from "./meta-home.js";

export const DEFAULT_GENOME = [
  "# Fleet operating constitution",
  "",
  "Each tick:",
  "1. One small verified improvement only — minimize scope.",
  "2. Run `npm run test:fast` on touched areas before claiming success.",
  "3. Git commit verified work; push when ahead of origin.",
  "4. End with a structured tick report (JSON footer) — prose claims are ignored.",
  "5. No architecture theater, meta-discussion, or user questions.",
  "",
  "Product vs meta: prefer src/, dashboard/, docs/ over tests-only diffs.",
  "Test-only ticks count at most 1 per 3 feature ticks (mechanical cap).",
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
