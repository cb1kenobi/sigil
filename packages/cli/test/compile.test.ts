import {
  ARCHES,
  assertCompilable,
  assertToolchain,
  binaryName,
  canBuildSea,
  compileWithBun,
  compileWithNode,
  hostTarget,
  identityOf,
  isIdentity,
  label,
  parseTarget,
  PLATFORMS,
  RUNTIMES,
  targets,
  type Target,
} from '../src/build/compile.ts';
import { candidates } from '@ttylabs/sigil/which';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    // the name is asked of `candidates()` rather than spelled `bun`, which is
    // this repository's own rule about platform-dependent fixtures: a fixture
    // for behaviour that varies by platform is written with the same function
    // the subject uses. Spelled by hand it was broken on Windows by
    // construction -- `candidates()` returns the `PATHEXT` list for a dotless
    // name there and **no empty extension**, which the root AGENTS.md `which`
    // entry states outright, so an extensionless `bun` is never a candidate and
    // three of these tests failed on every windows job.
    const first = [...candidates('bun', { path: fakebin })].find((one) => one.startsWith(fakebin));

    expect(first, 'candidates() offered nothing inside the fixture directory').toBeDefined();
    writeFileSync(first as string, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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

  it('should want codesign for a bun darwin target too, identity or not', () => {
    // This asserted the opposite until Bun's own signature turned out not to be
    // trustworthy: a binary compiled by Bun 1.3.0 reports
    // `adhoc, linker-signed` and is still SIGKILLed, and a re-sign fixes it. So
    // the rule is the target rather than the producer -- see `signsOn()`.
    //
    // `bun` is findable here, so reaching the `codesign` check means it was
    // genuinely asked rather than short-circuited by a missing `bun`
    expect(() => assertToolchain('bun', [parseTarget('darwin-arm64')], undefined)).toThrow(
      /codesign is not installed/
    );
  });

  it('should want codesign for a bun darwin target when an identity was asked for', () => {
    // the same answer as without one, now that the rule is the target -- kept
    // as its own case because `--sign` on the Bun path was silently discarded
    // once, and this is the assertion that the identity reaches the signer
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

describe('an identity', () => {
  it('should read a blank one as none, however it is spelled', () => {
    for (const blank of ['', ' ', '   ', '\t', '\n']) {
      expect(isIdentity(blank)).toBe(false);
      expect(identityOf(blank)).toBeUndefined();
    }

    expect(isIdentity(undefined)).toBe(false);
    expect(identityOf(undefined)).toBeUndefined();
  });

  it('should trim the value, not only the emptiness test', () => {
    // `codesign` does an exact lookup, so a padded identity is not one to the
    // only consumer that matters: `--sign ' - '` reached it as
    // ` - : no identity found`, after the bundle and an 85 MB compile. The trim
    // used to be spent entirely on deciding whether the string was blank.
    //
    // `' - '` is the sharpest spelling, because `-` is this code's own ad-hoc
    // sentinel: a caller quoting it has asked for exactly the default.
    expect(identityOf(' - ')).toBe('-');
    expect(identityOf('  Developer ID Application: X  ')).toBe('Developer ID Application: X');
    expect(isIdentity(' - ')).toBe(true);
  });

  it('should be refused by the exported compile functions when blank', () => {
    // these are exported, so they are their own entry point -- the command's
    // pre-flight is not in the way. A blank identity cannot be honoured by any
    // target, so it is the one identity question that is scope-free.
    for (const one of [compileWithBun, compileWithNode]) {
      expect(() =>
        one({ entry: 'unused', out: 'unused', sign: '   ', target: hostTarget() })
      ).toThrow(/identity cannot be blank/);
    }
  });

  it('should not be refused by them for a target that cannot use it', () => {
    // the severe regression this is written for: refusing per-target turned a
    // per-SET decision into a per-target one, so a mixed
    // `--target darwin-arm64 --target linux-x64 --sign -` release built the
    // darwin binary, signed it, refused the linux one, and deleted the darwin
    // binary on the way out. The command's own guard is set-level and refuses
    // only when NO target is darwin.
    //
    // What makes the per-target refusal unnecessary is that nothing is silent:
    // `CompileResult.signed` is absent when nothing was signed. Asserted here
    // as "does not throw for *this* reason" -- it will still fail further in,
    // on a bundle that does not exist, which is not what is under test.
    for (const one of [compileWithBun, compileWithNode]) {
      expect(() =>
        one({
          entry: 'unused',
          out: 'unused',
          sign: 'Developer ID Application: X',
          target: parseTarget('linux-x64'),
        })
      ).not.toThrow(/identity/);
    }
  });
});

describe('a compile that fails partway', () => {
  /**
   * A stub `bun` that writes a partial binary and then fails.
   *
   * POSIX only, and `skipIf`'d rather than left to fail: the stub has to be an
   * executable the real `spawnSync` runs, which on Windows means a `.cmd` or a
   * `.exe` rather than a shebang -- and what is under test is this
   * repository's cleanup, not its ability to write a batch file.
   *
   * The inducer matters because two review rounds failed to find one. A
   * pre-made *directory* at the outfile does not work (Bun replaces it and
   * succeeds); being Bun does. The same thing happens for real under
   * `ulimit -f`, which is how the defect was first reproduced: the real
   * `node --build-sea` left 2,097,152 bytes at the output path.
   */
  let fakebin: string;
  let out: string;
  let path: string | undefined;

  beforeEach(() => {
    path = process.env.PATH;
    fakebin = mkdtempSync(join(tmpdir(), 'sigil-stubbun-'));
    out = mkdtempSync(join(tmpdir(), 'sigil-stubout-'));

    const name = [...candidates('bun', { path: fakebin })].find((one) => one.startsWith(fakebin));

    writeFileSync(
      name as string,
      // the outfile is the argument after `--outfile`, which is how the real
      // call is spelled -- a stub that guessed the position would stop
      // reproducing the moment the arguments were reordered
      '#!/bin/sh\nwhile [ "$1" != "--outfile" ]; do shift; done\nprintf PARTIAL > "$2"\nexit 1\n',
      { mode: 0o755 }
    );
    process.env.PATH = fakebin;
  });

  afterEach(() => {
    process.env.PATH = path;
    rmSync(fakebin, { force: true, recursive: true });
    rmSync(out, { force: true, recursive: true });
  });

  it.skipIf(process.platform === 'win32')(
    'should leave no binary behind when the compiler writes one and then fails',
    () => {
      const binary = join(out, 'app');

      expect(() => compileWithBun({ entry: 'unused', out: binary, target: hostTarget() })).toThrow(
        /bun build --compile failed/
      );

      // the whole point: a truncated binary under the final name is
      // indistinguishable from a good one, and the scaffolded release workflow
      // attaches files by name
      expect(existsSync(binary)).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'should leave a file it never wrote, when it refuses before writing',
    () => {
      // the other half, and the one an earlier version of this cleanup got
      // wrong: a refusal that happens before any write must not remove what is
      // already at the path. Under `--no-clean` that is a previous release's
      // binary.
      const binary = join(out, 'app');
      writeFileSync(binary, 'PREVIOUS GOOD RELEASE', 'utf-8');

      // refused by `assertCompilable()`, which is before the write bracket
      expect(() =>
        compileWithBun({ entry: 'unused', out: binary, target: parseTarget('windows-arm64') })
      ).toThrow(/Bun cannot build/);

      expect(readFileSync(binary, 'utf-8')).toBe('PREVIOUS GOOD RELEASE');
    }
  );
});
