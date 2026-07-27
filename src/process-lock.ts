import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { metaPath } from "./meta-home.js";

export interface LockRecord {
  pid: number;
  at: string;
  name: string;
  command?: string;
}

export interface AcquireResult {
  acquired: boolean;
  path: string;
  /** Set when another live process already holds the lock. */
  heldBy?: LockRecord;
}

export function locksDir(metaDir?: string): string {
  return metaDir ? join(metaDir, "locks") : metaPath("locks");
}

export function lockPath(name: string, metaDir?: string): string {
  return join(locksDir(metaDir), `${name}.lock`);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function readLock(name: string, metaDir?: string): LockRecord | null {
  const path = lockPath(name, metaDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Claim a singleton role. Stale locks (dead pid) are taken over.
 *
 * Without this, a second fleet launch racing the first one leaves untracked
 * duplicate loops that no manifest can ever kill — two orchestrators steering the
 * same chats and double-billing the budget.
 */
export function acquireLock(name: string, metaDir?: string, pid = process.pid): AcquireResult {
  const dir = locksDir(metaDir);
  mkdirSync(dir, { recursive: true });
  const path = lockPath(name, metaDir);

  const existing = readLock(name, metaDir);
  if (existing && existing.pid !== pid && pidAlive(existing.pid)) {
    return { acquired: false, path, heldBy: existing };
  }

  const record: LockRecord = {
    pid,
    at: new Date().toISOString(),
    name,
    command: process.argv.slice(1).join(" ").slice(0, 300),
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { acquired: true, path };
}

export function releaseLock(name: string, metaDir?: string, pid = process.pid): boolean {
  const existing = readLock(name, metaDir);
  if (!existing || existing.pid !== pid) return false;
  try {
    rmSync(lockPath(name, metaDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Acquire a lock and release it on normal exit and on SIGINT/SIGTERM. */
export function acquireLockWithCleanup(name: string, metaDir?: string): AcquireResult {
  const result = acquireLock(name, metaDir);
  if (!result.acquired) return result;

  const release = () => releaseLock(name, metaDir);
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }
  return result;
}

/** Remove locks whose owning process is gone. Returns the names cleared. */
export function pruneStaleLocks(names: string[], metaDir?: string): string[] {
  const cleared: string[] = [];
  for (const name of names) {
    const record = readLock(name, metaDir);
    if (record && !pidAlive(record.pid)) {
      try {
        rmSync(lockPath(name, metaDir), { force: true });
        cleared.push(name);
      } catch {
        /* best-effort */
      }
    }
  }
  return cleared;
}
