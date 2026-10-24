import { canBuildSea, hostTarget, label } from '../src/build/compile.ts';
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

    it('should refuse a spelling the config invented', async () => {
      const app = mkdtempSync(join(tmpdir(), 'sigil-pkg-app-'));

      try {
        cpSync(join(fixtures, 'buildable'), app, { recursive: true });
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
        cpSync(join(fixtures, 'buildable'), app, { recursive: true });
        writeFileSync(
          join(app, 'sigil.json'),
          `${JSON.stringify({ package: { runtime: 'node' } }, undefined, 2)}\n`,
          'utf-8'
        );

        // Asserted through the **pre-flight** rather than through a binary, and
        // that is what makes it cheap enough to always run: a foreign target is
        // refused by whichever runtime was chosen, with a different message
        // each, before anything is bundled. So the message names which runtime
        // the chooser picked -- which is the thing under test -- without a
        // compiler, a `node_modules` or 138 MB of output.
        //
        // `linux-arm64` rather than the host, because the claim needs a target
        // node refuses and bun does not.
        const foreign = 'linux-arm64';

        const declared = await sigil('package', app, '--out', out, '--target', foreign);
        // on a Node without `--build-sea` the refusal is the version one, which
        // is still the *node* path refusing and so still proves the config was
        // read -- what must not happen is this asserting one Node's answer as
        // though it were every Node's
        expect(declared.err).toMatch(
          hasBuildSea ? /Node cannot cross-compile/ : /Node .* or newer is needed/
        );

        const overridden = await sigil(
          'package',
          app,
          '--out',
          out,
          '--target',
          foreign,
          '--runtime',
          'bun'
        );
        expect(overridden.err).not.toContain('Node cannot cross-compile');
      } finally {
        rmSync(app, { force: true, recursive: true });
      }
    }, 120_000);
  });

  describe('the bundle it embeds', () => {
    it('should be one CommonJS file that runs, for the node runtime', async () => {
      // The claim with teeth. A Node single executable runs its embedded main as
      // CommonJS and cannot `import()` at all, so this form has to be
      //
      //   - one file, because a SEA has nowhere to put a chunk, and
      //   - free of top-level await, because CommonJS cannot express it and
      //     rolldown refuses the whole bundle over one.
      //
      // Proved by running it rather than by reading it: a bundle that satisfies
      // both and still does not work is the failure this is here to catch, and
      // it is what every `sigil package --runtime node` embeds.
      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'node',
        // the host, so the pre-flight passes on every machine CI runs
        '--target',
        label(hostTarget())
      );

      if (!hasBuildSea) {
        expect(err).toMatch(/Node .* or newer is needed/);
        return;
      }

      // the command has to have *succeeded*, which this did not check: `err`
      // was read only in the branch above and `process.exitCode` never, so a
      // failure in the compile step after the bundle -- a missing `codesign`,
      // say -- left this test fully green. The `.cjs` exists, has no chunks and
      // runs, which is everything it went on to assert.
      expect(err).not.toMatch(/^Error:/m);
      expect(process.exitCode).toBeFalsy();

      const bundle = join(out, 'buildable.cjs');
      expect(existsSync(bundle)).toBe(true);

      // no chunks: everything is inlined, because there is nowhere for one to be
      const written = readdirSync(out, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      expect(written.filter((name) => name.endsWith('.mjs'))).toEqual([]);
      expect(existsSync(join(out, 'chunks'))).toBe(false);

      const ran = spawnSync(process.execPath, [bundle, '--help'], { encoding: 'utf-8' });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout).toContain('Usage:');

      // and a command, which is the half that proves the inlined `import()`
      // still resolves -- a flattened bundle whose commands cannot be reached
      // would answer `--help` perfectly well
      const cmd = spawnSync(process.execPath, [bundle, 'greet', 'Ada'], { encoding: 'utf-8' });
      expect(cmd.status, cmd.stderr).toBe(0);
    }, 120_000);

    it('should keep the ESM entry and its chunks, for the bun runtime', async () => {
      // the other half of the same claim: Bun reads what `sigil build` already
      // writes, `import()` and all, so nothing about the bundle changes and the
      // lazy chunk per command survives into the binary
      const { err } = await sigil(
        'package',
        join(fixtures, 'buildable'),
        '--out',
        out,
        '--runtime',
        'bun'
      );

      if (!hasBun) {
        expect(err).toMatch(/bun is not installed/);
        return;
      }

      expect(existsSync(join(out, 'buildable.mjs'))).toBe(true);
      expect(existsSync(join(out, 'buildable.cjs'))).toBe(false);
      expect(existsSync(join(out, 'chunks'))).toBe(true);
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
        cpSync(join(fixtures, 'buildable'), app, { recursive: true });
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

    it('should refuse a missing compiler before the bundle, not after it', async () => {
      // AGENTS.md says *every* refusal happens before the bundle, and this one
      // did not: measured with `bun` off PATH, the command bundled the whole
      // app -- entry and seventeen chunks -- and then said `bun is not
      // installed`. The output directory whose absence that rule is asserted by
      // existed, fully populated.
      //
      // `PATH` is emptied rather than the tool mocked, because `whichSync()`
      // reads it per call and that is the real mechanism -- a mocked `locate()`
      // would prove the test could stub a function.
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
          'bun'
        );

        expect(err).toContain('bun is not installed');
        expect(existsSync(out)).toBe(false);
        expect(process.exitCode).toBeTruthy();
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

        const binary = join(out, 'buildable');
        expect(existsSync(binary)).toBe(true);

        const help = spawnSync(binary, ['--help'], { encoding: 'utf-8' });
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain('Usage:');

        // against the unpackaged app rather than against a literal: what is
        // being claimed is that packaging changed nothing about what the app
        // says, and a snapshot of the help screen would be a claim about help
        const unpackaged = spawnSync(process.execPath, [join(out, 'buildable.mjs'), '--help'], {
          encoding: 'utf-8',
        });
        expect(help.stdout).toBe(unpackaged.stdout);

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

        const binary = join(out, 'buildable');
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

        // against the bundle it embeds, run under node, rather than against a
        // literal: what is claimed is that wrapping the entry and flattening
        // the chunks changed nothing about what the app says, and the embedded
        // `.cjs` is the one comparison that isolates the SEA from the bundle
        const embedded = spawnSync(process.execPath, [join(out, 'buildable.cjs'), '--help'], {
          encoding: 'utf-8',
        });
        expect(help.stdout).toBe(embedded.stdout);

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
        expect(existsSync(join(out, 'buildable'))).toBe(false);

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
        expect(existsSync(join(out, 'buildable'))).toBe(true);
      },
      300_000
    );
  });
});
