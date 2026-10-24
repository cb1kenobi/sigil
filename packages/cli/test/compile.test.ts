import {
  ARCHES,
  assertCompilable,
  assertToolchain,
  binaryName,
  canBuildSea,
  hostTarget,
  label,
  parseTarget,
  PLATFORMS,
  RUNTIMES,
  targets,
  type Target,
} from '../src/build/compile.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The target vocabulary, and what each runtime refuses.
 *
 * Everything that decides *whether they should run at all* is here, which is
 * why it is a file of its own: the two `compile*()` functions are a bundler and
 * a blob injector away from anything assertable.
 *
 * `assertCompilable()` is pure -- no disk, no spawn -- and most of this file
 * asserts it as such. `assertToolchain()` is not, and the last describe block
 * says so: it walks `PATH` through `whichSync()`, and that walk is the
 * mechanism under test rather than an implementation detail to mock away.
 *
 * `assertCompilable()` is the interesting half. It is asked twice on purpose --
 * once by `sigil package` before the bundle, once by the compile function
 * itself -- so a refusal that regressed would have to regress in one place, and
 * these are the assertions that say what it refuses.
 */
describe('a target', () => {
  it('should read a <platform>-<arch> pair', () => {
    expect(parseTarget('darwin-arm64')).toEqual({ arch: 'arm64', platform: 'darwin' });
    expect(parseTarget('windows-x64')).toEqual({ arch: 'x64', platform: 'windows' });
  });

  it('should round-trip every target it offers', () => {
    // the list a message prints and the list `parseTarget()` takes have to be
    // the same list, and the one way they come apart is a spelling in one that
    // the other does not read
    for (const text of targets()) {
      expect(label(parseTarget(text))).toBe(text);
    }
  });

  it('should offer every platform crossed with every arch', () => {
    expect(targets()).toHaveLength(PLATFORMS.length * ARCHES.length);
  });

  it.each([
    // the spelling somebody who knows uname reaches for, which is the whole
    // reason the error prints the list rather than only saying no
    'darwin-aarch64',
    'macos-arm64',
    'win32-x64',
    // a runtime name where a platform goes, which is what Bun's own triples
    // look like -- and is why a target here deliberately does not carry one
    'bun-darwin-arm64',
    'darwin',
    'arm64',
    '',
    '-',
    'darwin-arm64-extra',
  ])('should refuse %o, naming what a target is', (text) => {
    expect(() => parseTarget(text)).toThrow(/is not a target/);
  });

  it('should name the host as one of the targets it offers', () => {
    // not merely "returns something": a host whose label is not in the list is
    // a host no `--target` could have named, so the default would be
    // unreachable by hand
    expect(targets()).toContain(label(hostTarget()));
  });

  it('should add .exe on Windows and nowhere else', () => {
    // Windows will not execute a file without it, so a cross-compiled binary
    // that kept the bare name arrives unusable on the one platform that cannot
    // tell you so
    expect(binaryName('myapp', parseTarget('windows-x64'))).toBe('myapp.exe');
    expect(binaryName('myapp', parseTarget('windows-arm64'))).toBe('myapp.exe');

    for (const text of targets()) {
      const target = parseTarget(text);
      if (target.platform !== 'windows') {
        expect(binaryName('myapp', target)).toBe('myapp');
      }
    }
  });
});

describe('what a runtime can build', () => {
  const host = hostTarget();

  /**
   * Whether this Node can build a single executable at all.
   *
   * Every `node` assertion below has to be guarded by it, and for a while none
   * of them was: `assertCompilable('node', ...)` asks `assertBuildSea()`
   * *first*, so on Node 22 and 24 -- six of CI's nine jobs -- all three
   * answered `Node 25.5 or newer is needed` rather than the message under test,
   * and the suite went red on a branch whose feature is inert there.
   *
   * It is the same shape as this repository's rule about platform-specific
   * fixtures, in version form: the branch was measured on one Node, and the
   * tests encoded that Node's answers as though they were everyone's.
   */
  const hasBuildSea = canBuildSea();

  it('should offer exactly the two runtimes', () => {
    // asserted as the set rather than the length, because a third would need a
    // decision recorded in AGENTS.md and a `compile*()` of its own -- this is
    // what fails if one arrives without them
    expect([...RUNTIMES]).toEqual(['bun', 'node']);
  });

  it('should let bun build every target but windows-arm64', () => {
    for (const text of targets()) {
      const target = parseTarget(text);

      if (text === 'windows-arm64') {
        // named rather than discovered from a failed spawn: `bun build` answers
        // an unknown target with a usage dump, and the one thing the reader
        // needs is which combination is missing
        expect(() => assertCompilable('bun', target)).toThrow(/Bun cannot build windows-arm64/);
      } else {
        expect(() => assertCompilable('bun', target)).not.toThrow();
      }
    }
  });

  it('should let node build the host', () => {
    if (!hasBuildSea) {
      // the honest assertion on an old Node: it refuses, and says which
      // version is wanted rather than anything about the target
      expect(() => assertCompilable('node', host)).toThrow(/Node .* or newer is needed/);
      return;
    }

    expect(() => assertCompilable('node', host)).not.toThrow();
  });

  it.skipIf(!hasBuildSea)('should refuse every target but the host for node, saying why', () => {
    const foreign = targets()
      .map((text) => parseTarget(text))
      .filter((target) => label(target) !== label(host));

    expect(foreign).not.toHaveLength(0);

    for (const target of foreign) {
      // the message has to carry the mechanism, because "cannot cross-compile"
      // on its own reads as a missing feature rather than as a property of how
      // a single executable is built
      expect(() => assertCompilable('node', target)).toThrow(/Node cannot cross-compile/);
      expect(() => assertCompilable('node', target)).toThrow(new RegExp(label(target)));
      expect(() => assertCompilable('node', target)).toThrow(/--runtime bun/);
    }
  });

  it.skipIf(!hasBuildSea)('should tell bun and node apart for the same target', () => {
    // the one assertion that would fail if `assertCompilable()` ignored its
    // runtime argument, which is the shape a refactor of two checks into one
    // function can quietly produce
    const windowsArm: Target = parseTarget('windows-arm64');
    const bun = (): void => assertCompilable('bun', windowsArm);
    const node = (): void => assertCompilable('node', windowsArm);

    expect(bun).toThrow(/Bun cannot build/);

    // node refuses it too, and for an unrelated reason -- unless this is a
    // windows-arm64 machine, where it is the host and node is the way to get one
    if (label(windowsArm) === label(host)) {
      expect(node).not.toThrow();
    } else {
      expect(node).toThrow(/cannot cross-compile/);
    }
  });
});

describe('what gets code-signed', () => {
  /**
   * A `PATH` holding a stub `bun` and no `codesign`.
   *
   * Emptying `PATH` was the first version of this and made the Bun half of
   * these tests **vacuous**: `assertToolchain()` locates `bun` first, so every
   * Bun case exited at that check and the `codesign` branch -- the one
   * `signsOn()` exists to decide, and the one on both tests' names -- was never
   * reached. Measured: reintroducing the silent `--sign` drop by deleting
   * `|| identity !== undefined` from `signsOn()` left all 38 tests passing.
   *
   * So `bun` has to be findable and `codesign` has to not be, which is one
   * directory rather than a mock -- `whichSync()` walks `PATH`, and that walk
   * is the mechanism under test.
   */
  let fakebin: string;
  let path: string | undefined;

  beforeEach(() => {
    path = process.env.PATH;
    fakebin = mkdtempSync(join(tmpdir(), 'sigil-fakebin-'));
    writeFileSync(join(fakebin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = fakebin;
  });

  afterEach(() => {
    process.env.PATH = path;
    rmSync(fakebin, { force: true, recursive: true });
  });

  it('should want codesign for a darwin target on the node runtime', () => {
    // node's output is unsigned and unrunnable until it is signed, so this is
    // unconditional
    expect(() => assertToolchain('node', [parseTarget('darwin-arm64')], undefined)).toThrow(
      /codesign is not installed/
    );
  });

  it('should not want codesign for a bun darwin target with no identity', () => {
    // Bun's output is already `adhoc, linker-signed`, so this path never runs
    // `codesign` -- and demanding a tool the run will not use would refuse a
    // perfectly good cross-compile from a Linux host, where there is none.
    // `bun` is findable here, so reaching the end means the codesign branch was
    // genuinely skipped rather than short-circuited
    expect(() => assertToolchain('bun', [parseTarget('darwin-arm64')], undefined)).not.toThrow();
  });

  it('should want codesign for a bun darwin target when an identity was asked for', () => {
    // the assertion the silent-drop fix rests on: if `--sign` is honoured on
    // the Bun path, the tool it needs is part of the pre-flight. Deleting the
    // identity half of `signsOn()` fails exactly here
    expect(() =>
      assertToolchain('bun', [parseTarget('darwin-arm64')], 'Developer ID Application: X')
    ).toThrow(/codesign is not installed/);
  });

  it('should want codesign for no non-darwin target, whatever the identity', () => {
    for (const runtime of RUNTIMES) {
      for (const text of ['linux-x64', 'linux-arm64', 'windows-x64']) {
        for (const identity of [undefined, '-', 'Developer ID Application: X']) {
          expect(() => assertToolchain(runtime, [parseTarget(text)], identity)).not.toThrow();
        }
      }
    }
  });

  it('should want codesign when any one target of several needs it', () => {
    // the pre-flight is over the whole set, so a release that includes one
    // darwin target needs the tool even though four of its five do not
    expect(() =>
      assertToolchain('node', [parseTarget('linux-x64'), parseTarget('darwin-arm64')], undefined)
    ).toThrow(/codesign is not installed/);
  });
});
