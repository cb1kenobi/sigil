import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
});
