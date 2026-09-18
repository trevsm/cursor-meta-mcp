import type { AtlasIndex } from "./atlas-index.js";
import { searchThinking, type SearchScope } from "./chat-search.js";
import { searchChats, listChatSummaries } from "./history-store.js";

export interface AtlasSearchHit {
  sessionId: string;
  scope: string;
  snippet: string;
  segmentId: string | null;
  turnStart: number | null;
  turnEnd: number | null;
  rank: number;
}

export interface AtlasSearchResult {
  query: string;
  hits: AtlasSearchHit[];
  elapsedMs: number;
  scanned: number;
  sessions: number;
}

function recentSessionIds(limit: number): string[] {
  const { sessions } = listChatSummaries({ limit, offset: 0 });
  return sessions.map((s) => s.id);
}

function searchFtsHits(query: string, limit: number): AtlasSearchHit[] {
  try {
    return searchChats({ query, limit }).hits.map((hit) => ({
      sessionId: hit.sessionId,
      scope: "message",
      snippet: hit.snippet,
      segmentId: null,
      turnStart: null,
      turnEnd: null,
      rank: 2,
    }));
  } catch {
    return [];
  }
}

function indexRows(index: AtlasIndex) {
  const rows: Array<{ sessionId: string; scope: string; text: string; segmentId: string | null; turnStart: number | null; turnEnd: number | null; rank: number }> = [];
  for (const s of index.sessions) {
    rows.push({
      sessionId: s.id,
      scope: "title",
      text: s.title ?? "",
      segmentId: null,
      turnStart: null,
      turnEnd: null,
      rank: 3,
    });
    if (s.workspace) {
      rows.push({
        sessionId: s.id,
        scope: "workspace",
        text: s.workspace,
        segmentId: null,
        turnStart: null,
        turnEnd: null,
        rank: 1,
      });
    }
  }
  for (const seg of index.segments) {
    const title = index.sessions.find((s) => s.id === seg.sessionId)?.title ?? "";
    rows.push({
      sessionId: seg.sessionId,
      scope: "segment",
      text: [seg.preview, seg.groupLabel, seg.subtheme, title].filter(Boolean).join(" "),
      segmentId: seg.id,
      turnStart: seg.turnStart,
      turnEnd: seg.turnEnd,
      rank: 2,
    });
  }
  return rows;
}

function snippetAround(text: string, q: string, idx: number): string {
  const start = Math.max(0, idx - 48);
  const end = Math.min(text.length, idx + q.length + 64);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}

function searchIndexRows(index: AtlasIndex, query: string, limit: number): AtlasSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: AtlasSearchHit[] = [];
  for (const row of indexRows(index)) {
    const hay = row.text.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx < 0) continue;
    hits.push({
      sessionId: row.sessionId,
      scope: row.scope,
      snippet: snippetAround(row.text, q, idx),
      segmentId: row.segmentId,
      turnStart: row.turnStart,
      turnEnd: row.turnEnd,
      rank: row.rank,
    });
  }
  hits.sort((a, b) => b.rank - a.rank);
  return hits.slice(0, limit);
}

/** Bubble scan only for chats Cursor may not have FTS'd yet (active / very recent). */
const RECENT_BUBBLE_SESSIONS = 25;

export function searchAtlas(args: {
  query: string;
  index: AtlasIndex;
  limit?: number;
  scopes?: SearchScope[];
}): AtlasSearchResult {
  const query = args.query.trim();
  const limit = Math.min(Math.max(args.limit ?? 40, 1), 100);
  const started = Date.now();
  if (!query) {
    return { query, hits: [], elapsedMs: 0, scanned: 0, sessions: 0 };
  }

  const indexHits = searchIndexRows(args.index, query, limit);
  const ftsHits = searchFtsHits(query, limit);
  const indexRowCount = indexRows(args.index).length;
  const seen = new Set([
    ...indexHits.map((h) => `${h.sessionId}:${h.turnStart ?? ""}:${h.scope}`),
    ...ftsHits.map((h) => `${h.sessionId}:${h.turnStart ?? ""}:${h.scope}`),
  ]);

  const merged = [...indexHits, ...ftsHits];
  let bubblesScanned = 0;

  // Skip bubble scan when index + FTS already fill the page.
  if (merged.length < limit) {
    const messageSearch = searchThinking({
      query,
      scopes: args.scopes ?? ["user", "assistant"],
      sessionIds: recentSessionIds(RECENT_BUBBLE_SESSIONS),
      limit: limit - merged.length,
      quoteChars: 120,
    });
    bubblesScanned = messageSearch.bubblesScanned;

    for (const hit of messageSearch.hits) {
      const mapped: AtlasSearchHit = {
        sessionId: hit.sessionId,
        scope: hit.scope,
        snippet: hit.quote,
        segmentId: null,
        turnStart: hit.turn,
        turnEnd: hit.turn,
        rank: hit.scope === "user" ? 2 : 1,
      };
      const key = `${mapped.sessionId}:${mapped.turnStart ?? ""}:${mapped.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(mapped);
    }
  }

  merged.sort((a, b) => b.rank - a.rank || (a.turnStart ?? 0) - (b.turnStart ?? 0));
  const hits = merged.slice(0, limit);

  return {
    query,
    hits,
    elapsedMs: Math.max(1, Date.now() - started),
    scanned: indexRowCount + ftsHits.length + bubblesScanned,
    sessions: new Set(hits.map((h) => h.sessionId)).size,
  };
}
