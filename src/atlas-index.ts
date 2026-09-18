import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { metaPath } from "./meta-home.js";
import { llmSegments, heuristicSegments, themeIdFromLabel } from "./atlas-segment.js";
import type { ParsedSegment } from "./atlas-segment.js";
import { bucketForText, THEME_BUCKETS } from "./atlas-themes.js";
import { clusterSegmentsHeuristic, applyGroupLabels } from "./atlas-subtheme-cluster.js";
import { loadChatTurns } from "./chat-turns.js";
import { listChatSummaries, type ChatSummary } from "./history-store.js";

export interface AtlasTheme {
  id: string;
  label: string;
  color: string;
  description: string;
}

export interface AtlasSession {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  themeIds: string[];
}

export interface AtlasSegment {
  id: string;
  sessionId: string;
  themeId: string;
  themeLabel: string;
  /** LLM-specific subtopic before consolidation */
  subtheme?: string;
  /** Clustered subtopic label for navigation */
  groupLabel?: string;
  turnStart: number;
  turnEnd: number;
  preview: string;
}

export interface AtlasIndex {
  generatedAt: string;
  source: "llm" | "heuristic" | "mixed";
  themes: AtlasTheme[];
  sessions: AtlasSession[];
  segments: AtlasSegment[];
}

const THEME_COLORS = [
  "#6366f1",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#ef4444",
  "#14b8a6",
  "#a855f7",
  "#f97316",
];

function indexPath(): string {
  return metaPath("atlas", "index.json");
}

function shouldSkipSession(session: Pick<ChatSummary, "id" | "title">, skipEmpty: boolean): boolean {
  if (!skipEmpty) return false;
  if (session.title === "(untitled)" || !session.title.trim()) return true;
  const { turns } = loadChatTurns({
    sessionId: session.id,
    limit: 1,
    includeThoughts: false,
    includeTimeline: false,
  });
  return turns.length === 0;
}

function pruneEmptySessions(index: AtlasIndex): AtlasIndex {
  const kept = index.sessions.filter((s) => !shouldSkipSession(s, true));
  const keptIds = new Set(kept.map((s) => s.id));
  const segments = index.segments.filter((s) => keptIds.has(s.sessionId));
  return normalizeAtlasIndex({ ...index, sessions: kept, segments });
}

function colorForTheme(themeId: string, assigned: Map<string, string>): string {
  const existing = assigned.get(themeId);
  if (existing) return existing;
  let hash = 0;
  for (let i = 0; i < themeId.length; i++) hash = (hash * 31 + themeId.charCodeAt(i)) >>> 0;
  const color = THEME_COLORS[hash % THEME_COLORS.length]!;
  assigned.set(themeId, color);
  return color;
}

function workspaceShort(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function segmentsToAtlas(segments: ParsedSegment[], session: ChatSummary): AtlasSegment[] {
  return segments.map((s) => ({
    id: s.id,
    sessionId: session.id,
    themeId: s.themeId,
    themeLabel: s.themeLabel,
    turnStart: s.turnStart,
    turnEnd: s.turnEnd,
    preview: s.preview || s.themeLabel,
  }));
}

function consolidateSegments(
  segments: AtlasSegment[],
  workspaceBySession: Map<string, string> = new Map(),
): AtlasSegment[] {
  const canonicalLabels = new Set<string>(THEME_BUCKETS.map((b) => b.label));
  return segments.map((seg) => {
    const workspace = workspaceBySession.get(seg.sessionId) ?? "";
    const rawLabel = seg.subtheme ?? seg.themeLabel;
    const labelLooksCanonical = canonicalLabels.has(rawLabel);
    const textForBucket = labelLooksCanonical ? seg.preview : `${rawLabel} ${seg.preview}`;
    const bucket =
      bucketForText(textForBucket, { workspace }) ??
      (!labelLooksCanonical ? bucketForText(rawLabel, { workspace }) : null);
    if (!bucket) {
      return {
        ...seg,
        themeId: "other",
        themeLabel: "Other",
        subtheme: subthemeFromSegment(rawLabel, seg.preview, labelLooksCanonical),
      };
    }
    return {
      ...seg,
      themeId: bucket.id,
      themeLabel: bucket.label,
      subtheme: subthemeFromSegment(rawLabel, seg.preview, labelLooksCanonical),
    };
  });
}

function subthemeFromSegment(rawLabel: string, preview: string, labelLooksCanonical: boolean): string {
  if (!labelLooksCanonical && rawLabel.trim()) return rawLabel.trim();
  const clause = preview.split(/[.;!?]/)[0]?.trim() ?? preview.trim();
  return clause.slice(0, 64) || rawLabel.trim() || "Topic";
}

function buildThemes(segments: AtlasSegment[]): AtlasTheme[] {
  const byId = new Map<string, { label: string; previews: string[]; summary?: string }>();
  for (const seg of segments) {
    const cur = byId.get(seg.themeId) ?? {
      label: seg.themeLabel,
      previews: [],
      summary: THEME_BUCKETS.find((b) => b.id === seg.themeId)?.summary,
    };
    cur.previews.push(seg.preview);
    byId.set(seg.themeId, cur);
  }
  const colors = new Map<string, string>();
  return [...byId.entries()].map(([id, meta]) => ({
    id,
    label: meta.label,
    color: colorForTheme(id, colors),
    description: meta.summary ?? meta.previews[0]?.slice(0, 120) ?? "",
  }));
}

function rebuildSessionThemes(sessions: AtlasSession[], segments: AtlasSegment[]): AtlasSession[] {
  const themeIdsBySession = new Map<string, Set<string>>();
  for (const seg of segments) {
    const set = themeIdsBySession.get(seg.sessionId) ?? new Set();
    set.add(seg.themeId);
    themeIdsBySession.set(seg.sessionId, set);
  }
  return sessions.map((s) => ({
    ...s,
    themeIds: [...(themeIdsBySession.get(s.id) ?? [])],
  }));
}

function assignGroupLabels(segments: AtlasSegment[]): AtlasSegment[] {
  const byTheme = new Map<string, AtlasSegment[]>();
  for (const seg of segments) {
    const list = byTheme.get(seg.themeId) ?? [];
    list.push(seg);
    byTheme.set(seg.themeId, list);
  }
  let out = segments;
  for (const themeSegs of byTheme.values()) {
    const unlabeled = themeSegs.filter((s) => !s.groupLabel);
    if (unlabeled.length === 0) continue;
    const labels = clusterSegmentsHeuristic(unlabeled);
    out = applyGroupLabels(out, labels);
  }
  return out;
}

function segmentGroupLabel(seg: AtlasSegment): string {
  return (seg.groupLabel || seg.subtheme || seg.preview || "Topic").trim();
}

function mergeAdjacentSegments(segments: AtlasSegment[]): AtlasSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.turnStart - b.turnStart);
  const out: AtlasSegment[] = [];
  let cur = { ...sorted[0]! };
  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const sameGroup =
      seg.themeId === cur.themeId && segmentGroupLabel(seg) === segmentGroupLabel(cur);
    if (sameGroup && seg.turnStart <= cur.turnEnd + 1) {
      cur.turnEnd = Math.max(cur.turnEnd, seg.turnEnd);
      if ((seg.preview?.length ?? 0) > (cur.preview?.length ?? 0)) cur.preview = seg.preview;
    } else {
      out.push(cur);
      cur = { ...seg };
    }
  }
  out.push(cur);
  return out;
}

function extendSegmentCoverage(segments: AtlasSegment[], maxTurn: number): AtlasSegment[] {
  if (!segments.length || maxTurn <= 0) return segments;
  const sorted = [...segments].sort((a, b) => a.turnStart - b.turnStart);
  const last = sorted[sorted.length - 1]!;
  if (last.turnEnd < maxTurn) {
    last.turnEnd = maxTurn;
  }
  return sorted;
}

/** Index segments when cached; otherwise quick heuristic segmentation for live/unindexed chats. */
export function getSessionSegments(sessionId: string, index: AtlasIndex | null): AtlasSegment[] {
  const fromIndex = index?.segments.filter((s) => s.sessionId === sessionId) ?? [];
  if (fromIndex.length > 0) return fromIndex;

  const summary = listChatSummaries({ limit: 500, offset: 0 }).sessions.find((s) => s.id === sessionId);
  if (!summary) return [];

  const { turns } = loadChatTurns({
    sessionId,
    limit: 500,
    includeThoughts: false,
    includeTimeline: false,
  });
  const maxTurn = turns.at(-1)?.turn ?? 0;
  if (maxTurn === 0) return [];

  const parsed = heuristicSegments(sessionId);
  if (parsed.length === 0) return [];

  const workspace = new Map([[sessionId, workspaceShort(summary.workspace ?? "")]]);
  let segs = consolidateSegments(segmentsToAtlas(parsed, summary), workspace);
  segs = assignGroupLabels(segs);
  segs = mergeAdjacentSegments(segs);
  return extendSegmentCoverage(segs, maxTurn);
}

export function normalizeAtlasIndex(index: AtlasIndex): AtlasIndex {
  const workspaceBySession = new Map(index.sessions.map((s) => [s.id, s.workspace]));
  let segments = consolidateSegments(index.segments, workspaceBySession);
  segments = assignGroupLabels(segments);
  const themes = buildThemes(segments);
  const sessions = rebuildSessionThemes(index.sessions, segments);
  return { ...index, themes, segments, sessions };
}

function buildSessions(sessions: ChatSummary[], segments: AtlasSegment[]): AtlasSession[] {
  const themeIdsBySession = new Map<string, Set<string>>();
  for (const seg of segments) {
    const set = themeIdsBySession.get(seg.sessionId) ?? new Set();
    set.add(seg.themeId);
    themeIdsBySession.set(seg.sessionId, set);
  }
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    workspace: workspaceShort(s.workspace),
    updatedAt: s.updatedAt,
    themeIds: [...(themeIdsBySession.get(s.id) ?? [])],
  }));
}

export async function readAtlasIndex(): Promise<AtlasIndex | null> {
  try {
    const raw = await readFile(indexPath(), "utf8");
    return normalizeAtlasIndex(JSON.parse(raw) as AtlasIndex);
  } catch {
    return null;
  }
}

export async function writeAtlasIndex(index: AtlasIndex): Promise<void> {
  const path = indexPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2), "utf8");
}

export async function buildAtlasIndex(args: {
  limit?: number;
  offset?: number;
  /** When set with skipExisting, index until the cache has this many sessions total. */
  targetTotal?: number;
  /** Skip sessions already present in index.json; merge new results into the cache. */
  skipExisting?: boolean;
  /** Skip (untitled) and sessions with no user turns. With skipExisting, limit = how many new valid sessions to add. */
  skipEmpty?: boolean;
  useLlm?: boolean;
  cwd: string;
  model?: string;
  onProgress?: (msg: string) => void;
}): Promise<AtlasIndex> {
  const existingRaw = args.skipExisting ? await readAtlasIndex() : null;
  const existing = existingRaw && args.skipEmpty ? pruneEmptySessions(existingRaw) : existingRaw;
  const indexedIds = new Set(existing?.sessions.map((s) => s.id) ?? []);
  const limit = args.limit ?? 15;
  const targetTotal = args.targetTotal ?? limit;
  const needNew =
    args.skipExisting && existing
      ? args.skipEmpty
        ? limit
        : Math.max(0, targetTotal - existing.sessions.length)
      : limit;

  if (needNew === 0 && existing) {
    args.onProgress?.(`Already at ${existing.sessions.length} sessions — nothing to do`);
    if (existingRaw && args.skipEmpty && existing.sessions.length !== existingRaw.sessions.length) {
      await writeAtlasIndex(existing);
    }
    return existing;
  }

  const toIndex: ChatSummary[] = [];
  let skippedEmpty = 0;
  let skippedCached = 0;
  const batchSize = 40;
  let offset = args.skipExisting ? 0 : (args.offset ?? 0);

  while (toIndex.length < needNew) {
    const { sessions, hasMore } = listChatSummaries({ limit: batchSize, offset });
    if (sessions.length === 0) break;
    for (const session of sessions) {
      if (args.skipExisting && indexedIds.has(session.id)) {
        skippedCached += 1;
        continue;
      }
      if (shouldSkipSession(session, args.skipEmpty ?? false)) {
        skippedEmpty += 1;
        continue;
      }
      toIndex.push(session);
      if (toIndex.length >= needNew) break;
    }
    offset += sessions.length;
    if (!hasMore) break;
  }

  if (args.skipExisting) {
    const parts = [`Found ${toIndex.length} new session${toIndex.length === 1 ? "" : "s"} to index`];
    if (indexedIds.size) parts.push(`${indexedIds.size} already cached`);
    if (args.skipEmpty && skippedEmpty) parts.push(`${skippedEmpty} empty/untitled skipped`);
    args.onProgress?.(parts.join(" · "));
  } else {
    toIndex.splice(needNew);
  }

  const newSegments: AtlasSegment[] = [];
  let llmCount = 0;
  let heuristicCount = 0;

  for (const session of toIndex) {
    args.onProgress?.(`Indexing: ${session.title}`);
    let parsed: ParsedSegment[];
    if (args.useLlm) {
      parsed = await llmSegments({
        sessionId: session.id,
        title: session.title,
        workspace: session.workspace,
        cwd: args.cwd,
        model: args.model,
      });
      llmCount += 1;
    } else {
      parsed = heuristicSegments(session.id);
      heuristicCount += 1;
    }
    newSegments.push(...segmentsToAtlas(parsed, session));
  }

  const consolidatedNew = consolidateSegments(
    newSegments,
    new Map(toIndex.map((s) => [s.id, workspaceShort(s.workspace)])),
  );
  const mergedSegments = consolidateSegments(
    [...(existing?.segments ?? []), ...newSegments],
    new Map([
      ...(existing?.sessions.map((s) => [s.id, s.workspace] as const) ?? []),
      ...toIndex.map((s) => [s.id, workspaceShort(s.workspace)] as const),
    ]),
  );
  const mergedSessionsRaw = [
    ...(existing?.sessions ?? []),
    ...buildSessions(toIndex, consolidatedNew),
  ];
  const seenSessionIds = new Set<string>();
  const mergedSessions = mergedSessionsRaw.filter((s) => {
    if (seenSessionIds.has(s.id)) return false;
    seenSessionIds.add(s.id);
    return true;
  });
  const themes = buildThemes(mergedSegments);
  const priorSource = existing?.source;
  let source: AtlasIndex["source"];
  if (priorSource && (llmCount || heuristicCount)) {
    const newSource = llmCount && heuristicCount ? "mixed" : llmCount ? "llm" : "heuristic";
    source = priorSource === newSource ? priorSource : "mixed";
  } else if (priorSource && !llmCount && !heuristicCount) {
    source = priorSource;
  } else {
    source = llmCount && heuristicCount ? "mixed" : llmCount ? "llm" : "heuristic";
  }

  const index: AtlasIndex = normalizeAtlasIndex({
    generatedAt: new Date().toISOString(),
    source,
    themes,
    sessions: rebuildSessionThemes(mergedSessions, mergedSegments),
    segments: mergedSegments,
  });
  await writeAtlasIndex(index);
  return index;
}

/** Quick index without LLM — for first paint */
export async function buildHeuristicIndex(args: {
  limit?: number;
  offset?: number;
}): Promise<AtlasIndex> {
  return buildAtlasIndex({
    limit: args.limit ?? 25,
    offset: args.offset ?? 0,
    useLlm: false,
    cwd: process.cwd(),
  });
}

export async function clusterAtlasSubthemes(args: {
  cwd: string;
  useLlm?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<AtlasIndex | null> {
  const index = await readAtlasIndex();
  if (!index) return null;

  const { clusterSegmentsWithLlm } = await import("./atlas-subtheme-cluster.js");
  const byTheme = new Map<string, AtlasSegment[]>();
  for (const seg of index.segments) {
    const list = byTheme.get(seg.themeId) ?? [];
    list.push(seg);
    byTheme.set(seg.themeId, list);
  }

  let segments = index.segments;
  for (const [themeId, themeSegs] of byTheme) {
    const theme = index.themes.find((t) => t.id === themeId);
    args.onProgress?.(`Clustering: ${theme?.label ?? themeId} (${themeSegs.length} segments)`);
    const labels = args.useLlm
      ? await clusterSegmentsWithLlm({
          themeLabel: theme?.label ?? themeId,
          segments: themeSegs,
          cwd: args.cwd,
        })
      : clusterSegmentsHeuristic(themeSegs);
    segments = segments.map((seg) => {
      if (seg.themeId !== themeId) return seg;
      const label = labels.get(seg.id);
      return label ? { ...seg, groupLabel: label } : seg;
    });
  }

  const updated = normalizeAtlasIndex({ ...index, segments });
  await writeAtlasIndex(updated);
  return updated;
}

export { themeIdFromLabel };
