/**
 * Reading an app, for the commands that all have to.
 *
 * `check` is this and a report. `build` is this, the same report, and then a
 * bundle. `package` is `build` and then a compiler -- which is why it is one
 * module rather than implementations that agree for now: a failure in `check`
 * has to be a failure in both the others, or they come to disagree about what a
 * valid app is and the fast one stops meaning anything.
 *
 * What is here beyond the read is what those commands have to answer
 * *identically* rather than merely similarly: where the output goes, what the
 * executable is called, and which directory must not be emptied. The last of
 * those is the one with teeth, and it is why they are shared rather than
 * written twice -- `package` had its own copy for an afternoon and the copy was
 * wrong in a way that only showed up on an `--out` outside the app.
 *
 * The `_` prefix is this repo's own rule, read from the inside: an entry in a
 * commands directory that starts with one is not a route. Nothing walks
 * `src/commands/` today -- the toolchain's schema is written out -- but it will
 * once the CLI routes itself, and a helper that quietly became a command called
 * `_inspect` is exactly the footgun the prefix was invented for.
 */

import {
  appKeys,
  checkCatalogs,
  checkMainSettings,
  discoverApp,
  displayPath,
  isFatal,
  isInside,
  landsAt,
  readAppCatalogs,
  readAppCommands,
  resolveCommandTree,
  typeCheck,
  walkTree,
  type AppCatalogs,
  type Diagnostic,
  type DiscoveredApp,
  type ResolvedCommand,
  type TypeCheckResult,
} from '../build/index.ts';
import { CONFIG_FILES } from '../config.ts';
import { reportLevel, writeDiagnostics, writeSummary } from '../report.ts';
import { table } from '@ttylabs/sigil/components/table';
import type { TextRun } from '@ttylabs/sigil/element';
import { SIGIL_KEYS } from '@ttylabs/sigil/i18n-keys';
import { existsSync, lstatSync, rmSync, statSync, type BigIntStats } from 'node:fs';
import nodePath, { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** What reading an app turned up. */
export interface Inspection {
  /** The app, and the entry the conventions chose. */
  readonly app: DiscoveredApp;
  /**
   * Every file a catalog loader on its entry names by a literal `import()`,
   * whether or not it read as a catalog. Kept for the reason
   * `commandDir` is: the bundle reads them again, so emptying the directory
   * they are in is emptying the app's source.
   */
  readonly catalogFiles: readonly string[];
  /**
   * The directory its commands were walked from, when they were walked rather
   * than written out. Kept because emptying it is emptying the app's source --
   * see `assertCleanable()`.
   */
  readonly commandDir?: string;
  /** Its commands, however its schema declares them. */
  readonly commands: readonly ResolvedCommand[];
  /** Everything worth saying, in the order it was found. */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Whether the schema is itself the command, which is a single-command app.
   *
   * There is then nothing to walk and nothing to bake, so `commands` is empty
   * and that is the right answer rather than a problem. It is carried here so
   * that a summary can say `the root command` instead of `0 commands`, which
   * would be indistinguishable from a tree this failed to read -- the one
   * thing the count exists to make visible.
   */
  readonly root: boolean;
  /** What the type check did, or why it did not. */
  readonly types: TypeCheckResult;
}

/** Where to look and what to trust. */
export interface InspectOptions {
  /** A command directory, when the entry does not say or says wrong. */
  readonly commands?: string;
  /** The app's root. */
  readonly cwd: string;
  /** The schema module, when the conventions find the wrong one. */
  readonly entry?: string;
}

/**
 * Reads an app: what it is, whether it type-checks, and what commands it has.
 *
 * @param options - Where to look.
 * @returns What it found.
 * @throws If there is no app here at all. Everything else is a diagnostic.
 */
export function inspect(options: InspectOptions): Inspection {
  const diagnostics: Diagnostic[] = [];

  // the app before anything else: a directory that does not depend on the
  // runtime is not one this can read, and saying so is more use than reporting
  // that it has no `commands/` directory
  const app = discoverApp(resolve(options.cwd), { entry: options.entry });

  // the type check answers for the whole app rather than for the routes, so it
  // runs whatever the tree turns out to be
  const types = typeCheck({ cwd: app.root });
  diagnostics.push(...types.diagnostics);

  const found = findCommands(app, options.commands, diagnostics);

  const catalogs = readAppCatalogs(app);
  diagnostics.push(...checkTranslations(app, catalogs, diagnostics));

  // a `settings` passed to the app's own `main()` is lost in the built app, which
  // calls `main({ schema })` itself -- so say so, where the app has not moved it
  diagnostics.push(...checkMainSettings(app));

  return {
    app,
    catalogFiles: catalogs.files,
    commandDir: found.dir,
    commands: found.commands,
    diagnostics,
    root: found.root,
    types,
  };
}

/**
 * What the app's catalogs do and do not cover.
 *
 * Nothing at all for an app that declares no `locales`, which is most of them
 * -- the entry is parsed either way by the command reader, so what this costs
 * such an app is one walk for a property that is not there.
 *
 * The check is here rather than at run time for the reason the runtime falls
 * back silently: a missing key renders a correct English sentence, so a German
 * build with seven English messages in it is still better than an English one,
 * and loud-at-runtime would make a partial catalog -- the normal state of a
 * translation -- worse than no catalog. What is actually wrong is a key that
 * falls back *forever* with nobody told, and that is a thing only a build can
 * see.
 *
 * @param app - The app.
 * @param read - Its catalogs, as `readAppCatalogs()` found them.
 * @param found - The diagnostics so far, so a catalog that could not be read is
 * not then reported as empty.
 * @returns One diagnostic per missing key and per orphan key.
 */
function checkTranslations(
  app: DiscoveredApp,
  read: AppCatalogs,
  found: Diagnostic[]
): readonly Diagnostic[] {
  if (!read.declared) {
    return [];
  }

  found.push(...read.diagnostics);

  if (!read.catalogs.length) {
    return [];
  }

  return checkCatalogs({
    catalogs: read.catalogs,
    file: app.entry,
    framework: SIGIL_KEYS,
    keys: appKeys(app.root),
  });
}

/**
 * Where the app's commands are, and what is in them.
 *
 * Two ways in, and the order respects what the caller said: a `--commands`
 * directory is an instruction, and the entry's own `commands` is the app
 * speaking for itself.
 *
 * @param app - The app.
 * @param named - A directory the caller named, if any.
 * @param diagnostics - Where to report.
 * @returns The commands, and whether the schema is itself the command.
 */
function findCommands(
  app: DiscoveredApp,
  named: string | undefined,
  diagnostics: Diagnostic[]
): { commands: readonly ResolvedCommand[]; dir?: string; root: boolean } {
  if (named !== undefined) {
    const dir = resolve(app.root, named);
    return { commands: walkCommandDir(dir, diagnostics), dir, root: false };
  }

  const declared = readAppCommands(app);
  diagnostics.push(...declared.diagnostics);

  if (!declared.commands) {
    // only when the entry declared none at all: one it declared and this could
    // not read has already been reported, and saying it again here would get
    // the second telling wrong.
    //
    // And not when the schema carries a `run`, which is a single-command app:
    // `main()` dispatches the root, so there is nothing missing. Both halves
    // are needed -- without the `run` test an app that simply forgot its
    // `commands` builds in silence, and without this one the layout
    // `sigil new --layout single` scaffolds cannot be built at all.
    if (!declared.found && !declared.root) {
      diagnostics.push({
        file: app.entry,
        message:
          'no "commands" found in this module; pass --entry to name the one declaring the schema, or --commands to name a command directory',
        severity: 'error',
      });
    }
    return { commands: [], root: declared.root };
  }

  // a path is the filesystem router, which is a tree to walk; an object is the
  // app having written its commands out, which is already the tree
  if (declared.commands.kind === 'directory') {
    const { dir } = declared.commands;
    return { commands: walkCommandDir(dir, diagnostics), dir, root: false };
  }

  return { commands: declared.commands.commands, root: false };
}

/**
 * Walks a command directory, turning what cannot be walked into a diagnostic.
 *
 * A tree that cannot exist at all -- two routes claiming one name, a directory
 * that is really a package -- throws out of `resolveCommandTree()`, which is
 * right for a library and wrong for a command, where it would take the process
 * down with a trace.
 *
 * @param dir - The directory.
 * @param diagnostics - Where to report.
 * @returns Its commands, or none when it could not be read.
 */
function walkCommandDir(dir: string, diagnostics: Diagnostic[]): readonly ResolvedCommand[] {
  if (!existsSync(dir)) {
    diagnostics.push({
      file: dir,
      message: 'no command directory here; pass --commands to name one, or check the app root',
      severity: 'error',
    });
    return [];
  }

  try {
    const tree = resolveCommandTree(dir);
    diagnostics.push(...tree.diagnostics);
    return tree.commands;
  } catch (e: unknown) {
    diagnostics.push({ file: dir, message: (e as Error).message, severity: 'error' });
    return [];
  }
}

/**
 * Writes the resolved tree, so that "why is my command not showing up" has an
 * answer that is not a guess.
 *
 * Through the framework's own `table()`, which is the toolchain being its own
 * acceptance test -- and which gets the column arithmetic right for free.
 *
 * On stdout rather than stderr, because it is data somebody asked for; the
 * diagnostics go the other way, so a tree can be piped without losing the
 * problems.
 *
 * @param commands - The tree.
 * @param root - What to write paths relative to.
 */
export function printTree(commands: readonly ResolvedCommand[], root: string): void {
  const rows = [...walkTree(commands)].map(({ command: cmd, path }) => [
    `${'  '.repeat(path.length - 1)}${cmd.name}${cmd.hidden ? ' (hidden)' : ''}`,
    // a namespace has no module and nothing to run, which is a thing to say
    // rather than a blank: it is the answer to half the questions this is for
    cmd.module ? displayPath(relative(root, cmd.module)) : `(${cmd.kind}, nothing to run)`,
    cmd.desc ?? '',
  ]);

  if (rows.length) {
    // told stdout's colour level rather than defaulting to the process styler's.
    // They happen to be the same stream here, which is exactly why it is worth
    // saying: `supportsColor()` defaults to `process.stdout` whoever is asking,
    // so a default that is right here is right by luck and wrong the moment
    // something like this goes to stderr
    process.stdout.write(
      `${table(rows, {
        colorLevel: reportLevel(process.stdout),
        columns: ['Command', 'Module', 'Description'],
      })}\n`
    );
  }
}

/**
 * Writes every diagnostic, and says whether any of them was fatal.
 *
 * Rendered rather than assembled: the severity is coloured and a long message
 * wraps in the column it started in, which is `report.ts`'s. To stderr, which
 * is also the stream it is laid out and coloured for -- the tree and the sizes
 * go to stdout, and the two are not the same destination.
 *
 * @param found - What reading the app turned up.
 * @returns How many of each, and whether to stop.
 */
export function reportDiagnostics(found: Inspection): {
  errors: number;
  fatal: boolean;
  warnings: number;
} {
  const { app, diagnostics, types } = found;
  const stream = process.stderr;

  // relative to the app, because an absolute path per line is mostly the same
  // prefix repeated and the interesting part is at the end of it. Which form it
  // takes is `report.ts`'s: a terminal is laid out for, a pipe gets the one-line
  // form every compiler writes
  writeDiagnostics(diagnostics, {
    relativeTo: (file) => relative(app.root, file) || '.',
    stream,
  });

  if (!types.checked && types.skipped) {
    // a note rather than a diagnostic: nothing is wrong with an app that has no
    // tsconfig, and it goes through the same writer the verdict does because it
    // is the same shape of line
    writeSummary(
      [{ class: 'cli-note sigil-muted', text: `Not type-checked: ${types.skipped}` }],
      stream
    );
  }

  const errors = diagnostics.filter((d) => d.severity === 'error').length;

  return { errors, fatal: isFatal(diagnostics), warnings: diagnostics.length - errors };
}

/**
 * What to say when an app did not check out.
 *
 * Thrown rather than written, so the exit code and the rendering are `main()`'s
 * the way they are for every other command.
 *
 * @param found - What reading the app turned up.
 * @param counts - What `reportDiagnostics()` counted.
 * @returns The error to throw.
 */
export function failure(found: Inspection, counts: { errors: number; warnings: number }): Error {
  const { errors, warnings } = counts;
  const where = found.app.manifest.name ?? found.app.root;

  return new Error(
    `${errors} error${errors === 1 ? '' : 's'}${
      warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''
    } in ${where}`
  );
}

/**
 * The app and the entry it was read from, as runs a summary leads with.
 *
 * Runs rather than the string this used to be, so that the name is bold and the
 * entry is dim without either carrying a sequence of its own. The entry is in it
 * because choosing one is a heuristic -- source conventions before the manifest
 * -- and a guess nobody can see is the kind that costs an afternoon.
 *
 * `failure()` still builds a plain string, and that is not an inconsistency to
 * iron out: what it returns is an `Error`, whose message is text
 * `errorHandler()` renders, and an element tree has nowhere to go inside one.
 *
 * @param app - The app.
 * @returns Its name and its entry, styled.
 */
export function appRuns(app: DiscoveredApp): TextRun[] {
  return [
    { class: 'cli-app sigil-heading', text: app.manifest.name ?? app.root },
    {
      class: 'cli-entry sigil-muted',
      text: `(${displayPath(relative(app.root, app.entry) || app.entry)}):`,
    },
  ];
}

/**
 * How many commands a tree holds, counting subcommands.
 *
 * @param commands - The tree.
 * @returns The count.
 */
export function countCommands(commands: readonly ResolvedCommand[]): number {
  return [...walkTree(commands)].length;
}

/**
 * What a summary calls what the app has, which is a count or the root.
 *
 * `0 commands` about a single-command app would be the one reading the count
 * exists to prevent: a build that compiled none when the author wrote twelve
 * and a build of an app that has none are the same sentence, and only the
 * first is a problem. So a schema that is itself the command says so.
 *
 * Shared rather than written out in each command, which is `diagnosticLocation()`'s
 * rule one file along: `check` and `build` read the same app through the same
 * pass, so they must not come to disagree about what to call what they found.
 *
 * @param found - What reading the app turned up.
 * @returns The phrase, with no punctuation of its own.
 */
export function commandsFound(found: Inspection): string {
  if (found.root) {
    return 'the root command';
  }

  const total = countCommands(found.commands);
  return `${total} command${total === 1 ? '' : 's'}`;
}

/**
 * Where a build or a package writes.
 *
 * @param root - The app's root.
 * @param out - What the caller said.
 * @returns The absolute directory.
 */
export function resolveOut(root: string, out: string): string {
  return isAbsolute(out) ? out : resolve(root, out);
}

/**
 * What the built executable is called.
 *
 * The `bin` key an app already declares, since that is the name its users type.
 * A package name is the fallback, scope dropped -- `@ttylabs/cli` builds to
 * `cli.mjs` rather than to a directory called `@ttylabs`.
 *
 * @param found - What reading the app turned up.
 * @param named - What the caller said, if anything.
 * @returns The name, without an extension.
 */
export function binName(found: Inspection, named: string | undefined): string {
  if (named) {
    return named;
  }

  // what the manifest's `bin` says, before what it calls itself: a scoped
  // package's name is not its executable's -- `@ttylabs/cli` publishes `sigil`,
  // and naming the file after the package writes one the manifest does not
  // point at
  const { bin, name } = found.app.manifest;
  if (bin) {
    return bin;
  }

  return name ? (name.split('/').pop() ?? name) : 'cli';
}

/** What `clean()` and `assertCleanable()` need to know about a build. */
export interface OutputGuard {
  /** Whether cleaning was asked for at all, which `--no-clean` turns off. */
  readonly clean: boolean;
  /** What the build reads, from `buildReads()`. */
  readonly reads: readonly string[];
  /** The app's root. */
  readonly root: string;
  /**
   * What the command writes into the output directory, relative to it -- from
   * `bundleWrites()` for a build, and the binaries' names for a package. Asked
   * only of an output directory that holds the app under `--no-clean`, which
   * is the one place a write can land on a file the build reads without the
   * directory itself being refused.
   */
  readonly writes?: readonly string[];
}

/**
 * Empties the output directory, refusing the ones that would hurt.
 *
 * A build that leaves the last one behind publishes the union of every build
 * ever run there -- a renamed command's chunk stays, a removed one's stays. And
 * an `--out` that is the app root, or sits above it, or holds anything the
 * build is about to read, turns a mistyped path into data loss -- see
 * `assertCleanable()`.
 *
 * What it deliberately does **not** refuse is an `--out` outside the app
 * altogether: a sibling directory is an ordinary place to build into, and
 * `package` shipped a copy of this that refused one -- `relative()` starting
 * with `..` reads as "outside" and was treated as "above", which are different
 * things and only the second is dangerous.
 *
 * The directory is resolved once, and that one path is what is checked, tested
 * for and removed. `rmSync(resolve(out))` removes the lexically normalized
 * path, and a raw `out` of `link/../alias/src` reaches a different directory
 * through the kernel than through `resolve()` -- so asking about the raw string
 * checked one directory and removed another.
 *
 * **It runs once the module graph exists, and refuses a directory holding any
 * module in it.** `assertCleanable()` can only name what `inspect()` read, and
 * the rest of what the build reads -- a helper the entry imports, a vendored
 * module, a catalog behind a loader it cannot read -- is known only to the
 * bundle. So the removal waits for it: `sigil build` calls this from
 * `bundleApp()`'s `beforeWrite`, after rolldown has read every module and
 * before it has written anything, and `sigil package` calls it after the
 * bundle and before the binaries are compiled. `--out vendor`, with
 * `vendor/lib.mjs` imported by the entry, used to be emptied and then fail with
 * `Module not found`; it is refused with the module named. Emptying first had
 * been for the stale chunk a previous build left, which could be read back --
 * and a stale chunk the bundle reads is a module inside `out`, which is now
 * refused rather than removed.
 *
 * An `out` that is itself a symlink is unlinked rather than emptied, which is
 * what `rmSync()` does with one, so nothing behind it is lost and nothing is
 * asked about it.
 *
 * @param out - The output directory.
 * @param guard - The app, what the build reads, and whether to clean.
 * @param modules - The physical path of every module in the graph.
 * @throws If the directory holds the app itself, anything the build reads, or
 * any module in the graph.
 */
export function clean(out: string, guard: OutputGuard, modules: readonly string[]): void {
  const target = resolve(out);

  assertCleanable(target, guard);

  if (!guard.clean || !existsSync(target)) {
    return;
  }

  if (!lstatSync(target).isSymbolicLink()) {
    const removed = landsAt(target);
    const module = modules.find((m) => m === removed || isInside(removed, m));
    if (module !== undefined) {
      throw new Error(
        `Refusing to empty ${displayPath(target)}, which holds ${displayPath(relative(landsAt(guard.root), module) || module)}, a module the app is built from. ` +
          `Name a directory that holds none of the app's source.`
      );
    }
  }

  rmSync(target, { force: true, recursive: true });
}

/**
 * What a build writes into its output directory, relative to it: the entry
 * named after the executable, its sourcemap, and the chunk directory -- the
 * names `bundleApp()` gives rolldown. Both module extensions, because the
 * bundle `package` embeds for Node is CommonJS.
 *
 * @param name - What the built executable is called, from `binName()`.
 * @returns The names.
 */
export function bundleWrites(name: string): readonly string[] {
  return [...['mjs', 'cjs'].flatMap((ext) => [`${name}.${ext}`, `${name}.${ext}.map`]), 'chunks'];
}

/**
 * Whether removing `out` removes `target`: `out` is `target`, or a directory
 * above it.
 *
 * `isInside()` is the path rule, and this adds only the one thing it leaves
 * out on purpose: the path itself. SIG-246 is why the rule is asked of
 * `relative()` -- a prefix test let `/` and `C:\` through and reached
 * `rmSync('/', { recursive: true })` -- and the reasoning lives with
 * `isInside()` now rather than in a second copy of it here. The same-path
 * half is asked of `relative()` too rather than by comparing strings, so that
 * `c:\users\me\app` is the app at `C:\Users\me\app` on Windows.
 *
 * This is arithmetic on spellings, so it answers for the path as written and
 * not for what is on disk under it: a symlinked ancestor, or a different case
 * on a case-insensitive volume, is `heldFile()`'s to see.
 *
 * The path module is a parameter so both platforms' semantics can be asked on
 * one machine; everything that is not a test takes the host's.
 *
 * @param out - The output directory.
 * @param target - What might be under it.
 * @param path - The path semantics to ask with.
 * @returns `true` if `out` is `target` or an ancestor of it.
 */
function holds(out: string, target: string, path: typeof nodePath = nodePath): boolean {
  return (
    path.relative(path.resolve(out), path.resolve(target)) === '' || isInside(out, target, path)
  );
}

/**
 * Whether emptying `out` would take the app at `root` with it: `out` is the
 * app root or any directory above it, the filesystem root included.
 *
 * @param out - The output directory.
 * @param root - The app's root.
 * @param path - The path semantics to ask with.
 * @returns `true` if `out` is the app root or an ancestor of it.
 */
export function holdsApp(out: string, root: string, path: typeof nodePath = nodePath): boolean {
  return holds(out, root, path);
}

/**
 * Everything the build reads that is the app's own, which is everything
 * emptying the output directory must not take.
 *
 * The entry, every command module the walk found, every existing file a
 * catalog loader on the entry names by a literal `import()` -- parsed as a
 * catalog or not, since the bundle imports it either way -- the command
 * directory itself, the manifest, `sigil.json` or `sigil.jsonc`, and the `tsconfig.json`
 * the type check uses -- plus an executable `--bin` named. Files before the
 * directory, so that a refusal names a file somebody recognises rather than
 * the directory they typed.
 *
 * What it cannot list is a module only the bundle finds -- a helper the entry
 * imports, a catalog behind a loader that is not a literal `import()`,
 * `node_modules` -- because the module graph does not exist until rolldown
 * builds it, and the clean runs before that so that a stale chunk cannot be
 * read back. Cleaning such a directory still empties it and the build fails
 * after; under `--no-clean` nothing is removed, and a write that would land on
 * such a module is refused by the bundle itself (`sigil:own-source` in
 * `build/bundle.ts`), which is the one place the graph is known before
 * anything is written. The list is everything `inspect()` has already read,
 * which is what is knowable before the bundle.
 *
 * @param found - What reading the app turned up.
 * @param bin - An executable of the app's own, when one was named.
 * @returns Absolute paths, each of which exists.
 */
export function buildReads(found: Inspection, bin?: string): readonly string[] {
  const { root } = found.app;
  const files = [
    found.app.entry,
    ...modulesOf(found.commands),
    ...found.catalogFiles,
    join(root, 'package.json'),
    ...CONFIG_FILES.map((name) => join(root, name)),
    // the one `typeCheck()` uses, which is always the root's -- see
    // `typecheck.ts` for why it never walks up
    join(root, 'tsconfig.json'),
    ...(bin === undefined ? [] : [bin]),
    ...(found.commandDir === undefined ? [] : [found.commandDir]),
  ];

  return [...new Set(files.map((file) => resolve(file)))].filter((file) => existsSync(file));
}

/**
 * Every module in a tree, depth first.
 *
 * @param commands - The tree.
 * @returns The modules, in tree order.
 */
function modulesOf(commands: readonly ResolvedCommand[]): string[] {
  return commands.flatMap((cmd) => [
    ...(cmd.module === undefined ? [] : [cmd.module]),
    ...modulesOf(cmd.commands),
  ]);
}

/**
 * Which of `reads` removing `out` would take with it, asked two ways.
 *
 * By spelling, through `holds()`, which is what catches `--out src` and its
 * relatives: a relative `out`, a trailing separator and `..` segments are all
 * gone by the time `resolveOut()` and `resolve()` hand it over, and on Windows
 * `relative()` already compares the way that filesystem does.
 *
 * And by **identity**, which is what the spelling cannot see. `rmSync()`
 * follows every symlink on the way to `out` and none at it, so an `out` under
 * a symlinked directory removes what the link points at, and on a
 * case-insensitive volume `--out SRC` removes `src` while `relative()` calls
 * them strangers -- macOS's default, measured. So `out` is `lstat`ed, which is
 * exactly what `rmSync()` decides by, and compared by device and inode with
 * every directory above each file, walked both from the path the build reads
 * and from the real path behind it. An `out` that is itself a symlink to the
 * source is therefore **not** refused, and correctly: removing it unlinks the
 * link and leaves its target alone, measured too. An `out` that does not exist
 * yet cannot hold a file that does, so it is asked only by spelling.
 *
 * An inode of `0` is a file system that does not have them, where identity
 * says nothing and the spelling is all there is.
 *
 * @param out - The output directory.
 * @param reads - What the build reads.
 * @returns The first file `out` would take, and whether `out` is that file.
 */
export function heldFile(
  out: string,
  reads: readonly string[]
): { file: string; same: boolean } | undefined {
  // resolved once, so the spelling and the identity are asked of the same path
  // `clean()` removes
  const path = resolve(out);

  for (const file of reads) {
    if (holds(path, file)) {
      return { file, same: relative(path, resolve(file)) === '' };
    }
  }

  const target = statOf(path, lstatSync);
  if (!target || target.ino === 0n) {
    return undefined;
  }

  // one walk per directory however many files share it: a directory already
  // asked about did not match, and neither did anything above it
  const asked = new Set<string>();

  for (const file of reads) {
    for (const start of new Set([resolve(file), landsAt(file)])) {
      for (let dir = start; !asked.has(dir); dir = dirname(dir)) {
        asked.add(dir);
        const stats = statOf(dir, statSync);
        if (stats && stats.dev === target.dev && stats.ino === target.ino) {
          return { file, same: dir === start };
        }
        if (dirname(dir) === dir) {
          break;
        }
      }
    }
  }

  return undefined;
}

/**
 * A path's identity, or nothing when it cannot be asked.
 *
 * @param path - The path.
 * @param read - `lstatSync` for what `rmSync()` removes, `statSync` for what
 * a path reaches.
 * @returns Its stats, in `bigint` so a 64-bit inode survives.
 */
function statOf(path: string, read: typeof lstatSync | typeof statSync): BigIntStats | undefined {
  try {
    return read(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * Refuses an output directory that must not be emptied or built into, without
 * emptying any.
 *
 * Split out of `clean()` so it can be asked in a pre-flight, which is where it
 * belongs: it reads nothing but the paths it is given and the stats of what
 * they name, and leaving it until the removal meant a run doomed by its own
 * `--out` did all the expensive work first. Measured on CI, where
 * `sigil package --out <the app root>` **fetched a 90 MB runtime** before
 * refusing.
 *
 * The `existsSync` that guards the removal deliberately does not guard this. A
 * directory that is not there cannot be destroyed, so `clean()` skips it -- but
 * an `--out` naming the app root is a mistake whether or not the directory
 * exists yet, and reporting it only sometimes is worse than either.
 *
 * The second refusal is an `--out` holding anything the build reads:
 * `--out src` passed the first because `src` is below the app rather than
 * above it, and `rmSync()` took the source before rolldown failed on the entry
 * it was about to read (SIG-350). It is asked **whether or not cleaning was**,
 * because `--no-clean` into the source is the same mistake arriving later: the
 * bundle is written over it instead, and `--out src --no-clean` replaced an
 * entry called `src/<bin>.mjs` with the minified bundle and reported success.
 * A directory of source is never an output directory, so the message offers no
 * `--no-clean`.
 *
 * The one place `--no-clean` still means something is the app root and above,
 * which is the escape hatch the first refusal names: `--out . --no-clean` puts
 * the executable beside the manifest, and refusing it because the root holds
 * `package.json` would take the hatch away. There, what is refused is a write
 * that lands on something the build reads -- `guard.writes`, joined to `out`.
 *
 * @param out - The output directory.
 * @param guard - The app, what the build reads and writes, and whether to clean.
 * @throws If the directory holds the app itself and is to be emptied, if it
 * holds anything the build reads, or if a write would land on one.
 */
export function assertCleanable(out: string, guard: OutputGuard): void {
  const target = resolve(out);
  const { clean: wanted, reads, root } = guard;

  // a removal stops at the last link and a write goes through it, so a build
  // that only writes is asked about where its writes land as well as about the
  // path it was given: `--out outlink --no-clean`, with `outlink` a link to
  // `src`, wrote the bundle over the source while `lstat` saw only the link
  const landing = wanted ? target : landsAt(target);

  if (holdsApp(target, root) || (!wanted && holdsApp(landing, landsAt(root)))) {
    if (wanted) {
      throw new Error(
        `Refusing to empty ${displayPath(target)}, which holds the app itself. ` +
          `Name a directory inside it, or pass --no-clean.`
      );
    }

    // not emptied, so only what is written can hurt -- including through a
    // link, which a `<bin>.mjs` that is a symlink to the entry would be
    for (const name of guard.writes ?? []) {
      const write = join(target, name);
      const held = heldFile(write, reads) ?? heldFile(landsAt(write), reads);
      if (held) {
        throw new Error(refusal(write, held, root, false));
      }
    }
    return;
  }

  const held = heldFile(target, reads) ?? (wanted ? undefined : heldFile(landing, reads));
  if (held) {
    throw new Error(refusal(target, held, root, wanted));
  }
}

/**
 * What a refusal of a path holding something the build reads says.
 *
 * @param path - The path that would have been removed or written.
 * @param held - What it holds, from `heldFile()`.
 * @param root - The app's root, which the file is named relative to.
 * @param removing - Whether the path was to be removed rather than written.
 * @returns The message.
 */
function refusal(
  path: string,
  held: { file: string; same: boolean },
  root: string,
  removing: boolean
): string {
  const file = displayPath(relative(root, held.file) || held.file);
  const what = held.same
    ? `${removing ? 'remove' : 'write over'} ${displayPath(path)}, which is ${file}`
    : `${removing ? 'empty' : 'build into'} ${displayPath(path)}, which holds ${file}`;

  return `Refusing to ${what}, and the build reads it. Name a directory that holds none of the app's source.`;
}
