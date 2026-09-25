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
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
	/**
	 * Packages to leave as imports rather than inline.
	 *
	 * The zero-dependency promise is about what *sigil* adds, and this is the
	 * one thing that can break it, so it is explicit and it is reported. What
	 * forces it is a **native binding**: a package like `oxc-parser` or
	 * `rolldown` is JavaScript around a `.node` file, and no bundler inlines a
	 * `.node`. Its JavaScript resolves perfectly well, gets inlined, and then
	 * looks for a binary beside a file that is no longer there -- so the build
	 * reports success and the executable dies the first time it is used.
	 *
	 * An app that names one is saying its bundle is not self-contained, which is
	 * a true thing to say about an app with a native dependency and a lie about
	 * any other.
	 */
	readonly external?: readonly string[];
	/** Where the bundle goes. */
	readonly out: string;
	/**
	 * Whether to write sourcemaps. On by default.
	 *
	 * The first thing anybody debugging a built app wants, and nothing to
	 * whoever never opens one -- at run time. What it is not free of is *size*:
	 * they are several times the minified code they describe, and a package
	 * publishing its `dist` publishes them. So an app that ships its bundle
	 * rather than debugging it can say no.
	 */
	readonly sourcemap?: boolean;
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
	/** What was left as an import rather than inlined, in the order given. */
	readonly external: readonly string[];
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
	const { app, bin, binName, external = [], out, sourcemap = true, tree } = options;

	// imported here rather than at the top, the way the runtime defers its own
	// heavy modules: rolldown is a native binary, and `sigil check` has no use
	// for it
	const { rolldown } = await import('rolldown');

	const generated = bin ? undefined : writeEntry(app, tree);
	const input = bin ?? generated!;

	const unresolved: string[] = [];

	const bundle = await rolldown({
		// left as imports rather than inlined. Rolldown does not report these as
		// unresolved, which is the point: an external is a deliberate answer to
		// "this cannot be inlined" and an unresolved import is the absence of one
		external: external.flatMap((name) => [
			name,
			new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
		]),
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
		minify: true,
		// the first thing anybody debugging a built app wants, and nothing to
		// whoever never opens one -- but several times the size of the code it
		// describes, and a package publishing its `dist` publishes it too
		sourcemap,
	});
	await bundle.close();

	escapeControls(out, written.output);

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

	return { bin: executable, chunks, external: [...external], generated };
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
	writeFileSync(
		file,
		generateBin({ from: dir, schemaModule: app.entry, tree, version: app.manifest.version }),
		'utf-8'
	);

	return file;
}

/**
 * Every control character, as a property rather than as a range.
 *
 * `\p{Cc}` is exactly C0, `DEL` and C1 -- the same set a class of
 * `\u0000-\u0008\u000B...` spelled out, checked against all 1,112,064 code
 * points -- and it names what is being matched instead of enumerating it. It
 * also carries no control character, escaped or otherwise, so `no-control-regex`
 * has nothing to say and there is no suppression to keep in place.
 *
 * Which is what this replaced: the class was covered by an
 * `eslint-disable-next-line`, the formatter later wrapped the call and moved the
 * regex to its own line, and the comment stayed above the line it had been
 * written over. A suppression a formatter can detach from its target is one that
 * stops working without anybody editing it.
 */
const CONTROL = /\p{Cc}/gu;

/** The three a file is allowed to keep, because they are its own formatting. */
const FORMATTING = new Set(['\t', '\n', '\r']);

/**
 * Escapes every control character a terminal would act on, in what was written.
 *
 * The runtime builds `ESC` with `String.fromCharCode()` precisely so a raw
 * control character never sits in source -- and the minifier constant-folds
 * that straight back into a raw byte. A built app inlines the runtime, so
 * without this every minified app ships the sequence: three raw control
 * characters in one fixture's bundle, the first time minification was turned
 * on, and three is all it takes -- one of them opens a hyperlink.
 *
 * It matters because Node prints the offending source line on an uncaught
 * error, so a crash near one writes `ESC ] 8 ; ;` to the user's terminal and
 * leaves everything after it inside a hyperlink nothing closes. A CLI that dies
 * must not take the terminal with it.
 *
 * Done to the **files**, not in a `generateBundle` hook, which is where this
 * started: minification is an output stage that runs after the hooks, so the
 * escapes were folded straight back. What is written is the only thing the
 * minifier is finished with. Escaping a
 * raw byte inside a string to `\xNN` is the same string to JavaScript and inert
 * to a terminal, so doing it last is safe as well as sufficient.
 *
 * `\t`, `\n` and `\r` are left alone as the file's own formatting, which is
 * `FORMATTING` above. The same pass `packages/sigil`'s own build runs over its
 * own output, said here because an app's bundle is the other place the
 * runtime's source ends up.
 *
 * @param out - The output directory.
 * @param output - What rolldown wrote.
 */
function escapeControls(out: string, output: readonly { fileName: string; type: string }[]): void {
	for (const chunk of output) {
		if (chunk.type !== 'chunk') {
			continue;
		}

		const file = join(out, chunk.fileName);
		const code = readFileSync(file, 'utf-8');
		const escaped = code.replaceAll(CONTROL, (c) =>
			FORMATTING.has(c) ? c : `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
		);

		if (escaped !== code) {
			writeFileSync(file, escaped);
		}
	}
}
