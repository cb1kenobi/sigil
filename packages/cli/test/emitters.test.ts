/**
 * The two emitters, held against each other over a corpus.
 *
 * This is the mechanical answer SIG-72 asks for, and it is worth saying why it
 * has to be mechanical: nothing about the two emitters makes divergence loud.
 * A compiled template that builds a slightly different tree renders, lays out
 * and paints perfectly happily -- it is just not the UI the author wrote, and
 * the only person who finds out is the one who ran `sigil build` and noticed
 * their app changed.
 *
 * So both paths are generated from `template-corpus.ts` and neither is written
 * by hand. For every entry:
 *
 * - **interpreted** is `emit(parse(...))`, which is what `` ui`...` `` is.
 * - **analyzed** is `emit(analyze(parse(...)))`, which pins the analysis pass
 *   as a pure optimizer -- it is allowed to rewrite the IR and not allowed to
 *   change what the IR builds.
 * - **compiled** is the build emitter's output, imported as a real module.
 *
 * All three are built under their own root with their own signals, rendered,
 * written to, and rendered again -- because a frontend that built the tree
 * correctly and wired no effects would pass on the first frame alone. What is
 * compared is the element structure, every element's resolved style, and the
 * painted grid in full colour, which is the three things the ticket names.
 *
 * The generated modules are written under `fixtures/template/out/`, which is
 * ignored, and imported rather than spawned: both paths resolve
 * `@ttylabs/sigil` through the same package instance, which is what makes
 * `instanceof Element` mean the same thing in both.
 *
 * One thing the corpus deliberately does *not* cover, because it is not this
 * ticket's: a `ui` template written *inside* an interpolation is printed back
 * verbatim and stays interpreted. An expression is not the compiler's to read
 * -- finding templates in a file is what `sigil build` (SIG-73) does, and it
 * will find those too.
 */

import { analyze, compile, renderImports } from '../src/template/index.js';
import { CORPUS, type CorpusEntry } from './template-corpus.js';
import { box, type Element, renderToString, text } from '@ttylabs/sigil/element';
import { createRoot, For, Show } from '@ttylabs/sigil/renderer';
import { flush, State } from '@ttylabs/sigil/signals';
import { emit, Expr, type IRNode, parse, ui } from '@ttylabs/sigil/template';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'fixtures/template/out');

/** What every corpus expression is written against. */
interface Scope {
	count: State<number>;
	For: typeof For;
	items: State<string[]>;
	/** A component that reports what its children arrived as. */
	Kind: (props: { children?: unknown }) => Element;
	made: Element;
	Show: typeof Show;
	ui: typeof ui;
}

/** One template, built two ways from one source. */
type Builders = Record<string, (scope: Scope) => Element>;

/**
 * Splits a corpus template into the quasis and the interpolation order a
 * tagged template would have had.
 *
 * @param template - The template, with `${N}` where an interpolation goes.
 * @returns The static parts, and which expression sits between each pair.
 */
function split(template: string): { order: number[]; quasis: string[] } {
	// a capturing group makes `split` interleave the separators, so the pieces
	// alternate quasi, index, quasi -- which is the shape a template literal has
	const pieces = template.split(/\$\{(\d+)\}/);
	const order: number[] = [];
	const quasis: string[] = [];

	for (let at = 0; at < pieces.length; at += 2) {
		quasis.push(pieces[at]!);
		if (at + 1 < pieces.length) {
			order.push(Number(pieces[at + 1]));
		}
	}

	return { order, quasis };
}

/**
 * The IR one entry parses to, with an `Expr` where a value would be.
 *
 * @param entry - The corpus entry.
 * @returns The IR the build path sees.
 */
function irOf(entry: CorpusEntry): IRNode {
	const { order, quasis } = split(entry.template);
	return parse(
		quasis,
		order.map((at) => new Expr(entry.exprs[at]!))
	);
}

/**
 * Wraps a builder body in the locals an entry asked to be shadowed by.
 *
 * @param entry - The corpus entry.
 * @param body - The expression the builder returns.
 * @param shadowed - Every name the emitter imports, read off the compiled
 *   module so that a helper it starts importing is covered the same day.
 * @returns The arrow function's source.
 */
function builder(entry: CorpusEntry, body: string, shadowed: readonly string[]): string {
	if (!entry.shadow) {
		return `(scope) => ${body}`;
	}
	const locals = shadowed.map((name) => `${name} = "shadowed"`).join(', ');
	return `(scope) => { const ${locals}; return ${body}; }`;
}

/**
 * The module that parses every entry at run time.
 *
 * Generated rather than written, so that the expression source the compiler is
 * given and the expression the interpreter evaluates are the same characters.
 *
 * @returns The module's source.
 */
function interpretedModule(shadowed: readonly string[]): string {
	const lines = ["import { parse } from '@ttylabs/sigil/template';", ''];

	CORPUS.forEach((entry, at) => {
		const { quasis } = split(entry.template);
		lines.push(`const q${at} = ${JSON.stringify(quasis)};`);
	});

	lines.push('', 'export const templates = {');
	CORPUS.forEach((entry, at) => {
		const { order } = split(entry.template);
		const values = order.map((index) => `(${entry.exprs[index]!}\n)`).join(', ');
		lines.push(
			`\t${JSON.stringify(entry.name)}: ${builder(entry, `parse(q${at}, [${values}])`, shadowed)},`
		);
	});
	lines.push('};', '');

	return lines.join('\n');
}

/**
 * The module the build emitter produces for every entry.
 *
 * Compiled in one call, because that is what a module is: one prefix, one set
 * of imports, and one hoisted block that two templates sharing a prop set share
 * an entry in.
 *
 * @returns The module's source.
 */
function compiledModule(): { imported: string[]; source: string } {
	const compiled = compile(
		CORPUS.map((entry) => analyze(irOf(entry))),
		{ prefix: '$c_' }
	);

	// what a shadowing entry binds: read off the imports the emitter actually
	// asked for rather than listed anywhere, so the pin cannot go stale
	const imported = compiled.imports
		.flatMap((one) => one.names.map((binding) => binding.imported))
		.sort();

	return {
		imported,
		source: [
			renderImports(compiled.imports),
			...compiled.hoisted,
			'',
			'export const templates = {',
			...compiled.sources.map(
				(source, at) =>
					`\t${JSON.stringify(CORPUS[at]!.name)}: ${builder(CORPUS[at]!, source, imported)},`
			),
			'};',
			'',
		].join('\n'),
	};
}

/** Fresh signals per render, because a shared graph would settle once. */
function makeScope(): Scope {
	return {
		count: new State(1),
		For,
		items: new State(['parser', 'canvas']),
		// what a component's children arrived as is the one thing the two paths
		// could disagree about invisibly, so the component says it out loud
		Kind: (props: { children?: unknown }) =>
			box({}, text(Array.isArray(props.children) ? `list of ${props.children.length}` : 'one')),
		made: text('made'),
		Show,
		ui,
	};
}

/** What one element is, before anything has been drawn. */
interface Node {
	children: Node[];
	classes: readonly string[];
	focusable: boolean;
	id: string | undefined;
	key: number | string | undefined;
	props: Record<string, unknown>;
	tabIndex: number | undefined;
	text: string;
	type: string;
}

/**
 * The tree, as data.
 *
 * @param element - The root.
 * @returns Everything an element was built with.
 */
function structure(element: Element): Node {
	return {
		children: element.children.map((child) => structure(child)),
		classes: [...element.classes],
		focusable: element.focusable,
		id: element.id,
		key: element.key,
		props: { ...element.props },
		tabIndex: element.tabIndex,
		text: element.type === 'text' ? element.text : '',
		type: element.type,
	};
}

/**
 * Every resolved style in the tree, in document order.
 *
 * Read after a render, because that is what settles them.
 *
 * @param element - The root.
 * @returns One serialized style per element.
 */
function styles(element: Element): string[] {
	return [JSON.stringify(element.style), ...element.children.flatMap((child) => styles(child))];
}

/** One frame: the tree, its styles, and what it painted. */
interface Frame {
	render: string;
	structure: Node;
	styles: string[];
}

/**
 * Builds a tree, renders it, writes to the signals, and renders it again.
 *
 * @param build - What to build, given the scope its expressions read.
 * @returns The frame before the write and the frame after it.
 */
function frames(build: (scope: Scope) => Element): { after: Frame; before: Frame } {
	return createRoot((dispose) => {
		const scope = makeScope();
		const element = build(scope);
		flush();

		// in full colour, so that the resolved style reaches the comparison as
		// bytes as well as as data: a divergence the structure hides is one the
		// user sees
		const snapshot = (): Frame => ({
			render: renderToString(element, { colorLevel: 3, width: 30 }),
			structure: structure(element),
			styles: styles(element),
		});

		const before = snapshot();

		scope.count.set(3);
		scope.items.set(['parser', 'canvas', 'layout']);
		flush();

		const after = snapshot();

		dispose();
		return { after, before };
	});
}

describe('the runtime emitter and the build emitter', () => {
	let interpreted: Builders;
	let compiled: Builders;
	let compiledSource: string;

	beforeAll(async () => {
		mkdirSync(out, { recursive: true });

		const interpretedFile = resolve(out, 'corpus-interpreted.mjs');
		const compiledFile = resolve(out, 'corpus-compiled.mjs');

		const generated = compiledModule();
		compiledSource = generated.source;
		writeFileSync(interpretedFile, interpretedModule(generated.imported), 'utf-8');
		writeFileSync(compiledFile, compiledSource, 'utf-8');

		const parsed = (await import(pathToFileURL(interpretedFile).href)) as {
			templates: Record<string, (scope: Scope) => IRNode>;
		};
		interpreted = Object.fromEntries(
			Object.entries(parsed.templates).map(([name, read]) => [
				name,
				(scope: Scope) => emit(read(scope)),
			])
		);
		compiled = ((await import(pathToFileURL(compiledFile).href)) as { templates: Builders })
			.templates;

		// the analyzed path reads the same module, so the three differ in exactly
		// one step each
		analyzed = Object.fromEntries(
			Object.entries(parsed.templates).map(([name, read]) => [
				name,
				(scope: Scope) => emit(analyze(read(scope))),
			])
		);
	});

	let analyzed: Builders;

	describe.each(CORPUS.map((entry) => entry.name))('%s', (name) => {
		it('should survive the analysis pass unchanged', () => {
			// the analyzer may rewrite the IR and may not change what it builds,
			// which is the claim that makes the compiler's shortcuts shortcuts
			const one = frames((scope) => interpreted[name]!(scope));
			const other = frames((scope) => analyzed[name]!(scope));

			expect(other.before.structure).toEqual(one.before.structure);
			expect(other.before.styles).toEqual(one.before.styles);
			expect(other.before.render).toBe(one.before.render);
			expect(other.after.structure).toEqual(one.after.structure);
			expect(other.after.styles).toEqual(one.after.styles);
			expect(other.after.render).toBe(one.after.render);
		});

		it('should build the same tree compiled as interpreted', () => {
			const one = frames((scope) => interpreted[name]!(scope));
			const other = frames((scope) => compiled[name]!(scope));

			expect(other.before.structure).toEqual(one.before.structure);
			expect(other.before.styles).toEqual(one.before.styles);
			expect(other.before.render).toBe(one.before.render);
		});

		it('should follow the signals compiled as interpreted', () => {
			// the frame after the write is what makes this a test of the wiring
			// rather than of the first paint
			const one = frames((scope) => interpreted[name]!(scope));
			const other = frames((scope) => compiled[name]!(scope));

			expect(other.after.structure).toEqual(one.after.structure);
			expect(other.after.styles).toEqual(one.after.styles);
			expect(other.after.render).toBe(one.after.render);
		});
	});

	it('should have rendered something worth comparing', () => {
		// a corpus that rendered nothing would make every comparison above vacuous
		const counter = frames((scope) =>
			compiled['the Counter, which is the shape an app actually writes']!(scope)
		);
		expect(counter.before.render).toContain('count: 1');
		expect(counter.after.render).toContain('count: 3');
		expect(counter.after.render).toContain('layout');
	});

	it('should import no part of the parser', () => {
		// the payoff: what a built app carries is the leaf helpers and the host
		// constructors, and the tag, the cursor and the IR walk are all
		// unreachable. Asked of the imports rather than of the whole file, because
		// an expression the compiler printed back verbatim may say anything at all
		// -- the corpus has several that call `ui` themselves
		const imports = compiledSource.split('\n').filter((line) => line.startsWith('import '));

		// every one of them aliased, because the expression is spliced into a
		// module this compiler has never seen -- the corpus has an entry that
		// shadows all six names to prove the aliases are what make that safe
		expect(imports).toEqual([
			'import { box as $c_box, text as $c_text } from "@ttylabs/sigil/element";',
			'import { appendValue as $c_appendValue, applyProp as $c_applyProp, ' +
				'applyText as $c_applyText, rawElement as $c_rawElement, ' +
				'rootElement as $c_rootElement } from "@ttylabs/sigil/template";',
		]);
		expect(imports.join('\n')).not.toMatch(/\b(?:emit|parse|ui)\b/);
	});
});

describe('what the build emitter writes', () => {
	/**
	 * Compiles one template written inline.
	 *
	 * @param quasis - The static parts.
	 * @param exprs - The expressions between them.
	 * @returns The compiled template.
	 */
	function build(quasis: readonly string[], ...exprs: string[]) {
		const { hoisted, imports, sources } = compile([
			analyze(
				parse(
					quasis,
					exprs.map((source) => new Expr(source))
				)
			),
		]);
		return { hoisted, imports, source: sources[0]! };
	}

	it('should write a static template as one expression, with no function to call', () => {
		// the whole of a `<text>` whose content nothing can change: no array, no
		// scan for a thunk, no effect, and no IIFE to hold statements that do not
		// exist
		const { hoisted, source } = build(['<text font-weight="bold">Counter</text>']);
		expect(source).toBe('$text("Counter", $s0)');
		expect(hoisted).toEqual(['const $s0 = Object.freeze({ "font-weight": "bold" });']);
	});

	it('should hoist one object for two elements whose props agree', () => {
		const { hoisted } = build([
			'<box><text color="cyan">a</text><text color="cyan">b</text></box>',
		]);
		expect(hoisted).toEqual(['const $s0 = Object.freeze({ "color": "cyan" });']);
	});

	it("should never hoist a component's props, however static they are", () => {
		// a component is handed the object and may keep it; one shared between
		// every mount is a bug nobody would look for in generated code
		const { hoisted, source } = build(['<', ' when="yes" />'], 'Panel');
		expect(hoisted).toEqual([]);
		expect(source).toBe('(Panel)({ "when": "yes" })');
	});

	it('should ask for only the names it used', () => {
		expect(build(['<text>hi</text>']).imports).toEqual([
			{ from: '@ttylabs/sigil/element', names: [{ imported: 'text', local: '$text' }] },
		]);
	});

	it('should merge the imports of several templates', () => {
		const one = build(['<text>hi</text>']);
		const other = build(['<box>', '</box>'], '() => 1');
		expect(renderImports([...one.imports, ...other.imports])).toBe(
			'import { box as $box, text as $text } from "@ttylabs/sigil/element";\n' +
				'import { appendValue as $appendValue } from "@ttylabs/sigil/template";\n'
		);
	});

	it('should leave every prop where it was written when one name is repeated', () => {
		// lifting the literal into the constructor would reverse the two, and the
		// last one written is the one that wins
		const { hoisted, source } = build(['<text color="red" color=', '>x</text>'], '() => "green"');
		expect(hoisted).toEqual([]);
		expect(source).toContain('$applyProp($e0, "color", "red");');
		expect(source.indexOf('"red"')).toBeLessThan(source.indexOf('"green"'));
	});

	it('should refuse a component the IR holds as a live function', () => {
		// how a template reaches the IR at run time, and a shape that cannot reach
		// a file: there is no source to print
		const Panel = () => text('panel');
		expect(() => compile([parse(['<', ' />'], [Panel])])).toThrow(/cannot be compiled/);
	});

	it('should refuse an element inside a text, where the interpreter refuses it', () => {
		expect(() => build(['<text><box/></text>'])).toThrow(/no inline layout/);
	});

	it('should refuse a raw whose measure is not an expression', () => {
		// decidable at build time, and a build that fails beats an app that throws
		// on the frame it is first drawn
		expect(() => build(['<raw measure="soon" paint=', ' />'], '() => {}')).toThrow(
			/a value rather than an expression/
		);
		expect(() => build(['<raw paint=', ' />'], '() => {}')).toThrow(/its measure is missing/);
	});

	it('should refuse a prefix that cannot keep the output out of the way', () => {
		// an empty one comes back as bare imports, which is the shadowing bug the
		// prefix exists to close, and it is what a caller reaches by passing
		// something falsy rather than by meaning it
		const ir = [analyze(parse(['<text>hi</text>'], []))];
		expect(() => compile(ir, { prefix: '' })).toThrow(/must be a non-empty identifier-safe/);
		expect(() => compile(ir, { prefix: '1x' })).toThrow(/identifier-safe/);
		expect(() => compile(ir, { prefix: 'a-b' })).toThrow(/identifier-safe/);
		expect(compile(ir, { prefix: '$sigil_' }).sources[0]).toBe('$sigil_text("hi")');
	});

	it('should write __proto__ as a computed key, which is the only name that needs one', () => {
		// written plainly it is prototype sugar, so the object literal would have
		// no own property of that name and the prop would be dropped on the way in
		const { hoisted } = build(['<text __proto__="x">y</text>']);
		expect(hoisted).toEqual(['const $s0 = Object.freeze({ ["__proto__"]: "x" });']);
	});

	it('should point an error at the line the template broke on', () => {
		expect(() => build([`<box>\n\t<text>fine</text>\n\t<text><box/></text>\n</box>`])).toThrow(
			/at line 3/
		);
	});
});
