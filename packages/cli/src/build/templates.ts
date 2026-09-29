/**
 * Finding the `ui` templates in a module.
 *
 * This is the half the template toolchain has always been missing and said so:
 * `compile()` in `@ttylabs/cli/template` is handed the IR of every template in
 * one module and hands back the expression that replaces each of them, and
 * "splicing those into the module, and finding the templates in the first
 * place" is written down as `sigil build`'s. This is that.
 *
 * ## The tag is a binding, not a spelling
 *
 * A template is `ui` only because something imported `ui` from
 * `@ttylabs/sigil/template`. The name at the call site is whatever the import
 * called it -- `import { ui as html }` is the same tag -- and a local variable
 * that happens to be called `ui` is *not* one. So the binding is read off
 * oxc's own module record rather than matched by name, which is the same
 * question `emit()` answers by holding the function itself: compiling something
 * that was never the tag would rewrite a stranger's template literal into calls
 * it never asked for.
 *
 * That question is `bindings.ts`'s rather than this file's, because the pass
 * that shakes a stylesheet asks exactly the same one about `utilitySheet` --
 * the alias, the namespace member, the parentheses, the type-only import and
 * the name the module binds again are all decided in one place, so the two
 * cannot come to disagree. Every shape it *misses* is silent here: no
 * diagnostic, a template left interpreted, and a parser left in the bundle.
 *
 * ## Only the outermost, and that is a recorded decision
 *
 * A `ui` template written *inside* an interpolation stays interpreted. An
 * expression is not the compiler's to read -- `compile()` prints every `${...}`
 * back exactly as it was written, because that is what makes it a pure
 * optimizer -- so the inner template's source travels into the generated code
 * verbatim and the runtime tag handles it there.
 *
 * Returning both would be worse than useless. The outer template's expression
 * source is a span of the *original* module, so it still holds the inner
 * template's text: splice a compiled replacement for both and the inner one is
 * written twice, once compiled and once inside the outer's expression. So the
 * walk claims a tagged template and does not descend into it.
 *
 * ## The spans are what the caller splices
 *
 * `start` and `end` cover the whole tagged template, tag included, so replacing
 * `source.slice(start, end)` with what `compile()` produced is the whole edit.
 * They are UTF-16 code unit offsets, which is what `source.slice()` takes.
 */

import { bindingName, importBindings, reachable } from './bindings.ts';
import { parseModule, position, type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import type { Expression, TaggedTemplateExpression } from 'oxc-parser';

/** Where the `ui` tag comes from, when nothing says otherwise. */
export const TAG_MODULE = '@ttylabs/sigil/template';

/** What the tag is exported as, when nothing says otherwise. */
export const TAG_EXPORT = 'ui';

/** One template found in a module. */
export interface FoundTemplate {
	/**
	 * Where the tagged template ends in the module, exclusive.
	 *
	 * With `start`, the span to replace: `source.slice(start, end)` is the whole
	 * template including its tag.
	 */
	readonly end: number;
	/**
	 * Each interpolation's source, exactly as written, in order.
	 *
	 * Each becomes an `Expr` on the way into `parse()`. Taken verbatim because
	 * an expression is never rewritten -- a thunk is what makes a prop reactive,
	 * and a compiler that touched one would stop being a pure optimizer.
	 */
	readonly expressions: readonly string[];
	/** One-based column the template starts at. */
	readonly column: number;
	/** One-based line the template starts on. */
	readonly line: number;
	/**
	 * The literal's static parts, cooked.
	 *
	 * Cooked rather than raw, because that is what a tag function receives and
	 * the whole point is that the compiled path reads what the interpreted path
	 * would have: `\\n` in a template is a newline to `ui` and has to be one
	 * here.
	 */
	readonly quasis: readonly string[];
	/** Where the tagged template starts in the module. */
	readonly start: number;
	/**
	 * The expression the tag was reached by, as the module wrote it.
	 *
	 * A local name for a named import, alias included -- `html` for
	 * `import { ui as html }` -- and `t.ui` for a namespace import's member.
	 */
	readonly tag: string;
}

/** Which tag to look for. */
export interface TemplatesOptions {
	/** The module it is imported from. Defaults to `@ttylabs/sigil/template`. */
	readonly from?: string;
	/** The name it is exported as. Defaults to `ui`. */
	readonly name?: string;
}

/**
 * Finds every `ui` template in a module.
 *
 * @param file - Where the source came from; its extension decides TypeScript.
 * @param source - The module's source.
 * @param options - Which tag to look for.
 * @returns One entry per template, in source order.
 * @throws If the source does not parse.
 */
export function findTemplates(
	file: string,
	source: string,
	options: TemplatesOptions = {}
): readonly FoundTemplate[] {
	return templatesIn(parseModule(file, source), options);
}

/**
 * Finds every `ui` template in an already-parsed module.
 *
 * Separate from `findTemplates()` for the reason `factsOf()` is separate from
 * `extractCommand()`: the build parses a module once and asks it more than one
 * question.
 *
 * @param parsed - The module.
 * @param options - Which tag to look for.
 * @returns One entry per template, in source order.
 */
export function templatesIn(
	parsed: ParsedModule,
	options: TemplatesOptions = {}
): readonly FoundTemplate[] {
	// an import is a binding rather than a spelling, and the shapes that counts
	// -- an alias, a namespace member, a name the module binds again -- are
	// `bindings.ts`'s, shared with the pass that shakes a stylesheet
	const tags = importBindings(parsed, options.from ?? TAG_MODULE, options.name ?? TAG_EXPORT);

	if (!reachable(tags)) {
		return [];
	}

	const found: FoundTemplate[] = [];

	walk(parsed.program, (node) => {
		if (node.type !== 'TaggedTemplateExpression') {
			return true;
		}

		const reached = bindingName(node.tag, tags);
		if (reached === undefined) {
			return true;
		}

		found.push(describe(parsed, node, reached));

		// claimed: an inner template is inside an expression this one carries
		// verbatim, so descending would find one that is going to be printed back
		// as source anyway
		return false;
	});

	// source order, because `compile()` is handed a module's templates and the
	// caller writes each of `sources` back where its template was -- an order
	// that does not match the file is an off-by-one nobody can see
	return found.sort((one, other) => one.start - other.start);
}

/**
 * Reads one tagged template into what the template toolchain wants.
 *
 * @param parsed - The module it is in.
 * @param node - The tagged template.
 * @param tag - The local name it was reached by.
 * @returns The template.
 */
function describe(
	parsed: ParsedModule,
	node: TaggedTemplateExpression,
	tag: string
): FoundTemplate {
	const { quasi } = node;
	const { column, line } = position(parsed.source, node.start);

	return {
		column,
		end: node.end,
		// verbatim, which is the whole contract: `${() => count()}` is printed
		// back exactly as written or the compiler is not a pure optimizer
		expressions: quasi.expressions.map((expression: Expression) =>
			parsed.source.slice(expression.start, expression.end)
		),
		line,
		// `cooked` is null only for an invalid escape in a tagged template, which
		// is legal syntax that hands the tag `undefined` -- the raw text is the
		// honest answer there, and it is what the runtime tag would have shown
		quasis: quasi.quasis.map((element) => element.value.cooked ?? element.value.raw),
		start: node.start,
		tag,
	};
}
