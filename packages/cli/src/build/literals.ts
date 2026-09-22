/**
 * Reading values out of source, for the passes that read a declaration nobody
 * is going to run.
 *
 * Two of them need this and want the same answers: the `desc`/`hidden` lift out
 * of a command module, and the schema read out of an app's entry. A second copy
 * of "is this a string somebody wrote" is how two halves of one build come to
 * disagree about whether `` `build` `` counts.
 *
 * Everything here answers `undefined` for what it cannot read statically, and
 * the caller decides whether that is worth reporting. Nothing here guesses.
 */

import type { Expression, ObjectExpression, ObjectProperty } from 'oxc-parser';

/**
 * Looks through the wrappers that do not change what a value is.
 *
 * `as` and `satisfies` are type syntax and erase to nothing; parentheses are
 * nothing at all; `!` is an assertion about a value rather than a change to it.
 *
 * @param node - The expression.
 * @returns The expression under the type syntax.
 */
export function unwrapShallow(node: Expression): Expression {
	let current = node;
	while (
		current.type === 'TSAsExpression' ||
		current.type === 'TSSatisfiesExpression' ||
		current.type === 'ParenthesizedExpression' ||
		current.type === 'TSNonNullExpression'
	) {
		current = current.expression;
	}
	return current;
}

/**
 * The object literal an expression is, looking through the wrappers that change
 * nothing -- including a call that passes one through.
 *
 * `command()` is the call that matters: it is documented as the identity
 * function and exists only so inference reaches a nested literal, so what it
 * wraps says exactly what the bare literal says. It is unwrapped whatever it is
 * *called*, because the name is the app's to choose -- it may be imported under
 * an alias, or be a wrapper of the app's own. What that costs is a
 * `withDefaults({ desc: 'a' }, ...)` whose own body overrides `desc`, which is
 * why the unwrap stops at a call with exactly one argument that is an object
 * literal: a wrapper doing anything more interesting than passing its argument
 * through almost always takes something else too.
 *
 * @param node - The expression.
 * @returns The object literal, or `undefined` when it is not one.
 */
export function objectLiteral(node: Expression): ObjectExpression | undefined {
	let current = unwrapShallow(node);

	for (;;) {
		if (current.type === 'ObjectExpression') {
			return current;
		}

		if (current.type === 'CallExpression' && current.arguments.length === 1) {
			const [argument] = current.arguments;
			// a spread argument is not an object literal however it was written
			if (argument && argument.type !== 'SpreadElement') {
				current = unwrapShallow(argument);
				continue;
			}
		}

		return undefined;
	}
}

/**
 * The name a property declares, or `undefined` when it does not declare one
 * statically.
 *
 * A computed key is `undefined` even when it happens to hold a string, because
 * `['desc']` and `[key]` are the same syntax and only one of them is readable
 * -- and a pass that reads the easy half of a construct it does not support is
 * worse than one that skips it, since the half it skipped is silent.
 *
 * @param property - The property.
 * @returns The key.
 */
export function propertyKey(property: ObjectProperty): string | undefined {
	if (property.computed) {
		return undefined;
	}

	const { key } = property;

	if (key.type === 'Identifier') {
		return key.name;
	}

	// `{ 'desc': 'x' }` is the same declaration written with quotes
	if (key.type === 'Literal' && typeof key.value === 'string') {
		return key.value;
	}

	return undefined;
}

/**
 * The value a named property holds, when the object declares it plainly.
 *
 * `undefined` for an accessor, a method, a computed key, or a property that is
 * not there -- which the caller tells apart by asking whether it was declared
 * at all.
 *
 * @param object - The object literal.
 * @param name - The property to look for.
 * @returns The property, when it is a plain one.
 */
export function plainProperty(object: ObjectExpression, name: string): ObjectProperty | undefined {
	for (const property of object.properties) {
		if (property.type === 'SpreadElement') {
			continue;
		}

		if (propertyKey(property) === name && property.kind === 'init' && !property.method) {
			return property;
		}
	}

	return undefined;
}

/**
 * The string a node is, when it is one written down.
 *
 * A template literal with no substitutions counts: `` `build the app` `` is a
 * string somebody wrote, and refusing it would make the two spellings of one
 * thing disagree. One *with* substitutions does not, because its value is not
 * in the source.
 *
 * @param node - The expression.
 * @returns The string, or `undefined`.
 */
export function literalString(node: Expression): string | undefined {
	const value = unwrapShallow(node);

	if (value.type === 'Literal' && typeof value.value === 'string') {
		return value.value;
	}

	if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
		return value.quasis[0]?.value.cooked ?? undefined;
	}

	return undefined;
}

/**
 * The boolean a node is, when it is one written down.
 *
 * Only `true` and `false`. A `hidden: 1` is not a boolean, and the runtime
 * throws on a non-boolean `hidden` rather than coercing it -- so reading it as
 * truthy here would bake a value the app it came from refuses to start with.
 *
 * @param node - The expression.
 * @returns The boolean, or `undefined`.
 */
export function literalBoolean(node: Expression): boolean | undefined {
	const value = unwrapShallow(node);

	return value.type === 'Literal' && typeof value.value === 'boolean' ? value.value : undefined;
}
