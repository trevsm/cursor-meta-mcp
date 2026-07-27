import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GroundTruthAudit } from "./ground-truth.js";
import { metaHome } from "./meta-home.js";
import type { TickOutcome } from "./tick-outcome.js";

export function learningsPath(metaDir?: string): string {
  return join(metaDir ?? metaHome(), "world", "learnings.md");
}

export function readLearnings(metaDir?: string, maxLines = 40): string {
  const path = learningsPath(metaDir);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines)
    .join("\n");
}

export function formatLearningsForPrompt(metaDir?: string): string {
  const body = readLearnings(metaDir);
  if (!body) return "";
  return ["Prior lessons (follow on every tick):", body, ""].join("\n");
}

export function appendLearning(lesson: string, metaDir?: string): void {
  const trimmed = lesson.trim();
  if (!trimmed) return;
  const path = learningsPath(metaDir);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path, `- [${stamp}] ${trimmed}\n`, { flag: "a" });
}

export function lessonFromGroundTruth(audit: GroundTruthAudit): string | null {
  if (audit.violations.length === 0) return null;
  return `Never claim success without ground truth: ${audit.violations.join("; ")}`;
}

export function lessonFromTestFailure(outcome: TickOutcome): string | null {
  if (!outcome.tests || outcome.tests.passed) return null;
  return `test:fast failed (${outcome.tests.failed ?? "?"} failing) — fix before claiming done`;
}

/** Record durable lessons from verified tick failures. */
export function recordTickLesson(params: {
  audit?: GroundTruthAudit;
  outcome?: TickOutcome;
  metaDir?: string;
}): string | null {
  const fromTruth = params.audit ? lessonFromGroundTruth(params.audit) : null;
  const fromTests = params.outcome ? lessonFromTestFailure(params.outcome) : null;
  const lesson = fromTruth ?? fromTests;
  if (!lesson) return null;
  appendLearning(lesson, params.metaDir);
  return lesson;
}
