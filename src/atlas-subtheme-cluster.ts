import { runAgentCliPrompt } from "./agent-cli.js";
import type { AtlasSegment } from "./atlas-index.js";

const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "then", "into", "over",
  "asked", "user", "tried", "after", "before", "about", "using", "via", "have",
  "were", "was", "are", "been", "being", "their", "there", "when", "what",
  "which", "while", "would", "could", "should", "also", "just", "only",
  "debugged", "started", "built", "fixed", "added", "updated", "reviewed",
]);

const SEGMENT_JSON_RE = /\[[\s\S]*\]/;

function rawTopic(seg: AtlasSegment): string {
  return (seg.subtheme || seg.preview || "Topic").trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "topic";
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function pickGroupLabel(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) {
    const key = label.toLowerCase().trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byFreq = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const frequent = labels.find((l) => l.toLowerCase().trim() === byFreq[0]?.[0]);
  if (frequent && frequent.length <= 56) return frequent;

  const short = [...labels].sort((a, b) => a.length - b.length);
  const candidate = short.find((l) => l.length >= 8 && l.length <= 56);
  if (candidate) return candidate;

  const words = labels
    .flatMap((l) => [...tokens(l)])
    .reduce((acc, w) => acc.set(w, (acc.get(w) ?? 0) + 1), new Map<string, number>());
  const top = [...words.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w);
  if (top.length) {
    return top
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
      .slice(0, 56);
  }
  return (short[0] ?? "Topic").slice(0, 56);
}

function targetClusterCount(n: number): number {
  if (n <= 4) return n;
  return Math.max(6, Math.min(24, Math.round(Math.sqrt(n) * 1.8)));
}

/** Deterministic merge of segment topics within a theme bucket. */
export function clusterSegmentsHeuristic(segments: AtlasSegment[]): Map<string, string> {
  const out = new Map<string, string>();
  if (segments.length === 0) return out;

  const topics = segments.map((seg) => rawTopic(seg));
  const tokenSets = topics.map((t) => tokens(t));
  const uf = new UnionFind(segments.length);

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const shared = [...tokenSets[i]!].filter((t) => tokenSets[j]!.has(t)).length;
      if (shared >= 2 || jaccard(tokenSets[i]!, tokenSets[j]!) >= 0.28) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const root = uf.find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }

  let clusters = [...groups.values()].map((indices) => ({
    indices,
    labels: indices.map((i) => topics[i]!),
  }));

  const maxClusters = targetClusterCount(segments.length);
  while (clusters.length > maxClusters) {
    let bestPair: [number, number, number] | null = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ta = tokens(clusters[i]!.labels.join(" "));
        const tb = tokens(clusters[j]!.labels.join(" "));
        const score = jaccard(ta, tb);
        if (!bestPair || score > bestPair[2]) bestPair = [i, j, score];
      }
    }
    if (!bestPair || bestPair[2] <= 0) break;
    const [i, j] = bestPair;
    clusters[i] = {
      indices: [...clusters[i]!.indices, ...clusters[j]!.indices],
      labels: [...clusters[i]!.labels, ...clusters[j]!.labels],
    };
    clusters.splice(j, 1);
  }

  for (const cluster of clusters) {
    const label = pickGroupLabel(cluster.labels);
    for (const idx of cluster.indices) {
      out.set(segments[idx]!.id, label);
    }
  }
  return out;
}

function parseClusterJson(text: string): Array<{ label: string; members: number[] }> {
  const match = text.match(SEGMENT_JSON_RE);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    const groups = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { groups?: unknown }).groups)
        ? (parsed as { groups: unknown[] }).groups
        : [];
    return groups
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const label = String(r.label ?? r.name ?? "").trim();
        const members = Array.isArray(r.members)
          ? r.members.map((m) => Number(m)).filter((n) => Number.isFinite(n))
          : Array.isArray(r.memberIndices)
            ? r.memberIndices.map((m) => Number(m)).filter((n) => Number.isFinite(n))
            : [];
        if (!label || members.length === 0) return null;
        return { label: label.slice(0, 56), members };
      })
      .filter((x): x is { label: string; members: number[] } => x !== null);
  } catch {
    return [];
  }
}

/** LLM pass to name and merge subtopics within one theme bucket. */
export async function clusterSegmentsWithLlm(args: {
  themeLabel: string;
  segments: AtlasSegment[];
  cwd: string;
  model?: string;
}): Promise<Map<string, string>> {
  const lines = args.segments.map((seg, i) => `${i}. ${rawTopic(seg).slice(0, 100)}`);
  const maxGroups = targetClusterCount(args.segments.length);
  const prompt = `You group chat segment topics under one theme into reusable subtopics.

Theme: ${args.themeLabel}
Target: ${maxGroups} groups or fewer (merge similar lines aggressively)

Return ONLY JSON:
{"groups":[{"label":"2-5 word reusable subtopic","members":[0,3,7]}]}

Rules:
- label: short, reusable across chats (e.g. "Formula scheduling", "PR review process") — NOT a sentence fragment
- members: 0-based indices from the list below; every index exactly once
- Merge lines about the same work even if wording differs

Topics:
${lines.join("\n")}`;

  try {
    const result = await runAgentCliPrompt({
      prompt,
      cwd: args.cwd,
      mode: "ask",
      model: args.model ?? "auto",
    });
    const groups = parseClusterJson(result.result);
    if (groups.length === 0) return clusterSegmentsHeuristic(args.segments);

    const out = new Map<string, string>();
    const assigned = new Set<number>();
    for (const group of groups) {
      for (const idx of group.members) {
        if (idx < 0 || idx >= args.segments.length || assigned.has(idx)) continue;
        assigned.add(idx);
        out.set(args.segments[idx]!.id, group.label);
      }
    }
    for (let i = 0; i < args.segments.length; i++) {
      if (!assigned.has(i)) out.set(args.segments[i]!.id, rawTopic(args.segments[i]!).slice(0, 56));
    }
    return out;
  } catch {
    return clusterSegmentsHeuristic(args.segments);
  }
}

export function applyGroupLabels(
  segments: AtlasSegment[],
  labels: Map<string, string>,
): AtlasSegment[] {
  return segments.map((seg) => ({
    ...seg,
    groupLabel: labels.get(seg.id) ?? seg.groupLabel ?? rawTopic(seg).slice(0, 56),
  }));
}

export function groupKey(label: string): string {
  return slugify(label);
}
