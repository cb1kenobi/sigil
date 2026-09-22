/**
 * The analysis pass: a pure optimizer over the IR.
 *
 * SIG-72's rule, and the one thing this file may never break: **the analyzer
 * may not change what anything evaluates to.** `emit(analyze(ir))` and
 * `emit(ir)` build the same tree, and that is asserted over a corpus rather
 * than asserted in a comment -- see `test/emitters.test.ts`. What it buys is
 * that the build emitter's shortcuts are shortcuts rather than a second
 * dialect: every decision the compiler makes ahead of time is one this pass
 * already made in the IR, where both emitters can see it.
 *
 * ## It rewrites rather than annotates
 *
 * SIG-69 handed this over as "marking static subtrees, folding constants,
 * resolving class names and pre-measuring", with the warning that "marks
 * nothing reads are marks that go stale". The answer to that is not to be
 * careful with the marks: it is to have none. A fold is written into the IR, so
 * the build emitter sees a `<text>` with one literal child and prints
 * `text("...")` because that is what the node says -- not because a flag beside
 * it claims the children were static. There is no second copy of the truth to
 * keep in agreement, and the same rewritten IR still runs through `emit()`,
 * which is what makes the invariant above testable at all.
 *
 * ## What it does
 *
 * Constant folding, in the two places a template has constants:
 *
 * - A `<text>`'s content. Every piece that cannot change -- a literal run, an
 *   interpolated string or number -- is folded into the string it will draw,
 *   and adjacent pieces are merged. A `<text>` that comes out with one literal
 *   child is one the build emitter prints as `text("...")` with no runtime
 *   assembly at all.
 * - A box's children. An interpolated string or number is a `text` element
 *   however it arrived, so it is folded into one; an interpolated `null`,
 *   `undefined` or boolean draws nothing, so it is dropped. Both are exactly
 *   what `appendValue()` does at runtime, done once instead of per mount.
 *
 * ## What it deliberately does not do
 *
 * **It does not hoist a static subtree.** That is the optimization SIG-69 named
 * first and it is unsound here: Solid hoists a DOM template and *clones* it per
 * use, and there is nothing to clone here -- an `Element` is mutable, stateful,
 * and has one parent. A component body runs once per instance, so a subtree
 * hoisted to module scope would be one element tree shared by every row of a
 * `For`. What the build emitter hoists instead is the static *prop objects*,
 * which are read and never retained; that is in `emit.ts`, because it is a fact
 * about the generated module rather than about the tree.
 *
 * **It does not touch a component's children.** A host element's children are
 * nodes with known meaning; a component's are data it interprets, and folding
 * `${1}` into the string `"1"` would hand `Show` a different `when` than it was
 * written with.
 *
 * **It does not resolve class names or pre-measure text.** Both need something
 * that does not exist at this seam: a resolved class name needs the app's
 * stylesheets, which `sigil build` is what owns, and a measurement
 * needs a width and a resolved style -- neither of which a build has. A text's
 * measurement is cached per width and keyed on the resolved style object, so
 * there is no width to pre-measure *at*. They belong to the build once it has
 * an app to read, rather than to a function that has one template.
 */

import { type IRElement, type IRNode, textValue } from '@ttylabs/sigil/template';

/**
 * Folds the constants out of a template.
 *
 * @param node - The IR, from either frontend and from either path.
 * @returns The same tree with its constants folded, or the node itself when
 *   there was nothing to fold.
 */
export function analyze(node: IRNode): IRNode {
	if (node.kind !== 'element') {
		return node;
	}

	const children = node.children.map(analyze);
	const folded = foldChildren(node, children);

	return same(node.children, folded) ? node : { ...node, children: folded };
}

/**
 * Whether two child lists are the same list.
 *
 * @param before - What the node held.
 * @param after - What the fold produced.
 * @returns True when nothing moved, so the node can be handed back untouched.
 */
function same(before: readonly IRNode[], after: readonly IRNode[]): boolean {
	return before.length === after.length && before.every((child, at) => child === after[at]);
}

/**
 * Folds one element's children, according to what the element is.
 *
 * @param node - The element.
 * @param children - Its children, already analyzed.
 * @returns The children it should hold.
 */
function foldChildren(node: IRElement, children: readonly IRNode[]): readonly IRNode[] {
	if (node.type === 'text') {
		return foldContent(children);
	}
	if (node.type === 'box') {
		return foldBoxChildren(children);
	}
	// a `raw` has no children and a component's are its own business
	return children;
}

/**
 * Folds a `<text>`'s content into as few literal pieces as it can be written
 * in.
 *
 * @param children - The content, in order.
 * @returns The content with its constants merged.
 */
function foldContent(children: readonly IRNode[]): readonly IRNode[] {
	const folded: IRNode[] = [];

	for (const child of children) {
		const value = constant(child);

		if (value === undefined) {
			folded.push(child);
			continue;
		}

		// adjacent literals are one literal only inside a `<text>`, whose children
		// are pieces of one string. A box's two text children are two elements, and
		// merging them there would delete a flex item
		const last = folded[folded.length - 1];
		if (last?.kind === 'text') {
			folded[folded.length - 1] = { ...last, value: last.value + value };
		} else {
			folded.push({ kind: 'text', loc: child.loc, value });
		}
	}

	return folded;
}

/**
 * Folds a box's children: an interpolated value that is already a string is a
 * `text` element, and one that draws nothing is nothing.
 *
 * @param children - The children, in order.
 * @returns The children it should hold.
 */
function foldBoxChildren(children: readonly IRNode[]): readonly IRNode[] {
	const folded: IRNode[] = [];

	for (const child of children) {
		if (child.kind !== 'slot') {
			folded.push(child);
			continue;
		}

		const value = child.value;

		// `appendValue()` skips these, so there is nothing to append and nothing to
		// decide at run time
		if (value === null || value === undefined || typeof value === 'boolean') {
			continue;
		}

		const literal = constant(child);
		folded.push(literal === undefined ? child : { kind: 'text', loc: child.loc, value: literal });
	}

	return folded;
}

/**
 * What a child contributes to a string, when that is knowable without running
 * anything.
 *
 * A thunk is not, which is the whole of the reactive rule. Neither is an
 * `Expr`, which is the build path's hole -- and neither is an `Element` or any
 * other object, because `textValue()` throws on one and folding must not turn
 * a run-time error into a build-time one.
 *
 * @param child - The child node.
 * @returns The string it folds to, or `undefined` when it does not fold.
 */
function constant(child: IRNode): string | undefined {
	if (child.kind === 'text') {
		return child.value;
	}
	if (child.kind !== 'slot') {
		return undefined;
	}

	const value = child.value;
	switch (typeof value) {
		case 'bigint':
		case 'boolean':
		case 'number':
		case 'string':
			return textValue(value);
		case 'undefined':
			return '';
		default:
			return value === null ? '' : undefined;
	}
}
