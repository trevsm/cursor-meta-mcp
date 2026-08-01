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
): GroundTruthAudit {
  const tickReport = parseTickReport(assistantTail);
  const claims = detectCompletionClaims(assistantTail);
  const violations: string[] = [];
  const fabrications: string[] = [];
  const missingTickReport = Boolean(outcome?.producedWork && !tickReport);

  if (missingTickReport) {
    violations.push("missing structured tick report footer");
  }
  if (claims.claimedTestsPass && (!outcome?.tests?.ran || !outcome.tests.passed)) {
    fabrications.push(`claimed testsPass but ${outcome?.tests?.command ?? "verification"} did not pass this tick`);
  }
  if (claims.claimedCommitted && !outcome?.committed) {
    fabrications.push("claimed commit but HEAD unchanged this tick");
  }
  if (claims.claimedPushed && !outcome?.pushed) {
    fabrications.push("claimed push but origin was not updated this tick");
  }
  if (claims.claimedDone) {
    if (!outcome) {
      fabrications.push("claimed completion but no tick outcome recorded");
    } else if (!outcome.producedWork) {
      fabrications.push("claimed completion but no repo change detected");
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
