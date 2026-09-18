import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

const PINNED_COMPOSERS_KEY = "cursor/pinnedComposers";

function pinnedComposersDbPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "workspaceStorage",
    "empty-window",
    "state.vscdb",
  );
}

/** Composer IDs pinned in the Cursor sidebar (`cursor/pinnedComposers`). */
export function loadCursorPinnedComposerIds(): string[] {
  try {
    const db = new Database(pinnedComposersDbPath(), { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(PINNED_COMPOSERS_KEY) as { value?: string } | undefined;
      if (!row?.value) return [];
      const parsed = JSON.parse(row.value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0))];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
