/**
 * `sigil build`: one process in, zero dependencies out.
 *
 * The command the whole toolchain exists for. It reads the app the way `check`
 * does -- the same pass, through `_inspect.ts`, so the two cannot disagree
 * about what a valid app is -- and then bakes the command tree into a generated
 * executable and bundles the lot.
 *
 * ## It refuses to build an app that does not check out
 *
 * `check` first, always. Bundling an app with a type error produces an
 * executable nobody should run, and finding out at run time what a compiler
 * knew at build time is the thing a build is for. Warnings do not stop it: a
 * description the build could not read leaves a command exactly where an
 * unbundled one is, which is a thing to know rather than a thing to fail over.
 *
 * ## Nothing in the output spawns anything
 *
 * A subcommand that spawned would be a second Node startup, a lost stdio
 * inheritance problem and a broken exit code waiting to happen. Commands are
 * dynamic imports, which is what makes the chunks work and what makes a shared
 * component tree possible at all.
 *
 * ## What it does not do yet
 *
 * Templates and stylesheets are compiled at run time still. Both are pure
 * optimizations -- the `ui` tag works, a stylesheet parses at startup -- so an
 * app builds and runs correctly without them, and they make the first frame
 * faster when they land.
 */

import { bundleApp, type BuiltChunk, displayPath, type ResolvedTree } from '../build/index.ts';
import { readSigilConfig } from '../config.ts';
import { reportLevel } from '../report.ts';
import {
	appRuns,
	countCommands,
	failure,
	inspect,
	reportDiagnostics,
	writeSummary,
	type Inspection,
} from './_inspect.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { table } from '@ttylabs/sigil/components';
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Where a build goes when nobody says otherwise. */
const DEFAULT_OUT = 'dist';

/** See `check.ts` for why this is annotated, and why `AnyCommand`. */
const build: AnyCommand = command({
	args: [{ desc: "The app's root, defaulting to the working directory", name: '[dir]' }],
	desc: 'Build an app into a bundle that depends on nothing',
	options: {
		'--bin [file]': {
			desc: 'An executable of your own, bundled instead of a generated one',
		},
		'--commands [dir]': {
			desc: "The app's command directory, when its entry does not say",
		},
		'--entry [file]': {
			desc: "The module declaring the app's schema, when the conventions find the wrong one",
		},
		'--external [pkg]': {
			desc: 'A package to import rather than inline, for one carrying a native binding',
			multiple: true,
		},
		'--name [name]': {
			desc: 'What the built executable is called. Defaults to the name in package.json',
		},
		'--no-clean': {
			desc: 'Keep what is already in the output directory',
		},
		'--no-sourcemap': {
			desc: 'Skip the sourcemaps, which are several times the size of the code',
		},
		'--out [dir]': {
			default: DEFAULT_OUT,
			desc: 'Where the bundle goes, relative to the app',
		},
	},

	async run({ argv }) {
		const found = inspect({
			commands: argv.commands as string | undefined,
			cwd: String(argv.dir ?? '.'),
			entry: argv.entry as string | undefined,
		});

		const counts = reportDiagnostics(found);
		if (counts.fatal) {
			throw failure(found, counts);
		}

		const bin = argv.bin === undefined ? undefined : resolve(found.app.root, String(argv.bin));
		assertBuildable(found, bin);

		// a flag beats the file, which beats the default: `sigil.json` says what
		// this app is always built with, and a flag says what this invocation
		// wants. `--out` carries a `default:`, so what it holds when nobody
		// passed it is that default rather than `undefined` -- which is why it is
		// compared against rather than read for absence
		const config = readSigilConfig(found.app.root).build ?? {};
		const out = resolveOut(
			found.app.root,
			String(argv.out === DEFAULT_OUT ? (config.out ?? DEFAULT_OUT) : argv.out)
		);

		clean(out, found.app.root, argv.clean !== false);

		const result = await bundleApp({
			app: found.app,
			bin,
			binName: binName(found, (argv.name as string | undefined) ?? config.name),
			external: (argv.external as string[] | undefined) ?? config.external ?? [],
			out,
			sourcemap: argv.sourcemap !== false && config.sourcemap !== false,
			tree: { commands: found.commands, diagnostics: [] } satisfies ResolvedTree,
		});

		printSizes(result.chunks);

		const total = countCommands(found.commands);

		writeSummary([
			...appRuns(found.app),
			`${total} command${total === 1 ? '' : 's'} into`,
			displayPath(relative(found.app.root, result.bin) || result.bin),
			...(counts.warnings
				? [
						{
							class: 'cli-warning',
							text: `(${counts.warnings} warning${counts.warnings === 1 ? '' : 's'})`,
						},
					]
				: []),
		]);
	},
});

export default build;

/**
 * Refuses the combinations that would produce an executable that cannot work.
 *
 * A `--bin` of the app's own is bundled as it stands, so whatever `commands` it
 * declares is what it gets -- and a filesystem router bundled that way reads
 * directories that are not there beside the executable. That is a run-time
 * failure the build can see coming, which makes it a build error: the generated
 * entry exists precisely so the tree can be baked, and an app using both is
 * asking for two answers.
 *
 * @param found - What reading the app turned up.
 * @param bin - The executable the caller named, if any.
 * @throws If the pair cannot produce a working app.
 */
function assertBuildable(found: Inspection, bin: string | undefined): void {
	if (!bin) {
		return;
	}

	// `kind` is `inline` for a command the schema wrote out and one of the route
	// kinds for one a directory walk found -- so a walked tree beside a `--bin`
	// is the router, which cannot survive bundling
	const walked = found.commands.find((cmd) => cmd.kind !== 'inline');
	if (walked) {
		throw new Error(
			`Cannot combine --bin with a filesystem command directory: "${walked.name}" was found by walking, and a built executable has no directories to walk. Write the commands out in the schema, or drop --bin and let the build generate the executable.`
		);
	}
}

/**
 * What the built executable is called.
 *
 * The `bin` key an app already declares, since that is the name its users type.
 * A package name is the fallback, scope dropped -- `@ttylabs/cli` builds to
 * `cli.mjs` rather than to a directory called `@ttylabs`.
 *
 * @param found - What reading the app turned up.
 * @param named - What the caller said, if anything.
 * @returns The name, without an extension.
 */
function binName(found: Inspection, named: string | undefined): string {
	if (named) {
		return named;
	}

	// what the manifest's `bin` says, before what it calls itself: a scoped
	// package's name is not its executable's -- `@ttylabs/cli` publishes `sigil`,
	// and naming the file after the package writes one the manifest does not
	// point at
	const { bin, name } = found.app.manifest;
	if (bin) {
		return bin;
	}

	return name ? (name.split('/').pop() ?? name) : 'cli';
}

/**
 * Where the bundle goes.
 *
 * @param root - The app's root.
 * @param out - What the caller said.
 * @returns The absolute directory.
 */
function resolveOut(root: string, out: string): string {
	return isAbsolute(out) ? out : resolve(root, out);
}

/**
 * Writes what the build produced and what each piece costs.
 *
 * Startup time is the metric the whole design is pointed at, so what loads on
 * the fast path and what does not is worth saying rather than leaving somebody
 * to stat the directory. The entry is what `--help` pays for; every chunk below
 * it is a command that loads only when argv names it.
 *
 * @param chunks - What was written, largest first.
 */
function printSizes(chunks: readonly BuiltChunk[]): void {
	const rows = chunks
		.filter((chunk) => !chunk.name.endsWith('.map'))
		.map((chunk) => [
			chunk.name,
			`${(chunk.size / 1024).toFixed(1)} kB`,
			chunk.entry ? 'entry' : 'lazy',
		]);

	if (rows.length) {
		process.stdout.write(
			`${table(rows, {
				// stdout's level rather than the process styler's, for the reason
				// `printTree()` records: the default reads stdout whoever is asking
				colorLevel: reportLevel(process.stdout),
				columns: ['File', { align: 'right', header: 'Size' }, 'Loads'],
			})}\n`
		);
	}
}

/**
 * Empties the output directory before writing to it.
 *
 * A build that leaves the last one behind is a directory nobody can read: a
 * renamed command's chunk stays, a removed one's stays, and what is published
 * is the union of every build ever run there. Every bundler does this, and
 * doing it here rather than in a `rimraf` beside the call is what makes
 * `sigil build` the whole of the build.
 *
 * Refused for the app root itself or anything above it, which is the one way a
 * mistyped `--out` turns a build into data loss. `--no-clean` opts out for a
 * caller writing into a directory that holds something else.
 *
 * @param out - The output directory.
 * @param root - The app root, which bounds what may be removed.
 * @param wanted - Whether to clean at all.
 * @throws If the directory is one that must not be emptied.
 */
function clean(out: string, root: string, wanted: boolean): void {
	if (!wanted || !existsSync(out)) {
		return;
	}

	const resolved = resolve(out);
	const app = resolve(root);

	if (resolved === app || app.startsWith(`${resolved}${sep}`)) {
		throw new Error(
			`Refusing to empty ${displayPath(resolved)}, which holds the app itself. ` +
				`Name a directory inside it, or pass --no-clean.`
		);
	}

	rmSync(resolved, { force: true, recursive: true });
}
