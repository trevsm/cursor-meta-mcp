/** Canonical theme buckets — segments map here for cross-chat grouping */
export const THEME_BUCKETS = [
  {
    id: "faciliq-relate",
    label: "Faciliq & Relate",
    summary: "Formulas, deploys, MyPlace audits, incident reports, bluestep wiring",
    keywords: [
      "yardi", "formula", "populate", "audit", "incident", "bluestep", "myplace",
      "relate apps", "faciliq", "endpoint", "financial", "schedule", "notification",
      "harness", "missing items", "nested folder", "analytics", "sentry",
    ],
    workspaceHints: ["faciliq", "relate", "yardi", "bluestep", "myplace"],
  },
  {
    id: "cursor-tooling",
    label: "Cursor & MCP tooling",
    summary: "Conversation atlas, MCP, chat search, sentiment, wayfinder, indexing",
    keywords: [
      "cursor", "atlas", "wayfinder", "mcp", "sentiment", "conversation",
      "indexing", "segmentation", "usage limit", "auth", "prototype", "visual nav",
      "frustration", "roberta", "chat tooling",
    ],
    workspaceHints: ["cursor-meta", "orchestration"],
  },
  {
    id: "research",
    label: "Research & ideas",
    summary: "Exploration, consciousness, architecture, wayfinding maps",
    keywords: [
      "consciousness", "research", "iteration", "trade-off", "deep learning",
      "theory", "map charting", "scoping",
    ],
    workspaceHints: ["micro-consciousness", "research"],
  },
  {
    id: "personal",
    label: "Personal & setup",
    summary: "Mac apps, skills, side projects, creative experiments",
    keywords: [
      "hostblock", "host block", "skill", "prototype skill", "installation",
      "chiptune", "whistle", "audio", "sound", "game", "fx", "balloon", "magma",
    ],
    workspaceHints: ["plummet", "hostblock"],
  },
  {
    id: "other",
    label: "Other",
    summary: "Threads not yet bucketed — will improve with more indexing",
    keywords: [],
    workspaceHints: [],
  },
] as const;

export interface BucketContext {
  workspace?: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordScore(hay: string, keywords: readonly string[]): number {
  let score = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (re.test(hay)) score += 1;
  }
  return score;
}

function workspaceMatchesHints(workspace: string, hints: readonly string[]): boolean {
  const hay = workspace.toLowerCase();
  return hints.some((hint) => hay.includes(hint));
}

export function bucketForText(
  text: string,
  ctx: BucketContext = {},
): (typeof THEME_BUCKETS)[number] | null {
  const hay = text.toLowerCase();
  const workspace = ctx.workspace?.toLowerCase() ?? "";
  let best: { bucket: (typeof THEME_BUCKETS)[number]; score: number } | null = null;

  for (const bucket of THEME_BUCKETS) {
    if (bucket.id === "other") continue;
    if (
      bucket.id === "faciliq-relate" &&
      workspace &&
      !workspaceMatchesHints(workspace, bucket.workspaceHints)
    ) {
      continue;
    }
    const score = keywordScore(hay, bucket.keywords);
    if (score > 0 && (!best || score > best.score)) best = { bucket, score };
  }

  if (best) return best.bucket;

  if (workspace) {
    for (const bucket of THEME_BUCKETS) {
      if (bucket.id === "other") continue;
      if (workspaceMatchesHints(workspace, bucket.workspaceHints)) return bucket;
    }
  }

  return null;
}
