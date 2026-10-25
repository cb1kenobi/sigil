/**
 * `sigil package`: the build, and then a binary that needs no runtime installed.
 *
 * `sigil build` produces an app that still needs Node or Bun on the machine
 * that runs it. This is the step after it, and it is the whole of what oclif's
 * installers buy: one file somebody downloads and runs.
 *
 * It is `build` plus a compile step rather than a command of its own pass --
 * the same `_inspect.ts` read, the same refusal to package an app that does not
 * check out, the same bundle -- because two commands that disagree about what a
 * valid app is would be the worse half of this feature.
 *
 * ## The runtime is the app's decision, so it has to be made
 *
 * There is no default. Picking one silently would decide what every user's app
 * runs on, which is a bigger decision than packaging and not one to infer from
 * what happens to be installed. `"package": { "runtime": ... }` in `sigil.json`
 * is how an app says it once; `--runtime` is how an invocation says it.
 *
 * With neither, somebody at a terminal is **asked**, and a caller with nobody
 * to ask gets an error naming both runtimes and what each costs. Those are the
 * same decision reached two ways rather than two policies: the question is
 * always the app's to answer, and a prompt is simply the form it takes when
 * there is a person there.
 *
 * What that trade is, measured, is in AGENTS.md. The short version: Bun is
 * faster to start, smaller, cross-compiles to every target from one host and
 * needs no signing step, and the app then runs on Bun. Node runs the app on
 * what its `engines` already names, and costs a flat CommonJS bundle, a
 * per-platform build, and a mandatory `codesign` on macOS.
 */

import {
  assertCompilable,
  assertToolchain,
  bundleApp,
  compileWithBun,
  compileWithNode,
  type CompileResult,
  displayPath,
  hostTarget,
  isIdentity,
  label,
  NODE_BUILD_SEA,
  outputName,
  parseTarget,
  type ResolvedTree,
  type Runtime,
  type Target,
  canBuildSea,
  choices,
  hash,
  installed,
  WORK_DIR,
  latest,
  local,
  parseSpec,
  resolve,
  type Spec,
} from '../build/index.ts';
import { CONFIG_FILE, readSigilConfig } from '../config.ts';
import { isQuiet, reportLevel, writeNote, writeSummary } from '../report.ts';
import {
  appRuns,
  assertCleanable,
  binName,
  clean,
  commandsFound,
  failure,
  inspect,
  reportDiagnostics,
  resolveOut,
} from './_inspect.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { PromptError, select, table, text } from '@ttylabs/sigil/components';
import { mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One binary that was produced, as the summary and the table read it. */
type Built = CompileResult & { readonly file: string; readonly target: Target };

/**
 * Where the binaries go when nobody says otherwise.
 *
 * **Not** `dist`, which is where a build goes, and the two sharing it was a
 * defect rather than a tidy default: `clean()` empties the directory, so
 * `sigil build` followed by `sigil package` destroyed the build output and
 * `sigil package` followed by `sigil build` destroyed an 89 MB binary --
 * measured, in both orders. `pnpm build && pnpm package` lost something
 * whichever way round it ran.
 *
 * `dist` is also what `files` in a manifest usually publishes, so a binary
 * sitting there is one `npm publish` away from being shipped.
 *
 * `release` rather than `out`, because it says what the contents are -- the
 * artifacts you attach to a release -- and cannot be read as a source or build
 * directory. It also avoids `--out out`.
 */
const DEFAULT_OUT = 'release';

/** See `check.ts` for why this is annotated, and why `AnyCommand`. */
const pkg: AnyCommand = command({
  args: [{ desc: "The app's root, defaulting to the working directory", name: '[dir]' }],
  desc: 'Build an app and compile it into a single executable',
  options: {
    '--commands [dir]': {
      desc: "The app's command directory, when its entry does not say",
    },
    '--entry [file]': {
      desc: "The module declaring the app's schema, when the conventions find the wrong one",
    },
    '--external [pkg]': {
      desc: 'A package to import rather than inline, for one carrying a native binding',
      multiple: true,
    },
    '--name [name]': {
      desc: 'What the binary is called. Defaults to the name in package.json',
    },
    '--no-clean': {
      desc: 'Keep what is already in the output directory',
    },
    '--no-shake': {
      desc: 'Keep every utility rule, rather than only the ones the source can name',
    },
    '--out [dir]': {
      default: DEFAULT_OUT,
      desc: 'Where the binaries go, relative to the app. Not where the build goes',
    },
    '--runtime [runtime]': {
      desc: 'Which runtime the binary embeds, as bun or node, optionally bun@1.3.14',
    },
    '--sign [identity]': {
      desc: 'A codesigning identity for macOS. Ad-hoc by default, which is what makes it run',
    },
    '--target [target]': {
      desc: 'A <platform>-<arch> to build for, repeatable. Defaults to this machine',
      multiple: true,
    },
  },

  async run({ argv }) {
    const found = inspect({
      commands: argv.commands as string | undefined,
      cwd: String(argv.dir ?? '.'),
      entry: argv.entry as string | undefined,
    });

    const counts = reportDiagnostics(found);
    if (counts.fatal) {
      throw failure(found, counts);
    }

    // a flag beats the file, which beats the default, for the reasons
    // `build.ts` writes out at length -- including the imprecision a declared
    // flag carries, which is why `--out` is compared against its default
    // rather than read for absence
    const sigilConfig = readSigilConfig(found.app.root);
    const config = sigilConfig.package ?? {};
    const build = sigilConfig.build ?? {};

    const targets = chooseTargets(argv.target as string[] | undefined, config.target);
    const spec = await chooseRuntime(
      argv.runtime as string | undefined,
      config.runtime,
      targets[0] as Target
    );
    const runtime = spec.runtime;

    // said when the answer came from the **file**, and only then. A flag is the
    // caller's own immediate act and needs no echo; an answered prompt is on
    // screen already. What was invisible is a `sigil.json` deciding this
    // silently -- asked twice as "why doesn't it prompt me?", which is the
    // question a line of output answers once and a doc page never does.
    if (argv.runtime === undefined && config.runtime !== undefined) {
      writeNote(
        [
          `Using ${config.runtime} from ${CONFIG_FILE}.`,
          'Pass --runtime to override, or remove "package.runtime" to be asked.',
        ],
        process.stderr
      );
    }
    const external = (argv.external as string[] | undefined) ?? build.external ?? [];
    const out = resolveOut(
      found.app.root,
      // `package.out` only, never `build.out`: falling back to the build's
      // destination is what put the binaries in `dist` beside the bundle they
      // were made from, which is the whole of what this default moved away from
      String(argv.out === DEFAULT_OUT ? (config.out ?? DEFAULT_OUT) : argv.out)
    );

    // before the bundle, because every one of these is knowable without
    // reading a byte of the app and none of them gets better for having a
    // type-check and a bundle run first. The same rule `--bin` beside a routed
    // directory follows: a failure the build can see coming is a build error
    const identity = argv.sign as string | undefined;

    assertSelfContained(external);
    assertSignable(identity, targets);
    // before `resolveExec()`, because it is pure path arithmetic and a run
    // doomed by its own `--out` should not fetch a 90 MB runtime first
    assertCleanable(out, found.app.root, argv.clean !== false);
    for (const target of targets) {
      assertCompilable(runtime, target);
    }
    assertToolchain(runtime, targets, identity);

    // the executable that will do the work, fetched if this machine has not got
    // it. After the pre-flight, because downloading 100 MB for a package that
    // was going to be refused is the one order that wastes the user's time, and
    // before `clean()`, so a failed download leaves the output directory alone
    const exec = await resolveExec(spec, targets[0] as Target);

    const name = binName(found, (argv.name as string | undefined) ?? build.name);

    // the bundle is an intermediate, so it does not land beside the binaries.
    // Under `node_modules/.sigil/`, which is where `writeEntry()` already puts
    // the generated entry -- a convention this repo has rather than a temp
    // directory dance invented here. Kept rather than removed afterwards,
    // because "what was actually embedded" is the first thing anybody debugging
    // a packaged binary wants.
    // Keyed by the **resolved output**, not by the app and the name, which is
    // the rule `entryLocation()` already follows one file along and for the
    // same reason: two packages of one app at once otherwise share one scratch
    // directory and overwrite each other's bundle. Found immediately -- two
    // test files packaging one fixture collided, and each passed alone while
    // one failed in the suite.
    //
    // Removed on the way out, which is also `entryLocation()`'s rule and was
    // the second thing this got wrong. It was kept at first, on the reading
    // that "what was actually embedded" is worth having -- and a hash per
    // output means one directory per distinct `--out` anybody ever uses, so
    // they accumulate forever: **51** of them had piled up in one test fixture
    // before anybody looked. If you want the bundle, `sigil build` writes one.
    const staging = join(found.app.root, WORK_DIR, `${hash(out)}-package`);

    clean(out, found.app.root, argv.clean !== false);

    // and the staging directory, always: it is this command's own scratch space
    // rather than anything the user asked to keep, so a stale chunk from a
    // previous run has no business surviving into the next binary. `--no-clean`
    // is about the *output*, which is now a different directory entirely.
    rmSync(staging, { force: true, recursive: true });

    // nothing else creates the output directory any more. It used to appear
    // because the bundle was written into it; now the bundle is elsewhere and
    // the first thing to touch it is a compiler writing an `--outfile`, which
    // does not make parents.
    mkdirSync(out, { recursive: true });

    // Node embeds one CommonJS script and cannot `import()` at all, so its
    // bundle is a different shape rather than the same one compiled
    // differently -- see `compile.ts`
    // everything from here is bracketed so the staging directory goes whatever
    // happens, which is `entryLocation()`'s rule for the generated entry
    try {
      const result = await bundleApp({
        app: found.app,
        binName: name,
        defaultLocale: sigilConfig.locale,
        external,
        form: runtime === 'node' ? 'cjs' : 'esm',
        out: staging,
        safelist: build.safelist,
        shake: argv.shake !== false && build.shake !== false,
        // a sourcemap is embedded in nothing and read by nobody once the bundle
        // is inside a binary, so it is weight on the way to being discarded
        sourcemap: false,
        tree: { commands: found.commands, diagnostics: [] } satisfies ResolvedTree,
      });

      const compiled = compileAll(runtime, {
        entry: result.bin,
        exec,
        identity,
        name,
        out,
        targets,
      });

      if (!isQuiet()) {
        printBinaries(compiled);
      }

      writeSummary(
        [
          ...appRuns(found.app),
          `${commandsFound(found)} into`,
          `${compiled.length} ${runtime} binar${compiled.length === 1 ? 'y' : 'ies'},`,
          `${displayPath(relative(found.app.root, out) || out)}${counts.warnings ? ',' : ''}`,
          ...(counts.warnings
            ? [
                {
                  class: 'cli-warning sigil-warn',
                  text: `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`,
                },
              ]
            : []),
        ],
        process.stderr
      );
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  },
});

export default pkg;

/**
 * Refuses an app that has declared it is not self-contained.
 *
 * `external` means "this package must be installed where the app runs" and a
 * single binary means "nothing has to be installed". They are contradictory
 * claims about one app, so an app with externals cannot be packaged and the
 * contradiction is the message.
 *
 * It is a refusal rather than a warning because of what each runtime does with
 * it, found by packaging this toolchain -- which declares three externals,
 * two of them native bindings nothing can inline. Bun fails to compile and
 * says `Could not resolve: "@ttylabs/sigil". Maybe you need to "bun install"?`,
 * which points at the wrong fix. **Node succeeds**: it wrote a 138 MB binary,
 * reported success, and died on the first thing anybody typed with
 * `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: @ttylabs/sigil` --
 * because a SEA's injected `require` resolves builtins and nothing else, so an
 * external is not merely absent, it is unreachable.
 *
 * That is the same failure class as `--external` itself, the JSX gate and the
 * unresolved-import gate: a build that reported success and an executable that
 * dies the first time it is used. Three gates exist for it already and this is
 * the fourth.
 *
 * What an app with a native binding should do is `sigil build` and ship the
 * bundle with its `node_modules`, which is what externals are for. There is no
 * flag to override this: the binary it would produce cannot work.
 *
 * @param external - The packages the build was told to leave as imports.
 * @throws If there are any.
 */
function assertSelfContained(external: readonly string[]): void {
  if (!external.length) {
    return;
  }

  const named = external.map((pkg) => `"${pkg}"`).join(', ');

  throw new Error(
    `Cannot package an app with external packages: ${named}.\n  An external is the app saying that package must be installed where it runs, and a single binary is the app saying nothing has to be installed -- so the binary could not work. On the node runtime it would be built and reported successfully and then fail on first use, because a single executable cannot resolve anything outside itself.\n  A package carrying a native binding cannot be inlined at all, so an app with one is a "sigil build" plus its node_modules rather than a binary.`
  );
}

/**
 * Which runtime to embed.
 *
 * There is deliberately no default, and the error is the feature: a runtime
 * decides what the app runs on, so inferring one from what happens to be
 * installed would answer a question about the app with a fact about the
 * builder's laptop. The message carries the trade rather than only the names,
 * because "pick one" without saying what differs is a question asked twice.
 *
 * @param flag - What `--runtime` said.
 * @param declared - What `sigil.json` said.
 * @returns The runtime.
 * @throws If neither named one.
 */
async function chooseRuntime(
  flag: string | undefined,
  declared: string | undefined,
  target: Target
): Promise<Spec> {
  const named = flag ?? declared;

  if (named) {
    return parseSpec(named);
  }

  return askRuntime(target);
}

/**
 * Asks which runtime and version to embed, where there is somebody to ask.
 *
 * One picker for both halves, because it is one choice. It offers **both**
 * runtimes whatever is installed, which is the whole point of being able to
 * fetch one -- an author with no Bun can still ship a Bun binary, and refusing
 * to offer it would be refusing on a fact about the laptop rather than about
 * the app.
 *
 * That was the bug this replaced. `sigil new` pinned `"runtime": "bun"` into
 * `sigil.json`, so the question arrived already answered, the picker never
 * fired, and a machine without Bun got `bun is not installed` for an app whose
 * author had never been asked. The scaffold stopped writing it; the question
 * stays open until somebody answers it.
 *
 * The TTY rule is still not spelled here, for the reason it never was:
 * `select()` refuses where there is nobody to answer, so this asks and
 * translates that one rejection into the message a non-interactive caller
 * needs. An aborted prompt travels untouched.
 *
 * @param target - What is being built, for naming Bun's cached runtimes.
 * @returns The runtime and version to embed.
 * @throws If there is nobody to ask.
 */
async function askRuntime(target: Target): Promise<Spec> {
  const [bunReleases, nodeReleases] = await Promise.all([latest('bun'), latest('node')]);
  const rows = choices(
    { bun: local('bun', target), node: local('node', target) },
    { bun: bunReleases, node: nodeReleases }
  );

  let picked: string;

  try {
    picked = (await select({
      choices: rows.map((row) => ({ label: row.label, value: row.value })),
      message: 'Which runtime should the binary embed?',
    })) as string;
  } catch (e) {
    if (e instanceof PromptError && !e.aborted) {
      throw required();
    }

    throw e;
  }

  if (!picked.startsWith('custom:')) {
    return parseSpec(picked);
  }

  // the escape hatch: a picker offering the newest of each line cannot express
  // "the exact version our other service pins", which is the ordinary reason to
  // care about a version at all
  const runtime = picked.slice('custom:'.length);
  const typed = await text({
    message: `Which ${runtime} version?`,
    placeholder: runtime === 'bun' ? '1.3.14' : '26.12.1',
  });

  return parseSpec(`${runtime}@${String(typed).trim()}`);
}

/**
 * The executable that will compile, fetched into sigil's cache if need be.
 *
 * A bare `bun` or `node` resolves to whatever is installed, which is the
 * ordinary case and costs nothing. A pinned version resolves to that version,
 * from `PATH` or either cache, and is downloaded only if it is nowhere.
 *
 * `undefined` means "whatever the host has", which is what the compile
 * functions already default to -- so an unpinned run behaves exactly as it did
 * before any of this existed.
 *
 * @param spec - The runtime and any version.
 * @param target - What is being built, for naming Bun's cached runtimes.
 * @returns The executable, or `undefined` to use the host's.
 */
async function resolveExec(spec: Spec, target: Target): Promise<string | undefined> {
  if (spec.version !== undefined) {
    return fetchIfAbsent(spec.runtime, spec.version, target);
  }

  // no version named, so the host's is the one to use -- if it can do the job.
  // For Bun that is simply "is there one"; for Node it is also whether it is
  // new enough to build a single executable, which is the symmetric case and
  // equally worth fetching past: somebody on Node 24 who says `--runtime node`
  // should get a working binary, not a lecture about 25.5.
  const here = installed(spec.runtime);

  if (here && (spec.runtime === 'bun' || canBuildSea(here.version))) {
    return undefined;
  }

  // nothing usable here, so pick the newest the registry offers. This is the
  // reported bug's real fix: a missing runtime is a thing to resolve, not to
  // refuse -- `bun is not installed` was an error about the machine for an
  // instruction that was about the app.
  const offered = (await latest(spec.runtime)).filter(
    (one) => spec.runtime === 'bun' || canBuildSea(one.version)
  );
  const newest = offered[0]?.version;

  if (!newest) {
    throw new Error(
      `${spec.runtime} is not installed${here ? ` in a version that can package itself -- this is ${here.version}` : ''}, and the list of available versions could not be fetched.\n  Pin one with --runtime ${spec.runtime}@<version> and sigil will download it, or install ${spec.runtime} and run this again.`
    );
  }

  return fetchIfAbsent(spec.runtime, newest, target);
}

/**
 * The executable for a version, downloaded into sigil's cache if need be.
 *
 * @param runtime - Which runtime.
 * @param version - The version to use.
 * @param target - What is being built.
 * @returns The executable.
 */
async function fetchIfAbsent(runtime: Runtime, version: string, target: Target): Promise<string> {
  return resolve(runtime, version, target, (which) => {
    // said rather than left silent: fetching a runtime is tens of megabytes and
    // several seconds, and a build that appears to hang is worse than a slow one
    writeNote([`Fetching ${runtime} ${which}, which is not on this machine...`], process.stderr);
  });
}

/**
 * The message for a caller that cannot be asked.
 *
 * @returns The error.
 */
function required(): Error {
  // the version floor is read from the constant rather than spelled, because
  // this is the message somebody reads while *deciding* and the one they would
  // check it against is `assertBuildSea()`'s. And "almost every target" rather
  // than "every target": `windows-arm64` is exactly the one Bun has no runtime
  // for, so the sentence used to contradict the error a user gets the moment
  // they act on it
  const [major, minor] = NODE_BUILD_SEA;

  return new Error(
    `--runtime is required where there is nobody to ask: a packaged binary embeds a runtime, and which one decides what the app runs on.\n  --runtime bun starts faster, is a smaller binary, cross-compiles to almost every target from one machine, and runs the app on Bun.\n  --runtime node runs the app on what its "engines" already names, builds only for the machine it runs on, and needs Node ${major}.${minor} or newer.\n  A version can be pinned -- bun@1.3.14, node@${major}.${minor}.0 -- and is fetched if this machine has not got it.\n  Declare it once as "package": { "runtime": ... } in sigil.json, or run this at a terminal and it will ask.`
  );
}

/**
 * What to build for, defaulting to this machine.
 *
 * Deduplicated by label rather than by object, since two spellings of one
 * target would otherwise compile twice to one path -- the second overwriting
 * the first, reported as two binaries.
 *
 * @param flag - What `--target` said.
 * @param declared - What `sigil.json` said.
 * @returns The targets, in the order they were named.
 * @throws If one of them is not a target.
 */
function chooseTargets(
  flag: readonly string[] | undefined,
  declared: readonly string[] | undefined
): Target[] {
  const named = flag ?? declared;

  if (!named?.length) {
    return [hostTarget()];
  }

  const seen = new Set<string>();
  return named
    .map((text) => parseTarget(text))
    .filter((target) => {
      const key = label(target);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

/**
 * Compiles for one target with the chosen runtime.
 *
 * @param runtime - Which runtime to embed.
 * @param options - What to compile and where it goes.
 * @returns What was produced.
 */
function assertSignable(identity: string | undefined, targets: readonly Target[]): void {
  if (identity === undefined) {
    return;
  }

  // `--sign=` is how a value gets deliberately emptied, and an empty identity
  // is not one -- it reached `codesign` as `: no identity found` after the
  // bundle and the compile had both run, which is the rule above with a hole
  // the size of one string
  if (!isIdentity(identity)) {
    throw new Error(
      `--sign was given an empty identity. Name a codesigning identity, or drop the flag -- "" is not one, and the only thing it can produce is a codesign failure after the binary has been built.`
    );
  }

  if (targets.some((target) => target.platform === 'darwin')) {
    return;
  }

  throw new Error(
    `--sign names a codesigning identity, which only applies to a macOS binary, and none of the targets is one: ${targets.map((target) => label(target)).join(', ')}.\n  Drop --sign, or add a darwin target.`
  );
}

/**
 * Compiles every target, and leaves nothing behind if one of them fails.
 *
 * The loop used to be a bare `targets.map()`, so a failure on target three of
 * five threw with the first two fully written and nothing saying the set was
 * incomplete -- and the scaffolded release workflow attaches files *by name*,
 * so a truncated release is indistinguishable from a finished one except by
 * the exit code of a step that has already scrolled past.
 *
 * This is `undo()`'s rule in `bundle.ts` applied one layer out: a refused build
 * must leave nothing. The removal cannot itself fail the run, for the reason
 * `undo()` records -- swapping the real diagnostic for one about a file system
 * is how the actual cause gets lost -- and the message names which target
 * failed, since "it failed" over five targets is four questions.
 *
 * @param runtime - Which runtime to embed.
 * @param options - The bundle, the targets, and where they go.
 * @returns What was produced, in the order the targets were named.
 */
function compileAll(
  runtime: Runtime,
  options: {
    readonly entry: string;
    readonly exec: string | undefined;
    readonly identity: string | undefined;
    readonly name: string;
    readonly out: string;
    readonly targets: readonly Target[];
  }
): Built[] {
  const { entry, exec, identity, name, out, targets } = options;
  const compiled: Built[] = [];

  for (const target of targets) {
    const file = outputName(name, target, targets);

    try {
      const one = runtime === 'bun' ? compileWithBun : compileWithNode;

      compiled.push({
        ...one({ entry, exec, out: join(out, file), sign: identity, target }),
        file,
        target,
      });
    } catch (e) {
      // the failing target's own file first, then the ones before it. Only the
      // *sign* failure cleans up after itself inside `signed()`; a compiler
      // that dies mid-write -- a full disk over five 85-110 MB binaries, a
      // killed `bun` -- leaves a truncated file under exactly the name the
      // scaffolded release workflow attaches by, which is the
      // indistinguishability this cleanup exists to prevent. It was true of the
      // earlier targets and not of the failing one.
      // the targets built before this one, and only those. The failing
      // target's own file is removed by whoever was writing it -- `written()`
      // in `compile.ts` brackets exactly the part that writes -- which is both
      // more precise and the only version that works for a direct caller of
      // the exported compile functions.
      //
      // The precision matters under `--no-clean`, whose documented promise is
      // to keep what is already there: an earlier attempt at this removed the
      // failing target's path from here, unconditionally, so a refusal that
      // happened *before any write* destroyed the previous release's binary
      // sitting at it. Bracketing the write instead means a pre-write refusal
      // has nothing to clean up, by construction rather than by a stat.
      for (const written of compiled.map((one) => one.file)) {
        try {
          rmSync(join(out, written), { force: true });
        } catch {
          // never over the error being unwound: see `undo()` in `bundle.ts`
        }
      }

      throw new Error(
        `Could not package ${label(target)}${compiled.length ? `, and the ${compiled.length} binar${compiled.length === 1 ? 'y' : 'ies'} built before it have been removed` : ''}.\n${(e as Error).message}`
      );
    }
  }

  return compiled;
}

/**
 * What the Signed column says.
 *
 * Every darwin binary is signed by this command now, so the cell is the
 * identity that was used and an empty cell means a target where signing is not
 * a thing. It said `bun` for a while, on the reading that Bun signs its own
 * output and this should not claim the credit -- which was retired by measuring
 * a Bun-signed binary that would not run. See `signsOn()`.
 *
 * @param identity - What `sign()` used, if it ran.
 * @returns The cell.
 */
function describeSigning(identity: string | undefined): string {
  if (identity === undefined) {
    return '';
  }

  return identity === '-' ? 'ad-hoc' : identity;
}

/**
 * Writes what was produced, and what each binary costs.
 *
 * The size is the number nobody guesses right: an embedded runtime is tens of
 * megabytes whichever one it is, and the difference between the two is large
 * enough to be worth seeing rather than reading about.
 *
 * @param compiled - What was built, in the order it was named.
 */
function printBinaries(compiled: readonly Built[]): void {
  const rows = compiled.map((one) => [
    one.file,
    label(one.target),
    `${(one.size / 1048576).toFixed(1)} MB`,
    describeSigning(one.signed),
  ]);

  if (rows.length) {
    process.stdout.write(
      `${table(rows, {
        // stdout's level rather than the process styler's, for the reason
        // `printTree()` records: the default reads stdout whoever is asking
        colorLevel: reportLevel(process.stdout),
        columns: ['Binary', 'Target', { align: 'right', header: 'Size' }, 'Signed'],
      })}\n`
    );
  }
}
