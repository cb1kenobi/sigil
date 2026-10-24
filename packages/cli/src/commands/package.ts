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
 * is how an app says it once; `--runtime` is how an invocation says it. With
 * neither, the error names both and what each costs.
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
  label,
  NODE_BUILD_SEA,
  outputName,
  parseTarget,
  type ResolvedTree,
  RUNTIMES,
  type Runtime,
  type Target,
} from '../build/index.ts';
import { readSigilConfig } from '../config.ts';
import { isQuiet, reportLevel, writeSummary } from '../report.ts';
import {
  appRuns,
  binName,
  clean,
  commandsFound,
  failure,
  inspect,
  reportDiagnostics,
  resolveOut,
} from './_inspect.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { table } from '@ttylabs/sigil/components';
import { rmSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One binary that was produced, as the summary and the table read it. */
type Built = CompileResult & { readonly file: string; readonly target: Target };

/** Where a package goes when nobody says otherwise, which is where a build goes. */
const DEFAULT_OUT = 'dist';

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
      desc: 'Where the binary goes, relative to the app',
    },
    '--runtime [runtime]': {
      choices: [...RUNTIMES],
      desc: 'Which runtime the binary embeds. Required, here or in sigil.json',
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

    const runtime = chooseRuntime(argv.runtime as string | undefined, config.runtime);
    const targets = chooseTargets(argv.target as string[] | undefined, config.target);
    const external = (argv.external as string[] | undefined) ?? build.external ?? [];
    const out = resolveOut(
      found.app.root,
      String(argv.out === DEFAULT_OUT ? (config.out ?? build.out ?? DEFAULT_OUT) : argv.out)
    );

    // before the bundle, because every one of these is knowable without
    // reading a byte of the app and none of them gets better for having a
    // type-check and a bundle run first. The same rule `--bin` beside a routed
    // directory follows: a failure the build can see coming is a build error
    const identity = argv.sign as string | undefined;

    assertSelfContained(external);
    assertSignable(identity, targets);
    for (const target of targets) {
      assertCompilable(runtime, target);
    }
    assertToolchain(runtime, targets, identity);

    clean(out, found.app.root, argv.clean !== false);

    const name = binName(found, (argv.name as string | undefined) ?? build.name);

    // Node embeds one CommonJS script and cannot `import()` at all, so its
    // bundle is a different shape rather than the same one compiled
    // differently -- see `compile.ts`
    const result = await bundleApp({
      app: found.app,
      binName: name,
      defaultLocale: sigilConfig.locale,
      external,
      form: runtime === 'node' ? 'cjs' : 'esm',
      out,
      safelist: build.safelist,
      shake: argv.shake !== false && build.shake !== false,
      // a sourcemap is embedded in nothing and read by nobody once the bundle
      // is inside a binary, so it is weight on the way to being discarded
      sourcemap: false,
      tree: { commands: found.commands, diagnostics: [] } satisfies ResolvedTree,
    });

    const compiled = compileAll(runtime, {
      entry: result.bin,
      identity,
      name,
      out,
      targets,
    });

    if (!isQuiet()) {
      printBinaries(compiled, runtime);
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
function chooseRuntime(flag: string | undefined, declared: string | undefined): Runtime {
  const named = flag ?? declared;

  if (!named) {
    // the version is read from the constant rather than spelled, because this
    // is the message somebody reads while *deciding* and the one they would
    // check it against is `assertBuildSea()`'s. And "almost every target"
    // rather than "every target": `windows-arm64` is exactly the one Bun has
    // no runtime for, so the sentence used to contradict the error a user gets
    // the moment they act on it
    const [major, minor] = NODE_BUILD_SEA;

    throw new Error(
      `--runtime is required: a packaged binary embeds a runtime, and which one decides what the app runs on.\n  --runtime bun starts faster, is a smaller binary, cross-compiles to almost every target from one machine, and runs the app on Bun.\n  --runtime node runs the app on what its "engines" already names, builds only for the machine it runs on, and needs Node ${major}.${minor} or newer.\n  Declare it once as "package": { "runtime": ... } in sigil.json.`
    );
  }

  // the parser's `choices` already refuses anything else off the flag, so what
  // is left to check is the config file, which is the app's own source
  if (!(RUNTIMES as readonly string[]).includes(named)) {
    throw new Error(
      `"${named}" is not a runtime. Set "package": { "runtime": ... } in sigil.json to one of ${RUNTIMES.join(' or ')}.`
    );
  }

  return named as Runtime;
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
  if (identity === undefined || targets.some((target) => target.platform === 'darwin')) {
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
    readonly identity: string | undefined;
    readonly name: string;
    readonly out: string;
    readonly targets: readonly Target[];
  }
): Built[] {
  const { entry, identity, name, out, targets } = options;
  const compiled: Built[] = [];

  for (const target of targets) {
    const file = outputName(name, target, targets);

    try {
      const one = runtime === 'bun' ? compileWithBun : compileWithNode;

      compiled.push({
        ...one({ entry, out: join(out, file), sign: identity, target }),
        file,
        target,
      });
    } catch (e) {
      for (const written of compiled) {
        try {
          rmSync(join(out, written.file), { force: true });
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
 * `linker` is Bun's own: its output arrives `adhoc, linker-signed` whether or
 * not this command touched it, so an empty cell there would read as unsigned
 * when the binary is in fact runnable. An empty cell is reserved for a target
 * where signing is not a thing at all, which is every non-darwin one.
 *
 * @param identity - What `sign()` used, if it ran.
 * @param target - What the binary was built for.
 * @param runtime - Which runtime is embedded.
 * @returns The cell.
 */
function describeSigning(identity: string | undefined, target: Target, runtime: Runtime): string {
  if (identity !== undefined) {
    return identity === '-' ? 'ad-hoc' : identity;
  }

  return target.platform === 'darwin' && runtime === 'bun' ? 'ad-hoc (linker)' : '';
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
function printBinaries(compiled: readonly Built[], runtime: Runtime): void {
  const rows = compiled.map((one) => [
    one.file,
    label(one.target),
    `${(one.size / 1048576).toFixed(1)} MB`,
    describeSigning(one.signed, one.target, runtime),
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
