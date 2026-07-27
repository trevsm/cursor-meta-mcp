import type { TickOutcome } from "./tick-outcome.js";

export interface CompletionClaims {
  claimedDone: boolean;
  claimedTestsPass: boolean;
  claimedCommitted: boolean;
}

export interface GroundTruthAudit extends CompletionClaims {
  violations: string[];
  /** True when assistant claims outran verified repo/test state. */
  blocked: boolean;
  correctionPrompt?: string;
}

const DONE_CLAIM =
  /\b(all done|finished|complete|ready to merge|should work now|this is done|task complete)\b/i;
const TESTS_PASS_CLAIM =
  /\b(tests pass(?:ed)?|all tests pass|npm test pass(?:ed)?|test suite pass(?:es|ed)?|tests are passing)\b/i;
const COMMIT_CLAIM = /\b(committed|git commit|pushed to origin|git push(?:ed)?)\b/i;

/** Extract completion claims from the assistant tail of a tick. */
export function detectCompletionClaims(text: string | undefined): CompletionClaims {
  const tail = text?.trim() ?? "";
  return {
    claimedDone: DONE_CLAIM.test(tail),
    claimedTestsPass: TESTS_PASS_CLAIM.test(tail),
    claimedCommitted: COMMIT_CLAIM.test(tail),
  };
}

/**
 * Compare assistant claims against measured tick outcome (git + test:fast).
 * Inspired by Groundtruth-style Stop hooks — deterministic, no LLM judge.
 */
export function auditGroundTruth(
  assistantTail: string | undefined,
  outcome: TickOutcome | undefined,
): GroundTruthAudit {
  const claims = detectCompletionClaims(assistantTail);
  const violations: string[] = [];

  if (claims.claimedTestsPass && (!outcome?.tests?.ran || !outcome.tests.passed)) {
    violations.push("claimed tests pass but test:fast did not pass this tick");
  }
  if (claims.claimedCommitted && !outcome?.committed) {
    violations.push("claimed commit but HEAD unchanged this tick");
  }
  if ((claims.claimedDone || claims.claimedTestsPass) && outcome && !outcome.producedWork) {
    violations.push("claimed completion but no repo change detected");
  }

  const blocked = violations.length > 0;
  const correctionPrompt = blocked
    ? [
        "[Ground-truth gate] Your last message claimed success but verification failed:",
        ...violations.map((v) => `- ${v}`),
        "Run npm run test:fast on your changes, fix failures, commit verified work, then report honestly.",
      ].join("\n")
    : undefined;

  return { ...claims, violations, blocked, correctionPrompt };
}
