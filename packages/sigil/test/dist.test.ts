import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What ships, read as bytes.
 *
 * Everything else in this suite tests `src/`, which is the right default: `dist/`
 * is what the bundler made of it and testing the bundler is not this project's
 * job. This file is the exception, because one property of the output cannot be
 * seen from the source at all -- the minifier constant-folds
 * `String.fromCharCode(0x1b)` back into a raw byte, so the care `src/ansi/codes.ts`
 * takes is undone somewhere nobody was looking.
 *
 * Reads `dist/`, so it needs a build first, which is what `pnpm test` does and
 * what `@ttylabs/cli`'s tests already require.
 */

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Tab, newline and carriage return: the file's own formatting, not a sequence. */
const FORMATTING = new Set([0x09, 0x0a, 0x0d]);

/** Whether a code point is one a terminal would act on rather than print. */
function isControl(code: number): boolean {
	if (FORMATTING.has(code)) {
		return false;
	}
	// C0 and DEL, then C1 -- where U+009B is a CSI all by itself, and is one of
	// the two escapes `codes.ts` builds
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

describe('the shipped bundles', () => {
	const files = readdirSync(dist).filter((name) => name.endsWith('.mjs'));

	it('should have been built', () => {
		// a missing `dist/` is a build that did not run, not a passing test
		expect(files.length, `no bundles in ${dist}; run \`pnpm build\``).toBeGreaterThan(0);
	});

	it.each(files)('should carry no raw control characters: %s', (name) => {
		// a raw `ESC` in a shipped file is a sequence waiting for something to
		// print it, and Node prints the offending source line on an uncaught
		// error -- so a crash anywhere inside the bundle wrote `ESC ] 8 ; ;` to
		// the user's terminal and left every line after it inside a hyperlink
		// nothing closed. The build escapes them; this is what says it still does
		const text = readFileSync(join(dist, name), 'utf8');
		const found = new Map<number, number>();

		for (const char of text) {
			const code = char.codePointAt(0) ?? 0;
			if (isControl(code)) {
				found.set(code, (found.get(code) ?? 0) + 1);
			}
		}

		const report = [...found]
			.map(([code, count]) => `U+${code.toString(16).toUpperCase().padStart(4, '0')} x${count}`)
			.join(', ');

		expect(found.size, `${name} ships raw control characters: ${report}`).toBe(0);
	});

	it('should still spell the escapes it needs', () => {
		// the other half of it: escaping them must not have taken them away. The
		// styler cannot work without an `ESC`, and a build that dropped one would
		// pass the check above by being wrong
		const ansi = readFileSync(join(dist, 'ansi.mjs'), 'utf8');
		const imported = readdirSync(dist)
			.filter((name) => name.endsWith('.mjs'))
			.map((name) => readFileSync(join(dist, name), 'utf8'))
			.join('');

		expect(ansi.length).toBeGreaterThan(0);
		expect(imported).toMatch(/\\x1B/i);
	});
});
