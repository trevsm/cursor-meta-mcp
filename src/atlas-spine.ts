import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  archiveSessionBubbles,
  getArchivedBubbleText,
  listArchivedBubbleVersions,
} from "./atlas-bubble-archive.js";
import { getSessionSegments, type AtlasIndex, type AtlasSegment } from "./atlas-index.js";
import { metaPath } from "./meta-home.js";

export interface AtlasSpineTurn {
  n: number;
  bubbleId: string;
  role: "user" | "assistant";
  preview: string;
  at: string | null;
}

export interface AtlasSpineBranch {
  id: string;
  parentTurn: number;
  parentBubbleId: string;
  label: string;
  orphanPreview: string;
  status: "pruned";
}

export interface AtlasSpine {
  sessionId: string;
  turns: AtlasSpineTurn[];
  branches: AtlasSpineBranch[];
  segments: AtlasSegment[];
  /** Bumps when headers change (new bubbles, edit-resend truncation, in-place edits). */
  revision: string;
}

interface HeaderEntry {
  bubbleId?: string;
  type?: number;
  createdAt?: string;
  grouping?: { textPreview?: string };
}

interface RawBubble {
  bubbleId?: string;
  type?: number;
  text?: string;
  createdAt?: string;
  requestId?: string;
}

function globalDbFile(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override;
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function openGlobalDb(): Database.Database {
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });
  db.pragma("mmap_size = 268435456");
  db.pragma("busy_timeout = 2000");
  return db;
}

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

const PREVIEW_MAX = 320;

function previewFromHeader(h: HeaderEntry): string {
  const fromGrouping = h.grouping?.textPreview?.trim();
  if (fromGrouping) return fromGrouping;
  return "";
}

function normalizeMessageText(text: string): string {
  let body = text.trim();
  const tagged = body.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (tagged) body = tagged[1]!.trim();
  body = body.replace(/\*\*/g, "");
  return body.replace(/\s+/g, " ").trim();
}

function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) return `${cut.slice(0, lastSpace).trim()}…`;
  return `${cut.trim()}…`;
}

function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  let breakAt = -1;
  for (const match of cut.matchAll(/[.!?](?:\s|$)/g)) {
    const idx = match.index!;
    const digitBefore = idx > 0 && /\d/.test(cut[idx - 1]!);
    if (digitBefore) continue;
    breakAt = idx;
  }
  if (breakAt > maxLen * 0.4) return text.slice(0, breakAt + 1).trim();
  return truncateAtWord(text, maxLen);
}

function compressNumberedIntro(intro: string, maxLen: number): string {
  if (!/\d+\.\s/.test(intro)) return truncateAtSentence(intro, maxLen);
  const lead = intro.split(/\d+\.\s/)[0]?.trim().replace(/:\s*$/, "") ?? intro;
  const items = [...intro.matchAll(/\d+\.\s([^]+?)(?=\s*\d+\.\s|$)/g)]
    .map((m) => m[1]!.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!items.length) return truncateAtSentence(intro, maxLen);
  const brief = items
    .map((it) => truncateAtWord(it.split(/[—–-]/)[0]?.trim() || it, 48))
    .join("; ");
  const combined = `${lead} (${brief})`;
  return combined.length <= maxLen ? combined : truncateAtWord(combined, maxLen);
}

function summarizeMessageText(text: string, maxLen = PREVIEW_MAX): string {
  const body = normalizeMessageText(text);
  if (!body) return "";
  if (body.length <= maxLen) return body;

  const changedMatch = body.match(/\b(what i changed|changes made|what changed):\s*(.+)$/i);
  if (changedMatch) {
    const intro = body.slice(0, changedMatch.index).trim();
    const introShort = compressNumberedIntro(intro, Math.min(160, Math.floor(maxLen * 0.55)));
    const changed = changedMatch[2]!
      .split(/\n\s*[-•*]\s+|\s+-\s+(?=[A-Z*])/)
      .map((item) => item.replace(/^[-•*]\s*/, "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("; ");
    const changedShort = truncateAtWord(changed, maxLen - introShort.length - 12);
    const combined = `${introShort} Changed: ${changedShort}`;
    return combined.length <= maxLen ? combined : truncateAtSentence(combined, maxLen);
  }

  if (/\d+\.\s/.test(body)) {
    const compressed = compressNumberedIntro(body, maxLen);
    if (compressed.length <= maxLen) return compressed;
  }

  return truncateAtSentence(body, maxLen);
}

function previewFromBubble(b: RawBubble): string {
  const text = (b.text ?? "").trim();
  if (!text) return "";
  return summarizeMessageText(text);
}

function previewForHeader(
  h: HeaderEntry,
  bubbleById: Map<string, RawBubble>,
  role: "user" | "assistant",
): string {
  const bubble = h.bubbleId ? bubbleById.get(h.bubbleId) : undefined;
  const bubbleText = bubble?.text?.trim() ?? "";
  const headerPreview = previewFromHeader(h);

  if (bubbleText) return summarizeMessageText(bubbleText);
  if (headerPreview) return summarizeMessageText(headerPreview);
  return "";
}

function isSystemUserPreview(preview: string): boolean {
  const t = preview.trim();
  return (
    t.includes("<system_notification>") ||
    /task result and perform any follow-up/i.test(t) ||
    /follow-up actions in response to the subagent/i.test(t) ||
    t === "(empty prompt)"
  );
}

function isInternalAssistantPreview(preview: string): boolean {
  const t = preview.trim();
  if (!t || t === "(assistant)") return true;
  if (
    /^(checking|investigating|updating|starting|indexing|building|running|looking|creating|recording|opening|moved|wait|hmm)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/likely appears when|checking the navigation|checking how/i.test(t)) return true;
  if (t.length < 72 && /\b(fixing that|in progress|still running|one moment)\b/i.test(t)) return true;
  if (/^i['']ll\b/i.test(t) && t.length < 160 && !/\n---|^#{1,3}\s/m.test(t)) return true;
  return false;
}

function consolidateSpineTurns(turns: AtlasSpineTurn[]): AtlasSpineTurn[] {
  const byTurn = new Map<number, { user?: AtlasSpineTurn; assistants: AtlasSpineTurn[] }>();
  for (const turn of turns) {
    const bucket = byTurn.get(turn.n) ?? { assistants: [] };
    if (turn.role === "user") bucket.user = turn;
    else bucket.assistants.push(turn);
    byTurn.set(turn.n, bucket);
  }

  const out: AtlasSpineTurn[] = [];
  for (const n of [...byTurn.keys()].sort((a, b) => a - b)) {
    const bucket = byTurn.get(n)!;
    const user = bucket.user;
    if (user && !isSystemUserPreview(user.preview)) out.push(user);

    let picked: AtlasSpineTurn | undefined;
    let bestLen = -1;
    for (let i = bucket.assistants.length - 1; i >= 0; i--) {
      const candidate = bucket.assistants[i]!;
      if (isInternalAssistantPreview(candidate.preview)) continue;
      if (candidate.preview.length >= bestLen) {
        picked = candidate;
        bestLen = candidate.preview.length;
      }
    }
    if (!picked && bucket.assistants.length) {
      picked = bucket.assistants[bucket.assistants.length - 1];
    }
    if (picked && !isInternalAssistantPreview(picked.preview)) out.push(picked);
  }
  return out;
}

function loadComposerHeaders(db: Database.Database, sessionId: string): HeaderEntry[] {
  const row = db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`composerData:${sessionId}`) as { value?: string } | undefined;
  if (!row?.value) return [];
  const data = JSON.parse(row.value) as { fullConversationHeadersOnly?: HeaderEntry[] };
  return data.fullConversationHeadersOnly ?? [];
}

function loadAllBubbles(db: Database.Database, sessionId: string): RawBubble[] {
  const { start, end } = bubbleKeyRange(sessionId);
  const rows = db
    .prepare(
      `SELECT value FROM cursorDiskKV
       WHERE key >= ? AND key < ?
       ORDER BY rowid ASC`,
    )
    .all(start, end) as Array<{ value: string }>;
  return rows.map((r) => JSON.parse(r.value) as RawBubble);
}

function loadVirtualRowHeights(db: Database.Database, sessionId: string): Record<string, number> | null {
  const row = db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`composerVirtualRowHeights:${sessionId}`) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as Record<string, number>;
  } catch {
    return null;
  }
}

/** Cursor UI tracks prior assistant responses per user turn in virtual row keys. */
function orderedAssistantMarkdownIds(
  virtualRows: Record<string, number> | null,
  userBubbleId: string,
): string[] {
  if (!virtualRows || !userBubbleId) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(virtualRows)) {
    if (!key.includes(userBubbleId) || !key.includes("assistant-markdown")) continue;
    const match = key.match(/assistant-markdown:([0-9a-f-]{36}):markdown/i);
    if (!match || seen.has(match[1]!)) continue;
    seen.add(match[1]!);
    ordered.push(match[1]!);
  }
  return ordered;
}

const PRUNED_CONTENT_GONE =
  "Previous response — Cursor removed this version from local storage when the prompt was edited.";

function turnTimestamp(turn: AtlasSpineTurn, bubbleById: Map<string, RawBubble>): number {
  if (turn.at) return Date.parse(turn.at);
  const bubble = bubbleById.get(turn.bubbleId);
  if (bubble?.createdAt) return Date.parse(bubble.createdAt);
  return 0;
}

function nearestUserTurn(
  atMs: number,
  userTurns: AtlasSpineTurn[],
  bubbleById: Map<string, RawBubble>,
): { turn: AtlasSpineTurn; delta: number } | null {
  let best: { turn: AtlasSpineTurn; delta: number } | null = null;
  for (const ut of userTurns) {
    const ts = turnTimestamp(ut, bubbleById);
    const delta = Math.abs(ts - atMs);
    if (!best || delta < best.delta) best = { turn: ut, delta: delta };
  }
  return best;
}

const LIVE_SUMMARY_MAX = 160;
const LIVE_SUMMARY_TAIL = 24;

function liveSummaryFromDb(db: Database.Database, sessionId: string): string | null {
  const headers = loadComposerHeaders(db, sessionId);
  if (!headers.length) return null;

  const tail = headers.slice(-LIVE_SUMMARY_TAIL);
  const bubbleById = new Map<string, RawBubble>();
  const bubbleStmt = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`);
  for (const h of tail) {
    if (!h.bubbleId) continue;
    const row = bubbleStmt.get(`bubbleId:${sessionId}:${h.bubbleId}`) as { value?: string } | undefined;
    if (!row?.value) continue;
    bubbleById.set(h.bubbleId, JSON.parse(row.value) as RawBubble);
  }

  for (let i = headers.length - 1; i >= 0; i--) {
    const h = headers[i]!;
    const role = h.type === 2 ? "assistant" : "user";
    const preview = previewForHeader(h, bubbleById, role);
    if (!preview) continue;
    if (role === "user" && isSystemUserPreview(preview)) continue;
    if (role === "assistant" && isInternalAssistantPreview(preview)) continue;
    return summarizeMessageText(preview, LIVE_SUMMARY_MAX);
  }
  return null;
}

/** Latest meaningful turn preview for inbox rows — reads only recent bubbles. */
export function liveSummariesForSessions(sessionIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!sessionIds.length) return out;

  const db = openGlobalDb();
  try {
    for (const sessionId of sessionIds) {
      const summary = liveSummaryFromDb(db, sessionId);
      if (summary) out.set(sessionId, summary);
    }
    return out;
  } finally {
    db.close();
  }
}

export function loadAtlasSpine(sessionId: string): AtlasSpine {
  archiveSessionBubbles(sessionId);

  const db = openGlobalDb();
  try {
    const headers = loadComposerHeaders(db, sessionId);
    const activeIds = new Set(headers.map((h) => h.bubbleId).filter(Boolean) as string[]);
    const allBubbles = loadAllBubbles(db, sessionId);
    const bubbleById = new Map<string, RawBubble>();
    for (const b of allBubbles) {
      if (b.bubbleId) bubbleById.set(b.bubbleId, b);
    }

    let userTurn = 0;
    const turns: AtlasSpineTurn[] = [];
    for (const h of headers) {
      const role = h.type === 2 ? "assistant" : "user";
      if (role === "user") userTurn += 1;
      const preview = previewForHeader(h, bubbleById, role);
      if (!preview && role === "assistant") continue;
      turns.push({
        n: role === "user" ? userTurn : userTurn,
        bubbleId: h.bubbleId ?? "",
        role,
        preview: preview || (role === "user" ? "(empty prompt)" : "(assistant)"),
        at: h.createdAt ?? null,
      });
    }

    const consolidated = consolidateSpineTurns(turns);
    const userTurns = consolidated.filter((t) => t.role === "user");
    const branches: AtlasSpineBranch[] = [];
    const branchIds = new Set<string>();

    const pushBranch = (branch: AtlasSpineBranch): void => {
      if (branchIds.has(branch.id)) return;
      branchIds.add(branch.id);
      branches.push(branch);
    };

    const orphanBubbles = allBubbles.filter((b) => b.bubbleId && !activeIds.has(b.bubbleId));
    for (const orphan of orphanBubbles) {
      const orphanAt = orphan.createdAt ? Date.parse(orphan.createdAt) : 0;
      const orphanPreview = previewFromBubble(orphan);
      if (!orphanPreview) continue;

      const best = nearestUserTurn(orphanAt, userTurns, bubbleById);
      if (!best || best.delta > 120_000) continue;

      const isUserOrphan = orphan.type === 1;
      const stem = orphanPreview.slice(0, 40).toLowerCase();
      const activeStem = best.turn.preview.slice(0, 40).toLowerCase();
      const isEditResend =
        isUserOrphan &&
        stem.length > 8 &&
        (activeStem.startsWith(stem) || stem.startsWith(activeStem) || stem === activeStem);

      pushBranch({
        id: `br-${orphan.bubbleId}`,
        parentTurn: best.turn.n,
        parentBubbleId: best.turn.bubbleId,
        label: isUserOrphan
          ? isEditResend
            ? "edited resend"
            : "pruned prompt"
          : "aborted response",
        orphanPreview: (orphanPreview || getArchivedBubbleText(sessionId, orphan.bubbleId!) || "")
          .slice(0, 200) || PRUNED_CONTENT_GONE.slice(0, 200),
        status: "pruned",
      });
    }

    const virtualRows = loadVirtualRowHeights(db, sessionId);
    for (const userTurn of userTurns) {
      const assistantIds = orderedAssistantMarkdownIds(virtualRows, userTurn.bubbleId);
      if (assistantIds.length < 2) continue;

      const canonical = consolidated.find((t) => t.role === "assistant" && t.n === userTurn.n);
      const canonicalId = canonical?.bubbleId ?? assistantIds.at(-1) ?? "";

      for (const assistantId of assistantIds) {
        if (assistantId === canonicalId) continue;
        const bubble = bubbleById.get(assistantId);
        const archived = getArchivedBubbleText(sessionId, assistantId);
        const preview = bubble ? previewFromBubble(bubble) : archived ? summarizeMessageText(archived) : "";
        pushBranch({
          id: `br-vr-${assistantId}`,
          parentTurn: userTurn.n,
          parentBubbleId: userTurn.bubbleId,
          label: "previous response",
          orphanPreview: preview || PRUNED_CONTENT_GONE,
          status: "pruned",
        });
      }

      const promptVersions = listArchivedBubbleVersions(sessionId, userTurn.bubbleId);
      if (promptVersions.length > 1) {
        const currentText = userTurn.preview;
        for (let i = 0; i < promptVersions.length - 1; i++) {
          const version = promptVersions[i]!;
          const versionPreview = summarizeMessageText(version.text);
          if (!versionPreview || versionPreview === currentText) continue;
          pushBranch({
            id: `br-pv-${userTurn.bubbleId}-${i}`,
            parentTurn: userTurn.n,
            parentBubbleId: userTurn.bubbleId,
            label: "edited resend",
            orphanPreview: versionPreview.slice(0, 200),
            status: "pruned",
          });
        }
      }
    }

    const lastHeader = headers.at(-1);
    const revision = `${headers.length}:${lastHeader?.bubbleId ?? ""}:${lastHeader?.createdAt ?? ""}`;
    const index = readAtlasIndexSync();
    const segments = getSessionSegments(sessionId, index);

    return { sessionId, turns: consolidated, branches, segments, revision };
  } finally {
    db.close();
  }
}

function readAtlasIndexSync(): AtlasIndex | null {
  try {
    const raw = readFileSync(metaPath("atlas", "index.json"), "utf8");
    return JSON.parse(raw) as AtlasIndex;
  } catch {
    return null;
  }
}
