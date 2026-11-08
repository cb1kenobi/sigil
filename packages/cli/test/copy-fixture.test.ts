import { copyFixture } from './copy-fixture.ts';
import { tempDir } from './temp.ts';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Every file under `dir`, relative to it and forward-slashed, sorted. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

/**
 * A fixture-shaped app with a build's scratch directory in it, as a fixture
 * looks while another worker is building it in place.
 */
function fixtureWithScratch(): string {
  const app = tempDir('sigil-copy-fixture-src-');
  mkdirSync(join(app, 'src', 'commands'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '.sigil', '0123456789abcdef'), { recursive: true });
  mkdirSync(join(app, 'src', 'node_modules'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}\n');
  writeFileSync(join(app, 'src', 'index.js'), 'export default {};\n');
  writeFileSync(join(app, 'src', 'commands', 'node_modules.js'), 'export default {};\n');
  writeFileSync(join(app, 'node_modules', '.sigil', '0123456789abcdef', 'entry.mjs'), '');
  writeFileSync(join(app, 'src', 'node_modules', 'stray.js'), '');
  return app;
}

describe('copyFixture()', () => {
  it('should copy the app and leave out every node_modules in it', () => {
    const to = tempDir('sigil-copy-fixture-dst-');

    copyFixture(fixtureWithScratch(), to);

    // a file merely *named* after the directory is still copied, which is what
    // matching a path segment rather than a substring buys
    expect(filesIn(to)).toStrictEqual([
      'package.json',
      'src/commands/node_modules.js',
      'src/index.js',
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'should never list a node_modules, which is what closes the race',
    () => {
      // Leaving the directory out of the result is not the same claim as never
      // reading it, and only the second one closes the race: a copy that listed
      // a build's scratch directory and dropped it afterwards would still meet
      // the `ENOENT`. So the scratch directory is made unreadable, which a copy
      // that so much as lists it fails on with `EACCES`. POSIX only, since
      // Windows has no mode bit to take away, and not as root, who reads it
      // anyway.
      const app = fixtureWithScratch();
      const scratch = join(app, 'node_modules', '.sigil');
      const to = tempDir('sigil-copy-fixture-dst-');

      chmodSync(scratch, 0o000);
      try {
        expect(() => copyFixture(app, to)).not.toThrow();
      } finally {
        // or `removeTempDirs()` cannot remove what is under it
        chmodSync(scratch, 0o755);
      }
    }
  );
});

describe('copying a fixture', () => {
  /**
   * Every test file that could copy one: the tests of every package, the
   * examples, and the website's tests -- tracked or merely not ignored, so that
   * a test file written a minute ago is checked before anybody commits it.
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
    .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/.test(path))
    .filter((path) => !path.includes('/fixtures/'));

  /**
   * The copies that do not go through `copyFixture()`, and why each is safe.
   *
   * Named with a count rather than as a file that may copy freely, so that a
   * third copy added to one of them is a decision somebody makes.
   */
  const exempt: Record<string, { count: number; why: string }> = {
    'packages/cli/test/update-check.test.ts': {
      count: 2,
      why:
        'copies `package.json` and `src` by name, never a whole tree -- the ' +
        "variants it writes live under the fixture's own `out/`, so a whole-tree " +
        'copy would copy the fixture into itself',
    },
  };

  /** A call to node's tree copy, synchronous or not, however it was imported. */
  const call = /\b(?:cpSync|cp)\s*\(/g;

  const copies = Object.fromEntries(
    sources
      .filter((path) => path !== 'packages/cli/test/copy-fixture.ts')
      .map((path) => [path, readFileSync(join(repo, path), 'utf-8').match(call)?.length ?? 0])
      .filter(([, count]) => count)
  );

  it('should find the sources it means to check', () => {
    // a listing that came back empty would pass the test below by checking
    // nothing -- git missing, or a pathspec that stopped matching
    expect(sources).toContain('packages/cli/test/build/bundle.test.ts');
    expect(sources).toContain('packages/cli/test/copy-fixture.ts');
    expect(sources.length).toBeGreaterThan(100);
  });

  it('should go through copyFixture() everywhere else', () => {
    // A fixture copied with node's own call carries whatever a build in another
    // worker has under the fixture's `node_modules/.sigil/` at that moment, and
    // races it -- SIG-331, after four copies in `package-command.test.ts` had
    // each been fixed with a filter of its own. One helper is what stops a
    // fifth being written without one.
    expect(copies).toStrictEqual(
      Object.fromEntries(Object.entries(exempt).map(([path, { count }]) => [path, count]))
    );
  });
});
