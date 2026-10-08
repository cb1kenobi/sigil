import {
	choosePrefix,
	compileTemplates,
	TemplateCompileError,
} from '../../src/build/compile-templates.js';
import { MODULE_RE } from '../../src/build/index.js';
import { renderToString } from '@ttylabs/sigil/element';
import { ui } from '@ttylabs/sigil/template';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The splice: `compile()`'s output written back into the module it came from.
 *
 * `emitters.test.ts` already asserts the interpreted, analyzed and compiled
 * paths agree over a corpus, so what is new here is putting the result back
 * into a file -- which is where the prefix contract and the source map live.
 */

// inside the package rather than in the OS temp directory, because what is
// written here imports `@ttylabs/sigil` and node resolves that by walking up
// from the file -- the same reason `bootstrap.test.ts` builds its stages here
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(root, '.splice-'));

afterAll(() => {
	rmSync(work, { force: true, recursive: true });
});

/** A module using the tag, with `body` as the template. */
function moduleWith(body: string, extra = ''): string {
	return `import { ui } from '@ttylabs/sigil/template';\n${extra}export const view = () => ${body};\n`;
}

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Which original line a generated line maps back to, by reading the mappings.
 *
 * Decoded here rather than with a library, because the question is one line long
 * and the packages that answer it are not dependencies this repo has. A source
 * map's `mappings` is `;`-separated generated lines, `,`-separated segments, each
 * segment base64-VLQ fields where the third is the original line **as a delta
 * carried across the whole string** -- which is why this walks from the start
 * rather than jumping to the line asked about.
 *
 * @param mappings - The `mappings` field.
 * @param generated - A one-based generated line.
 * @returns The one-based original line, or `undefined` where nothing is mapped.
 */
function originalLineOf(mappings: string, generated: number): number | undefined {
	let line = 0;
	let found: number | undefined;

	mappings.split(';').forEach((group, index) => {
		if (!group) {
			return;
		}
		for (const segment of group.split(',')) {
			let shift = 0;
			let value = 0;
			const fields: number[] = [];
			for (const char of segment) {
				const digit = VLQ.indexOf(char);
				value += (digit & 31) << shift;
				if (digit & 32) {
					shift += 5;
					continue;
				}
				fields.push(value & 1 ? -(value >> 1) : value >> 1);
				shift = 0;
				value = 0;
			}
			if (fields.length >= 4) {
				line += fields[2]!;
			}
			if (index + 1 === generated && found === undefined) {
				found = line + 1;
			}
		}
	});

	return found;
}

/** Imports a compiled module and renders what its `view` builds. */
async function renderCompiled(source: string, file = 'view.ts'): Promise<string> {
	const compiled = compileTemplates(`/app/${file}`, source);
	expect(compiled, 'nothing was compiled').toBeDefined();

	// written and imported, because the claim is that the output is a *module* --
	// valid JavaScript whose imports resolve and whose expression builds a tree.
	// Inside the package so that `@ttylabs/sigil` resolves the way it would in an
	// app
	const path = join(work, `${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(path, compiled!.code);
	const mod = (await import(path)) as { view: () => unknown };

	return renderToString(mod.view() as never, { colorLevel: 0, width: 40 });
}

describe('compiling a module’s templates', () => {
	describe('the prefix contract', () => {
		it('should pick a prefix the module does not contain', () => {
			expect(choosePrefix('const a = 1;')).toBe('$ui');
		});

		it('should escalate until the module really does not contain it', () => {
			// the outward half of the contract: a local named like a generated one
			// shadows it, so the search is over the whole module rather than over
			// the templates
			expect(choosePrefix('const $ui = 1;')).toBe('$ui0');
			expect(choosePrefix('const $ui = 1, $ui0 = 2;')).toBe('$ui1');
			expect(choosePrefix('$ui $ui0 $ui1 $ui2')).toBe('$ui3');
		});

		it('should never return a prefix the source contains, whatever it holds', () => {
			// including in a comment or a string, which is deliberate: it costs a
			// longer name in a module that merely mentions the prefix in prose, and
			// it keeps the search a plain substring test rather than something that
			// has to know where it is looking
			for (const source of [
				'// $ui is mentioned here',
				'const s = "$ui0 in a string";',
				'/* $ui $ui0 $ui1 */',
				'$ui'.repeat(50),
			]) {
				expect(source).not.toContain(choosePrefix(source));
			}
		});

		it('should keep the generated names out of an expression’s scope', async () => {
			// The inward half: an interpolated expression is printed back into the
			// scope the generated locals are declared in, so an author's own name
			// must still be the one their expression reads.
			//
			// The names have to be ones the emitter would *actually* generate, which
			// is the prefix plus `e0`, `s0`, or an imported helper. A first version of
			// this declared `$ui` and `$ui0` and passed even with the scan disabled,
			// because a prefix of `$ui` generates `$uie0` and `$uis0` and collides
			// with neither -- vacuous for the one thing it is named for
			const source = `import { ui } from '@ttylabs/sigil/template';
const $uie0 = 'the author\\'s own';
const $uitext = 'and another';
export const view = () => ui\`<text>\${$uie0} \${$uitext}</text>\`;
`;

			expect(await renderCompiled(source)).toBe("the author's own and another");
		});
	});

	describe('the splice', () => {
		it('should say there was nothing to do when a module has no templates', () => {
			// `undefined` rather than the source back: a transform that returns a
			// string is a transform rolldown has to map, and a module with no
			// templates has nothing to map
			expect(compileTemplates('/app/a.ts', 'export const a = 1;')).toBeUndefined();
			// the tag has to be imported to count, which is `templatesIn()`'s rule
			expect(
				compileTemplates('/app/a.ts', 'const ui = String; ui`<text>x</text>`;')
			).toBeUndefined();
		});

		it('should build the same tree the interpreted tag does', async () => {
			// the whole claim, end to end: the same template through the compiler and
			// through the tag, rendered, compared. `emitters.test.ts` proves this over
			// a corpus from the IR down; this proves the splice did not break it
			const template = '<box flex-direction="column"><text>one</text><text>two</text></box>';
			const compiled = await renderCompiled(moduleWith(`ui\`${template}\``));
			const interpreted = renderToString(
				ui`<box flex-direction="column"><text>one</text><text>two</text></box>`,
				{
					colorLevel: 0,
					width: 40,
				}
			);

			expect(compiled).toBe(interpreted);
		});

		it('should compile every template in a module, not just the first', async () => {
			const source = `import { ui } from '@ttylabs/sigil/template';
export const one = () => ui\`<text>first</text>\`;
export const two = () => ui\`<text>second</text>\`;
`;
			const compiled = compileTemplates('/app/two.ts', source);

			expect(compiled?.count).toBe(2);
			expect(compiled?.code).not.toContain('ui`');
			// each template's own content, because a count of 2 and an absent tag are
			// both satisfied by splicing the *first* template's output over both
			// spans -- which is the off-by-one `sources[at]` exists to avoid
			expect(compiled?.code).toContain('"first"');
			expect(compiled?.code).toContain('"second"');
		});

		it('should keep a shebang on the first line', () => {
			// an `import` in front of `#!` leaves a module whose first line is a
			// syntax error to node and which the kernel will not exec either
			const source = `#!/usr/bin/env node\n${moduleWith('ui`<text>x</text>`')}`;
			const compiled = compileTemplates('/app/bin.ts', source);

			expect(compiled?.code.startsWith('#!/usr/bin/env node\n')).toBe(true);
			expect(compiled?.code).toContain('@ttylabs/sigil/element');
		});

		it('should leave the module’s own code alone', async () => {
			// a pure optimizer: only the template spans are rewritten, and everything
			// around them is the author's
			const source = `import { ui } from '@ttylabs/sigil/template';
const greeting = 'hello';
export const view = () => ui\`<text>\${greeting}</text>\`;
export const untouched = () => 'still here';
`;
			const compiled = compileTemplates('/app/a.ts', source);

			expect(compiled?.code).toContain("const greeting = 'hello';");
			expect(compiled?.code).toContain("export const untouched = () => 'still here';");
			// the template really was replaced: the interpreted tag renders `hello`
			// too, so the render below passes just as happily on a module nothing
			// rewrote
			expect(compiled?.code).not.toContain('ui`');
			expect(compiled?.code).toContain('@ttylabs/sigil/element');
			expect(await renderCompiled(source)).toBe('hello');
		});
	});

	describe('the source map', () => {
		it('should come back with the module in it and something mapped', () => {
			// a transform that returns code without a map is `SOURCEMAP_BROKEN` *and*
			// silently drops the module from the map -- measured on rolldown, a
			// two-source map became one and the transformed file was simply not in it
			const compiled = compileTemplates('/app/view.ts', moduleWith('ui`<text>x</text>`'));

			expect(compiled?.map.sources).toEqual(['/app/view.ts']);
			expect(compiled?.map.mappings.length).toBeGreaterThan(0);
			expect(compiled?.map.sourcesContent?.[0]).toContain('ui`');
		});

		it('should map a line after the splice back to where it was written', () => {
			// present is not the same as *correct*, and the assertion above only says
			// present. The head the splice prepends shifts every line after it, so a
			// map that merely existed would send a stack trace somewhere near but
			// wrong -- which is worse than none, because it reads as authoritative
			const source = [
				"import { ui } from '@ttylabs/sigil/template';", // 1
				'', // 2
				'export function makeView(name) {', // 3
				'  return ui`<text>${name}</text>`;', // 4
				'}', // 5
				'', // 6
				'export function afterwards() {', // 7
				"  throw new Error('here');", // 8
				'}', // 9
			].join('\n');

			const compiled = compileTemplates('/app/view.ts', source);
			const lines = compiled!.code.split('\n');
			const generated = lines.findIndex((line) => line.includes("Error('here')")) + 1;

			// the head really did move it, or this proves nothing
			expect(generated).toBeGreaterThan(8);
			expect(originalLineOf(compiled!.map.mappings, generated)).toBe(8);
			expect(
				originalLineOf(
					compiled!.map.mappings,
					lines.findIndex((line) => line.includes('export function afterwards')) + 1
				)
			).toBe(7);
		});
	});

	describe('a template that cannot be compiled', () => {
		it('should name the file and the line rather than throwing from inside', () => {
			// what is decidable from the IR fails the build rather than the frame,
			// which is the rule the utility generator already follows -- and a
			// diagnostic without a position is one nobody can act on
			const source = `import { ui } from '@ttylabs/sigil/template';

export const view = () => ui\`<text><box /></text>\`;
`;
			let thrown: unknown;
			try {
				compileTemplates('/app/bad.ts', source);
			} catch (e: unknown) {
				thrown = e;
			}

			expect(thrown).toBeInstanceOf(TemplateCompileError);
			expect((thrown as TemplateCompileError).file).toBe('/app/bad.ts');
			expect((thrown as TemplateCompileError).line).toBe(3);
			expect((thrown as TemplateCompileError).message).toContain('/app/bad.ts:3:');
		});

		it('should rewrite nothing when any template in the module fails', () => {
			// a half-spliced module is a worse thing to hand a bundler than an error,
			// so every template's IR is built before anything is written back
			const source = `import { ui } from '@ttylabs/sigil/template';
export const fine = () => ui\`<text>ok</text>\`;
export const broken = () => ui\`<text><box /></text>\`;
`;

			expect(() => compileTemplates('/app/mixed.ts', source)).toThrow(TemplateCompileError);
			// and it names the *broken* template rather than merely throwing: the
			// good one is line 2
			expect(() => compileTemplates('/app/mixed.ts', source)).toThrow('/app/mixed.ts:3:');
		});

		it('should name the template a whole-module compile failure was about', () => {
			// `compile()` is handed every template at once and what it throws names
			// none of them, so the first template's position was the answer for one
			// commit -- a location pointing at code the author would read, find
			// correct, and be stuck on. `<raw>` with a literal measure is the case
			// that gets past `parse()` and fails in `compile()`
			const source = `import { ui } from '@ttylabs/sigil/template';
export const fine = () => ui\`<text>ok</text>\`;
export const broken = () => ui\`<raw measure="nope" paint="nope" />\`;
`;

			let thrown: unknown;
			try {
				compileTemplates('/app/raw.ts', source);
			} catch (e: unknown) {
				thrown = e;
			}

			expect(thrown).toBeInstanceOf(TemplateCompileError);
			expect((thrown as TemplateCompileError).line).toBe(3);
			expect((thrown as TemplateCompileError).message).toContain('measure');
		});
	});

	describe('which modules are asked at all', () => {
		it('should admit every extension the compiler can actually read', () => {
			// the invariant, rather than a list: the plugin's `id` filter and what
			// `compileTemplates()` can parse are two things that have to agree, and
			// the gap between them is a template nobody compiles and nobody is told
			// about. `.tsx` and `.jsx` were exactly that gap
			//
			// Each extension is given source it can legally hold, which is what one
			// ESM fixture for all eight got wrong: a `.cjs` and a `.cts` are
			// CommonJS, so an `import` statement in either is a file Node refuses to
			// load -- checked with `node` rather than assumed. oxc-parser took it
			// until 0.153 and refuses the `.cjs` now, which is the stricter and the
			// correct reading; it still reads a `.cts` as a module, so this does not
			// rest on which of the two it happens to refuse today.
			const esm = `import { ui } from '@ttylabs/sigil/template';
export const view = () => ui\`<text>x</text>\`;
`;
			const cjs = `const { ui } = require('@ttylabs/sigil/template');
module.exports.view = () => ui\`<text>x</text>\`;
`;

			for (const ext of ['ts', 'mts', 'js', 'mjs', 'tsx', 'jsx']) {
				expect(compileTemplates(`/app/view.${ext}`, esm)?.count, ext).toBe(1);
				expect(MODULE_RE.test(`/app/view.${ext}`), ext).toBe(true);
			}

			// a CommonJS module has no static import for the tag to be a binding of,
			// so there is no `ui` to find and nothing is claimed. That is the
			// recorded limitation rather than the gap above -- a template reached
			// through `require()` stays interpreted, which is correct output at the
			// cost of the parser staying in the bundle -- and what has to hold here
			// is that it *parses*: a throw would be the plugin failing a build over
			// a file rolldown handed it.
			for (const ext of ['cjs', 'cts']) {
				expect(() => compileTemplates(`/app/view.${ext}`, cjs), ext).not.toThrow();
				expect(compileTemplates(`/app/view.${ext}`, cjs)?.count, ext).toBeUndefined();
				expect(MODULE_RE.test(`/app/view.${ext}`), ext).toBe(true);
			}
		});

		it('should refuse a CommonJS module written as an ES module, as Node does', () => {
			// a `.cjs` holding an `import` statement is a file Node will not load, so
			// compiling a template in one would be the build reporting success over a
			// module that cannot run -- the failure this repo refuses everywhere
			// else. A parse failure is loud, which is the right half of the trade: a
			// template nobody compiles is the silent one.
			//
			// The assertion is on `parseModule()`'s own message rather than on oxc's
			// wording, so a reword does not fail it and oxc going back to taking this
			// does.
			const source = `import { ui } from '@ttylabs/sigil/template';
export const view = () => ui\`<text>x</text>\`;
`;

			expect(() => compileTemplates('/app/view.cjs', source)).toThrow(
				/Failed to parse [^:]*view\.cjs/
			);
		});

		it('should not admit an extension that does not exist', () => {
			// the eight real extensions are not a product of their parts: there is no
			// `.mtsx` or `.cjsx`, and oxc does not read either as JSX, so a single
			// `x?` admitted four spellings whose JSX is a syntax error
			for (const ext of ['mtsx', 'ctsx', 'mjsx', 'cjsx']) {
				expect(MODULE_RE.test(`/app/view.${ext}`), ext).toBe(false);
			}
		});

		it('should not admit what the compiler does not read', () => {
			// JSON, a native binding and whatever virtual module a plugin invented
			// are not JavaScript this can parse, and asking anyway would turn a build
			// into a parse error about a file nobody wrote
			for (const id of [
				'/app/data.json',
				'/app/binding.node',
				'/app/style.css',
				'/app/view.ts?commonjs-proxy',
			]) {
				expect(MODULE_RE.test(id), id).toBe(false);
			}
		});

		it('should compile a template in a .tsx, which oxc parses as JSX', () => {
			// the extension is what decides the language, so a `.tsx` holding both
			// JSX and a `ui` template parses and compiles -- and leaving `.tsx` out
			// of the build's `id` filter was a silent miss, not a safe one
			const source = `import { ui } from '@ttylabs/sigil/template';
const Btn = () => <box>hi</box>;
export const view = () => ui\`<text>tsx</text>\`;
`;
			const compiled = compileTemplates('/app/view.tsx', source);

			expect(compiled?.count).toBe(1);
			expect(compiled?.code).toContain('"tsx"');
			expect(compiled?.code).toContain('<box>hi</box>');
		});

		it('should refuse the same source as a .ts, where JSX is not the language', () => {
			// which is exactly why the gate is the extension: oxc reads the language
			// off the filename, and a `.ts` full of JSX is a parse error rather than
			// a module to rewrite
			const source = `import { ui } from '@ttylabs/sigil/template';
const Btn = () => <box>hi</box>;
export const view = () => ui\`<text>tsx</text>\`;
`;

			expect(() => compileTemplates('/app/view.ts', source)).toThrow('Failed to parse');
		});
	});
});
