/**
 * Which local names in a module are a particular import, and nothing else.
 *
 * Two passes ask this and have to get the same answer: `templates.ts` asks
 * whether a tagged template's tag is the `ui` imported from
 * `@ttylabs/sigil/template`, and `shake.ts` asks whether a call is the
 * `utilitySheet` imported from `@ttylabs/sigil/style`. Both are the same
 * question -- **an import is a binding, not a spelling** -- and a second
 * implementation of it is a second set of answers about aliases, namespaces and
 * shadowing. That is the rule `readRoutes()` already records for the two route
 * walks, met a second time.
 *
 * ## The direction the uncertainty falls
 *
 * Every shape this *misses* is silent and safe: a template stays interpreted, a
 * sheet stays unshaken, and the build says nothing. Every shape it claims
 * *wrongly* rewrites somebody else's code. So the answer is given up wherever it
 * cannot be had -- a name the module binds again is dropped whole, because there
 * is no scope tree here to ask which use site is the import's -- and the list of
 * shapes that stay unreachable is in AGENTS.md rather than repeated here.
 */

import { type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import type { Expression } from 'oxc-parser';

/**
 * Every way one module can reach one export.
 *
 * Sets rather than single names, because a module may import the same thing
 * more than once -- under its own name, under an alias, and as a namespace --
 * and each of them is that import.
 */
export interface ImportBindings {
	/** Locals a named import bound it to, alias included. */
	readonly direct: ReadonlySet<string>;
	/** The export name being looked for, which a namespace member has to match. */
	readonly name: string;
	/** Locals a namespace import bound the whole module to. */
	readonly namespaces: ReadonlySet<string>;
}

/** Whether a set of bindings can reach the export at all. */
export function reachable(bindings: ImportBindings): boolean {
	return bindings.direct.size > 0 || bindings.namespaces.size > 0;
}

/**
 * Every local name in a module that is one export of one module.
 *
 * Read off oxc's own module record rather than by walking for imports, and then
 * narrowed by taking out every name the module binds again -- see
 * `reboundNames()` for why that is module-wide rather than per use site.
 *
 * @param parsed - The module.
 * @param from - The module specifier to look for.
 * @param name - The export name to look for.
 * @returns The direct locals and the namespace locals, shadowed names removed.
 */
export function importBindings(parsed: ParsedModule, from: string, name: string): ImportBindings {
	const direct = new Set<string>();
	const namespaces = new Set<string>();

	for (const imported of parsed.module.staticImports) {
		if (imported.moduleRequest.value !== from) {
			continue;
		}

		for (const entry of imported.entries) {
			// a type-only import erases, so nothing it named exists at run time
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

	// nothing imported it, so there is nothing for a shadow to shadow and the
	// walk `reboundNames()` would do is worth skipping rather than running to
	// find that out
	if (!direct.size && !namespaces.size) {
		return { direct, name, namespaces };
	}

	const rebound = reboundNames(parsed);
	const keep = (names: ReadonlySet<string>): Set<string> =>
		new Set([...names].filter((local) => !rebound.has(local)));

	return { direct: keep(direct), name, namespaces: keep(namespaces) };
}

/**
 * Every name the module binds somewhere other than by importing it.
 *
 * A binding is only the import's for as long as nothing else in the module
 * binds that name, and this walk has no scope tree to ask -- so a name the
 * module binds again is given up on entirely rather than guessed at. The
 * direction of that giving-up is the whole point: claiming something that was
 * never the import rewrites a stranger's code, while declining one leaves it
 * alone, which is correct output at the cost of an optimization.
 *
 * Keyed on the *keys* a binding hangs off -- `id`, `param`, `params` -- rather
 * than on a list of node types, for the reason `walk()` is driven by
 * `visitorKeys`: a list of node types is a second copy of the grammar, and the
 * day the parser grows one this file has not heard of is the day a binding stops
 * being seen. Those key names are far more stable than the set of nodes that use
 * them, and reading one key too many is harmless here because every name this
 * collects is a name the matcher then declines.
 *
 * @param parsed - The module.
 * @returns The names it re-binds.
 */
function reboundNames(parsed: ParsedModule): Set<string> {
	const names = new Set<string>();

	walk(parsed.program, (node) => {
		// an import's own binding is not a shadow of itself
		if (node.type === 'ImportDeclaration') {
			return false;
		}

		const record = node as unknown as Record<string, unknown>;
		for (const key of ['id', 'param', 'params']) {
			const value = record[key];

			if (Array.isArray(value)) {
				for (const each of value) {
					patternNames(each, names);
				}
			} else {
				patternNames(value, names);
			}
		}

		return true;
	});

	return names;
}

/**
 * The names a binding pattern binds, added to a set.
 *
 * Destructuring, defaults and rest elements all bind, so all of them are read
 * -- and anything unrecognised is simply not a name, which is safe because an
 * unread pattern can only cost an optimization.
 *
 * @param value - A pattern, or whatever was on the key.
 * @param into - Where to collect the names.
 */
function patternNames(value: unknown, into: Set<string>): void {
	if (!value || typeof value !== 'object') {
		return;
	}

	const node = value as Record<string, unknown> & { type?: string };

	switch (node.type) {
		case 'ArrayPattern':
			for (const element of (node.elements as unknown[]) ?? []) {
				patternNames(element, into);
			}
			patternNames(node.rest, into);
			return;
		case 'AssignmentPattern':
			patternNames(node.left, into);
			return;
		case 'Identifier':
			into.add(String(node.name));
			return;
		case 'ObjectPattern':
			for (const property of (node.properties as Record<string, unknown>[]) ?? []) {
				patternNames(property.value, into);
			}
			patternNames(node.rest, into);
			return;
		case 'RestElement':
			patternNames(node.argument, into);
			return;
		case 'TSParameterProperty':
			patternNames(node.parameter, into);
			return;
		default:
			return;
	}
}

/**
 * The name an expression reached an import by, if it is that import at all.
 *
 * Two shapes, because a module has two static ways to name one import and the
 * answer has to be the same for both: a bare local from a named import, and a
 * property of a namespace object. `import * as t` followed by `t.ui` is the same
 * function as `ui` -- there is no scope walk in either answer, which is what
 * keeps this a question about the module record.
 *
 * A *computed* property is deliberately not read, even holding a literal:
 * `t['ui']` and `t[key]` are the same syntax and only one of them is readable,
 * and reading the easy half of a construct this does not support is worse than
 * skipping both, because the half it skipped is silent. That is the rule the
 * static `desc` lift already follows for a computed key.
 *
 * @param node - The expression, parentheses and all.
 * @param bindings - What this module imported.
 * @returns The name it was reached by, or `undefined` if it is not the import.
 */
export function bindingName(node: Expression, bindings: ImportBindings): string | undefined {
	const expression = unwrap(node);

	if (expression.type === 'Identifier') {
		return bindings.direct.has(expression.name) ? expression.name : undefined;
	}

	if (
		expression.type === 'MemberExpression' &&
		!expression.computed &&
		expression.object.type === 'Identifier' &&
		bindings.namespaces.has(expression.object.name) &&
		expression.property.type === 'Identifier' &&
		expression.property.name === bindings.name
	) {
		return `${expression.object.name}.${expression.property.name}`;
	}

	return undefined;
}

/**
 * An expression with its parentheses taken off.
 *
 * `(ui)\`...\`` is the same call as `ui\`...\``, and oxc preserves the
 * parentheses as a node -- so a matcher that reads straight off the node sees a
 * `ParenthesizedExpression` and silently declines something with nothing wrong
 * with it. Recursive, because `((ui))` is also that call.
 *
 * @param node - The expression.
 * @returns The innermost expression the parentheses wrap.
 */
export function unwrap(node: Expression): Expression {
	let inner = node;
	while (inner.type === 'ParenthesizedExpression') {
		inner = inner.expression;
	}
	return inner;
}
