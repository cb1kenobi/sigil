import type { ReadShape } from './read.js';
import { isPlainObject } from '@ttylabs/sigil/config';
import { __ } from '@ttylabs/sigil/i18n';
import { isAlias, isMap, isScalar, isSeq, type Document, type Node } from 'yaml';

/**
 * Writing a value back into a parsed document, by editing it rather than
 * replacing it.
 *
 * ## The diff is the whole of why a comment survives
 *
 * `doc.contents = createNode(value)` is one line and loses every comment in the
 * file. So this computes the paths at which the document and the target value
 * **differ** and calls `setIn()` or `deleteIn()` for each, which is
 * `@ttylabs/config-xml`'s `applyInto()` one format along and
 * for its reason: everything untouched is untouched, so a comment, an anchor,
 * a quoting style and a block scalar survive because nothing rewrote them.
 *
 * A sequence is diffed by **index**, so a `push` is one `setIn()` and an
 * `unshift` rewrites every element -- which is the same trade the XML store
 * records, and it is what keeps a comment on an untouched element.
 *
 * ## Three kinds of path a write refuses, each measured
 *
 * An anchor, an alias and a merge key are the three things YAML has that no
 * other config format does, and a write that touched one would be wrong in a
 * different way each time. Against `yaml` 2.9.1:
 *
 * 1. **Through an alias**: `c: *b` and a write to `c.p` throws
 *    `Expected YAML collection at c. Remaining path: p` out of `setIn()` --
 *    an internal error naming neither the file nor anything a user can act on.
 * 2. **A delete of a merged key**: `c: {<<: *b, q: 2}` and `deleteIn(['c','p'])`
 *    answers **`false`** and changes nothing, so the value still reads `1` after
 *    a `delete()` said it was gone. Silent, which is the worst of the three.
 * 3. **An aliased anchor**: writing `base.p` where `base` is `&b` and another
 *    map merges it moves `c.p` as well -- a path the write never claimed --
 *    so the document no longer holds the value it was handed. And *deleting*
 *    one leaves the document **unserializable**: `toString()` throws
 *    `Unresolved alias`, so the file cannot be written at all.
 *
 * Which is why the refusal is sharper than "both answers are defensible". Each
 * names the path and the line, and nothing else in the file is affected: an
 * anchor or an alias on a path the write does not touch survives, which is what
 * the diff buys.
 *
 * ## A *set* of a merged key is allowed, and that is the one place this differs
 * from the list above
 *
 * `set('c.p', 99)` where `c` takes `p` from `<<: *b` writes `p: 99` **into
 * `c`**, shadowing the merge: measured, the anchor is untouched, `base.p` stays
 * `1`, and a re-read answers exactly what was written. An explicit key beats a
 * merge key whatever their order, so the value round-trips -- and shadowing is
 * the only way to make that path hold that value without editing an anchor
 * every other map that merges it also reads. So it is allowed rather than
 * refused, and the surprise -- a key that used to track `base` now does not --
 * is what a `set()` on that path asks for.
 */

/** One change to make to the document. */
interface Edit {
  /** The dotted path, as segments. */
  at: readonly string[];
  /** Whether to remove it rather than set it. */
  drop: boolean;
  /** What to set it to, where it is not a removal. */
  value?: unknown;
}

/** A path a write may not touch, and why. */
interface Fence {
  /** The line the blocking node is on. */
  line: number;
  /** What is in the way. */
  why: 'alias' | 'anchor';
}

/** A map that takes some of its value from a merge key. */
interface Merged {
  /** The line the map's merge key is on. */
  line: number;
  /** The keys the map writes out itself. */
  own: ReadonlySet<string>;
}

/** What a write may not touch in this document. */
export interface Fences {
  /** Paths at or under an alias or an aliased anchor, by dotted path. */
  blocked: ReadonlyMap<string, Fence>;
  /** Maps with a merge key, by dotted path. */
  merged: ReadonlyMap<string, Merged>;
}

/** The dotted spelling of a path, for a message and for a map key. */
function dotted(at: readonly string[]): string {
  return at.join('.');
}

/** Every anchor name something in this document aliases. */
function aliasedAnchors(doc: Document): ReadonlySet<string> {
  const out = new Set<string>();

  const walk = (node: unknown): void => {
    if (isAlias(node)) {
      out.add(node.source);
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        walk(pair.value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const it of node.items) {
        walk(it);
      }
    }
  };

  walk(doc.contents);
  return out;
}

/**
 * The paths a write may not touch, and the maps that merge.
 *
 * An anchor fences its subtree only where something **aliases** it, which is a
 * narrowing rather than caution: an anchor nobody refers to is a label, so
 * editing what it names moves nothing else and the write preserves the anchor
 * either way. An anchor something does alias is shared state, and the two
 * measured failures above are what happens when a write edits one.
 *
 * @param doc - The parsed document.
 * @param read - The line counter and the path.
 * @returns What a write may not touch.
 */
export function fencesOf(doc: Document, read: ReadShape): Fences {
  const blocked = new Map<string, Fence>();
  const merged = new Map<string, Merged>();
  const shared = aliasedAnchors(doc);

  const lineOf = (node: Node): number => {
    const at = node.range?.[0];
    return at === undefined ? 0 : read.lines.linePos(at).line;
  };

  const walk = (node: unknown, at: readonly string[]): void => {
    if (isAlias(node)) {
      // the alias itself and everything under it: a write that replaced the
      // alias would drop the reference, and one that reached through it throws
      blocked.set(dotted(at), { line: lineOf(node), why: 'alias' });
      return;
    }

    if ((isMap(node) || isSeq(node) || isScalar(node)) && typeof node.anchor === 'string') {
      if (shared.has(node.anchor)) {
        blocked.set(dotted(at), { line: lineOf(node), why: 'anchor' });
        // and no deeper: the subtree is fenced by the prefix check, so
        // recording every descendant would be the same answer at more cost
        return;
      }
    }

    if (isMap(node)) {
      const own = new Set<string>();
      let mergeLine: number | undefined;

      for (const pair of node.items) {
        const key = pair.key as Node | null;
        // the merge key arrives as a scalar whose value is a **symbol** --
        // `yaml`'s `MERGE_KEY` -- which is what tells it from a literal key
        // spelled `"<<"`: measured, the quoted form is an ordinary string key
        // and reads as one
        if (key && isScalar(key) && typeof key.value === 'symbol') {
          mergeLine = lineOf(key);
          continue;
        }
        if (key && isScalar(key)) {
          own.add(String(key.value));
        }
      }

      if (mergeLine !== undefined) {
        merged.set(dotted(at), { line: mergeLine, own });
      }

      for (const pair of node.items) {
        const key = pair.key as Node | null;
        if (key && isScalar(key) && typeof key.value !== 'symbol') {
          walk(pair.value, [...at, String(key.value)]);
        }
      }
      return;
    }

    if (isSeq(node)) {
      node.items.forEach((it, i) => walk(it, [...at, String(i)]));
    }
  };

  walk(doc.contents, []);
  return { blocked, merged };
}

/** Whether two leaf values are the same value as far as a write is concerned. */
function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

/**
 * The edits that take `current` to `target`.
 *
 * Deepest-first is **not** needed and is deliberately not arranged: `setIn()`
 * and `deleteIn()` each resolve their own path against the document as it
 * stands, and no edit this produces is a prefix of another -- a path where the
 * two values differ in *kind* is one edit for the whole subtree rather than one
 * per leaf under it.
 *
 * @param current - What the document holds.
 * @param target - What it should hold.
 * @param at - The path reached so far.
 * @returns The edits, in document order.
 */
export function editsFor(current: unknown, target: unknown, at: readonly string[] = []): Edit[] {
  if (isPlainObject(current) && isPlainObject(target)) {
    const out: Edit[] = [];

    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(target, key)) {
        out.push({ at: [...at, key], drop: true });
      }
    }
    for (const [key, value] of Object.entries(target)) {
      if (!Object.hasOwn(current, key)) {
        out.push({ at: [...at, key], drop: false, value });
        continue;
      }
      out.push(...editsFor(current[key], value, [...at, key]));
    }

    return out;
  }

  if (Array.isArray(current) && Array.isArray(target)) {
    const out: Edit[] = [];

    // the tail first, so that a shorter target drops from the end rather than
    // renumbering under the sets that follow
    for (let i = current.length - 1; i >= target.length; i--) {
      out.push({ at: [...at, String(i)], drop: true });
    }
    for (let i = 0; i < target.length; i++) {
      if (i >= current.length) {
        out.push({ at: [...at, String(i)], drop: false, value: target[i] });
        continue;
      }
      out.push(...editsFor(current[i], target[i], [...at, String(i)]));
    }

    return out;
  }

  return same(current, target) ? [] : [{ at, drop: false, value: target }];
}

/**
 * Refuses an edit the document cannot take.
 *
 * Every **prefix** of the path is checked rather than only the path itself,
 * which is what makes the fence cover a subtree: an alias at `c` blocks `c`,
 * `c.p` and `c.p.q` alike, with one entry recorded rather than one per
 * descendant.
 */
function assertEditable(edit: Edit, fences: Fences, read: ReadShape): void {
  for (let i = 0; i <= edit.at.length; i++) {
    const prefix = dotted(edit.at.slice(0, i));
    const fence = fences.blocked.get(prefix);
    if (!fence) {
      continue;
    }
    const where = prefix === '' ? __`the document` : `"${prefix}"`;
    throw new Error(
      fence.why === 'alias'
        ? __`Cannot write "${dotted(edit.at)}" in ${read.what}: ${where} is an alias, on line ${fence.line}`
        : __`Cannot write "${dotted(edit.at)}" in ${read.what}: ${where} carries an anchor another node aliases, on line ${fence.line}`
    );
  }

  if (!edit.drop || edit.at.length === 0) {
    return;
  }

  // a **removal** of a key a map takes from a merge key, which `deleteIn()`
  // answers `false` for and changes nothing. A *set* of one is allowed, because
  // `yaml` shadows it and the value round-trips
  const parent = dotted(edit.at.slice(0, -1));
  const last = edit.at[edit.at.length - 1] as string;
  const merge = fences.merged.get(parent);

  if (merge && !merge.own.has(last)) {
    throw new Error(
      __`Cannot remove "${dotted(edit.at)}" from ${read.what}: it comes from the merge key on line ${merge.line}`
    );
  }
}

/**
 * Applies a value to a document, touching only what differs.
 *
 * Every edit is **checked before any is applied**, which is the rule `Show`
 * keeps in the runtime: build first and touch nothing until there is something
 * to put there, because that is the only order where a failure needs no undo.
 *
 * It is a **declared sabotage survivor** rather than a guard a test can see.
 * `store.ts` renders into a document it made itself and writes the file from
 * what this returns, so a refusal part way through leaves a half-applied
 * document nobody can reach and the file untouched either way -- which is what
 * the test for it asserts, and is therefore true of one loop as well as two.
 * What the two passes are for is this function's own contract: it is handed a
 * document by its caller, and handing back a half-applied one is a worse thing
 * to do than throwing. The same footing `clipboardSequence()`'s unreachable
 * assertion is on.
 *
 * @param doc - The parsed document, which is modified.
 * @param current - What it holds.
 * @param target - What it should hold.
 * @param read - The line counter and the path.
 * @throws If any edit touches an anchor, an alias or a merged key.
 */
export function applyInto(doc: Document, current: unknown, target: unknown, read: ReadShape): void {
  const edits = editsFor(current, target);
  if (edits.length === 0) {
    return;
  }

  const fences = fencesOf(doc, read);
  for (const edit of edits) {
    assertEditable(edit, fences, read);
  }

  for (const edit of edits) {
    if (edit.at.length === 0) {
      // the whole document, which is the one path `setIn([])` cannot take:
      // measured, it throws `Already at the root`. Reached where the root's own
      // kind changed, which for a config is a map becoming something else --
      // and `store.ts` has already refused anything but a map, so what is left
      // is a map that was empty and is not
      doc.contents = doc.createNode(edit.value);
      continue;
    }
    if (edit.drop) {
      doc.deleteIn(edit.at);
      continue;
    }
    doc.setIn(edit.at, edit.value);
  }
}
