export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const extras: string[] = [];
    const anyErr = error as unknown as Record<string, unknown>;
    if (typeof anyErr.code === "string") extras.push(`code=${anyErr.code}`);
    if (typeof anyErr.status === "number") extras.push(`status=${anyErr.status}`);
    if (typeof anyErr.requestId === "string") extras.push(`requestId=${anyErr.requestId}`);
    if (typeof anyErr.helpUrl === "string") extras.push(`helpUrl=${anyErr.helpUrl}`);
    return extras.length > 0 ? `${error.message} (${extras.join(", ")})` : error.message;
  }
  return String(error);
}

export function assertLocalAgentId(agentId: string): void {
  if (agentId.startsWith("bc-")) {
    throw new Error(
      "Cloud agent IDs (bc-*) are not supported. This server is local-only.",
    );
  }
}
