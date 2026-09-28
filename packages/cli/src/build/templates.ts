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
 * Which shapes count is the other half of that, and each one it *misses* is
 * silent -- no diagnostic, a template left interpreted, and a parser left in
 * the bundle. So a namespace member counts, because `import * as t` followed by
 * ``t.ui`...` `` is statically the same import; parentheses come off, because
 * ``(ui)`...` `` is the same call; and a computed property does not, which is
 * the rule the static `desc` lift already records. A tag re-exported through
 * another module is the one shape that cannot be answered here at all: it means
 * reading a file this parse has not got.
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

/** Every way one module can reach the tag. */
interface TagBindings {
	/** Locals a named import bound it to, alias included. */
	readonly direct: ReadonlySet<string>;
	/** The export name being looked for, which a namespace member has to match. */
	readonly name: string;
	/** Locals a namespace import bound the whole module to. */
	readonly namespaces: ReadonlySet<string>;
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
	if (!tags.direct.size && !tags.namespaces.size) {
		return [];
	}

	const found: FoundTemplate[] = [];

	walk(parsed.program, (node) => {
		if (node.type !== 'TaggedTemplateExpression') {
			return true;
		}

		const reached = tagName(unwrap(node.tag), tags);
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
 * Every way this module can reach the tag.
 *
 * Sets rather than single names, because a module may import it more than once
 * -- under its own name, under an alias, and as a namespace -- and each of them
 * is the tag.
 *
 * @param parsed - The module.
 * @param from - The module specifier to look for.
 * @param name - The export name to look for.
 * @returns The direct locals and the namespace locals.
 */
function tagBindings(parsed: ParsedModule, from: string, name: string): TagBindings {
	const direct = new Set<string>();
	const namespaces = new Set<string>();

	for (const imported of parsed.module.staticImports) {
		if (imported.moduleRequest.value !== from) {
			continue;
		}

		for (const entry of imported.entries) {
			// a type-only import erases, so nothing it named is callable
			if (entry.isType) {
				continue;
			}

			if (entry.importName.kind === 'NamespaceObject') {
				namespaces.add(entry.localName.value);
			} else if (entry.importName.kind === 'Name' && entry.importName.name === name) {
				direct.add(entry.localName.value);
			}
		}
	}

	return { direct, name, namespaces };
}

/**
 * The name a tagged template's tag was reached by, if it is the tag at all.
 *
 * Two shapes, because a module has two static ways to name one import and the
 * answer has to be the same for both: a bare local from a named import, and a
 * property of a namespace object. `import * as t` followed by ``t.ui`...` `` is
 * the same function as ``ui`...` `` -- there is no scope walk in either
 * answer, which is what keeps this a question about the module record.
 *
 * A *computed* property is deliberately not read, even holding a literal:
 * `t['ui']` and `t[key]` are the same syntax and only one of them is readable,
 * and reading the easy half of a construct this does not support is worse than
 * skipping both, because the half it skipped is silent. That is the rule the
 * static `desc` lift already follows for a computed key.
 *
 * What neither shape reaches is a tag that arrived through another module --
 * `export { ui } from '@ttylabs/sigil/template'` re-exported and then imported
 * from the barrel. That is a question about a file this one has not read, and
 * answering it means resolving a specifier, which is the bundler's job rather
 * than a parse's. Such a template stays interpreted, which is correct but
 * costs the bundle its parser; see the note in `compile-templates.ts`.
 *
 * @param tag - The tag expression, parentheses already off.
 * @param tags - What this module imported.
 * @returns The name it was reached by, or `undefined` if it is not the tag.
 */
function tagName(tag: Expression, tags: TagBindings): string | undefined {
	if (tag.type === 'Identifier') {
		return tags.direct.has(tag.name) ? tag.name : undefined;
	}

	if (
		tag.type === 'MemberExpression' &&
		!tag.computed &&
		tag.object.type === 'Identifier' &&
		tags.namespaces.has(tag.object.name) &&
		tag.property.type === 'Identifier' &&
		tag.property.name === tags.name
	) {
		return `${tag.object.name}.${tag.property.name}`;
	}

	return undefined;
}

/**
 * An expression with its parentheses taken off.
 *
 * ``(ui)`...` `` is the same call as ``ui`...` ``, and oxc preserves the
 * parentheses as a node -- so a matcher that reads the tag straight off sees a
 * `ParenthesizedExpression` and silently declines to compile a template with
 * nothing wrong with it. Recursive, because `((ui))` is also that call.
 *
 * @param node - The expression.
 * @returns The innermost expression the parentheses wrap.
 */
function unwrap(node: Expression): Expression {
	let inner = node;
	while (inner.type === 'ParenthesizedExpression') {
		inner = inner.expression;
	}

	return inner;
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
