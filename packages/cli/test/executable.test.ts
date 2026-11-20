import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

/**
 * `writeExecutable()`, which every stub a test runs is written with (SIG-482).
 *
 * The stubs are shell scripts, so running one is POSIX only; what it writes is
 * checked everywhere.
 */

const POSIX = process.platform !== 'win32';

/** A stub that says it ran, so a test can tell it ran rather than merely exited. */
const SAYS = (word: string): string => `#!/bin/sh\necho ${word}\n`;

/**
 * A worker thread that forks for as long as `stop` holds `0` -- what the other
 * test files in a `threads` pool are doing while this one writes a stub.
 */
const FORKER = `
const { spawnSync } = require('node:child_process');
const { workerData } = require('node:worker_threads');
const stop = new Int32Array(workerData);
while (Atomics.load(stop, 0) === 0) spawnSync('true');
`;

describe('writeExecutable()', () => {
  it('should write the bytes it was given and nothing else', () => {
    const dir = tempDir('sigil-executable-');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

    writeExecutable(join(dir, 'binary'), bytes);
    writeExecutable(join(dir, 'text'), SAYS('é'));

    expect(readFileSync(join(dir, 'binary')).equals(bytes)).toBe(true);
    expect(readFileSync(join(dir, 'text'), 'utf-8')).toBe(SAYS('é'));
  });

  it('should replace a file that is already there', () => {
    const dir = tempDir('sigil-executable-');
    const path = join(dir, 'stub');
    writeFileSync(path, 'a much longer file than the one that replaces it');

    writeExecutable(path, SAYS('second'));

    expect(readFileSync(path, 'utf-8')).toBe(SAYS('second'));
  });

  it('should say which file it could not write', () => {
    const dir = tempDir('sigil-executable-');

    expect(() => writeExecutable(join(dir, 'no-such-dir', 'stub'), SAYS('x'))).toThrow(
      /no-such-dir/
    );
  });

  it.skipIf(!POSIX)('should end with the mode it was asked for, and run', () => {
    const dir = tempDir('sigil-executable-');

    writeExecutable(join(dir, 'default'), SAYS('default'));
    writeExecutable(join(dir, 'owner'), SAYS('owner'), 0o700);

    expect(statSync(join(dir, 'default')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'owner')).mode & 0o777).toBe(0o700);
    expect(spawnSync(join(dir, 'default'), { encoding: 'utf-8' }).stdout).toBe('default\n');
    expect(spawnSync(join(dir, 'owner'), { encoding: 'utf-8' }).stdout).toBe('owner\n');
  });

  // Linux is the platform that refuses to execute a file with a writer, so it
  // is the one where this can fail. Every stub is spawned the moment it is
  // written, while three other threads of this process fork as fast as they
  // can: a descriptor for the stub open in this process at any point would be
  // copied into one of their children sooner or later, and the spawn after it
  // would be `ETXTBSY`
  it.runIf(process.platform === 'linux')(
    'should run what it wrote at once while other threads fork',
    async () => {
      const dir = tempDir('sigil-executable-race-');
      const stop = new SharedArrayBuffer(4);
      const forkers = Array.from(
        { length: 3 },
        () => new Worker(FORKER, { eval: true, workerData: stop })
      );
      const exited = forkers.map((one) => new Promise((resolve) => one.once('exit', resolve)));
      const failures: string[] = [];
      let runs = 0;

      try {
        const until = Date.now() + 2000;
        while (Date.now() < until) {
          const path = join(dir, `stub-${runs++}`);
          writeExecutable(path, SAYS('ran'));
          const ran = spawnSync(path, { encoding: 'utf-8' });
          if (ran.error || ran.stdout !== 'ran\n') {
            failures.push(ran.error?.message ?? `exit ${ran.status}: ${ran.stderr}`);
          }
        }
      } finally {
        Atomics.store(new Int32Array(stop), 0, 1);
        await Promise.all(exited);
      }

      expect(failures).toEqual([]);
      expect(runs).toBeGreaterThan(20);
    },
    30_000
  );
});
