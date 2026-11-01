import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every directory `tempDir()` has made in this test file and not yet removed. */
const made = new Set<string>();

/**
 * A fresh directory under the OS temp directory, removed once the test file
 * that made it has finished.
 *
 * It is `mkdtempSync()` with the prefix the caller gives, so the path is the one
 * a test would have made for itself and anything it reads back is unchanged.
 * What this adds is the removal: `test/setup.ts` calls `removeTempDirs()` in an
 * `afterAll` that vitest runs for every test file. Per file rather than per test
 * because a directory made in a `beforeAll`, or at module level, has to outlive
 * the first test, and tracking each directory instead of nesting them under one
 * root keeps every path exactly as long as it was. See "The suite removes every
 * directory it makes" in `packages/sigil/src/testing/AGENTS.md`, which also
 * says why there is one copy of this file per package.
 *
 * @param prefix - What the directory's name starts with. Name it after the test
 *   so a leak is traceable to the file that made it.
 * @returns The directory's absolute path.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

/**
 * Removes every directory `tempDir()` made and has not removed yet.
 *
 * `maxRetries` is for Windows, where a directory a child process has only just
 * let go of can still answer `EBUSY` or `EPERM` for a moment. A directory that
 * still cannot be removed fails the file rather than leaking quietly, which is
 * the failure this exists to stop.
 */
export function removeTempDirs(): void {
  const failed: unknown[] = [];
  for (const dir of made) {
    try {
      rmSync(dir, { force: true, maxRetries: 5, recursive: true });
    } catch (err) {
      failed.push(err);
    }
  }
  made.clear();
  if (failed.length) {
    throw new AggregateError(failed, `Could not remove ${failed.length} temp directories`);
  }
}
