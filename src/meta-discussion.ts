const META_DISCUSSION =
  /\b(low level|high level|confused|what is this|what for|what'?s this all|honest assessment|mental model|autopilot|over-?engineered|self.?improve|strategy review|conversation strategy|no more moves|whatever you think|tactical adjustment|keep going|dont stop|don't stop|keep chugging)\b/i;

const STRATEGY_TITLE =
  /\b(strategy review|conversation alignment|conversation tracking|mental model|orchestrat|self.?improve|meta.?mcp)\b/i;

export function isMetaDiscussion(text: string): boolean {
  return META_DISCUSSION.test(text.trim());
}

export function isStrategySessionTitle(title: string): boolean {
  return STRATEGY_TITLE.test(title.trim());
}

export function isOrchestrationExempt(text: string, title = ""): boolean {
  return isMetaDiscussion(text) || isStrategySessionTitle(title);
}
