/**
 * What the build tells an app's update check to look at.
 *
 * `check()` is a function an app calls wherever it likes, so unlike the
 * version and the default locale there is no schema in its hand to bake this
 * into -- it reaches the runtime as a `define`, which is the one thing that
 * can replace a value inside a dependency the bundle inlined.
 *
 * Two facts go across and the second is the one the ticket is about. **What**
 * to check comes from `sigil.json`. **Whether there is a runtime to spawn**
 * comes from which command is running: `sigil build` produces an app that
 * still needs node or bun installed, and the default check spawns one so that
 * it outlives the CLI; `sigil package` produces an app that *is* its runtime,
 * where `process.execPath` is the app's own binary and spawning it would
 * re-execute the CLI. The build knows which it is making, so nothing has to
 * be sniffed at run time.
 */

import type { SigilConfig, UpdateCheckConfig } from '../config.ts';
import { quote } from '../template/emit.ts';
import { importBindings, importCall, type ImportBindings } from './bindings.ts';
import type { Diagnostic } from './diagnostic.ts';
import {
  flatten,
  lastReplacing,
  literalBoolean,
  literalString,
  literalType,
  objectLiteral,
  outermostDeclaring,
  plainProperty,
  propertyKey,
  stringList,
  unwrapShallow,
  type Member,
} from './literals.ts';
import { locate, parseModule } from './parse-module.ts';
import { schemaModule } from './schema-module.ts';
import {
  checkedChecker,
  customChecker,
  githubChecker,
  npmChecker,
  type BakedUpdateConfig,
  type UpdateChecker,
} from '@ttylabs/sigil/updates';
import { readFileSync } from 'node:fs';
import type { Expression, ObjectExpression, ObjectProperty } from 'oxc-parser';

/** The identifier `check()` reads the baked config out of. */
export const UPDATE_CHECK_DEFINE = '__SIGIL_UPDATE_CHECK__';

/** What `bakedUpdateCheck()` is given. */
export interface BakedUpdateCheckOptions {
  /** Whether what is being produced is a single-file executable. */
  readonly compiled: boolean;
  /** The app's `sigil.json`. */
  readonly config: SigilConfig;
  /** The app's own package name, which an npm check defaults to. */
  readonly packageName?: string;
}

/**
 * Turns `sigil.json`'s `updateCheck` into what the runtime reads.
 *
 * @param options - The config, the app's name, and which command is running.
 * @returns The baked config.
 * @throws If an npm check has no package name to ask about.
 */
export function bakedUpdateCheck(options: BakedUpdateCheckOptions): BakedUpdateConfig {
  const { compiled, config, packageName } = options;
  const declared = config.updateCheck;

  // the manifest's name goes across whether or not anything was declared: an
  // automatic check has the program's name in hand and not the package's, and
  // `@ttylabs/cli` publishes `sigil`. The runtime cannot read a `package.json`
  // of its own -- a bundle has no manifest beside it
  const named = packageName === undefined ? {} : { packageName };

  if (!declared) {
    // absent rather than `null`: an app that declared nothing falls through
    // to `check()`'s own default, which is npm where there is a runtime and
    // no check at all in a binary. `null` is the app saying it checks
    // nothing, which is a different answer and must not be invented here
    return { compiled, ...named };
  }

  return { checker: checkerFor(declared, packageName), compiled, ...named };
}

/**
 * What each builder calls the option a `sigil.json` key becomes, and the key.
 *
 * A builder's refusal is written for code -- `registryURL` is `npmChecker()`'s
 * option and `package name` is its message's noun -- and an author who wrote
 * `updateCheck.registry` in a file is told about a word they never typed
 * (SIG-547). `checkerFor()` is the one place a declaration is renamed on its way
 * in, so it is the one place this table is needed, and a test per row pins each
 * against the message the builder writes.
 */
const DECLARED_KEYS: readonly (readonly [noun: string, key: string])[] = [
  ['registryURL', 'updateCheck.registry'],
  ['package name', 'updateCheck.package'],
  ['dist tag', 'updateCheck.distTag'],
  ['repo', 'updateCheck.repo'],
  ['url', 'updateCheck.url'],
  ['path', 'updateCheck.path'],
  ['prefix', 'updateCheck.prefix'],
];

/**
 * Builds a checker, and re-words a refusal in the terms of the file.
 *
 * Re-worded here rather than by a label the published builders take: a label
 * would be an option on three public functions that only this caller wants,
 * where the table above is one place, private, and held honest by tests that
 * read every refusal back. The message keeps the builder's own sentence, so
 * what was wrong is said once and by the one definition of the rule.
 *
 * @param build - Makes the checker.
 * @returns What it made.
 * @throws What the builder threw, naming the `sigil.json` key.
 */
function asDeclared<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (err instanceof Error) {
      for (const [noun, key] of DECLARED_KEYS) {
        const prefix = `Update check ${noun} `;
        if (err.message.startsWith(prefix)) {
          err.message = `Update check "${key}" ${err.message.slice(prefix.length)}`;
          break;
        }
      }
    }
    throw err;
  }
}

/**
 * The `define` entry the bundler is given.
 *
 * @param baked - What the build decided.
 * @returns The define map.
 */
export function updateCheckDefine(baked: BakedUpdateConfig): Record<string, string> {
  // `define` replaces an identifier with a snippet of *source*, so the value
  // is a JSON string literal rather than the JSON itself -- stringified twice
  // on purpose. Unbuilt, nothing replaces it and `check()` reads a free
  // identifier through `typeof`, which is the one operator that is legal on
  // a name nothing declared. The outer quoting is `quote()`, the one helper for
  // a string printed as source, so a separator in a URL or a repo name is
  // escaped there as it is everywhere else
  return { [UPDATE_CHECK_DEFINE]: quote(JSON.stringify(baked)) };
}

/**
 * One declared check, as the runtime's own builders make it.
 *
 * Built with `npmChecker()` and `githubChecker()` rather than with object
 * literals here, so that a URL this bakes and a URL an app builds in its own
 * source are the same URL -- the rule `readRoutes()` already records for the
 * two route walks, met in a smaller place.
 *
 * @param declared - The declared section, already validated by the reader.
 * @param packageName - The app's own name.
 * @returns The checker, or `null` where the app declared it checks nothing.
 * @throws If an npm check has no package name to ask about.
 */
function checkerFor(
  declared: UpdateCheckConfig,
  packageName: string | undefined
): UpdateChecker | null {
  switch (declared.type) {
    case 'none':
      return null;

    case 'github':
      return asDeclared(() =>
        githubChecker({
          ...(declared.prefix !== undefined && { prefix: declared.prefix }),
          repo: declared.repo!,
        })
      );

    case 'custom':
      return asDeclared(() =>
        customChecker({
          path: declared.path!,
          ...(declared.prefix !== undefined && { prefix: declared.prefix }),
          url: declared.url!,
        })
      );

    default: {
      const name = declared.package ?? packageName;
      if (!name) {
        throw new Error(
          'An "npm" update check needs a package name: set "updateCheck.package" in sigil.json, ' +
            'or give the app\'s package.json a "name".'
        );
      }
      return asDeclared(() =>
        npmChecker({
          ...(declared.distTag !== undefined && { distTag: declared.distTag }),
          packageName: name,
          ...(declared.registry !== undefined && { registryURL: declared.registry }),
        })
      );
    }
  }
}

/** The subpath an app imports to check for updates. */
export const UPDATE_CHECK_SPECIFIER = '@ttylabs/sigil/updates';

/** What a schema's `updateCheck` says, read off its source. */
export type SchemaUpdateCheck =
  /** It switches the check on and says nothing about where to look. */
  | 'asks'
  /** It switches the check on and names the checker itself. */
  | 'names'
  /**
   * It names a checker through a call of the app's own, `wrap({ checker })`, which
   * the build cannot read the result of -- so what it names is not confirmed.
   */
  | 'wrapped';

/**
 * Whether a module reaches `check()` from `@ttylabs/sigil/updates`, as opposed to
 * a builder or a type (SIG-609).
 *
 * The bundler's watch sees the specifier and not what was imported from it, so an
 * app that writes `updateCheck: githubChecker({ repo })` and an app that also calls
 * `check()` by hand look the same to it -- and only the second has a call that
 * reads `sigil.json` instead of the schema. This is the question asked of one
 * module's own imports and exports: a named import of `check`, a namespace import,
 * and a re-export of `check`, of everything (`export *`) or of the namespace.
 *
 * It is asked of the **import**, not of a use site, which is why it does not go
 * through `importBindings()`: that gives up a name the module binds again anywhere,
 * and `check` is as generic a name as there is -- a module with
 * `items.filter((check) => ...)` beside the import would have the warning turned
 * off for it, which is the ticket's own symptom. Here a wrong yes costs one note and
 * a wrong no costs the hole, so the answer is "was it imported". What stays silent:
 * a dynamic `import()` and a `require()` have no name to read, and a module that
 * does not read or parse is not one this can say anything about. A namespace import
 * counts without asking which member is used, so an app that only calls
 * `ns.githubChecker()` is told about a call it does not make; it costs one line and a
 * `sigil.json` entry, the price `wrappedCheckWarning()` already charges.
 *
 * @param file - The module that imports `@ttylabs/sigil/updates`.
 * @returns Whether it reaches `check()`.
 */
export function importsCheckFunction(file: string): boolean {
  let parsed: ReturnType<typeof parseModule>;
  try {
    parsed = parseModule(file, readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }

  const imported = parsed.module.staticImports.some(
    (declaration) =>
      declaration.moduleRequest.value === UPDATE_CHECK_SPECIFIER &&
      declaration.entries.some(
        (entry) =>
          !entry.isType &&
          (entry.importName.kind === 'NamespaceObject' ||
            (entry.importName.kind === 'Name' && entry.importName.name === 'check'))
      )
  );
  if (imported) {
    return true;
  }

  return parsed.module.staticExports.some((declaration) =>
    declaration.entries.some(
      (entry) =>
        !entry.isType &&
        entry.moduleRequest?.value === UPDATE_CHECK_SPECIFIER &&
        (entry.importName.kind === 'All' ||
          entry.importName.kind === 'AllButDefault' ||
          (entry.importName.kind === 'Name' && entry.importName.name === 'check'))
    )
  );
}

/** The checker builders an app may call in its schema. */
const CHECKER_BUILDERS = ['githubChecker', 'npmChecker'] as const;

/**
 * Whether a schema's `updateCheck` names its own checker.
 *
 * Three spellings do, and each is the app having said where to look -- except
 * that one handed over by a call of the app's own, `wrap({ checker })`, is
 * `'wrapped'` rather than `'names'`: a
 * `checker` inside the options, a checker written bare -- the shorthand, as a
 * call to one of the builders or as a literal with a `type` and a `url` -- and
 * nothing else. The builder is asked as a **binding** rather than a spelling,
 * for the reason `findTemplates()` is: an alias is the same function and a
 * local called `githubChecker` is not.
 *
 * The call is asked first, and the order is load-bearing:
 * `objectLiteral()` looks through a call with one object-literal argument, so
 * `githubChecker({ repo })` would otherwise be read as the options `{ repo }`.
 *
 * What it answers is **how sure** the build is. `'names'` is a builder call or a
 * literal, which is the app saying where to look; `'wrapped'` is a literal that
 * only a call of the app's own hands over, which that call may not (SIG-593).
 */
function namesChecker(
  value: Expression,
  builders: readonly ImportBindings[]
): 'names' | 'wrapped' | false {
  // `importCall()` rather than a `CallExpression` check, so that
  // `githubChecker?.({ ... })` is the call it is: oxc puts a `ChainExpression`
  // around it, which is not a wrapper `unwrapShallow()` takes off
  if (importCall(value, builders)) {
    return 'names';
  }

  const expression = unwrapShallow(value);

  // `optional`: `wrap?.({ checker })` is read as `wrap({ checker })` is, which
  // is `'wrapped'` and not `'names'` (SIG-591, SIG-593). When `wrap` is nullish the schema has no `updateCheck` at all, so
  // reading it as naming costs a declaration the build did not demand, and a
  // reader that errs towards not refusing may afford that. The shared reader does
  // not do it by default because the module lift and the command tree could not
  // afford it: they would bake a description of a command that is not there.
  const options = objectLiteral(expression, { optional: true });
  if (!options) {
    return false;
  }

  if (
    plainProperty(options, 'checker') === undefined &&
    (plainProperty(options, 'type') === undefined || plainProperty(options, 'url') === undefined)
  ) {
    return false;
  }

  // the literal itself is the app saying where to look. One reached **through a
  // call** is the call's to return, and the build does not know what it returns
  // (SIG-593): `wrap?.({ checker })` is `undefined` when `wrap` is nullish
  return options === expression ? 'names' : 'wrapped';
}

/**
 * What a schema says about the automatic update check, read off its source.
 *
 * `updateCheck` on the schema is the app asking for a check without importing
 * `@ttylabs/sigil/updates`, so the bundler's watch on that specifier never sees
 * it -- and a binary that asks for one and declares nothing for it to look at
 * is the failure this refuses. The schema is read rather than run, for the
 * reason every pass here reads: running the entry runs the app.
 *
 * It errs towards **not** refusing, because a false refusal stops a correct
 * build and a missed one costs a notice that never appears. Three things are
 * therefore read as "nothing to say": a key spelled in a way this cannot read
 * (computed, an accessor), a value that is literally `false`, and a value that
 * names its own checker -- which beats whatever `sigil.json` declares, so the
 * app has already said where to look.
 *
 * @param entry - The app's entry module. The schema is read from the module that holds it,
 *   which is this one unless it imports its schema (`schemaModule()`).
 * @returns `'asks'` when some schema asks for a check that nothing says where
 *   to run, `'wrapped'` when one says where through a call of the app's own,
 *   `'names'` when every schema that asks says where itself, and `undefined`
 *   when none asks.
 */
export function readSchemaUpdateCheck(entry: string): SchemaUpdateCheck | undefined {
  const file = schemaModule(entry);
  const parsed = parseModule(file, readFileSync(file, 'utf-8'));
  const builders = CHECKER_BUILDERS.map((name) =>
    importBindings(parsed, UPDATE_CHECK_SPECIFIER, name)
  );
  let result: SchemaUpdateCheck | undefined;

  for (const schema of outermostDeclaring(parsed.program as never, 'updateCheck')) {
    const property = plainProperty(schema, 'updateCheck');
    if (!property) {
      continue;
    }

    const value = property.value as Expression;
    if (literalBoolean(value as never) === false) {
      continue;
    }

    const names = namesChecker(value, builders);
    if (names) {
      // the weaker answer wins: one schema that names through a call is a schema
      // the build has not confirmed
      result = names === 'wrapped' ? 'wrapped' : (result ?? 'names');
      continue;
    }

    return 'asks';
  }

  return result;
}

/**
 * Whether the schema asks for a check that nothing says where to run.
 *
 * @param entry - The app's entry module. The schema is read from the module that holds it,
 *   which is this one unless it imports its schema (`schemaModule()`).
 * @returns Whether `readSchemaUpdateCheck()` answers `'asks'`.
 */
export function schemaWantsUpdateCheck(entry: string): boolean {
  return readSchemaUpdateCheck(entry) === 'asks';
}

/** Why a binary is being asked to declare what its update check looks at. */
export type UpdateCheckUse = 'import' | 'schema';

/**
 * Refuses a binary whose update check could never report anything.
 *
 * A compiled app has no runtime to spawn and no npm default -- npm is the
 * right answer for something somebody installed and a guess for a binary
 * somebody downloaded, which may well not be published anywhere. So an app
 * that asks for the check and declares nothing for it to look at ships a
 * feature that silently does nothing, which is the failure this whole area
 * keeps being about: a build reporting success over something that cannot
 * work.
 *
 * ## Why this one is not a pre-flight
 *
 * `assertCleanable()` is refused before a runtime is fetched because it needs
 * only paths `inspect()` already has and a few stats of them -- it can be asked
 * at any time, so it is asked first.
 * The import half of this cannot: whether the check is in the app is a
 * question about the module graph, and the graph does not exist until the
 * bundle is built. So it is asked at the first moment there is an answer,
 * which still comes before `compileAll()` -- the download is a cache fill and
 * the compile is the expensive, signing, binary-writing half.
 *
 * Guessing earlier was the alternative and is refused: a scan of the app's
 * source for the specifier reports a mention in a comment as a use and misses
 * one re-exported through a barrel, and a **false** refusal here stops a build
 * that is correct. This file already records what a warning that fires on
 * correct code teaches people to do, and an error is the louder version of it.
 *
 * @param config - The app's `sigil.json`.
 * @param use - How the app asked: by importing the check, or by switching it on
 *   in its schema. `false` when it did not ask.
 * @throws If it asked and the config says nothing.
 */
export function assertUpdateCheckDeclared(
  config: SigilConfig,
  use: boolean | UpdateCheckUse
): void {
  if (!use || config.updateCheck) {
    return;
  }

  const how =
    use === 'schema'
      ? 'This app sets updateCheck in its schema'
      : `This app imports ${UPDATE_CHECK_SPECIFIER}`;

  throw new Error(
    `${how}, and a binary has no default to fall back on.\n` +
      'Declare "updateCheck" in sigil.json -- "npm", "github" or "custom" for where to look, ' +
      'or "none" to say it checks nothing here.\n' +
      "A `checker` passed to check() in the app's own source still beats whatever is declared, " +
      'so "none" is also how an app that does that says so.'
  );
}

/**
 * What `sigil package` says when a schema names its checker through a call it cannot read.
 *
 * `assertUpdateCheckDeclared()` is not asked of such an app, because the usual
 * one only imports a builder to write `updateCheck: githubChecker(...)` and a
 * refusal there stops a correct build. But `wrap({ checker })` may hand back
 * something else, or nothing at all when `wrap` is nullish, and then an app that
 * also calls `check()` with no checker of its own ships a binary whose update
 * check does nothing. The build cannot tell the two apart, so it says so and
 * leaves the decision with the build's author (SIG-593).
 *
 * @param config - The app's `sigil.json`.
 * @param imported - Whether the bundle reached `@ttylabs/sigil/updates`.
 * @param schema - What `readSchemaUpdateCheck()` made of the schema.
 * @returns The warning, or `undefined` when there is nothing to say.
 */
export function wrappedCheckWarning(
  config: SigilConfig,
  imported: boolean,
  schema: SchemaUpdateCheck | undefined
): string | undefined {
  if (!imported || schema !== 'wrapped' || config.updateCheck) {
    return undefined;
  }

  return (
    "This app's updateCheck names its checker through a call, and the build cannot see what that call returns. " +
    `It imports ${UPDATE_CHECK_SPECIFIER}, so if it also calls check() with no checker of its own, the binary's update check does nothing. ` +
    'Declare "updateCheck" in sigil.json -- "npm", "github" or "custom" for where to look, or "none" -- to settle it.'
  );
}

/**
 * What `sigil package` says when a schema names its checker and the app calls `check()`.
 *
 * The schema's checker serves the **automatic** check, and `check()` reads only
 * its own `checker` option or the one `sigil.json` bakes -- so an app that writes
 * `updateCheck: githubChecker({ repo })` and also calls `check()` with no checker
 * of its own ships a binary whose hand-called check answers `{ current }` with no
 * `latest`. The build cannot see which arguments a call was given, so it cannot
 * tell that app from one that passes its own `checker`; it says why the check
 * would be empty and leaves it to the author (SIG-609). Declaring `updateCheck` in
 * `sigil.json` is both the fix and the silence, the way it is for
 * `wrappedCheckWarning()`.
 *
 * Asked of `'names'` only, and only once the bundle reaches `check` itself: a
 * schema that names its checker and imports nothing but the builder is the
 * documented path, and it is not warned about.
 *
 * @param config - The app's `sigil.json`.
 * @param importsCheck - Whether a module of the bundle reaches `check()`.
 * @param schema - What `readSchemaUpdateCheck()` made of the schema.
 * @returns The warning, or `undefined` when there is nothing to say.
 */
export function handCalledCheckWarning(
  config: SigilConfig,
  importsCheck: boolean,
  schema: SchemaUpdateCheck | undefined
): string | undefined {
  if (!importsCheck || schema !== 'names' || config.updateCheck) {
    return undefined;
  }

  return (
    "This app's updateCheck names its checker in the schema, and the app imports check() from " +
    `${UPDATE_CHECK_SPECIFIER}. The schema's checker serves the automatic check only: a check() called with no ` +
    'checker of its own reads sigil.json, which declares nothing, so in this binary it does nothing. ' +
    'Declare "updateCheck" in sigil.json -- "npm", "github" or "custom" for where to look -- to give it one. ' +
    'An app that passes a checker to check() does not need to, and "none" says so.'
  );
}

/** What a source read of one checker field came to. */
type Field =
  /** The checker does not spell it, and nothing may carry it. */
  | { readonly kind: 'absent' }
  /** Spelled, and the source is the value's. */
  | { readonly kind: 'written'; readonly node: Expression }
  /** A spread, a computed key or an accessor may say what it is. */
  | { readonly kind: 'unknown' };

/**
 * What an object literal says about one key, as the object it evaluates to would.
 *
 * The same question `lastReplacing()` answers for the module lift: the spelling
 * that runs is the last one, so a spread or computed key after it may have
 * replaced it.
 */
function fieldOf(members: readonly Member[], key: string): Field {
  const spelled = members.findLastIndex(
    (member) => member.type !== 'SpreadElement' && propertyKey(member) === key
  );

  if (lastReplacing(members, key) > spelled) {
    return { kind: 'unknown' };
  }

  if (spelled === -1) {
    return { kind: 'absent' };
  }

  const property = members[spelled] as ObjectProperty;
  return property.kind === 'init' && !property.method
    ? { kind: 'written', node: property.value as Expression }
    : { kind: 'unknown' };
}

/** A URL and a path `checkedChecker()` accepts, for the field the source does not settle. */
const READABLE_URL = 'https://example.com/latest';
const READABLE_PATH = ['version'];

/** A value of a type a header may not have, for a header whose source says its type. */
const JUNK: Record<string, unknown> = {
  bigint: 1n,
  function: () => undefined,
  object: {},
  symbol: Symbol('header'),
};

/**
 * The headers an object literal spells, as far as their names and types go.
 *
 * A value that is a string is read; any other value is read as a harmless
 * string unless its type is written down as one a header may not have, because
 * the value of `Bearer ${token}` is not in the source and a refusal has to be
 * about what is. A spread or a computed key in the literal makes all of it
 * unreadable rather than some of it.
 */
function readHeaders(node: Expression): unknown {
  const value = unwrapShallow(node);
  if (value.type === 'ArrayExpression') {
    return [];
  }

  if (value.type !== 'ObjectExpression') {
    return literalString(value);
  }

  const headers: Record<string, unknown> = {};
  for (const member of flatten(value)) {
    const name = member.type === 'SpreadElement' ? undefined : propertyKey(member);
    if (member.type === 'SpreadElement' || name === undefined) {
      return undefined;
    }

    // an accessor's value is whatever its getter answers, so it is not read
    const written = unwrapShallow(member.value as Expression);
    const type = member.kind === 'init' ? literalType(written) : undefined;
    // a list is a value Node sends, one header line per element: it is `'object'`
    // to `literalType()` and not the junk a plain object is
    headers[name] =
      type !== undefined && type in JUNK && written.type !== 'ArrayExpression'
        ? JUNK[type]
        : (literalString(written) ?? 'x');
  }

  return headers;
}

/**
 * What a checker written as an object literal says, with what the source does
 * not settle replaced by something `checkedChecker()` accepts.
 *
 * "Not settle" is a name, a call or a template with a substitution, and it is
 * read as valid, as is a literal of the wrong type (`url: 42`, a list holding a
 * list as a header value) which the runtime refuses: only a `url` string, a
 * `path` list or string, and a header value written as a function, an object, a
 * bigint or a symbol are judged. It errs towards not refusing, for the reason
 * `readSchemaUpdateCheck()` does: a false refusal stops a correct build and a
 * missed one is what there was before this existed.
 */
function readChecker(object: ObjectExpression): Record<string, unknown> {
  const members = flatten(object);
  const checker: Record<string, unknown> = { path: READABLE_PATH, url: READABLE_URL };

  const url = fieldOf(members, 'url');
  if (url.kind === 'absent') {
    delete checker.url;
  } else if (url.kind === 'written') {
    checker.url = literalString(url.node) ?? READABLE_URL;
  }

  const path = fieldOf(members, 'path');
  if (path.kind === 'absent') {
    delete checker.path;
  } else if (path.kind === 'written') {
    const node = unwrapShallow(path.node);
    const strings = node.type === 'ArrayExpression' ? stringList(node) : undefined;
    const bare = literalString(node);
    checker.path = bare ?? (strings?.kind === 'strings' ? strings.values : READABLE_PATH);
  }

  const headers = fieldOf(members, 'headers');
  if (headers.kind === 'written') {
    const read = readHeaders(headers.node);
    if (read !== undefined) {
      checker.headers = read;
    }
  }

  return checker;
}

/**
 * Whether an object literal given as the whole `updateCheck` is a checker written
 * bare, which at run time is `isChecker()`: a `type` and a `url` that are strings
 * and a `path` that is a list.
 *
 * Asked of what the source says, so a field whose type is written down as another
 * one is options -- `{ type, url, path: 'version' }` is read by the runtime as
 * options, which check npm and refuse nothing -- and a name, whose type is not in
 * the source, is read as the type it needs. A `path` that is not written is not a
 * list either.
 */
function isWrittenChecker(members: readonly Member[]): boolean {
  const wanted = [
    ['type', 'string'],
    ['url', 'string'],
    ['path', 'object'],
  ] as const;

  return wanted.every(([key, type]) => {
    const field = fieldOf(members, key);
    if (field.kind !== 'written') {
      return false;
    }
    const written = literalType(field.node);
    if (written === undefined) {
      return true;
    }
    // an object or a regular expression is `'object'` to `literalType()` and is
    // not a list, which `isChecker()` asks with `Array.isArray()`
    return key === 'path' ? unwrapShallow(field.node).type === 'ArrayExpression' : written === type;
  });
}

/**
 * Refuses, while building, a hand-written checker the update check would
 * refuse when the app runs (SIG-564).
 *
 * `check()` asks `checkedChecker()` of every checker it is handed, and a
 * schema's `updateCheck` reaches it through `beginUpdateCheck()`, which catches
 * everything because a notice may not fail a command -- so a checker it refuses
 * is an update notice that never appears, said under `DEBUG=sigil:updates` and
 * nowhere else. `sigil.json` has no such gap: it is built through
 * `customChecker()` and refused here. This is the same question asked of the
 * schema, answered by the same function, so the rules are the runtime's own.
 *
 * The schema is read and not run, as every pass here reads, so only what the
 * source writes down is judged: a `url`, a `path` and `headers` written as
 * literals, in `updateCheck: { checker: { ... } }` or in the bare form. A call
 * to `npmChecker()`, `githubChecker()` or `customChecker()` is left alone,
 * because a builder refuses where it is called and the app does not start. A
 * value that is a name, a call or a template with a substitution is read as
 * valid; a checker held in a variable is not read at all.
 *
 * @param entry - The app's entry module. The schema is read from the module that holds it,
 *   which is this one unless it imports its schema (`schemaModule()`).
 * @returns One error per schema whose checker is refused.
 */
export function checkSchemaUpdateCheck(entry: string): Diagnostic[] {
  let parsed: ReturnType<typeof parseModule>;
  try {
    const file = schemaModule(entry);
    parsed = parseModule(file, readFileSync(file, 'utf-8'));
  } catch {
    // an entry that does not read has been reported by what read it first
    return [];
  }

  const found: Diagnostic[] = [];
  for (const schema of outermostDeclaring(parsed.program as never, 'updateCheck')) {
    // the spelling that runs, as a checker's own fields are read: a spread after
    // it may have replaced it
    const declared = fieldOf(flatten(schema), 'updateCheck');
    const value = declared.kind === 'written' ? unwrapShallow(declared.node) : undefined;
    if (value?.type !== 'ObjectExpression') {
      continue;
    }

    // the same two spellings `updateCheckOptions()` tells apart, in its order: a
    // checker written bare is asked first and a `checker` beside one is never
    // looked at, then the options with a `checker` in them
    const members = flatten(value);
    let checker: ObjectExpression | undefined;
    if (isWrittenChecker(members)) {
      checker = value;
    } else {
      const named = fieldOf(members, 'checker');
      const node = named.kind === 'written' ? unwrapShallow(named.node) : undefined;
      checker = node?.type === 'ObjectExpression' ? node : undefined;
    }
    if (!checker) {
      continue;
    }

    try {
      checkedChecker(readChecker(checker));
    } catch (err) {
      found.push({
        ...locate(parsed, checker.start),
        message:
          'this updateCheck checker is refused when the app runs, so the app never shows an ' +
          `update notice: ${(err as Error).message}`,
        severity: 'error',
      });
    }
  }

  return found;
}
