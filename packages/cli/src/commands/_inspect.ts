/**
 * Reading an app, for the two commands that both have to.
 *
 * `check` is this and a report. `build` is this, the same report, and then a
 * bundle -- which is why it is one module rather than two implementations that
 * agree for now: a failure in `check` has to be a failure in `build`, or the
 * two come to disagree about what a valid app is and the fast one stops meaning
 * anything.
 *
 * The `_` prefix is this repo's own rule, read from the inside: an entry in a
 * commands directory that starts with one is not a route. Nothing walks
 * `src/commands/` today -- the toolchain's schema is written out -- but it will
 * once the CLI routes itself, and a helper that quietly became a command called
 * `_inspect` is exactly the footgun the prefix was invented for.
 */

import {
	discoverApp,
	formatDiagnostic,
	isFatal,
	readAppCommands,
	resolveCommandTree,
	typeCheck,
	walkTree,
	type Diagnostic,
	type DiscoveredApp,
	type ResolvedCommand,
	type TypeCheckResult,
} from '../build/index.js';
import { table } from '@ttylabs/sigil/components';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** What reading an app turned up. */
export interface Inspection {
	/** The app, and the entry the conventions chose. */
	readonly app: DiscoveredApp;
	/** Its commands, however its schema declares them. */
	readonly commands: readonly ResolvedCommand[];
	/** Everything worth saying, in the order it was found. */
	readonly diagnostics: readonly Diagnostic[];
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

	const commands = findCommands(app, options.commands, diagnostics);

	return { app, commands, diagnostics, types };
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
 * @returns The commands.
 */
function findCommands(
	app: DiscoveredApp,
	named: string | undefined,
	diagnostics: Diagnostic[]
): readonly ResolvedCommand[] {
	if (named !== undefined) {
		return walkCommandDir(resolve(app.root, named), diagnostics);
	}

	const declared = readAppCommands(app);
	diagnostics.push(...declared.diagnostics);

	if (!declared.commands) {
		// only when the entry declared none at all: one it declared and this could
		// not read has already been reported, and saying it again here would get
		// the second telling wrong
		if (!declared.found) {
			diagnostics.push({
				file: app.entry,
				message:
					'no "commands" found in this module; pass --entry to name the one declaring the schema, or --commands to name a command directory',
				severity: 'error',
			});
		}
		return [];
	}

	// a path is the filesystem router, which is a tree to walk; an object is the
	// app having written its commands out, which is already the tree
	return declared.commands.kind === 'directory'
		? walkCommandDir(declared.commands.dir, diagnostics)
		: declared.commands.commands;
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
		diagnostics.push({ file: dir, message: (<Error>e).message, severity: 'error' });
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
		cmd.module ? relative(root, cmd.module) : `(${cmd.kind}, nothing to run)`,
		cmd.desc ?? '',
	]);

	if (rows.length) {
		process.stdout.write(`${table(rows, { columns: ['Command', 'Module', 'Description'] })}\n`);
	}
}

/**
 * Writes every diagnostic, and says whether any of them was fatal.
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

	// relative to the app, because an absolute path per line is mostly the same
	// prefix repeated and the interesting part is at the end of it
	for (const diagnostic of diagnostics) {
		process.stderr.write(
			`${formatDiagnostic({ ...diagnostic, file: relative(app.root, diagnostic.file) || '.' })}\n`
		);
	}

	if (!types.checked && types.skipped) {
		process.stderr.write(`\nNot type-checked: ${types.skipped}\n`);
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
 * How an app is named in a summary line.
 *
 * The entry is in it because choosing one is a heuristic -- source conventions
 * before the manifest -- and a guess nobody can see is the kind that costs an
 * afternoon.
 *
 * @param app - The app.
 * @returns Its name and the entry that was read.
 */
export function describeApp(app: DiscoveredApp): string {
	return `${app.manifest.name ?? app.root} (${relative(app.root, app.entry) || app.entry})`;
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
