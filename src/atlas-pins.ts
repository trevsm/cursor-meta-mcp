import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { loadCursorPinnedComposerIds } from "./cursor-pinned-composers.js";
import { metaPath } from "./meta-home.js";

export interface AtlasPinsFile {
  /** Atlas-only pins (not already pinned in Cursor). */
  sessionIds: string[];
  /** Cursor-native pins explicitly hidden in Atlas. */
  unpinnedSessionIds?: string[];
  updatedAt: string;
}

export interface AtlasPins extends AtlasPinsFile {
  /** Cursor + Atlas pins visible in the UI. */
  visibleSessionIds: string[];
}

export interface AtlasPinItem {
  sessionId: string;
  title: string;
  workspace: string;
  updatedAt: string;
  liveSummary: string;
  activityLevel: "idle";
  signals: string[];
  source: "cursor" | "atlas";
}

function pinsPath(): string {
  return metaPath("atlas", "pins.json");
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

async function readAtlasPinsFile(): Promise<AtlasPinsFile> {
  try {
    const raw = await readFile(pinsPath(), "utf8");
    const parsed = JSON.parse(raw) as AtlasPinsFile;
    return {
      sessionIds: [...new Set(parsed.sessionIds ?? [])],
      unpinnedSessionIds: [...new Set(parsed.unpinnedSessionIds ?? [])],
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return { sessionIds: [], unpinnedSessionIds: [], updatedAt: new Date(0).toISOString() };
  }
}

function mergeVisiblePins(file: AtlasPinsFile, cursorIds: string[]): string[] {
  const unpinned = new Set(file.unpinnedSessionIds ?? []);
  const merged = new Set([...cursorIds, ...file.sessionIds]);
  for (const id of unpinned) merged.delete(id);
  return [...merged];
}

function fileFromDesiredVisible(
  desiredVisibleIds: string[],
  cursorIds: string[],
  file: AtlasPinsFile,
): AtlasPinsFile {
  const cursorSet = new Set(cursorIds);
  const desiredSet = new Set(desiredVisibleIds.filter(Boolean));
  const mergedBefore = mergeVisiblePins(file, cursorIds);
  const omitsAllCursorPins = cursorIds.length > 0 && !cursorIds.some((id) => desiredSet.has(id));
  const allOmittedAreExplicitlyUnpinned =
    omitsAllCursorPins &&
    cursorIds.every(
      (id) => (file.unpinnedSessionIds ?? []).includes(id) || !mergedBefore.includes(id),
    );
  const staleClient =
    omitsAllCursorPins && !allOmittedAreExplicitlyUnpinned && desiredSet.size > 0;

  if (staleClient) {
    const unpinned = new Set(file.unpinnedSessionIds ?? []);
    for (const id of desiredSet) unpinned.delete(id);
    return {
      sessionIds: [...desiredSet].filter((id) => !cursorSet.has(id)),
      unpinnedSessionIds: [...unpinned],
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    sessionIds: [...desiredSet].filter((id) => !cursorSet.has(id)),
    unpinnedSessionIds: cursorIds.filter((id) => !desiredSet.has(id)),
    updatedAt: new Date().toISOString(),
  };
}

export async function readAtlasPins(): Promise<AtlasPins> {
  const file = await readAtlasPinsFile();
  const cursorIds = loadCursorPinnedComposerIds();
  const visibleSessionIds = mergeVisiblePins(file, cursorIds);
  return { ...file, visibleSessionIds };
}

export async function writeAtlasPins(desiredVisibleIds: string[]): Promise<AtlasPins> {
  const cursorIds = loadCursorPinnedComposerIds();
  const file = await readAtlasPinsFile();
  const body = fileFromDesiredVisible(desiredVisibleIds, cursorIds, file);
  await mkdir(metaPath("atlas"), { recursive: true });
  await writeFile(pinsPath(), JSON.stringify(body, null, 2));
  return { ...body, visibleSessionIds: mergeVisiblePins(body, cursorIds) };
}

export function resolvePinnedChatItems(
  sessionIds: string[],
  cursorIds: string[],
): AtlasPinItem[] {
  if (!sessionIds.length) return [];
  const cursorSet = new Set(cursorIds);
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });
  try {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT composerId, lastUpdatedAt, value
         FROM composerHeaders
         WHERE composerId IN (${placeholders})`,
      )
      .all(...sessionIds) as Array<{ composerId: string; lastUpdatedAt: number; value: string }>;
    const byId = new Map(rows.map((row) => [row.composerId, row]));

    return sessionIds.map((sessionId) => {
      const row = byId.get(sessionId);
      if (!row) {
        return {
          sessionId,
          title: sessionId.slice(0, 8),
          workspace: "unknown",
          updatedAt: new Date(0).toISOString(),
          liveSummary: "",
          activityLevel: "idle" as const,
          signals: [],
          source: cursorSet.has(sessionId) ? "cursor" : "atlas",
        };
      }
      const header = JSON.parse(row.value) as {
        name?: string;
        subtitle?: string;
        workspaceIdentifier?: { id?: string; uri?: { fsPath?: string; path?: string } };
      };
      const uri = header.workspaceIdentifier?.uri;
      const workspace =
        uri?.fsPath ?? uri?.path ?? header.workspaceIdentifier?.id ?? "unknown";
      return {
        sessionId,
        title: header.name ?? "(untitled)",
        workspace,
        updatedAt: new Date(row.lastUpdatedAt).toISOString(),
        liveSummary: header.subtitle ?? "",
        activityLevel: "idle" as const,
        signals: [],
        source: cursorSet.has(sessionId) ? "cursor" : "atlas",
      };
    });
  } finally {
    db.close();
  }
}
