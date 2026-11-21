import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.js';
import { escapeControls } from '@ttylabs/sigil/error-handler';
import { candidates } from '@ttylabs/sigil/which';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every version the runtime picker offers has passed `isVersion()` (SIG-553).
 *
 * `isVersion()` calls itself the one test every source of a version goes
 * through, and three of them did not: what a runtime on `PATH` prints for
 * `--version`, the directory names in sigil's own runtime cache, and the ones in
 * Bun's. A row's value is `<runtime>@<version>`, which `parseSpec()` refuses
 * when the version is not one, and its label is drawn, so a control character
 * in it is garbled by the canvas.
 *
 * `local()` is asked against a real directory and a real `PATH`, because that is
 * where the names come from; `choices()` is asked against lists, because a count
 * of rows needs no spawn. `cache()` is mocked for the reason
 * `runtimes-cache.test.ts` records, and `os.homedir()` is mocked to a directory of this file's own,
 * which is where Bun's cache is.
 */

const box = tempDir('sigil-picker-');

vi.mock('@ttylabs/sigil/paths', () => ({
  cache: (...paths: string[]) => join(box, 'cache', ...paths),
}));

/**
 * Bun's cache is under `os.homedir()`, which a test cannot move by setting
 * `HOME`: vitest runs this in a worker thread, whose `process.env` is a copy,
 * and `os.homedir()` reads the real one. So it is mocked, which is what
 * `runtimes-cache.test.ts` does for `cache()` for a neighbouring reason.
 */
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => join(box, 'home'),
}));

const { bunTriple, choices, local } = await import('../src/build/runtimes.ts');

/** The `PATH` this file started with, which `writeExecutable()` needs for `sh` and `cat`. */
const REAL_PATH = process.env.PATH ?? '';
const POSIX = process.platform !== 'win32';
const EXE = (runtime: string) => (POSIX ? runtime : `${runtime}.exe`);

/** The host's own target, which is what decides which of Bun's cache entries run here. */
const target = {
  arch: process.arch === 'x64' ? 'x64' : 'arm64',
  platform:
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
} as const;

const found = (version: string, how: 'cache' | 'path') => ({ how, path: '/x', version });
const release = (version: string) => ({ major: Number(version.split('.')[0]), version });

/** A runtime directory in sigil's own cache, holding an executable. */
function cached(runtime: 'bun' | 'node', name: string): void {
  const dir = join(box, 'cache', 'sigil', 'runtimes', runtime, name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, EXE(runtime)), 'x');
}

/** An entry in Bun's own download cache, which is the host's triple and a version. */
function bunCache(rest: string): void {
  const dir = join(box, 'home', '.bun', 'install', 'cache');

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${bunTriple(target)}-v${rest}`), 'x');
}

/** Puts a `bun` that prints `output` for `--version` alone on `PATH`. */
function onPath(runtime: 'bun' | 'node', output: string): void {
  const bin = join(box, 'bin');
  const name = [...candidates(runtime, { path: bin })].find((one) => one.startsWith(bin));

  mkdirSync(bin, { recursive: true });
  expect(name, 'candidates() offered nothing inside the fixture directory').toBeDefined();
  // the stub is written with the real `PATH`, and only then is `PATH` made to
  // hold nothing else
  vi.stubEnv('PATH', REAL_PATH);
  writeExecutable(name as string, `#!/bin/sh\n[ "$1" = "--version" ] && printf '${output}\\n'\n`);
  vi.stubEnv('PATH', bin);
}

beforeEach(() => {
  rmSync(join(box, 'cache'), { force: true, recursive: true });
  rmSync(join(box, 'home'), { force: true, recursive: true });
  rmSync(join(box, 'bin'), { force: true, recursive: true });
  mkdirSync(join(box, 'bin'), { recursive: true });
  // an empty directory rather than no `PATH`, so nothing real is found and
  // nothing here depends on what this machine has installed
  vi.stubEnv('PATH', join(box, 'bin'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('what the picker lists from this machine', () => {
  it('should leave out a cache directory whose name is not a version', () => {
    cached('node', '26.12.1');
    cached('node', '26.12.1-rc.1');
    cached('node', '../x');
    cached('node', 'v26.12.1');

    expect(local('node', target).map((one) => one.version)).toEqual(['26.12.1']);
  });

  it.skipIf(!POSIX)('should leave out a cache directory named with a control character', () => {
    cached('bun', '1.3.0');
    cached('bun', `1.3.1${String.fromCharCode(0x1b)}[31m`);

    expect(local('bun', target).map((one) => one.version)).toEqual(['1.3.0']);
  });

  it("should leave out an entry in Bun's own cache whose version is not one", () => {
    bunCache('1.3.0');
    bunCache('1.3.0-canary.5+abc');
    bunCache('');

    expect(local('bun', target).map((one) => one.version)).toEqual(['1.3.0']);
  });

  it.skipIf(!POSIX)('should answer a canary on PATH last, after every release', () => {
    cached('bun', '1.2.0');
    bunCache('1.3.0');
    onPath('bun', '1.4.0-canary.5+abc');

    const all = local('bun', target);

    expect(all.map((one) => one.version)).toEqual(['1.3.0', '1.2.0', '1.4.0-canary.5+abc']);
    expect(all.at(-1)?.how).toBe('path');
  });
});

describe('a runtime on PATH that is not a release', () => {
  it.skipIf(!POSIX)('should be one row named for the runtime, not a version of it', () => {
    onPath('bun', '1.3.0-canary.5+abc');

    const rows = choices(
      { bun: local('bun', target), node: [] },
      { bun: [release('1.4.4')], node: [] }
    );
    const bun = rows.filter((row) => row.value === 'bun' || row.value.startsWith('bun@'));

    // `bun@1.3.0-canary.5+abc` is a value `parseSpec()` refuses; the bare name is
    // what `--runtime bun` resolves to, which is this same executable
    expect(bun.map((row) => row.value)).toEqual(['bun@1.4.4', 'bun']);
    expect(bun[1]?.label).toBe('bun 1.3.0-canary.5+abc  (installed, not a release)');
  });

  it.skipIf(!POSIX)('should show what it printed with its control characters escaped', () => {
    onPath('bun', `1.3.0\\033]0;PWNED\\007`);

    const rows = choices({ bun: local('bun', target), node: [] }, { bun: [], node: [] });
    const row = rows.find((one) => one.value === 'bun');
    const printed = `1.3.0${String.fromCharCode(0x1b)}]0;PWNED${String.fromCharCode(0x07)}`;

    expect(row?.label).toBe(`bun ${escapeControls(printed)}  (installed, not a release)`);
    expect(row?.label).not.toContain(String.fromCharCode(0x1b));
    expect(row?.label).not.toContain(String.fromCharCode(0x07));
  });

  it.skipIf(!POSIX)('should still be an ordinary row when what it printed is a release', () => {
    onPath('bun', '1.3.0');

    const rows = choices({ bun: local('bun', target), node: [] }, { bun: [], node: [] });

    expect(rows.filter((row) => row.value === 'bun')).toHaveLength(0);
    expect(rows.filter((row) => row.value === 'bun@1.3.0')).toHaveLength(1);
    expect(rows.find((row) => row.value === 'bun@1.3.0')?.label).toContain('installed');
  });
});

describe('what the picker offers', () => {
  it('should leave out a version nobody validated, whichever list it came from', () => {
    const rows = choices(
      {
        bun: [found('1.3.0', 'cache'), found('1.3.0-canary.5+abc', 'cache')],
        node: [found('../x', 'cache'), found('26.12.1', 'cache')],
      },
      { bun: [release('1.4.4'), release('1.4.4\u001b[31m')], node: [] }
    );

    expect(rows.map((row) => row.value)).toEqual([
      'bun@1.4.4',
      'bun@1.3.0',
      'node@26.12.1',
      'custom:bun',
      'custom:node',
    ]);
  });

  it('should show a long version cut, and not whole', () => {
    const long = `1.3.0-${'x'.repeat(500)}`;
    const rows = choices({ bun: [found(long, 'path')], node: [] }, { bun: [], node: [] });
    const row = rows.find((one) => one.value === 'bun');

    expect(row?.label.length).toBeLessThan(80);
    expect(row?.label).toContain('…');
  });

  it('should offer a Node that is not a release only if it can package itself', () => {
    const rows = choices({ bun: [], node: [found('26.1.0-rc.1', 'path')] }, { bun: [], node: [] });

    expect(rows.find((row) => row.value === 'node')?.label).toBe(
      'node 26.1.0-rc.1  (installed, not a release)'
    );

    // `resolveExec()` would download one instead of using this, so a row
    // saying "the one on PATH" would be untrue of it
    const below = choices({ bun: [], node: [found('24.1.0-rc.1', 'path')] }, { bun: [], node: [] });
    const garbage = choices(
      { bun: [], node: [found('not a version', 'path')] },
      { bun: [], node: [] }
    );

    expect(below.some((row) => row.value === 'node')).toBe(false);
    expect(garbage.some((row) => row.value === 'node')).toBe(false);
  });

  it('should never take a cached entry for the runtime on PATH', () => {
    const rows = choices(
      { bun: [found('1.3.0-canary.5', 'cache')], node: [] },
      { bun: [], node: [] }
    );

    expect(rows.some((row) => row.value === 'bun')).toBe(false);
  });
});
