import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

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

/** Cursor IDE session token from local state DB (distinct from CURSOR_API_KEY). */
export function readCursorAccessToken(): string | null {
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/accessToken") as { value?: string } | undefined;
    const token = row?.value?.trim();
    return token || null;
  } finally {
    db.close();
  }
}
