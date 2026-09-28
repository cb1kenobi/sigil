/**
 * Compiling a module's `ui` templates into the JavaScript that builds them.
 *
 * The splice SIG-73 left out, and the last join in a pipeline whose every other
 * piece was already written and tested:
 *
 * 1. `findTemplates()` finds each `ui` template and hands back its quasis, its
 *    interpolations' source, and the **span** it occupies.
 * 2. `parse()` reads those into IR, with an `Expr` per interpolation.
 * 3. `analyze()` folds the constants out.
 * 4. `compile()` prints one expression per template, the statements they need at
 *    module scope, and the imports all of it needs.
 * 5. This writes each expression back over its template's span, the hoisted
 *    block and the imports at the top, and hands the result to rolldown.
 *
 * What it buys is that the parser, the tag and the IR walk tree-shake out of the
 * bundle entirely -- a compiled template ships no parser. It is an
 * **optimization rather than a gap**: the `ui` tag works perfectly well at run
 * time, which is why an app built before this still ran.
 *
 * ## Why the risk is here rather than in the compiling
 *
 * `test/emitters.test.ts` already asserts the interpreted, analyzed and compiled
 * paths agree over a corpus -- the element structure, every resolved style and
 * the painted grid, before and after a signal write. So what `compile()` prints
 * is checked. What was never checked until now is putting it back into a file,
 * and that is where the two hazards live: the prefix contract, and the source
 * map.
 *
 * ## The prefix contract, which is the caller's to keep
 *
 * `compile()` puts a prefix on every name it generates -- the locals, the hoisted
 * objects, and the imports -- and cannot check that the prefix is unused,
 * because it is handed IR rather than a file. That check is this module's, and it
 * matters in both directions:
 *
 * - **outward**, a local at the splice site shadows a generated name: a component
 *   whose prop is called `text` puts a `text` in scope, and `const $e0 = text("")`
 *   then calls it;
 * - **inward**, an interpolated expression is printed back into the scope those
 *   locals are declared in, so a template whose expression reads a free variable
 *   called `$e0` reads the generated `$e0` instead of the author's.
 *
 * Neither is reachable once the prefix occurs nowhere in the module, which is a
 * substring search over the source. `choosePrefix()` is that search. It scans
 * the **whole** module rather than the templates, because the outward half is
 * about names anywhere in the file.
 *
 * ## The source map is not optional, which was measured
 *
 * A rolldown `transform` that returns code without a map does two things, and
 * only the first is loud: it warns `SOURCEMAP_BROKEN`, and it **drops the module
 * from the map altogether** -- measured, a two-source map became a one-source map
 * and the transformed file was simply not in it. Sourcemaps are on by default
 * here, so that would quietly cost every template-bearing module its map in
 * exchange for a smaller bundle, which is not a trade anybody asked for.
 *
 * `{ mappings: '' }` is the other candidate and is half an answer: it keeps the
 * module listed and maps nothing inside it. So this uses `magic-string`, which
 * tracks the edits and produces a real map -- the same tool rollup and vite use
 * for exactly this, already in the lockfile through rolldown, and a dependency
 * the toolchain is allowed because it is a devDependency of an app rather than
 * part of what the app ships.
 */

import { analyze } from '../template/analyze.ts';
import { compile, renderImports } from '../template/emit.ts';
import { parseModule } from './parse-module.ts';
import { TAG_MODULE, templatesIn, type FoundTemplate, type TemplatesOptions } from './templates.ts';
import { Expr, parse, type IRNode } from '@ttylabs/sigil/template';
import MagicString from 'magic-string';

/** What compiling a module's templates produced. */
export interface CompiledModule {
	/** The rewritten source. */
	readonly code: string;
	/** How many templates were compiled. */
	readonly count: number;
	/** The source map, as rolldown wants it. */
	readonly map: ReturnType<MagicString['generateMap']>;
}

/** Where a template that could not be compiled was. */
export class TemplateCompileError extends Error {
	/** One-based column. */
	readonly column: number;
	/** The module. */
	readonly file: string;
	/** One-based line. */
	readonly line: number;

	constructor(file: string, line: number, column: number, message: string) {
		super(`${file}:${line}:${column}: ${message}`);
		this.name = 'TemplateCompileError';
		this.column = column;
		this.file = file;
		this.line = line;
	}
}

/**
 * A name prefix that occurs nowhere in a module.
 *
 * The prefix contract, kept by the one party that can keep it. `$ui` is tried
 * first because it reads as generated and is short; a module that already
 * contains that substring anywhere -- in code, in a string, in a comment -- gets
 * `$ui0`, `$ui1`, and so on. Searching the comments and strings too is
 * deliberate: it costs a longer name in a module that merely mentions `$ui` in
 * prose, and it means the search is a plain `includes()` rather than something
 * that has to know where it is looking.
 *
 * @param source - The module's source.
 * @returns A prefix the module does not contain.
 */
export function choosePrefix(source: string): string {
	if (!source.includes('$ui')) {
		return '$ui';
	}

	for (let n = 0; ; n++) {
		const candidate = `$ui${n}`;
		if (!source.includes(candidate)) {
			return candidate;
		}
	}
}

/**
 * Compiles every `ui` template in a module, or says there were none.
 *
 * @param file - The module's path; its extension decides TypeScript.
 * @param source - The module's source.
 * @param options - Which tag to look for.
 * @returns The rewritten module, or `undefined` when it holds no templates.
 * @throws {TemplateCompileError} If a template cannot be compiled, naming where.
 */
export function compileTemplates(
	file: string,
	source: string,
	options: TemplatesOptions = {}
): CompiledModule | undefined {
	// a module that does not even mention the tag's module cannot hold a template,
	// and a substring test answers that without a parse. This is the function's own
	// fast path rather than the build's: `bundle.ts` narrows natively with a
	// rolldown hook filter before it ever calls here, which is the cheaper place to
	// do it, and this is what makes the same answer hold for any other caller.
	// Same shape as `strip()`, which tests for an `ESC` before running its matcher,
	// and for the same reason -- the common case has nothing to do
	if (!source.includes(options.from ?? TAG_MODULE)) {
		return undefined;
	}

	// parsed once and asked twice, which is what `templatesIn()` is separate from
	// `findTemplates()` for
	const found = templatesIn(parseModule(file, source), options);

	if (!found.length) {
		return undefined;
	}

	const prefix = choosePrefix(source);

	// every template's IR first, so that a template which cannot be compiled is
	// reported before anything is rewritten -- a half-spliced module is a worse
	// thing to hand a bundler than an error
	const nodes: IRNode[] = found.map((template) => {
		try {
			return analyze(
				parse(
					template.quasis,
					template.expressions.map((src) => new Expr(src))
				)
			);
		} catch (e: unknown) {
			throw new TemplateCompileError(file, template.line, template.column, (e as Error).message);
		}
	});

	let compiled;
	try {
		compiled = compile(nodes, { prefix });
	} catch (e: unknown) {
		throw blame(file, found, nodes, prefix, e as Error);
	}

	const edited = new MagicString(source);

	// each expression over the span its template occupied. `overwrite()` rather
	// than a string splice, because the map is what makes this worth doing at all
	found.forEach((template, at) => {
		edited.overwrite(template.start, template.end, compiled.sources[at]!);
	});

	// the imports and the hoisted block at the top, in that order: a hoisted
	// object is built from what the imports bring in, and both are module scope
	const head = [renderImports(compiled.imports), ...compiled.hoisted.map((line) => `${line}\n`)];

	// after the shebang rather than before it, because `#!` is only a shebang on
	// the first line -- an `import` in front of it leaves a module whose first line
	// is a syntax error to node and which the kernel will not exec either. Only
	// the *first* line counts, so this is the one directive-shaped thing that has
	// to be stepped over; `'use strict'` does not, since a module is strict anyway
	// and an import before it merely makes it an ordinary string expression
	const shebang = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;

	if (shebang > 0) {
		edited.appendLeft(shebang, head.join(''));
	} else {
		edited.prepend(head.join(''));
	}

	return {
		code: edited.toString(),
		count: found.length,
		map: edited.generateMap({ hires: true, includeContent: true, source: file }),
	};
}

/**
 * Which template a whole-module `compile()` failure was about.
 *
 * `compile()` is handed every template in the module at once -- one prefix, one
 * hoisted block deduplicated across all of them -- so what it throws names no
 * template, and the first is a position with nothing wrong with it: a module
 * whose *second* template holds a bad `<raw>` reported the first one's line, so
 * the error pointed at code the author would read, find correct, and be stuck
 * on. A diagnostic that names the wrong line is worse than one that names no
 * line, because it is believed.
 *
 * So the culprit is found by compiling each template on its own until one throws
 * the same way. That is only ever the error path, so the happy path pays
 * nothing -- at worst one compile per template, and only once the build is
 * already failing -- and it is sound in the direction that matters: a template
 * that fails alone fails in the module too, since nothing `compile()` does
 * across templates can *rescue* one.
 *
 * Matching on the message is what makes it the *right* template rather than
 * merely a failing one, and it is reliable because no message `compile()` throws
 * mentions a generated name, an index, or anything else that depends on how many
 * templates it was handed -- each is about one node and its template-relative
 * `loc`, which is the same either way. Checked against every throw site in
 * `emit.ts`, the prefix check included: that one throws an identical message for
 * one template and for twenty, so it reproduces alone and lands on the first
 * template through the match rather than through the fallback.
 *
 * Which means that with today's emitter the matching template and the first
 * template to fail alone are **always the same one** -- `compile()` throws on the
 * first failure it meets, so there is never an earlier failing template for the
 * match to disagree with. The two rules are indistinguishable from the outside,
 * and the ordering exists for the day one of those properties stops holding: a
 * template that threw *something* beats one that threw nothing, and the module's
 * first template is the last resort. Machinery nothing exercises is machinery
 * that stops working silently, so `test/build/blame.test.ts` mocks `compile()` to
 * separate all three -- which is the only way to ask, and is why two earlier
 * attempts at those tests were green with the fallback they named deleted. The
 * message reported is always the one `compile()` gave.
 *
 * @param file - The module.
 * @param found - Its templates, in source order.
 * @param nodes - Their analyzed IR, in the same order.
 * @param prefix - The prefix the failed call used.
 * @param error - What `compile()` threw.
 * @returns The error to throw, pointed at the template that caused it.
 */
function blame(
	file: string,
	found: readonly FoundTemplate[],
	nodes: readonly IRNode[],
	prefix: string,
	error: Error
): TemplateCompileError {
	// what each template does on its own, once. Asked as two questions over one
	// pass because the answers rank: a template throwing the *same* message is the
	// one `compile()` was complaining about, while a template merely throwing
	// something is a worse answer that still beats naming a template with nothing
	// wrong with it
	let exact: FoundTemplate | undefined;
	let failing: FoundTemplate | undefined;

	for (const [at, template] of found.entries()) {
		try {
			compile([nodes[at]!], { prefix });
			continue;
		} catch (e: unknown) {
			failing ??= template;
			if ((e as Error).message === error.message) {
				exact = template;
				break;
			}
		}
	}

	const culprit = exact ?? failing ?? found[0]!;

	return new TemplateCompileError(file, culprit.line, culprit.column, error.message);
}
