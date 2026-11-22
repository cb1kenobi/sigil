import { createConfigSync, json, readText, readTextSync } from '../../src/config/index.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A config file's path is quoted by every message that names the file, and it is
 * the app's root as it is on disk (SIG-551).
 *
 * `readSigilConfig()` in the toolchain reads an app's `sigil.json` through
 * `json()`, and a failure printed the path exactly as the file system held it --
 * so a root named `ESC ] 0 ; T BEL` retitled the terminal of whoever read the
 * error. The rule is that a value an error echoes is escaped where it is thrown,
 * and it is the store's message that quotes the path, so it is the store that
 * escapes it: every app reading a config file gets it, and the toolchain needs
 * no wrap of its own.
 *
 * Written with escapes and never raw bytes, for the reason `sources.test.ts`
 * exists. A control character in a directory name cannot be created on Windows,
 * so the file is under one only where the platform can make it.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

const POSIX = process.platform !== 'win32';

let box: string;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'sigil-path-escape-'));
});

afterEach(() => {
  rmSync(box, { force: true, recursive: true });
});

/** A directory with the hostile name in it, holding `config.json` with these bytes. */
function dirty(bytes: Uint8Array | string): string {
  const dir = join(box, `root-${HOSTILE}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, bytes);
  return path;
}

/** A directory where the file should be, which reads as `EISDIR` on every platform. */
function dirtyDirectory(): string {
  const path = join(box, `root-${HOSTILE}`, 'config.json');
  mkdirSync(path, { recursive: true });
  return path;
}

/** Asserts a message names the path escaped and holds nothing a terminal acts on. */
function expectInert(message: string): void {
  expect(message).toContain(ESCAPED);
  // every control character but the newline a message may be made of, and no line
  // that is the hostile one's forged second line
  expect(message.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  expect(message.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
}

/** The message of whatever `work` throws, or rejects with. */
async function said(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

describe.skipIf(!POSIX)(
  'a config file under a directory with a control character in its name',
  () => {
    describe('that holds invalid JSON', () => {
      it('should be escaped by a read', async () => {
        const store = json(dirty('{ "a": }'));

        expectInert(await said(() => store.read()));
        expectInert(await said(() => store.readSync()));
      });

      it('should be escaped when a string is not closed', async () => {
        expectInert(await said(() => json(dirty('{ "a": "x')).readSync()));
      });

      it('should be escaped when a comment is not closed', async () => {
        expectInert(await said(() => json(dirty('{ "a": 1 /* x')).readSync()));
      });

      it('should be escaped when it holds a line separator outside a string', async () => {
        expectInert(await said(() => json(dirty('{ "a": 1 }\u2028')).readSync()));
      });
    });

    describe('that is not UTF-8', () => {
      it('should be escaped when a byte is invalid', async () => {
        const store = json(dirty(Buffer.from([0x7b, 0xe9, 0x7d])));

        expectInert(await said(() => store.read()));
        expectInert(await said(() => store.readSync()));
      });

      it('should be escaped when it starts with a UTF-16 byte order mark', async () => {
        const store = json(dirty(Buffer.from('\uFEFF{}', 'utf16le')));

        expectInert(await said(() => store.read()));
        expectInert(await said(() => store.readSync()));
      });
    });

    describe('that cannot be read', () => {
      it('should be escaped, both in the path and in what the system said', async () => {
        const path = dirtyDirectory();

        for (const message of [
          await said(() => json(path).read()),
          await said(() => json(path).readSync()),
          await said(() => readText(path)),
          await said(() => readTextSync(path)),
        ]) {
          expect(message).toMatch(/^Failed to read /);
          expectInert(message);
        }
      });
    });

    describe('that is under something that is not a directory', () => {
      it('should be escaped in what the system said, which quotes the path itself', async () => {
        // `EISDIR` quotes no path, so a directory proves nothing about the second
        // escape: `ENOTDIR` names the one it failed to open
        const under = join(dirty('x'), 'inside.json');

        for (const message of [
          await said(() => json(under).read()),
          await said(() => json(under).readSync()),
          await said(() => readText(under)),
          await said(() => readTextSync(under)),
        ]) {
          expect(message).toMatch(/^Failed to read /);
          expect(message).toContain('ENOTDIR');
          expectInert(message);
        }
      });
    });

    describe('that holds something other than an object', () => {
      it('should be escaped', async () => {
        const store = json(dirty('42'));

        expectInert(await said(() => store.read()));
        expectInert(await said(() => store.readSync()));
      });
    });

    describe('that is written to', () => {
      it('should be escaped when the value cannot be held', async () => {
        const store = json(dirty('{}'));
        const message = await said(() => store.write({ a: () => 1 }));

        expect(message).toMatch(/^Cannot write /);
        expectInert(message);
      });

      it('should be escaped when a claimed path runs through something that is not an object', async () => {
        const store = json(dirty('{ "a": 1 }'));
        const message = await said(() => store.write({ a: { b: 2 } }, { paths: ['a.b'] }));

        expect(message).toContain('is not an object');
        expectInert(message);
      });

      it('should be escaped when what it holds does not parse', async () => {
        const store = json(dirty('{ "a": }'));

        expectInert(await said(() => store.write({ a: 1 })));
      });
      describe('in a read-only layer', () => {
        it('should be escaped when a delete names the file it is set in and the one to set it in', () => {
          const dir = join(box, `root-${HOSTILE}`);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'system.json'), '{ "a": 1 }');
          writeFileSync(join(dir, 'user.json'), '{}');
          const config = createConfigSync({
            layers: [
              { name: 'system', readOnly: true, store: json(join(dir, 'system.json')) },
              { name: 'user', store: json(join(dir, 'user.json')) },
            ],
          });

          expectInert(
            (() => {
              try {
                config.delete('a');
              } catch (error) {
                return (error as Error).message;
              }
              throw new Error('expected it to refuse');
            })()
          );
        });
      });
    });
  }
);
