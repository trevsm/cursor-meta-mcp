const META_DISCUSSION =
  /\b(low level|high level|confused|what is this|what for|what'?s this all|honest assessment|mental model|autopilot|over-?engineered|self.?improve|strategy review|conversation strategy|no more moves|whatever you think|tactical adjustment|keep going|dont stop|don't stop|keep chugging|stay autonomous|no user moves)\b/i;

const STRATEGY_TITLE =
  /\b(strategy review|conversation alignment|conversation tracking|mental model|orchestrat|self.?improve|meta.?mcp|long.?session|autonomous worker|conductor)\b/i;

const TERSE_REJECTION = /^(no|nope|wrong|bad)\.?$/i;
const TERSE_STILL = /^still\.?$/i;
const REPEATED_FAILURE =
  /\b(same error|same (bug|issue|problem)|keeps? (failing|breaking)|again\.?$|still (seeing|getting) the same)\b/i;
const LOOP_FRUSTRATION =
  /\b(going in circles|keep(?:s|ing)? (?:trying|failing|breaking)|we're looping|this is looping|tried that already)\b/i;

export function isMetaDiscussion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return META_DISCUSSION.test(trimmed);
}

export function isStrategySessionTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  return STRATEGY_TITLE.test(trimmed);
}

export function isOrchestrationExempt(text: string, title = ""): boolean {
  return isMetaDiscussion(text) || isStrategySessionTitle(title);
}

export function isTerseStill(text: string): boolean {
  return TERSE_STILL.test(text.trim());
}

export function isTerseRejection(text: string): boolean {
  return TERSE_REJECTION.test(text.trim());
}

export function isRepeatedFailureLoop(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return REPEATED_FAILURE.test(trimmed) || LOOP_FRUSTRATION.test(trimmed);
}
