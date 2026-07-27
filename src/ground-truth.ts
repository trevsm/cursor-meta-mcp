import type { TickOutcome } from "./tick-outcome.js";

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
}

const DONE_CLAIM =
  /\b(?:all done|task (?:is )?complete|ready to merge|this is done|work is finished)(?!\s+(?:once|when|if|after|until|before|for)\b)|should work now(?! that)|(?<!\b(?:almost|nearly|still) )finished(?:\.|!|$)/i;
const TESTS_PASS_CLAIM =
  /(?<!\bnot )(?<!\bno )(?<!\bhaven'?t )(?<!\bdidn'?t )(?<!\bnever claim )(?<!\bwithout (?:claiming )?)(?<!\bdo not say )(?<!\bthat )(?<!\bonce )(?<!\bwhen )(?<!\bif )(?<!\bafter )(?<!\buntil )(?<!\bbefore )(?<!\bensure )(?<!\bmake )(?<!\bneed )(?<!\bhelp )\b(?:all tests pass(?:ed)?(?!\s+in\b)|(?<!\ball )tests pass(?:ed)?(?!\s+in\b)|npm (?:run )?test(?::fast)? pass(?:ed)?|test suite pass(?:es|ed)?|tests are passing(?!\s+in\b))\b/i;
const COMMIT_CLAIM =
  /(?<!\bnot )(?<!\bno )(?<!\bhaven'?t )(?<!\bdidn'?t )(?<!\bnever claim )(?<!\bwithout )(?<!\bdo not say )(?<!\bonce )(?<!\bwhen )(?<!\bif )(?<!\bafter )(?<!\buntil )(?<!\bbefore )(?<!\balready )(?<!\bpreviously )(?<!\bwas )(?<!\bhave )\bcommitted(?!\s+(?:earlier|locally|already|yesterday)\b)\b/i;
const PUSH_CLAIM =
  /(?<!\bnot )(?<!\bno )(?<!\bhaven'?t )(?<!\bdidn'?t )(?<!\bnever claim )(?<!\bwithout )(?<!\bdo not say )(?<!\bonce )(?<!\bwhen )(?<!\bif )(?<!\bafter )(?<!\buntil )(?<!\bbefore )(?<!\balready )(?<!\bpreviously )\b(?:pushed to origin|pushed(?!\s+earlier\b))\b/i;

/** Extract completion claims from the assistant tail of a tick. */
export function detectCompletionClaims(text: string | undefined): CompletionClaims {
  const tail = text?.trim() ?? "";
  return {
    claimedDone: DONE_CLAIM.test(tail),
    claimedTestsPass: TESTS_PASS_CLAIM.test(tail),
    claimedCommitted: COMMIT_CLAIM.test(tail),
    claimedPushed: PUSH_CLAIM.test(tail),
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
  if (claims.claimedPushed && !outcome?.pushed) {
    violations.push("claimed push but origin was not updated this tick");
  }
  if (claims.claimedDone) {
    if (!outcome) {
      violations.push("claimed completion but no tick outcome recorded");
    } else if (!outcome.producedWork) {
      violations.push("claimed completion but no repo change detected");
    }
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
