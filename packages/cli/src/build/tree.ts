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
 * ## Eager here, lazy in what it emits
 *
 * Reading everything is what a compiler does; making the *output* read
 * everything would throw away the deferral. So each command becomes a `load`
 * -- a function that imports its module -- and the tree itself is data. A
 * built `mycli --help` walks a literal and imports nothing.
 */

import type { Diagnostic } from './diagnostic.ts';
import { factsOf, type CommandFacts } from './extract.ts';
import { parseModule } from './parse-module.ts';
import { readPackage, readRoutes, type Route, type RouteKind } from '@ttylabs/sigil/routes';
import { readFileSync } from 'node:fs';

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
	/** Its subcommands, resolved the same way, sorted as the routes were. */
	readonly commands: readonly ResolvedCommand[];
	/** What it does, lifted from its module or read from its manifest. */
	readonly desc?: string;
	/** Whether it hides itself, lifted from its module. */
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

	// the root's own `index` is deliberately not read: a bare
	// `commands: './commands'` has no directory command for an index to *be* --
	// its own command is the schema -- which is the rule the runtime's walk
	// already follows. A subdirectory's index is a different thing, and
	// `resolve()` below is where it becomes that subdirectory's command
	return found.routes.map((route) => resolve(route, diagnostics, facts));
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
function resolve(route: Route, diagnostics: Diagnostic[], facts: boolean): ResolvedCommand {
	if (route.kind === 'directory') {
		// read once and used twice, for its routes and for its index: reading it
		// again per half is the cost the runtime's own walk is careful to pay only
		// once, in the comment that says both halves come from one `readdir`
		const inside = readRoutes(route.path);
		if (!inside) {
			throw new Error(`Command directory not found: ${route.path}`);
		}

		return {
			commands: inside.routes.map((child) => resolve(child, diagnostics, facts)),
			...(inside.index ? read(inside.index, diagnostics, facts) : {}),
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
	if (route.kind === 'package') {
		return {
			commands: [],
			desc: route.desc,
			kind: route.kind,
			module: route.path,
			name: route.name,
		};
	}

	return {
		commands: [],
		...read(route.path, diagnostics, facts),
		kind: route.kind,
		module: route.path,
		name: route.name,
	};
}

/**
 * Reads one module for what it says about itself.
 *
 * @param file - The module.
 * @param diagnostics - Where to report.
 * @param facts - Whether to read it at all.
 * @returns Its facts, or nothing when reading is off.
 */
function read(file: string, diagnostics: Diagnostic[], facts: boolean): CommandFacts {
	if (!facts) {
		return {};
	}

	const parsed = parseModule(file, readFileSync(file, 'utf-8'));
	const extracted = factsOf(parsed);

	diagnostics.push(...extracted.diagnostics);

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
