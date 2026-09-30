/**
 * What the class-evidence walk reads, counted rather than timed.
 *
 * `scanClassEvidence()` keeps an `entered` set of real paths so that a symlink
 * pointing back up the tree is followed once rather than forever. What that
 * guard is for is **cost** rather than termination -- the operating system stops
 * an infinite walk anyway, since a path through more than MAXSYMLINKS links
 * fails `readdir` with ELOOP, which the walk treats as an unreadable directory
 * -- so without it the recursion ends after about thirty levels having walked
 * the whole tree about thirty times over.
 *
 * That claim is a **count**, and it used to be asserted as a duration: the same
 * tree with and without the loop, timed, with the ratio required to come in
 * under four. It was a proxy for the thing rather than the thing, and it flaked.
 * Measured over five full-suite runs, correct behaviour gives ratios of 0.69,
 * 0.93, 0.98, 1.04 and 1.27 -- the loop really does cost nothing -- while each
 * side's own absolute figure moves by a factor of 1.8 between runs, 3.2ms to
 * 5.7ms on twenty files. One full-suite run reported **5.41** and failed the
 * build over a walk with nothing wrong with it.
 *
 * Taking the fastest of three runs per side, which is what it did, only helps
 * where contention is intermittent *within* the sampling window. The two sides
 * were measured in separate windows, so a sustained stall over one of them
 * inflates all three of its samples and the minimum with them -- which is the
 * batched-against-interleaved failure AGENTS.md already records for the
 * style-shaking measurement, in a suite that runs eighteen workers at once.
 * Interleaving would have narrowed it and left a timing test behind; counting
 * removes the question, because "read once rather than once per level" is
 * literally what is now asserted.
 *
 * `node:fs` is mocked the way `bundle-close.test.ts` mocks `rolldown` and for
 * its reason: the walk is inside `scanClassEvidence()`, nothing outside can see
 * what it read, and the alternative is a counter on production code whose only
 * reader would be this file. The real `readdirSync` and `readFileSync` run and
 * the wrapper only records. A file of its own, because `vi.mock` is hoisted and
 * module-wide.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Every path handed to `readdirSync`, in order, since the last `reads()`. */
const dirs: string[] = [];

/** Every path handed to `readFileSync`, in order, since the last `reads()`. */
const files: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs')>();

	return {
		...real,
		readdirSync: (path: Parameters<typeof real.readdirSync>[0], ...rest: unknown[]) => {
			dirs.push(String(path));
			return (real.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
		},
		readFileSync: (path: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
			files.push(String(path));
			return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
		},
	};
});

const { scanClassEvidence } = await import('../../src/build/shake.ts');

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

/** An app tree on disk, from a map of relative path to source. */
function tree(sources: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'sigil-walk-'));
	made.push(root);

	for (const [path, source] of Object.entries(sources)) {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source);
	}

	return root;
}

/**
 * Scans `root` and reports what the walk read inside it.
 *
 * Filtered to the tree rather than counted wholesale, because this process
 * reads plenty of files that are none of the walk's doing -- and a count that
 * included them would be a number nobody could predict. Reset here rather than
 * in a `beforeEach`, so there is no state between tests to be wrong about.
 *
 * @param root - The tree to scan.
 * @returns The directories and files read under it, in order.
 */
function reads(root: string): { dirs: string[]; files: string[] } {
	dirs.length = 0;
	files.length = 0;
	scanClassEvidence(root);

	return {
		dirs: dirs.filter((path) => path.startsWith(root)),
		files: files.filter((path) => path.startsWith(root)),
	};
}

/** Twenty modules under `src/`, each naming a class, plus anything else asked for. */
function app(extra: Record<string, string> = {}): Record<string, string> {
	const sources: Record<string, string> = { ...extra };
	for (let n = 0; n < 20; n++) {
		sources[`src/m${n}.ts`] = `export const c${n} = 'p-${n} text-red flex-col';\n`;
	}
	return sources;
}

describe('the class-evidence walk', () => {
	it('should read each directory once and each module once', () => {
		// the baseline the loop is compared against, asserted absolutely so that the
		// comparison below cannot be satisfied by both sides being wrong together
		const read = reads(tree(app()));

		expect(read.dirs).toHaveLength(2);
		expect(read.files).toHaveLength(20);
		expect(new Set(read.dirs).size).toBe(read.dirs.length);
		expect(new Set(read.files).size).toBe(read.files.length);
	});

	it('should walk a symlink loop once rather than once per level', () => {
		// the claim, and it is exact: a link pointing back at the root is entered,
		// found in `entered` by its real path, and returned from before its
		// `readdir`. So a loop costs one `realpath` and changes no count at all,
		// where without the guard every directory and every file would be read
		// about thirty times over
		const root = tree(app());
		symlinkSync(root, join(root, 'src', 'loop'));

		const read = reads(root);

		expect(read.dirs).toHaveLength(2);
		expect(read.files).toHaveLength(20);
		// no path twice, which is what "once rather than once per level" says
		expect(new Set(read.dirs).size).toBe(read.dirs.length);
		expect(new Set(read.files).size).toBe(read.files.length);
	});

	it('should read the same tree the same way whether or not the loop is there', () => {
		// the differential, which is the form the timing test was reaching for and
		// could only approximate. Paths are compared relative to each root, since
		// the two trees are two `mkdtemp` directories
		const plain = tree(app());
		const looped = tree(app());
		symlinkSync(looped, join(looped, 'src', 'loop'));

		const relative = (root: string) => {
			const read = reads(root);
			return {
				dirs: read.dirs.map((path) => path.slice(root.length)).sort(),
				files: read.files.map((path) => path.slice(root.length)).sort(),
			};
		};

		expect(relative(looped)).toEqual(relative(plain));
	});

	it('should follow a link to a directory outside the tree exactly once', () => {
		// the other half of what `entered` is keyed on real paths for: two links to
		// one directory are one directory, so a tree reaching the same place twice
		// reads it once. Counted outside the root, which is where the target is
		const target = tree({ 'deep/shared.ts': `const c = 'from-a-linked-dir';` });
		const root = tree(app());
		symlinkSync(join(target, 'deep'), join(root, 'src', 'one'));
		symlinkSync(join(target, 'deep'), join(root, 'src', 'two'));

		dirs.length = 0;
		files.length = 0;
		const evidence = scanClassEvidence(root);

		expect(evidence.mayName('from-a-linked-dir')).toBe(true);
		// the file behind both links is read once
		expect(files.filter((path) => path.endsWith('shared.ts'))).toHaveLength(1);
		// and only one of the two links is entered. Asserted on the paths the walk
		// *walked* rather than on the target's real path, because `join()` builds
		// each path from the link it came through -- which is why the target's own
		// spelling appears nowhere in what was read. Which of the two wins is
		// `readdir` order and none of this test's business
		expect(dirs.filter((path) => /\/(?:one|two)$/.test(path))).toHaveLength(1);
	});
});
