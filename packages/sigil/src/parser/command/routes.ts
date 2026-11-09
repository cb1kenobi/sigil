/**
 * What a directory of commands routes to, as data.
 *
 * The rules live here rather than inside the walk that uses them, because
 * there are two walks. The runtime's is `loadCommandDir()`, which reads one
 * level when argv names it and turns each route into a command. The build's is
 * `sigil build`, which reads every level ahead of time and turns each route
 * into a line of a generated schema. Those two have to agree exactly or an app
 * routes differently bundled and unbundled -- the one divergence a user cannot
 * debug, because both halves are behaving as designed.
 *
 * So neither of them decides anything. `readRoutes()` answers "what is in this
 * directory" once, and what either caller does with the answer is its own
 * business: the name a route claims, the file behind it, the collision between
 * two routes claiming one name, the `index` module that is the directory
 * itself, and the package that renames itself are all settled here. This is the
 * same reason `LAYOUT_PROPERTIES` sits next to the property table and the
 * colour properties are read off it rather than listed again -- a second copy
 * of a rule is a rule that drifts, and this one drifts into an app that works
 * until it is built.
 *
 * Nothing here builds a command or imports a module. Every answer is a
 * `readdir`, a `stat`, a `package.json` read per subdirectory that has one,
 * and at most one `commands.json` read per level, which is what lets the build
 * ask about a tree it is compiling and the runtime ask about a level it is
 * about to match.
 */

import { parseJsonc } from '../../config/jsonc.js';
import { byCodeUnit } from '../../util/by-code-unit.js';
import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, parse } from 'node:path';

/**
 * A module file, which is any of the six extensions a route may have.
 *
 * TypeScript is here because every runtime this package supports strips types
 * on its own: `engines` says node >=22.19.0 and stripping has been on by
 * default since 22.18, so there is no capability to detect and no flag to
 * document. A `.cts` is still CommonJS and a `.mts` still an ES module, since
 * stripping erases annotations and does not rewrite module syntax.
 */
const fileTypeRegExp = /^\.[cm]?[jt]s$/;

/**
 * A TypeScript extension, which is the half of `fileTypeRegExp` that needs a
 * declaration file kept out of it.
 */
const tsTypeRegExp = /^\.[cm]?ts$/;

/**
 * The basename of the module that declares a directory's own command, as
 * opposed to one of the commands inside it.
 */
export const INDEX_NAME = 'index';

/**
 * The file a directory of commands is described in, as `commands.json` or as
 * `commands.jsonc`.
 *
 * One list, read by both walks, so that the runtime and `sigil build` cannot
 * come to disagree about what the file is called. Either name is read as
 * JSONC, which is the rule `sigil.json` already follows: the extension is a
 * preference rather than a statement about the bytes. Both in one directory is
 * refused rather than one of them winning, for the reason two `index` modules
 * are -- whichever one is not read is a file somebody edits to no effect.
 *
 * Neither is a route, because `.json` is not one of the six route extensions.
 */
export const MANIFEST_FILES = ['commands.json', 'commands.jsonc'] as const;

/**
 * What a `commands.json` says about one route: the four properties a
 * placeholder already takes, meaning what they mean there.
 */
export interface RouteEntry {
  /** Extra spellings that route to the command, and stay out of help. */
  readonly alias?: readonly string[];
  /** Whether it runs when argv names none of its siblings. */
  readonly default?: boolean;
  /** What help shows before the module loads. */
  readonly desc?: string;
  /** Whether help leaves it out. */
  readonly hidden?: boolean;
}

/** A `commands.json`, read and checked. */
export interface RouteManifest {
  /** What it says, keyed by route name. */
  readonly entries: ReadonlyMap<string, RouteEntry>;
  /** Where it is, for a message. */
  readonly file: string;
  /**
   * A property an entry carries that is none of the four, which is ignored.
   *
   * Ignored rather than refused, which is the rule for an entry naming no
   * route: an app runs exactly as it would without it, and it is `sigil check`
   * and `sigil build` that say so -- a misspelt `"aliases"` is a spelling that
   * does not route, and that must not be silent.
   */
  readonly unknown: readonly { readonly name: string; readonly property: string }[];
}

/** The properties an entry may carry, so the set is one list. */
const ENTRY_PROPERTIES: ReadonlySet<string> = new Set(['alias', 'default', 'desc', 'hidden']);

/** What kind of thing a route is, which is what says how to load it. */
export type RouteKind = 'directory' | 'module' | 'package';

/** One route in a command directory. */
export interface Route {
  /** Extra spellings, from the directory's `commands.json`. */
  readonly alias?: readonly string[];
  /** Whether it is the default, from the directory's `commands.json`. */
  readonly default?: boolean;
  /**
   * What the route says it does, which only a file read can answer here.
   *
   * A package describes itself in its `package.json`, and any route may be
   * described by the `commands.json` beside it. Every other description is
   * inside the module, which is why it is `undefined` without one and why the
   * build lifts it statically. A package's manifest beats an entry, because
   * that read is free and cannot go stale.
   */
  readonly desc?: string;
  /** Whether it is hidden, from the directory's `commands.json`. */
  readonly hidden?: boolean;
  /** Which of the three things this route is. */
  readonly kind: RouteKind;
  /** The command name, after a package has had its say. */
  readonly name: string;
  /**
   * The module for a `module` or a `package`, the directory for a `directory`.
   *
   * A package resolves to its entry module rather than to its directory,
   * because its `exports` is what says which module is the command -- the
   * files beside it are internals and are never walked for routes.
   */
  readonly path: string;
}

/** One level of a command directory, resolved. */
export interface DirectoryRoutes {
  /**
   * The `index` module, which is this directory's own command rather than one
   * inside it.
   */
  readonly index?: string;
  /** The directory's `commands.json`, already applied to `routes`. */
  readonly manifest?: RouteManifest;
  /** Every route inside, sorted, with no two claiming one name. */
  readonly routes: readonly Route[];
  /**
   * The entries of `manifest` that name no route, which the runtime ignores:
   * an entry describes and aliases a command and never creates one.
   */
  readonly stale: readonly string[];
}

/** What a package says about itself, read rather than imported. */
export interface PackageRoute {
  readonly description?: string;
  readonly entryFile: string;
  readonly name?: string;
}

/**
 * Whether a directory entry is deliberately not a route.
 *
 * Two prefixes, and they are not the same kind of statement. A `.` is not a
 * route because nothing that starts with one ever was: `.gitkeep`,
 * `.DS_Store`, and a `.git` directory all end up beside command modules and
 * none of them is a command anybody wrote. A `_` is not a route because
 * somebody *said* so -- it is the one way to put a helper module, a fixture, a
 * shared component, or a `__tests__` directory inside a `commands/` tree
 * without it becoming a command. Without it, `commands/_helpers.js` is a
 * command called `_helpers`, which is a footgun the moment a routes tree is
 * the normal way to write an app.
 *
 * It is the prefix and only the prefix, so `my_command.js` is `my_command` and
 * a name is never searched for an underscore in the middle of it.
 *
 * **This is a rule about a walk, not about a path somebody wrote.** A
 * declaration naming `'./_helpers.js'` is an explicit statement and gets the
 * command it asked for, which is the same asymmetry already recorded for a
 * path nobody named being a directory *of* commands while a path somebody
 * named is *one* command. That is why the check is here and in `indexEntry()`,
 * and deliberately not inside `moduleName()` -- which is asked about full
 * paths from a declaration as well as about entries from a listing, and could
 * not tell the two apart.
 *
 * @param name - The entry's own name, not a path.
 * @returns Whether to skip it.
 */
export function isPrivateRoute(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_');
}

/**
 * Reads a directory, or answers `undefined` for anything that is not one.
 *
 * @param dir - The path to read.
 * @returns Its entries, or `undefined`.
 */
export function readDirectory(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // not a directory, or not there
    return undefined;
  }
}

/**
 * Whether a directory entry is itself a directory.
 *
 * @param entry - The entry.
 * @param dir - The directory it came from.
 * @returns Whether to walk it.
 */
export function isDirectoryEntry(entry: Dirent, dir: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }

  // a `Dirent` reports a symlink as a symlink whatever it points at, and a
  // symlinked directory of commands is still a directory of commands
  if (entry.isSymbolicLink()) {
    try {
      return statSync(join(dir, entry.name)).isDirectory();
    } catch {
      // a broken link points at nothing
      return false;
    }
  }

  return false;
}

/**
 * The command name a directory entry routes to.
 *
 * @param entry - The entry.
 * @param dir - The directory it came from.
 * @param isDir - Whether it is a directory, when the caller already asked.
 * @returns The name, or `undefined` when the entry is not a route at all.
 */
export function routeName(
  entry: Dirent,
  dir: string,
  isDir: boolean = isDirectoryEntry(entry, dir)
): string | undefined {
  if (isPrivateRoute(entry.name)) {
    return undefined;
  }

  if (isDir) {
    return entry.name;
  }

  return moduleName(entry.name);
}

/**
 * The command a module filename names, or `undefined` when it names none.
 *
 * @param filename - The file's own name, or a path ending in it.
 * @returns The name, without the extension.
 */
export function moduleName(filename: string): string | undefined {
  const { ext, name } = parse(filename);

  if (!name || !ext || !fileTypeRegExp.test(ext)) {
    return undefined;
  }

  // `build.d.ts` parses as a name of `build.d` and an extension of `.ts`, so
  // left alone a declaration file is a command called `build.d` -- and beside
  // the `build.js` it describes it is a second claim on `build`, which is the
  // collision error on a directory that has nothing wrong with it. Compiled
  // output is the ordinary way to end up with both
  if (tsTypeRegExp.test(ext) && name.endsWith('.d')) {
    return undefined;
  }

  return name;
}

/**
 * The `index` module in a directory listing, if there is one.
 *
 * @param dir - The directory.
 * @param entries - Its listing.
 * @returns The path to the index module, or `undefined`.
 */
export function indexEntry(dir: string, entries: Dirent[]): string | undefined {
  // `isPrivateRoute()` is asked here as well as in `routeName()`, and that is
  // one rule with two readers rather than two rules: a `_index.js` is a helper
  // somebody deliberately kept out of the tree, and the directory's own
  // command is a route like any other -- so the prefix has to take it too, or
  // `_` would hide a module from the listing and then load it as the
  // directory itself
  const found = entries.filter(
    (entry) => !isPrivateRoute(entry.name) && moduleName(entry.name) === INDEX_NAME
  );

  // two of them is the ambiguity two routes of one name already is, said about
  // the directory itself: an `index.ts` beside a stale `index.js` is a
  // directory with two answers, and picking one by a preference order is how
  // somebody edits the file that is not being loaded
  if (found.length > 1) {
    const names = found.map((entry) => `"${entry.name}"`).sort();
    throw new Error(`Directory "${dir}" has more than one index module: ${names.join(', ')}`);
  }

  return found.length ? join(dir, found[0]!.name) : undefined;
}

/**
 * Resolves a package's `exports` to the relative paths worth trying, best first.
 *
 * An `exports` map nests: `"."` holds a conditions object, a condition holds
 * another, and an array is a fallback list. Unwrapping exactly one level --
 * `exports['.'] || exports.default` -- left a plain object for the ordinary
 * `{ ".": { "import": "./index.js" } }`, which then reached `join()` as
 * `[object Object]` and reported the package as having no valid export.
 *
 * Every candidate is returned rather than the first one, because a fallback list
 * means "the first of these that works" and whether one works is a question about
 * the file system: the caller already walks the list looking for a file, so
 * picking here would pick a path that may not exist and call the package broken.
 *
 * Only what this loader can actually import is considered: `import` and `node`
 * before `default`, and `require` last, since a CommonJS entry still loads. The
 * conditions it cannot honor -- `browser`, `types`, a user condition -- are
 * skipped rather than guessed at.
 *
 * @param exports - The `exports` field, whatever shape it is in.
 * @param subpath - Whether a `"."` subpath is still to be taken.
 * @returns The relative paths, in the order they should be tried.
 */
function resolveEntries(exports: unknown, subpath = true): string[] {
  if (typeof exports === 'string') {
    return [exports];
  }

  if (Array.isArray(exports)) {
    return exports.flatMap((candidate) => resolveEntries(candidate, subpath));
  }

  if (!exports || typeof exports !== 'object') {
    return [];
  }

  const map = exports as Record<string, unknown>;

  // a map whose keys are subpaths is a different thing from one whose keys are
  // conditions, and `"."` is only a subpath at the top
  if (subpath && Object.hasOwn(map, '.')) {
    return resolveEntries(map['.'], false);
  }

  const entries: string[] = [];
  for (const condition of ['import', 'node', 'default', 'require']) {
    if (Object.hasOwn(map, condition)) {
      entries.push(...resolveEntries(map[condition], false));
    }
  }

  // one file reached through two conditions is still one file to try
  return [...new Set(entries)];
}

/**
 * Reads what a package says about itself, without importing it.
 *
 * Everything here is a file read and a `stat`: which module is the command,
 * what it is called, and what it does. That is what lets a package a directory
 * walk discovered cost no more than a plain directory -- it is described in
 * help by its `package.json` and imported only when it is matched.
 *
 * @param dir - The directory that may be a package.
 * @returns What it says, or `undefined` when it is not a package.
 */
export function readPackage(dir: string): PackageRoute | undefined {
  const pkgFile = join(dir, 'package.json');

  let json;
  try {
    json = readFileSync(pkgFile, 'utf-8');
  } catch {
    // no package.json, not a package
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to JSON parse ${pkgFile}: ${err instanceof Error ? err.message : err}`);
  }

  const { description, exports, main, name, type } = pkgJson;

  const entries = resolveEntries(exports);
  if (!entries.length && typeof main === 'string') {
    entries.push(main);
  }

  const filePaths = entries.length
    ? entries
    : ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.mts', 'index.cts'];
  let entryFile;

  for (const filepath of filePaths) {
    try {
      const file = join(dir, filepath);
      const st = statSync(file);
      if (st.isFile()) {
        entryFile = file;
        break;
      }
    } catch {
      // not a file or does not exist
    }
  }

  if (!entryFile) {
    throw new Error(
      `Command package does not have a valid ${type === 'module' ? 'export' : 'main'}: ${dir}`
    );
  }

  return { description, entryFile, name };
}

/**
 * Reads a directory's `commands.json`, if its listing holds one.
 *
 * Asked of the listing the walk already has, so a directory without one costs
 * nothing at all, and one with it costs one file read -- the same as the
 * `package.json` a package subdirectory already costs. No module is read.
 *
 * What it checks is the file's own shape: an object of objects, each property
 * the type a placeholder's is. A wrong one throws naming the file, as an invalid
 * placeholder declaration throws, and `sigil build` fails with the same message
 * because it reads the file through this. What it does not check is whether a
 * key names a route, which is the caller's to compare against the routes it
 * found, and a property it does not know, which it reports and ignores -- see
 * `RouteManifest.unknown`.
 *
 * @param dir - The directory.
 * @param entries - Its listing.
 * @returns What the file says, or `undefined` when there is none.
 * @throws If both spellings are there, if it is not JSON or JSONC, if it is not
 *   an object of objects, if a property is the wrong type, or if two entries are
 *   both `default`.
 */
export function readRouteManifest(dir: string, entries: Dirent[]): RouteManifest | undefined {
  const found = entries
    .filter(
      (entry) =>
        (MANIFEST_FILES as readonly string[]).includes(entry.name) && !isDirectoryEntry(entry, dir)
    )
    .map((entry) => entry.name)
    .sort();

  if (!found.length) {
    return undefined;
  }

  // two answers to one question, which is what two routes claiming one name and
  // two `index` modules already are
  if (found.length > 1) {
    throw new Error(
      `Directory "${dir}" has more than one commands manifest: ${found.map((name) => `"${name}"`).join(', ')}`
    );
  }

  const file = join(dir, found[0]!);
  const { value } = parseJsonc(readFileSync(file, 'utf-8'), file);

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected ${file} to be an object of commands, keyed by route name`);
  }

  const parsed = new Map<string, RouteEntry>();
  const unknown: { name: string; property: string }[] = [];
  let fallback: string | undefined;

  for (const [name, declared] of Object.entries(value as Record<string, unknown>)) {
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new TypeError(`Expected "${name}" in ${file} to be an object`);
    }

    const { alias, default: isDefault, desc, hidden } = declared as Record<string, unknown>;

    for (const property of Object.keys(declared)) {
      if (!ENTRY_PROPERTIES.has(property)) {
        unknown.push({ name, property });
      }
    }

    if (desc !== undefined && typeof desc !== 'string') {
      throw new TypeError(`Expected desc for "${name}" in ${file} to be a string`);
    }

    if (hidden !== undefined && typeof hidden !== 'boolean') {
      throw new TypeError(`Expected hidden for "${name}" in ${file} to be a boolean`);
    }

    if (isDefault !== undefined && typeof isDefault !== 'boolean') {
      throw new TypeError(`Expected default for "${name}" in ${file} to be a boolean`);
    }

    const aliases = typeof alias === 'string' ? [alias] : alias;
    if (
      aliases !== undefined &&
      (!Array.isArray(aliases) || aliases.some((each) => typeof each !== 'string'))
    ) {
      throw new TypeError(
        `Expected alias for "${name}" in ${file} to be a string or list of strings`
      );
    }

    // the placeholder this becomes would refuse it too, but naming no file --
    // and after a build it would be refused by the built app on every start
    // rather than by the build, which is the one place it can still be fixed
    for (const each of (aliases ?? []) as string[]) {
      if (each[0] === '!' || each[0] === '@') {
        throw new Error(
          `Invalid alias "${each}" for "${name}" in ${file}: "${each[0]}" is name-string syntax and an alias is a plain name`
        );
      }
    }

    // two siblings both default is refused by the registry when they are
    // registered; asked here as well so that it is refused naming the file,
    // and whether or not both entries name a route
    if (isDefault === true) {
      if (fallback !== undefined) {
        const [a, b] = [fallback, name].sort(byCodeUnit);
        throw new Error(
          `Only one default command is allowed: "${a}" and "${b}" are both default in ${file}`
        );
      }
      fallback = name;
    }

    parsed.set(name, {
      ...(aliases === undefined ? {} : { alias: [...(aliases as string[])] }),
      ...(isDefault === undefined ? {} : { default: isDefault }),
      ...(desc === undefined ? {} : { desc }),
      ...(hidden === undefined ? {} : { hidden }),
    });
  }

  return { entries: parsed, file, unknown };
}

/**
 * A route with what the directory's `commands.json` says about it applied.
 *
 * `route.desc` first, which is the one precedence rule this has: a package's
 * own manifest is a free read that cannot go stale, so an entry fills only
 * what the walk could not say. Everything else a route has no answer of its
 * own for.
 *
 * @param route - The route.
 * @param entry - What the file says about it.
 * @returns The route, described.
 */
function describeRoute(route: Route, entry: RouteEntry | undefined): Route {
  if (!entry) {
    return route;
  }

  const desc = route.desc ?? entry.desc;

  return {
    ...route,
    ...(entry.alias === undefined ? {} : { alias: entry.alias }),
    ...(entry.default === undefined ? {} : { default: entry.default }),
    ...(desc === undefined ? {} : { desc }),
    ...(entry.hidden === undefined ? {} : { hidden: entry.hidden }),
  };
}

/**
 * The route one directory entry is, or `undefined` when it is not one.
 *
 * @param dir - The directory the entry came from.
 * @param entry - The entry.
 * @returns The route.
 */
function entryRoute(dir: string, entry: Dirent): Route | undefined {
  const isDir = isDirectoryEntry(entry, dir);
  const name = routeName(entry, dir, isDir);

  // `index` is the directory's own command rather than one inside it. Where
  // there is no directory command for it to be -- a bare
  // `commands: './commands'`, whose own command is the schema -- it is
  // nothing at all, which is why this is one rule rather than two
  if (!name || name === INDEX_NAME) {
    return undefined;
  }

  const path = join(dir, entry.name);

  if (!isDir) {
    return { kind: 'module', name, path };
  }

  // a package is not walked: its `exports` is what says which module is the
  // command, so reading the directory would register its internals as
  // commands. Its manifest is what names and describes it, which is a file
  // read rather than an import -- so the name is known in time to match on and
  // the module still waits for a match
  const pkg = readPackage(path);
  if (pkg) {
    return {
      desc: pkg.description,
      kind: 'package',
      name: pkg.name ?? name,
      path: pkg.entryFile,
    };
  }

  return { kind: 'directory', name, path };
}

/**
 * Resolves every route in one directory listing.
 *
 * @param dir - The directory the entries came from.
 * @param entries - Its listing.
 * @param manifest - Its `commands.json`, read from the listing unless the
 *   caller already has it.
 * @returns One route per entry that is one, sorted, names unique, each with
 *   what the `commands.json` says about it.
 */
export function resolveRoutes(
  dir: string,
  entries: Dirent[],
  manifest: RouteManifest | undefined = readRouteManifest(dir, entries)
): readonly Route[] {
  const claimed = new Map<string, string>();
  const routes: Route[] = [];

  // sorted, because `readdir` order is the file system's, and a registry whose
  // order depends on that is the thing `CommandRegistry.add()` already sorts
  // names to avoid reporting. By code unit, because a sort that reads the
  // process locale is the same defect one step along: `localeCompare` puts
  // `ä.js` before `z.js` under `de` and after it under `sv`, so one tree could
  // register in two orders on two machines
  for (const entry of [...entries].sort((a, b) => byCodeUnit(a.name, b.name))) {
    const route = entryRoute(dir, entry);
    if (!route) {
      continue;
    }

    // asked of the route rather than of the entry, because a package renames
    // itself: a `pkg/` whose `package.json` says `foo` collides with a `foo.js`
    // beside it, and the directory name would not have seen it
    const previous = claimed.get(route.name);
    if (previous !== undefined) {
      // silently keeping one of them would keep whichever `readdir` handed
      // over second, which is the file system's order deciding which command
      // an app has
      throw new Error(
        `Two entries in "${dir}" both declare a "${route.name}" command: "${previous}" and "${entry.name}"`
      );
    }
    claimed.set(route.name, entry.name);

    // keyed by the route's name rather than the entry's, for the reason the
    // collision is: a package names itself, and `pkg` is then not a command
    routes.push(describeRoute(route, manifest?.entries.get(route.name)));
  }

  return routes;
}

/**
 * Reads one level of a command directory.
 *
 * One level and not the tree, because that is the deferral the runtime walk is
 * built on -- `mycli db migrate up` reads `commands/`, `commands/db/` and
 * `commands/db/migrate/` and nothing else. A caller that wants the whole tree,
 * which is the build, recurses on the `directory` routes itself and pays for
 * exactly what it asked for.
 *
 * @param dir - The directory.
 * @returns Its routes, its own `index` module and its `commands.json`, or
 *   `undefined` when the path is not a directory at all.
 */
export function readRoutes(dir: string): DirectoryRoutes | undefined {
  const entries = readDirectory(dir);
  if (!entries) {
    return undefined;
  }

  const manifest = readRouteManifest(dir, entries);
  const routes = resolveRoutes(dir, entries, manifest);
  const named = new Set(routes.map((route) => route.name));

  return {
    index: indexEntry(dir, entries),
    ...(manifest ? { manifest } : {}),
    routes,
    stale: manifest ? [...manifest.entries.keys()].filter((name) => !named.has(name)) : [],
  };
}
