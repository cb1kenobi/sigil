/**
 * A rename Windows refuses because somebody else holds the target open
 * (SIG-415).
 *
 * `writeAtomic()` retries `EPERM`, `EBUSY` and `EACCES` on `win32` for about a
 * second and fails at once on everything else. This was **not reproduced** on
 * Windows first -- that is the decision recorded in `src/config/AGENTS.md` --
 * so what is pinned here is the staged shape: a `rename` that answers with the
 * code a scripted number of times and then does what it always did.
 *
 * `node:fs` and `node:fs/promises` are wrapped the way `atomic-temp.test.ts`
 * wraps them, and for the same reason it is a file of its own: `vi.mock` is
 * hoisted and module-wide. Nothing here waits: the async walk's `setTimeout`
 * and the sync walk's `Atomics.wait` are stubbed to record the delay they were
 * asked for, so no assertion reads a clock.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the next renames answer with, one entry per attempt; then the real call. */
let script: string[] = [];

/** How many times `rename` was called, async and sync alike. */
let attempts = 0;

/** The real platform, put back after a test pretends to be another. */
const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

/** The error `rename` is scripted to throw, numbered so the last one can be told apart. */
function refusal(code: string): Error {
  return Object.assign(new Error(`${code} on attempt ${attempts}`), { code });
}

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();

  return {
    ...real,
    renameSync(from: string, to: string): void {
      attempts++;
      const code = script.shift();
      if (code !== undefined) {
        throw refusal(code);
      }
      real.renameSync(from, to);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...real,
    async rename(from: string, to: string): Promise<void> {
      attempts++;
      const code = script.shift();
      if (code !== undefined) {
        throw refusal(code);
      }
      return real.rename(from, to);
    },
  };
});

const { writeAtomic, writeAtomicSync } = await import('../../src/config/atomic.js');

/** The most a busy rename may be retried: the schedule's own length. */
const RETRIES = 7;

/** The bound, in milliseconds, which the schedule is written to sum to. */
const BOUND = 1000;

let root: string;
let target: string;

/** The delays each walk was asked to wait, in order. */
const waited: number[] = [];

beforeEach(() => {
  script = [];
  attempts = 0;
  waited.length = 0;
  root = mkdtempSync(join(tmpdir(), 'sigil-busy-'));
  target = join(root, 'config.jsonc');
  writeFileSync(target, 'old');

  // neither walk may sleep, and each says how long it was asked to
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    waited.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  vi.spyOn(Atomics, 'wait').mockImplementation(((
    _array: Int32Array,
    _index: number,
    _value: number,
    ms?: number
  ) => {
    waited.push(ms ?? 0);
    return 'timed-out';
  }) as typeof Atomics.wait);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', origPlatform);
  rmSync(root, { force: true, recursive: true });
});

/** Pretends to be Windows, which is the only platform that retries. */
function asWindows(): void {
  Object.defineProperty(process, 'platform', { ...origPlatform, value: 'win32' });
}

/** Pretends to be Linux, where the first refusal is the answer. */
function asPosix(): void {
  Object.defineProperty(process, 'platform', { ...origPlatform, value: 'linux' });
}

/** Both walks, so that each claim is asserted of the pair rather than of one. */
const walks = [
  ['writeAtomic', async (text: string) => writeAtomic(target, text)],
  ['writeAtomicSync', async (text: string) => writeAtomicSync(target, text)],
] as const;

describe.each(walks)('a busy rename in %s', (_name, write) => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'should be retried on %s until it succeeds',
    async (code) => {
      asWindows();
      script = [code, code, code];

      await write('new');

      expect(attempts).to.equal(4);
      expect(readFileSync(target, 'utf8')).to.equal('new');
      expect(waited).to.deep.equal([10, 20, 40]);
      expect(readdirSync(root)).to.deep.equal(['config.jsonc']);
    }
  );

  it('should fail with the last error, its code and no temp file, once the bound is spent', async () => {
    asWindows();
    script = Array.from({ length: 100 }, () => 'EPERM');

    await expect(write('new')).rejects.toMatchObject({
      code: 'EPERM',
      message: `EPERM on attempt ${RETRIES + 1}`,
    });

    expect(attempts).to.equal(RETRIES + 1);
    expect(waited).to.have.length(RETRIES);
    expect(waited.reduce((a, b) => a + b, 0)).to.equal(BOUND);
    expect(readFileSync(target, 'utf8')).to.equal('old');
    expect(readdirSync(root)).to.deep.equal(['config.jsonc']);
  });

  it.each(['ENOSPC', 'EIO', 'EXDEV', 'ENOENT'])('should not retry %s', async (code) => {
    asWindows();
    script = [code];

    await expect(write('new')).rejects.toMatchObject({ code });

    expect(attempts).to.equal(1);
    expect(waited).to.deep.equal([]);
    expect(readdirSync(root)).to.deep.equal(['config.jsonc']);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('should not retry %s off Windows', async (code) => {
    asPosix();
    script = [code];

    await expect(write('new')).rejects.toMatchObject({ code });

    expect(attempts).to.equal(1);
    expect(waited).to.deep.equal([]);
    expect(readFileSync(target, 'utf8')).to.equal('old');
    expect(readdirSync(root)).to.deep.equal(['config.jsonc']);
  });

  it('should not retry a rename that went through', async () => {
    asWindows();

    await write('new');

    expect(attempts).to.equal(1);
    expect(waited).to.deep.equal([]);
    expect(existsSync(target)).to.equal(true);
  });
});
