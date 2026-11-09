/**
 * The command tree, resolved ahead of time.
 *
 * The runtime reads one level of `commands/` when argv names it, which is what
 * keeps a sixty-command tree to one `readdir` per level and one `import`. The
 * build reads every level once, because it is about to compile all of them --
 * and what it produces is that same tree as a schema literal, so a built app
 * reads no directories and stats nothing.
 *
 * ## The two walks share their rules and nothing else
 *
 * Every decision about what is in a directory comes from `readRoutes()` in
 * `@ttylabs/sigil/routes`: the names, the extensions, the `.` and `_` prefixes,
 * the `index` module that is the directory itself, the package that renames
 * itself, and the collision between two routes claiming one name. This file
 * decides none of them. That is the whole point -- an app that routed
 * differently bundled and unbundled would be the one divergence a user cannot
 * debug, since both halves would be behaving exactly as designed.
 *
 * What this adds is the half the runtime has no answer for: a command's `desc`
 * and `hidden` live *inside* its module, and the runtime cannot know them
 * without importing it. See `extract.ts`.
 *
 * ## A `commands.json` is read the runtime's way and baked
 *
 * A routed directory's `commands.json` describes and aliases its commands
 * without loading a module, and `readRoutes()` is what reads it -- so each
 * route arrives here with its `desc`, `hidden`, `alias` and `default` already
 * applied, by the same function the runtime walk applies them with. This bakes
 * them into the tree, which is what makes an alias or a default route the same
 * from source and after a build. An entry's `desc` wins over the one lifted out
 * of the module, which is the placeholder rule (what help shows before the
 * module loads); a route with no entry, or an entry with no `desc`, keeps the
 * lift. What the runtime ignores -- an entry naming no route, a property it
 * does not know -- is a warning here, because a stale alias is a spelling that
 * does not route and must not be silent.
 *
 * ## Eager here, lazy in what it emits
 *
 * Reading everything is what a compiler does; making the *output* read
 * everything would throw away the deferral. So each command becomes a `load`
 * -- a function that imports its module -- and the tree itself is data. A
 * built `mycli --help` walks a literal and imports nothing.
 */

import type { Diagnostic } from './diagnostic.ts';
import { factsOf, type CommandFacts, type RoutedBy } from './extract.ts';
import { parseModule } from './parse-module.ts';
import {
  type DirectoryRoutes,
  MANIFEST_FILES,
  readPackage,
  readRoutes,
  type Route,
  type RouteKind,
} from '@ttylabs/sigil/routes';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * What a command came from: one of the three route kinds, or a schema that
 * wrote it out.
 *
 * `inline` is the build's rather than the runtime's, which is why it widens
 * `RouteKind` here instead of joining it: a walk can only produce the three,
 * and only an entry's own schema produces the fourth.
 */
export type CommandKind = RouteKind | 'inline';

/** One command in a resolved tree. */
export interface ResolvedCommand {
  /**
   * The extra spellings its placeholder declared with the `alias` property, or
   * that the `commands.json` beside a walked route gives it.
   *
   * Never a module's own: that is not known until it loads, and baking it would
   * route a spelling the source does not -- see `placeholderRouting()` in
   * `discover.ts`. The one exception is a package a schema key points at, whose
   * module the runtime imports when the schema is built, so its own `alias` is
   * the placeholder's -- see `keyedPackage()` there.
   */
  readonly alias?: readonly string[];
  /** Its subcommands, resolved the same way, sorted as the routes were. */
  readonly commands: readonly ResolvedCommand[];
  /**
   * Whether it is the command that runs when argv named none, as its
   * placeholder or its `commands.json` entry declared. Routing, for the reason
   * `alias` is.
   */
  readonly default?: boolean;
  /**
   * What it does: from its `commands.json` entry, from its package's manifest,
   * or lifted from its module.
   */
  readonly desc?: string;
  /**
   * Whether `desc` is a catalog key rather than the description itself. Never
   * set for a package, whose description is prose out of a manifest.
   */
  readonly descTranslated?: boolean;
  /** Whether it is hidden, from its `commands.json` entry or its module. */
  readonly hidden?: boolean;
  /**
   * Which of the three things the route behind it was, or `inline` for one a
   * schema wrote out rather than a walk discovered.
   */
  readonly kind: CommandKind;
  /**
   * The module that *is* this command, if any.
   *
   * Absent for a directory with no `index` module, which is a namespace: it
   * matches, it lists what is under it, and it has nothing to run. That is the
   * runtime's rule and the generated tree keeps it -- a namespace emits no
   * `load`, so nothing is ever imported for it.
   */
  readonly module?: string;
  /** What the user types. */
  readonly name: string;
}

/** A whole tree, and everything reading it turned up. */
export interface ResolvedTree {
  /** The root's commands. */
  readonly commands: readonly ResolvedCommand[];
  /** Everything worth telling the author, in the order it was found. */
  readonly diagnostics: readonly Diagnostic[];
}

/** How to resolve a tree. */
export interface ResolveOptions {
  /**
   * Whether to read each module's source for its `desc` and `hidden`.
   *
   * On by default, since it is the reason this exists. Off is for a caller
   * that only wants the shape -- listing the tree, say -- and would rather not
   * parse sixty files to get it.
   */
  readonly facts?: boolean;
}

/**
 * Resolves a directory of commands into a tree.
 *
 * @param dir - The directory, which is what `commands: './commands'` names.
 * @param options - Whether to read the modules.
 * @returns The tree, and every diagnostic reading it produced.
 * @throws If `dir` is not a directory, or if two routes in it claim one name.
 *   Both are the runtime's errors, raised by the rules this shares with it.
 */
export function resolveCommandTree(dir: string, options: ResolveOptions = {}): ResolvedTree {
  // asked first, because the runtime asks first: an unnamed path that is a
  // package is *one* command rather than a directory of them, and a `commands/`
  // holding nothing but `{ "type": "module" }` -- which is how a package forces
  // ESM on a directory -- is one. Left unasked, this walked the routes inside
  // and emitted a tree where the runtime emits a single command, which is the
  // divergence everything here exists to prevent
  if (readPackage(dir)) {
    throw new Error(
      `Cannot resolve "${dir}" at build time: its package.json makes it a package rather ` +
        'than a directory of commands, and the runtime names such a package from the module ' +
        'it imports -- which the build cannot read without running it. Declare it under a ' +
        'key to make it one named command, or remove the manifest to have its routes ' +
        'become sibling commands.'
    );
  }

  const diagnostics: Diagnostic[] = [];
  const commands = level(dir, diagnostics, options.facts ?? true);

  return { commands, diagnostics };
}

/**
 * Resolves one directory's routes.
 *
 * @param dir - The directory.
 * @param diagnostics - Where to report.
 * @param facts - Whether to read modules.
 * @returns One command per route.
 */
function level(dir: string, diagnostics: Diagnostic[], facts: boolean): ResolvedCommand[] {
  const found = readRoutes(dir);
  if (!found) {
    throw new Error(`Command directory not found: ${dir}`);
  }

  warnManifest(found, diagnostics);

  // the root's own `index` is deliberately not read: a bare
  // `commands: './commands'` has no directory command for an index to *be* --
  // its own command is the schema -- which is the rule the runtime's walk
  // already follows. A subdirectory's index is a different thing, and
  // `resolve()` below is where it becomes that subdirectory's command
  return found.routes.map((route) => resolve(route, manifestName(found), diagnostics, facts));
}

/**
 * The name a level's routes are described under: its `commands.json` or
 * `commands.jsonc` if it has one, and the first spelling if it has neither --
 * which is the one a warning tells an author to create.
 *
 * @param found - The level.
 * @returns The file's name, without its directory.
 */
function manifestName(found: DirectoryRoutes): string {
  return found.manifest ? basename(found.manifest.file) : MANIFEST_FILES[0];
}

/**
 * Warns about what a level's `commands.json` says that the runtime ignores.
 *
 * Two things, and both are ignored rather than refused because an app with
 * either runs exactly as it would without it: an entry naming no route, which
 * describes nothing because the walk decides what exists, and a property that
 * is none of the four an entry takes. Either is very often a spelling that
 * does not route -- a renamed file's old entry, an `"aliases"` -- and that is
 * the one thing that must not be silent.
 *
 * @param found - The level.
 * @param diagnostics - Where to report.
 */
function warnManifest(found: DirectoryRoutes, diagnostics: Diagnostic[]): void {
  const { manifest, stale } = found;
  if (!manifest) {
    return;
  }

  for (const name of stale) {
    const alias = manifest.entries.get(name)?.alias ?? [];
    diagnostics.push({
      file: manifest.file,
      message:
        `"${name}" names no command in this directory, so its entry is ignored` +
        (alias.length
          ? ` and ${alias.map((spelling) => `"${spelling}"`).join(', ')} does not route`
          : '') +
        `; key it by a file or subdirectory name here, without the extension, or remove it`,
      severity: 'warning',
    });
  }

  for (const { name, property } of manifest.unknown) {
    diagnostics.push({
      file: manifest.file,
      message: `"${property}" on "${name}" is not something an entry takes, so it is ignored; an entry takes "desc", "hidden", "alias" and "default"`,
      severity: 'warning',
    });
  }
}

/**
 * What a route's `commands.json` entry says, over what its module says.
 *
 * The entry's `desc` wins over the lifted one, because it is what the
 * placeholder declares and so what help shows before the module loads -- and
 * a lifted `descTranslated` goes with the lifted `desc`, since an entry's is
 * prose. `hidden` the same way. `alias` and `default` are the entry's alone: a
 * module's are not read, since they do not route.
 *
 * @param route - The route, with its entry already applied by `readRoutes()`.
 * @param facts - What its module says.
 * @returns The command's facts.
 */
function described(
  route: Route,
  facts: CommandFacts
): CommandFacts & { alias?: readonly string[]; default?: boolean } {
  const hidden = route.hidden ?? facts.hidden;
  const desc =
    route.desc !== undefined
      ? { desc: route.desc }
      : facts.desc !== undefined
        ? { desc: facts.desc, ...(facts.descTranslated ? { descTranslated: true } : {}) }
        : {};

  return {
    ...(route.alias?.length ? { alias: route.alias } : {}),
    ...(route.default !== undefined ? { default: route.default } : {}),
    ...desc,
    ...(hidden !== undefined ? { hidden } : {}),
  };
}

/**
 * How a walked route is reached, for the warning about what its module
 * declares that cannot route.
 *
 * @param route - The route.
 * @param file - The `commands.json` its level is described in.
 * @param index - Whether the module is the route's directory's `index`.
 * @returns How it is reached.
 */
function walkedBy(route: Route, file: string, index: boolean): RoutedBy {
  return {
    default: route.default === true,
    index,
    manifest: { file, key: route.name },
    name: [route.name, ...(route.alias ?? [])].join(', '),
  };
}

/**
 * Resolves one route into the command it is, recursing where it is a
 * directory.
 *
 * @param route - The route.
 * @param diagnostics - Where to report.
 * @param facts - Whether to read modules.
 * @returns The command.
 */
function resolve(
  route: Route,
  file: string,
  diagnostics: Diagnostic[],
  facts: boolean
): ResolvedCommand {
  if (route.kind === 'directory') {
    // read once and used twice, for its routes and for its index: reading it
    // again per half is the cost the runtime's own walk is careful to pay only
    // once, in the comment that says both halves come from one `readdir`
    const inside = readRoutes(route.path);
    if (!inside) {
      throw new Error(`Command directory not found: ${route.path}`);
    }

    warnManifest(inside, diagnostics);

    // the directory is described in its *parent's* file, under its own name --
    // its own file describes what is inside it
    return {
      commands: inside.routes.map((child) =>
        resolve(child, manifestName(inside), diagnostics, facts)
      ),
      ...described(
        route,
        inside.index
          ? read(
              inside.index,
              walkedBy(route, file, true),
              diagnostics,
              facts,
              route.desc !== undefined
            )
          : {}
      ),
      kind: route.kind,
      module: inside.index,
      name: route.name,
    };
  }

  // a package describes itself in its `package.json`, and that is the
  // description the runtime uses -- so this takes the same one rather than
  // reading its entry module. Reading it would mean reading somebody's
  // compiled output for a `desc` that is very likely computed there, to answer
  // a question its manifest has already answered
  //
  // `route.desc` is the manifest's, or the `commands.json` entry's where the
  // manifest has none -- `readRoutes()` settled which
  if (route.kind === 'package') {
    return {
      commands: [],
      ...described(route, {}),
      kind: route.kind,
      module: route.path,
      name: route.name,
    };
  }

  return {
    commands: [],
    ...described(
      route,
      read(route.path, walkedBy(route, file, false), diagnostics, facts, route.desc !== undefined)
    ),
    kind: route.kind,
    module: route.path,
    name: route.name,
  };
}

/**
 * Reads one module for what it says about itself.
 *
 * @param file - The module.
 * @param routedBy - The name it is routed by: its file's, or its directory's for
 *   an `index`. What a declaration inside the module is compared with, because
 *   that is the one name argv matches before the module is read.
 * @param diagnostics - Where to report.
 * @param facts - Whether to read it at all.
 * @param entryDescribed - Whether its `commands.json` entry already says what
 *   help shows, which answers every diagnostic about what the module's own
 *   `desc` and `hidden` would have shown -- the rule `moduleFacts()` in
 *   `discover.ts` follows for a placeholder with a `desc`. What it declares
 *   that cannot route is said either way.
 * @returns Its facts, or nothing when reading is off.
 */
function read(
  file: string,
  routedBy: RoutedBy,
  diagnostics: Diagnostic[],
  facts: boolean,
  entryDescribed: boolean
): CommandFacts {
  if (!facts) {
    return {};
  }

  const parsed = parseModule(file, readFileSync(file, 'utf-8'));
  const extracted = factsOf(parsed, routedBy);

  // an `error` is the module being unusable, which no description answers
  for (const diagnostic of extracted.diagnostics) {
    if (!entryDescribed || diagnostic.severity === 'error') {
      diagnostics.push(diagnostic);
    }
  }
  diagnostics.push(...extracted.routing);

  return extracted.facts;
}

/**
 * Walks a resolved tree, parents before children.
 *
 * Exported because more than one thing wants to: the generator prints it, a
 * build report counts it, and the bundler is handed every `module` in it.
 *
 * @param commands - Where to start.
 * @returns Each command, with the names above it.
 */
export function* walkTree(
  commands: readonly ResolvedCommand[],
  path: readonly string[] = []
): Generator<{ command: ResolvedCommand; path: readonly string[] }> {
  for (const command of commands) {
    const here = [...path, command.name];
    yield { command, path: here };
    yield* walkTree(command.commands, here);
  }
}
