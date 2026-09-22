/**
 * Type-checking the app, with the app's own compiler.
 *
 * SIG-73 left this open -- "does `build` type-check, or is that the app's own
 * `tsc`? Delegating is simpler and faster" -- and the answer is that it type-
 * checks. An app that builds and then fails its own `tsc` has been told it is
 * fine by the tool whose job is to say so, and "simpler and faster" is not
 * worth that. It is a gate rather than a pass that produces anything: nothing
 * here emits, because Node strips types on its own and the bundler handles the
 * rest.
 *
 * ## The app's compiler, not the toolchain's
 *
 * `typescript` is an **optional peer dependency** and is resolved from the app
 * directory. The alternative -- bundling a TypeScript with `@ttylabs/cli` --
 * type-checks the app with a compiler the app never chose, so the build
 * disagrees with the editor and with CI about a program neither of them
 * changed. A version skew in a type checker is not a small disagreement: it is
 * new errors on code that was fine, or silence on code that is not.
 *
 * ## The CLI, not the programmatic API, and that is a version decision
 *
 * TypeScript 7 is the native port and its root export is a version string:
 * `createProgram` is gone, and its replacement lives under `typescript/unstable/`
 * and says so in the specifier. TypeScript 5 and 6 have the old API and not the
 * new one. Supporting an app on any of the three through the programmatic API
 * means two adapters, one of them written against a surface that has announced
 * it will move.
 *
 * `tsc --noEmit` is the one interface all three have, it has not changed in a
 * decade, and it is the same command the app's own `type-check` script runs --
 * so the build agrees with CI by construction rather than by coincidence.
 *
 * Spawning is the *build's* to do, and the one-process rule is about the
 * *output*: nothing `sigil build` emits may spawn anything. A compiler invoking
 * a compiler is ordinary, and this one is invoked once.
 *
 * The binary is run as `node <path-to-bin/tsc>` rather than executed directly,
 * because `bin/tsc` is a plain Node script with a shebang -- and a shebang is
 * not how anything starts on Windows.
 */

import { type Diagnostic, type Severity } from './diagnostic.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The config file an app is checked against, when it does not name one. */
const TSCONFIG = 'tsconfig.json';

/** How to type-check. */
export interface TypeCheckOptions {
	/** The app's root, which is where its compiler and config are looked for. */
	readonly cwd: string;
	/**
	 * The config file, when it is not `tsconfig.json` in the app's root.
	 *
	 * Relative paths resolve against `cwd`.
	 */
	readonly project?: string;
	/**
	 * The `tsc` entry to run, when it should not be the app's own.
	 *
	 * For a test, and for an app whose compiler is somewhere this cannot find.
	 * Not a thing to reach for otherwise -- the whole point is that the build
	 * checks with what the app checks with.
	 */
	readonly tsc?: string;
}

/** What type-checking found, or why it did not happen. */
export interface TypeCheckResult {
	/** Whether a check actually ran. */
	readonly checked: boolean;
	/** What it found, empty when it passed or did not run. */
	readonly diagnostics: readonly Diagnostic[];
	/** Why no check ran, when none did. */
	readonly skipped?: string;
}

/**
 * `file(line,col): error TS2322: message`, which is what `--pretty false`
 * writes.
 *
 * The code is kept in the message rather than given a field of its own: it is
 * part of what the compiler tells the author, and it is what they will search
 * for.
 */
const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .*)$/;

/** A diagnostic with no file in front of it, such as a bad config option. */
const GLOBAL_RE = /^(error|warning) (TS\d+: .*)$/;

/**
 * Type-checks an app.
 *
 * @param options - Where the app is, and what to check it with.
 * @returns What it found, or why nothing ran.
 */
export function typeCheck(options: TypeCheckOptions): TypeCheckResult {
	const { cwd } = options;

	const project = options.project
		? isAbsolute(options.project)
			? options.project
			: resolve(cwd, options.project)
		: join(cwd, TSCONFIG);

	// looked for in the app's root and nowhere above it. `tsc` itself walks up,
	// and walking up here would find a monorepo's own config -- whose `include`
	// describes a different program entirely, so the build would report errors
	// about files the app does not contain and miss the ones it does
	if (!existsSync(project)) {
		return {
			checked: false,
			diagnostics: [],
			skipped: `no ${options.project ?? TSCONFIG} in ${cwd}, so there is nothing to type-check`,
		};
	}

	// an override that is not there is the caller's mistake, and it is worth
	// naming: left to the spawn it comes back as a non-zero exit with "Cannot
	// find module" on stderr, which reads as the app failing to type-check
	if (options.tsc !== undefined && !existsSync(options.tsc)) {
		throw new Error(`Failed to run the type checker at ${options.tsc}: no such file`);
	}

	const tsc = options.tsc ?? findTsc(cwd);
	if (!tsc) {
		return {
			checked: false,
			diagnostics: [],
			skipped: `${project} exists but typescript could not be resolved from ${cwd}; add it as a devDependency to have the build type-check`,
		};
	}

	// `node <bin>` rather than the bin itself: it is a Node script behind a
	// shebang, and a shebang is not how anything starts on Windows
	const run = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', project], {
		cwd,
		encoding: 'utf-8',
	});

	if (run.error) {
		throw new Error(`Failed to run the type checker at ${tsc}: ${run.error.message}`);
	}

	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	const diagnostics = parseDiagnostics(output, cwd);

	// a non-zero exit with nothing parseable behind it is the compiler refusing
	// to run rather than the app failing to check -- a `composite` project that
	// cannot be told `--noEmit`, an option this build passed that it does not
	// know. Swallowing that would report a clean type-check for a check that
	// never happened, so the raw output becomes the diagnostic
	if (run.status !== 0 && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
		return {
			checked: true,
			diagnostics: [
				...diagnostics,
				{
					file: project,
					message: `the type checker exited ${run.status ?? 'without a status'} without reporting a diagnostic:\n${output.trim() || '(no output)'}`,
					severity: 'error',
				},
			],
		};
	}

	return { checked: true, diagnostics };
}

/**
 * The app's own `tsc`, or `undefined` when it has none.
 *
 * Resolved from the app rather than from here, which is the whole point: a
 * build that checked with its own TypeScript would disagree with the app's
 * editor about a program neither of them changed.
 *
 * @param cwd - The app's root.
 * @returns The path to its `tsc` entry.
 */
function findTsc(cwd: string): string | undefined {
	// resolution is relative to a *file*, and the app root may hold no module
	// this can name -- so a path that need not exist stands in for one
	const require = createRequire(join(cwd, 'noop.js'));

	let manifestPath;
	try {
		manifestPath = require.resolve('typescript/package.json');
	} catch {
		// the app has no typescript, which for a JavaScript app is correct
		return undefined;
	}

	try {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
			bin?: string | Record<string, string>;
		};
		const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsc;

		if (!bin) {
			return undefined;
		}

		const entry = resolve(dirname(manifestPath), bin);
		return existsSync(entry) ? entry : undefined;
	} catch {
		// a manifest that will not parse is not a compiler
		return undefined;
	}
}

/**
 * Reads what `--pretty false` wrote.
 *
 * @param output - Everything the compiler printed.
 * @param cwd - What its relative paths are relative to.
 * @returns One diagnostic per line it recognised.
 */
function parseDiagnostics(output: string, cwd: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const line of output.split('\n')) {
		const located = DIAGNOSTIC_RE.exec(line);
		if (located) {
			const [, file, row, column, severity, message] = located;
			diagnostics.push({
				column: Number(column),
				// the compiler is run with the app as its cwd, so its paths are
				// relative to that; absolute is what a diagnostic from any other pass
				// carries, and one report holding both spellings is one nobody can sort
				file: resolve(cwd, file!),
				line: Number(row),
				message: message!,
				severity: severity as Severity,
			});
			continue;
		}

		const global = GLOBAL_RE.exec(line);
		if (global) {
			const [, severity, message] = global;
			diagnostics.push({ file: cwd, message: message!, severity: severity as Severity });
		}
	}

	return diagnostics;
}
