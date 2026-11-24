import { main } from '../src/index.js';
import type { Schema } from '../src/types.js';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `main()` guards its output streams and writes its own output whole (SIG-538,
 * SIG-542).
 *
 * `mycli list | head -1` ended in Node's `EPIPE` dump because nothing listened for
 * the stream's `error` event, and `mycli --help > file` exited 0 over a cut-off
 * file because Node discards the count `fs.writeSync()` returns. `main()` writes
 * the help screen, `--version` and a command's serialized output, so both are its
 * to fix for every app. The spawned halves, with a real pipe and a real size
 * limit, are in `packages/cli/test/output.test.ts`.
 *
 * `node:fs`'s `writeSync` is the one thing replaced: a kernel that takes part of a
 * write is not something a test can ask for portably, and the real call is what
 * every other descriptor gets.
 */

const room = vi.hoisted(() => ({ left: Infinity }));

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    // takes what is left of `room` and then fails the way a full disk does, so
    // the first call is a short write and the second is the real errno
    writeSync(fd: number, ...rest: unknown[]) {
      if (room.left === Infinity) {
        return (real.writeSync as (...args: unknown[]) => number)(fd, ...rest);
      }
      const [bytes, offset = 0] = rest as [Uint8Array, number?];
      if (room.left <= 0) {
        throw Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG' });
      }
      const taken = Math.min(room.left, bytes.length - offset);
      room.left -= taken;
      return real.writeSync(fd, bytes, offset, taken);
    },
  };
});

const schema = (): Schema => ({
  commands: {
    list: {
      desc: 'List the items',
      format: true,
      run: () => ({ items: Array.from({ length: 40 }, (_, i) => `item-${i}`) }),
    },
  },
  desc: 'A program whose help screen is longer than one block',
  name: 'out',
  version: '1.2.3',
});

describe('main() and the streams it writes to', () => {
  let dir: string;
  let file: string;
  let fd: number;
  let exitCode: typeof process.exitCode;
  let err: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigil-output-main-'));
  });
  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    err = '';
    file = join(dir, `out-${Math.random().toString(36).slice(2)}.txt`);
    fd = openSync(file, 'w');
    // a worker's stdout has no descriptor, so it is given the real one of a real
    // file: that is the whole of what makes `main()` treat it as a redirect
    Object.defineProperty(process.stdout, 'fd', { configurable: true, value: fd });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (process.stdout as { fd?: number }).fd;
    closeSync(fd);
    room.left = Infinity;
    process.exitCode = exitCode;
  });

  describe('a document redirected to a file', () => {
    it('should write the whole of the help screen when nothing limits the file', async () => {
      await main({ argv: ['--help'], schema: schema() });

      expect(readFileSync(file, 'utf-8')).toContain('A program whose help screen');
      expect(process.exitCode).toBe(0);
      expect(err).toBe('');
    });

    it('should fail --help when the file takes only part of it', async () => {
      room.left = 40;

      await main({ argv: ['--help'], schema: schema() });

      expect(readFileSync(file, 'utf-8')).toHaveLength(40);
      expect(process.exitCode).toBe(1);
      expect(err).toContain('The output was cut off: 40 of');
      expect(err).toContain('(EFBIG)');
      // the message is an error and not a crash
      expect(err).not.toMatch(/\n\s+at /);
    });

    it('should fail --version when none of it lands', async () => {
      room.left = 0;

      await main({ argv: ['--version'], schema: schema() });

      expect(process.exitCode).toBe(1);
      expect(err).toContain('The output was cut off: 0 of 6 bytes were written (EFBIG).');
    });

    it('should write --version whole when nothing limits the file', async () => {
      await main({ argv: ['--version'], schema: schema() });

      expect(readFileSync(file, 'utf-8')).toBe('1.2.3\n');
      expect(process.exitCode).toBeUndefined();
    });

    it('should fail a command’s serialized output that was cut off', async () => {
      // the one that matters most: data another program will read, and a cut-off
      // JSON file that exited 0 fails somewhere else, later
      room.left = 30;

      await main({ argv: ['list', '--json'], schema: schema() });

      expect(readFileSync(file, 'utf-8')).toHaveLength(30);
      expect(process.exitCode).toBe(1);
      expect(err).toContain('The output was cut off');
    });

    it('should write a command’s serialized output whole when nothing limits the file', async () => {
      await main({ argv: ['list', '--json'], schema: schema() });

      expect(JSON.parse(readFileSync(file, 'utf-8')).items).toHaveLength(40);
      expect(process.exitCode).toBeUndefined();
    });

    it('should hand a cut-off to errorHandler: false as a throw', async () => {
      room.left = 0;

      await expect(
        main({ argv: ['--version'], schema: schema(), settings: { errorHandler: false } })
      ).rejects.toThrow('The output was cut off');
    });

    it('should leave a capture of stdout to the capture', async () => {
      // a stream whose `write` was replaced is somebody capturing, and the
      // descriptor under it is not theirs to bypass
      room.left = 0;
      const chunks: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
      });

      await main({ argv: ['--version'], schema: schema() });

      expect(chunks).toEqual(['1.2.3\n']);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('the listener on the streams', () => {
    /** Takes off what a `main()` put on the worker's own streams, which a bin never does. */
    function listenersOf() {
      return [process.stdout, process.stderr].map((s) => new Set(s.listeners('error')));
    }

    afterEach(() => {
      // restoring mocks leaves a guard behind by design, and the worker's streams
      // outlive this file
      for (const stream of [process.stdout, process.stderr]) {
        stream.removeAllListeners('error');
      }
    });

    it('should be on before the parse, so --help | head is covered', async () => {
      let during: number[] = [];
      const withHook: Schema = {
        ...schema(),
        hooks: {
          beforeParse: () => {
            during = [process.stdout, process.stderr].map((s) => s.listenerCount('error'));
          },
        },
      };

      await main({ argv: ['--version'], schema: withHook });

      expect(during).toEqual([1, 1]);
    });

    it('should leave a reader that went away quiet, and the exit code the command’s own', async () => {
      await main({
        argv: ['list'],
        schema: {
          ...schema(),
          commands: {
            list: {
              run: () => {
                process.stdout.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
                process.stderr.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
                process.exitCode = 3;
              },
            },
          },
        },
      });

      expect(process.exitCode).toBe(3);
    });

    it('should still fail a real write error', async () => {
      await main({ argv: ['--version'], schema: schema() });

      expect(() =>
        process.stdout.emit('error', Object.assign(new Error('no space'), { code: 'ENOSPC' }))
      ).toThrow('no space');
      expect(() =>
        process.stderr.emit('error', Object.assign(new Error('too big'), { code: 'EFBIG' }))
      ).toThrow('too big');
    });

    it('should not stack a listener for a second main(), nested or not', async () => {
      const before = listenersOf();

      await main({
        argv: ['outer'],
        schema: {
          ...schema(),
          commands: {
            outer: {
              run: async () => {
                await main({ argv: ['--version'], schema: schema() });
              },
            },
          },
        },
      });
      await main({ argv: ['--version'], schema: schema() });

      for (const [i, stream] of [process.stdout, process.stderr].entries()) {
        const added = stream.listeners('error').filter((fn) => !before[i]!.has(fn));
        expect(added, i === 0 ? 'stdout' : 'stderr').toHaveLength(1);
      }
    });
  });
});
