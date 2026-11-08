/**
 * A file's identity, as `sigil reference`'s sweep reads it, past 2^53.
 *
 * A file of its own because it wraps `node:fs`, and a `vi.mock` is hoisted over
 * the whole file it is in: `reference.test.ts` reads and writes real files
 * throughout, and none of it should run through a stub it did not ask for.
 *
 * The stub is the only way to stage this. NTFS hands out 64-bit file IDs and
 * which ones is not something a test chooses, so the collision SIG-325 met on a
 * Windows runner cannot be provoked on demand -- and APFS and ext4 hand out IDs
 * nowhere near 2^53 at all. So two real files are written and `statSync()` is
 * made to report them under two IDs that differ only beyond 2^53, the way Node
 * itself does: exact when asked for a bigint, and through `Number()` when not,
 * which is where the two become one.
 */

import { syncReference } from '../src/reference/write.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** The IDs a path is reported under, by path. */
const ids = new Map<string, { dev: bigint; ino: bigint }>();

/** Every path the stub answered for, so a sweep that stopped asking is caught. */
const asked: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();

  return {
    ...real,
    statSync(path: string, opts?: { bigint?: boolean }): unknown {
      const it = (real.statSync as (p: string, o?: unknown) => unknown)(path, opts);
      const id = ids.get(path);

      if (id === undefined || it === undefined) {
        return it;
      }
      asked.push(path);
      // what Node does with a 64-bit ID: a bigint when asked for one, and the
      // nearest double when not
      return opts?.bigint
        ? Object.assign(it as object, id)
        : Object.assign(it as object, { dev: Number(id.dev), ino: Number(id.ino) });
    },
  };
});

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('identity', () => {
  it('should not read two files as one where their IDs differ past 2^53', () => {
    // the ID SIG-325's Windows runner reported, and the one beside it: a temp
    // file renamed over an original is handed a neighbouring ID, and past 2^53
    // a double cannot tell neighbours apart -- so as numbers these are one
    // file, and the stale page read as the page this run wrote
    const one = 11_821_949_023_213_364n;
    const two = 11_821_949_023_213_365n;

    // the premise, asserted rather than trusted: if these stop colliding as
    // numbers, the test below stops being about anything
    expect(Number(one)).toBe(Number(two));

    const dir = mkdtempSync(join(tmpdir(), 'sigil-reference-identity-'));
    temps.push(dir);

    const page = join(dir, 'a.md');
    const gone = join(dir, 'gone.md');

    writeFileSync(page, 'one\n', 'utf-8');
    writeFileSync(gone, 'old\n', 'utf-8');
    ids.set(page, { dev: 7n, ino: one });
    ids.set(gone, { dev: 7n, ino: two });

    const changes = syncReference(dir, [{ body: 'one\n', file: 'a.md' }], {
      check: true,
      sweep: true,
    });

    expect(changes).toStrictEqual([{ kind: 'stale', path: expect.stringContaining('gone.md') }]);
    // and both were asked about through the stub, so a sweep that moved to
    // another call -- where the real IDs differ -- fails here rather than
    // passing over a question it no longer asks
    expect(new Set(asked)).toStrictEqual(new Set([page, gone]));
  });
});
