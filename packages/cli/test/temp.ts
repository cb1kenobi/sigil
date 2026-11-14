import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every directory `tempDir()` has made in this test file and not yet removed. */
const made = new Set<string>();

/**
 * How long a removal may take before vitest calls it hung: the budget the
 * `afterAll` in `test/setup.ts` is given, and the one a test removing its own
 * directory early gives its hook.
 *
 * Six times vitest's 10-second default, because Windows is where removal is
 * slow and the default was too little there: Defender scans every file a test
 * has just written, and `new-tui.test.ts` ran past 10 seconds in this hook after
 * every test had passed (SIG-426). A removal that cannot finish does not hang --
 * `rm` gives up after `maxRetries` and throws, which fails the file -- so this
 * only ever fires on a removal that is slow, and slow is not what the hook is
 * there to catch.
 */
export const REMOVAL_TIMEOUT = 60_000;

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
 * Every directory `removeTempDir()` has removed in this test file, which
 * `removeTempDirs()` checks again when the file ends.
 */
const removed = new Set<string>();

/** Removes a directory, retrying for Windows. */
function remove(dir: string): Promise<void> {
  // `maxRetries` is for Windows, where a directory a child process has only
  // just let go of can still answer `EBUSY` or `EPERM` for a moment
  return rm(dir, { force: true, maxRetries: 5, recursive: true });
}

/**
 * Removes one directory `tempDir()` made, now rather than when the file ends.
 *
 * For a directory that is heavy and of no use to any other test, so that it
 * goes when its test finishes rather than piling up for the `afterAll`. A
 * directory that cannot be removed stays on the list, so the file's own removal
 * tries it once more, and the error is thrown. One that is removed is checked
 * again when the file ends, since it was removed while the rest of the file
 * could still write to it.
 *
 * @param dir - A directory `tempDir()` returned.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await remove(dir);
  made.delete(dir);
  removed.add(dir);
}

/**
 * Removes every directory `tempDir()` made and has not removed yet, and any
 * that `removeTempDir()` removed and that has come back.
 *
 * All at once rather than one after another, so that one directory waiting out
 * its retries does not hold up the rest. A directory that still cannot be
 * removed fails the file rather than leaking quietly, which is the failure this
 * exists to stop. So does one that came back: something wrote to it after it
 * was removed -- a child its test started and did not wait for -- and nothing
 * else would ever see it. It is removed again, and the file still fails, since
 * a removal that has to be repeated is a race that will one day lose.
 */
export async function removeTempDirs(): Promise<void> {
  const back = [...removed].filter((dir) => existsSync(dir));
  removed.clear();
  const results = await Promise.allSettled([...made, ...back].map((dir) => remove(dir)));
  made.clear();
  const failed = [
    ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    ...back.map((dir) => new Error(`${dir} was written to after it was removed`)),
  ];
  if (failed.length) {
    throw new AggregateError(failed, `Could not remove ${failed.length} temp directories`);
  }
}
