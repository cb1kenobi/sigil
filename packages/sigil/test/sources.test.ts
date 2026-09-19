import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What is committed, read as bytes.
 *
 * The other half of the rule `dist.test.ts` keeps. That one says what ships
 * carries no raw control character, because the minifier puts back what the
 * source was careful to avoid; this one says the *source* carries none either,
 * which is the half that had never been checked and was being broken by the very
 * file that fixes the other.
 *
 * `tsdown.config.ts` held its escape regex as a character class of literal
 * bytes, a NUL among them, and git calls a file binary the moment it finds one
 * in the first 8000 bytes -- so the file whose whole job is to keep raw control
 * characters out of the build was unreviewable on GitHub, showing `Bin 2786 ->
 * 2858 bytes` instead of a diff. `canvas/style.ts` had the same literal NUL far
 * enough in that the heuristic missed it, which is the same bug waiting for the
 * file to grow.
 *
 * Neither was wrong to the regex engine. That is the point: a raw control
 * character in source is invisible in an editor and in a diff, and the damage it
 * does is to the people reading it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Tab, newline and carriage return: the file's own formatting, not a sequence. */
const FORMATTING = new Set([0x09, 0x0a, 0x0d]);

/**
 * What is allowed to hold one anyway.
 *
 * A test that feeds a terminal's own bytes to a decoder is describing those
 * bytes, and writing `ESC [ A` as an escape there would be describing something
 * else. They are listed rather than inferred so that a new one is a decision.
 */
const ALLOWED = new Set([
	'demos/canvas/01-sparkline.js',
	'demos/canvas/02-image.js',
	'demos/canvas/03-links.js',
	'packages/sigil/test/ansi/strip.test.ts',
	'packages/sigil/test/components/helpers.ts',
	'packages/sigil/test/components/keys.test.ts',
	'packages/sigil/test/components/prompt.test.ts',
	'packages/sigil/test/input/input.test.ts',
	'website/src/app/favicon.ico',
]);

/** Everything git is tracking, which is what a reviewer sees. */
function tracked(): string[] {
	return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 24 })
		.toString('utf8')
		.split('\0')
		.filter(Boolean);
}

describe('committed sources', () => {
	const files = tracked().filter((name) => !ALLOWED.has(name));

	it('should be tracked, so that this is testing something', () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it('should carry no raw control character', () => {
		const offenders: string[] = [];

		for (const name of files) {
			let raw: Buffer;
			try {
				raw = readFileSync(join(root, name));
			} catch {
				// a path git knows about and the disk does not: a submodule, or a file
				// removed but not yet staged. Neither is this test's business
				continue;
			}

			const found = new Set<number>();
			for (const byte of raw) {
				if (FORMATTING.has(byte)) {
					continue;
				}
				// C0 and DEL as bytes. C1 arrives as UTF-8 rather than as a byte, so it
				// is read from the decoded text below instead
				if (byte < 0x20 || byte === 0x7f) {
					found.add(byte);
				}
			}

			for (const char of raw.toString('utf8')) {
				const code = char.codePointAt(0) ?? 0;
				if (code >= 0x80 && code <= 0x9f) {
					found.add(code);
				}
			}

			if (found.size > 0) {
				const names = [...found]
					.sort((a, b) => a - b)
					.map((code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
				offenders.push(`${name}: ${names.join(', ')}`);
			}
		}

		expect(offenders, offenders.join('\n')).toEqual([]);
	});

	it('should be text to git, which is what makes a diff readable', () => {
		// the observable half of the same rule, and the one that was actually
		// costing something: git's own test is a NUL in the first 8000 bytes, so a
		// file can hold raw control characters for years and only become binary the
		// day one of them moves far enough up
		const binary: string[] = [];

		for (const name of files) {
			let raw: Buffer;
			try {
				raw = readFileSync(join(root, name));
			} catch {
				continue;
			}
			if (raw.subarray(0, 8000).includes(0)) {
				binary.push(name);
			}
		}

		expect(binary, binary.join('\n')).toEqual([]);
	});
});
