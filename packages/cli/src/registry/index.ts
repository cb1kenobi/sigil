/**
 * The registry: resolving what `sigil add` copies, and where it lands.
 *
 * A registry is an npm package carrying `registry/registry.json`. There is no
 * central index and no interoperability with anyone else's component library,
 * which is a deliberate non-goal: resolution is npm's, so a registry is
 * something you already know how to publish, install and pin.
 *
 * ## It resolves from the app, never from the toolchain
 *
 * `@ttylabs/cli` is a devDependency on its own version line; `@ttylabs/sigil`
 * is what the app actually imports, at the version the app has pinned. So the
 * registry is resolved out of the *app's* `node_modules`, and the source that
 * lands in the tree is guaranteed to match the runtime it will be compiled
 * against. Reading it out of the toolchain's own dependencies would eject a
 * component that is a release ahead of the app.
 *
 * ## Copying, and what it costs
 *
 * An ejected component does not get upgrades. That is the price of owning it,
 * and it should be said plainly rather than discovered: a component that is 90%
 * right becomes editable instead of a fork or a feature request, and in
 * exchange a fix upstream is one somebody has to bring across by hand.
 *
 * What makes the price worth paying is that ejecting is the *last* resort
 * rather than the first. A built-in is themed with an ordinary rule against the
 * classes it draws with, and a prop overrides a one-off at the call site.
 * Ejecting is for when the structure or the behaviour has to change, which the
 * cascade cannot reach.
 */

import { displayPath, isFile, isInside } from '../build/index.ts';
import { readSigilConfig } from '../config.ts';
import { errorMessage, escapeControls } from '@ttylabs/sigil/error-handler';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Whether a path is a directory, answering `false` for anything unreadable. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The package a registry lives in when a spec does not name one. */
export const DEFAULT_REGISTRY = '@ttylabs/sigil';

/** One file an entry brings, and where it lands relative to the target directory. */
export interface EntryFile {
  /** The file's name inside the registry directory. */
  readonly from: string;
  /** Where it lands, relative to the configured component directory. */
  readonly to: string;
}

/** One thing that can be ejected. */
export interface RegistryEntry {
  /** The classes it draws with, which is what a theme may restyle. */
  readonly classes: readonly string[];
  /** What it is, for the listing and the plan. */
  readonly desc: string;
  /** Its files. */
  readonly files: readonly EntryFile[];
  /** The package subpaths it imports, all of which must resolve in the app. */
  readonly imports: readonly string[];
  /** Other entries in the same registry it needs, resolved transitively. */
  readonly registryDeps: readonly string[];
}

/** A registry, as its package ships it. */
export interface RegistryManifest {
  readonly entries: Record<string, RegistryEntry>;
  readonly name: string;
  readonly version: string;
}

/** A registry that has been found on disk. */
export interface Registry {
  /** The directory its files are read from. */
  readonly dir: string;
  readonly manifest: RegistryManifest;
  /** The package it came from. */
  readonly pkg: string;
}

/** Where an app keeps what it has ejected, and what it was told rather than guessed. */
export interface AddConfig {
  /** Where components land, relative to the app root. */
  readonly components: string;
  /** Whether the app has a `sigil.json` saying so, or this was worked out. */
  readonly declared: boolean;
}

export { CONFIG_FILE } from '../config.ts';

/**
 * The app the command is being run against.
 *
 * The nearest `package.json` at or above the directory, because that is what a
 * package manager means by the root and what `node_modules` hangs off. Not
 * `discoverApp()`: that asks whether a directory is a *sigil app* -- an entry,
 * a command tree, a schema it can read -- and `add` needs none of that. A
 * half-built project with a manifest and the runtime installed is exactly when
 * somebody reaches for `sigil add`, and refusing it because there is no
 * `commands/` yet would be refusing the case.
 *
 * @param cwd - Where to start looking.
 * @returns The directory holding the manifest.
 * @throws If there is no manifest at or above it.
 */
export function findAppRoot(cwd: string): string {
  let dir = resolve(cwd);

  for (;;) {
    if (isFile(join(dir, 'package.json'))) {
      return dir;
    }

    const up = dirname(dir);
    // `dirname('/')` is `'/'`, so a loop that relies on finding something is
    // one that can run off the top of the filesystem
    if (up === dir) {
      throw new Error(`No package.json at or above ${displayPath(cwd)}`);
    }
    dir = up;
  }
}

/**
 * Where ejected components land.
 *
 * `sigil.json` is the answer when there is one. Otherwise it is worked out, and
 * the result says which -- because a guess the user cannot see is the kind that
 * costs an afternoon, so the plan prints it either way.
 *
 * The convention follows the app's own shape rather than being fixed: a project
 * with a `src/` puts its code there, and putting components beside it instead
 * would be this tool having an opinion about a layout the app already chose.
 *
 * @param root - The app root.
 * @returns The configured or conventional directory, and which it was.
 */
export function readConfig(root: string): AddConfig {
  // through `readSigilConfig()` rather than reading the file again: one file
  // with two readers is two ideas of what it may contain, and the second one
  // to grow a field is the one that silently ignores the other's
  const { components } = readSigilConfig(root);

  if (components !== undefined) {
    return { components, declared: true };
  }

  return {
    components: isDirectory(join(root, 'src')) ? join('src', 'components') : 'components',
    declared: false,
  };
}

/**
 * Splits `@acme/components/date-picker` into its package and its entry.
 *
 * A bare name is an entry in the default registry, which is the ordinary case
 * and the one worth keeping short. A scoped package takes two segments before
 * the entry begins, which is why this counts rather than splitting on the last
 * slash -- `@acme/components` is a package and `components/date-picker` is not.
 *
 * @param spec - What was typed.
 * @returns The package to resolve, and the entry inside it.
 */
export function parseSpec(spec: string): { entry: string; pkg: string } {
  const parts = spec.split('/');

  if (parts.length === 1) {
    return { entry: spec, pkg: DEFAULT_REGISTRY };
  }

  const take = spec.startsWith('@') ? 2 : 1;

  if (parts.length <= take) {
    throw new Error(`"${escapeControls(spec)}" names a package but no entry inside it`);
  }

  return { entry: parts.slice(take).join('/'), pkg: parts.slice(0, take).join('/') };
}

/**
 * Finds a registry in the app's own dependencies.
 *
 * Resolved through `package.json`, which every package publishes in its
 * `exports` map and which is the one subpath that answers wherever the files
 * actually live. Resolving the package's *main* would import it, which is a
 * registry running code to be read.
 *
 * @param root - The app root, which is where resolution starts.
 * @param pkg - The package to look in.
 * @returns The registry.
 * @throws If the package is not installed, or carries no registry.
 */
export function loadRegistry(root: string, pkg: string): Registry {
  const require = createRequire(join(root, 'package.json'));
  let manifestPath: string;

  try {
    manifestPath = require.resolve(`${pkg}/package.json`);
  } catch {
    throw new Error(
      `${escapeControls(pkg)} is not installed in ${displayPath(root)}. ` +
        `A registry is an ordinary dependency, so install it first.`
    );
  }

  const dir = join(dirname(manifestPath), 'registry');
  const path = join(dir, 'registry.json');

  if (!isFile(path)) {
    throw new Error(
      `${escapeControls(pkg)} is installed but ships no registry, so it has nothing to add`
    );
  }

  // read outside the `try`, so that a file that cannot be read is not reported
  // as one that is not JSON
  const text = readFileSync(path, 'utf-8');
  let manifest: RegistryManifest;
  try {
    manifest = JSON.parse(text) as RegistryManifest;
  } catch (err) {
    // V8's message quotes the text it failed on, and a registry is somebody
    // else's package rather than the app's own file, so it is escaped the way
    // every other value `add` echoes from one is
    throw new Error(
      `${escapeControls(pkg)} ships a registry.json that is not valid JSON: ${escapeControls(errorMessage(err))}`,
      { cause: err }
    );
  }

  if (!manifest.entries || typeof manifest.entries !== 'object') {
    throw new Error(`${escapeControls(pkg)} ships a registry with no entries in it`);
  }

  return { dir, manifest, pkg };
}

/** One file the plan will write. */
export interface PlannedFile {
  /** The entry that brought it, which may not be one that was asked for. */
  readonly entry: string;
  /** Whether something is already there. */
  readonly exists: boolean;
  /** Where it is read from. */
  readonly from: string;
  /** Where it lands, absolute. */
  readonly to: string;
  /** Where it lands, relative to the app, for printing. */
  readonly shown: string;
}

/** What `add` would do, worked out before anything is written. */
export interface Plan {
  /** Every entry being ejected, including ones pulled in as dependencies. */
  readonly entries: readonly string[];
  /** The files, in the order they would be written. */
  readonly files: readonly PlannedFile[];
  /** Entries asked for that the registry does not have. */
  readonly missing: readonly string[];
  /** Entries pulled in because something else needed them. */
  readonly pulled: readonly string[];
}

/**
 * Works out what ejecting these entries would write, and writes nothing.
 *
 * Separate from doing it because `add` puts code into somebody's source tree
 * from a package they installed: what it will write is shown first, and that is
 * only honest if the showing and the doing read the same answer rather than
 * being two walks that agree for now.
 *
 * @param registry - The registry to read from.
 * @param wanted - The entries asked for.
 * @param target - The absolute directory they land in.
 * @param root - The app root, for the paths that get printed.
 * @returns The plan.
 */
export function planAdd(
  registry: Registry,
  wanted: readonly string[],
  target: string,
  root: string
): Plan {
  const entries: string[] = [];
  const missing: string[] = [];
  const pulled: string[] = [];
  const files: PlannedFile[] = [];
  const seen = new Set<string>();

  /** Depth-first so that a dependency is written before what needed it. */
  const visit = (name: string, asked: boolean): void => {
    if (seen.has(name)) {
      return;
    }

    const entry = registry.manifest.entries[name];
    if (!entry) {
      // only what the user actually typed is reported as missing; a broken
      // `registryDeps` is the registry's bug and says so separately
      if (asked) {
        missing.push(name);
      } else {
        throw new Error(
          `${escapeControls(registry.pkg)} says "${escapeControls(name)}" is needed but does not have it, which is a bug in the registry`
        );
      }
      return;
    }

    seen.add(name);

    // dependencies first, so a file is never written before the thing it
    // imports and a half-applied plan is still in a sensible order
    for (const dep of entry.registryDeps) {
      visit(dep, false);
    }

    entries.push(name);
    if (!asked) {
      pulled.push(name);
    }

    for (const file of entry.files) {
      const from = confine(registry, name, 'from', file.from, registry.dir);
      const to = confine(registry, name, 'to', file.to, target);
      files.push({
        entry: name,
        exists: existsSync(to),
        from,
        shown: displayPath(join(relativeTo(root, to))),
        to,
      });
    }
  };

  for (const name of wanted) {
    visit(name, true);
  }

  return { entries, files, missing, pulled };
}

/**
 * One of an entry's paths, joined onto the directory it is relative to, and
 * refused unless it stays there.
 *
 * A registry is somebody else's package, and `from` and `to` are its data: a
 * `from` of `../../../../etc/hosts` and a `to` that climbs out of the app
 * planned a copy of `/etc/hosts` to wherever the second one pointed, and `--yes`
 * wrote it without anybody reading the plan. `join()` normalises, so nothing
 * about joining a path keeps it where it was joined.
 *
 * `from` has to be inside the registry directory, which is what the manifest
 * says it is relative to. `to` has to be inside the **target** -- the directory
 * components land in -- rather than merely inside the app, and that is the
 * reading that works for both ways of naming one: it is what the manifest says
 * `to` is relative to, a registry knows nothing about an app's layout above it,
 * and a `--dir` outside the app is the user asking for exactly that place, where
 * an "inside the app" rule would refuse every file. An absolute path is refused
 * outright rather than joined: on POSIX `join()` would quietly turn
 * `/etc/hosts` into a file under the target, which is a path that means
 * something different from what it says.
 *
 * Refused as a bug in the registry rather than skipped, because the plan is all
 * or nothing: a half-applied entry is a component that does not compile, and
 * a registry shipping one bad path is not one to take the other paths from.
 * Asked here, while planning, so that nothing has been written when it throws.
 *
 * @param registry - The registry, for the message.
 * @param name - The entry, for the message.
 * @param field - Which of the two paths this is.
 * @param path - What the entry says.
 * @param dir - The directory it is relative to, and must stay inside.
 * @returns The joined path.
 * @throws If it is not a relative path inside `dir`.
 */
function confine(
  registry: Registry,
  name: string,
  field: 'from' | 'to',
  path: unknown,
  dir: string
): string {
  if (typeof path === 'string' && path !== '' && !isAbsolute(path)) {
    const joined = join(dir, path);

    if (isInside(dir, joined)) {
      return joined;
    }
  }

  const where = field === 'from' ? 'its registry directory' : 'the components directory';

  throw new Error(
    `${escapeControls(registry.pkg)}'s "${escapeControls(name)}" has a file whose ${field} is ${escapeControls(JSON.stringify(path))}, which is not a path inside ${where}. ` +
      `That is a bug in the registry, and nothing was written.`
  );
}

/** A path relative to the app, kept readable when it escapes the root. */
function relativeTo(root: string, path: string): string {
  const rel = resolve(path).startsWith(resolve(root))
    ? resolve(path).slice(resolve(root).length + 1)
    : path;
  return rel || path;
}
