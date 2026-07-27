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

export function appendLearning(lesson: string, metaDir?: string): boolean {
  const trimmed = lesson.trim();
  if (!trimmed) return false;
  const path = learningsPath(metaDir);
  if (existsSync(path) && readFileSync(path, "utf8").includes(trimmed)) return false;
  mkdirSync(dirname(path), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path, `- [${stamp}] ${trimmed}\n`, { flag: "a" });
  return true;
}

export function lessonFromGroundTruth(audit: GroundTruthAudit): string | null {
  if (audit.violations.length === 0) return null;
  return `Never claim success without ground truth: ${audit.violations.join("; ")}`;
}

export function lessonFromTestFailure(outcome: TickOutcome): string | null {
  if (!outcome.tests || outcome.tests.passed) return null;
  return `test:fast failed (${outcome.tests.failed ?? "?"} failing) — fix before claiming done`;
}

export function lessonFromTickError(error: string | undefined): string | null {
  const msg = error?.trim();
  if (!msg) return null;
  if (/no auth available|CURSOR_API_KEY is not set/i.test(msg)) {
    return "Preflight SDK auth before fleet launch — set CURSOR_API_KEY in ~/.cursor/.env or run ~/.local/bin/agent login";
  }
  if (/better-sqlite3|NODE_MODULE_VERSION/i.test(msg)) {
    return "Run fleet and pulse on Node 22 — npm rebuild better-sqlite3 if ABI mismatches";
  }
  if (/timed out waiting for chat/i.test(msg)) {
    return "Chat idle wait timed out — reduce tick scope or increase waitTimeoutMs";
  }
  if (
    /\/bin\/sh:.*command not found|syntax error near unexpected token|Passing args to a child process with shell option true/i.test(
      msg,
    )
  ) {
    return "Never spawn Agent CLI with shell:true — prompts with ;/`()` are executed by sh; pass argv without a shell";
  }
  return `Tick infra failure: ${msg.slice(0, 200)}`;
}

/** Record durable lessons from verified tick failures. */
export function recordTickLesson(params: {
  audit?: GroundTruthAudit;
  outcome?: TickOutcome;
  error?: string;
  metaDir?: string;
}): string | null {
  const fromTruth = params.audit ? lessonFromGroundTruth(params.audit) : null;
  const fromTests = params.outcome ? lessonFromTestFailure(params.outcome) : null;
  const fromError = params.error ? lessonFromTickError(params.error) : null;
  const lesson = fromTruth ?? fromTests ?? fromError;
  if (!lesson) return null;
  if (!appendLearning(lesson, params.metaDir)) return null;
  return lesson;
}
