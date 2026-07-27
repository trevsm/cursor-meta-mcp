import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const metaDir = mkdtempSync(join(tmpdir(), "process-lock-test-"));

const { acquireLock, readLock, releaseLock, pruneStaleLocks } = await import("../src/process-lock.js");

after(() => {
  releaseLock("test-role", metaDir);
});

test("acquireLock grants and releases", () => {
  const holder = process.pid;
  const first = acquireLock("test-role", metaDir, holder);
  assert.equal(first.acquired, true);
  assert.ok(readLock("test-role", metaDir));

  const second = acquireLock("test-role", metaDir, holder + 1);
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy?.pid, holder);

  assert.equal(releaseLock("test-role", metaDir, holder), true);
  const third = acquireLock("test-role", metaDir, holder + 2);
  assert.equal(third.acquired, true);
  releaseLock("test-role", metaDir, holder + 2);
});

test("pruneStaleLocks clears dead pid locks", () => {
  acquireLock("stale-role", metaDir, 9_999_999);
  const cleared = pruneStaleLocks(["stale-role"], metaDir);
  assert.deepEqual(cleared, ["stale-role"]);
  assert.equal(readLock("stale-role", metaDir), null);
});
