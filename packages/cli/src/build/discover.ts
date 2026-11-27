/**
 * Finding the app: its root, its entry, and where it keeps its commands.
 *
 * Step one of the pipeline, and the one that decides whether anything else has
 * something to work on. A caller that already knows where the commands are can
 * say so and skip all of this; a caller standing in a directory cannot, and
 * "run it from the app root and it works out the rest" is the whole of what
 * makes a toolchain feel like one.
 *
 * ## `@ttylabs/sigil` in the manifest is what makes it an app
 *
 * Checked before anything else, because every error after it would be a worse
 * version of the same message. A directory that does not depend on the runtime
 * is not an app this can check, and saying that is more use than reporting that
 * it has no `commands/` directory.
 *
 * It is any kind of dependency -- a `dependency`, a `devDependency`, a
 * `peerDependency` -- since which one an app declares is a packaging decision
 * and none of them makes it less of a sigil app.
 *
 * ## Source first, manifest second
 *
 * The obvious entry is `bin`, and it is usually the wrong file: a published CLI
 * points its `bin` at built output, so following it means parsing a minified
 * bundle whose import specifiers are chunk names a bundler invented. `check`
 * reads what the author edits and what the build will compile, so it looks for
 * a source entry by convention first and falls back to what the manifest names
 * only when there is none.
 *
 * That is a heuristic, so the entry it picked is *reported* rather than assumed
 * -- and `--entry` overrides it. A guess nobody can see is the kind that costs
 * an afternoon.
 *
 * ## The schema is read, not run
 *
 * An app's `commands` is either a path -- the filesystem router, which
 * `resolveCommandTree()` already walks -- or an object written out. Both are
 * read off source -- the entry's, or the module the entry imports its schema
 * from (`schemaModule()`) -- because running it would run the app.
 */

import {
  lacksResolver,
  schemasWith,
  sealedResolver,
  spellingIn,
  visibleLiteral,
  writtenKeys,
} from './bindings.ts';
import { type Diagnostic, displayPath } from './diagnostic.ts';
import { type CommandFacts, factsOf, type RoutedBy } from './extract.ts';
import { translatedKey } from './i18n.ts';
import {
  flatten,
  isNoBaseDir,
  isUndefined,
  isWrongType,
  lastPlain,
  literalBoolean,
  literalString,
  literalType,
  loaderSpecifier,
  mayCarry,
  objectLiteral,
  outermostDeclaring,
  PLACEHOLDER_KEYS,
  plainProperty,
  propertyKey,
  replacerPhrase,
  stringList,
  unwrapShallow,
} from './literals.ts';
import { locate, parseModule, type ParsedModule } from './parse-module.ts';
import { schemaModule } from './schema-module.ts';
import type { ResolvedCommand } from './tree.ts';
import { physicalPath } from '@ttylabs/sigil/config';
import { errorMessage, escapeControls } from '@ttylabs/sigil/error-handler';
import {
  defaultTypeMessage,
  descReturnMessage,
  descTypeMessage,
  hiddenTypeMessage,
  invalidAlias,
  type PackageRoute,
  packageRouteName,
  parseName,
  readPackage,
} from '@ttylabs/sigil/internal/routes';
import { readFileSync, statSync } from 'node:fs';
import nodePath, { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Expression, ObjectExpression, ObjectProperty, SpreadElement } from 'oxc-parser';

/**
 * What makes a directory an app this can check.
 *
 * Exported because two other places name the same package and each had its own
 * spelling of it: `generate.ts` imports `main` from it in the entry it writes,
 * and the bundle tells rolldown to compile JSX against its `./jsx-runtime`. The
 * package whose presence in a manifest makes a directory a sigil app is the
 * package the built app imports and the package whose JSX runtime it uses, so it
 * is one constant -- the rule `COLOR_PROPERTIES` and `INHERITED` already follow,
 * met over a string.
 */
export const RUNTIME = '@ttylabs/sigil';

/**
 * Where a source entry is looked for, in order.
 *
 * `index` before `main` and `cli` because it is what every other tool means by
 * an entry, and `src/` before the root because an app with both keeps its
 * sources in one and its output in the other.
 */
const ENTRY_NAMES = ['src/index', 'src/main', 'src/cli', 'src/app', 'index', 'main', 'cli'];

/** The extensions a module may have, in the order they are tried. */
export const EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** What an app's manifest says that matters here. */
export interface AppManifest {
  /** Every dependency it declares, however it declares them. */
  readonly dependencies: readonly string[];
  /**
   * The one executable it publishes, when it publishes exactly one.
   *
   * What the built executable should be called, and a better answer than the
   * package name: `@ttylabs/cli` publishes `sigil`, and a build naming the
   * file after the package writes a `cli.mjs` the manifest does not point at.
   * More than one is not an answer, so it is left to `--name`.
   */
  readonly bin?: string;
  /** What it calls itself. */
  readonly name?: string;
  /** Where the manifest is. */
  readonly path: string;
  /**
   * What it calls its version, baked into the generated entry as the fallback
   * for a schema that declares no string `version` of its own.
   *
   * A bundle has no `package.json` beside it, so an app that reads its own at
   * run time is reading a path that points wherever the bundle was written.
   */
  readonly version?: string;
}

/** An app, found. */
export interface DiscoveredApp {
  /**
   * The module the generated entry imports its schema from.
   *
   * Not always the file the schema is written in: an entry that exports a schema it
   * imported leaves that to `schemaModule()`, which the readers ask.
   */
  readonly entry: string;
  /** What its manifest said. */
  readonly manifest: AppManifest;
  /** Its root, which is where the manifest is. */
  readonly root: string;
}

/** Where an app keeps its commands, as its entry declares them. */
export type AppCommands =
  | {
      /** The directory the filesystem router walks. */
      readonly dir: string;
      readonly kind: 'directory';
    }
  | {
      /** The commands the schema wrote out. */
      readonly commands: readonly ResolvedCommand[];
      readonly kind: 'inline';
    };

/** How to find an app. */
export interface DiscoverOptions {
  /** The entry to read, when the conventions should not be trusted. */
  readonly entry?: string;
}

/**
 * Finds the app rooted at a directory.
 *
 * @param cwd - Where to look.
 * @param options - An entry, when the caller knows better than the conventions.
 * @returns The app.
 * @throws If there is no manifest, if it does not depend on the runtime, or if
 *   no entry can be found. Each is a thing to fix rather than to report and
 *   carry on from, because none of them leaves anything to check.
 */
export function discoverApp(cwd: string, options: DiscoverOptions = {}): DiscoveredApp {
  const root = resolve(cwd);
  const manifest = readManifest(root);

  // asked first, because every error after this one would be a worse version
  // of the same message
  if (!manifest.dependencies.includes(RUNTIME)) {
    throw new Error(
      `${escapeControls(displayPath(manifest.path))} does not depend on ${RUNTIME}, so there is no sigil app here to check`
    );
  }

  const entry = options.entry
    ? resolveEntry(root, options.entry)
    : findEntry(root, readManifestEntries(manifest.path));

  if (!entry) {
    throw new Error(
      `No entry module found in ${escapeControls(displayPath(root))}. Looked for ${ENTRY_NAMES.map((name) => `${name}.*`).join(', ')} and what the manifest names; pass --entry to name one`
    );
  }

  return { entry, manifest, root };
}

/**
 * Reads what an app's manifest says about itself.
 *
 * @param root - The app's root.
 * @returns Its manifest.
 * @throws If there is no manifest, or it will not parse.
 */
export function readManifest(root: string): AppManifest {
  const path = join(root, 'package.json');

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(
      `No package.json in ${escapeControls(displayPath(root))}; sigil runs from an app's root`
    );
  }

  let json;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(
      `Failed to parse ${escapeControls(path)}: ${escapeControls((e as Error).message)}`
    );
  }

  const dependencies = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const declared = json[field];
    if (declared && typeof declared === 'object') {
      for (const name of Object.keys(declared)) {
        dependencies.add(name);
      }
    }
  }

  return {
    bin: binName(json.bin),
    dependencies: [...dependencies],
    name: typeof json.name === 'string' ? json.name : undefined,
    path,
    version: typeof json.version === 'string' ? json.version : undefined,
  };
}

/**
 * The entries a manifest names, as paths relative to the app.
 *
 * Last resort rather than first guess: a published CLI points its `bin` at
 * built output, and parsing a bundle is not what anybody means by checking an
 * app.
 *
 * @param manifestPath - The manifest.
 * @returns The relative paths it names.
 */
function readManifestEntries(manifestPath: string): string[] {
  const json = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    bin?: string | Record<string, string>;
    main?: string;
  };

  const named: string[] = [];

  if (typeof json.bin === 'string') {
    named.push(json.bin);
  } else if (json.bin && typeof json.bin === 'object') {
    named.push(...Object.values(json.bin));
  }

  if (typeof json.main === 'string') {
    named.push(json.main);
  }

  return named;
}

/**
 * The first entry that exists, source conventions before the manifest.
 *
 * @param root - The app's root.
 * @param named - What the manifest named.
 * @returns The entry, or `undefined`.
 */
function findEntry(root: string, named: readonly string[]): string | undefined {
  for (const name of ENTRY_NAMES) {
    for (const extension of EXTENSIONS) {
      const candidate = join(root, `${name}${extension}`);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }

  for (const entry of named) {
    const candidate = resolve(root, entry);
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * An entry the caller named, resolved and checked.
 *
 * @param root - The app's root.
 * @param entry - What they said.
 * @returns The path.
 * @throws If it is not a file.
 */
function resolveEntry(root: string, entry: string): string {
  const path = isAbsolute(entry) ? entry : resolve(root, entry);

  if (!isFile(path)) {
    throw new Error(`Entry module not found: ${escapeControls(displayPath(path))}`);
  }

  return path;
}

/**
 * Whether a path is a file that exists, answering `false` for anything
 * unreadable.
 *
 * Exported for `sigil add`'s registry lookup, which asks the same question of a
 * `package.json` and had written it out again.
 *
 * @param path - The path.
 * @returns Whether to read it.
 */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a path lies strictly inside a directory, by path arithmetic alone.
 *
 * The one definition of a question four places were asking. `undo()` and
 * `isAppsOwn()` had each written it out, and `sigil package`'s runtime cache and
 * `sigil add`'s registry paths needed it a third and fourth time -- for input
 * that came from somebody else's data, where a `..` is how a write lands
 * outside the directory it was meant for.
 *
 * **Strictly** inside: the directory is not inside itself, because every caller
 * is asking about a file or a subdirectory below it. `holds()` in
 * `commands/_inspect.ts` is the one caller that wants the path itself counted
 * too, and it says so beside this rather than with a path rule of its own.
 *
 * Asked of `relative()` rather than of a string prefix, for the reasons SIG-246
 * found in the copy of this that the clean guard used to carry. A prefix needs a
 * separator appended, so that `dist-old` is not read as inside `dist`, and the
 * root is the one directory `resolve()` already ends in one -- every caller had
 * to remember that, and the clean guard did not. A prefix is also
 * case-sensitive where Windows is not, so `c:\users\me\app\x` was outside
 * `C:\Users\me\app`; `win32.relative()` compares the way that filesystem
 * does. What `relative()` answers is the way down from `dir` to `target`, and
 * `target` is inside when that is not empty (the directory itself), does not
 * climb (`..` as a whole segment, so a child called `..foo` is a child), and
 * is not absolute (another drive). This is one copy of that question instead of
 * two that agree today.
 *
 * Lexical rather than through `realpath`, for the reason `undo()` records: a
 * symlink somebody put inside the directory is a layout they chose, and what
 * this guards against is a path that *says* it goes elsewhere.
 *
 * The path module is a parameter so both platforms' semantics can be asked on
 * one machine; everything that is not a test takes the host's.
 *
 * @param dir - The directory.
 * @param target - The path, relative to the working directory or absolute.
 * @param path - The path semantics to ask with.
 * @returns Whether `target` resolves to something under `dir`.
 */
export function isInside(dir: string, target: string, path: typeof nodePath = nodePath): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));

  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Where the kernel would put a write to `path`, as `physicalPath()` in
 * `@ttylabs/sigil/config` answers it -- every symlink on the way followed, a
 * `..` after one read the way the kernel reads it, for a path that need not
 * exist -- or the path as spelled where the file system cannot answer.
 *
 * `physicalPath()` throws for anything but a missing file, which is right for a
 * writer about to write and wrong for a guard asking a question: a path under a
 * file, a link loop or a directory it cannot read fails the write or the
 * removal itself a moment later, with the file system's own error, and a guard
 * that threw first would only replace that error with one about asking. A
 * dangling link at the end of the path is not followed, and need not be: what
 * the guards ask is whether a path lands on a file the build reads, every one of
 * which exists, so a link that points at nothing cannot point at one.
 *
 * `isInside()` is lexical on purpose (see `undo()`), and this is the one place
 * the build asks the file system instead: the clean guard and the bundle's own
 * write guard, both of which are about what is on disk at the end of a path.
 *
 * @param path - The path, which need not exist.
 * @returns Its physical path, or `resolve(path)` where that cannot be learned.
 */
export function landsAt(path: string): string {
  try {
    return physicalPath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolves an import specifier the way the module holding it would.
 *
 * The `.js` to `.ts` fallback is the one that matters and is not a guess: a
 * TypeScript ES module imports its neighbour as `./check.js` even though the
 * file on disk is `check.ts`, which is the convention this repo follows itself.
 * Without it every command a schema declares through `load` would come back
 * unresolved.
 *
 * @param from - The directory the specifier was written in.
 * @param specifier - What it said.
 * @returns The file, or `undefined` when nothing answers to it.
 */
export function resolveSpecifier(from: string, specifier: string): string | undefined {
  // a bare specifier is a package rather than a file in this app, and a
  // package's commands are its own business
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
    return undefined;
  }

  const base = isAbsolute(specifier) ? specifier : resolve(from, specifier);

  if (isFile(base)) {
    return base;
  }

  // `./check.js` where the file is `check.ts`
  const swapped = base.replace(/\.[cm]?js$/, '');
  if (swapped !== base) {
    for (const extension of EXTENSIONS) {
      const candidate = `${swapped}${extension}`;
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }

  for (const extension of EXTENSIONS) {
    if (isFile(`${base}${extension}`)) {
      return `${base}${extension}`;
    }
  }

  // a directory is its index module
  for (const extension of EXTENSIONS) {
    const candidate = join(base, `index${extension}`);
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Reads where an app's entry says its commands are.
 *
 * @param app - The app.
 * @returns What its schema declares, and anything reading it turned up.
 */
export function readAppCommands(app: DiscoveredApp): {
  commands?: AppCommands;
  diagnostics: readonly Diagnostic[];
  /**
   * Whether the entry declared `commands` at all.
   *
   * Apart from `commands` being `undefined`, which covers the other case too:
   * a schema that declares commands this cannot *read* has already been
   * reported on, and a caller adding "no commands found" on top would be
   * saying one problem twice and getting the second one wrong.
   */
  found: boolean;
  /**
   * Whether the schema is itself the command: a `run` and no `commands`.
   *
   * Which is a single-command app, and is the `--layout single` layout `sigil new`
   * scaffolds. There is nothing to walk and nothing to bake, so the absence of
   * `commands` is the answer rather than a thing to report -- without this the
   * build refused such an app outright with `no "commands" found in this
   * module`, so `--single` scaffolded an app that ran from source and could
   * not be built, which is the works-unbundled-fails-built divergence the
   * shared route rules exist to prevent.
   *
   * Asked only where this read the entry's own `commands`, so a `--commands`
   * directory leaves it `false`: that flag is an instruction about where the
   * app's commands are, and the summary should then speak about that directory
   * rather than about the root.
   */
  root: boolean;
} {
  // the module the schema is written in, which is the entry unless the entry
  // imports it -- and what its paths, its positions and its `baseDir` are
  // relative to either way
  const file = schemaModule(app.entry);
  const parsed = parseModule(file, readFileSync(file, 'utf-8'));
  const diagnostics: Diagnostic[] = [];

  const schemas = schemasWith(parsed, 'commands');

  if (!schemas.length) {
    // a `run` with no `commands` beside it is a single-command app, where
    // `main()` dispatches the root. `outermostDeclaring()` rather than
    // `schemasWith()`, because a `run` is written as a **method** far more
    // often than as a property and `plainProperty()` leaves a method out --
    // the scaffold's own `run({ argv }) { ... }` is one.
    //
    // Asked as a presence rather than as a single unambiguous literal, because
    // nothing is *read* out of it: the runtime reads `schema.run` off the
    // module's own export, and what this decides is only whether a missing
    // `commands` is a problem. So a module with two run-bearing literals needs
    // no rule of its own here.
    const root = outermostDeclaring(parsed.program as never, 'run').length > 0;
    return { diagnostics, found: false, root };
  }

  if (schemas.length > 1) {
    // more than one schema in one module is a thing this cannot choose
    // between, and choosing by source order would be choosing by accident
    diagnostics.push({
      ...locate(parsed, schemas[1]!.start),
      message: `found ${schemas.length} schemas in this module; pass --commands to say which command directory to check`,
      severity: 'warning',
    });
    return { diagnostics, found: true, root: false };
  }

  // read through the spreads the build can resolve, so a sealed base's `commands`
  // and `baseDir` are what the schema has, and the last spelling is the one that
  // runs (SIG-728)
  const resolver = sealedResolver(parsed);
  const declared = lastPlain(schemas[0]!, 'commands', resolver);
  const commandsSpelling = spellingIn(parsed, schemas[0]!, 'commands');
  if (!declared) {
    // claimed for spelling `commands` as a getter, a setter or a method, which the
    // runtime reads and a build cannot run: the app has commands and the built one
    // would have none. An error, as a computed `commands` is, and for the same
    // reason -- it would build an app that silently lacks what the source app has,
    // where the placeholder's is a warning because the rest of the app is still
    // baked (SIG-734). Worded as that one is (SIG-732)
    diagnostics.push({
      ...locate(parsed, commandsSpelling.declared!.start),
      message:
        '"commands" is an accessor or a method rather than an object literal, so it cannot be read at build time and a built app will not have these commands; it applies when the app runs from source and not after a build, so write it as an object literal of commands, or pass --commands to name a command directory',
      severity: 'error',
    });
    return { diagnostics, found: true, root: false };
  }
  if (commandsSpelling.replaced || commandsSpelling.shadowedBy) {
    // a spread the build cannot read, after the `commands` that was read: it may
    // carry its own, and the app runs the last -- and an accessor of the same key
    // does carry one, which `lastPlain()` leaves out. Said rather than guessed
    // (SIG-728, SIG-730)
    diagnostics.push({
      ...locate(parsed, declared.start),
      message: `"commands" is written before ${replacerPhrase(commandsSpelling)}, so what is read here may not be the app's commands; pass --commands to say which command directory to check`,
      severity: 'warning',
    });
  }
  const schemaDir = dirname(file);

  const asPath = literalString(declared.value);
  if (asPath !== undefined) {
    // A relative path here means two different things unless the schema says
    // what it is relative to. This pass resolves it against the entry module;
    // the runtime has no file to resolve an inline schema against, so it falls
    // back to the process's working directory -- which for an installed CLI is
    // wherever the user was standing. So the app builds and runs bundled, and
    // throws `Unsupported command module` the moment anybody runs it from
    // source, while this command reports no problems at all.
    //
    // A warning rather than an error because the *built* app is genuinely
    // fine, and an app that only ever ships bundled is not wrong. What is
    // wrong is this command having nothing to say about it.
    // a `baseDir` spelled in any way counts, an accessor included: the runtime
    // reads it. What is not known is whether a spread or a computed key the build
    // cannot read carries one, which is said as that and not as there being none
    // (SIG-729)
    const members = flatten(schemas[0]!, resolver);
    const spelled = members.findLastIndex(
      (member) => member.type !== 'SpreadElement' && propertyKey(member) === 'baseDir'
    );
    const last = spelled < 0 ? undefined : members[spelled];
    // `baseDir: undefined` is none, as it is to the runtime, and so are `null` and
    // an empty string, which it reads as falsy (SIG-733)
    const unset =
      last !== undefined &&
      last.type !== 'SpreadElement' &&
      last.kind === 'init' &&
      !last.method &&
      isNoBaseDir(last.value);
    // what may set it after the last spelling of it, and what it is known to hold
    // nothing of is not asked about
    const lacks = lacksResolver(parsed);
    const carrier = members
      .slice(spelled + 1)
      .find(
        (member) =>
          (member.type === 'SpreadElement' || member.computed) && mayCarry(member, 'baseDir', lacks)
      );
    if (!isAbsolute(asPath) && (spelled < 0 || unset)) {
      const resolves =
        `this resolves it against ${displayPath(schemaDir)} ` +
        `while the runtime resolves it against the working directory`;
      diagnostics.push(
        carrier
          ? {
              ...locate(parsed, carrier.start),
              message:
                `"commands" is a relative path and ${carrier.type === 'SpreadElement' ? 'a spread' : 'a computed key'} ` +
                `in the schema may carry a "baseDir" this cannot see; if it does not, ${resolves}. ` +
                `Add \`baseDir: import.meta.dirname\` to the schema, after the last spread or computed key.`,
              severity: 'warning',
            }
          : {
              ...locate(parsed, declared.value.start),
              message:
                `"commands" is a relative path and the schema sets no "baseDir", so ${resolves}. ` +
                `Add \`baseDir: import.meta.dirname\` to the schema.`,
              severity: 'warning',
            }
      );
    }

    return {
      commands: { dir: resolve(schemaDir, asPath), kind: 'directory' },
      diagnostics,
      found: true,
      root: false,
    };
  }

  const written = objectLiteral(declared.value);
  if (!written) {
    diagnostics.push({
      ...locate(parsed, declared.value.start),
      message:
        '"commands" is computed rather than a path or an object literal, so it cannot be read at build time; pass --commands to name a command directory',
      severity: 'error',
    });
    return { diagnostics, found: true, root: false };
  }

  return {
    commands: { commands: readInline(written, schemaDir, parsed, diagnostics), kind: 'inline' },
    diagnostics,
    found: true,
    root: false,
  };
}

/**
 * Reads a `commands` object literal into commands.
 *
 * @param object - The literal.
 * @param from - What its specifiers are relative to.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @returns One command per property.
 */
function readInline(
  object: ObjectExpression,
  from: string,
  parsed: ParsedModule,
  diagnostics: Diagnostic[]
): ResolvedCommand[] {
  const commands: ResolvedCommand[] = [];

  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      diagnostics.push({
        ...locate(parsed, property.start),
        message: '"commands" spreads another object, which may carry commands this cannot see',
        severity: 'warning',
      });
      continue;
    }

    // `{ __proto__: x }` sets the prototype of the object and declares nothing,
    // so source has no such command. `generateCommands()` prints a command of
    // that name as an own key, which is right for a package really named so --
    // and would give the built app a command this literal never had (SIG-634)
    if (
      property.kind === 'init' &&
      !property.computed &&
      !property.method &&
      !property.shorthand &&
      propertyKey(property) === '__proto__'
    ) {
      continue;
    }

    const name = propertyKey(property);
    if (!name) {
      diagnostics.push({
        ...locate(parsed, property.start),
        message: 'a command is declared under a computed key, so its name cannot be read',
        severity: 'warning',
      });
      continue;
    }

    commands.push(readCommand(name, property.value, from, parsed, diagnostics));
  }

  return commands;
}

/**
 * Reads one declared command.
 *
 * @param name - What it is called.
 * @param value - What it was declared as.
 * @param from - What its specifiers are relative to.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @returns The command.
 */
function readCommand(
  name: string,
  value: Expression,
  from: string,
  parsed: ParsedModule,
  diagnostics: Diagnostic[]
): ResolvedCommand {
  // `commands: { build: './build.js' }` is a path, which the runtime resolves
  // as one command however many files sit behind it
  const asPath = literalString(value);
  if (asPath !== undefined) {
    // ...unless it is a package, which the runtime imports when the schema is
    // built and which names itself -- the key is not one of its spellings
    const pkg = keyedPackage(name, isAbsolute(asPath) ? asPath : resolve(from, asPath), {
      at: value,
      diagnostics,
      parsed,
    });
    if (pkg) {
      return pkg;
    }

    const module = resolveSpecifier(from, asPath);
    return {
      commands: [],
      kind: 'inline',
      ...moduleFacts(
        module,
        asPath,
        name,
        parsed,
        diagnostics,
        value,
        false,
        routedByPlaceholder(asPath, module, name)
      ),
      name,
    };
  }

  const object = objectLiteral(value);
  if (!object) {
    diagnostics.push({
      ...locate(parsed, value.start),
      message: `the "${escapeControls(name)}" command is computed rather than a literal, so nothing about it can be read at build time`,
      severity: 'warning',
    });
    return { commands: [], kind: 'inline', name };
  }

  const { name: named, specifier } = placeholderIdentity(object, parsed, diagnostics, name);
  // read as the other keys are, through `flatten()`: a spread may carry the
  // subcommands, or replace the ones written, and a built app has the tree it
  // was given and nothing else (SIG-726)
  const nested = readSpelled(object, 'commands', {
    consequence: 'the built app will not have its subcommands',
    diagnostics,
    // a spelling a later spread may replace is baked all the same: a mixin that
    // carries no `commands` is the usual one, and dropping subcommands the app
    // has is the worse of the two ways to be wrong
    keepReplaced: 'the built app has the subcommands as written',
    name: commandName(named).name,
    parsed,
    severity: 'warning',
  });
  const own = placeholderFacts(object, parsed, diagnostics, named);
  const routing = placeholderRouting(object, parsed, diagnostics, named);
  warnUnbaked(object, parsed, diagnostics, named);

  // what the *placeholder* declares is what help shows before the module loads,
  // so a `desc` here -- readable or not -- is the answer to every question the
  // module's own readability could have raised, which is why it silences them.
  // All of `factsOf()`'s diagnostics are about what help would show pre-load,
  // and a `hidden` the module computes is what the `!` name prefix is for
  const described = own.declaresDesc;

  const module = specifier ? resolveSpecifier(from, specifier) : undefined;
  const facts = moduleFacts(
    module,
    specifier,
    name,
    parsed,
    diagnostics,
    value,
    described,
    routedByPlaceholder(
      specifier,
      module,
      [named, ...(routing.alias ?? [])].join(', '),
      routing.default === true
    )
  );

  // what the *placeholder* declares is what help shows before the module
  // loads, so whenever it declares one it decides -- even where this cannot
  // read it, which bakes nothing rather than the module's answer to a question
  // the placeholder already answered. And `descTranslated` goes with whichever
  // `desc` is used: the module's key is printed as a thunk over the tag, as the
  // string-path spelling above already does by spreading the facts
  const desc = own.declaresDesc ? own : facts;

  return {
    ...routing,
    commands: nested
      ? objectLiteral(nested.value)
        ? readInline(objectLiteral(nested.value)!, from, parsed, diagnostics)
        : []
      : [],
    desc: desc.desc,
    ...(desc.descTranslated ? { descTranslated: true } : {}),
    hidden: own.declaresHidden ? own.hidden : facts.hidden,
    kind: 'inline',
    module: facts.module,
    name: named,
  };
}

/** What a placeholder says help shows before its module loads. */
interface PlaceholderFacts extends CommandFacts {
  /** Whether it declares a `desc` at all, readable or not. */
  readonly declaresDesc: boolean;
  /** Whether it declares a `hidden` at all, readable or not. */
  readonly declaresHidden: boolean;
}

/**
 * What a placeholder declares about what help shows before its module loads.
 *
 * The runtime registers the placeholder as it is written, so any `desc` or
 * `hidden` on it is what an unloaded command shows -- its module's are merged in
 * only where the placeholder left the key `undefined`, and only once it loads.
 * So a declared value decides whether or not this can read it, and one it
 * cannot read bakes nothing rather than the module's answer (SIG-352).
 *
 * A `__` tag is read as its key and printed as **prose**, because that is what
 * the app shows from source: the schema module is evaluated before `main()`
 * loads a catalog, so the tag answers in English there (see `DescThunk`). A
 * thunk over the tag, `` () => __`...` ``, is evaluated during the parse and
 * after the catalog, so it is read as the key it returns and printed as the
 * same thunk. A value of a type the runtime refuses fails the build in the
 * runtime's words, as a placeholder's `alias` and `default` do -- and that
 * includes a function where the runtime wants a boolean, and a thunk that
 * cannot answer a string, which an `async` one never does (SIG-421).
 *
 * @param object - The command literal.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @param nameString - The name string it is registered under.
 * @returns What it declares.
 */
function placeholderFacts(
  object: ObjectExpression,
  parsed: ParsedModule,
  diagnostics: Diagnostic[],
  nameString: string
): PlaceholderFacts {
  const command = commandName(nameString);
  const spelled = (key: string) => placeholderSpelling(object, key, parsed);
  const beforeOpaque = (key: string, consequence: string) =>
    replacedMessage(command.name, key, consequence);
  const carried = (key: string, consequence: string) =>
    carriedMessage(command.name, key, consequence);
  // reported under a `!` too, with what is true there: a `!` hides it from a
  // boolean of either value and from `undefined`, and anything else -- which
  // a spread may hold as easily as a boolean -- is a value the runtime refuses
  const hiddenUnknown = command.hidden
    ? 'the "!" in its name hides it either way, unless the value the app runs with is neither a boolean nor undefined, which the app refuses'
    : 'the built app will list it in help';

  const facts: { desc?: string; descTranslated?: boolean; hidden?: boolean } = {};
  const { carrier: descCarrier, declared: desc, replaced: descReplaced } = spelled('desc');
  const { carrier: hiddenCarrier, declared: hidden, replaced: hiddenReplaced } = spelled('hidden');

  if (desc && descReplaced) {
    diagnostics.push({
      ...locate(parsed, desc.start),
      message: beforeOpaque('desc', 'the built app will list it by name alone'),
      severity: 'warning',
    });
  } else if (descCarrier) {
    diagnostics.push({
      ...locate(parsed, descCarrier.start),
      message: carried('desc', 'the built app will list it by name alone'),
      severity: 'warning',
    });
  } else if (desc) {
    const value = desc.kind === 'init' && !desc.method ? desc.value : undefined;
    // the runtime names the command by the name its name string parses to
    const what = `the "${command.name}" command`;
    const refused = refusedThunk(desc);
    const read = value && !refused ? placeholderDesc(parsed, value) : undefined;

    if (read) {
      Object.assign(facts, read);
    } else if (refused) {
      diagnostics.push({
        ...locate(parsed, refused.start),
        message: descReturnMessage(what),
        severity: 'error',
      });
    } else if (value && literalType(value) !== 'function' && isWrongType(value, 'string')) {
      diagnostics.push({
        ...locate(parsed, value.start),
        message: descTypeMessage(what),
        severity: 'error',
      });
    } else {
      diagnostics.push({
        ...locate(parsed, (value ?? desc).start),
        message: `the "${command.name}" command's "desc" is ${
          value && interpolated(parsed, value)
            ? 'a translated string with a value interpolated into it'
            : 'computed rather than a string literal'
        }, so it cannot be read at build time; the built app will list it by name alone`,
        severity: 'warning',
      });
    }
  }

  if (hidden && hiddenReplaced) {
    diagnostics.push({
      ...locate(parsed, hidden.start),
      message: beforeOpaque('hidden', hiddenUnknown),
      severity: 'warning',
    });
  } else if (hiddenCarrier) {
    diagnostics.push({
      ...locate(parsed, hiddenCarrier.start),
      message: carried('hidden', hiddenUnknown),
      severity: 'warning',
    });
  } else if (hidden) {
    const value = hidden.kind === 'init' && !hidden.method ? hidden.value : undefined;
    const flag = value ? literalBoolean(value) : undefined;

    if (flag !== undefined) {
      facts.hidden = flag;
    } else if (hidden.method || (value && isWrongType(value, 'boolean'))) {
      // a method is a function however it is spelled, and the runtime refuses
      // one as it refuses `hidden: () => true`; an accessor is not known to be
      diagnostics.push({
        ...locate(parsed, (value ?? hidden).start),
        // the runtime names the name string as declared, here
        message: hiddenTypeMessage(escapeControls(nameString)),
        severity: 'error',
      });
    } else if (!command.hidden) {
      // a `!` in the name string hides it whatever boolean `hidden` turns out
      // to be, since the two are additive and `false` cannot un-hide it -- so
      // "the built app will list it" is false there, and it is the only thing
      // this warning says. The refusal above is reported under a `!` all the
      // same, because `initCommand()` checks the type before it applies the `!`
      diagnostics.push({
        ...locate(parsed, (value ?? hidden).start),
        message: `the "${command.name}" command's "hidden" is computed rather than a boolean literal, so it cannot be read at build time; the built app will list it in help`,
        severity: 'warning',
      });
    }
  }

  return {
    ...facts,
    declaresDesc: desc !== undefined || descCarrier !== undefined,
    declaresHidden: hidden !== undefined || hiddenCarrier !== undefined,
  };
}

/**
 * Which spelling of a key a placeholder registers, as far as the source says.
 *
 * The last spelling of a key is the one an object literal keeps -- unless a
 * spread or a computed key after it may carry the key too, since order is what
 * the runtime registers: then it is not known to be what runs, so it is never
 * refused, since the value that runs may be a fine one, and never baked. The
 * rule `factsOf()` follows for a module, asked through the same
 * `lastReplacing()`, and asked *before* an `undefined` is set aside: a
 * `desc: undefined` a spread replaces is a `desc` (SIG-421). A key spelled
 * nowhere that a spread may carry is the placeholder's too -- the runtime merges
 * a module's `desc` and `hidden` in only where the placeholder's is
 * `undefined`, and never reads a module's `alias` or `default` for routing --
 * so it is unknown, and nothing else is baked in its place.
 *
 * One function for the seven keys the baked tree takes off a placeholder, so
 * what help lists, what routes and which module is bundled cannot come to
 * disagree about which spelling runs (SIG-430, SIG-433, SIG-434). It reads
 * `flatten()`'s list rather than the source's: a spread of an object literal is
 * what the literal holds, and `['path']` is `path`, so `{ ...{ alias: 'x' } }`
 * is an `alias` and is baked where it used to be unknown. What stays unknown is
 * what is not a literal, and the callers decide what that costs.
 *
 * @param object - The command literal.
 * @param key - The key in question.
 * @param parsed - The module, which a spread of a `const` of its own is read in
 *   (SIG-440).
 * @param computed - Whether a computed key that may be `key` is a carrier as
 *   well as a spread, which `name`, `path` and `load` ask and the rest do not.
 * @returns The spelling that runs, `undefined` where the key is not declared;
 *   whether a later property may replace it; and a spread that may carry a key
 *   spelled nowhere.
 */
function placeholderSpelling(
  object: ObjectExpression,
  key: string,
  parsed: ParsedModule,
  computed = false
): {
  carrier: SpreadElement | ObjectProperty | undefined;
  declared: ObjectProperty | undefined;
  replaced: boolean;
} {
  return spellingIn(parsed, object, key, computed);
}

/**
 * The spelling of a key a placeholder registers, where the source says which it
 * is, and a report where it does not.
 *
 * `placeholderSpelling()` answers what is known; this is what every read of a
 * placeholder's key does with the answer that it is *not* known -- a spelling a
 * later spread or computed key may replace, or a key a spread may carry that is
 * spelled nowhere -- so the sentence it says is one definition, whatever the
 * key. `alias` and `default` bake nothing and warn, or fail the build for a
 * package, which is the caller's to say. The three keys that decide which command
 * a built app routes to and which module it holds are `placeholderIdentity()`'s,
 * and a wrong answer there is refused (SIG-433, SIG-434).
 *
 * @param object - The command literal.
 * @param key - The key in question.
 * @param report - Where and how to say it is not known.
 * @param report.consequence - What the built app does without it.
 * @param report.diagnostics - Where to report.
 * @param report.keepReplaced - What the built app does, where a spelling a later
 *   property may replace is still returned, with the report, rather than treated
 *   as unknown.
 * @param report.name - The command's name, for the message.
 * @param report.parsed - The module, for positions.
 * @param report.severity - How serious it is.
 * @returns The spelling that runs, or `undefined` where the key is not declared
 *   or is not known.
 */
function readSpelled(
  object: ObjectExpression,
  key: string,
  report: {
    consequence: string;
    diagnostics: Diagnostic[];
    name: string;
    keepReplaced?: string;
    parsed: ParsedModule;
    severity: Diagnostic['severity'];
  }
): ObjectProperty | undefined {
  const { consequence, diagnostics, keepReplaced, name, parsed, severity } = report;
  const { carrier, declared, replaced } = placeholderSpelling(object, key, parsed);
  if (
    declared &&
    replaced &&
    keepReplaced !== undefined &&
    declared.kind === 'init' &&
    objectLiteral(declared.value)
  ) {
    // what is written is baked and what may replace it is said: for a key whose
    // loss is worse than its being wrong, which a spread that carries no such key
    // -- the common one -- makes it
    diagnostics.push({
      ...locate(parsed, declared.start),
      message: `the "${name}" command's "${key}" is written before a spread or a computed key, which may replace it when the app runs; ${keepReplaced}`,
      severity,
    });
    return declared;
  }

  if (declared && replaced) {
    diagnostics.push({
      ...locate(parsed, declared.start),
      message: replacedMessage(name, key, consequence),
      severity,
    });
    return undefined;
  }

  if (carrier) {
    diagnostics.push({
      ...locate(parsed, carrier.start),
      message: carriedMessage(name, key, consequence),
      severity,
    });
    return undefined;
  }

  return declared;
}

/**
 * The warning for a placeholder's key written before a spread or a computed key
 * that may replace it.
 *
 * @param name - The command's name, as the runtime parses it.
 * @param key - The key.
 * @param consequence - What the built app does without it.
 * @returns The message.
 */
function replacedMessage(name: string, key: string, consequence: string): string {
  return `the "${name}" command's "${key}" is written before a spread or a computed key, which may replace it when the app runs, so it cannot be read at build time; ${consequence}`;
}

/**
 * The warning for a key a placeholder spells nowhere that a spread may carry.
 *
 * @param name - The command's name, as the runtime parses it.
 * @param key - The key.
 * @param consequence - What the built app does without it.
 * @returns The message.
 */
function carriedMessage(name: string, key: string, consequence: string): string {
  const article = /^[aeiou]/.test(key) ? 'an' : 'a';
  return `the "${name}" command spreads another object, which may carry ${article} "${key}" this cannot see; ${consequence}`;
}

/**
 * What the runtime calls a command, for a message, and whether its name string
 * hides it.
 *
 * Read with the runtime's own `parseName()`, because the alternative is a
 * second reading of rules that have to stay one: `'build, b'` is `build` and
 * `'!secret'` is `secret`. A name string that names nothing is refused by the
 * runtime as it registers the command, which is not this message's to say, so
 * it is named as written.
 *
 * @param nameString - The name string a placeholder is registered under.
 * @returns Its name, and whether a `!` hides it.
 */
function commandName(nameString: string): { hidden: boolean; name: string } {
  try {
    const { hidden, name } = parseName(nameString);
    return { hidden, name: escapeControls(name) };
  } catch {
    return { hidden: false, name: escapeControls(nameString) };
  }
}

/**
 * A `desc` written as a function that cannot answer a string, which the runtime
 * calls and refuses: an `async` one answers a promise, a generator answers an
 * iterator, and an arrow whose body is a literal of another type answers that.
 *
 * Only what the source settles. A function whose body is a block, or returns
 * something this cannot read, may well answer a string, and is computed.
 *
 * @param property - The `desc` property.
 * @returns What to point the error at, or `undefined` when it is not refused.
 */
function refusedThunk(property: ObjectProperty): { start: number } | undefined {
  if (property.kind !== 'init') {
    return undefined;
  }

  // `async desc() {}` and `*desc() {}` are functions written as methods
  const fn = property.method ? property.value : unwrapShallow(property.value);
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
    return undefined;
  }

  if (fn.async || fn.generator) {
    return fn;
  }

  if (fn.type === 'ArrowFunctionExpression' && fn.expression) {
    const body = fn.body as Expression;
    if (isUndefined(body) || isWrongType(body, 'string')) {
      return body;
    }
  }

  return undefined;
}

/**
 * Whether a `desc` is a `__` tag with a value interpolated into it, or a thunk
 * returning one -- which is unreadable for a reason of its own, and is told
 * apart from "computed" because a tag whose neighbour lifted fine is the thing
 * the author is looking at.
 *
 * @param parsed - The module, for the tag's binding.
 * @param value - What the `desc` was written as.
 * @returns Whether it is.
 */
function interpolated(parsed: ParsedModule, value: Expression): boolean {
  const fn = unwrapShallow(value);
  const returned =
    fn.type === 'ArrowFunctionExpression' && fn.expression ? (fn.body as Expression) : value;
  const translated = translatedKey(parsed, returned);
  return translated !== undefined && translated.key === undefined;
}

/**
 * A placeholder's `desc`, where the source holds it: a string, a `__` tag read
 * as the prose it is from source, or a thunk returning either.
 *
 * @param parsed - The module, for the tag's binding.
 * @param value - What the `desc` was written as.
 * @returns The description, or `undefined` where the source does not hold it.
 */
function placeholderDesc(
  parsed: ParsedModule,
  value: Expression
): { desc: string; descTranslated?: true } | undefined {
  const text = literalString(value) ?? translatedKey(parsed, value)?.key;
  if (text !== undefined) {
    return { desc: text };
  }

  const fn = unwrapShallow(value);
  if (fn.type === 'ArrowFunctionExpression' && !fn.params.length && fn.expression) {
    const body = fn.body as Expression;
    const returned = literalString(body);
    if (returned !== undefined) {
      return { desc: returned };
    }

    const key = translatedKey(parsed, body)?.key;
    if (key !== undefined) {
      return { desc: key, descTranslated: true };
    }
  }

  return undefined;
}

/**
 * What a placeholder says about how it is *reached*, which no module can say for
 * it.
 *
 * `alias` and `default` are routing: the runtime reads them off the
 * placeholder when the command is registered, before argv has matched anything
 * and so before the module behind it could be loaded. A built app has nothing
 * else to read them from -- the tree it bakes is the only declaration it has --
 * so one left out is not deferred to the module, it is gone: `alias: 'del'`
 * answered from source and was `Unexpected argument "del"` after a build.
 *
 * This is the placeholder's own and never the module's, which is why it sits
 * beside the module's facts rather than in them: a module's `alias` is only
 * known once it has loaded, and baking it would make a command reachable under
 * a spelling that does not resolve from source.
 *
 * Two different things can stop a value being read and they are answered
 * differently. A **computed** one (`alias: names`) is this pass's limit, so it
 * is a warning, and the worse of the warnings since the command is unreachable
 * by that spelling rather than listed wrongly. A **literal of the wrong type**
 * (`alias: 42`, `default: 'yes'`) is the author's mistake: the runtime throws on
 * it at every start, so a build that only warned would turn an app that cannot
 * run from source into one that runs. That fails the build, in the runtime's
 * own words.
 *
 * Which spelling is read is the runtime's: the **last** one, through
 * `placeholderSpelling()`, as for `desc` and `hidden`. It used to be the first,
 * so `{ default: 'yes', default: true }` failed the build of an app that starts,
 * and `{ alias: 'del', ...base }` baked `del` where the app answers to `base`'s
 * alias. A spelling a later spread or computed key may replace, and a key a
 * spread may carry that is spelled nowhere, bake nothing and warn, as a
 * computed value does (SIG-430).
 *
 * The same reading serves a package a schema key points at, whose own module
 * routes it (see `keyedPackage()`). There a computed value is not this pass's
 * limit to warn about but a built app that would route differently from
 * source, so `refusal` makes it an error and says why.
 *
 * @param object - The command literal.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @param nameString - The name string it is registered under, for the messages.
 * @param refusal - Why a computed value fails the build, where it does.
 * @returns The routing it declares, absent where it declares none.
 */
function placeholderRouting(
  object: ObjectExpression,
  parsed: ParsedModule,
  diagnostics: Diagnostic[],
  nameString: string,
  refusal?: string
): { alias?: readonly string[]; default?: boolean } {
  const routing: { alias?: readonly string[]; default?: boolean } = {};
  const { name } = commandName(nameString);

  // read as the runtime reads the object it registers: the last spelling, with
  // `undefined` not declared -- and where a later spread or computed key may
  // replace that spelling, or a spread may carry a key spelled nowhere, what
  // runs is unknown, so nothing is baked and nothing is refused (SIG-430). A
  // package's export never gets that far, since `keyedPackage()` refuses any
  // spread or computed key in it first
  const unknown = (key: string, consequence: string) =>
    readSpelled(object, key, {
      consequence: refusal ?? consequence,
      diagnostics,
      name,
      parsed,
      severity: refusal ? 'error' : 'warning',
    });
  // an accessor's value is whatever it returns when the runtime reads it, which
  // is not in the source; a method is a function, which neither key takes
  const value = (property: ObjectProperty) =>
    property.kind === 'init' && !property.method ? property.value : undefined;

  const alias = unknown('alias', 'the built app will not answer to the alias the app runs with');
  if (alias) {
    const read = value(alias);
    const list = read ? stringList(read) : undefined;
    if (alias.method || list?.kind === 'wrong') {
      diagnostics.push({
        ...locate(parsed, (read ?? alias).start),
        message: `Expected alias in "${name}" command to be a string or list of strings`,
        severity: 'error',
      });
    } else if (!list || list.kind === 'computed') {
      diagnostics.push({
        ...locate(parsed, (read ?? alias).start),
        message: `the "${name}" command's "alias" is computed rather than a string or a list of strings, so it cannot be read at build time; ${refusal ?? 'the built app will not answer to it'}`,
        severity: refusal ? 'error' : 'warning',
      });
    } else if (list.values.length) {
      // the runtime refuses an alias a route's name could not be, when the command is
      // built at every start, so a build that baked one is an app that cannot run
      // (SIG-688). Asked of the same function, in the runtime's own words
      const refused = list.values
        .map((each) => invalidAlias(each, `in the "${escapeControls(nameString)}" command`))
        .filter((message): message is string => message !== undefined);
      for (const message of refused) {
        diagnostics.push({ ...locate(parsed, (read ?? alias).start), message, severity: 'error' });
      }
      routing.alias = list.values;
    }
  }

  const isDefault = unknown('default', 'the built app will not run it when argv names no command');
  if (isDefault) {
    const read = value(isDefault);
    const flag = read ? literalBoolean(read) : undefined;
    if (flag !== undefined) {
      routing.default = flag;
    } else if (isDefault.method || (read && isWrongType(read, 'boolean'))) {
      diagnostics.push({
        ...locate(parsed, (read ?? isDefault).start),
        // the runtime names the name string as declared, here
        message: defaultTypeMessage(escapeControls(nameString)),
        severity: 'error',
      });
    } else {
      diagnostics.push({
        ...locate(parsed, (read ?? isDefault).start),
        message: `the "${name}" command's "default" is computed rather than a boolean literal, so it cannot be read at build time; ${refusal ?? 'the built app will not run it when argv names no command'}`,
        severity: refusal ? 'error' : 'warning',
      });
    }
  }

  return routing;
}

/**
 * The name string a placeholder is registered under, and the module it is
 * reached by: the two things a build has to read exactly, because a built app
 * that guessed is a different app.
 *
 * **The name.** A `name` the declaration carries **wins over the key** it was
 * written under: the runtime only fills the key in when `name` is `undefined`.
 * So `remove: { name: 'remove, rm', ... }` is registered as `remove, rm` and the
 * key is never consulted -- the extra labels route, `!` hides, `@` makes an
 * alias, and the first bare label is the name, all through the one parser the
 * runtime owns. The build does not parse any of that: the tree is keyed by the
 * name string, as it already is for a key written `'hello, hi'`, and the
 * built app's own `initCommand()` does the reading. Doing it here too would be
 * a second reading of rules that have to stay one.
 *
 * **The module.** `load: () => import('./x.js')` and `path: './x.js'` are the
 * same statement -- the module *is* the command -- said as a function and as a
 * file. One that is spelled and that nothing replaces decides, and the other key
 * beside it needs no say.
 *
 * **Which spelling is the runtime's: the last**, through `placeholderSpelling()`
 * as for the other keys the tree takes off a placeholder (SIG-433, SIG-434), and
 * read off `flatten()`'s list, so `...{ path: './a.js' }` and `['name']: 'a'`
 * are what they spell. Where it is not known, or is known and cannot be read,
 * the build is **refused** rather than warned, as an `alias` is: the name is
 * what argv is matched against and a module the build cannot see is not
 * bundled, so a built app that guessed answers to one name where the app
 * answers to another, or matches the command and prints help with exit 0 --
 * under a build that said it succeeded. Said once per placeholder, for
 * everything a spread or a computed key blocks, and what to write is always the
 * same: the key, literally, after the last of them.
 *
 * What cannot be read: a `name` that is not a string literal, an accessor for
 * either key, a `path` that is not a string literal, and a `load` that is not an
 * arrow returning a literal `import()` -- a block body, a function expression
 * and a method are not. A `path` and a `load` together are the runtime's own
 * refusal, said in its words. A name that is a literal and is not a non-empty
 * string throws from source (`Expected command name to be a non-empty string`),
 * so it fails the build in those words.
 *
 * @param object - The command literal.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @param key - What the command was written under, which is its name when it
 *   declares none.
 * @returns The name string to register it under, and the specifier of its
 *   module where it declares one that can be read.
 */
function placeholderIdentity(
  object: ObjectExpression,
  parsed: ParsedModule,
  diagnostics: Diagnostic[],
  key: string
): { name: string; specifier: string | undefined } {
  const error = (at: { start: number }, message: string) =>
    diagnostics.push({ ...locate(parsed, at.start), message, severity: 'error' });
  const spell = (property: 'load' | 'name' | 'path') => ({
    key: property,
    ...placeholderSpelling(object, property, parsed, true),
  });
  const name = spell('name');
  const path = spell('path');
  const load = spell('load');
  type Spelling = typeof name;
  // spelled, and nothing after it may replace it
  const known = (spelling: Spelling) => spelling.declared !== undefined && !spelling.replaced;
  const isReplaced = (spelling: Spelling) => spelling.declared !== undefined && spelling.replaced;

  // the name first, since every other message calls the command by it: as the
  // facts about the same placeholder do, and not by the key it was written under
  // where it declared another
  const nameBlocked = isReplaced(name) || name.carrier !== undefined;
  const resolved = !nameBlocked && name.declared ? readName(name.declared, key, error) : key;
  const command = commandName(resolved).name;

  // both is the runtime's to refuse, in its words, whatever else is unknown
  const both = path.declared !== undefined && load.declared !== undefined;
  if (both) {
    error(
      load.declared!,
      `Cannot combine "load" with "path" in the "${command}" command: both name the module that is the command, so only one of them can be it`
    );
  }

  // what a spread or a computed key blocks: a module is unknown only where
  // neither key is known to decide
  const moduleBlocked = !both && !known(path) && !known(load);
  const blocked = [...(nameBlocked ? [name] : []), ...(moduleBlocked ? [path, load] : [])].filter(
    (spelling) => isReplaced(spelling) || spelling.carrier
  );
  if (blocked.length) {
    const replaced = blocked.filter(isReplaced);
    const carried = blocked.filter((spelling) => !isReplaced(spelling));
    const quoted = (spellings: readonly Spelling[], word: string) => {
      const list = spellings.map((spelling) => `"${spelling.key}"`);
      return list.length > 1 ? `${list.slice(0, -1).join(', ')} ${word} ${list.at(-1)}` : list[0]!;
    };
    const carriers = carried.map((spelling) => spelling.carrier!);
    const how = carriers.every((carrier) => carrier.type === 'SpreadElement')
      ? 'spreads another object, which may carry'
      : carriers.every((carrier) => carrier.type !== 'SpreadElement')
        ? 'has a computed key, which may be'
        : 'has a spread or a computed key, which may carry';
    const parts = [
      ...(replaced.length
        ? [
            `writes ${quoted(replaced, 'and')} before a spread or a computed key, which may replace ${replaced.length > 1 ? 'them' : 'it'} when the app runs`,
          ]
        : []),
      ...(carried.length ? [`${how} its ${quoted(carried, 'or')}`] : []),
    ];
    const aboutName = blocked.includes(name);
    const aboutModule = blocked.includes(path) || blocked.includes(load);
    const effects =
      aboutName && aboutModule
        ? 'which name the command answers to or which module to bundle for it, and a built app that guessed would route by the wrong name, or match the command and print help rather than run it'
        : aboutName
          ? 'which name the command answers to, and a built app that guessed would route by one name where the app routes by another'
          : 'which module to bundle for the command, and a built app without it matches the command and prints help rather than running it';
    // never both `path` and `load`, which is the one thing refused above
    const fix = [
      ...(aboutName ? ['"name"'] : []),
      ...(aboutModule ? ['one of "path" or "load"'] : []),
    ].join(' and ');
    const at = [...replaced.map((spelling) => spelling.declared!), ...carriers].reduce((a, b) =>
      b.start < a.start ? b : a
    );
    error(
      at,
      `the "${command}" command ${parts.join(', and ')}; the build cannot tell ${effects}; spell ${fix} literally, after the last spread or computed key`
    );
  }

  let specifier: string | undefined;
  const decider =
    !both && !moduleBlocked ? (known(path) ? path : known(load) ? load : undefined) : undefined;
  if (decider) {
    const declared = decider.declared!;
    // an accessor or a method is not a value this reads
    const value = declared.kind === 'init' && !declared.method ? declared.value : undefined;
    specifier = value
      ? decider.key === 'path'
        ? literalString(value)
        : loaderSpecifier(value)
      : undefined;
    if (specifier === undefined) {
      const why = !value
        ? 'an accessor or a method rather than a value'
        : decider.key === 'path'
          ? 'not a string literal'
          : 'not an arrow function returning a literal import()';
      error(
        value ?? declared,
        `the "${command}" command's "${decider.key}" is ${why}, so it cannot be read at build time; the build cannot tell which module to bundle for the command, and a built app without it matches the command and prints help rather than running it. It can only bundle a module whose "path" is a string literal or whose "load" is an arrow returning a literal import(), as in \`path: './build.js'\` or \`load: () => import('./build.js')\``
      );
    }
  }

  return { name: resolved, specifier };
}

/**
 * The name string a placeholder's last, unreplaced `name` is, or the key where
 * it cannot be read, with an error said.
 *
 * @param declared - The `name` property.
 * @param key - What the command was written under.
 * @param error - Reports an error at a node.
 * @returns The name string to register it under.
 */
function readName(
  declared: ObjectProperty,
  key: string,
  error: (at: { start: number }, message: string) => void
): string {
  const command = commandName(key).name;
  // an accessor is whatever it returns when the runtime reads it, which is not
  // in the source. A method is a function, which the runtime refuses for a name
  if (declared.kind !== 'init') {
    error(
      declared,
      `the "${command}" command's "name" is an accessor rather than a string literal, so it cannot be read at build time; ${NAME_UNREADABLE}`
    );
    return key;
  }

  const text = literalString(declared.value);
  if (text) {
    return text;
  }

  if (text === '' || declared.method || isWrongType(declared.value, 'string')) {
    error(
      declared.value,
      `Expected command name to be a non-empty string in the "${escapeControls(key)}" command`
    );
  } else {
    // as `keyedPackage()` refuses a package's computed name: from source it
    // answers to whatever the expression gives, and the built app would answer
    // to the key
    error(
      declared.value,
      `the "${command}" command's "name" is computed rather than a string literal, so it cannot be read at build time; ${NAME_UNREADABLE}`
    );
  }

  return key;
}

/** Why a `name` the build cannot read fails it, and what to write instead. */
const NAME_UNREADABLE =
  'the build cannot tell which name the command answers to, and a built app that guessed would route by one name where the app routes by another; write "name" as a string literal';

/**
 * What a placeholder declares that a built app does not carry.
 *
 * The runtime reads **every** property off a placeholder -- `initCommand()`
 * copies the declaration, and `loadCommand()` merges it over a module that left
 * the key `undefined` -- but the tree a build bakes holds only the properties
 * below. The rest apply from source and silently do not after a build: an
 * inline `run` with no module prints help and exits 0, and `options` and `args`
 * on a placeholder are gone, so `remove --force x` parses differently.
 * Baking them is SIG-320. Until then the divergence is said out loud, once per
 * property, rather than left to be found by running the built app.
 *
 * What is carried is exactly what `readCommand()` reads: `desc` and `hidden`
 * (the lift), `alias`, `default` and `name` (routing), `path` and `load` (the
 * module), and `commands` when it is an object literal.
 *
 * Properties only, of what the literal spells (`flatten()`). A spread or a
 * computed key that is not a literal can carry anything, and is reported here for nothing -- the reads above report it only for the `desc`,
 * `hidden`, `alias`, `default`, `name`, `path`, `load` and `commands` it may carry, the
 * `name`, `path` and `load` as errors.
 *
 * @param object - The command literal.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @param nameString - The name string it is registered under, for the message.
 */
function warnUnbaked(
  object: ObjectExpression,
  parsed: ParsedModule,
  diagnostics: Diagnostic[],
  nameString: string
): void {
  const { name } = commandName(nameString);

  // what the object spells, as the build reads it: an unbaked key inside a
  // literal spread or under a computed key written as a string is as unbaked as
  // one written plainly
  // a spread of a const the resolver gave up on is refused only for the keys that
  // route a placeholder, and not for one it spells after the spread or a const that
  // holds none of them, so what else it holds is said here, at the spread (SIG-731)
  // and a key written to such a const anywhere in the module is one it carries as
  // well (SIG-736): the literal is what it was declared as, and `shared.options = x`
  // is not in it. Asked of the scan `lacksResolver()` answers from, for every key at
  // once; where a use cannot be followed -- `shared[k] = x`, `mutate(shared)` -- the
  // keys are not a list, and the spread is reported by nothing, as every spread the
  // build cannot read is
  const members = flatten(object, sealedResolver(parsed)).flatMap((member) => {
    const operand = member.type === 'SpreadElement' ? unwrapShallow(member.argument) : undefined;
    const literal =
      operand?.type === 'Identifier' ? visibleLiteral(parsed, operand.name) : undefined;
    if (!literal || operand?.type !== 'Identifier') {
      return [{ at: member.start, key: keyOf(member), written: false, value: valueOf(member) }];
    }

    const spelled = flatten(literal).map((property) => ({
      at: member.start,
      key: keyOf(property),
      value: valueOf(property),
      written: false,
    }));
    const held = new Set(spelled.map((each) => each.key));
    const written = [...(writtenKeys(parsed, operand.name) ?? [])]
      .filter((key) => !held.has(key))
      .map((key) => ({ at: member.start, key, value: undefined, written: true }));
    return [...spelled, ...written];
  });

  for (const { at, key, value, written } of members) {
    if (key === undefined || key === '__proto__') {
      continue;
    }

    // `commands` is carried only in the one shape the build reads, and the
    // others are dropped whole -- a path to a directory of them, a list. What was
    // written to a const is not read at all
    if (key === 'commands') {
      if (!written && value !== undefined && objectLiteral(value)) {
        continue;
      }
    } else if (BAKED.has(key)) {
      continue;
    }

    diagnostics.push({
      ...locate(parsed, at),
      message: `the "${name}" command declares "${escapeControls(key)}" in the schema, which \`sigil build\` does not carry into a built app (SIG-320); it applies when the app runs from source and not after a build${advice(key)}`,
      severity: 'warning',
    });
  }
}

/** The key a member of a literal declares, where it declares one statically. */
function keyOf(member: ObjectExpression['properties'][number]): string | undefined {
  return member.type === 'SpreadElement' ? undefined : propertyKey(member);
}

/**
 * What a member of a literal holds, where it is a plain property: an accessor or a
 * method holds nothing the build reads, so `commands` as one is not the object
 * literal the build bakes.
 */
function valueOf(member: ObjectExpression['properties'][number]): Expression | undefined {
  return member.type !== 'SpreadElement' && member.kind === 'init' && !member.method
    ? (member.value as Expression)
    : undefined;
}

/**
 * What to do about a property the build does not carry.
 *
 * Per property, because the right answer differs and one that points at the
 * module is wrong for anything that routes: a name or an alias declared inside
 * a module does not route, since the command has to be matched before the
 * module can be loaded. The properties a module's own declaration does supply
 * are the ones its merge reads when the module leaves them `undefined`, and
 * those are the only ones moving it helps.
 *
 * @param key - The property.
 * @returns A clause to follow the message, led by its own punctuation.
 */
function advice(key: string): string {
  if (key === 'commands') {
    return ', so write it as an object literal of commands, which is the one form the build reads';
  }

  if (MODULE_OWNED.has(key)) {
    return ", so declare it in the command's module instead";
  }

  return '';
}

/**
 * What a command's module can declare for itself, and so what moving it helps.
 *
 * `destructive`, `idempotent` and `readOnly` are here rather than baked
 * (SIG-718): they are read when the command surface is walked, which loads every
 * module, so one declared in the module reaches a built app's `schema` command
 * with no build step at all -- where baking a placeholder's would be a fourth
 * kind of literal for this file to read for a property nothing reads before a
 * load.
 */
const MODULE_OWNED: ReadonlySet<string> = new Set([
  'args',
  'destructive',
  'examples',
  'format',
  'help',
  'hooks',
  'idempotent',
  'options',
  'readOnly',
  'run',
]);

/** The properties of a placeholder that the baked tree holds. */
const BAKED: ReadonlySet<string> = PLACEHOLDER_KEYS;

/**
 * How a placeholder reaches its module, for the warning about what a module
 * declares that cannot route.
 *
 * Never asked about a **package** a key's value is the path of
 * (`commands: { foo: './pkg' }`), whose module's own `name` and `alias` are what
 * route: `keyedPackage()` reads that one before this is reached. An object's
 * `path` property is imported as a file, so a directory there is refused and a
 * package is not one -- its module is checked like any other.
 *
 * `index` is whether the specifier named a directory that resolved to its
 * `index` module. The advice then has to name the directory: a key pointed at
 * the `index` file is one command with none of the directory's subcommands.
 *
 * @param specifier - What the command declared its module by.
 * @param module - The file it resolved to.
 * @param name - Every spelling the placeholder is routed by, as a name string.
 * @param defaulted - Whether the placeholder declares `default: true`.
 * @returns How it is reached, or nothing where there is no module.
 */
function routedByPlaceholder(
  specifier: string | undefined,
  module: string | undefined,
  name: string,
  defaulted = false
): RoutedBy | undefined {
  if (specifier === undefined || module === undefined) {
    return undefined;
  }

  return {
    default: defaulted,
    index:
      /^index\.[cm]?[jt]sx?$/.test(basename(module)) && !/(^|[\\/])index\.[^\\/]*$/.test(specifier),
    name,
  };
}

/**
 * Why a package a schema key points at fails the build when its names cannot be
 * read: from source it answers to them and not to the key, so a built app that
 * could not bake them would route differently from the app it was built from.
 */
const PACKAGE_NAMES =
  'a package a schema key points at answers to the names its own module declares, ' +
  'not to the key, so the build has to read them to route the built app as the app routes from source';

/**
 * Reads a package a schema key's string value points at, which names itself.
 *
 * From source, `commands: { foo: './pkg' }` over a directory with a
 * `package.json` imports the package's module when the schema is built and
 * registers it as `cmd.name ?? packageRouteName(pkg)` -- the key is not one of its spellings
 * (`registerCommandPackage()` in the runtime, and "A package names itself,
 * wherever it was found" in the root `AGENTS.md`). So the build reads the same
 * answer statically: the module's literal `name`, else the manifest's, and the
 * module's `alias` and `default` the way a placeholder's are read, since this
 * module *is* the declaration the runtime registers. A built app then answers to
 * exactly what the source run answers to.
 *
 * Where that cannot be read, the build is refused rather than guessing, which
 * is the rule a walked `commands/` directory that is a package already follows:
 * a computed `name`, `alias` or `default`, an accessor for one, a spread or a
 * computed key that could carry one, a default export that is not a readable
 * literal, and a manifest the runtime would itself refuse (one that does not
 * parse, or names no entry that exists).
 *
 * @param key - What the schema wrote it under, for the messages.
 * @param dir - The directory the key's value resolves to.
 * @param context - The schema's module, for positions, where to report, and the
 *   node to point at.
 * @returns The command, or `undefined` when the directory is not a package.
 */
function keyedPackage(
  key: string,
  dir: string,
  context: { at: { start: number }; diagnostics: Diagnostic[]; parsed: ParsedModule }
): ResolvedCommand | undefined {
  const { at, diagnostics, parsed } = context;
  const refused: ResolvedCommand = { commands: [], kind: 'inline', name: key };

  let pkg;
  try {
    pkg = readPackage(dir);
  } catch (err) {
    // the runtime raises the same error when the schema is built
    diagnostics.push({
      ...locate(parsed, at.start),
      message: `the "${escapeControls(key)}" command is a package the app cannot load: ${escapeControls(errorMessage(err))}`,
      severity: 'error',
    });
    return refused;
  }

  if (!pkg) {
    return undefined;
  }

  const entry = parseModule(pkg.entryFile, readFileSync(pkg.entryFile, 'utf-8'));
  const read = factsOf(entry);
  const description = typeof pkg.description === 'string' ? pkg.description : undefined;

  // a manifest's description is what help shows when the module says nothing
  // readable, so what the lift could not read is said only where there is none
  for (const diagnostic of read.diagnostics) {
    if (description === undefined || diagnostic.severity === 'error') {
      diagnostics.push(diagnostic);
    }
  }

  const { object } = read;
  if (!object) {
    diagnostics.push({
      ...locate(parsed, at.start),
      message: `the "${escapeControls(key)}" command is a package whose default export cannot be read at build time; ${PACKAGE_NAMES}`,
      severity: 'error',
    });
    return refused;
  }

  // what could carry a name nothing here can see
  const opaque = object.properties.find(
    (property) =>
      property.type === 'SpreadElement' ||
      property.computed ||
      (ROUTED.has(propertyKey(property) ?? '') && (property.kind !== 'init' || property.method))
  );
  if (opaque) {
    const what =
      opaque.type === 'SpreadElement'
        ? 'spreads another object, which may carry a "name", "alias" or "default" this cannot read'
        : opaque.computed
          ? 'has a computed key, which may be a "name", "alias" or "default" this cannot read'
          : `declares "${escapeControls(propertyKey(opaque))}" as an accessor or a method rather than a value, so it cannot be read at build time`;
    diagnostics.push({
      ...locate(entry, opaque.start),
      message: `the "${escapeControls(key)}" command is a package whose default export ${what}; ${PACKAGE_NAMES}`,
      severity: 'error',
    });
    return refused;
  }

  const before = diagnostics.length;
  const name = packageName(object, entry, diagnostics, key, pkg, dir);
  const routing = placeholderRouting(object, entry, diagnostics, key, PACKAGE_NAMES);

  if (name === undefined || diagnostics.slice(before).some((d) => d.severity === 'error')) {
    return refused;
  }

  return {
    ...routing,
    ...read.facts,
    commands: [],
    desc: read.facts.desc ?? description,
    kind: 'inline',
    module: pkg.entryFile,
    name,
  };
}

/** What a package's module declares that decides how it is reached. */
const ROUTED: ReadonlySet<string> = new Set(['alias', 'default', 'name']);

/**
 * The name string a package a schema key points at is registered under.
 *
 * The module's own `name` wins, as the runtime reads it, and an absent one --
 * `undefined` or `null`, both of which `??` passes over -- falls to the
 * manifest's, with its scope off and refused by `packageRouteName()`.
 *
 * @param object - The module's command literal.
 * @param entry - The module, for positions.
 * @param diagnostics - Where to report.
 * @param key - What the schema wrote it under, for the messages.
 * @param pkg - What its `package.json` says, whose name is the fallback.
 * @param dir - The package's directory.
 * @returns The name string, or `undefined` with an error said.
 */
function packageName(
  object: ObjectExpression,
  entry: ParsedModule,
  diagnostics: Diagnostic[],
  key: string,
  pkg: PackageRoute,
  dir: string
): string | undefined {
  const declared = plainProperty(object, 'name');
  if (declared && !isUndefined(declared.value) && literalType(declared.value) !== 'null') {
    const text = literalString(declared.value);
    if (text) {
      return text;
    }

    diagnostics.push({
      ...locate(entry, declared.value.start),
      message:
        text === '' || isWrongType(declared.value, 'string')
          ? `Expected command name to be a non-empty string in the "${escapeControls(key)}" command`
          : `the "${escapeControls(key)}" command's "name" is computed rather than a string literal, so it cannot be read at build time; ${PACKAGE_NAMES}`,
      severity: 'error',
    });
    return undefined;
  }

  if (pkg.name !== undefined) {
    // a name the file system gave, so the runtime's rule for it and not a name
    // string's: scope off, and refused where the runtime refuses it -- in its
    // words, an empty one and a number included, which is why this does not
    // pre-filter on what it thinks a name is. The directory is named the way
    // every other diagnostic names a path
    try {
      return packageRouteName(pkg, displayPath(dir));
    } catch (err) {
      diagnostics.push({
        file: join(dir, 'package.json'),
        message: `the "${escapeControls(key)}" command is a package the app cannot name: ${escapeControls(errorMessage(err))}`,
        severity: 'error',
      });
      return undefined;
    }
  }

  diagnostics.push({
    file: join(dir, 'package.json'),
    message: `Expected command name to be a non-empty string in the "${escapeControls(key)}" command, which is a package whose module and package.json both leave it unnamed`,
    severity: 'error',
  });
  return undefined;
}

/**
 * What a command's module says about itself, when there is one to read.
 *
 * @param module - The resolved path, if it resolved.
 * @param specifier - What was written, for the message when it did not.
 * @param name - The command, for the message.
 * @param parsed - The entry, for positions.
 * @param diagnostics - Where to report.
 * @param at_ - The node to point at.
 * @param described - Whether the placeholder already said what help shows.
 * @param routedBy - How the placeholder reaches the module, which is what a
 *   name, an alias or a default inside it is compared with; absent where the
 *   module names itself, which is a package. See `routedByPlaceholder()`.
 * @returns Its facts and its module.
 */
function moduleFacts(
  module: string | undefined,
  specifier: string | undefined,
  name: string,
  parsed: ParsedModule,
  diagnostics: Diagnostic[],
  at_: { start: number },
  described: boolean,
  routedBy: RoutedBy | undefined
): CommandFacts & { module?: string } {
  if (!module) {
    if (specifier) {
      diagnostics.push({
        ...locate(parsed, at_.start),
        message: `the "${escapeControls(name)}" command imports "${escapeControls(specifier)}", which could not be resolved to a file`,
        severity: 'error',
      });
    }
    return {};
  }

  // the module the schema points at is a command module like any other, so it
  // is read the same way -- which is what makes `check` check the commands
  // rather than only the tree above them
  const read = factsOf(parseModule(module, readFileSync(module, 'utf-8')), routedBy);

  // an `error` is the module being unusable rather than merely unreadable -- no
  // default export at all -- and that is worth saying however well the
  // placeholder describes it
  for (const diagnostic of read.diagnostics) {
    if (!described || diagnostic.severity === 'error') {
      diagnostics.push(diagnostic);
    }
  }

  // never silenced by a description: those answer what help shows before the
  // module loads, and these are about a declaration that routes nothing
  diagnostics.push(...read.routing);

  return { ...read.facts, module };
}

/**
 * The single executable a manifest's `bin` names.
 *
 * A string is the shorthand for "named after the package", which says nothing
 * this does not already know. An object with one key is the useful case and the
 * common one. More than one key is a package publishing several executables,
 * which a single-bundle build has no answer for -- so it says nothing and lets
 * `--name` be asked.
 *
 * @param bin - Whatever the manifest put there.
 * @returns The name, or `undefined`.
 */
function binName(bin: unknown): string | undefined {
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) {
    return undefined;
  }

  const names = Object.keys(bin);
  return names.length === 1 ? names[0] : undefined;
}
