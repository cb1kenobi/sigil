import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('writing an executable', () => {
  /**
   * Every test file that could write one: the tests of every package, the
   * examples, and the website's tests -- tracked or merely not ignored, as
   * `copy-fixture.test.ts` reads them for the same kind of rule.
   */
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const sources = spawnSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'packages/*/test/**',
      'examples/**',
      'website/test/**',
    ],
    { cwd: repo, encoding: 'utf-8' }
  )
    .stdout.split('\n')
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
    .filter((path) => !path.includes('/fixtures/'));

  /**
   * The modes with an execute bit set that are not a stub somebody runs, and
   * why. Counted rather than exempted wholesale, so that a stub added to one
   * of these files is a decision somebody makes.
   */
  const exempt: Record<string, { count: number; why: string }> = {
    'packages/cli/test/copy-fixture.test.ts': {
      count: 1,
      why: 'gives a directory back the mode it took away',
    },
    'packages/cli/test/executable.ts': {
      count: 1,
      why: 'the helper itself, in the comment that says what it replaces',
    },
    'packages/sigil/test/completion-install.test.ts': {
      count: 4,
      why: 'directories made unwritable and given back',
    },
    'packages/sigil/test/components/editor.test.ts': {
      count: 1,
      why: 'an empty `vi` on a stub PATH that is looked up and never run',
    },
    'packages/sigil/test/mkdir-owner-sync-mode.test.ts': {
      count: 2,
      why: 'directories, which is what the file is about',
    },
    'packages/sigil/test/mkdir-owner-sync.test.ts': {
      count: 3,
      why: 'the mode a mocked `mkdirSync` was asked for',
    },
    'packages/sigil/test/trash.test.ts': {
      count: 5,
      why: 'trash directories and the mounts they sit on',
    },
    'packages/sigil/test/which.test.ts': {
      count: 1,
      why: 'files `which` is asked to find, which it never runs',
    },
  };

  /**
   * A `mode:` option, or a `chmod` call's mode, spelled as an octal literal.
   * Which of them has an execute bit is decided below rather than in the
   * pattern.
   */
  const mode = /\bmode:\s*0o([0-7]+)|\bchmod(?:Sync)?\([^;]*?,\s*0o([0-7]+)\s*\)/g;

  const executables = Object.fromEntries(
    sources
      .map((path): [string, number] => [
        path,
        [...readFileSync(join(repo, path), 'utf-8').matchAll(mode)].filter(
          ([, option, chmod]) => Number.parseInt((option ?? chmod) as string, 8) & 0o111
        ).length,
      ])
      .filter(([, count]) => count)
  );

  it('should find the sources it means to check', () => {
    // a listing that came back empty would pass the test below by checking
    // nothing -- git missing, or a pathspec that stopped matching
    expect(sources).toContain('packages/cli/test/runtimes-target.test.ts');
    expect(sources).toContain('packages/sigil/test/which.test.ts');
    expect(sources.length).toBeGreaterThan(100);
  });

  it('should go through writeExecutable() everywhere else', () => {
    // a stub given its execute bit by a write or a `chmod` in this process and
    // then run is the race this file is about: a fork in another thread of the
    // pool can still hold it open for writing when it is executed, which Linux
    // refuses
    expect(executables).toStrictEqual(
      Object.fromEntries(Object.entries(exempt).map(([path, { count }]) => [path, count]))
    );
  });
});
