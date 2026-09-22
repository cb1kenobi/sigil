/**
 * `sigil check`: read an app and say what is wrong with it.
 *
 * Everything `sigil build` has to know before it can bundle anything --
 * does the app type-check, does its `commands/` tree resolve, and can every
 * description be read statically -- asked on its own and reported. It is the
 * fast inner loop `tsc --noEmit` and `astro check` are, and it stays that once
 * building exists rather than being a placeholder for it: `build` will run this
 * and then compile, so a failure here is a failure there and the two cannot
 * come to disagree about what a valid app is.
 *
 * ## It reports rather than refuses
 *
 * A description nobody could read is a `warning`: the command keeps exactly the
 * help it would have had unbundled, which is none until its module loads. A
 * type error, a module with no default export, a directory two routes both
 * claim -- those are errors, because each is an app that would be wrong once
 * built. `isFatal()` is what decides, in one place, so `check` and `build`
 * cannot disagree about what stops a build either.
 *
 * ## Why the module is loaded rather than declared inline
 *
 * The schema declares `check` with a `desc` and a `load`, which is the same
 * shape `sigil build` generates for an app's own commands -- and the reason is
 * the one the build exists for. This module pulls in `oxc-parser`, which is a
 * native binary; leaving it on the startup path would make `sigil --version`
 * pay for a parser it never uses. The `desc` sits on the placeholder so that
 * `sigil --help` can describe the command without loading any of that, which is
 * precisely the problem the static `desc` lift solves for an app.
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
} from '../build/index.js';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { table } from '@ttylabs/sigil/components';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * Annotated rather than inferred, which `--isolatedDeclarations` requires of a
 * default export. Nothing is lost by it: `command()` has already typed this
 * literal's own `run`, and a command loaded from a module is one whose `argv`
 * inference the schema above could not have seen into anyway.
 *
 * `AnyCommand` rather than `Command`, for the reason that type exists: a
 * command whose `run` takes a narrow `argv` is not assignable to one whose
 * `run` takes the wide default, because a function parameter is contravariant.
 */
const check: AnyCommand = command({
	args: [{ desc: "The app's root, defaulting to the working directory", name: '[dir]' }],
	options: {
		'--commands [dir]': {
			desc: "The app's command directory, when its entry does not say",
		},
		'--entry [file]': {
			desc: "The module declaring the app's schema, when the conventions find the wrong one",
		},
		'--tree': {
			desc: 'Print the command tree as it resolved',
			type: 'bool',
		},
	},

	run({ argv }) {
		const cwd = resolve(String(argv.dir ?? '.'));
		const diagnostics: Diagnostic[] = [];

		// the app before anything else: a directory that does not depend on the
		// runtime is not one this can check, and saying so is more use than
		// reporting that it has no `commands/` directory
		const app = discoverApp(cwd, { entry: argv.entry as string | undefined });

		// the type check answers for the whole app rather than for the routes, so
		// it runs whatever the tree turns out to be
		const types = typeCheck({ cwd: app.root });
		diagnostics.push(...types.diagnostics);

		const commands = findCommands(app, argv.commands as string | undefined, diagnostics);

		if (argv.tree) {
			printTree(commands, app.root);
		}

		return report({ app, commands, diagnostics, types });
	},
});

export default check;

/**
 * Where the app's commands are, and what is in them.
 *
 * Three ways in, and the order is the one that respects what the caller said:
 * a `--commands` directory is an instruction, the entry's own `commands` is the
 * app speaking for itself, and neither leaves nothing to check.
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
 * acceptance test: a framework whose toolchain is not written in it has not
 * been tested by anyone who had to live with it. It also gets the column
 * arithmetic right for free, which is the whole reason that component exists.
 *
 * On stdout rather than stderr, because it is data somebody asked for -- the
 * diagnostics go the other way, so `sigil check --tree` can be piped without
 * losing the problems.
 *
 * @param commands - The tree.
 * @param root - What to write paths relative to.
 */
function printTree(commands: readonly ResolvedCommand[], root: string): void {
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
 * Writes everything that was found, and says whether it was fatal.
 *
 * The entry is named in the summary because choosing it is a heuristic --
 * source conventions before the manifest -- and a guess nobody can see is the
 * kind that costs an afternoon.
 *
 * @param found - The app, its commands, the diagnostics, and the type check.
 * @throws If anything fatal was found. `main()` renders the message and sets a
 *   non-zero exit code, which is what makes this usable in CI.
 */
function report(found: {
	app: DiscoveredApp;
	commands: readonly ResolvedCommand[];
	diagnostics: readonly Diagnostic[];
	types: { checked: boolean; skipped?: string };
}): void {
	const { app, commands, diagnostics, types } = found;
	const { root } = app;

	// relative to the app, because an absolute path per line is mostly the same
	// prefix repeated and the interesting part is at the end of it
	const show = (file: string) => relative(root, file) || '.';

	for (const diagnostic of diagnostics) {
		process.stderr.write(`${formatDiagnostic({ ...diagnostic, file: show(diagnostic.file) })}\n`);
	}

	const errors = diagnostics.filter((d) => d.severity === 'error').length;
	const warnings = diagnostics.length - errors;
	const total = [...walkTree(commands)].length;

	if (!types.checked && types.skipped) {
		process.stderr.write(`\nNot type-checked: ${types.skipped}\n`);
	}

	if (isFatal(diagnostics)) {
		// thrown rather than written, so the exit code and the rendering are
		// `main()`'s the way they are for every other command
		throw new Error(
			`${errors} error${errors === 1 ? '' : 's'}${warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''} in ${app.manifest.name ?? root}`
		);
	}

	const counted = `${total} command${total === 1 ? '' : 's'}`;
	const named = `${app.manifest.name ?? root} (${show(app.entry)})`;
	process.stderr.write(
		warnings
			? `\n${named}: ${counted}, ${warnings} warning${warnings === 1 ? '' : 's'}\n`
			: `\n${named}: ${counted}, no problems found\n`
	);
}
