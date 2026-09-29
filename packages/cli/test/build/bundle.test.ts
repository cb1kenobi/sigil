import { bundleApp, rawJsxIn, undo } from '../../src/build/bundle.js';
import { discoverApp, readAppCommands } from '../../src/build/discover.js';
import { parseModule } from '../../src/build/parse-module.js';
import { resolveCommandTree } from '../../src/build/tree.js';
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = resolve(__dirname, '../fixtures/buildable');

let out: string;
let bin: string;
let chunks: readonly { entry: boolean; name: string; size: number }[];

/**
 * Every module specifier the bundle imports, static and dynamic.
 *
 * Read off the parser's own module record rather than matched with a regex.
 * The naive pattern found `Error(\`...command name from "${e}"\`)` -- the word
 * "from" inside a message, followed by a quoted template -- and a test that
 * reports a dependency an app does not have is worse than no test.
 */
function bundleSpecifiers(dir_ = out): string[] {
	const found: string[] = [];

	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);

			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!path.endsWith('.mjs')) {
				continue;
			}

			const source = readFileSync(path, 'utf-8');
			const parsed = parseModule(path, source);

			for (const imported of parsed.module.staticImports) {
				found.push(imported.moduleRequest.value);
			}
			for (const exported of parsed.module.staticExports) {
				for (const entry_ of exported.entries) {
					if (entry_.moduleRequest) {
						found.push(entry_.moduleRequest.value);
					}
				}
			}
			for (const dynamic of parsed.module.dynamicImports) {
				// a dynamic import's request is a span rather than a value, because it
				// need not be a literal at all -- and a computed one is not a
				// dependency, it is code choosing a module at run time. Only a literal
				// can name a package the app would have to have installed
				const request = source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
				if (/^["']/.test(request)) {
					found.push(request);
				}
			}
		}
	};

	walk(dir_);
	return found.map((specifier) => specifier.replace(/^["'`]|["'`]$/g, ''));
}

/** Runs the built executable. */
function run(...argv: string[]) {
	// through `node` rather than by executing the file, because a shebang is not
	// how anything starts on Windows: `spawnSync(bin, ...)` there comes back with
	// a null status and no stdout at all, so every assertion below failed on a
	// bundle that was perfectly fine. The rule is already written down for the
	// way the build invokes `tsc`; this is the same rule, applied to the build's
	// own output.
	//
	// What that gives up is proof the shebang line works, which is what the
	// test below is for.
	//
	// `cwd` somewhere unrelated on purpose: a built app must not depend on where
	// it is run from, and the fixture's own directory would hide it if it did
	return spawnSync(process.execPath, [bin, ...argv], { cwd: tmpdir(), encoding: 'utf-8' });
}

/**
 * `sigil build`: one process in, zero dependencies out.
 *
 * The claim the whole ticket rests on, and the only place it can be asserted is
 * against a bundle that was actually written and actually run. Everything above
 * this reads source or prints it; this spawns the result.
 */
describe('bundling an app', () => {
	beforeAll(async () => {
		out = mkdtempSync(join(tmpdir(), 'sigil-build-'));

		const found = discoverApp(app);
		const declared = readAppCommands(found);
		const dir = declared.commands?.kind === 'directory' ? declared.commands.dir : '';
		const tree = resolveCommandTree(dir);

		const result = await bundleApp({ app: found, binName: 'buildable', out, tree });
		bin = result.bin;
		chunks = result.chunks;
	}, 60_000);

	it('should write a shebang', () => {
		// asserted everywhere, because the line is in the file whoever built it:
		// a bundle built on Windows and published from there still has to run on
		// a machine that reads shebangs
		expect(readFileSync(bin, 'utf-8').startsWith('#!/usr/bin/env node')).toBe(true);
	});

	it.skipIf(process.platform === 'win32')('should set the executable bit', () => {
		// a shebang without the bit is a file nobody can run -- on a platform
		// that has one. Windows has no execute bit, so `mode & 0o111` is always
		// 0 there and the assertion was failing on a correct build; what makes a
		// bin runnable on Windows is the shim npm writes, which is npm's to do
		// and not this build's.
		expect(statSync(bin).mode & 0o111).toBeGreaterThan(0);
	});

	it('should depend on nothing but itself and node', () => {
		// the promise in the ticket's title. Every specifier is either a relative
		// chunk or a node builtin -- a bare one would be a package the built app
		// reaches for at run time, which is the whole thing this exists to avoid
		const bare = bundleSpecifiers().filter(
			(specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')
		);

		expect(bare).toStrictEqual([]);
	});

	it('should import nothing from outside the output directory', () => {
		// a relative specifier that climbs out of the bundle is the same failure
		// as a bare one wearing a different hat: the app would reach for a file
		// that is not shipped with it
		const escaping = bundleSpecifiers().filter((specifier) => specifier.startsWith('..'));

		expect(escaping).toStrictEqual([]);
	});

	it('should run with no node_modules anywhere near it', () => {
		// the same claim from the other side: it was copied nowhere, but it is run
		// from a directory with no package of any kind above it
		const result = run('--help');

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage: buildable');
	});

	it('should dispatch a command', () => {
		expect(run('greet').stdout.trim()).toBe('hello world');
	});

	it('should dispatch a command with an argument', () => {
		expect(run('greet', 'sigil').stdout.trim()).toBe('hello sigil');
	});

	it('should dispatch a subcommand', () => {
		expect(run('db', 'migrate').stdout.trim()).toBe('migrated');
	});

	it('should have compiled a TypeScript command module', () => {
		// `greet.ts` has type annotations; nothing compiled it before the bundler
		expect(run('greet').status).toBe(0);
	});

	it('should carry the descriptions it baked in', () => {
		// the reason the static lift exists: help that lists commands by name
		// alone is not help, and a built app reads no directories to find out
		const help = run('--help').stdout;

		expect(help).toContain('say hello');
		expect(help).toContain('A fixture app that builds');
	});

	it("should carry a subcommand's description as deep as the tree goes", () => {
		// the root screen is the easy half: a nested `desc` is what the walk's
		// recursion is for, and a lift that only reached the top level would look
		// exactly like one that worked when read from `--help` alone
		expect(run('db', '--help').stdout).toContain('run migrations');
	});

	it('should bake the descriptions into the entry rather than read them from the modules', () => {
		// the claim `--help` rests on, from both sides: the entry carrying the
		// description is what says the lift happened, and the entry *not* carrying
		// the command body is what says the deferral survived it. A build that had
		// flattened the modules in to read their descriptions would satisfy the
		// first assertion and fail the second
		const entry = readFileSync(bin, 'utf-8');

		expect(entry).toContain('run migrations');
		expect(entry).not.toContain('migrated');
	});

	it('should carry the root options the app declared', () => {
		// the generated entry composes the app's schema with the baked tree, so
		// everything the app said other than `commands` survives
		expect(run('--help').stdout).toContain('Say more');
	});

	it('should hide a command it read as hidden', () => {
		const help = run('--help').stdout;

		expect(help).not.toContain('quiet');
		// ...and it still runs, which is what hidden means
		expect(run('quiet').stdout.trim()).toBe('quiet');
	});

	it('should put every command in its own chunk', () => {
		// a literal specifier inside a dynamic import is the one thing a bundler
		// can see, follow and split on -- so the deferral survives bundling rather
		// than being flattened into the entry
		const lazy = chunks.filter((chunk) => !chunk.entry).map((chunk) => chunk.name);

		expect(lazy.some((name) => name.includes('greet'))).toBe(true);
		expect(lazy.some((name) => name.includes('migrate'))).toBe(true);
	});

	it('should keep the entry small, because startup time is the metric', () => {
		// what `--help` pays for is the entry plus what it reaches; the parser and
		// the help renderer are chunks of their own, and no command body is in it
		const entry = chunks.find((chunk) => chunk.entry)!;

		expect(entry.size).toBeLessThan(16 * 1024);
		expect(readFileSync(bin, 'utf-8')).not.toContain('hello ');
	});

	it('should inline everything by default', async () => {
		// the zero-dependency promise: what a built app ships is the app plus the
		// runtime, and nothing it has to find at run time
		const source = readFileSync(bin, 'utf-8');
		expect(source).not.toMatch(/from\s*["'][^."'][^"']*["']/);
	});

	it('should report a non-zero exit code from a command that failed', () => {
		expect(run('nope').status).toBe(1);
	});
});

describe('a package that cannot be inlined', () => {
	// nothing inlines a `.node`, so a package that is JavaScript around one has
	// to stay an import: its JS resolves perfectly well, gets inlined, and then
	// looks for a binary beside a file that is no longer there -- a build that
	// reports success and an executable that dies the first time it is used
	let out: string;

	beforeAll(() => {
		out = mkdtempSync(join(tmpdir(), 'sigil-external-'));
	});

	afterAll(() => {
		rmSync(out, { force: true, recursive: true });
	});

	it('should leave a named package as an import', async () => {
		const found = discoverApp(app);
		const tree = resolveCommandTree(join(app, 'src', 'commands'));

		const result = await bundleApp({
			app: found,
			binName: 'buildable',
			external: ['node:zlib'],
			out,
			tree,
		});

		expect(result.external).toStrictEqual(['node:zlib']);
	});
});

describe('an app whose output is JSX', () => {
	/**
	 * JSX is the canonical syntax, and rolldown's default import source is
	 * `react`.
	 *
	 * The fixture has no `tsconfig.json` on purpose: rolldown reads one when it
	 * is there, so an app naming `jsxImportSource` always built correctly and the
	 * defect was only ever the default. Left to it, this app built, reported
	 * success, and died the first time the command was run with `Cannot find
	 * package 'react'` -- the shape `--external` is written for, one option
	 * along.
	 */
	let jsxOut: string;
	let jsxBin: string;
	let jsxTemplates: number;

	beforeAll(async () => {
		jsxOut = mkdtempSync(join(tmpdir(), 'sigil-jsx-'));

		const jsxApp = resolve(__dirname, '../fixtures/jsx');
		const found = discoverApp(jsxApp);
		const tree = resolveCommandTree(join(jsxApp, 'src', 'commands'));

		const result = await bundleApp({ app: found, binName: 'jsx', out: jsxOut, tree });
		jsxBin = result.bin;
		jsxTemplates = result.templates;
	}, 60_000);

	afterAll(() => {
		rmSync(jsxOut, { force: true, recursive: true });
	});

	it('should compile JSX against the runtime rather than react', () => {
		// the defect, named. `react/jsx-runtime` resolves in plenty of
		// repositories and would then be *inlined*, so asserting the absence of
		// the specifier is the check that holds wherever it runs
		const bare = bundleSpecifiers(jsxOut).filter(
			(specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')
		);

		expect(bare).toStrictEqual([]);
		// and said the other way, because an empty list is a check that passes
		// for the wrong reason the day the walk stops finding files
		expect(bundleSpecifiers(jsxOut).length).toBeGreaterThan(0);
	});

	it('should run the JSX it compiled', () => {
		// the claim only a spawned binary can make: the transform picked a runtime
		// that is in the bundle, and what it built renders
		const result = spawnSync(process.execPath, [jsxBin, 'greet', 'sigil'], {
			cwd: tmpdir(),
			encoding: 'utf-8',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Hello, sigil!');
		expect(result.stdout).toContain('from a compiled JSX element');
	});

	it('should not read compiled JSX as JSX that survived', () => {
		// the false positive that would matter, asked against a bundle a real build
		// really wrote rather than against a string: this app's whole output is JSX
		// and every chunk of it has to come back clean. Two substring probes for
		// JSX reported this bundle as holding some while the check was being
		// written -- the runtime's error strings carry `<box>`, `<text>` and
		// `<raw>`, and `panel.tsx`'s doc comment carries `jsxDEV` -- which is why
		// the answer is a parse rather than a search.
		//
		// The assertion is a second line of defence rather than the only one, and
		// it is worth knowing which: `beforeAll` already built this app *through*
		// `bundleApp()`, so a gate that false-positived here would fail the hook
		// and skip this test rather than fail on the `expect`. The suite still goes
		// red either way; the line that reports it is the hook's
		const files = readdirSync(jsxOut, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
			.map((entry) => ({
				fileName: relative(jsxOut, join(entry.parentPath, entry.name)),
				type: 'chunk',
			}));

		// said the other way too, because an empty list is a check that passes for
		// the wrong reason the day the walk stops finding files
		expect(files.length).toBeGreaterThan(0);
		expect(rawJsxIn(jsxOut, files)).toBeUndefined();
	});

	it('should compile a template and the JSX beside it in one module', () => {
		// two passes over one file, which is the shape AGENTS.md describes when it
		// says the two syntaxes live side by side in one app. The plugin's
		// `transform` runs before rolldown's own, so it is handed the module with
		// its JSX intact; nothing checked that the two compose except a module that
		// has both
		expect(jsxTemplates).toBe(1);

		const result = spawnSync(process.execPath, [jsxBin, 'greet', 'sigil'], {
			cwd: tmpdir(),
			encoding: 'utf-8',
		});

		expect(result.stdout).toContain('Hello again, sigil!');
	});
});

describe('an import nothing can resolve', () => {
	/**
	 * The gate that had never fired.
	 *
	 * `rolldown()` builds nothing -- rolldown's own documentation says the module
	 * graph is not built until a method on the bundle is called -- so the check
	 * that used to sit between it and `write()` asked an empty array every time.
	 * A *relative* specifier is a hard error from rolldown itself, which is why
	 * this went unnoticed; a *bare* one is downgraded to "treating it as an
	 * external dependency", which is exactly the shape the gate exists for: the
	 * bundle reaches for a package at run time and the build says it succeeded.
	 *
	 * The case is the one AGENTS.md already records as what found the gate in the
	 * first place -- "a fixture app with no real `node_modules` built
	 * 'successfully' while importing `@ttylabs/sigil` at run time" -- reproduced
	 * by copying an app somewhere with no workspace above it. Nothing is planted:
	 * the unresolvable import is the runtime itself, which is what makes the
	 * failure the real one rather than a contrived one.
	 */
	let out_: string;
	let app_: string;

	beforeAll(() => {
		out_ = mkdtempSync(join(tmpdir(), 'sigil-unresolved-out-'));
		app_ = mkdtempSync(join(tmpdir(), 'sigil-unresolved-app-'));
		cpSync(app, app_, { recursive: true });
	});

	afterAll(() => {
		rmSync(out_, { force: true, recursive: true });
		rmSync(app_, { force: true, recursive: true });
	});

	it('should refuse the build and leave nothing behind', async () => {
		const found = discoverApp(app_);
		const tree = resolveCommandTree(join(app_, 'src', 'commands'));

		const failure = await bundleApp({
			app: found,
			binName: 'buildable',
			out: out_,
			tree,
		}).then(
			// spelled out rather than `rejects.toThrow`, so that a build which
			// *succeeded* fails the assertion with a sentence instead of with chai
			// complaining about `undefined`
			() => '(the build succeeded)',
			(error: unknown) => (error as Error).message
		);

		// named rather than matched loosely, so the test cannot pass because
		// something else went wrong on the way
		expect(failure).toContain('could not be resolved');
		expect(failure).toContain('@ttylabs/sigil');

		// the other half, and the reason the check cannot simply be moved after
		// the write and left there: a bundle that would die the first time it was
		// run is what the refusal is about, so handing it over anyway would answer
		// the question and then give the wrong answer
		expect(readdirSync(out_)).toStrictEqual([]);
	});
});

describe('unwinding a refused build', () => {
	/**
	 * `undo()` is asserted directly, because rolldown will not produce the name
	 * that reaches the guard.
	 *
	 * A reported `fileName` is joined onto the output directory and `join()`
	 * normalises, so `../precious.txt` resolves to a file *beside* the output
	 * directory -- and for one commit that file was deleted, because the
	 * separator check written next to the unlink only protected the directory
	 * climb. rolldown 1.2.11 refuses such a name before writing anything
	 * (`INVALID_OPTION` for an entry, `FILE_NAME_OUTSIDE_OUTPUT_DIRECTORY` for a
	 * chunk), so there is no build that demonstrates it and the only way to
	 * assert the guard is to call the function.
	 */
	let base: string;
	let out: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'sigil-undo-'));
		out = join(base, 'dist');
		mkdirSync(join(out, 'chunks'), { recursive: true });
	});

	afterEach(() => {
		rmSync(base, { force: true, recursive: true });
	});

	it('should remove what the build wrote, directory included', () => {
		writeFileSync(join(out, 'app.mjs'), 'x');
		writeFileSync(join(out, 'chunks', 'a.mjs'), 'x');
		writeFileSync(join(out, 'chunks', 'a.mjs.map'), 'x');

		undo(out, [
			{ fileName: 'app.mjs' },
			{ fileName: 'chunks/a.mjs' },
			{ fileName: 'chunks/a.mjs.map' },
		]);

		// the sourcemaps are assets in the same list, which is why they go too
		expect(readdirSync(out)).toStrictEqual([]);
	});

	it('should keep a directory something else is using', () => {
		// an `--out` the build was told not to clean may hold somebody else's
		// files, so emptiness is what bounds the climb
		writeFileSync(join(out, 'chunks', 'a.mjs'), 'x');
		writeFileSync(join(out, 'chunks', 'index.html'), 'mine');

		undo(out, [{ fileName: 'chunks/a.mjs' }]);

		expect(readdirSync(join(out, 'chunks'))).toStrictEqual(['index.html']);
	});

	it('should carry on past something it cannot remove', () => {
		// the unwind runs on a failure path, so what has to survive it is the error
		// the build was about to report. `force` covers a file that is not there
		// and not a name that turns out to be a directory, which is
		// `ERR_FS_EISDIR` -- unreachable through rolldown, and the cost of not
		// guarding it is a message about the file system in place of the real one
		mkdirSync(join(out, 'oops'));
		writeFileSync(join(out, 'app.mjs'), 'x');

		expect(() => undo(out, [{ fileName: 'oops' }, { fileName: 'app.mjs' }])).not.toThrow();
		expect(existsSync(join(out, 'app.mjs'))).toBe(false);
	});

	it('should refuse a path that climbs out of the output directory', () => {
		const precious = join(base, 'precious.txt');
		writeFileSync(precious, 'keep me');

		undo(out, [{ fileName: '../precious.txt' }, { fileName: 'chunks/../../precious.txt' }]);

		expect(existsSync(precious)).toBe(true);
	});

	it('should not read dist-old as being inside dist', () => {
		// the separator, without which a prefix test says yes to a sibling
		const sibling = join(base, 'dist-old');
		mkdirSync(sibling);
		writeFileSync(join(sibling, 'a.mjs'), 'keep me');

		undo(out, [{ fileName: '../dist-old/a.mjs' }]);

		expect(existsSync(join(sibling, 'a.mjs'))).toBe(true);
	});
});

describe('a bundle that still holds JSX', () => {
	/**
	 * `"jsx": "preserve"` asks for no transform at all, and rolldown obeys.
	 *
	 * The same failure shape as a bundle that reaches for `react`: the build
	 * reports success and the executable dies the first time it is used, here with
	 * `Unexpected token '<'`. It is a refusal rather than a thing the build
	 * honours, because `preserve` means "another tool compiles this" and a bundle
	 * is the end of the pipeline -- there is no other tool, so the only executable
	 * the setting can produce is one that will not parse.
	 *
	 * The fixture differs from `jsx-dev/` by one tsconfig field, and it
	 * type-checks: `preserve` still checks the JSX against the `JSX` namespace
	 * `jsxImportSource` names, so this is an app the build has to refuse on its own
	 * rather than one the type-check has already refused.
	 */
	let out_: string;

	beforeAll(() => {
		out_ = mkdtempSync(join(tmpdir(), 'sigil-preserve-'));
	});

	afterAll(() => {
		rmSync(out_, { force: true, recursive: true });
	});

	it('should refuse the build, name the setting, and leave nothing behind', async () => {
		const preserveApp = resolve(__dirname, '../fixtures/jsx-preserve');
		const found = discoverApp(preserveApp);
		const tree = resolveCommandTree(join(preserveApp, 'src', 'commands'));

		const failure = await bundleApp({
			app: found,
			binName: 'jsx-preserve',
			out: out_,
			tree,
		}).then(
			// spelled out rather than `rejects.toThrow`, so a build that *succeeded*
			// fails the assertion with a sentence instead of with chai complaining
			// about `undefined` -- the shape the unresolved-import test uses
			() => '(the build succeeded)',
			(error: unknown) => (error as Error).message
		);

		expect(failure).toContain('still holds JSX');
		// the setting is the fix, so the message has to name it: a message about a
		// syntax error in generated code sends the author looking at the generated
		// code, which is not where the problem is
		expect(failure).toContain('"jsx"');
		expect(failure).toContain('tsconfig.json');
		// and which chunk, because an app with one `.tsx` among fifty modules has
		// to be able to find it
		expect(failure).toMatch(/chunks\/.*\.mjs/);

		// the same reason the unresolved gate unwinds: a bundle that would die the
		// first time it was run is what the refusal is about
		expect(readdirSync(out_)).toStrictEqual([]);
	}, 60_000);
});

describe('recognising JSX in what was written', () => {
	/**
	 * `rawJsxIn()` is asserted directly, because two of the three answers it gives
	 * cannot be reached through a bundler.
	 *
	 * Only `"jsx": "preserve"` on a `.tsx` produces the positive case -- measured,
	 * `react-native` is compiled by rolldown despite `tsc` preserving it, and
	 * `compilerOptions.jsx` does not reach a `.jsx` at all. Nothing rolldown emits
	 * fails to parse for any *other* reason, which is the case this deliberately
	 * leaves alone, so a call is the only way to ask about it.
	 */
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'sigil-rawjsx-'));
	});

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true });
	});

	/** Writes a chunk and returns what `rolldown` would have reported for it. */
	function chunk(name: string, code: string) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), code);
		return { fileName: name, type: 'chunk' };
	}

	it('should say nothing about a bundle that parses', () => {
		expect(
			rawJsxIn(dir, [
				chunk('app.mjs', 'const a = 1;\nexport { a };\n'),
				// the shapes the substring probes got wrong while this was written:
				// a `<` in an operator, and the runtime's own error strings
				chunk('chunks/a.mjs', 'export const t = (a, b) => a < b ? `<text>` : "<box>";\n'),
			])
		).toBeUndefined();
	});

	it('should name the chunk that is JSX rather than JavaScript', () => {
		expect(
			rawJsxIn(dir, [
				chunk('app.mjs', 'export const ok = 1;\n'),
				chunk(
					'chunks/p.mjs',
					'function P({who}){return<text class="h">Hi, {who}!</text>}export{P};\n'
				),
			])
		).toBe('chunks/p.mjs');
	});

	it('should leave a chunk that parses as neither alone', () => {
		// not this failure, and refusing it would risk failing a build that works:
		// `oxc-parser` and the oxc inside rolldown are separately versioned, so a
		// grammar this one is behind on would read as a broken bundle
		expect(rawJsxIn(dir, [chunk('app.mjs', 'const = = ;\n')])).toBeUndefined();
	});

	it('should not read an asset, and not report one that is JSX', () => {
		// an asset is not a module, which is the line `escapeControls()` draws, and
		// finding a test for that took three goes. A *sourcemap* fails both parses
		// and falls into the conservative branch anyway, measured, so a test using
		// one is green with the skip deleted. An asset named `.jsx` parses as JSX on
		// the first call, so a test using one is green too. What is left is the two
		// things the skip really decides, and both are asserted because each covers
		// what the other does not:
		//
		// an asset with no file behind it is never **opened** -- without the skip
		// this is an `ENOENT` rather than an answer...
		expect(rawJsxIn(dir, [{ fileName: 'nothing-here.map', type: 'asset' }])).toBeUndefined();

		// ...and an asset that really is JSX under a name that is not is never
		// **reported**, which is the half a `try`/`catch` around the read could
		// otherwise fake. `notes.map` is what an app shipping a template as an asset
		// looks like: the `.map` parse fails and the `.map.jsx` parse succeeds, so
		// the discriminator would name it
		writeFileSync(join(dir, 'notes.map'), 'const a = <text>x</text>;\n');

		expect(rawJsxIn(dir, [{ fileName: 'notes.map', type: 'asset' }])).toBeUndefined();
	});
});
