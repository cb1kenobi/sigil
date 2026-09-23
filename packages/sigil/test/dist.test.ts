import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * Every module a static `import` of `entry` would load, and nothing else.
 *
 * Static rather than every specifier, because the difference is the whole
 * point: `main()` reaches the parser and the help screen through `await
 * import()`, so neither is on the graph that importing the package costs. A
 * dynamic import is spelled `import(` and a static one is `import ... from"x"`
 * or `import"x"`, so the parenthesis is what tells them apart.
 *
 * @param entry - A bundle in `dist/`, by name.
 * @returns The bundles reachable from it without calling anything.
 */
function staticGraph(entry: string): Set<string> {
	const seen = new Set<string>();
	const queue = [entry];

	while (queue.length > 0) {
		const name = queue.shift() as string;
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);

		const source = readFileSync(join(dist, name), 'utf8');
		for (const re of [/\bfrom\s*["'](\.\/[^"']+)["']/g, /\bimport\s*["'](\.\/[^"']+)["']/g]) {
			for (const [, spec] of source.matchAll(re)) {
				queue.push((spec as string).slice(2));
			}
		}
	}

	return seen;
}

describe('what importing the package costs', () => {
	/**
	 * Names only a component's implementation defines.
	 *
	 * Class names would not do: `FRAMEWORK_CSS` carries `.sigil-spinner` and
	 * every one of its siblings, and that sheet is on the help path because help
	 * is themed -- so a search for the *vocabulary* finds the theme and reports
	 * the whole component set as loaded when none of it is.
	 */
	const IMPLEMENTATIONS = [
		'createSpinner',
		'createProgress',
		'mountLive',
		'PromptError',
		'renderBar',
		'tableView',
	];

	/** The bundles in a graph that define any of them. */
	const carriers = (graph: Set<string>, symbol: string): string[] =>
		[...graph].filter((name) => readFileSync(join(dist, name), 'utf8').includes(symbol));

	it.each(IMPLEMENTATIONS)('should not load %s to import the package', (symbol) => {
		// `src/index.ts` exports `main`, `command`, `options` and the error
		// handling, and nothing else -- so a CLI that prints one line pays 4 KB
		// rather than the 124 KB the component set comes to. It is true by
		// omission, which is exactly the kind of thing that stops being true when
		// somebody adds `export * from './components/index.js'` for convenience
		// and nothing says so.
		expect(carriers(staticGraph('index.mjs'), symbol)).toEqual([]);
	});

	it.each(IMPLEMENTATIONS)('should load %s to import the components', (symbol) => {
		// the other half, and it is not decoration: a test that only asserts a
		// symbol is absent passes forever the day the symbol is renamed, and
		// would then be pinning nothing at all
		expect(carriers(staticGraph('components.mjs'), symbol)).not.toEqual([]);
	});

	it('should keep the root entry small enough to be worth it', () => {
		const graph = staticGraph('index.mjs');
		const bytes = [...graph].reduce((n, name) => n + statSync(join(dist, name)).size, 0);

		// a ceiling rather than a measurement -- it sits about 5x over the 4.1 KB
		// this is today, so ordinary growth never touches it and pulling a
		// rendering path onto the entry blows straight through it
		expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(20 * 1024);
	});
});
