import type { TickOutcome } from "./tick-outcome.js";

/** Structured footer workers append at the end of every tick. */
export interface TickReport {
  done?: boolean;
  testsPass?: boolean;
  committed?: boolean;
  pushed?: boolean;
}

export interface CompletionClaims {
  claimedDone: boolean;
  claimedTestsPass: boolean;
  claimedCommitted: boolean;
  claimedPushed: boolean;
}

export interface GroundTruthAudit extends CompletionClaims {
  violations: string[];
  /** True when assistant claims outran verified repo/test state. */
  blocked: boolean;
  correctionPrompt?: string;
  /** Parsed tick report when present. */
  tickReport?: TickReport;
  /** True when produced work but no parseable tick report footer. */
  missingTickReport?: boolean;
  /**
   * True only when a claim contradicts measured state (claimed X, git/tests say
   * not-X). A missing footer on verified work blocks the next prompt but is not
   * fabrication — measured git+test outcomes outrank footer compliance.
   */
  fabrication?: boolean;
}

/**
 * Session facts the per-tick outcome cannot express.
 *
 * A tick diff answers "what changed just now"; some claims are about the
 * mission as a whole. Without this the gate reads every clean tick on finished
 * work as a lie.
 */
export interface GroundTruthContext {
  /** True when an earlier tick in this worker session produced verified work. */
  priorWorkInSession?: boolean;
}

export const TICK_REPORT_LABEL = "Tick report:";

const TICK_REPORT_LINE = /^\s*tick\s+report\s*:/i;

/** Extract JSON tick report from assistant tail. Prose claims are ignored. */
export function parseTickReport(text: string | undefined): TickReport | null {
  const tail = text?.trim() ?? "";
  if (!tail) return null;

  const lines = tail.split(/\r?\n/);
  let jsonStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (TICK_REPORT_LINE.test(lines[i]!.trim())) {
      jsonStart = i;
      break;
    }
  }
  if (jsonStart < 0) return null;

  const payload = lines
    .slice(jsonStart)
    .join("\n")
    .replace(TICK_REPORT_LINE, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const brace = payload.indexOf("{");
  if (brace < 0) return null;
  const candidate = payload.slice(brace);
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      done: parsed.done === true,
      testsPass: parsed.testsPass === true,
      committed: parsed.committed === true,
      pushed: parsed.pushed === true,
    };
  } catch {
    return null;
  }
}

/** Map structured tick report fields to completion claims. */
export function detectCompletionClaims(text: string | undefined): CompletionClaims {
  const report = parseTickReport(text);
  if (!report) {
    return {
      claimedDone: false,
      claimedTestsPass: false,
      claimedCommitted: false,
      claimedPushed: false,
    };
  }
  return {
    claimedDone: report.done === true,
    claimedTestsPass: report.testsPass === true,
    claimedCommitted: report.committed === true,
    claimedPushed: report.pushed === true,
  };
}

export function formatTickReportFooter(report: TickReport): string {
  return `${TICK_REPORT_LABEL}\n${JSON.stringify(report)}`;
}

export const TICK_REPORT_INSTRUCTION = [
  "End every tick with a structured report (required):",
  `${TICK_REPORT_LABEL}`,
  '{"done":false,"testsPass":true,"committed":true,"pushed":false}',
  "Set booleans from verified git + npm run test:fast this tick only. Prose claims are ignored.",
].join("\n");

/**
 * Compare structured tick report against measured tick outcome (git + test:fast).
 * Missing or unparseable reports block ticks that produced repo changes.
 */
export function auditGroundTruth(
  assistantTail: string | undefined,
  outcome: TickOutcome | undefined,
  context?: GroundTruthContext,
): GroundTruthAudit {
  const tickReport = parseTickReport(assistantTail);
  const claims = detectCompletionClaims(assistantTail);
  const violations: string[] = [];
  const fabrications: string[] = [];
  const missingTickReport = Boolean(outcome?.producedWork && !tickReport);

  if (missingTickReport) {
    violations.push("missing structured tick report footer");
  }
  // Verification only runs on ticks that touched the repo, so a clean tick has
  // no measurement to contradict — "we did not look" is not "the worker lied".
  // Auditing it as fabrication is what burned 5 of 6 ticks for a worker whose
  // mission was already complete and correctly reported as such.
  if (claims.claimedTestsPass && outcome?.tests?.ran === true && !outcome.tests.passed) {
    fabrications.push(`claimed testsPass but ${outcome.tests.command ?? "verification"} did not pass this tick`);
  }
  if (claims.claimedCommitted && !outcome?.committed && context?.priorWorkInSession !== true) {
    fabrications.push("claimed commit but HEAD unchanged this tick");
  }
  // Only audit push claims we can actually measure. A branch with no upstream —
  // which is every fleet worktree — leaves `pushed` false whether or not the
  // worker pushed, so auditing it here brands honest workers as fabricators,
  // zeroes the tick, and writes the false lesson into learnings.md where it is
  // replayed into every later run.
  if (claims.claimedPushed && !outcome?.pushed && outcome?.pushMeasurable !== false) {
    fabrications.push("claimed push but origin was not updated this tick");
  }
  // `done` describes the mission, not the tick. A worker that shipped the work
  // on an earlier tick — or on an earlier run, then resumed — is telling the
  // truth when it reports done on a clean tree. Only call it fabrication when
  // nothing has been produced at any point in the session.
  if (claims.claimedDone) {
    if (!outcome) {
      fabrications.push("claimed completion but no tick outcome recorded");
    } else if (!outcome.producedWork && context?.priorWorkInSession !== true) {
      fabrications.push("claimed completion but no repo change detected in this session");
    }
  }

  violations.push(...fabrications);
  const fabrication = fabrications.length > 0;
  const blocked = violations.length > 0;
  const correctionPrompt = blocked
    ? [
        "[Ground-truth gate] Verification failed:",
        ...violations.map((v) => `- ${v}`),
        TICK_REPORT_INSTRUCTION,
        "Run verification, commit verified work, then resubmit an honest tick report.",
      ].join("\n")
    : undefined;

  return {
    ...claims,
    violations,
    blocked,
    correctionPrompt,
    tickReport: tickReport ?? undefined,
    missingTickReport,
    fabrication,
  };
}
