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
  // Flatten multi-line dumps so compact never sees undated continuation rows.
  const trimmed = lesson.replace(/\s+/g, " ").trim();
  if (!trimmed) return false;
  const path = learningsPath(metaDir);
  if (existsSync(path) && readFileSync(path, "utf8").includes(trimmed)) return false;
  mkdirSync(dirname(path), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path, `- [${stamp}] ${trimmed}\n`, { flag: "a" });
  return true;
}

function learningBody(line: string): string {
  return line.replace(/^- \[\d{4}-\d{2}-\d{2}\]\s*/, "").trim();
}

/**
 * Drop raw "Tick infra failure:" dumps once a classified lesson covers the same class,
 * drop orphaned continuation fragments from multi-line dumps, and dedupe identical bodies.
 */
export function compactLearnings(metaDir?: string): number {
  const path = learningsPath(metaDir);
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return 0;

  const bodies = lines.map(learningBody);
  const hasShellLesson = bodies.some((body) => /shell:true/i.test(body));
  const hasTransportLesson = bodies.some((body) => /transport dropped/i.test(body));
  const hasAgentMissingLesson = bodies.some((body) =>
    /ENOENT means the binary is missing|Install Cursor Agent CLI/i.test(body),
  );

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    // Multi-line infra dumps leave undated continuation rows — drop them.
    if (!/^- \[\d{4}-\d{2}-\d{2}\]\s/.test(line)) continue;

    const body = learningBody(line);
    if (
      hasShellLesson &&
      !/shell:true/i.test(body) &&
      /\/bin\/sh:|syntax error near unexpected token|Operating constitution/i.test(body)
    ) {
      continue;
    }
    if (
      hasTransportLesson &&
      !/transport dropped/i.test(body) &&
      (/connection lost|reconnect(?:ing|ed)? to https?:\/\/agent|^Retry attem/i.test(body))
    ) {
      continue;
    }
    if (
      hasAgentMissingLesson &&
      !/ENOENT means the binary is missing|Install Cursor Agent CLI/i.test(body) &&
      /spawn .+ ENOENT|Agent CLI not installed/i.test(body)
    ) {
      continue;
    }
    const key = body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }

  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  writeFileSync(path, `${kept.join("\n")}\n`);
  return removed;
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
  if (/connection lost|reconnect(?:ing|ed)? to https?:\/\/agent/i.test(msg)) {
    return "Agent transport dropped mid-tick — retry once; if persistent, check network or fall back to IDE worker";
  }
  if (/spawn .+ ENOENT|Agent CLI not installed|ENOENT.*\.local\/bin\/agent/i.test(msg)) {
    return "Install Cursor Agent CLI at ~/.local/bin/agent before CLI fleet workers — ENOENT means the binary is missing";
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
  if (!appendLearning(lesson, params.metaDir)) {
    compactLearnings(params.metaDir);
    return null;
  }
  compactLearnings(params.metaDir);
  return lesson;
}
