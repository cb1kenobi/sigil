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
 * `readdir`, a `stat`, and at most one `package.json` read, which is what lets
 * the build ask about a tree it is compiling and the runtime ask about a level
 * it is about to match.
 */

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

/** What kind of thing a route is, which is what says how to load it. */
export type RouteKind = 'directory' | 'module' | 'package';

/** One route in a command directory. */
export interface Route {
	/**
	 * What the route says it does, which only a package can answer here.
	 *
	 * A package describes itself in its `package.json`, so its description is a
	 * file read rather than an import. Every other kind keeps its description
	 * inside the module, which is why it is `undefined` here and why the build
	 * has to lift it statically.
	 */
	readonly desc?: string;
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
	/** Every route inside, sorted, with no two claiming one name. */
	readonly routes: readonly Route[];
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
 * @returns One route per entry that is one, sorted, names unique.
 */
export function resolveRoutes(dir: string, entries: Dirent[]): readonly Route[] {
	const claimed = new Map<string, string>();
	const routes: Route[] = [];

	// sorted, because `readdir` order is the file system's, and a registry whose
	// order depends on that is the thing `CommandRegistry.add()` already sorts
	// names to avoid reporting
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
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

		routes.push(route);
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
 * @returns Its routes and its own `index` module, or `undefined` when the path
 *   is not a directory at all.
 */
export function readRoutes(dir: string): DirectoryRoutes | undefined {
	const entries = readDirectory(dir);
	if (!entries) {
		return undefined;
	}

	return { index: indexEntry(dir, entries), routes: resolveRoutes(dir, entries) };
}
