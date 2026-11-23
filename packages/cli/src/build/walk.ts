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
 * Pre-order, children in `visitorKeys` order, and **with a stack of its own**
 * rather than the call stack's (SIG-625). A recursive walk overflowed at about
 * 3,500 levels -- a `+` or `||` chain of that many terms is a left-nested tree
 * that deep -- and a `RangeError` out of a build step is a failure somebody has
 * to be told about, which the shake's reader was not: it caught everything and
 * fell back to a raw token scan, so the rules the unread half of the file opened
 * were dropped and the build said nothing. What reads a tree now reaches as deep
 * as the parser does, which is the limit that matters.
 *
 * @param node - Where to start.
 * @param visit - Called per node; returning `false` skips its children.
 */
export function walk(node: Node, visit: (node: Node) => boolean): void {
  const pending: Node[] = [node];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!visit(next)) {
      continue;
    }

    // the children in order, then pushed back to front so the first is popped
    // first: the order a recursive walk would have visited them in
    const children: Node[] = [];
    for (const key of visitorKeys[next.type] ?? []) {
      const child = (next as unknown as Record<string, unknown>)[key];

      if (Array.isArray(child)) {
        for (const each of child) {
          if (isNode(each)) {
            children.push(each);
          }
        }
        continue;
      }

      if (isNode(child)) {
        children.push(child);
      }
    }

    for (let at = children.length - 1; at >= 0; at--) {
      pending.push(children[at] as Node);
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
