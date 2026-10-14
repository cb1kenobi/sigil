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
 * ## Templates are compiled and the utility sheet is shaken
 *
 * A `ui` template is compiled into the module it was written in, by a rolldown
 * `transform` -- so the tag, the parser and the IR walk shake out of the bundle,
 * and the summary says how many were compiled. What that buys is the *bundle*
 * and not the first frame: a template parse is 1.6us, so the startup cost it was
 * supposed to remove was never there.
 *
 * The stylesheet half is the same shape and the same answer. A second transform
 * rewrites `utilitySheet()` to hold only the rules the app's own source could
 * name, so 383 rules become the dozen an app uses and `UTILITY_CSS` leaves the
 * bundle entirely. What it is *not* is the sheet emitted as data, which SIG-115
 * asked for and which was measured and refused: 13.3 kB of CSS is 103 kB of JS
 * literal against a 9.1 kB parser, so it trades 90 kB for half a millisecond.
 * See `shake.ts`.
 *
 * Both are pure optimizations: an app builds and runs correctly without either.
 */

import {
	bundleApp,
	type BuiltChunk,
	displayPath,
	type InlinedPackage,
	type ResolvedTree,
	type ShakenStyles,
} from '../build/index.ts';
import { readSigilConfig } from '../config.ts';
import { reportLevel, writeNote, writeSummary } from '../report.ts';
import {
	appRuns,
	countCommands,
	failure,
	inspect,
	reportDiagnostics,
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
		'--no-shake': {
			desc: 'Keep every utility rule, rather than only the ones the source can name',
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
		// compared against rather than read for absence.
		//
		// The same imprecision is sharper for a **flag**, and it is worth saying
		// rather than leaving to be found: a declared flag always has a value --
		// `false`, or `true` when negated, never `undefined` -- so an explicit
		// `--shake` is indistinguishable from the default and cannot beat a
		// `"shake": false` in the file. `--no-shake` over a `"shake": true` works,
		// which is the direction that matters, because off is the only thing
		// either flag is offered for. Telling the two apart means re-reading argv
		// for a spelling, which is a second parser disagreeing with the first over
		// a case nobody has. `--sourcemap` is the same and always was.
		const sigilConfig = readSigilConfig(found.app.root);
		const config = sigilConfig.build ?? {};
		const out = resolveOut(
			found.app.root,
			String(argv.out === DEFAULT_OUT ? (config.out ?? DEFAULT_OUT) : argv.out)
		);

		clean(out, found.app.root, argv.clean !== false);

		const result = await bundleApp({
			app: found.app,
			bin,
			binName: binName(found, (argv.name as string | undefined) ?? config.name),
			defaultLocale: sigilConfig.locale,
			external: (argv.external as string[] | undefined) ?? config.external ?? [],
			out,
			safelist: config.safelist,
			shake: argv.shake !== false && config.shake !== false,
			sourcemap: argv.sourcemap !== false && config.sourcemap !== false,
			tree: { commands: found.commands, diagnostics: [] } satisfies ResolvedTree,
		});

		printSizes(result.chunks);
		printInlined(result.inlined);
		warnEmptyShake(result.styles);

		const total = countCommands(found.commands);

		writeSummary(
			[
				...appRuns(found.app),
				`${total} command${total === 1 ? '' : 's'}${
					result.templates
						? ` and ${result.templates} template${result.templates === 1 ? '' : 's'}`
						: ''
				} into`,
				// the comma rides on this run rather than being one of its own,
				// because a run is a *word*: a lone comma would be drawn with a space
				// in front of it. And it is a comma rather than a parenthetical
				// because the runs are joined by a space off a terminal, and `, N
				// warnings` is what `main` wrote -- the byte-for-byte promise covers
				// `build` as well as `check`
				`${displayPath(relative(found.app.root, result.bin) || result.bin)}${
					result.styles || counts.warnings ? ',' : ''
				}`,
				// only when a sheet was actually shaken, which is only when the app
				// called `utilitySheet()`: saying nothing is the right answer for an
				// app with no utility sheet in its bundle, and `383 of 383` would be
				// a sentence about a sheet that is not there
				...(result.styles
					? [
							`${result.styles.kept} of ${result.styles.total} utility rules${
								counts.warnings ? ',' : ''
							}`,
						]
					: []),
				...(counts.warnings
					? [
							{
								class: 'cli-warning sigil-warn',
								text: `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`,
							},
						]
					: []),
			],
			process.stderr
		);
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
 * Writes what the bundle inlined, which is what the app's own imports cost.
 *
 * The zero-dependency promise is about what *sigil* adds; everything an app
 * imports is in the executable, and a build that silently inlines a
 * two-megabyte library has told the author nothing they could act on. This is
 * the plain statement SIG-73 asked for and SIG-115 carried.
 *
 * Beside the chunk table rather than folded into it, because the two answer
 * different questions: one is what loads when, and this is what is in it. The
 * column is called `Code` rather than `Size` for the same reason -- these are
 * pre-minification bytes and the chunk sizes are not, so they deliberately do
 * not add up to each other, and `inlinedPackages()` records why there is no
 * per-package number on the other side of the minifier.
 *
 * @param inlined - The packages, largest first.
 */
function printInlined(inlined: readonly InlinedPackage[]): void {
	if (!inlined.length) {
		return;
	}

	process.stdout.write(
		`${table(
			inlined.map((pkg) => [pkg.name, `${(pkg.bytes / 1024).toFixed(1)} kB`]),
			{
				colorLevel: reportLevel(process.stdout),
				columns: ['Inlined', { align: 'right', header: 'Code' }],
			}
		)}\n`
	);
}

/**
 * Says so when shaking kept nothing at all.
 *
 * The count in the summary is what makes shaking visible, and a count of zero
 * is the one value it cannot speak for itself: an app that asked for the
 * utility sheet and named none of it is either carrying a call it no longer
 * uses, or naming its classes in a way the scan cannot see -- and the second is
 * exactly the unsound case, arriving as a layout that is subtly wrong with
 * nothing to point at. Both are worth a sentence, and they have the same two
 * answers.
 *
 * A note rather than a diagnostic, and no file or line, because there is
 * nothing to point at: the finding is an absence spread over the whole app, and
 * a diagnostic that named the `utilitySheet()` call would be pointing at the
 * one line that is certainly right.
 *
 * @param styles - What shaking came to, or nothing when it did not shake.
 */
function warnEmptyShake(styles: ShakenStyles | undefined): void {
	if (!styles || styles.kept > 0) {
		return;
	}

	writeNote(
		[
			{ class: 'cli-warning sigil-warn', text: 'No utility class is named anywhere in this app,' },
			`so all ${styles.total} rules were dropped from the sheet it asked for.`,
			'If its classes are built out of values that are never literals in the source,',
			'name them in "build.safelist" in sigil.json, or pass --no-shake.',
		],
		process.stderr
	);
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
