/**
 * Stage five: one process in, zero dependencies out.
 *
 * rolldown, with the runtime inlined and everything unreached shaken out. What
 * comes out is a directory of ES modules that import nothing but each other and
 * node builtins.
 *
 * ## The dependency question, which is three questions
 *
 * `@ttylabs/sigil` has no dependencies and that is a hard constraint.
 * `@ttylabs/cli` is a devDependency of the app, like `tsc`, so it may depend on
 * a bundler and a parser. And what this *emits* depends on nothing, because the
 * runtime has nothing to bring and a bundler is a compiler rather than a
 * runtime -- nothing it writes imports it, exactly as nothing `tsc` writes
 * imports TypeScript.
 *
 * ## Chunks, because the deferral is the point
 *
 * A command is reached by `load: () => import('./commands/build.js')`, and a
 * literal specifier inside a dynamic import is the one thing a bundler can see,
 * follow and split on. So each command becomes its own chunk and `mycli --help`
 * loads the entry, the parser and the help renderer and no command bodies at
 * all. Flattening to a single file would undo the whole reason the tree is
 * lazy.
 *
 * ## The generated entry is a real file
 *
 * It could be a virtual module, and a real one is worth the temporary
 * directory: a build that produces something surprising is one somebody has to
 * read, and `node_modules/.sigil/` is both conventional for generated build
 * input and ignored by every repository already.
 */

import type { DiscoveredApp } from './discover.ts';
import { generateBin } from './generate.ts';
import type { ResolvedTree } from './tree.ts';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the generated entry is written, relative to the app. */
const WORK_DIR = join('node_modules', '.sigil');

/** How to bundle. */
export interface BundleOptions {
	/** The app. */
	readonly app: DiscoveredApp;
	/** What the built executable is called, without an extension. */
	readonly binName: string;
	/** An executable of the app's own, bundled instead of a generated one. */
	readonly bin?: string;
	/** Where the bundle goes. */
	readonly out: string;
	/** The tree to bake into the generated entry. */
	readonly tree: ResolvedTree;
}

/** One file the build wrote. */
export interface BuiltChunk {
	/** Whether it is the executable. */
	readonly entry: boolean;
	/** Its name inside the output directory. */
	readonly name: string;
	/** Its size in bytes. */
	readonly size: number;
}

/** What the build produced. */
export interface BundleResult {
	/** The executable, as an absolute path. */
	readonly bin: string;
	/** Everything written, the executable included, largest first. */
	readonly chunks: readonly BuiltChunk[];
	/** The generated entry, when the build wrote one. */
	readonly generated?: string;
}

/**
 * Bundles an app.
 *
 * @param options - The app, the tree, and where the output goes.
 * @returns What it wrote.
 */
export async function bundleApp(options: BundleOptions): Promise<BundleResult> {
	const { app, bin, binName, out, tree } = options;

	// imported here rather than at the top, the way the runtime defers its own
	// heavy modules: rolldown is a native binary, and `sigil check` has no use
	// for it
	const { rolldown } = await import('rolldown');

	const generated = bin ? undefined : writeEntry(app, tree);
	const input = bin ?? generated!;

	const unresolved: string[] = [];

	const bundle = await rolldown({
		input,
		// an import a bundler cannot resolve is left as an import, so the bundle
		// reaches for it at run time -- which is the zero-dependency promise
		// broken without anybody being told. It is collected and raised below
		// rather than warned about, because a build that cannot find the runtime
		// has not built anything worth running
		onLog(level, log, handler) {
			if (log.code === 'UNRESOLVED_IMPORT') {
				unresolved.push(String(log.message ?? ''));
				return;
			}
			handler(level, log);
		},
		platform: 'node',
		resolve: { conditionNames: ['node', 'import', 'default'] },
	});

	if (unresolved.length) {
		await bundle.close();
		throw new Error(
			`Cannot build: ${unresolved.length} import${unresolved.length === 1 ? '' : 's'} could not be resolved, and an unresolved import is one the built app would reach for at run time.\n${unresolved.map((message) => `  ${message}`).join('\n')}`
		);
	}

	const written = await bundle.write({
		chunkFileNames: 'chunks/[name]-[hash].mjs',
		dir: out,
		entryFileNames: `${binName}.mjs`,
		format: 'esm',
		// a sourcemap would be the first thing anybody debugging a built app
		// wants, and it costs nothing to whoever does not open it
		sourcemap: true,
	});
	await bundle.close();

	const chunks = written.output
		.map((chunk) => ({
			entry: chunk.type === 'chunk' && chunk.isEntry,
			name: chunk.fileName,
			size: Buffer.byteLength(
				chunk.type === 'chunk' ? chunk.code : (chunk.source as string | Uint8Array)
			),
		}))
		.sort((one, other) => other.size - one.size);

	const executable = join(out, `${binName}.mjs`);

	// the bit, because a shebang without it is a file nobody can run. `0o755`
	// rather than a mask off the umask: what a bin needs is the same everywhere
	// and an umask that happened to be 077 would produce one only its owner
	// could execute
	chmodSync(executable, 0o755);

	return { bin: executable, chunks, generated };
}

/**
 * Writes the generated executable the bundle is built from.
 *
 * @param app - The app.
 * @param tree - The tree to bake in.
 * @returns Where it was written.
 */
function writeEntry(app: DiscoveredApp, tree: ResolvedTree): string {
	const dir = join(app.root, WORK_DIR);
	mkdirSync(dir, { recursive: true });

	const file = join(dir, 'entry.mjs');
	writeFileSync(file, generateBin({ from: dir, schemaModule: app.entry, tree }), 'utf-8');

	return file;
}
