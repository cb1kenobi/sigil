import {
	createShaker,
	isAppsOwn,
	scanClassEvidence,
	shakeStyles,
	shakeUtilities,
	type ClassEvidence,
} from '../../src/build/index.js';
import { generateUtilities, utilities } from '../../src/utilities/index.js';
import { parseStylesheet, UTILITY_CSS } from '@ttylabs/sigil/style';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

/** An app tree on disk, from a map of relative path to source. */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'sigil-shake-'));
	made.push(root);

	for (const [path, source] of Object.entries(files)) {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source);
	}

	return root;
}

/** The evidence one module's source leaves behind. */
function evidenceOf(source: string, name = 'src/app.ts'): ClassEvidence {
	return scanClassEvidence(tree({ [name]: source }));
}

/**
 * What an app's own source says about the classes it can name.
 *
 * The analysis is evidence rather than proof and its whole value is in *which*
 * direction each shape falls, so every one of these is a statement about that:
 * a closed literal is the class, an open one is a piece of one, and anything
 * that leaves no literal behind leaves no evidence. The unsound case is
 * asserted as deliberately as the sound ones, because it is the case the
 * safelist exists for and a test that only covered the affordances would read
 * as a claim of soundness.
 */
describe('the class evidence', () => {
	it('should read a closed literal as the class itself', () => {
		const evidence = evidenceOf(`const c = 'p-2 bold';`);

		expect(evidence.mayName('p-2')).toBe(true);
		expect(evidence.mayName('bold')).toBe(true);
		// closed means equality, so a longer name it is merely a prefix of is not
		// evidence -- this is the whole reason the open/closed distinction exists
		expect(evidence.mayName('p-2x')).toBe(false);
		expect(evidence.mayName('boldish')).toBe(false);
	});

	it('should read a template quasi next to an interpolation as an open piece', () => {
		const evidence = evidenceOf('const c = `text-${colour}`;');

		expect(evidence.mayName('text-red')).toBe(true);
		expect(evidence.mayName('text-bright-cyan')).toBe(true);
		// the piece is open on the right only, so it is a prefix and not a suffix
		expect(evidence.mayName('bg-text-')).toBe(false);
	});

	it('should read a concatenated literal as an open piece on the side it is open', () => {
		const left = evidenceOf(`const c = 'text-' + colour;`);
		const right = evidenceOf(`const c = colour + '-red';`);

		expect(left.mayName('text-green')).toBe(true);
		expect(right.mayName('text-red')).toBe(true);
		expect(right.mayName('red-text')).toBe(false);
	});

	it('should flatten a concatenation chain rather than reading its nesting', () => {
		// `x + 'b-' + y` parses as `(x + 'b-') + y`, so off the nested shape the
		// literal is the *last* operand of the inner addition and looks closed on
		// its right -- suffix evidence, which says nothing about a name the token
		// sits in the middle of. Flattened it is open on both sides, which is
		// what is true of it. This is the one shape where the two answers differ:
		// a chain whose literals are at its ends reads the same either way, which
		// is why the obvious repro passes with `flatten()` deleted
		const evidence = evidenceOf(`const c = x + 'b-' + y;`);

		expect(evidence.mayName('ab-c')).toBe(true);
	});

	it('should see through the wrappers that change nothing', () => {
		// parentheses, `as`, `satisfies` and `!` all erase or do nothing at run
		// time, so each of these is the same concatenation -- and read straight
		// off the node the operand is not a literal, the openness is never
		// applied, and the walk later reads the string as a *closed* token. That
		// is a dropped rule rather than a kept one
		for (const source of [
			`const c = ('text-') + colour;`,
			`const c = ('text-' as string) + colour;`,
			`const c = ('text-' satisfies string) + colour;`,
			`const c = 'text-'! + colour;`,
			// one level in: `(x + 'b-') + y` has to flatten through the
			// parentheses or the middle literal is only open on its left
			`const c = (x + 'text-') + colour;`,
		]) {
			expect(evidenceOf(source).mayName('text-red'), source).toBe(true);
		}
	});

	it('should read a suffix through a wrapper too', () => {
		expect(evidenceOf(`const c = colour + ('-red');`).mayName('text-red')).toBe(true);
	});

	it('should read a literal appended with +=', () => {
		// the same concatenation with the accumulator on the left, so the literal
		// is open on that side
		expect(evidenceOf(`let c = ''; c += '-red';`).mayName('text-red')).toBe(true);
	});

	it('should only open a token that touches the open end', () => {
		// the chunk is open on the right and the token is not, because the comma
		// and the space sit between them. Without this every string in an app
		// would be a prefix of something
		const evidence = evidenceOf('const s = `Hello, ${who}`;');

		expect(evidence.mayName('Hello')).toBe(true);
		expect(evidence.mayName('Hello-there')).toBe(false);
	});

	it('should read a class out of a ui template, where it sits inside the text', () => {
		const evidence = evidenceOf(
			'import { ui } from "@ttylabs/sigil/template";\n' +
				'export const v = ui`<text class="p-1 text-red">hi</text>`;'
		);

		expect(evidence.mayName('p-1')).toBe(true);
		expect(evidence.mayName('text-red')).toBe(true);
		// the quote is a boundary, so the class is not glued to the attribute
		expect(evidence.mayName('text-green')).toBe(false);
	});

	it('should read a class out of a JSX attribute', () => {
		const evidence = evidenceOf('export const v = <box class="flex-col" />;\n', 'src/view.tsx');

		expect(evidence.mayName('flex-col')).toBe(true);
	});

	it('should read the characters a class name is actually made of', () => {
		// ten base utilities are named `w-1/2` and its siblings, so a slash is
		// part of a name rather than a boundary; a colon is how a variant is
		// spelled, and leaving it out of the token would stop working silently
		// the day the variants ship rather than when somebody changed something
		const evidence = evidenceOf('const c = `<box class="w-1/2 md:flex-row" />`;');

		expect(evidence.mayName('w-1/2')).toBe(true);
		expect(evidence.mayName('md:flex-row')).toBe(true);
	});

	it('should leave no evidence for a class no literal contains', () => {
		// the unsound case, asserted as such: this is what `build.safelist` is for
		// and what the summary's count is there to make visible
		const evidence = evidenceOf(`const c = classes.join(' ');`);

		expect(evidence.mayName('p-2')).toBe(false);
	});

	it('should keep a safelisted class whatever the source says', () => {
		const root = tree({ 'src/app.ts': `const c = classes.join(' ');` });
		const evidence = scanClassEvidence(root, { safelist: ['p-2'] });

		expect(evidence.mayName('p-2')).toBe(true);
		expect(evidence.mayName('p-3')).toBe(false);
	});

	it('should fall back to a raw scan of a file that does not parse', () => {
		// strictly more conservative than the parse -- it reads identifiers and
		// comments as though they were class names -- because losing evidence can
		// drop a rule the app really names, and failing the build would refuse an
		// app over a file rolldown never reads
		const evidence = evidenceOf(`this is not ( javascript p-2`);

		expect(evidence.mayName('p-2')).toBe(true);
	});

	it('should not read node_modules, a dot directory, or an excluded one', () => {
		const root = tree({
			'dist/bundle.mjs': `const c = 'from-dist';`,
			'node_modules/dep/index.js': `const c = 'from-a-dependency';`,
			'src/app.ts': `const c = 'from-source';`,
			'.cache/old.js': `const c = 'from-a-cache';`,
		});
		const evidence = scanClassEvidence(root, { exclude: [join(root, 'dist')] });

		expect(evidence.mayName('from-source')).toBe(true);
		expect(evidence.mayName('from-a-dependency')).toBe(false);
		expect(evidence.mayName('from-a-cache')).toBe(false);
		// the one exclusion that really matters: a previous build's output holds
		// the whole utility sheet, so reading it is evidence for every rule
		expect(evidence.mayName('from-dist')).toBe(false);
	});

	it('should match an excluded directory however the caller spelled it', () => {
		const root = tree({ 'dist/bundle.mjs': `const c = 'from-dist';` });
		const evidence = scanClassEvidence(root, { exclude: [join(root, 'dist', '.', '') + '/'] });

		expect(evidence.mayName('from-dist')).toBe(false);
	});

	it('should follow a symlinked source file', () => {
		// `readdir` does not follow a link, so a `Dirent` answers `false` to both
		// `isDirectory()` and `isFile()` for one -- and rolldown follows it and
		// compiles the module, so a walk that skips it drops a rule the bundle
		// really can match.
		//
		// The target is in a **second** tree on purpose: pointed at a file inside
		// the scanned one, the walk finds the real file anyway and the test
		// passes with the link handling deleted. It did, which is how this was
		// caught
		const target = tree({ 'real.ts': `const c = 'from-a-link';` });
		const root = tree({ 'src/app.ts': `const c = 'from-source';` });
		symlinkSync(join(target, 'real.ts'), join(root, 'src', 'linked.ts'));

		const evidence = scanClassEvidence(root);
		expect(evidence.mayName('from-source')).toBe(true);
		expect(evidence.mayName('from-a-link')).toBe(true);
	});

	it('should follow a symlinked directory', () => {
		const target = tree({ 'deep/real.ts': `const c = 'from-a-linked-dir';` });
		const root = tree({ 'src/app.ts': `const c = 'from-source';` });
		symlinkSync(join(target, 'deep'), join(root, 'src', 'linked'));

		expect(scanClassEvidence(root).mayName('from-a-linked-dir')).toBe(true);
	});

	it('should walk a symlink loop once rather than once per level', () => {
		// what the loop guard is for is **cost**, not termination: the walk is
		// recursive and a link pointing back up the tree is infinite, but the
		// operating system stops it anyway -- a path through more than
		// MAXSYMLINKS links fails `readdir` with ELOOP, which this treats as an
		// unreadable directory. So the recursion ends after about thirty levels
		// with the whole tree walked about thirty times over, measured at 3.0ms
		// against 43.8ms on twenty files.
		//
		// Asserted as a **ratio** against the same tree without the link rather
		// than as a duration, for the reason the invalidation benchmark records:
		// an absolute threshold on a CI runner is a guard against the one thing
		// that says nothing, a single pass stalling. Correct is about 1.1x and
		// broken is about 15x, so four leaves headroom either way
		const files: Record<string, string> = {};
		for (let n = 0; n < 20; n++) {
			files[`src/m${n}.ts`] = `export const c${n} = 'p-${n} text-red flex-col';\n`.repeat(40);
		}

		const plain = tree(files);
		const looped = tree(files);
		symlinkSync(looped, join(looped, 'src', 'loop'));

		/** The fastest of a few runs, which is the least noisy thing to compare. */
		const fastest = (root: string): number => {
			let best = Infinity;
			for (let run = 0; run < 3; run++) {
				const at = process.hrtime.bigint();
				scanClassEvidence(root);
				best = Math.min(best, Number(process.hrtime.bigint() - at));
			}
			return best;
		};

		// warmed, so the first scan's module loading is not in either number
		fastest(plain);

		expect(scanClassEvidence(looped).mayName('flex-col')).toBe(true);
		expect(fastest(looped) / fastest(plain)).toBeLessThan(4);
	});

	it('should step over a dangling link rather than failing', () => {
		const root = tree({ 'src/app.ts': `const c = 'from-source';` });
		symlinkSync(join(root, 'gone.ts'), join(root, 'src', 'dangling.ts'));

		expect(scanClassEvidence(root).mayName('from-source')).toBe(true);
	});

	it('should read only the extensions the module parser can', () => {
		const root = tree({
			'src/a.ts': `const c = 'in-ts';`,
			'src/b.mjs': `const c = 'in-mjs';`,
			'src/c.tsx': `const c = 'in-tsx';`,
			'src/notes.md': `in-markdown`,
			'src/data.json': `{ "c": "in-json" }`,
		});
		const evidence = scanClassEvidence(root);

		for (const name of ['in-ts', 'in-mjs', 'in-tsx']) {
			expect(evidence.mayName(name), name).toBe(true);
		}
		for (const name of ['in-markdown', 'in-json']) {
			expect(evidence.mayName(name), name).toBe(false);
		}
	});
});

/**
 * The sheet that comes out the other side.
 *
 * The invariant worth pinning is that a shaken sheet is a **subset** of the
 * committed one rather than a second sheet that happens to agree: it is
 * regenerated by the generator that produced `UTILITY_CSS`, so each surviving
 * rule's text is byte for byte the text it already had.
 */
describe('the shaken sheet', () => {
	/** An evidence that says yes to exactly these names. */
	const only = (...names: string[]): ClassEvidence => ({
		mayName: (name) => names.includes(name),
	});

	it('should keep only what the evidence allows', () => {
		const sheet = shakeUtilities(only('p-2', 'flex-col'));

		expect(sheet.kept).toBe(2);
		expect(sheet.total).toBe(utilities({ variants: false }).length);
		expect(parseStylesheet(sheet.css).rules).toHaveLength(2);
	});

	it('should be a line-for-line subset of the committed sheet', () => {
		const sheet = shakeUtilities(only('p-2', 'flex-col', 'text-red'));
		const committed = new Set(UTILITY_CSS.split('\n'));

		for (const line of sheet.css.split('\n')) {
			expect(committed.has(line), line).toBe(true);
		}
	});

	it('should still be a sheet when nothing survives', () => {
		const sheet = shakeUtilities(only());

		expect(sheet.kept).toBe(0);
		expect(parseStylesheet(sheet.css).rules).toHaveLength(0);
	});

	it('should be the whole sheet when everything is named', () => {
		const sheet = shakeUtilities({ mayName: () => true });

		expect(sheet.css).toBe(UTILITY_CSS);
		expect(sheet.kept).toBe(sheet.total);
	});
});

/** A sheet to splice, small enough to read in an assertion. */
const sheet = { css: '@layer utilities {\n\t.p-2 { padding: 2 }\n}\n', kept: 1, total: 383 };

/**
 * Rewriting the call site.
 *
 * The same binding question `findTemplates()` asks, so the same shapes have to
 * be answered the same way -- and each one it *misses* is silent, which is why
 * the negatives are asserted rather than assumed.
 */
describe('rewriting utilitySheet()', () => {
	const shake = (source: string, file = '/app/src/view.ts') =>
		shakeStyles(file, source, () => sheet);

	it('should replace the call with a module-scope constant', () => {
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet();\n`
		);

		expect(out?.sites).toBe(1);
		expect(out?.code).not.toMatch(/=\s*utilitySheet\(\)/);
		expect(out?.code).toContain('parseStylesheet as $cssp');
		expect(out?.code).toContain('function $csss()');
		expect(out?.code).toContain(JSON.stringify(sheet.css));
	});

	it('should hoist the replacement rather than leaving it in a temporal dead zone', () => {
		// `utilitySheet()` answers whenever it is called, including from a module
		// reached through an import cycle before its own body has run. A `const`
		// would throw a `ReferenceError` there; a `var` and a function
		// declaration hoist, so neither can
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet();\n`
		);

		expect(out?.code).toMatch(/^import \{ parseStylesheet as \$cssp \}/);
		expect(out?.code).toContain('var $cssv;');
		expect(out?.code).not.toMatch(/\bconst \$css/);
	});

	it('should not ask for the sheet until it has found a call', () => {
		// importing from `@ttylabs/sigil/style` is ordinary and calling
		// `utilitySheet()` is not, so most modules that reach here have nothing
		// to rewrite -- and the scan behind the sheet walks the app's whole
		// source tree
		let asked = 0;
		const ask = () => {
			asked++;
			return sheet;
		};

		shakeStyles('/app/src/a.ts', `import { parseStylesheet } from '@ttylabs/sigil/style';\n`, ask);
		expect(asked).toBe(0);

		shakeStyles(
			'/app/src/b.ts',
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet();\n`,
			ask
		);
		expect(asked).toBe(1);
	});

	it('should parse the sheet once however many call sites there are', () => {
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\n` +
				`export const a = utilitySheet();\nexport const b = utilitySheet();\n`
		);

		expect(out?.sites).toBe(2);
		expect(out?.code.match(/\$cssp\(/g)).toHaveLength(1);
		expect(out?.code.match(/\$csss/g)).toHaveLength(3);
		// memoized rather than parsed per call, which is what `utilitySheet()`
		// itself does -- a rewrite that parsed twice would be slower than what it
		// replaced
		expect(out?.code).toContain('??=');
	});

	it('should follow an alias and a namespace member', () => {
		for (const source of [
			`import { utilitySheet as u } from '@ttylabs/sigil/style';\nexport const s = u();\n`,
			`import * as style from '@ttylabs/sigil/style';\nexport const s = style.utilitySheet();\n`,
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = (utilitySheet)();\n`,
		]) {
			expect(shake(source)?.sites, source).toBe(1);
		}
	});

	it('should decline a name that is not the import', () => {
		for (const source of [
			// never imported
			`function utilitySheet() {}\nexport const s = utilitySheet();\n`,
			// imported from somewhere else
			`import { utilitySheet } from './mine.js';\nexport const s = utilitySheet();\n`,
			// the wrong member of a namespace
			`import * as style from '@ttylabs/sigil/style';\nexport const s = style.parseStylesheet('');\n`,
			// a computed member, which is the shape the `desc` lift also declines
			`import * as style from '@ttylabs/sigil/style';\nexport const s = style['utilitySheet']();\n`,
			// type-only, so it erases
			`import type { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet;\n`,
		]) {
			expect(shake(source), source).toBeUndefined();
		}
	});

	it('should decline a name the module binds again', () => {
		// a name is only the import's while nothing else binds it, and there is no
		// scope tree here to ask which use site is which -- so it is given up
		const source =
			`import { utilitySheet } from '@ttylabs/sigil/style';\n` +
			`function f(utilitySheet) { return utilitySheet(); }\n`;

		expect(shake(source)).toBeUndefined();
	});

	it('should decline a call that takes arguments', () => {
		const source = `import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet(1);\n`;

		expect(shake(source)).toBeUndefined();
	});

	it('should leave a module that never calls it alone', () => {
		for (const source of [
			`export const s = 1;\n`,
			`import { parseStylesheet } from '@ttylabs/sigil/style';\nexport const s = parseStylesheet('');\n`,
			// imported and passed as a value rather than called, which is correct
			// output with the whole sheet behind it
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const f = utilitySheet;\n`,
		]) {
			expect(shake(source), source).toBeUndefined();
		}
	});

	it('should put its imports after a shebang rather than before it', () => {
		const out = shake(
			`#!/usr/bin/env node\nimport { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet();\n`
		);

		expect(out?.code.startsWith('#!/usr/bin/env node\n')).toBe(true);
		expect(out?.code.split('\n')[1]).toContain('parseStylesheet as $cssp');
	});

	it('should choose a prefix the module does not already contain', () => {
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\n` +
				`const $csss = 1, $css0s = 2;\nexport const s = utilitySheet();\n`
		);

		// `$css` and `$css0` both occur, so neither may be used: a generated name
		// that shadows one the author wrote is the outward half of the prefix
		// contract, and it is the half that turns a working build into a crash
		expect(out?.code).toContain('function $css1s()');
		expect(out?.code).toMatch(/=\s*\$css1s\(\);/);
	});

	it('should produce a map that carries the module', () => {
		// a transform that returns code without one warns SOURCEMAP_BROKEN *and*
		// silently drops the module from the map, which is the measurement
		// `compileTemplates()` records
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet();\n`
		);

		expect(out?.map.sources).toEqual(['/app/src/view.ts']);
		expect(out?.map.mappings.length).toBeGreaterThan(0);
	});
});

/** The lazy wrapper, which exists so an app that never asks pays nothing. */
describe('the shaker', () => {
	it('should report nothing until something asks for the sheet', () => {
		const shaker = createShaker(tree({ 'src/app.ts': `const c = 'p-2';` }));

		expect(shaker.result()).toBeUndefined();
		expect(shaker.sheet().kept).toBeGreaterThan(0);
		expect(shaker.result()).toBe(shaker.sheet());
	});

	it('should scan once however many modules ask', () => {
		const shaker = createShaker(tree({ 'src/app.ts': `const c = 'p-2';` }));

		expect(shaker.sheet()).toBe(shaker.sheet());
	});
});

/** The generator's own half of it. */
describe('generating a subset', () => {
	it('should keep the generated order and text rather than the caller s', () => {
		const css = generateUtilities({ only: ['p-2', 'flex-col'], variants: false });
		const reversed = generateUtilities({ only: ['flex-col', 'p-2'], variants: false });

		expect(css).toBe(reversed);
		expect(css.indexOf('.flex-col')).toBeLessThan(css.indexOf('.p-2'));
	});

	it('should ignore a name nothing generates', () => {
		// a safelist is written by hand against a vocabulary that moves between
		// releases, and failing a build over a class somebody stopped using is a
		// worse answer than generating nothing for it
		expect(() =>
			generateUtilities({ only: ['p-2', 'not-a-utility'], variants: false })
		).not.toThrow();
		expect(parseStylesheet(generateUtilities({ only: ['not-a-utility'] })).rules).toHaveLength(0);
	});

	it('should emit no empty variant blocks when nothing survives', () => {
		// an `@media` with nothing in it parses and means nothing, which is the
		// same shape as a property the engine ignores
		expect(generateUtilities({ only: [] })).toBe('@layer utilities {\n}\n');
	});

	it('should be unchanged when nothing was asked for', () => {
		expect(generateUtilities({ variants: false })).toBe(UTILITY_CSS);
	});
});

/**
 * Which modules the bundle counted as somebody else's.
 *
 * A path predicate, so it is asserted as one rather than through a bundler and
 * a real install -- which is also the only way to reach the case that matters,
 * since every fixture in this repository resolves its dependencies through a
 * workspace link and therefore has no `node_modules` of its own.
 */
describe('telling the app apart from what it depends on', () => {
	const app = resolve('/app');

	it('should count the app’s own modules as its own', () => {
		for (const file of ['/app/src/index.ts', '/app/index.ts', '/app']) {
			expect(isAppsOwn(resolve(file), app), file).toBe(true);
		}
	});

	it('should count an installed dependency as a dependency, inside the root though it is', () => {
		// the half that was missing: `<app>/node_modules/left-pad` is inside the
		// app root, so "outside the root" alone reported a normally installed app
		// as having inlined nothing at all
		for (const file of [
			'/app/node_modules/left-pad/index.js',
			'/app/node_modules/@scope/pkg/index.js',
			'/app/src/node_modules/nested/index.js',
		]) {
			expect(isAppsOwn(resolve(file), app), file).toBe(false);
		}
	});

	it('should count a linked dependency as a dependency, outside the root though it is', () => {
		// the other half: a workspace resolves to a real directory with no
		// `node_modules` in the path at all
		expect(isAppsOwn(resolve('/other/packages/sigil/dist/index.mjs'), app)).toBe(false);
	});

	it('should not read a node_modules above the app as the app’s', () => {
		// an app may perfectly well live inside one -- a package being built where
		// it was installed -- and every module of it would otherwise be filed
		// under its own name
		const installed = resolve('/host/node_modules/myapp');

		expect(isAppsOwn(resolve('/host/node_modules/myapp/src/x.ts'), installed)).toBe(true);
		expect(isAppsOwn(resolve('/host/node_modules/myapp/node_modules/dep/x.js'), installed)).toBe(
			false
		);
	});
});
