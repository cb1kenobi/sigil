import {
	createShaker,
	scanClassEvidence,
	shakeStyles,
	shakeUtilities,
	type ClassEvidence,
} from '../../src/build/index.js';
import { generateUtilities, utilities } from '../../src/utilities/index.js';
import { parseStylesheet, UTILITY_CSS } from '@ttylabs/sigil/style';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
		files: 0,
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
		const sheet = shakeUtilities({ files: 0, mayName: () => true });

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
	const shake = (source: string, file = '/app/src/view.ts') => shakeStyles(file, source, sheet);

	it('should replace the call with a module-scope constant', () => {
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\nexport const s = utilitySheet();\n`
		);

		expect(out?.sites).toBe(1);
		expect(out?.code).not.toMatch(/=\s*utilitySheet\(\)/);
		expect(out?.code).toContain('parseStylesheet as $cssp');
		expect(out?.code).toContain('const $csss =');
		expect(out?.code).toContain(JSON.stringify(sheet.css));
	});

	it('should parse the sheet once however many call sites there are', () => {
		const out = shake(
			`import { utilitySheet } from '@ttylabs/sigil/style';\n` +
				`export const a = utilitySheet();\nexport const b = utilitySheet();\n`
		);

		expect(out?.sites).toBe(2);
		expect(out?.code.match(/\$cssp\(/g)).toHaveLength(1);
		expect(out?.code.match(/\$csss/g)).toHaveLength(3);
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
		expect(out?.code).toContain('const $css1s =');
		expect(out?.code).toMatch(/=\s*\$css1s;/);
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
