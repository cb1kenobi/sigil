import { run } from '../src/index.js';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Runs the CLI with both streams captured.
 *
 * `console.warn` is captured into `err` beside `process.stderr.write`, and it is
 * not decoration: rolldown logs through `console.warn`, and vitest replaces
 * `globalThis.console` with a reporter of its own -- so a spy on
 * `process.stderr.write` never sees a bundler warning and any assertion about
 * one passes whatever the build did. Found by sabotage: removing the code that
 * suppresses a warning left the assertion green and printed the warning to the
 * terminal.
 */
async function sigil(...argv: string[]) {
	const chunks: Record<'err' | 'out', string[]> = { err: [], out: [] };
	const spies: { mockRestore: () => void }[] = (['stdout', 'stderr'] as const).map((stream) =>
		vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
			chunks[stream === 'stdout' ? 'out' : 'err'].push(chunk.toString());
			return true;
		}) as typeof process.stdout.write)
	);

	for (const level of ['error', 'warn'] as const) {
		spies.push(
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				chunks.err.push(args.map(String).join(' '));
			})
		);
	}

	try {
		await run(argv);
	} finally {
		for (const spy of spies) {
			spy.mockRestore();
		}
	}

	return { err: chunks.err.join(''), out: chunks.out.join('') };
}

/**
 * `sigil build` as a command, which is the half `bundle.test.ts` does not
 * cover: what it refuses, and what it says about what it made.
 */
describe('sigil build', () => {
	let exitCode: typeof process.exitCode;
	let out: string;

	beforeEach(() => {
		exitCode = process.exitCode;
		out = mkdtempSync(join(tmpdir(), 'sigil-build-cmd-'));
	});

	afterEach(() => {
		process.exitCode = exitCode;
		rmSync(out, { force: true, recursive: true });
		vi.restoreAllMocks();
	});

	it('should build an app and say what it made', async () => {
		const { err, out: stdout } = await sigil('build', join(fixtures, 'buildable'), '--out', out);

		expect(existsSync(join(out, 'buildable.mjs'))).toBe(true);
		expect(stdout).toContain('entry');
		expect(stdout).toContain('lazy');
		expect(err).toContain('4 commands');
		expect(process.exitCode).toBeFalsy();
	}, 60_000);

	it('should compile an app’s templates, and ship no parser for them', async () => {
		// the payoff, asserted rather than assumed: a compiled template ships no
		// parser, so the tag, the parser and the IR walk shake out of the bundle.
		// The marker is a *string literal* the parser throws, because the output is
		// minified and every identifier in it has been mangled
		const { err } = await sigil('build', join(fixtures, 'templated'), '--out', out);

		expect(err).toContain('1 template');

		const bundled = readdirSync(out, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'))
			.join('');

		expect(bundled).not.toContain('A template produces exactly one element');
		expect(bundled).not.toContain('ui`');
	}, 60_000);

	it('should compile a template in a .tsx, which the id filter used to skip', async () => {
		// the plugin's `id` filter gated on `/\.[cm]?[jt]s$/`, so a `ui` template in
		// a `.tsx` was never asked about -- bundled interpreted, omitted from the
		// count, and the parser left in with nothing saying so. Asserted end to end
		// rather than only over the pattern, because rolldown has a JSX transform of
		// its own and whether a `.tsx` reaches this hook at all is the thing a unit
		// test cannot answer.
		//
		// This fixture is built and never run from source: node cannot load a `.tsx`
		// at all, so an app with one is a built app by construction
		const { err } = await sigil('build', join(fixtures, 'templated-tsx'), '--out', out);

		expect(err).toContain('1 template');

		const built = spawnSync(process.execPath, [join(out, 'templated-tsx.mjs'), 'show'], {
			encoding: 'utf-8',
		});

		expect(built.status, built.stderr).toBe(0);
		expect(built.stdout).toContain('a template from a .tsx');

		const bundled = readdirSync(out, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'))
			.join('');

		expect(bundled).not.toContain('A template produces exactly one element');
	}, 60_000);

	it('should leave the rest of the JSX transform to the app, and say nothing about it', async () => {
		// two claims about one option, and both are decisions rather than
		// behaviours. The build sets `transform.jsx.importSource` and nothing else,
		// so this fixture's `jsx: "react-jsxdev"` still reaches
		// `@ttylabs/sigil/jsx-dev-runtime` -- adding `runtime: 'automatic'` beside
		// the import source was tried and rejected precisely because it takes that
		// away. The marker is the module's own file name, which the development
		// transform passes to `jsxDEV` as a string and which therefore survives
		// minification, where every identifier does not.
		//
		// And rolldown says `compilerOptions.jsxImportSource` was overridden
		// whether or not the two agree -- this fixture names `@ttylabs/sigil`, the
		// only thing a sigil app can name -- so the warning is noise on a correct
		// build and is dropped. A warning that fires on correct code teaches people
		// to ignore warnings.
		const { err } = await sigil('build', join(fixtures, 'jsx-dev'), '--out', out);

		expect(err).not.toContain('CONFIGURATION_FIELD_CONFLICT');
		expect(process.exitCode).toBeFalsy();

		const bundled = readdirSync(out, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'))
			.join('');

		expect(bundled).toContain('panel.tsx');

		const built = spawnSync(process.execPath, [join(out, 'jsx-dev.mjs'), 'greet'], {
			encoding: 'utf-8',
		});

		expect(built.status, built.stderr).toBe(0);
		expect(built.stdout).toContain('Hello, world!');
	}, 60_000);

	it('should build a templated app that renders what the interpreted tag does', async () => {
		// two runs of one app: the built one, whose template was compiled, and the
		// source one, whose `ui` tag parses at run time. `emitters.test.ts` proves
		// the two agree from the IR down; this proves the splice did not break it
		// once a real bundler had written the result to disk
		await sigil('build', join(fixtures, 'templated'), '--out', out);

		const built = spawnSync(process.execPath, [join(out, 'templated.mjs'), 'greet', 'Ada'], {
			encoding: 'utf-8',
		});
		const source = spawnSync(
			process.execPath,
			[join(fixtures, 'templated', 'dev.ts'), 'greet', 'Ada'],
			{ encoding: 'utf-8' }
		);

		expect(built.status, built.stderr).toBe(0);
		expect(source.status, source.stderr).toBe(0);
		expect(built.stdout).toContain('Hello, Ada!');
		expect(built.stdout).toBe(source.stdout);
	}, 60_000);

	it('should take a name for the executable', async () => {
		await sigil('build', join(fixtures, 'buildable'), '--out', out, '--name', 'renamed');
		expect(existsSync(join(out, 'renamed.mjs'))).toBe(true);
	}, 60_000);

	it('should refuse an app that does not check out', async () => {
		// bundling an app with a type error produces an executable nobody should
		// run, and finding out at run time what a compiler knew at build time is
		// the thing a build is for
		const { err } = await sigil('build', join(fixtures, 'typecheck', 'broken'), '--out', out);

		expect(err).toContain('TS2322');
		expect(process.exitCode).toBe(1);
		expect(existsSync(join(out, 'broken-app.mjs'))).toBe(false);
	}, 60_000);

	it('should build despite a warning, which is not a failure', async () => {
		// a description the build could not read leaves a command exactly where an
		// unbundled one is
		const { err } = await sigil('build', join(fixtures, 'app'), '--out', out);

		expect(err).toContain('warning');
		expect(process.exitCode).toBeFalsy();
		expect(existsSync(join(out, 'fixture-app.mjs'))).toBe(true);
	}, 60_000);

	it('should refuse --bin beside a filesystem command directory', async () => {
		// a built executable has no directories to walk, so an app bundled as it
		// stands would read paths that are not beside it
		const { err } = await sigil(
			'build',
			join(fixtures, 'buildable'),
			'--out',
			out,
			'--bin',
			'src/index.ts'
		);

		expect(err).toContain('Cannot combine --bin');
		expect(process.exitCode).toBe(1);
	}, 60_000);

	it('should refuse a directory that is not a sigil app', async () => {
		const { err } = await sigil('build', join(fixtures, 'discover', 'not-an-app'), '--out', out);

		expect(err).toContain('does not depend on @ttylabs/sigil');
		expect(process.exitCode).toBe(1);
	});

	it.skipIf(process.platform === 'win32')(
		'should report an --out it cannot write as being about that',
		async () => {
			// the one way to make `bundle.write()` itself reject, which is what
			// `bundle-close.test.ts` needs and is worth pinning from the command as
			// well: what the user is told has to name the directory rather than
			// whatever went wrong on the way out of it. An `--out` that is an
			// existing *file* does not reach here -- the clean step removes it and
			// makes a directory in its place, measured -- so the read-only parent is
			// the case.
			//
			// Skipped on Windows, where a mode of `0o500` on a directory does not
			// stop anything being created inside it, which is the same reason the
			// executable-bit assertion is skipped in `bundle.test.ts`
			const readonly = join(out, 'readonly');
			mkdirSync(readonly);
			chmodSync(readonly, 0o500);

			try {
				const { err } = await sigil(
					'build',
					join(fixtures, 'buildable'),
					'--out',
					join(readonly, 'dist')
				);

				expect(err).toContain('Could not create directory');
				expect(err).toContain(join(readonly, 'dist'));
				expect(process.exitCode).toBe(1);
			} finally {
				// or `afterEach`'s own `rmSync` cannot get inside it either
				chmodSync(readonly, 0o700);
			}
		},
		60_000
	);
});
