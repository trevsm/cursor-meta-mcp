import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

import { metaPath } from "./meta-home.js";

interface RawBubble {
  bubbleId?: string;
  type?: number;
  text?: string;
  createdAt?: string;
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
  db.pragma("busy_timeout = 2000");
  return db;
}

function archiveDbFile(): string {
  return metaPath("atlas", "bubble-archive.db");
}

function openArchiveDb(): Database.Database {
  const db = new Database(archiveDbFile());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bubbles (
      session_id TEXT NOT NULL,
      bubble_id TEXT NOT NULL,
      type INTEGER,
      text TEXT NOT NULL,
      created_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (session_id, bubble_id)
    );
    CREATE TABLE IF NOT EXISTS bubble_versions (
      session_id TEXT NOT NULL,
      bubble_id TEXT NOT NULL,
      text TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (session_id, bubble_id, seen_at)
    );
    CREATE INDEX IF NOT EXISTS idx_bubble_versions_session
      ON bubble_versions (session_id, bubble_id);
    CREATE TABLE IF NOT EXISTS session_snapshots (
      session_id TEXT PRIMARY KEY,
      last_updated_ms INTEGER NOT NULL,
      header_count INTEGER NOT NULL,
      last_archived_at TEXT NOT NULL
    );
  `);
  return db;
}

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

function loadSessionBubbles(db: Database.Database, sessionId: string): RawBubble[] {
  const { start, end } = bubbleKeyRange(sessionId);
  const rows = db
    .prepare(
      `SELECT value FROM cursorDiskKV
       WHERE key >= ? AND key < ?`,
    )
    .all(start, end) as Array<{ value: string }>;
  return rows.map((r) => JSON.parse(r.value) as RawBubble);
}

/** Snapshot all bubbles for a session into ~/.cursor-meta/atlas/bubble-archive.db */
export function archiveSessionBubbles(sessionId: string): { archived: number; versions: number } {
  const global = openGlobalDb();
  const archive = openArchiveDb();
  const now = new Date().toISOString();
  let archived = 0;
  let versions = 0;

  try {
    const upsert = archive.prepare(`
      INSERT INTO bubbles (session_id, bubble_id, type, text, created_at, first_seen_at, last_seen_at)
      VALUES (@sessionId, @bubbleId, @type, @text, @createdAt, @now, @now)
      ON CONFLICT(session_id, bubble_id) DO UPDATE SET
        type = excluded.type,
        text = excluded.text,
        created_at = COALESCE(excluded.created_at, bubbles.created_at),
        last_seen_at = excluded.last_seen_at
    `);
    const insertVersion = archive.prepare(`
      INSERT OR IGNORE INTO bubble_versions (session_id, bubble_id, text, seen_at)
      VALUES (?, ?, ?, ?)
    `);
    const lastVersion = archive.prepare(`
      SELECT text FROM bubble_versions
      WHERE session_id = ? AND bubble_id = ?
      ORDER BY seen_at DESC
      LIMIT 1
    `);

    const tx = archive.transaction(() => {
      for (const bubble of loadSessionBubbles(global, sessionId)) {
        const bubbleId = bubble.bubbleId?.trim();
        const text = (bubble.text ?? "").trim();
        if (!bubbleId || !text) continue;

        upsert.run({
          sessionId,
          bubbleId,
          type: bubble.type ?? null,
          text,
          createdAt: bubble.createdAt ?? null,
          now,
        });
        archived += 1;

        const prev = lastVersion.get(sessionId, bubbleId) as { text?: string } | undefined;
        if (!prev || prev.text !== text) {
          insertVersion.run(sessionId, bubbleId, text, now);
          versions += 1;
        }
      }
    });
    tx();
    return { archived, versions };
  } finally {
    global.close();
    archive.close();
  }
}

export function getArchivedBubbleText(sessionId: string, bubbleId: string): string | null {
  const archive = openArchiveDb();
  try {
    const row = archive
      .prepare(
        `SELECT text FROM bubbles
         WHERE session_id = ? AND bubble_id = ?`,
      )
      .get(sessionId, bubbleId) as { text?: string } | undefined;
    return row?.text?.trim() || null;
  } finally {
    archive.close();
  }
}

export function listArchivedBubbleVersions(
  sessionId: string,
  bubbleId: string,
): Array<{ text: string; seenAt: string }> {
  const archive = openArchiveDb();
  try {
    const rows = archive
      .prepare(
        `SELECT text, seen_at AS seenAt FROM bubble_versions
         WHERE session_id = ? AND bubble_id = ?
         ORDER BY seen_at ASC`,
      )
      .all(sessionId, bubbleId) as Array<{ text: string; seenAt: string }>;
    return rows;
  } finally {
    archive.close();
  }
}

export interface ArchiveWatcherConfig {
  /** How often to run a pass. Default 15s. */
  intervalMs?: number;
  /** Archive every matching session each pass (recently edited). Default 10 min. */
  hotWithinMs?: number;
  /** Round-robin archive for sessions updated within this window. Default 30 days. */
  warmWithinMs?: number;
  /** Warm sessions archived per pass. Default 30. */
  warmBatchSize?: number;
}

export interface ArchivePassResult {
  hot: number;
  warm: number;
  skipped: number;
  bubbles: number;
  versions: number;
}

interface ComposerRow {
  composerId: string;
  lastUpdatedAt: number;
}

function readWatcherConfig(overrides: ArchiveWatcherConfig = {}): Required<ArchiveWatcherConfig> {
  const env = process.env;
  return {
    intervalMs: overrides.intervalMs ?? Number(env.ATLAS_ARCHIVE_INTERVAL_MS ?? 15_000),
    hotWithinMs: overrides.hotWithinMs ?? Number(env.ATLAS_ARCHIVE_HOT_MS ?? 10 * 60 * 1000),
    warmWithinMs: overrides.warmWithinMs ?? Number(env.ATLAS_ARCHIVE_WARM_MS ?? 30 * 24 * 60 * 60 * 1000),
    warmBatchSize: overrides.warmBatchSize ?? Number(env.ATLAS_ARCHIVE_WARM_BATCH ?? 30),
  };
}

function listComposerSessions(withinMs: number): ComposerRow[] {
  const db = openGlobalDb();
  try {
    const minUpdated = Date.now() - withinMs;
    return db
      .prepare(
        `SELECT composerId, lastUpdatedAt
         FROM composerHeaders
         WHERE IFNULL(isSubagent, 0) = 0
           AND lastUpdatedAt >= ?
         ORDER BY lastUpdatedAt DESC`,
      )
      .all(minUpdated) as ComposerRow[];
  } finally {
    db.close();
  }
}

function sessionMeta(sessionId: string): { lastUpdatedMs: number; headerCount: number } | null {
  const db = openGlobalDb();
  try {
    const headerRow = db
      .prepare(`SELECT lastUpdatedAt FROM composerHeaders WHERE composerId = ?`)
      .get(sessionId) as { lastUpdatedAt?: number } | undefined;
    const dataRow = db
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`composerData:${sessionId}`) as { value?: string } | undefined;
    if (!dataRow?.value) return null;
    const data = JSON.parse(dataRow.value) as { fullConversationHeadersOnly?: unknown[] };
    const headerCount = data.fullConversationHeadersOnly?.length ?? 0;
    const lastUpdatedMs = headerRow?.lastUpdatedAt ?? 0;
    return { lastUpdatedMs, headerCount };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function shouldSkipWarmArchive(
  archive: Database.Database,
  sessionId: string,
  meta: { lastUpdatedMs: number; headerCount: number },
): boolean {
  const prev = archive
    .prepare(
      `SELECT last_updated_ms AS lastUpdatedMs, header_count AS headerCount
       FROM session_snapshots WHERE session_id = ?`,
    )
    .get(sessionId) as { lastUpdatedMs?: number; headerCount?: number } | undefined;
  if (!prev) return false;
  return prev.lastUpdatedMs === meta.lastUpdatedMs && prev.headerCount === meta.headerCount;
}

function markSessionArchived(
  archive: Database.Database,
  sessionId: string,
  meta: { lastUpdatedMs: number; headerCount: number },
  now: string,
): void {
  archive
    .prepare(
      `INSERT INTO session_snapshots (session_id, last_updated_ms, header_count, last_archived_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_updated_ms = excluded.last_updated_ms,
         header_count = excluded.header_count,
         last_archived_at = excluded.last_archived_at`,
    )
    .run(sessionId, meta.lastUpdatedMs, meta.headerCount, now);
}

let warmCursor = 0;

/** Archive all recently touched composers — not just chats open in Atlas. */
export function runArchivePass(config: ArchiveWatcherConfig = {}): ArchivePassResult {
  const cfg = readWatcherConfig(config);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const hotCutoff = now - cfg.hotWithinMs;

  const warmRows = listComposerSessions(cfg.warmWithinMs);
  const hotIds = warmRows.filter((r) => r.lastUpdatedAt >= hotCutoff).map((r) => r.composerId);
  const warmPool = warmRows.filter((r) => r.lastUpdatedAt < hotCutoff).map((r) => r.composerId);

  if (warmPool.length && cfg.warmBatchSize > 0 && warmCursor >= warmPool.length) {
    warmCursor = 0;
  }

  const warmBatch: string[] = [];
  for (let i = 0; i < cfg.warmBatchSize && warmPool.length; i++) {
    warmBatch.push(warmPool[(warmCursor + i) % warmPool.length]!);
  }
  warmCursor = warmPool.length ? (warmCursor + warmBatch.length) % warmPool.length : 0;

  const toProcess = [...new Set([...hotIds, ...warmBatch])];
  const archive = openArchiveDb();
  const result: ArchivePassResult = { hot: 0, warm: 0, skipped: 0, bubbles: 0, versions: 0 };
  const hotSet = new Set(hotIds);

  try {
    for (const sessionId of toProcess) {
      const meta = sessionMeta(sessionId);
      if (!meta) continue;

      const isHot = hotSet.has(sessionId);
      if (!isHot && shouldSkipWarmArchive(archive, sessionId, meta)) {
        result.skipped += 1;
        continue;
      }

      try {
        const snap = archiveSessionBubbles(sessionId);
        markSessionArchived(archive, sessionId, meta, nowIso);
        if (isHot) result.hot += 1;
        else result.warm += 1;
        result.bubbles += snap.archived;
        result.versions += snap.versions;
      } catch {
        // skip individual session failures
      }
    }
    return result;
  } finally {
    archive.close();
  }
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;

/** Background loop — starts with atlas-serve unless ATLAS_ARCHIVE_DISABLE=1. */
export function startBubbleArchiveWatcher(config: ArchiveWatcherConfig = {}): () => void {
  if (process.env.ATLAS_ARCHIVE_DISABLE === "1") return () => undefined;
  stopBubbleArchiveWatcher();

  const cfg = readWatcherConfig(config);
  const tick = () => {
    try {
      const pass = runArchivePass(cfg);
      if (pass.hot > 0 || pass.versions > 0) {
        console.error(
          `[atlas-archive] hot=${pass.hot} warm=${pass.warm} skipped=${pass.skipped} bubbles=${pass.bubbles} versions=${pass.versions}`,
        );
      }
    } catch (err) {
      console.error("[atlas-archive] pass failed:", err);
    }
  };

  tick();
  watcherTimer = setInterval(tick, cfg.intervalMs);
  return stopBubbleArchiveWatcher;
}

export function stopBubbleArchiveWatcher(): void {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = null;
}
