import { binaryName, canBuildSea, hostTarget, label } from '../src/build/compile.ts';
import { CONFIG_FILE } from '../src/config.ts';
import { run } from '../src/index.js';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Whether Bun is installed, which decides whether its half can be proved. */
const hasBun = Boolean(whichSync('bun'));

/**
 * Whether this node can build a single executable in one step.
 *
 * `canBuildSea()` rather than a copy of its arithmetic, which is what this was
 * for a while: the threshold lives in `compile.ts`, so spelling it again here
 * meant raising it would leave these tests guarding on the old number and
 * asserting against the new one.
 */
const hasBuildSea = canBuildSea();

/**
 * What the fixture's binary is called on this platform.
 *
 * `binaryName()` rather than `'buildable'`, which is the repository's own rule
 * about platform-dependent fixtures: a test never spells a value the subject
 * can be asked for. Spelled by hand it failed every Windows job, where the
 * binary is `buildable.exe`.
 */
const BINARY = binaryName('buildable', hostTarget());

/** Runs the CLI with both streams captured, the way `build-command.test.ts` does. */
async function sigil(...argv: string[]) {
  const chunks: Record<'err' | 'out', string[]> = { err: [], out: [] };
  const spies: { mockRestore: () => void }[] = (['stdout', 'stderr'] as const).map((stream) =>
    vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks[stream === 'stdout' ? 'out' : 'err'].push(chunk.toString());
      return true;
    }) as typeof process.stdout.write)
  );

  // rolldown logs through `console.warn`, and vitest replaces the console --
  // see `build-command.test.ts` for the sabotage that found this
  for (const level of ['error', 'warn'] as const) {
    spies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        chunks.err.push(args.map(String).join(' '));
      })
    );
  }

  try {
    await run(argv);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  return { err: chunks.err.join(''), out: chunks.out.join('') };
}

/**
 * `sigil package`: what it refuses, what it bundles, and what it produces.
 *
 * The three layers are deliberately separate. What it refuses needs no tool
 * installed and always runs. The **bundle** is the part that is new and
 * load-bearing -- a flat CommonJS form whose `main()` call is wrapped -- and it
 * is proved by running the bundle under node, with no 138 MB binary involved, so
 * that too always runs. Only the last layer needs a compiler, and each half of
 * it skips with a reason when its runtime is absent.
 */
describe('sigil package', () => {
  let exitCode: typeof process.exitCode;
  let out: string;

  beforeEach(() => {
    exitCode = process.exitCode;
    out = mkdtempSync(join(tmpdir(), 'sigil-pkg-'));
  });

  afterEach(() => {
    process.exitCode = exitCode;
    rmSync(out, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  describe('choosing a runtime', () => {
    it('should refuse to pick one, naming both and what each costs', async () => {
      // the error *is* the feature: a runtime decides what the app runs on, so
      // inferring one from what happens to be installed would answer a question
      // about the app with a fact about the builder's laptop
      const { err } = await sigil('package', join(fixtures, 'buildable'), '--out', out);

      expect(err).toContain('--runtime is required');
      expect(err).toContain('--runtime bun');
      expect(err).toContain('--runtime node');
      // and where to say it once, which is the thing a reader wants next
      expect(err).toContain('sigil.json');
      expect(process.exitCode).toBeTruthy();
    }, 60_000);

    it('should say when the runtime came from the file, and only then', async () => {
      // Asked twice as "why doesn't it prompt me?", both times because a
      // `sigil.json` was deciding this silently. A flag is the caller's own
      // immediate act and needs no echo; an answered prompt is on screen
      // already. The file is the one source that was invisible.
      const app = mkdtempSync(join(tmpdir(), 'sigil-pkg-app-'));

      try {
        cpSync(join(fixtures, 'buildable'), app, {
          filter: (from) => !from.includes('node_modules'),
          recursive: true,
        });
        writeFileSync(
          join(app, 'sigil.json'),
          `${JSON.stringify({ package: { runtime: 'bun' } }, undefined, 2)}\n`,
          'utf-8'
        );

        // a target Bun cannot build, so the run refuses in the pre-flight and
        // this needs no compiler and no download
        const declared = await sigil(
          app ? 'package' : 'package',
          app,
          '--out',
          out,
          '--target',
          'windows-arm64'
        );

        expect(declared.err).toContain(`Using bun from ${CONFIG_FILE}`);
        expect(declared.err).toContain('--runtime');

        // and nothing is said when the flag supplied it
        const flagged = await sigil(
          'package',
          app,
          '--out',
          out,
          '--runtime',
          'bun',
          '--target',
          'windows-arm64'
        );

        expect(flagged.err).not.toContain('Using bun from');
      } finally {
        rmSync(app, { force: true, recursive: true });
      }
    }, 60_000);

    it('should refuse a spelling the config invented', async () => {
      const app = mkdtempSync(join(tmpdir(), 'sigil-pkg-app-'));

      try {
        // `node_modules` is excluded, and that is not tidiness: `sigil package`
        // writes its staging directory under the app's own
        // `node_modules/.sigil/`, so copying the fixture while another test
        // file packages it races a read against a delete. Measured as a test
        // that passed alone and failed in the suite.
        cpSync(join(fixtures, 'buildable'), app, {
          filter: (from) => !from.includes('node_modules'),
          recursive: true,
        });
        writeFileSync(
          join(app, 'sigil.json'),
          `${JSON.stringify({ package: { runtime: 'deno' } }, undefined, 2)}\n`,
          'utf-8'
        );

        // refused by the config reader's own `choices`, which is the same
        // vocabulary `--runtime` carries -- so the flag and the file cannot come
        // to mean two different things
        const { err } = await sigil('package', app, '--out', out);

        expect(err).toContain('deno');
        expect(process.exitCode).toBeTruthy();
      } finally {
        rmSync(app, { force: true, recursive: true });
      }
    }, 60_000);

    it('should take the runtime from sigil.json, and let the flag beat it', async () => {
      const app = mkdtempSync(join(tmpdir(), 'sigil-pkg-app-'));

      try {
        // `node_modules` is excluded, and that is not tidiness: `sigil package`
        // writes its staging directory under the app's own
        // `node_modules/.sigil/`, so copying the fixture while another test
        // file packages it races a read against a delete. Measured as a test
        // that passed alone and failed in the suite.
        cpSync(join(fixtures, 'buildable'), app, {
          filter: (from) => !from.includes('node_modules'),
          recursive: true,
        });
        writeFileSync(
          join(app, 'sigil.json'),
          `${JSON.stringify({ package: { runtime: 'node' } }, undefined, 2)}\n`,
          'utf-8'
        );

        // Asserted through the **pre-flight**, which is what makes it cheap
        // enough to always run: no compiler, no `node_modules`, no 138 MB of
        // output. The message names which runtime the chooser picked, which is
        // the thing under test.
        //
        // The target has to be one the *node* path refuses on every platform,
        // and a foreign **platform** is not that: this used `linux-arm64`,
        // which is foreign on a Mac and the host on a Linux runner, so the
        // assertion held on the machine it was written on and failed on every
        // ubuntu job. A pinned Node below the `--build-sea` floor is
        // platform-independent -- no Node packages 24 anywhere.
        const declared = await sigil('package', app, '--out', out, '--runtime', 'node@24.22.1');
        expect(declared.err).toMatch(/cannot package itself/);

        // and the file's own `node` is what answers when nothing overrides it,
        // which is the other half: a target Bun cannot build would be refused
        // by the *bun* message if the file had been ignored
        const fromFile = await sigil('package', app, '--out', out, '--target', 'windows-arm64');
        expect(fromFile.err).not.toContain('Bun cannot build');
      } finally {
        rmSync(app, { force: true, recursive: true });
      }
    }, 120_000);
  });

  describe('the bundle it embeds', () => {
    it.skipIf(!hasBuildSea)(
      'should embed one flat CommonJS file, for the node runtime',
      async () => {
        // The claim with teeth. A Node single executable runs its embedded main as
        // CommonJS and cannot `import()` at all, so this form has to be one file,
        // free of top-level await, and still able to reach its commands.
        //
        // Asserted through the **binary** now rather than through the staged
        // bundle, because the staging directory no longer survives the run: a
        // hash per output meant one directory per distinct `--out`, so they
        // accumulated -- 51 of them in this very fixture before anybody looked.
        const { err } = await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'node',
          '--target',
          label(hostTarget())
        );

        // Skipped rather than branched on an old host, and the branch is what
        // was wrong: it asserted a refusal or a fetch, and on a Node 24 machine
        // with a cached Node 26 the command simply **worked** -- correct
        // behaviour, and a third outcome the branch did not allow for. On CI it
        // would download ~50 MB instead, which makes a unit test a network test.
        //
        // Where the host can build a SEA there is nothing to fetch and nothing
        // to skip, so this is deterministic on exactly the jobs that run it.
        expect(err).not.toMatch(/^Error:/m);
        expect(process.exitCode).toBeFalsy();

        // the output directory holds binaries and nothing else, which is the whole
        // of why the bundle moved out of it
        expect(readdirSync(out)).toEqual([BINARY]);

        const binary = join(out, BINARY);
        const help = spawnSync(binary, ['--help'], { encoding: 'utf-8' });
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain('Usage:');

        // and a command, which is the half that proves the inlined `import()`
        // still resolves -- a flattened bundle whose commands cannot be reached
        // would answer `--help` perfectly well
        const cmd = spawnSync(binary, ['greet', 'Ada'], { encoding: 'utf-8' });
        expect(cmd.status, cmd.stderr).toBe(0);
        expect(cmd.stdout).toBe('hello Ada\n');
      },
      120_000
    );

    it('should leave only binaries in the output directory', async () => {
      // the other half of the same claim, and the user-visible reason the bundle
      // moved: `sigil package` defaulted to `dist/` beside `sigil build`, and
      // `clean()` empties whichever directory it is given -- so each command
      // deleted the other's output, measured in both orders
      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'bun'
      );

      if (!hasBun) {
        expect(err).toMatch(/bun/);
        return;
      }

      expect(readdirSync(out)).toEqual([BINARY]);
      expect(existsSync(join(out, 'buildable.mjs'))).toBe(false);
      expect(existsSync(join(out, 'chunks'))).toBe(false);
    }, 120_000);
  });

  describe('what it refuses before building anything', () => {
    it('should write nothing when a target cannot be built', async () => {
      // the rule `--bin` beside a routed directory already follows: a failure
      // the build can see coming is a build error. Asserted as the *absence of
      // output*, because a refusal that arrives after the bundle is a refusal
      // that charged for a type-check and a bundle first
      rmSync(out, { force: true, recursive: true });

      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'bun',
        '--target',
        'windows-arm64'
      );

      expect(err).toContain('Bun cannot build windows-arm64');
      expect(existsSync(out)).toBe(false);
      expect(process.exitCode).toBeTruthy();
    }, 60_000);

    it('should refuse an app that declared it is not self-contained', async () => {
      // Found by packaging this toolchain, which declares three externals --
      // two of them native bindings nothing can inline. An external means
      // "this must be installed where the app runs" and a binary means
      // "nothing has to be installed", so the two cannot both be true.
      //
      // It is a refusal rather than a warning because of what Node did with
      // it: a 138 MB binary, reported successfully, that died on the first
      // thing anybody typed with `No such built-in module`. That is the
      // build-reported-success-executable-dies class three other gates in this
      // package already exist for.
      rmSync(out, { force: true, recursive: true });

      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'bun',
        '--external',
        'some-native-package'
      );

      expect(err).toContain('Cannot package an app with external packages');
      expect(err).toContain('some-native-package');
      // and it says what to do instead, which is the half a refusal owes
      expect(err).toContain('sigil build');
      // before the bundle, like every other pre-flight here
      expect(existsSync(out)).toBe(false);
      expect(process.exitCode).toBeTruthy();
    }, 60_000);

    it('should refuse an app that declared one in sigil.json', async () => {
      // the flag and the file reach the same check, because `build.external`
      // is where an app with a native dependency actually says so
      const app = mkdtempSync(join(tmpdir(), 'sigil-pkg-app-'));

      try {
        // `node_modules` is excluded, and that is not tidiness: `sigil package`
        // writes its staging directory under the app's own
        // `node_modules/.sigil/`, so copying the fixture while another test
        // file packages it races a read against a delete. Measured as a test
        // that passed alone and failed in the suite.
        cpSync(join(fixtures, 'buildable'), app, {
          filter: (from) => !from.includes('node_modules'),
          recursive: true,
        });
        writeFileSync(
          join(app, 'sigil.json'),
          `${JSON.stringify(
            { build: { external: ['oxc-parser'] }, package: { runtime: 'bun' } },
            undefined,
            2
          )}\n`,
          'utf-8'
        );

        const { err } = await sigil('package', app, '--out', out);

        expect(err).toContain('Cannot package an app with external packages');
        expect(err).toContain('oxc-parser');
      } finally {
        rmSync(app, { force: true, recursive: true });
      }
    }, 60_000);

    it('should refuse a signing identity nothing could use, before building', async () => {
      // `codesign` is macOS's, so an identity with no darwin target is a
      // request that cannot be honoured -- and it used to be accepted and
      // dropped in silence, which is the half that matters
      rmSync(out, { force: true, recursive: true });

      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'bun',
        '--target',
        'linux-x64',
        '--sign',
        'Developer ID Application: Example (TEAM123)'
      );

      expect(err).toContain('--sign names a codesigning identity');
      expect(err).toContain('linux-x64');
      expect(existsSync(out)).toBe(false);
      expect(process.exitCode).toBeTruthy();
    }, 60_000);

    it('should not refuse over a missing runtime, but fetch one', async () => {
      // This asserted the opposite, and the opposite was reported as a bug
      // twice: `bun is not installed` is an error about the machine for an
      // instruction that was about the app. Sigil can fetch a runtime, so a
      // missing one is a thing to resolve.
      //
      // Asserted without a download, which is what makes it a test rather than
      // a network call: `PATH` is emptied, so the old check would fire, and the
      // target is one Bun has no runtime for at all -- so the run still refuses,
      // for a reason that is about the target rather than about `PATH`.
      const path = process.env.PATH;
      rmSync(out, { force: true, recursive: true });

      try {
        process.env.PATH = '';

        const { err } = await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'bun',
          '--target',
          'windows-arm64'
        );

        expect(err).not.toContain('bun is not installed');
        expect(err).toContain('Bun cannot build windows-arm64');
        expect(existsSync(out)).toBe(false);
      } finally {
        process.env.PATH = path;
      }
    }, 60_000);

    it('should refuse an empty signing identity before building', async () => {
      // `--sign=` is how a value gets deliberately emptied, and it used to pass
      // all three checks that read an identity -- reaching `codesign` as
      // `: no identity found` after the bundle and an 85 MB compile had run
      rmSync(out, { force: true, recursive: true });

      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'bun',
        '--target',
        'darwin-arm64',
        '--sign='
      );

      expect(err).toContain('empty identity');
      expect(existsSync(out)).toBe(false);
      expect(process.exitCode).toBeTruthy();
    }, 60_000);

    it('should refuse an --out that holds the app itself', async () => {
      // the same refusal and the same message `build` carries, because it is
      // the same function: an `--out` that is the app root is the one way a
      // mistyped path turns a build into data loss
      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        join(fixtures, 'buildable'),
        '--runtime',
        'bun'
      );

      expect(err).toContain('holds the app itself');
      expect(process.exitCode).toBeTruthy();
    }, 60_000);
  });

  describe('the binary', () => {
    it.skipIf(!hasBun)(
      'should run, and answer the way the unpackaged app does',
      async () => {
        const { out: stdout } = await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'bun'
        );

        // the size table, which is the number nobody guesses right
        expect(stdout).toContain(label(hostTarget()));
        expect(stdout).toMatch(/\d+\.\d MB/);

        const binary = join(out, BINARY);
        expect(existsSync(binary)).toBe(true);

        const help = spawnSync(binary, ['--help'], { encoding: 'utf-8' });
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain('Usage:');

        // against a real `sigil build` rather than against a literal or against
        // this run's own intermediate: what is claimed is that packaging changed
        // nothing about what the app says, so the comparison should be with the
        // canonical unpackaged output
        const built = mkdtempSync(join(tmpdir(), 'sigil-pkg-built-'));

        try {
          await sigil('build', join(fixtures, 'buildable'), '--out', built);

          const unpackaged = spawnSync(process.execPath, [join(built, 'buildable.mjs'), '--help'], {
            encoding: 'utf-8',
          });

          expect(unpackaged.status, unpackaged.stderr).toBe(0);
          expect(help.stdout).toBe(unpackaged.stdout);
        } finally {
          rmSync(built, { force: true, recursive: true });
        }

        // and a lazily loaded command, which is the thing a flattened or
        // mis-chunked bundle gets wrong while answering `--help` correctly
        const cmd = spawnSync(binary, ['greet', 'Ada'], { encoding: 'utf-8' });
        expect(cmd.status, cmd.stderr).toBe(0);
        expect(cmd.stdout).toBe('hello Ada\n');
      },
      180_000
    );

    it.skipIf(!hasBuildSea)(
      'should run on the node runtime, signed where the platform needs it',
      async () => {
        const { out: stdout } = await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'node'
        );

        const binary = join(out, BINARY);
        expect(existsSync(binary)).toBe(true);

        // the reported size against the file on disk, which is what pins the
        // figure being taken **after** signing. It used to be one object
        // literal with `sizeOf(out)` written before `sign(...)`, and properties
        // evaluate in order -- so every signed Node binary was reported about
        // 0.3 MB light: 138.6 MB printed for a 138.8 MB file.
        // to the printed precision rather than approximately: the defect was
        // 0.28 MB, which a `toBeCloseTo(..., 0)` tolerance of 0.5 waves through.
        //
        // Worth knowing what this can and cannot catch, because it is
        // platform-scoped and the comment above used to imply otherwise. The
        // figure matching the file is true everywhere and asserted everywhere;
        // the **ordering** defect it was written for was a signing one, so only
        // a platform that signs can see it -- reintroduce it on Linux and the
        // bytes are identical either way. On this matrix that is the macOS legs.
        const printed = /(\d+\.\d) MB/.exec(stdout)?.[1];
        expect(printed).toBeDefined();
        expect(printed).toBe((statSync(binary).size / 1048576).toFixed(1));

        // on Apple Silicon this is not a finishing touch: `--build-sea` strips
        // the signature node ships with, and an unsigned binary is killed with
        // SIGKILL before it runs a line -- exit 137, no output. So the
        // assertion that it *runs* is the assertion that it was signed
        if (process.platform === 'darwin') {
          expect(stdout).toContain('ad-hoc');
        }

        const help = spawnSync(binary, ['--help'], { encoding: 'utf-8' });
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain('Usage:');

        // against a real `sigil build`, which is the canonical unpackaged
        // output: what is claimed is that wrapping the entry and flattening the
        // chunks changed nothing about what the app says
        const built = mkdtempSync(join(tmpdir(), 'sigil-pkg-built-'));

        try {
          await sigil('build', join(fixtures, 'buildable'), '--out', built);

          const unpackaged = spawnSync(process.execPath, [join(built, 'buildable.mjs'), '--help'], {
            encoding: 'utf-8',
          });

          expect(unpackaged.status, unpackaged.stderr).toBe(0);
          expect(help.stdout).toBe(unpackaged.stdout);
        } finally {
          rmSync(built, { force: true, recursive: true });
        }

        const cmd = spawnSync(binary, ['greet', 'Ada'], { encoding: 'utf-8' });
        expect(cmd.status, cmd.stderr).toBe(0);
        expect(cmd.stdout).toBe('hello Ada\n');
      },
      300_000
    );

    it.skipIf(!hasBun)(
      'should name a binary after its target only when there is more than one',
      async () => {
        // one target is the ordinary case and `myapp` is what its users type.
        // Several at once is a release, where every one would otherwise be
        // written to the same path and the last would be the only survivor --
        // reported as several binaries, which is the quiet version of this bug
        await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'bun',
          '--target',
          'linux-x64',
          '--target',
          'windows-x64'
        );

        expect(existsSync(join(out, 'buildable-linux-x64'))).toBe(true);
        expect(existsSync(join(out, 'buildable-windows-x64.exe'))).toBe(true);
        expect(existsSync(join(out, BINARY))).toBe(false);

        // and they really are different files rather than one written twice
        const linux = readFileSync(join(out, 'buildable-linux-x64'));
        const windows = readFileSync(join(out, 'buildable-windows-x64.exe'));
        expect(linux.equals(windows)).toBe(false);
      },
      300_000
    );

    it.skipIf(!hasBun)(
      'should sign the darwin member of a mixed set and build the rest unsigned',
      async () => {
        // The severe regression round 3 found. Moving the identity refusal down
        // to the per-target compile layer turned a per-SET decision into a
        // per-target one: this invocation built the darwin binary, signed it,
        // refused `linux-x64`, and **deleted the darwin binary** on the way
        // out -- where the commit before produced both correctly.
        const { out: stdout } = await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'bun',
          '--target',
          'darwin-arm64',
          '--target',
          'linux-x64',
          '--sign',
          '-'
        );

        expect(existsSync(join(out, 'buildable-darwin-arm64'))).toBe(true);
        expect(existsSync(join(out, 'buildable-linux-x64'))).toBe(true);

        // and the table says which of them was signed, since only one could be
        expect(stdout).toMatch(/buildable-darwin-arm64.*ad-hoc/);
        expect(stdout).toMatch(/buildable-linux-x64\s+linux-x64\s+\S+ MB\s*$/m);
      },
      300_000
    );

    it('should leave a previous release alone when it refuses, under --no-clean', async () => {
      // This is the case that found the bug -- the cleanup removed the failing
      // target's path unconditionally, so a refused rerun destroyed the
      // previous release's binary sitting there under `--no-clean`, whose
      // documented promise is to keep what is already there.
      //
      // What it pins *now* is the pre-flight, not the cleanup, and the
      // distinction is worth stating: once every pre-write failure site moved
      // into the pre-flight over all targets, this invocation stopped reaching
      // the compile loop at all. So this asserts the outer guarantee -- a
      // refusal leaves the directory as it found it -- and the `stamp()` guard
      // inside the loop is defensive against a race, which its own comment
      // says rather than implying a test covers it.
      rmSync(out, { force: true, recursive: true });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'buildable-linux-x64'), 'PREVIOUS GOOD RELEASE', 'utf-8');
      writeFileSync(join(out, 'keepme.txt'), 'bystander', 'utf-8');

      // `windows-arm64` is refused by `assertCompilable()` inside the compile
      // function, which is a failure site reached before anything is written
      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--no-clean',
        '--runtime',
        'bun',
        '--target',
        'linux-x64',
        '--target',
        'windows-arm64'
      );

      expect(err).toContain('Bun cannot build windows-arm64');
      expect(readFileSync(join(out, 'buildable-linux-x64'), 'utf-8')).toBe('PREVIOUS GOOD RELEASE');
      expect(readFileSync(join(out, 'keepme.txt'), 'utf-8')).toBe('bystander');
    }, 120_000);

    it.skipIf(!hasBun)(
      'should build one binary per target named once, however often it was named',
      async () => {
        // two spellings of one target would compile twice to one path, the
        // second overwriting the first, and be reported as two binaries
        const { out: stdout } = await sigil(
          'package',
          join(fixtures, 'buildable'),
          '--out',
          out,
          '--runtime',
          'bun',
          '--target',
          'linux-x64',
          '--target',
          'linux-x64'
        );

        expect(stdout.match(/linux-x64/g)).toHaveLength(1);
        // one target after deduplication, so it keeps the unsuffixed name
        expect(existsSync(join(out, BINARY))).toBe(true);
      },
      300_000
    );
  });
});
