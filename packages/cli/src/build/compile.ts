/**
 * Turning a bundle into a single executable.
 *
 * `sigil build` produces an app that still needs a runtime installed. This is
 * the step after it: embed a runtime and hand back one file somebody can run
 * without installing anything. Two runtimes are supported and they are not
 * interchangeable -- what each one costs is measured in AGENTS.md, and the
 * short version is that the choice decides what the app runs on, which is a
 * bigger decision than packaging.
 *
 * ## Bun, which takes the bundle as it stands
 *
 * `bun build --compile` reads the ESM entry `sigil build` already writes,
 * `import()` and all, and cross-compiles to any of five targets from any host.
 * The binary it writes is already ad-hoc signed, so it runs on Apple Silicon
 * with nothing further done to it.
 *
 * ## Node, which does not
 *
 * A Node single executable embeds **one CommonJS script** and cannot
 * `import()` at all -- every spelling fails `ERR_UNKNOWN_BUILTIN_MODULE`
 * inside a SEA, because the injected loader resolves builtins and nothing
 * else. So the Node path asks `bundleApp()` for `form: 'cjs'`, which is one
 * flat file whose `main()` call is wrapped because CommonJS cannot hold a
 * top-level `await`.
 *
 * It also cannot cross-compile, because the blob is injected into the host's
 * own `node`: the binary this produces embeds whatever runtime is running the
 * toolchain. And `--build-sea` leaves the result **unsigned**, which on Apple
 * Silicon is not a distribution concern but an execution one -- an unsigned
 * binary is killed with SIGKILL before it runs a line. So `sign()` runs on
 * darwin and is not optional there.
 */

import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The runtimes a binary can embed. */
export const RUNTIMES = ['bun', 'node'] as const;

/** Which runtime a packaged app runs on. */
export type Runtime = (typeof RUNTIMES)[number];

/** The platforms a binary can be produced for. */
export const PLATFORMS = ['darwin', 'linux', 'windows'] as const;

/** The architectures a binary can be produced for. */
export const ARCHES = ['arm64', 'x64'] as const;

/**
 * A platform and architecture to produce a binary for.
 *
 * Spelled `<platform>-<arch>` everywhere a user types one, which is the
 * spelling Go, Zig, Rust and Bun all use some version of. Deliberately *not*
 * Bun's own `bun-darwin-arm64`, which carries the runtime name: the runtime is
 * a separate choice here, so putting it in the target would mean a
 * `--runtime node --target bun-linux-x64` that reads as a contradiction.
 */
export interface Target {
  /** The architecture. */
  readonly arch: (typeof ARCHES)[number];
  /** The operating system. */
  readonly platform: (typeof PLATFORMS)[number];
}

/**
 * What Bun cannot produce, though the target is otherwise a real one.
 *
 * Bun ships no `bun-windows-arm64`, so a Windows ARM binary is not available
 * from this runtime at any host. Named rather than discovered from a failed
 * spawn, because `bun build` answers an unknown target with a usage dump and
 * the one thing a reader needs is which combination is missing.
 */
const BUN_UNSUPPORTED: readonly string[] = ['windows-arm64'];

/**
 * The lowest Node that can build a single executable in one step.
 *
 * Exported because a test has to guard on it, and the guard and the check have
 * to read the same number: `package-command.test.ts` spelled `25` and `5` of
 * its own for a while, so raising this constant would have left the tests
 * guarding on the old threshold and asserting against the new one.
 */
export const NODE_BUILD_SEA: readonly [number, number] = [25, 5];

/**
 * Whether the running Node can build a single executable in one step.
 *
 * Read off `process.versions` rather than probed by spawning, because the node
 * that builds the blob is the node running this: there is no second runtime
 * whose capabilities could differ from what this process reports.
 *
 * @returns Whether `--build-sea` is available.
 */
export function canBuildSea(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const [wantMajor, wantMinor] = NODE_BUILD_SEA;

  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/**
 * The target the toolchain is running on.
 *
 * `process.platform` and `process.arch` rather than anything read or guessed,
 * and the two values this does not understand are refused rather than passed
 * through: a target is used to name a file and to pick a Bun triple, and
 * inventing `bun-aix-ppc64` would produce a usage dump from a tool that was
 * asked a question nobody can answer.
 *
 * @returns The host's target.
 * @throws If the host is a platform or architecture no runtime here builds for.
 */
export function hostTarget(): Target {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch;

  if (!isPlatform(platform) || !isArch(arch)) {
    throw new Error(
      `Cannot package on ${process.platform}-${process.arch}: a binary can be built for ${PLATFORMS.join(', ')} on ${ARCHES.join(' and ')}, and the host is neither.`
    );
  }

  return { arch, platform };
}

/**
 * Reads a `<platform>-<arch>` target.
 *
 * Both halves are checked against the lists rather than split and trusted, so
 * `darwin-aarch64` is refused here with the spelling it should have had rather
 * than reaching a bundler that answers with its own usage.
 *
 * @param text - What the user typed.
 * @returns The target.
 * @throws If it is not a target.
 */
export function parseTarget(text: string): Target {
  const [platform, arch, ...rest] = text.split('-');

  if (rest.length || !platform || !arch || !isPlatform(platform) || !isArch(arch)) {
    throw new Error(
      `"${text}" is not a target. Targets are <platform>-<arch>: ${targets().join(', ')}.`
    );
  }

  return { arch, platform };
}

/** Every target, for a message that has to list them. */
export function targets(): string[] {
  return PLATFORMS.flatMap((platform) => ARCHES.map((arch) => label({ arch, platform })));
}

/**
 * A target as the user spells it.
 *
 * @param target - The target.
 * @returns `<platform>-<arch>`.
 */
export function label(target: Target): string {
  return `${target.platform}-${target.arch}`;
}

/**
 * What the binary is called on a given target.
 *
 * The `.exe` is not cosmetic: Windows will not execute a file without it, so a
 * cross-compiled Windows binary that kept the bare name would arrive unusable
 * and look like a packaging bug on the machine that could not run it anyway.
 *
 * @param name - The app's name.
 * @param target - What it was built for.
 * @returns The file name.
 */
export function binaryName(name: string, target: Target): string {
  return target.platform === 'windows' ? `${name}.exe` : name;
}

/**
 * What a binary is called when it is one of a set being built.
 *
 * One target is the ordinary case and `myapp` is what its users type, so a lone
 * binary is not named after the machine it was built for. Several at once is a
 * release, where every one of them would otherwise be written to the same path
 * and the last would be the only survivor -- reported as several binaries,
 * which is the quiet version of that bug.
 *
 * Exported rather than private to `sigil package`, and the reason is the
 * scaffolded release workflow: that file spells five of these names as literal
 * text, so nothing in a build connects it to this convention. A guard in
 * `new.test.ts` asserts the literals against this function, which it can only
 * do if the function is reachable.
 *
 * @param name - The app's name.
 * @param target - This one.
 * @param among - Everything being built, this one included.
 * @returns The file name, extension and all.
 */
export function outputName(name: string, target: Target, among: readonly Target[]): string {
  return binaryName(among.length === 1 ? name : `${name}-${label(target)}`, target);
}

/**
 * Refuses a runtime and target pair that cannot produce a binary.
 *
 * Asked **before** the bundle rather than at the compile step, which is the
 * rule `--bin` beside a routed directory already follows: a failure the build
 * can see coming is a build error, and finding out that Bun has no
 * `windows-arm64` after paying for a type-check and a bundle is finding out
 * late for no reason. Nothing here reads the disk or spawns anything, so there
 * is no cost to asking first.
 *
 * The compile functions ask it too. That is not belt-and-braces: they are
 * exported, so a caller that is not `sigil package` would otherwise reach the
 * spawn with an impossible pair -- and one implementation asked twice cannot
 * come to disagree with itself the way two copies would.
 *
 * @param runtime - Which runtime would be embedded.
 * @param target - What it would be built for.
 * @throws If that runtime cannot produce that target here.
 */
export function assertCompilable(runtime: Runtime, target: Target): void {
  if (runtime === 'bun') {
    if (BUN_UNSUPPORTED.includes(label(target))) {
      throw new Error(
        `Bun cannot build ${label(target)}: it ships no runtime for it. Use --runtime node on a ${label(target)} machine, or drop the target.`
      );
    }
    return;
  }

  assertBuildSea();

  const host = hostTarget();
  if (label(target) !== label(host)) {
    throw new Error(
      `Node cannot cross-compile: a single executable is built by injecting a blob into the host's own node, so ${label(target)} has to be built on ${label(target)}. This is ${label(host)}. Use --runtime bun, which cross-compiles, or build this target on its own machine.`
    );
  }
}

/**
 * Refuses a package whose compiler or signer is not installed.
 *
 * Separate from `assertCompilable()` and deliberately not folded into it: that
 * one is pure -- no disk, no spawn -- and `compile.test.ts` asserts so in its
 * header, because it is asked for every target before anything happens. This
 * one touches `PATH`, so it is its own step.
 *
 * It exists because the AGENTS.md rule says *every* refusal happens before the
 * bundle and two of them did not. Measured: with `bun` off `PATH`,
 * `sigil package --runtime bun` bundled the whole app -- entry and seventeen
 * chunks written -- and then said `bun is not installed`. With `codesign` off
 * `PATH`, `--runtime node` bundled, spent 2.1s building a 145 MB SEA, and then
 * failed, **leaving the unsigned binary behind** -- which is the one artifact
 * that cannot run, sitting under the name a release workflow attaches by.
 *
 * Both are knowable from `PATH` before a byte of the app is read, which is what
 * makes them the same class as the target checks rather than a new one.
 *
 * @param runtime - Which runtime would be embedded.
 * @param targets - Everything that would be built.
 * @param identity - A codesigning identity, if one was asked for.
 * @throws If a tool the run will need is not installed.
 */
export function assertToolchain(
  runtime: Runtime,
  targets: readonly Target[],
  identity: string | undefined
): void {
  if (runtime === 'bun') {
    locate('bun', '--runtime bun needs it to compile the binary.');
  }

  // `codesign` is wanted wherever a darwin binary will actually be signed,
  // which is not the same as "a darwin target exists": Bun's output is already
  // ad-hoc signed, so the Bun path only reaches `codesign` when an identity was
  // asked for. Asking for the tool a run will not use would refuse a perfectly
  // good cross-compile from Linux, where there is no `codesign` at all
  if (targets.some((target) => signsOn(target, runtime, identity))) {
    locate(
      'codesign',
      'A macOS binary has to be signed to run at all -- an unsigned one is killed before it starts -- so this is not something to skip.'
    );
  }
}

/**
 * Whether a binary for this target will be code-signed.
 *
 * One function so that the pre-flight and the compile step cannot disagree
 * about whether `codesign` is going to be run -- a pre-flight that demanded a
 * tool the compile never used, or skipped one it did, would be worse than no
 * pre-flight.
 *
 * @param target - What is being built.
 * @param runtime - Which runtime is embedded.
 * @param identity - A codesigning identity, if one was asked for.
 * @returns Whether `sign()` will do anything.
 */
function signsOn(target: Target, runtime: Runtime, identity: string | undefined): boolean {
  if (target.platform !== 'darwin') {
    return false;
  }

  // Node's output is unsigned and unrunnable until it is signed, so it is
  // always signed. Bun's is already `adhoc, linker-signed`, so it is signed
  // only when somebody asked for a particular identity
  return runtime === 'node' || identity !== undefined;
}

/** What `compile()` was asked to do. */
export interface CompileOptions {
  /** The bundle to embed -- ESM for Bun, the flat `.cjs` for Node. */
  readonly entry: string;
  /** Where the binary goes, including any `.exe`. */
  readonly out: string;
  /**
   * A codesigning identity, or `-` for ad-hoc.
   *
   * Only read on darwin, where it is not optional: see `sign()`.
   */
  readonly sign?: string;
  /** What to build for. */
  readonly target: Target;
}

/** What came out. */
export interface CompileResult {
  /** The binary's size in bytes. */
  readonly size: number;
  /** Whether it was code-signed, and with what. */
  readonly signed?: string;
}

/**
 * Compiles a bundle into a binary with Bun's runtime embedded.
 *
 * @param options - The bundle, the target, and where it goes.
 * @returns What was produced.
 * @throws If Bun is not installed, cannot build that target, or fails.
 */
export function compileWithBun(options: CompileOptions): CompileResult {
  const { entry, out, sign: identity, target } = options;

  assertCompilable('bun', target);

  const bun = locate('bun', '--runtime bun needs it to compile the binary.');
  const run = spawnSync(
    bun,
    [
      'build',
      '--compile',
      `--target=bun-${label(target)}`,
      entry,
      '--outfile',
      out,
      // the bundle is already minified by `sigil build`, and asking Bun to do
      // it again buys nothing measurable while making a stack trace from the
      // packaged binary harder to read than one from the unpackaged app
      '--sourcemap=none',
    ],
    { encoding: 'utf-8' }
  );

  if (run.error) {
    throw new Error(`Failed to run bun at ${bun}: ${run.error.message}`);
  }

  if (run.status !== 0) {
    throw new Error(`bun build --compile failed for ${label(target)}:\n${said(run)}`);
  }

  // Bun ad-hoc signs what it writes -- `adhoc, linker-signed` on a darwin
  // target -- so there is nothing to do for the default case. An **explicit**
  // identity is still honoured here, and that is a fix rather than a flourish:
  // `--sign` used to be accepted and silently discarded on this path, so
  // `sigil package --runtime bun --sign "Developer ID Application: ..."` exited
  // 0 and produced `Signature=adhoc, TeamIdentifier=not set`. The caller asked
  // for Developer ID signing, was told nothing, and got a binary that fails
  // Gatekeeper -- which is the exact failure `--sign` exists to avoid, and the
  // scaffolded workflow's own comment points at this flag.
  return signed(out, target, identity, 'bun');
}

/**
 * Compiles a bundle into a binary with Node's runtime embedded.
 *
 * @param options - The bundle, the target, and where it goes.
 * @returns What was produced.
 * @throws If this Node cannot build one, the target is not the host, or it
 *   fails.
 */
export function compileWithNode(options: CompileOptions): CompileResult {
  const { entry, out, sign: identity, target } = options;

  assertCompilable('node', target);

  // the config is the interface `--build-sea` takes, and it is written to a
  // temporary directory rather than beside the output: it names an absolute
  // input and an absolute output, so nothing resolves against where it sits,
  // and a build artifact nobody asked for should not survive the build
  const dir = mkdtempSync(join(tmpdir(), 'sigil-sea-'));

  try {
    const config = join(dir, 'sea-config.json');
    writeFileSync(
      config,
      `${JSON.stringify(
        {
          disableExperimentalSEAWarning: true,
          main: entry,
          output: out,
          // the V8 code cache for the embedded script, which is sound here for
          // the reason cross-compiling is not: the cache is specific to this
          // node on this platform, and this is the node being embedded
          useCodeCache: true,
        },
        undefined,
        2
      )}\n`,
      'utf-8'
    );

    const run = spawnSync(process.execPath, [`--build-sea=${config}`], { encoding: 'utf-8' });

    if (run.error) {
      throw new Error(`Failed to run node at ${process.execPath}: ${run.error.message}`);
    }

    if (run.status !== 0) {
      throw new Error(`node --build-sea failed:\n${said(run)}`);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }

  // signed first, then measured. The two used to be one object literal with
  // `sizeOf(out)` written before `sign(...)`, and properties evaluate in order
  // -- so every signed Node binary's headline figure was the pre-signature
  // size: 138.6 MB reported for a file that was 138.8 MB on disk, because
  // ad-hoc signing adds about 0.3 MB.
  return signed(out, target, identity, 'node');
}

/**
 * Signs a binary where the platform and runtime need it, and reports its size.
 *
 * One function for both runtimes, which is what stops `--sign` meaning two
 * things. The size is taken **after** signing, because signing changes it.
 *
 * A failure here **removes the binary**, which is the rule `undo()` in
 * `bundle.ts` already follows: a refused build must not leave the thing it
 * refused. It matters more here than anywhere else in the build, because on
 * darwin the unsigned binary is precisely the artifact that cannot run -- exit
 * 137, killed before it executes a line -- and it would be sitting under the
 * name a release workflow attaches by, indistinguishable from a good one.
 *
 * @param file - The binary.
 * @param target - What it was built for.
 * @param identity - A signing identity, or undefined for the runtime's default.
 * @param runtime - Which runtime is embedded.
 * @returns The binary's size in bytes, after any signing.
 * @throws If signing was needed and failed.
 */
function signed(
  file: string,
  target: Target,
  identity: string | undefined,
  runtime: Runtime
): CompileResult {
  if (!signsOn(target, runtime, identity)) {
    // nothing was signed *here*, which is not the same as unsigned: Bun's own
    // output is already ad-hoc signed, and saying so is the table's job rather
    // than this function's
    return { size: sizeOf(file) };
  }

  // what was actually used rather than what was passed, so the table cannot
  // report `ad-hoc` over a Developer ID or an empty column over a real signing
  const used = identity ?? '-';

  try {
    sign(file, used);
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }

  return { signed: used, size: sizeOf(file) };
}

/**
 * Code-signs a binary, where the platform needs it.
 *
 * On Apple Silicon this is the difference between a binary and a file: an
 * unsigned one is killed with SIGKILL, measured as exit 137 with no output at
 * all, on the very machine that produced it. `--build-sea` strips the
 * signature `node` itself ships with -- `codesign -dv` answers
 * `code object is not signed at all` -- so this is a repair rather than a
 * finishing touch, and it is why a failure here fails the package.
 *
 * Ad-hoc by default, which is what makes the binary runnable and nothing more.
 * It does **not** get it past Gatekeeper on somebody else's machine: that is a
 * Developer ID, which `--sign` takes, plus notarization, which is deliberately
 * not here -- see AGENTS.md.
 *
 * Linux and Windows are left alone. Linux has no such mechanism; Windows has
 * Authenticode, which needs a real certificate and `signtool`, and an ad-hoc
 * equivalent does not exist -- so there is nothing honest to do by default.
 *
 * @param file - The binary.
 * @param target - What it was built for.
 * @param identity - A signing identity, or `-` for ad-hoc.
 * @returns Whether it was signed.
 * @throws If signing was needed and failed.
 */
function sign(file: string, identity: string): void {
  const run = spawnSync('codesign', ['--sign', identity, '--force', file], { encoding: 'utf-8' });

  if (run.error) {
    throw new Error(
      `Failed to run codesign: ${run.error.message}\n  A macOS binary must be signed to run at all -- an unsigned one is killed before it starts -- so this is not something to skip.`
    );
  }

  if (run.status !== 0) {
    throw new Error(`codesign failed for ${file}:\n${said(run)}`);
  }
}

/**
 * Refuses a Node that cannot build a single executable in one step.
 *
 * `--build-sea` arrived in Node 25.5 and replaced a three-step dance through
 * `--experimental-sea-config` and `postject`, an external tool. Supporting the
 * old path would mean taking a dependency to work around a Node this
 * toolchain's own `engines` does not require anybody to be on -- so the answer
 * is to say which Node is needed, naming the one in hand.
 *
 * Read off `process.versions` rather than probed by spawning, because the node
 * that builds the blob is the node running this: there is no second runtime
 * whose capabilities could differ from what this process reports.
 *
 * @throws If this Node has no `--build-sea`.
 */
function assertBuildSea(): void {
  if (canBuildSea()) {
    return;
  }

  const [wantMajor, wantMinor] = NODE_BUILD_SEA;

  throw new Error(
    `Node ${wantMajor}.${wantMinor} or newer is needed to package with --runtime node, and this is ${process.versions.node}. Earlier versions build a single executable through postject, an external tool this toolchain will not install for you. Use --runtime bun, or upgrade Node.`
  );
}

/**
 * Finds an executable, or says what to install and what wanted it.
 *
 * The reason is the caller's rather than built from the name, which is what the
 * first version did: it wrote `--runtime ${name} needs it`, so a missing
 * `codesign` was reported as `--runtime codesign needs it to compile the
 * binary` -- a flag nobody can pass, about a tool that is not a runtime.
 *
 * @param name - The executable.
 * @param why - What wanted it, as a sentence.
 * @returns Its path.
 * @throws If it is not on `PATH`.
 */
function locate(name: string, why: string): string {
  const found = whichSync(name);

  if (!found) {
    throw new Error(`${name} is not installed, or is not on PATH. ${why}`);
  }

  return found;
}

/** Whatever a failed spawn said, indented, with the empty stream left out. */
function said(run: { readonly stderr?: string; readonly stdout?: string }): string {
  return [run.stderr, run.stdout]
    .filter((stream): stream is string => Boolean(stream?.trim()))
    .join('\n')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * The size of a file something has just claimed to write.
 *
 * Asked rather than assumed, because a compiler that exits zero having written
 * nothing is a thing that happens, and reporting a binary that is not there is
 * worse than failing.
 *
 * @param file - The binary.
 * @returns Its size in bytes.
 * @throws If it is not there.
 */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    throw new Error(`The compiler reported success but wrote no binary at ${file}.`);
  }
}

/** Whether a string is one of the platforms. */
function isPlatform(value: string): value is Target['platform'] {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Whether a string is one of the architectures. */
function isArch(value: string): value is Target['arch'] {
  return (ARCHES as readonly string[]).includes(value);
}
