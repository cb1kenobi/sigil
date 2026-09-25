import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The compiler bootstrap: the toolchain building itself, twice.
 *
 * Stage 0 is `node src/sigil.ts`, which runs from source with no build step --
 * the escape hatch for a clean checkout, and for a broken build that cannot
 * build its own fix. Stage 1 is what stage 0 produces. Stage 2 is what *stage
 * 1* produces, and it has to be byte-identical to stage 1.
 *
 * What that catches is a class of bug nothing else here can see: a build whose
 * output depends on something about the builder rather than only on the source.
 * Two runs of the same binary agreeing proves determinism; two *different*
 * binaries agreeing proves the compiler is a fixed point, which is the claim
 * "the toolchain is written in itself" actually rests on.
 *
 * It is a test rather than a CI step because it costs 336ms, and a check that
 * only runs somewhere else is one nobody sees fail until later. The two stages
 * are built inside the package so that the externals resolve: what
 * `sigil build` emits imports `@ttylabs/sigil`, `oxc-parser` and `rolldown`
 * rather than inlining them, and node resolves those by walking up from the
 * file.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'sigil.ts');

let work: string;
let stage1: string;
let stage2: string;

/** Runs a sigil binary, failing loudly rather than leaving a silent build. */
function build(bin: string, out: string): void {
	const result = spawnSync(process.execPath, [bin, 'build', '--out', out], {
		cwd: root,
		encoding: 'utf-8',
	});

	expect(result.status, `${relative(root, bin)} build failed:\n${result.stderr}`).toBe(0);
}

/** Every file in a directory, relative and sorted, so two trees can be compared. */
function tree(dir: string): string[] {
	const found: string[] = [];

	const walk = (at: string): void => {
		for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name)
		)) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else {
				// forward-slashed, because the comparison is between two trees and
				// not against a path somebody typed
				found.push(relative(dir, path).split(sep).join('/'));
			}
		}
	};

	walk(dir);
	return found;
}

beforeAll(() => {
	// inside the package, so `@ttylabs/sigil`, `oxc-parser` and `rolldown`
	// resolve from the built files the way they would once published
	work = mkdtempSync(join(root, '.bootstrap-'));
	stage1 = join(work, 'stage1');
	stage2 = join(work, 'stage2');

	build(source, stage1);
	build(join(stage1, 'sigil.mjs'), stage2);
}, 120_000);

afterAll(() => {
	rmSync(work, { force: true, recursive: true });
});

describe('the bootstrap', () => {
	it('should write the same files at both stages', () => {
		// the file names carry rolldown's content hashes, so a set that matches is
		// already most of the claim -- and naming the difference beats a byte
		// count nobody can act on
		expect(tree(stage2)).toStrictEqual(tree(stage1));
	});

	it('should write byte-identical contents', () => {
		for (const file of tree(stage1)) {
			const one = readFileSync(join(stage1, file));
			const other = readFileSync(join(stage2, file));

			expect(other.equals(one), `${file} differs between stage 1 and stage 2`).toBe(true);
		}
	});

	it('should produce a binary that works, not merely one that matches', () => {
		// two identical broken binaries would satisfy everything above, so the
		// fixed point has to be a *working* fixed point
		const result = spawnSync(process.execPath, [join(stage2, 'sigil.mjs'), '--help'], {
			cwd: root,
			encoding: 'utf-8',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage: sigil');
		expect(result.stdout).toContain('Build an app into a bundle that depends on nothing');
	});

	it('should build an app with the stage 2 binary', () => {
		// the whole point of the toolchain, asked of the copy that was built by a
		// copy: a self-hosted compiler that cannot compile is a fixed point and
		// nothing else
		const out = join(work, 'app');
		const result = spawnSync(
			process.execPath,
			[
				join(stage2, 'sigil.mjs'),
				'build',
				join(root, 'test', 'fixtures', 'buildable'),
				'--out',
				out,
			],
			{ cwd: root, encoding: 'utf-8' }
		);

		expect(result.status, result.stderr).toBe(0);

		const ran = spawnSync(process.execPath, [join(out, 'buildable.mjs'), '--help'], {
			encoding: 'utf-8',
		});

		expect(ran.status).toBe(0);
		expect(ran.stdout).toContain('Usage: buildable');
	});
});
