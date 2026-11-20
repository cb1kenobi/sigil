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
 * It also cannot cross-compile, because the blob is injected into a `node` of
 * the host's own platform: the binary this produces embeds the node whose
 * `--build-sea` ran, which is `exec` -- not necessarily the one running the
 * toolchain, which is what this used to say. And `--build-sea` leaves the result **unsigned**, which on Apple
 * Silicon is not a distribution concern but an execution one -- an unsigned
 * binary is killed with SIGKILL before it runs a line. So `sign()` runs on
 * darwin and is not optional there.
 */

import { escapeControls } from '@ttylabs/sigil/error-handler';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * Whether a Node version can build a single executable in one step.
 *
 * Arithmetic over a version string, so it answers for **any** node rather than
 * only this one: the callers ask it about the `node` on `PATH`, about a version
 * the registry listed, and about a version somebody typed. `process.versions`
 * is the default and nothing more.
 *
 * Both this and `assertBuildSea()` used to carry a paragraph saying the opposite
 * -- that it is read off `process.versions` rather than probed, because "the
 * node that builds the blob is the node running this: there is no second runtime
 * whose capabilities could differ from what this process reports". That was true
 * when there was no way to name a runtime, and the version parameter and
 * `--runtime node@<version>` each made it false while it sat here in two
 * identical copies. It is the premise the defect `resolveExec()` records grew
 * out of, so it is written out rather than deleted.
 *
 * @param version - The version to judge, defaulting to this process's.
 * @returns Whether `--build-sea` is available.
 */
export function canBuildSea(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
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
 * Whether a target is the machine this is running on.
 *
 * @param target - The target.
 * @returns Whether it is. A host that is no target at all is no target's host.
 */
export function isHostTarget(target: Target): boolean {
  try {
    return label(target) === label(hostTarget());
  } catch {
    return false;
  }
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
      `"${escapeControls(text)}" is not a target. Targets are <platform>-<arch>: ${targets().join(', ')}.`
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
 * It says nothing about **versions**, and that is the point: the host's Node
 * version used to be checked here, which would have stopped somebody on Node 24
 * choosing `node@26.12.1` for sigil to fetch. Whether a given Node can package
 * itself is `canBuildSea()`, asked of the node that will actually run.
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
 * one is pure -- no disk, no spawn -- because it is asked for every target
 * before anything happens. This one walks `PATH`, so it is its own step.
 *
 * It exists because the AGENTS.md rule says *every* refusal happens before the
 * bundle and one of them did not: with `codesign` off `PATH`, the Node path
 * bundled, spent 2.1s building a 145 MB SEA, and then failed, **leaving the
 * unsigned binary behind** -- the one artifact that cannot run, sitting under
 * the name a release workflow attaches by.
 *
 * What it deliberately does **not** check is whether the *runtime* is
 * installed. It did, and that was wrong twice over: "package with Bun" is a
 * complete instruction, and sigil can satisfy it by fetching a Bun -- so a
 * missing one is a thing to resolve rather than refuse. Looking on `PATH` is an
 * optimisation and never a reason to stop. See `resolveExec()` in
 * `package.ts`.
 *
 * @param runtime - Which runtime would be embedded.
 * @param targets - Everything that would be built.
 * @param identity - A codesigning identity, if one was asked for.
 * @throws If `codesign` is needed and is not installed.
 */
export function assertToolchain(
  runtime: Runtime,
  targets: readonly Target[],
  identity: string | undefined
): void {
  // `codesign` is wanted wherever a darwin binary will actually be signed,
  // which `signsOn()` decides and is asked rather than restated here.
  //
  // What that comes to is every darwin target, whatever the runtime -- so this
  // really does refuse a cross-compile to darwin from a machine with no
  // `codesign`, which is every Linux and every Windows one. An earlier version
  // of this comment called that outcome the reason *not* to ask, on the reading
  // that Bun's output is already ad-hoc signed and so needs nothing; `signsOn()`
  // records the measurement that overturned it -- Bun 1.3.0's output reports
  // `adhoc, linker-signed` and is SIGKILLed anyway. A cross-compile to darwin
  // from Linux is therefore not a perfectly good one: it writes a binary that
  // cannot run. Refusing up front is the honest form of that, which is why the
  // workflow `sigil new` scaffolds runs on macOS
  if (targets.some((target) => signsOn(target, runtime, identity))) {
    locate(
      'codesign',
      'A macOS binary has to be signed to run at all -- an unsigned one is killed before it starts -- so this is not something to skip.'
    );
  }
}

/**
 * Refuses an identity that is not one.
 *
 * Blank only, and deliberately **not** "this target cannot use it". That was
 * the first version and it was a severe regression: `assertSignable()` in the
 * command is *set-level* -- it refuses an identity only when **no** target is
 * darwin, because in a mixed set the identity signs the darwin member and the
 * others are simply not signed -- and moving the refusal down to a per-target
 * layer turned a per-set decision into a per-target one. Measured: a
 * `--target darwin-arm64 --target linux-x64 --sign -` release built the darwin
 * binary, signed it, then refused the linux target and **deleted the darwin
 * binary on the way out**, where the commit before produced both correctly.
 *
 * What makes the per-target refusal unnecessary is that nothing is silent here:
 * `CompileResult.signed` is absent when nothing was signed, so an exported
 * caller passing an identity with a non-darwin target is told, by the result,
 * that it was not used. Round 1's silent-drop defect was that the **table** and
 * the user saw nothing; the programmatic surface always reported it.
 *
 * @param identity - What the caller asked for, if anything.
 * @throws If an identity was given and is blank.
 */
function assertSignUsable(identity: string | undefined): void {
  if (identity !== undefined && !isIdentity(identity)) {
    throw new Error(
      `A codesigning identity cannot be blank. Pass a real identity, or none at all.`
    );
  }
}

/**
 * Whether a string names a codesigning identity.
 *
 * `undefined` is "none given" and so is `''`: `--sign=` is how a value gets
 * deliberately emptied, and an empty identity is not one `codesign` can use --
 * measured, it answers `: no identity found` after the bundle and an 85 MB
 * compile have already run. Whitespace is the same thing less mechanically.
 *
 * Asked in one place so that the pre-flight, `signsOn()` and the identity
 * `signed()` passes to `codesign` cannot disagree about what counts: all three
 * tested `!== undefined` and so all three took `''` for an identity.
 *
 * @param identity - What `--sign` said, if anything.
 * @returns Whether it names one.
 */
export function isIdentity(identity: string | undefined): boolean {
  return identityOf(identity) !== undefined;
}

/**
 * A codesigning identity as `codesign` should receive it, or `undefined`.
 *
 * Trims, and reads a blank as none. The trimming used to be spent entirely on
 * the *emptiness* question and none of it on the **value**: `isIdentity()`
 * asked `identity.trim() !== ''` while `signed()` passed the string verbatim,
 * so `--sign ' - '` named an identity to every guard and then reached
 * `codesign`, which does an exact lookup, as ` - : no identity found` -- after
 * the bundle and an 85 MB compile. `' - '` is the sharpest spelling of it,
 * because `-` is this code's own ad-hoc sentinel: a caller quoting it has asked
 * for exactly the default and is refused nothing up front.
 *
 * @param identity - What the caller asked for, if anything.
 * @returns The identity to use, or `undefined` for none.
 */
export function identityOf(identity: string | undefined): string | undefined {
  const trimmed = identity?.trim();

  return trimmed ? trimmed : undefined;
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
  // the target, and nothing about the producer. This used to read
  // `runtime === 'node' || isIdentity(identity)` on the ground that Bun's
  // output is already `adhoc, linker-signed` and so needs nothing -- which is
  // true of what Bun writes and **not** true of whether it runs.
  //
  // Measured: a binary compiled by Bun 1.3.0 reports
  // `flags=0x20002(adhoc,linker-signed)` and is still **SIGKILLed**, exit 137,
  // on the machine that produced it. `codesign --sign - --force` over the same
  // file makes it run. So a signature being present is not a signature being
  // valid, and "the producer signed it" is not a fact this can act on -- which
  // matters the moment `--runtime bun@<version>` lets somebody target a Bun
  // other than the one on their PATH.
  //
  // Re-signing a binary that was already fine is harmless, measured on Bun
  // 1.4.4's output, so the cheap answer is also the correct one: on darwin,
  // always ensure a signature.
  void runtime;
  void identity;

  return target.platform === 'darwin';
}

/**
 * The first Bun whose `Bun.build()` honours `compile`: 1.2.20 takes the option,
 * ignores it, writes nothing and answers `success: true`, and 1.2.21 writes the
 * binary (both measured).
 */
export const BUN_COMPILES_FROM = '1.2.21';

/** What `compile()` was asked to do. */
export interface CompileOptions {
  /** The bundle to embed -- ESM for Bun, the flat `.cjs` for Node. */
  readonly entry: string;
  /** Where the binary goes, including any `.exe`. */
  readonly out: string;
  /**
   * A codesigning identity, or `-` for ad-hoc.
   *
   * Used where the target can be signed, which is darwin only. Elsewhere it is
   * **not** an error -- a release names it once for a set of targets and only
   * the darwin members use it -- and the result says what happened:
   * `CompileResult.signed` is absent when nothing was signed. A *blank*
   * identity is refused, because it is not one.
   */
  readonly sign?: string;
  /**
   * The runtime executable to compile with.
   *
   * For Bun it is the `bun` that does the **bundling**, and that is the whole
   * of why this option exists: `--target=bun-...-v<version>` downloads the
   * runtime but leaves the bundler as whatever is on `PATH`, and a 1.4.4
   * bundler writing into a 1.3.0 runtime produces a binary that prints Bun's
   * usage text instead of the app -- exit 0 at compile time and at run time.
   *
   * For Node it is the node whose `--build-sea` runs, which is the node the
   * binary embeds. Node's SEA config has an `executable` field that would let
   * the host inject into some other node, and it silently produces a broken
   * binary across a version boundary -- see `runtimes.ts`.
   *
   * Defaults to whatever the host has: `bun` on `PATH`, or this process. That
   * default is for an exported caller only -- `sigil package` always names one,
   * for the reason `resolveExec()` records: the Node default is
   * `process.execPath` while everything that *decides* reads `PATH`, so leaving
   * it unset there checked one binary and compiled with another.
   */
  readonly exec?: string;
  /**
   * The verified runtime to embed, for a Bun binary.
   *
   * **Required for a target that is not the host**, and refused without: left
   * to itself, `bun build --compile --target=bun-<other>` downloads that
   * target's runtime into its own cache and embeds whatever it got, by rules
   * sigil does not control and cannot see. `bunTargetRuntime()` is what
   * produces one that has been checked against npm's own digest for it. Given
   * for the host target as well, it is embedded in place of `exec` itself.
   * Ignored by Node, which embeds the `node` whose `--build-sea` ran.
   */
  readonly embed?: string;
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
 * Runs the part of a compile that writes the binary, and removes it on failure.
 *
 * The bracket starts **after** the assertions and the `PATH` lookups, which is
 * what makes it precise without a stat: nothing before it has written to `out`,
 * so a failure inside it is a failure of something that was writing. That
 * matters under `--no-clean`, where the path may hold a previous release's
 * binary that a pre-write refusal must not touch.
 *
 * It was true of the Bun path and **false of the Node one**, which is the way
 * round that hurts: `locate('bun')` has always sat above `compileWithBun()`'s
 * bracket, while `assertBuildSea()` sat inside `compileSea()` -- so
 * `compileWithNode({ out: 'release/myapp', ... })` under a node below 25.5, or
 * given an `exec` that is not a node, refused before writing a byte and deleted
 * the good `release/myapp` that was already there on its way out. `sigil
 * package` was not exposed, because `resolveExec()` has already picked a node
 * that can do the job -- but these functions are exported precisely so that a
 * direct caller gets the same guarantees, and the Bun half of this cleanup had a
 * test for exactly that case while the Node half had none. Both halves of both
 * runtimes are pinned now.
 *
 * Reproduced before it existed, with `ulimit -f 2048` so the real compilers die
 * mid-write: `compileWithNode()` threw `node --build-sea failed` and left
 * **2,097,152 bytes** at the output path. `sigil package` was covered, because
 * `compileAll()` cleans up in the command -- but these two functions are
 * exported, and a direct caller got a truncated binary under the final name,
 * which is the indistinguishability the whole cleanup exists to prevent. Real
 * `bun build --compile` unlinks its own partial, so for that one this is a belt
 * over Bun's braces; for Node it is the only thing between a full disk and a
 * truncated `myapp-linux-x64` in a release directory.
 *
 * @param out - The binary's path.
 * @param write - The compile, which may throw.
 * @returns Whatever the compile returned.
 * @throws Whatever the compile threw, never something about the removal.
 */
function written(out: string, write: () => CompileResult): CompileResult {
  try {
    return write();
  } catch (e) {
    try {
      rmSync(out, { force: true });
    } catch {
      // never over the error being unwound: a removal that fails would replace
      // `file too large` -- the actionable half -- with a sentence about the
      // file system. The rule `undo()` records in `bundle.ts`
    }

    throw e;
  }
}

/**
 * Compiles a bundle into a binary with Bun's runtime embedded.
 *
 * @param options - The bundle, the target, and where it goes.
 * @returns What was produced.
 * @throws If Bun is not installed, cannot build that target, or fails.
 */
export function compileWithBun(options: CompileOptions): CompileResult {
  const { out, sign: identity, target } = options;

  assertCompilable('bun', target);
  assertSignUsable(identity);

  const bun = options.exec ?? locate('bun', 'Packaging with Bun needs it to compile the binary.');

  // before the bracket, for `written()`'s reason: a refusal that wrote nothing
  // must not delete what is at `out`
  if (options.embed === undefined && !isHostTarget(target)) {
    throw new Error(
      `Refusing to compile for ${label(target)} without a verified runtime to embed: bun would download that platform's runtime itself and embed it unchecked.\n  Resolve one with bunTargetRuntime() and pass it as "embed" -- "sigil package" does.`
    );
  }

  return written(out, () => compileBun(bun, options));
}

/**
 * The writing half of a Bun compile, which `written()` brackets.
 *
 * @param bun - The resolved `bun` executable.
 * @param options - What to compile and where it goes.
 * @returns What was produced.
 */
function compileBun(bun: string, options: CompileOptions): CompileResult {
  const { embed, entry, out, sign: identity, target } = options;
  const run =
    embed === undefined
      ? scratch((here) =>
          spawnSync(
            bun,
            [
              'build',
              '--compile',
              `--target=bun-${label(target)}`,
              // absolute, because it no longer runs where the caller did
              resolve(entry),
              '--outfile',
              resolve(out),
              // the bundle is already minified by `sigil build`, and asking Bun to do
              // it again buys nothing measurable while making a stack trace from the
              // packaged binary harder to read than one from the unpackaged app
              '--sourcemap=none',
            ],
            { cwd: here, encoding: 'utf-8', env: offline(here) }
          )
        )
      : compileEmbedding(bun, options, embed);

  if (run.error) {
    throw new Error(`Failed to run bun at ${bun}: ${escapeControls(run.error.message)}`);
  }

  if (run.status !== 0) {
    // the one failure this environment is built to cause: a Bun that tried to
    // fetch a runtime because it does not agree with node about the host
    const hint =
      embed === undefined && /Failed to download/.test(run.stderr)
        ? `\n  bun is not a native ${label(target)} build although node reports ${label(target)} (Rosetta?), so it tried to fetch that platform's runtime, which sigil does not allow it to. Use a node and a bun of the same architecture.`
        : '';

    throw new Error(`bun build --compile failed for ${label(target)}:\n${said(run)}${hint}`);
  }

  if (embed !== undefined) {
    assertEmbedded(out, embed, bun, target);
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
 * Runs `work` in an empty directory made for it, and removes the directory after.
 *
 * @param work - Given the directory.
 * @returns What `work` returned.
 */
function scratch<T>(work: (here: string) => T): T {
  const here = mkdtempSync(join(tmpdir(), 'sigil-compile-'));

  try {
    return work(here);
  } finally {
    rmSync(here, { force: true, recursive: true });
  }
}

/**
 * What a `bun` is run in, so that it can neither download a runtime nor find one
 * that nobody checked.
 *
 * Both compile spawns run in it. Which targets are the host's is decided by the
 * platform and architecture **node** reports, and a `bun` can disagree -- an x64
 * node under Rosetta beside a native arm64 `bun` counts `darwin-x64` as the host
 * and runs the CLI form, which for a target it takes to be foreign looks for
 * `bun-<triple>-v<version>` first in its **working directory**, then in its
 * **install cache** (`BUN_INSTALL_CACHE_DIR`, or `~/.bun/install/cache`), uses
 * what it finds there with no check of any kind, and only then downloads. Three
 * things are closed, one for each place it looks:
 *
 * - **The working directory** is `here`, an empty directory, so nothing in the
 *   directory sigil was started from can be a runtime.
 * - **The install cache** is `here` too, set through `BUN_INSTALL_CACHE_DIR`, so
 *   neither the user's own `~/.bun/install/cache` nor anything planted in it is
 *   read. Measured: a renamed 1.3.0 arm64 binary as `bun-darwin-x64-v1.4.4`, in
 *   the cache or in the working directory, was embedded silently into a
 *   "darwin-x64" binary that is Mach-O arm64 and reports 1.3.0.
 * - **The network** is every proxy variable at a port nothing can listen on
 *   (`:0`, which fails at once; `:9` can be bound unprivileged on macOS, and a
 *   silent listener there hung Bun for good) with `NO_PROXY` removed in every
 *   spelling, since `NO_PROXY=*` was measured to send the request straight past
 *   a dead proxy.
 *
 * What is left is a loud failure -- `Failed to download 'bun-darwin-x64-v1.4.4':
 * ConnectionRefused` -- rather than an unchecked runtime in a shipped binary. A
 * host-target compile and a `Bun.build()` cross compile with an embedded runtime
 * both still succeed in it.
 *
 * @param here - An empty directory, which is also where the spawn runs.
 * @returns The environment to spawn `bun` with.
 */
function offline(here: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: here };

  // by lower case, because Windows keeps the user's own spelling (`No_Proxy`)
  // and looks a name up without regard to case, so two names are one
  for (const name of Object.keys(env)) {
    if (/^(?:https?_proxy|no_proxy)$/i.test(name)) {
      delete env[name];
    }
  }

  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    env[name] = DEAD_PROXY;
  }

  return env;
}

/** A proxy address that refuses at once: port 0 is not one anything can listen on. */
const DEAD_PROXY = 'http://127.0.0.1:0';

/**
 * The script a `bun` runs to compile with a runtime it was handed.
 *
 * For a target that is not the host, `bun build --compile` downloads that
 * target's runtime itself. Bun 1.4.4 has a flag for naming one
 * (`--compile-executable-path`) and it is **not used**, on purpose: Bun 1.3.0
 * accepts an unknown flag silently and downloads anyway, so the flag cannot
 * tell a Bun that honours it from one that does not. `Bun.build()` takes
 * `compile.executablePath` and fails visibly on a Bun that cannot (see
 * `assertEmbedded()`), which is why it is the form here. It embeds the file it
 * names and fetches nothing
 * -- measured with the network refused: the CLI form failed with
 * `Failed to download 'bun-linux-x64-v1.4.4': ConnectionRefused` and this wrote
 * the binary, byte for byte the one the CLI wrote with the network up.
 *
 * Arguments are positional and absolute, because the script runs in a directory
 * of its own (see `compileEmbedding()`).
 */
const COMPILE_WITH = `
const [entry, outfile, target, executablePath] = process.argv.slice(1);
try {
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { executablePath, outfile, target },
    sourcemap: 'none',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'the build failed');
  }
} catch (error) {
  const logs = error instanceof AggregateError ? error.errors : [error];
  console.error(logs.map((one) => String(one?.message ?? one)).join('\\n'));
  process.exit(1);
}
`;

/**
 * Runs `Bun.build()` with `compile.executablePath` under the bundler.
 *
 * In a directory made for it, and with nothing else read from where the user
 * happens to be: a script run by `bun` loads that directory's `bunfig.toml`,
 * `preload` included, which `bun build` does not -- measured, a `preload` there
 * printed from the script and not from the CLI form. The compile is therefore
 * not run from the app, and every path it is given is absolute.
 *
 * @param bun - The bundler.
 * @param options - What to compile and where it goes.
 * @param embed - The runtime to embed.
 * @returns The finished process.
 */
function compileEmbedding(bun: string, options: CompileOptions, embed: string) {
  return scratch((here) => {
    // whatever is at the output goes first. A Bun that predates `compile` in
    // `Bun.build()` writes nothing and answers `success: true`, so a binary an
    // earlier run left there -- `--no-clean` keeps one -- would pass the size
    // check in `assertEmbedded()` and be shipped as this run's
    rmSync(options.out, { force: true });

    return spawnSync(
      bun,
      [
        '--no-install',
        '-e',
        COMPILE_WITH,
        resolve(options.entry),
        resolve(options.out),
        `bun-${label(options.target)}`,
        resolve(embed),
      ],
      { cwd: here, encoding: 'utf-8', env: offline(here) }
    );
  });
}

/**
 * Refuses a compile that did not write the binary it was asked for.
 *
 * Needed because a Bun that predates `compile` in `Bun.build()` takes the
 * option, ignores it, writes nothing and answers `success: true` -- measured,
 * 1.2.20 does and 1.2.21 does not. A binary smaller than the runtime inside it
 * is the same failure by another route -- smaller than half of it, which no
 * binary holding it can be.
 *
 * @param out - Where the binary should be.
 * @param embed - The runtime that should be in it.
 * @param bun - The bundler, for the message.
 * @param target - What was being built.
 * @throws If there is no binary there, or it is smaller than the runtime.
 */
function assertEmbedded(out: string, embed: string, bun: string, target: Target): void {
  let wrote = -1;

  try {
    wrote = statSync(out).size;
  } catch {
    // nothing there, which is the answer
  }

  // half, not all: a Mach-O runtime's signature is replaced on the way in, so
  // the binary can come out a few hundred kilobytes under the file it embeds
  if (wrote < statSync(embed).size / 2) {
    throw new Error(
      `${bun} exited cleanly and did not write a binary for ${label(target)} at ${out}.\n  A Bun that old accepts "compile" in Bun.build() and ignores it; use ${BUN_COMPILES_FROM} or newer.`
    );
  }
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
  const { out, sign: identity, target } = options;

  assertCompilable('node', target);
  assertSignUsable(identity);

  // the **target's** own `--build-sea`, not the host's. Producer and consumer
  // are then the same binary, so there is no cross-version blob format to get
  // wrong -- which the `executable` field route does get wrong, silently.
  //
  // The fallback is unreachable from `sigil package`, which always names one:
  // it was reachable, and it was the defect, because what that command checks
  // is the `node` on `PATH` and this is whatever is running sigil.
  //
  // Resolved and checked **here** rather than inside the bracket, which is the
  // half that cost an existing binary: `assertBuildSea()` sat inside
  // `compileSea()`, so a refusal that had written nothing at all ran through
  // `written()`'s `catch` and **deleted** whatever was at `out` -- under
  // `--no-clean`, a previous release's binary. That is the asymmetry the Bun
  // path never had, since `locate('bun')` has always been above its own
  // `written()`, and it is what makes that function's own promise -- the bracket
  // starts after the assertions -- true of both runtimes rather than one.
  const node = options.exec ?? process.execPath;

  assertBuildSea(node);

  // the config is the interface `--build-sea` takes, and it is written to a
  // temporary directory rather than beside the output: it names an absolute
  // input and an absolute output, so nothing resolves against where it sits,
  // and a build artifact nobody asked for should not survive the build.
  //
  // Also above the bracket, and for the same reason one step further out: a
  // `mkdtempSync` or a config write that fails has not touched `out` either, so
  // leaving them inside would have left the promise a little bit false in a way
  // nobody would have found. The `finally` sits where the directory exists,
  // which is `bundleApp()`'s own rule about where a bracket begins.
  const dir = mkdtempSync(join(tmpdir(), 'sigil-sea-'));

  try {
    const config = seaConfig(dir, options);

    return written(out, () => compileSea(node, config, options));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Writes the config `--build-sea` reads, and answers with its path.
 *
 * @param dir - The temporary directory it goes in.
 * @param options - The bundle to embed and where the binary goes.
 * @returns The config's path.
 */
function seaConfig(dir: string, options: CompileOptions): string {
  const config = join(dir, 'sea-config.json');

  writeFileSync(
    config,
    `${JSON.stringify(
      {
        disableExperimentalSEAWarning: true,
        main: options.entry,
        output: options.out,
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

  return config;
}

/**
 * The writing half of a Node single-executable build, which `written()` brackets.
 *
 * Everything it needs is resolved before it is called, which is what keeps the
 * bracket over the write alone -- the same shape as `compileBun()`, which takes
 * its already-located `bun`.
 *
 * @param node - The node whose `--build-sea` runs, already checked.
 * @param config - The config it reads, already written.
 * @param options - Where the binary goes and how it is signed.
 * @returns What was produced.
 */
function compileSea(node: string, config: string, options: CompileOptions): CompileResult {
  const { out, sign: identity, target } = options;
  const run = spawnSync(node, [`--build-sea=${config}`], { encoding: 'utf-8' });

  if (run.error) {
    throw new Error(`Failed to run node at ${node}: ${escapeControls(run.error.message)}`);
  }

  if (run.status !== 0) {
    throw new Error(`node --build-sea failed:\n${said(run)}`);
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
  const used = identityOf(identity) ?? '-';

  try {
    sign(file, used);
  } catch (e) {
    try {
      rmSync(file, { force: true });
    } catch {
      // never over the error being unwound: a removal that fails would replace
      // `codesign failed: no identity found` -- the actionable half -- with a
      // sentence about the file system. `compileAll()`'s cleanup was guarded
      // from the start and this one was not, which made the AGENTS.md
      // sentence covering "neither removal" true of one of them
    }

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
      `Failed to run codesign: ${escapeControls(run.error.message)}\n  A macOS binary must be signed to run at all -- an unsigned one is killed before it starts -- so this is not something to skip.`
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
 * Probed by spawning `--version`, because the node being asked about is the one
 * named in `exec` rather than this process: `sigil package` resolves it off
 * `PATH` or out of a cache, so its capabilities are a thing to find out rather
 * than to report. The paragraph that used to sit here said the reverse, in the
 * words `canBuildSea()` now carries.
 *
 * @param node - The node that would run `--build-sea`.
 * @throws If that Node has no `--build-sea`.
 */
function assertBuildSea(node: string): void {
  const run = spawnSync(node, ['--version'], { encoding: 'utf-8' });
  const version = (run.stdout ?? '').trim().replace(/^v/, '');

  if (version && canBuildSea(version)) {
    return;
  }

  const [wantMajor, wantMinor] = NODE_BUILD_SEA;

  throw new Error(
    `Node ${wantMajor}.${wantMinor} or newer is needed to package with Node, and ${node} is ${version || 'not a node'}. Earlier versions build a single executable through postject, an external tool this toolchain will not install for you. Use --runtime bun, or upgrade Node.`
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
  return (
    [run.stderr, run.stdout]
      .filter((stream): stream is string => Boolean(stream?.trim()))
      .join('\n')
      .split('\n')
      // a spawned program's own words, which a terminal would act on
      .map((line) => `  ${escapeControls(line.replace(/\r$/, ''))}`)
      .join('\n')
  );
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
