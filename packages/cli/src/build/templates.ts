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
 * A type-only import is skipped for the same reason from the other side: it
 * erases, so nothing it named is callable at run time.
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

import { parseModule, position, type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import type { Expression, TaggedTemplateExpression } from 'oxc-parser';

/** Where the `ui` tag comes from, when nothing says otherwise. */
const TAG_MODULE = '@ttylabs/sigil/template';

/** What the tag is exported as, when nothing says otherwise. */
const TAG_EXPORT = 'ui';

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
	/** The local name the tag was reached by, which is what the import called it. */
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
	const tags = tagBindings(parsed, options.from ?? TAG_MODULE, options.name ?? TAG_EXPORT);

	// nothing imported the tag, so nothing in this module is a template -- and
	// the walk is worth skipping rather than running to find that out
	if (!tags.size) {
		return [];
	}

	const found: FoundTemplate[] = [];

	walk(parsed.program, (node) => {
		if (node.type !== 'TaggedTemplateExpression') {
			return true;
		}

		const { tag } = node;
		if (tag.type !== 'Identifier' || !tags.has(tag.name)) {
			return true;
		}

		found.push(describe(parsed, node, tag.name));

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
 * Every local name the tag was imported under.
 *
 * A set rather than one name, because a module may import it twice -- under its
 * own name and under an alias -- and both are the tag.
 *
 * @param parsed - The module.
 * @param from - The module specifier to look for.
 * @param name - The export name to look for.
 * @returns The local names.
 */
function tagBindings(parsed: ParsedModule, from: string, name: string): Set<string> {
	const locals = new Set<string>();

	for (const imported of parsed.module.staticImports) {
		if (imported.moduleRequest.value !== from) {
			continue;
		}

		for (const entry of imported.entries) {
			// a type-only import erases, so nothing it named is callable
			if (entry.isType) {
				continue;
			}

			if (entry.importName.kind === 'Name' && entry.importName.name === name) {
				locals.add(entry.localName.value);
			}
		}
	}

	return locals;
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
