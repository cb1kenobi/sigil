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
 * read off the entry's source, because running it would run the app.
 */

import { type Diagnostic, displayPath } from './diagnostic.ts';
import { type CommandFacts, factsOf, type RoutedBy } from './extract.ts';
import { translatedKey } from './i18n.ts';
import {
  isUndefined,
  isWrongType,
  lastReplacing,
  literalBoolean,
  literalString,
  literalType,
  loaderSpecifier,
  objectLiteral,
  outermostDeclaring,
  outermostWith,
  plainProperty,
  propertyKey,
  stringList,
  unspelledCarrier,
  unwrapShallow,
} from './literals.ts';
import { locate, parseModule, type ParsedModule } from './parse-module.ts';
import type { ResolvedCommand } from './tree.ts';
import { physicalPath } from '@ttylabs/sigil/config';
import { errorMessage } from '@ttylabs/sigil/error-handler';
import {
  defaultTypeMessage,
  descReturnMessage,
  descTypeMessage,
  hiddenTypeMessage,
  parseName,
  readPackage,
} from '@ttylabs/sigil/routes';
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
   * What it calls its version, baked into the generated entry.
   *
   * A bundle has no `package.json` beside it, so an app that reads its own at
   * run time is reading a path that points wherever the bundle was written.
   */
  readonly version?: string;
}

/** An app, found. */
export interface DiscoveredApp {
  /** The module its schema was read from. */
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
      `${manifest.path} does not depend on ${RUNTIME}, so there is no sigil app here to check`
    );
  }

  const entry = options.entry
    ? resolveEntry(root, options.entry)
    : findEntry(root, readManifestEntries(manifest.path));

  if (!entry) {
    throw new Error(
      `No entry module found in ${root}. Looked for ${ENTRY_NAMES.map((name) => `${name}.*`).join(', ')} and what the manifest names; pass --entry to name one`
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
    throw new Error(`No package.json in ${root}; sigil runs from an app's root`);
  }

  let json;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`Failed to parse ${path}: ${(e as Error).message}`);
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
    throw new Error(`Entry module not found: ${displayPath(path)}`);
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
  const parsed = parseModule(app.entry, readFileSync(app.entry, 'utf-8'));
  const diagnostics: Diagnostic[] = [];

  const schemas = outermostWith(parsed.program as never, 'commands');

  if (!schemas.length) {
    // a `run` with no `commands` beside it is a single-command app, where
    // `main()` dispatches the root. `outermostDeclaring()` rather than
    // `outermostWith()`, because a `run` is written as a **method** far more
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

  const declared = plainProperty(schemas[0]!, 'commands')!;
  const entryDir = dirname(app.entry);

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
    if (!isAbsolute(asPath) && !plainProperty(schemas[0]!, 'baseDir')) {
      diagnostics.push({
        ...locate(parsed, declared.value.start),
        message:
          `"commands" is a relative path and the schema sets no "baseDir", so this resolves it ` +
          `against ${displayPath(entryDir)} while the runtime resolves it against the working ` +
          `directory. Add \`baseDir: import.meta.dirname\` to the schema.`,
        severity: 'warning',
      });
    }

    return {
      commands: { dir: resolve(entryDir, asPath), kind: 'directory' },
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
    commands: { commands: readInline(written, entryDir, parsed, diagnostics), kind: 'inline' },
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
      message: `the "${name}" command is computed rather than a literal, so nothing about it can be read at build time`,
      severity: 'warning',
    });
    return { commands: [], kind: 'inline', name };
  }

  const specifier = moduleSpecifier(object);
  const nested = plainProperty(object, 'commands');
  const named = placeholderName(object, parsed, diagnostics, name);
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
  const spelled = (key: string) => placeholderSpelling(object, key);
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
        message: hiddenTypeMessage(nameString),
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
 * One function for the four keys the baked tree takes off a placeholder, so
 * what help lists and what routes cannot come to disagree about which spelling
 * runs (SIG-430).
 *
 * @param object - The command literal.
 * @param key - The key in question.
 * @returns The spelling that runs, `undefined` where the key is not declared;
 *   whether a later property may replace it; and a spread that may carry a key
 *   spelled nowhere.
 */
function placeholderSpelling(
  object: ObjectExpression,
  key: string
): { carrier: SpreadElement | undefined; declared: ObjectProperty | undefined; replaced: boolean } {
  let found: ObjectProperty | undefined;
  for (const property of object.properties) {
    if (property.type !== 'SpreadElement' && propertyKey(property) === key) {
      found = property;
    }
  }

  const replaced =
    found !== undefined && object.properties.indexOf(found) < lastReplacing(object, key);

  // `undefined` is what the runtime reads as not declared
  const declared =
    found?.kind === 'init' && !found.method && isUndefined(found.value) && !replaced
      ? undefined
      : found;
  return { carrier: unspelledCarrier(object, key), declared, replaced };
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
    return { hidden, name };
  } catch {
    return { hidden: false, name: nameString };
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
  const unknown = (key: string, consequence: string) => {
    const { carrier, declared, replaced } = placeholderSpelling(object, key);
    if (declared && replaced) {
      diagnostics.push({
        ...locate(parsed, declared.start),
        message: replacedMessage(name, key, refusal ?? consequence),
        severity: refusal ? 'error' : 'warning',
      });
    } else if (carrier) {
      diagnostics.push({
        ...locate(parsed, carrier.start),
        message: carriedMessage(name, key, refusal ?? consequence),
        severity: refusal ? 'error' : 'warning',
      });
    } else {
      return declared;
    }

    return undefined;
  };
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
        message: defaultTypeMessage(nameString),
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
 * The name string a placeholder is registered under.
 *
 * A `name` the declaration carries **wins over the key** it was written under:
 * the runtime only fills the key in when `name` is `undefined`. So
 * `remove: { name: 'remove, rm', ... }` is registered as `remove, rm` and the
 * key is never consulted -- the extra labels route, `!` hides, `@` makes an
 * alias, and the first bare label is the name, all through the one parser the
 * runtime owns. The build does not parse any of that: the tree is keyed by the
 * name string, as it already is for a key written `'hello, hi'`, and the
 * built app's own `initCommand()` does the reading. Doing it here too would be
 * a second reading of rules that have to stay one.
 *
 * A literal that is not a non-empty string throws from source (`Expected
 * command name to be a non-empty string`), so it fails the build in those
 * words; a computed one is a warning and leaves the key as the name.
 *
 * @param object - The command literal.
 * @param parsed - The module, for positions.
 * @param diagnostics - Where to report.
 * @param key - What the command was written under, which is its name when it
 *   declares none.
 * @returns The name string to register it under.
 */
function placeholderName(
  object: ObjectExpression,
  parsed: ParsedModule,
  diagnostics: Diagnostic[],
  key: string
): string {
  const declared = plainProperty(object, 'name');
  if (!declared || isUndefined(declared.value)) {
    return key;
  }

  const text = literalString(declared.value);
  if (text) {
    return text;
  }

  if (text === '' || isWrongType(declared.value, 'string')) {
    diagnostics.push({
      ...locate(parsed, declared.value.start),
      message: `Expected command name to be a non-empty string in the "${key}" command`,
      severity: 'error',
    });
  } else {
    diagnostics.push({
      ...locate(parsed, declared.value.start),
      message: `the "${key}" command's "name" is computed rather than a string literal, so it cannot be read at build time; the built app will name it "${key}", and any other spelling it declares will not answer`,
      severity: 'warning',
    });
  }

  return key;
}

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
 * Properties only. A spread or a computed key can carry anything, and is
 * reported here for nothing -- the reads above report it only for the `desc`,
 * `hidden`, `alias` and `default` it may carry.
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

  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      continue;
    }

    const key = propertyKey(property);
    if (key === undefined || key === '__proto__') {
      continue;
    }

    // `commands` is carried only in the one shape the build reads, and the
    // others are dropped whole -- a path to a directory of them, a list
    if (key === 'commands') {
      if (property.kind === 'init' && !property.method && objectLiteral(property.value)) {
        continue;
      }
    } else if (BAKED.has(key)) {
      continue;
    }

    diagnostics.push({
      ...locate(parsed, property.start),
      message: `the "${name}" command declares "${key}" in the schema, which \`sigil build\` does not carry into a built app (SIG-320); it applies when the app runs from source and not after a build${advice(key)}`,
      severity: 'warning',
    });
  }
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

/** What a command's module can declare for itself, and so what moving it helps. */
const MODULE_OWNED: ReadonlySet<string> = new Set([
  'args',
  'examples',
  'format',
  'help',
  'hooks',
  'options',
  'run',
]);

/** The properties of a placeholder that the baked tree holds. */
const BAKED: ReadonlySet<string> = new Set([
  'alias',
  'default',
  'desc',
  'hidden',
  'load',
  'name',
  'path',
]);

/**
 * The specifier a command declares its module by, whichever way it declares it.
 *
 * `load: () => import('./x.js')` and `path: './x.js'` are the same statement --
 * the module *is* the command -- said as a function and as a file.
 *
 * @param object - The command literal.
 * @returns The specifier, or `undefined`.
 */
function moduleSpecifier(object: ObjectExpression): string | undefined {
  const path = plainProperty(object, 'path');
  if (path) {
    return literalString(path.value);
  }

  const load = plainProperty(object, 'load');
  if (!load) {
    return undefined;
  }

  // the one shape a bundler can see and this can read: an arrow whose body is
  // a dynamic import of a literal. Shared with the catalog check, which reads
  // `Schema.locales` the same way
  return loaderSpecifier(load.value);
}

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
 * registers it as `cmd.name ?? pkg.name` -- the key is not one of its spellings
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
      message: `the "${key}" command is a package the app cannot load: ${errorMessage(err)}`,
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
      message: `the "${key}" command is a package whose default export cannot be read at build time; ${PACKAGE_NAMES}`,
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
          : `declares "${propertyKey(opaque)}" as an accessor or a method rather than a value, so it cannot be read at build time`;
    diagnostics.push({
      ...locate(entry, opaque.start),
      message: `the "${key}" command is a package whose default export ${what}; ${PACKAGE_NAMES}`,
      severity: 'error',
    });
    return refused;
  }

  const before = diagnostics.length;
  const name = packageName(object, entry, diagnostics, key, pkg.name, join(dir, 'package.json'));
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
 * `cmd.name ?? pkg.name`, as the runtime reads it: the module's own `name`
 * wins, and an absent one -- `undefined` or `null`, both of which `??` passes
 * over -- falls to the manifest's.
 *
 * @param object - The module's command literal.
 * @param entry - The module, for positions.
 * @param diagnostics - Where to report.
 * @param key - What the schema wrote it under, for the messages.
 * @param manifestName - What its `package.json` calls it.
 * @param manifest - Where that is, for the message when neither names it.
 * @returns The name string, or `undefined` with an error said.
 */
function packageName(
  object: ObjectExpression,
  entry: ParsedModule,
  diagnostics: Diagnostic[],
  key: string,
  manifestName: unknown,
  manifest: string
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
          ? `Expected command name to be a non-empty string in the "${key}" command`
          : `the "${key}" command's "name" is computed rather than a string literal, so it cannot be read at build time; ${PACKAGE_NAMES}`,
      severity: 'error',
    });
    return undefined;
  }

  if (typeof manifestName === 'string' && manifestName !== '') {
    return manifestName;
  }

  diagnostics.push({
    file: manifest,
    message: `Expected command name to be a non-empty string in the "${key}" command, which is a package whose module and package.json both leave it unnamed`,
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
        message: `the "${name}" command imports "${specifier}", which could not be resolved to a file`,
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
