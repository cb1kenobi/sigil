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
import {
	countCommands,
	describeApp,
	failure,
	inspect,
	reportDiagnostics,
	type Inspection,
} from './_inspect.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { table } from '@ttylabs/sigil/components';
import { isAbsolute, relative, resolve } from 'node:path';

/** Where a build goes when nobody says otherwise. */
const DEFAULT_OUT = 'dist';

/** See `check.ts` for why this is annotated, and why `AnyCommand`. */
const build: AnyCommand = command({
	args: [{ desc: "The app's root, defaulting to the working directory", name: '[dir]' }],
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
		'--name [name]': {
			desc: 'What the built executable is called. Defaults to the name in package.json',
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

		const out = resolveOut(found.app.root, String(argv.out));
		const result = await bundleApp({
			app: found.app,
			bin,
			binName: binName(found, argv.name as string | undefined),
			out,
			tree: { commands: found.commands, diagnostics: [] } satisfies ResolvedTree,
		});

		printSizes(result.chunks);

		const total = countCommands(found.commands);
		process.stderr.write(
			`\n${describeApp(found.app)}: ${total} command${total === 1 ? '' : 's'} into ${displayPath(
				relative(found.app.root, result.bin) || result.bin
			)}${counts.warnings ? `, ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}` : ''}\n`
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

	const { name } = found.app.manifest;
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
				columns: ['File', { align: 'right', header: 'Size' }, 'Loads'],
			})}\n`
		);
	}
}
