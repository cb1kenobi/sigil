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

import { compileTemplates } from './compile-templates.ts';
import { RUNTIME, type DiscoveredApp } from './discover.ts';
import { generateBin } from './generate.ts';
import { parses, parseTree } from './parse-module.ts';
import { TAG_MODULE } from './templates.ts';
import type { ResolvedTree } from './tree.ts';
import { walk } from './walk.ts';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'rolldown';

/**
 * Where a build's generated entry goes, relative to the app.
 *
 * The *parent* of a per-build directory rather than the directory itself, which
 * is the fix for a defect worth stating: this used to be the whole path, so
 * every build of one app wrote the same `entry.mjs`. Two builds of one app at
 * once is ordinary -- two terminals, or a script producing two `--out`
 * directories -- and the result was not a flaky failure but a **silently wrong
 * bundle**: measured, two concurrent builds differing only in `--commands`
 * baked the same tree into both outputs, four runs out of four, with whichever
 * wrote last winning for both. Exit 0, nothing said.
 *
 * It has to be inside the app, which is why this is a subdirectory rather than
 * somewhere neutral. The entry does `import { main } from '@ttylabs/sigil'`,
 * which resolves by walking up from the file, and it reaches the app's own
 * modules relatively -- `generate.ts` computes those with `relative(from, ...)`,
 * so the depth is derived rather than assumed and a deeper directory costs
 * nothing there.
 */
const WORK_DIR = join('node_modules', '.sigil');

/**
 * A generated entry and the directory made for it.
 *
 * Both, because the directory is this build's alone and has to be removed again
 * -- carrying only the file would leave the caller taking `dirname()` of it and
 * trusting that to be a directory nothing else is in.
 */
interface GeneratedEntry {
	/** The per-build directory, which the caller removes. */
	readonly dir: string;
	/** The entry module inside it. */
	readonly file: string;
}

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
	// there is no `generated` here any more. It handed back the path of the
	// generated entry, nothing in either package ever read it, and the per-build
	// directory is removed before this result is returned -- so keeping it would
	// mean publishing a path that is guaranteed not to exist. That is the same
	// call `Command.file` got, for the same two reasons: unread, and wrong.
	/**
	 * How many `ui` templates were compiled.
	 *
	 * Reported because it is the difference between "this app ships no template
	 * parser" and "this app has no templates", and those look identical from the
	 * outside. A build that silently compiled none when the author wrote twelve is
	 * the failure mode worth being able to see.
	 */
	readonly templates: number;
}

/**
 * Bundles an app.
 *
 * @param options - The app, the tree, and where the output goes.
 * @returns What it wrote.
 */
/**
 * The extensions `parseModule()` can read, which is what decides whether a
 * module is worth asking about templates.
 *
 * Everything else rolldown hands a `transform` -- JSON, a `.node` binding, a
 * virtual module some plugin invented -- is not JavaScript this can parse, and
 * asking anyway would turn a build into a parse error about a file nobody wrote.
 *
 * The `x` is not decoration. oxc reads the language off the *filename*, so a
 * `.tsx` parses with JSX enabled and a `.ts` does not -- which is why the
 * extension is the right thing to gate on and why leaving `.tsx` out was a
 * silent miss rather than a safe one: a `ui` template in a `.tsx` compiles
 * perfectly well through `compileTemplates()`, and the plugin simply never
 * asked. Left out, such a module was bundled with its template interpreted, the
 * count omitted the template, and the parser stayed in the bundle with nothing
 * saying so. JSX being the canonical syntax is exactly what makes a `.tsx` a
 * likely place to find the tag: the two live side by side in one app.
 *
 * Spelled as two alternatives rather than as one `x?`, because the eight real
 * extensions are not a product: there is no `.mtsx` or `.cjsx`, and oxc does not
 * read either as JSX -- so `[cm]?[jt]sx?` admitted four spellings that then parse
 * a JSX element as a syntax error. Harmless, since rolldown's own parser refuses
 * them identically, and still four ids crossing into JavaScript for nothing.
 *
 * Exported for the reason `candidates()` in `which.ts` is: what it admits is
 * worth asserting directly rather than through a bundler, and the invariant that
 * matters is a relation between two things -- every extension
 * `compileTemplates()` can read has to be one this admits, or the gap is a
 * template nobody compiles and nobody is told about.
 */
export const MODULE_RE: RegExp = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export async function bundleApp(options: BundleOptions): Promise<BundleResult> {
	const { app, bin, binName, external = [], out, sourcemap = true, tree } = options;

	// imported here rather than at the top, the way the runtime defers its own
	// heavy modules: rolldown is a native binary, and `sigil check` has no use
	// for it
	const { rolldown } = await import('rolldown');

	const generated = bin ? undefined : writeEntry(app, tree, out);
	const input = bin ?? generated!.file;

	const unresolved: string[] = [];
	let templates = 0;

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
			const message = String(log.message ?? '');

			if (log.code === 'UNRESOLVED_IMPORT') {
				unresolved.push(message);
				return;
			}

			// the one warning this build asks for and does not want reported.
			// Setting `transform.jsx.importSource` makes rolldown say that it beat
			// `compilerOptions.jsxImportSource`, and it says so without comparing
			// the two -- measured: an app whose tsconfig names `@ttylabs/sigil`,
			// which is what `sigil new` scaffolds, gets the warning for being
			// right. A warning that fires on correct code teaches people to ignore
			// warnings, which is the rule already written down for reading a file
			// off `import.meta.url`.
			//
			// It is every scaffolded TypeScript app rather than the few with a
			// `.tsx`: loading the tsconfig is what reports the conflict and a
			// `.ts` module loads it whether or not it holds JSX, measured, while a
			// `.js` module does not. And it is reported even where the tsconfig
			// did not win -- a per-file `@jsxImportSource` beats both and the
			// warning still names the tsconfig -- so some of what it says is not
			// true either.
			//
			// Scoped to the field rather than switched off with
			// `checks: { configurationFieldConflict: false }`, so a conflict about
			// any of the other options this build sets still reaches whoever is
			// building. Matching the message is what that costs, and it fails in
			// the safe direction: reworded, the warning comes back.
			if (log.code === 'CONFIGURATION_FIELD_CONFLICT' && message.includes('jsxImportSource')) {
				return;
			}

			handler(level, log);
		},
		platform: 'node',
		plugins: [
			{
				name: 'sigil:templates',
				/**
				 * Compiles a module's `ui` templates on the way in, so the parser,
				 * the tag and the IR walk shake out of the bundle.
				 *
				 * A `transform` rather than a pass over the app's files beforehand,
				 * because rolldown is what knows which modules are actually reached:
				 * a template in a file nothing imports costs nothing here, and a
				 * template inside a dependency is compiled the same way the app's own
				 * are. The map is returned because a transform without one is
				 * `SOURCEMAP_BROKEN` *and* silently drops the module from the map --
				 * measured, not assumed.
				 */
				transform: {
					/**
					 * Narrowed before the handler is reached rather than inside it.
					 *
					 * rolldown applies these natively, so a module that cannot hold a
					 * template never crosses into JavaScript at all -- and most modules
					 * in a bundle are the runtime's own. Asking inside the handler
					 * instead costs the per-module call itself rather than the parsing,
					 * which a substring test already skipped; AGENTS.md carries the
					 * measurement, and it is stated there rather than here as well
					 * because two spellings of one number is how the two come to
					 * disagree -- which they had, by 2ms of a noise band a few ms wide.
					 *
					 * `code` is the substring that has to be there for a template to
					 * exist, since the tag is only the tag because something imported
					 * it. `id` is the extensions `parseModule()` can read, so JSON, a
					 * `.node` binding and whatever virtual module a plugin invented are
					 * all out. The `id` pattern is matched against forward slashes
					 * whatever the platform, which rolldown documents and which is why
					 * it needs no Windows spelling.
					 */
					filter: {
						code: new RegExp(TAG_MODULE.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
						id: MODULE_RE,
					},

					handler(code: string, id: string) {
						// no extension or substring test here: the filter above is what
						// does the narrowing, natively, and verified -- the `buildable`
						// fixture reaches this handler zero times and `templated` reaches
						// it exactly once, for the one module holding a template. A second
						// check would be a guard that reads as load-bearing and is not
						const compiled = compileTemplates(id, code);
						if (!compiled) {
							return null;
						}

						templates += compiled.count;
						return { code: compiled.code, map: compiled.map };
					},
				},
			} satisfies Plugin,
		],
		resolve: { conditionNames: ['node', 'import', 'default'] },
		// JSX compiles against the runtime the app depends on, because rolldown's
		// own default is `react` and a framework that publishes `./jsx-runtime` has
		// no business shipping apps that import somebody else's. Left to the
		// default, a `.tsx` holding one JSX element built cleanly, reported
		// success, and died the first time the command was run with `Cannot find
		// package 'react'` -- a build that reported success and an executable that
		// dies the first time it is used, which is the shape `--external` is
		// written for one option along.
		//
		// rolldown *does* read the app's `tsconfig.json`, and that was the first
		// thing measured rather than assumed: `tsconfig` defaults to `true` and it
		// is resolved by walking up from each module, so an app whose config names
		// `jsxImportSource` already built correctly and the defect was only ever
		// the default. Which is why this is one option and not a `tsconfig`
		// reader: parsing one means JSONC and an `extends` chain, and a second
		// reader of the app's config is a second thing to disagree with the app's
		// own `tsc`.
		//
		// `importSource` alone, and the narrowness is the decision. Measured
		// against rolldown 1.2.11: this option beats a `jsxImportSource` from the
		// tsconfig, and everything else about the transform stays the app's --
		// `jsx: "react-jsxdev"` still reaches `@ttylabs/sigil/jsx-dev-runtime`,
		// `jsx: "react"` still emits `React.createElement`, and `jsx: "preserve"`
		// still preserves. Adding `runtime: 'automatic'` was tried and rejected:
		// it does fix `preserve` and classic, and it silently costs
		// `react-jsxdev` its dev runtime, which is a configuration this framework
		// publishes a runtime for -- re-measured when `preserve` was closed, since
		// this was the candidate for closing it, and the rejection holds. What the
		// option takes away in **this** build is the `panel.tsx` string and the
		// `fileName` property, not the `jsx-dev-runtime` chunk: minification is on,
		// so that chunk is inlined and gone either way, and the string is the marker
		// `test/fixtures/jsx-dev/` pins for exactly that reason. See `rawJsxIn()`
		// below for the whole table. What `preserve` leaves behind is a
		// bundle that keeps the JSX and dies with `Unexpected token '<'`, which is
		// **refused** rather than honoured -- by `rawJsxIn()` below, which asks
		// what was written rather than what the tsconfig said, so this stays one
		// option with no config reader of its own.
		//
		// What it costs is an app that names a different automatic import source
		// in its tsconfig, which this overrides. Deliberate: the JSX in a sigil
		// app has to produce sigil `Element`s for anything in the framework to
		// render it, and the one statement nothing here overrides is the per-file
		// `@jsxImportSource` pragma -- measured, it beats this option -- so the
		// escape hatch is the most explicit spelling there is rather than the
		// least. A tsconfig could not have been the whole answer in any case:
		// measured, `compilerOptions.jsxImportSource` does not reach a `.jsx` at
		// all, so a `.jsx` has never been configurable that way with a tsconfig
		// or without one.
		transform: { jsx: { importSource: RUNTIME } },
	});

	// there is one leak and it is a `write()` that rejects: `close()` used to be
	// the statement immediately after the write, so the unresolved gate,
	// `undo()`, `escapeControls()` and the `chmod` below all ran with the bundle
	// already closed. A `finally` around the write alone would have closed the
	// same leak -- what the wide one buys is where the correctness lives. The
	// eager call was right only because nothing between the write and it threw,
	// which is a property of the fifty lines under it rather than of the call;
	// everything added since happened to be added *after* the close, and one
	// statement added before it would have brought the leak back with nothing to
	// notice. A `finally` over the whole use of the bundle is right by its shape,
	// and it closes exactly once on one path, so "was it closed" has one answer.
	//
	// It begins where the bundle exists, which is after `await rolldown()`
	// returns rather than at the call: a `rolldown()` that rejects hands back no
	// reference for anything here to close. Measured against rolldown 1.2.11 --
	// an `options` hook that throws rejects before a bundle is constructed, and a
	// missing input resolves to one -- so there is no reachable path where a
	// bundle exists and this function cannot see it.
	try {
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

		// asked after the write, which reads backwards and is the only place the
		// answer exists. `rolldown()` builds nothing: rolldown's own documentation
		// says the module graph is not built until a method on the bundle is called,
		// so asking here before the write -- which is where this check used to sit --
		// asked an empty array and the gate had never once fired. Measured: an app
		// importing `totally-not-a-package` built and reported success, and so did
		// one whose JSX reached for `react`. It was untested, which is how a check
		// comes to be dead.
		//
		// It cannot be moved into a plugin hook either, and each candidate was tried:
		// `buildEnd` and `generateBundle` both run *before* the warning is reported,
		// so both see nothing. `generate()` first and `write()` after is the other
		// shape and is worse -- measured, the transform hook runs again for the
		// second call, which would double `templates` and compile every template
		// twice. So one write, and what it wrote is unwound: exactly the files
		// rolldown reported, which is where the `.map`s are too.
		if (unresolved.length) {
			undo(out, written.output);
			throw new Error(
				`Cannot build: ${unresolved.length} import${unresolved.length === 1 ? '' : 's'} could not be resolved, and an unresolved import is one the built app would reach for at run time.\n${unresolved.map((message) => `  ${message}`).join('\n')}`
			);
		}

		// the second thing a bundle can be wrong about in a way that only shows up
		// the first time somebody runs it, and the reason it is asked here rather
		// than configured away is one entry along in AGENTS.md
		const preserved = rawJsxIn(out, written.output);
		if (preserved) {
			undo(out, written.output);
			throw new Error(
				`Cannot build: ${preserved} still holds JSX, so the built app would die with "Unexpected token '<'" the first time it was loaded.\n  Set "jsx" in the app's tsconfig.json to "react-jsx" or "react-jsxdev". "preserve" leaves JSX for a later tool to compile, and a bundle is the end of the pipeline -- there is no later tool.`
			);
		}

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

		return { bin: executable, chunks, external: [...external], templates };
	} finally {
		// this build's own directory, so removing it cannot disturb a build running
		// beside it -- which is the whole point of it being unique. Unconditional
		// rather than success-only: a refused build has no more use for a generated
		// entry than a finished one, and leaving one behind per failure is how
		// `node_modules/.sigil` fills up with the outputs of builds nobody kept
		if (generated) {
			try {
				rmSync(generated.dir, { force: true, recursive: true });
			} catch {
				// for the reason `close()` below is swallowed: a `finally` that throws
				// replaces the real diagnostic with one about a directory, and what is
				// left behind is a few kB inside `node_modules`
			}
		}

		try {
			await bundle.close();
		} catch {
			// `close()` never decides what the build answered, which is the same
			// rule `undo()` follows and for the same reason: a `finally` that
			// rethrows replaces the real diagnostic with one about releasing a
			// handle, and there is no error worse to report than the one that was
			// already on its way. It is swallowed on the success path too rather
			// than raised there, because the asymmetry would have to be stated as
			// "releasing the bundle is fatal only when everything else worked",
			// which reads backwards -- and what it would produce is a refused
			// build sitting beside a bundle that is complete, escaped and
			// executable, which is the shape `undo()` exists to prevent with
			// nothing left to unwind.
			//
			// Reachable, unlike the guards in `undo()`: measured against rolldown
			// 1.2.11, a plugin whose `closeBundle` hook throws throws out of
			// `close()`, as a `PLUGIN_ERROR`. This build's one plugin has only a
			// `transform`, so it cannot happen here today -- and a plugin is
			// exactly the kind of thing that gets added.
			//
			// Which is also why the eager call was *replaced* rather than joined to
			// this one. A second `close()` is **not** a no-op: measured, it resolves
			// and leaves `closed` true, and it runs every `closeBundle` hook again
			// -- a counting hook reached 3 after three closes, and a throwing one
			// threw from each. So two closes would run a plugin's teardown twice
			// for one build, which is a thing to get wrong rather than a tidiness
			// argument.
		}
	}
}

/**
 * The first written chunk that is JSX rather than JavaScript, if there is one.
 *
 * ## What this is for
 *
 * An app whose `tsconfig.json` says `"jsx": "preserve"` asks for no transform at
 * all, and rolldown obeys -- so the bundle keeps its JSX, the build reports
 * success, and running it dies with `Unexpected token '<'`. That is the shape
 * `--external` and the unresolved-import gate are both written for, arriving
 * through a third door.
 *
 * ## Why detecting rather than configuring
 *
 * Overriding the mode means `transform.jsx.runtime`, which was measured and
 * rejected once already and re-measured here: adding `runtime: 'automatic'` does
 * fix `preserve`, and it silently costs `jsx: "react-jsxdev"` its **dev**
 * runtime, which is a configuration this framework publishes a runtime for.
 * Which marker says so depends on whether the output is minified, and the
 * distinction is worth keeping because only one of the two is what `sigil build`
 * writes. Unminified, the `jsx-dev-runtime` region goes and `_jsxFileName` with
 * it; **minified**, which is the default here, both are already gone and what
 * the option removes is the `panel.tsx` string and the `fileName` property --
 * exactly the marker `test/fixtures/jsx-dev/` was built to pin, since a string
 * survives minification where an identifier does not. The option also makes
 * rolldown report a **second** `CONFIGURATION_FIELD_CONFLICT`, about
 * `compilerOptions.jsx`, which the suppression above does not match because it
 * is scoped to `jsxImportSource` -- so that path would have printed a warning on
 * every build of exactly the app it was meant to fix.
 *
 * Detecting costs no tsconfig reader, contradicts nothing the app's own `tsc`
 * says, and answers for whatever else ever produces the same end state.
 *
 * ## Two questions, each meaningful on its own
 *
 * Asked by **parsing**, not by looking for `<`. A regex over minified output is
 * the trap this ticket warned about and it fired twice while this was being
 * written: the runtime's own error strings carry `<box>`, `<text>` and `<raw>`,
 * and `panel.tsx`'s doc comment carries the word `jsxDEV`, so two different
 * substring probes reported JSX in bundles that had none.
 *
 * What decides the refusal is one thing: **is there a JSX element in the chunk**,
 * asked by parsing the source with `lang: 'jsx'` and walking the tree for a
 * `JSXElement` or a `JSXFragment`. Nothing is inferred from a verdict.
 *
 * The parse that comes first -- does the chunk parse as it stands -- is a **cost**
 * filter and is worth reading as one, because it looks like half the answer and is
 * not. It cannot change what this reports, and the reason is a proof rather than a
 * measurement: JSX is a syntax error in JavaScript, so a chunk that parses under
 * its own name cannot contain a JSX node, and the walk would find nothing. What it
 * buys is that the **AST is never deserialized on a build that is fine**, which is
 * the expensive half -- measured, asking only about the errors over 9 chunks is
 * 2.0ms and touching `.program` as well is 9.9ms. Deleting it changes no answer
 * and no test, which is exactly what a filter should do.
 *
 * The first version of this inferred the second clause from a **parse
 * differential** -- fails under its own name, parses when offered as `.jsx` --
 * and that was wrong, because the extension moves two axes rather than one: oxc
 * reads the *source type* off it too. A `.mjs` is always a module while a `.jsx`
 * with no `import` or `export` in it is inferred a **script**, and a script is
 * allowed things a module is not. So every module-only error read as "JSX must be
 * why". Found by review, with an Annex B HTML comment; hunting the class it
 * belongs to turned up four more shapes -- a `-->` line, and `await` used as a
 * variable, a class name or a label -- and nobody had enumerated the set, which is
 * the actual argument against inferring rather than asking.
 *
 * Pinning the source type on both parses was the other candidate fix, and it is
 * the one to know about because it looks strictly safer and is not: see `AS_JSX`,
 * where it costs 50 of 180 measured combinations their JSX.
 *
 * A chunk that parses as neither is deliberately **left alone**: that is not this
 * failure, and refusing it would risk failing a build that works, since
 * `oxc-parser` and the oxc inside rolldown are separately versioned and a
 * grammar this one is behind on would read as a broken bundle. The structural
 * reason that is safe is stronger than any corpus: a chunk is oxc's own
 * parse-and-print output, so anything rolldown could emit, rolldown has already
 * parsed.
 *
 * Measured: `preserve` on a `.tsx` is the **only** tsconfig `jsx` value that
 * leaves raw JSX behind -- `react-native`, which `tsc` also treats as
 * preserving, is compiled by rolldown -- and `compilerOptions.jsx` does not
 * reach a `.jsx` at all, exactly as `jsxImportSource` does not. What it does not
 * catch is `jsx: "react"`, which emits `React.createElement` and parses
 * perfectly: that is a bundle that will not *run* rather than one that will not
 * *parse*, it is what AGENTS.md already records as the app's own choice, and an
 * app that really does depend on React can make it work.
 *
 * ## Read from disk, not from `written.output`
 *
 * `chunk.code` is byte-identical to the file today -- measured -- and reading it
 * would cost nothing. The file is read anyway, because the whole reason
 * `escapeControls()` exists is that rolldown's in-memory view of a chunk and the
 * bytes it finally writes came apart once, and a check about whether **node** can
 * parse the bundle has to ask the bytes node will read. The cost is measured and
 * small: 2.7ms to read and parse a 9-chunk, 111 kB bundle and 4.8ms for 44
 * chunks of 182 kB. End to end, a `sigil build` of the fixture goes from 118ms
 * to 121ms with it, medians of nine interleaved -- 3ms either way, and a review
 * on another machine measured the same 3ms against a 73ms build, so the delta is
 * the number worth writing down rather than the absolutes.
 *
 * Exported for the reason `undo()` and `MODULE_RE` are: what it admits is worth
 * asserting directly rather than only through a bundler, and the
 * parses-as-neither case cannot be reached through one at all.
 *
 * @param out - The output directory.
 * @param output - What rolldown wrote.
 * @returns The first offending chunk's name, or `undefined`.
 */
export function rawJsxIn(
	out: string,
	output: readonly { fileName: string; type: string }[]
): string | undefined {
	for (const chunk of output) {
		// an asset is not a module, which is the same line `escapeControls()`
		// draws -- and here it is a **cost** guard rather than a correctness one,
		// which is worth saying because it looks like the latter. A sourcemap
		// fails both parses and would fall into the conservative branch below
		// anyway, measured, so removing this changes no answer for anything
		// rolldown emits; what it changes is that the maps are read, and they are
		// the largest files in the output -- 288 kB of maps against 111 kB of
		// chunks on the fixture, which takes the pass from 2.33ms to 3.14ms. An
		// asset that is JSX, which an app shipping a template as one would be, is
		// the case where it changes an answer too, and that answer is that an
		// asset nobody imports is not a module that has to parse
		if (chunk.type !== 'chunk') {
			continue;
		}

		const file = join(out, chunk.fileName);
		const code = readFileSync(file, 'utf-8');

		// the cost filter, not half the answer: a chunk that parses cannot hold a
		// JSX node, so this only keeps the AST off the success path
		if (parses(file, code)) {
			continue;
		}
		// the whole of the answer, asked of the tree rather than of a verdict
		if (hasJsx(file, code)) {
			return chunk.fileName;
		}
	}

	return undefined;
}

/**
 * JSX admitted, and **nothing else pinned** -- the source type above all.
 *
 * Pinning `sourceType: 'module'` here is the obvious tidy-up and it is a
 * false-negative machine: measured over 180 combinations of a name, a body and a
 * JSX element, it loses the JSX in **50** of them. Every one is a chunk that
 * holds real JSX *and* something a module may not do -- `await` as an identifier,
 * a label or a class name, an Annex B HTML comment -- where the pinned parse
 * fails before the walk can see anything. The only job of this parse is to hand
 * the walk a tree, so the permissive reading is the right one; what the source
 * type does or does not allow is the *first* clause's business, and it is asked
 * there.
 *
 * The same measurement says pinning the first parse changes no answer in any of
 * the 180, because a JSX node is the whole of what this reports and a source
 * type cannot conjure one. So neither parse pins it, and there is one mechanism
 * rather than two that mask each other.
 */
const AS_JSX = { lang: 'jsx' } as const;

/**
 * Whether a source holds a JSX element.
 *
 * Parsed with JSX admitted and walked for the node, rather than inferred from the
 * parse succeeding: "it parses as JSX" is true of every ordinary JavaScript file
 * there is, so it proves nothing on its own, and the differential that made it
 * look like proof is the defect recorded above.
 *
 * `walk()` is the repo's own, driven by oxc's `visitorKeys`, so there is no
 * second copy of the grammar here and a JSX element nested somewhere this file
 * has never heard of is still found. It stops at the first one, since the
 * question is whether there is any.
 *
 * @param file - Where it came from, for the language default the options override.
 * @param source - The source.
 * @returns Whether a `JSXElement` or `JSXFragment` is in it.
 */
function hasJsx(file: string, source: string): boolean {
	const program = parseTree(file, source, AS_JSX);
	if (!program) {
		return false;
	}

	let found = false;
	walk(program, (node) => {
		if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
			found = true;
		}

		return !found;
	});

	return found;
}

/**
 * Removes what a build wrote, because a refused build must leave nothing.
 *
 * The gate above can only be asked after the write, so by the time the answer
 * exists the bundle is on disk -- and a bundle that would die the first time it
 * was run is precisely what the refusal is about, so leaving it there would
 * answer the question and then hand over the thing anyway.
 *
 * Exactly the files rolldown reported, rather than the output directory: an
 * `--out` the build was told not to clean may hold somebody else's files, and
 * removing a directory this function does not own is how a mistyped path becomes
 * data loss. The assets are in that list too, which is where the sourcemaps are.
 *
 * Every path is checked to be **inside `out` before it is unlinked**, and that
 * guard was missing for a commit: `join()` normalises, so a reported name of
 * `../precious.txt` resolved to a file beside the output directory and was
 * deleted, while the separator check written next to it only ever protected the
 * directory climb. Not reachable through rolldown 1.2.11, which refuses such a
 * name before anything is written -- `entryFileNames` outside the directory is
 * `INVALID_OPTION` and a chunk name that climbs out is
 * `FILE_NAME_OUTSIDE_OUTPUT_DIRECTORY` -- and closed anyway, because the one
 * operation here is a delete and a delete is not the place to rely on somebody
 * else's validation. `escapeControls()` builds the same paths and only writes to
 * them, which is why it is left as it is.
 *
 * Checked rather than resolved through `realpath`: if `out/chunks` is a symlink
 * then rolldown wrote through it, so what is being removed is still exactly what
 * this build put there, and resolving would refuse to clean up after a directory
 * layout somebody chose on purpose.
 *
 * A directory each of those files sat in goes with it, up to but never including
 * `out`, and only while it is empty -- `chunks/` is one this build made and an
 * empty directory left behind reads as a build that half happened. Emptiness is
 * what bounds it to directories nobody else is using, so a `--no-clean` output
 * holding somebody's own `chunks/index.html` keeps its directory.
 *
 * Exported for the reason `MODULE_RE` is: rolldown will not produce a name that
 * reaches the guard, so the only way to assert the guard is to call this.
 *
 * @param out - The output directory.
 * @param output - What rolldown wrote.
 */
export function undo(out: string, output: readonly { fileName: string }[]): void {
	const root = resolve(out);
	// with the separator, so that an `--out` of `dist` cannot have `dist-old`
	// read as being inside it
	const inside = root.endsWith(sep) ? root : root + sep;

	for (const chunk of output) {
		const file = resolve(join(out, chunk.fileName));
		if (!file.startsWith(inside)) {
			continue;
		}

		try {
			rmSync(file, { force: true });
		} catch {
			// what must survive this function is the error the build was about to
			// report, and a removal that throws replaces it with something about the
			// file system. `force` covers a file that is not there and not a
			// `fileName` that names a **directory**, which is `ERR_FS_EISDIR` --
			// rolldown 1.2.11 reports no such name, so this is the same kind of guard
			// as the containment check above: unreachable through the bundler, and
			// cheap where the alternative is a message about the file system in place
			// of the real one. Whatever could not be removed is skipped and the rest
			// of the list still is
			continue;
		}

		for (let dir = dirname(file); dir !== root && dir.startsWith(inside);) {
			try {
				rmdirSync(dir);
			} catch {
				// not empty, or already gone: either way there is nothing above it
				// left to remove
				break;
			}
			dir = dirname(dir);
		}
	}
}

/**
 * Writes the generated executable the bundle is built from.
 *
 * @param app - The app.
 * @param tree - The tree to bake in.
 * @returns Where it was written.
 */
function writeEntry(app: DiscoveredApp, tree: ResolvedTree, out: string): GeneratedEntry {
	// named from the **output** rather than randomly, and that is a trade taken on
	// purpose. `mkdtempSync` was the first version and is unique per invocation,
	// which closes this defect and one more -- two builds of one app to one `--out`
	// -- at the cost of a directory name that differs every run. That name reaches
	// the sourcemap, where it is a `sources` entry, so a random one makes two
	// identical builds produce different bytes: this repo asserts its own build is
	// a byte-identical fixed point, and an app verifying a published artifact wants
	// the same property. It survived only because the toolchain builds with
	// `--no-sourcemap`, which is luck rather than design.
	//
	// A hash of the resolved output is deterministic and separates any two outputs
	// that do not collide, which real ones do not -- see `hash()` for why that is a
	// claim about accident rather than about possibility, and for the measurement
	// that made the first width wrong. What it does not separate is two builds of
	// one app to one `--out`, which are already fighting over every file they
	// write -- the entry is the least of what they would clobber -- so buying that
	// case with reproducibility would be paying for the wrong thing. That case is
	// also where the cleanup below is unreliable: two processes removing one
	// directory means one of the two `rmSync` calls can throw, and a swallowed
	// throw leaves it behind. Observed once in four runs, a few kB inside
	// `node_modules`, in a case whose bundle was already whichever process wrote
	// last.
	const dir = join(app.root, WORK_DIR, hash(resolve(out)));
	mkdirSync(dir, { recursive: true });

	const file = join(dir, 'entry.mjs');
	writeFileSync(
		file,
		generateBin({ from: dir, schemaModule: app.entry, tree, version: app.manifest.version }),
		'utf-8'
	);

	return { dir, file };
}

/**
 * A short, stable name for a path.
 *
 * Sixteen hex characters of SHA-256. It has to be the same for the same output
 * and different for a different one, and a truncated digest is both -- but only
 * up to a collision, and the width is the whole of what decides how near that
 * is. Twelve was the first answer and is **not** enough to say what the entry
 * above wants to say: 48 bits puts a birthday search at 2^24, and a search of
 * twenty million paths found `/tmp/sigil-c-10001357` and `/tmp/sigil-c-11986969`
 * sharing `94e17cf76917` in about ten seconds -- then built `two-trees` into both
 * and got `onlyB` in each, which is this defect back with two outputs that share
 * no file at all. Sixteen puts the same search at 2^32.
 *
 * What that buys is a guarantee about *accident*, and the claim is worth stating
 * no wider than that: a pair of real output directories will not collide, and a
 * pair constructed on purpose still can at any width short of the whole digest.
 * The whole digest is not the answer because this is a directory name somebody
 * reads in a stack trace, and the failure it would be closing is somebody
 * deliberately corrupting their own build.
 *
 * `node:crypto` rather than a hand-rolled hash for the reason this package takes
 * dependencies at all: it is already there.
 *
 * @param value - The path to name.
 * @returns Sixteen hex characters.
 */
function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
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
