import { run } from '../src/index.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Runs the CLI with both streams captured. */
async function sigil(...argv: string[]) {
	const chunks: Record<'err' | 'out', string[]> = { err: [], out: [] };
	const spies = (['stdout', 'stderr'] as const).map((stream) =>
		vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
			chunks[stream === 'stdout' ? 'out' : 'err'].push(chunk.toString());
			return true;
		}) as typeof process.stdout.write)
	);

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
});
