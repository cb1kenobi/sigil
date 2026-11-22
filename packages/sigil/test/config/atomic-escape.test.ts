import {
  isMissing,
  json,
  physicalPath,
  writeAtomic,
  writeAtomicSync,
} from '../../src/config/index.js';
import { inertError } from '../../src/util/escape-controls.js';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A save that fails quotes the app's root as it is on disk, and it is escaped
 * where `writeAtomic()` throws (SIG-571).
 *
 * `atomic.ts` rethrows Node's own error, and Node's message quotes the path it
 * failed on -- so a root named `ESC ] 0 ; T BEL` retitled the terminal of whoever
 * read `config set`'s failure. The error is edited rather than wrapped, so what a
 * caller reads off it -- `code`, `errno`, `syscall`, `path` -- is what Node set,
 * and `path` in particular is the real path.
 *
 * None of the failures here depends on a permission, which a CI job running as
 * root does not have: a name too long for the temp file, a directory where the
 * target should be, and a parent that is a file. Written with escapes and never
 * raw bytes, for the reason `sources.test.ts` exists, and skipped on Windows,
 * which cannot create the name.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

const POSIX = process.platform !== 'win32';

let box: string;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'sigil-atomic-escape-'));
});

afterEach(() => {
  rmSync(box, { force: true, recursive: true });
});

/** The hostile directory, made. */
function root(): string {
  const dir = join(box, `root-${HOSTILE}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A target whose temp file's name cannot exist: the temp name is the target's
 * with a suffix, so a name at the limit refuses the open with `ENAMETOOLONG`,
 * which quotes the path and needs no permission to provoke.
 */
function tooLong(): string {
  return join(root(), `${'a'.repeat(250)}.json`);
}

/** A directory where the file should be, so the temp file opens and the rename is refused. */
function directoryTarget(): string {
  const path = join(root(), 'config.json');
  mkdirSync(path);
  return path;
}

/** A path under a regular file, which is refused before any temp file exists. */
function underFile(): string {
  const file = join(root(), 'file');
  writeFileSync(file, 'x');
  return join(file, 'inside', 'config.json');
}

type Failure = { code: string; make: () => string; syscall: string };

const FAILURES: Record<string, Failure> = {
  'a temp file that cannot be opened': {
    code: 'ENAMETOOLONG',
    make: tooLong,
    syscall: 'open',
  },
  'a rename over a directory': { code: 'EISDIR', make: directoryTarget, syscall: 'rename' },
  // resolved before anything is made, so it is the resolution that refuses
  'a path under a file': { code: 'ENOTDIR', make: underFile, syscall: 'realpath' },
};

/** What a write throws, from the async one and from the sync one. */
async function caught(work: () => unknown): Promise<Error & Record<string, unknown>> {
  try {
    await work();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('expected the write to fail');
}

/** Asserts a message names the path escaped and holds nothing a terminal acts on. */
function expectInert(text: string): void {
  expect(text).toContain(ESCAPED);
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\u0007');
  expect(text.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
}

describe.skipIf(!POSIX)('a save that fails under a directory with a control character', () => {
  for (const [name, failure] of Object.entries(FAILURES)) {
    describe(`over ${name}`, () => {
      for (const kind of ['async', 'sync'] as const) {
        it(`should say ${failure.syscall} with the path escaped, ${kind}`, async () => {
          const path = failure.make();
          const e = await caught(() =>
            kind === 'async' ? writeAtomic(path, 'x') : writeAtomicSync(path, 'x')
          );

          expect(e.message).toContain(failure.code);
          expectInert(e.message);
          // the stack's header is built once, from the message the error was made
          // with, and it is what `DEBUG=sigil:error` and an uncaught throw print
          expectInert(String(e.stack).split('\n    at ')[0] ?? '');
        });

        it(`should keep what a caller reads off the error, ${kind}`, async () => {
          const path = failure.make();
          const e = await caught(() =>
            kind === 'async' ? writeAtomic(path, 'x') : writeAtomicSync(path, 'x')
          );

          expect(e).toBeInstanceOf(Error);
          expect(e.code).toBe(failure.code);
          expect(e.syscall).toBe(failure.syscall);
          expect(typeof e.errno).toBe('number');
          // the real path, which code uses to find the file again: it is the one
          // thing that must **not** be escaped
          expect(String(e.path)).toContain(HOSTILE);
          if (failure.syscall === 'rename') {
            // `dest` is the resolved path, which is `/private/var` where `tmpdir()`
            // says `/var`, so it is the name that is compared
            expect(String(e.dest)).toContain(HOSTILE);
            expect(basename(String(e.dest))).toBe(basename(path));
          }
        });
      }
    });
  }

  it('should not read a failed save as a missing file, which is decided by the code', async () => {
    // `isMissing()` and the store kit ask `code`, so editing the message must not
    // move the answer either way: a code of `ENOENT` is missing whatever it quotes
    expect(isMissing(await caught(() => writeAtomic(underFile(), 'x')))).toBe(false);
    expect(isMissing(await caught(() => writeAtomic(directoryTarget(), 'x')))).toBe(false);
    expect(isMissing(Object.assign(new Error(`ENOENT ${HOSTILE}`), { code: 'ENOENT' }))).toBe(true);
  });

  it('should escape what mkdirOwnerSync() refuses with, which is raised outside atomic.ts', async () => {
    // a dangling link where a directory should be: `mkdir` answers `ENOENT`
    // naming the link, and needs no permission to provoke
    const dir = root();
    symlinkSync(join(dir, 'missing'), join(dir, 'link'));
    const target = join(dir, 'link', 'config.json');

    for (const e of [
      await caught(() => writeAtomic(target, 'x')),
      await caught(() => writeAtomicSync(target, 'x')),
    ]) {
      expect(e.syscall).toBe('mkdir');
      expectInert(e.message);
    }
  });

  it('should leave no temp file behind where the rename failed', async () => {
    const path = directoryTarget();
    await caught(() => writeAtomic(path, 'x'));

    expect(readdirSync(root())).toEqual(['config.json']);
  });

  it('should be escaped through a store, which is what `config set` writes with', async () => {
    const path = tooLong();

    const e = await caught(() => json(path).write({ a: 1 }));
    expectInert(e.message);
    expect(e.code).toBe('ENAMETOOLONG');
    expect(String(e.path)).toContain(HOSTILE);

    const sync = await caught(() => json(path).writeSync({ a: 1 }));
    expectInert(sync.message);
    expect(sync.code).toBe('ENAMETOOLONG');
  });

  it('should escape what physicalPath() refuses with, which is public', () => {
    let e: (Error & Record<string, unknown>) | undefined;
    try {
      physicalPath(underFile());
    } catch (error) {
      e = error as Error & Record<string, unknown>;
    }

    expect(e?.code).toBe('ENOTDIR');
    expectInert(e?.message ?? '');
  });

  it('should leave a message with nothing to escape as it was', async () => {
    const dir = join(box, 'plain');
    mkdirSync(join(dir, 'config.json'), { recursive: true });
    const e = await caught(() => writeAtomic(join(dir, 'config.json'), 'x'));

    expect(e.code).toBe('EISDIR');
    // the message quotes the resolved path, which is `/private/var` where
    // `tmpdir()` says `/var`, so it is the name that is asked for
    expect(e.message).toContain(`${basename(dir)}`);
    expect(e.message).not.toContain('\\x');
  });
});

describe('inertError()', () => {
  it('should return what is not an error as it came', () => {
    const odd = { message: 7 };
    expect(inertError(undefined)).toBeUndefined();
    expect(inertError('a\u001b')).toBe('a\u001b');
    expect(inertError(odd)).toBe(odd);
  });

  it('should be idempotent and keep the identity of the error', () => {
    const e = Object.assign(new Error(`open '${HOSTILE}'`), { code: 'EACCES', path: HOSTILE });
    const same = inertError(inertError(e));

    expect(same).toBe(e);
    expect(e.message).toBe(`open '${ESCAPED}'`);
    expect(e.path).toBe(HOSTILE);
    expect(e.stack?.split('\n')[0]).toBe(`Error: open '${ESCAPED}'`);
  });

  it('should still throw what it cannot edit', () => {
    const frozen = Object.freeze(new Error(`open '${HOSTILE}'`));

    expect(inertError(frozen)).toBe(frozen);
  });
});
