/**
 * Walking a parsed module, one visitor for everything that needs one.
 *
 * Two passes want this and want it identically: finding the `ui` templates in a
 * module, and finding the schema in an app's entry. Both need to stop a branch
 * -- a claimed template is not descended into, and a schema's own commands are
 * not searched for a second schema -- which is the one thing a plain recursive
 * `for..in` cannot express.
 *
 * It is driven by oxc's own `visitorKeys` rather than by a hand-written list of
 * node types. A list would be a second copy of the grammar, and the day the
 * parser grows a node this file has not heard of is the day whatever is inside
 * it stops being found -- silently, since nothing found is simply nothing
 * reported.
 */

import type { Node } from 'oxc-parser';
import { visitorKeys } from 'oxc-parser';

/**
 * Walks a tree, letting the visitor stop a branch.
 *
 * @param node - Where to start.
 * @param visit - Called per node; returning `false` skips its children.
 */
export function walk(node: Node, visit: (node: Node) => boolean): void {
	if (!visit(node)) {
		return;
	}

	for (const key of visitorKeys[node.type] ?? []) {
		const child = (node as unknown as Record<string, unknown>)[key];

		if (Array.isArray(child)) {
			for (const each of child) {
				if (isNode(each)) {
					walk(each, visit);
				}
			}
			continue;
		}

		if (isNode(child)) {
			walk(child, visit);
		}
	}
}

/**
 * Whether a value off a node's key is itself a node.
 *
 * A key may be `null` -- an omitted `returnType`, an elided array element -- and
 * a `type` is what every node has.
 *
 * @param value - The value.
 * @returns Whether to walk it.
 */
function isNode(value: unknown): value is Node {
	return !!value && typeof value === 'object' && typeof (value as Node).type === 'string';
}
