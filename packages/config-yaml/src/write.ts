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
 * ## The paths a write refuses, each measured
 *
 * An anchor, an alias and a merge key are the three things YAML has that no
 * other config format does, and a write that touched one would be wrong in a
 * different way each time; a tag is the fourth, and it rewrites a value rather
 * than moving it. Against `yaml` 2.9.1:
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
 * 4. **A tagged scalar the tag cannot spell back**: `a: !!int 5` set to `1.5`
 *    wrote `a: !!int 1.5`, which the next read refuses with `Unresolved tag`,
 *    and `!!bool true` set to `null` wrote `a: !!bool false` and read back
 *    **false**. Asked of the tag rather than of the value's `typeof`, which
 *    was the proxy that let both of those through.
 * 5. **A removal of a key carrying an aliased anchor**, and of any **ancestor**
 *    that holds one: `editsFor()` emits a drop or a kind-changing replacement
 *    of a whole subtree as one edit at the ancestor, so the anchor buried
 *    inside it met no fence and `yaml` threw its own `Unresolved alias` with
 *    neither the file nor the path in it.
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
  /** Pairs whose **key** carries an aliased anchor, by dotted path. */
  keyAnchored: ReadonlyMap<string, Fence>;
  /** Scalars carrying an explicit tag, by dotted path. */
  tagged: ReadonlyMap<string, Tagged>;
}

/** A scalar whose own tag decides what a value written onto it becomes. */
interface Tagged {
  /** The line it is on. */
  line: number;
  /** The tag as it is written. */
  tag: string;
  /** `typeof` the value it currently holds. */
  type: string;
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
  const tagged = new Map<string, Tagged>();
  const keyAnchored = new Map<string, Fence>();
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

    // a scalar whose tag is written in the file decides what a value set onto
    // it becomes, because `setIn()` keeps the node and only swaps its value
    if (isScalar(node) && typeof node.tag === 'string') {
      tagged.set(dotted(at), {
        line: lineOf(node),
        tag: node.tag,
        type: typeof node.value,
      });
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

          // an anchor can sit on a **key**, and this walk only ever visits
          // values -- so `&k host: x` with `copy: *k` was invisible to every
          // fence. Measured, deleting `host` removed the pair the alias points
          // at, `deleteIn()` having already run, and the document could not even
          // be rendered: `toString()` threw `Unresolved alias`, naming no file.
          // Only a **removal** is refused, because editing the value keeps the
          // key and its anchor and round-trips
          if (typeof key.anchor === 'string' && shared.has(key.anchor)) {
            keyAnchored.set(dotted([...at, String(key.value)]), {
              line: lineOf(key),
              why: 'anchor',
            });
          }
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
  return { blocked, keyAnchored, merged, tagged };
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
/**
 * Whether a tag writes this value back as itself.
 *
 * Measured against `Document` + `toString()` + a re-parse over a matrix of the
 * five core tags and nine values, rather than reasoned from the grammar. The
 * integer forms are the subtle pair: `!!int` takes a number only where its
 * **decimal printing** is all digits, so `1e21` is refused although
 * `Number.isInteger(1e21)` is true, and `!!float` takes a number only where it
 * is **not**, because JS cannot spell `2.0` and `!!float 2` does not resolve.
 * Conservative where the measurement was odd -- a string onto `!!float`
 * round-tripped and is refused anyway, because nothing should rely on it.
 */
function tagTakes(tag: string, value: unknown): boolean {
  const integral = typeof value === 'number' && /^[-+]?[0-9]+$/.test(String(value));

  switch (tag) {
    case 'tag:yaml.org,2002:str':
      return typeof value === 'string';
    case 'tag:yaml.org,2002:bool':
      return typeof value === 'boolean';
    case 'tag:yaml.org,2002:int':
      return integral;
    case 'tag:yaml.org,2002:float':
      return typeof value === 'number' && !integral;
    case 'tag:yaml.org,2002:null':
      return value === null;
    default:
      return false;
  }
}

/** Whether a value is one `editsFor()` descends into rather than replacing whole. */
function isCollection(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

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

  // and an edit that takes a whole subtree away has to answer for the fences
  // **under** it, which the prefix walk above cannot see: `editsFor()` emits a
  // drop, or a replacement whose value is not a collection, as a single edit at
  // the ancestor, so a fenced descendant inside it was never consulted.
  // Measured, dropping `grp` from `grp:\n  host: &k example.com\nother: *k\n`
  // threw `yaml`'s own `Unresolved alias ... k` -- no file, no path, nothing
  // actionable -- where dropping the anchored key itself names both. A
  // collection value is left alone because `editsFor()` descends into one, so
  // the removal of an anchored descendant arrives as its own edit and meets
  // the exact-path fences instead
  if (edit.drop || !isCollection(edit.value)) {
    const under = `${dotted(edit.at)}.`;
    const buried = [...fences.blocked, ...fences.keyAnchored].find(
      ([at]) => at !== '' && at.startsWith(under)
    );

    if (buried) {
      const [at, fence] = buried;

      throw new Error(
        __`Cannot write "${dotted(edit.at)}" in ${read.what}: it holds "${at}", which carries an anchor another node aliases, on line ${fence.line}`
      );
    }
  }

  // a key a map takes from a **merge key** is not one of its own pairs, and
  // `setIn()` and `deleteIn()` only ever see own pairs. Every segment of the
  // path is asked about, not just the last: the guard used to ask about the
  // immediate parent of a *drop* alone, and what that left through was measured
  // as data loss. With `base: &b {nest: {a: 1, b: 2}}` and `c: {<<: *b}`,
  // asking for `c.nest = {a: 9, b: 2}` wrote `c.nest.a` as a new own pair and
  // the read then answered `{a: 9}` -- key `b` **gone**, because the own pair
  // shadows the whole merged `nest` rather than merging into it. The same shape
  // over a sequence wrote `c.items` as `"1": 9`, so an array came back a
  // mapping. And a *delete* one level deeper threw `yaml`'s own `Expected YAML
  // collection at nest. Remaining path: a`, which names neither the file nor
  // the path
  for (let i = 0; i < edit.at.length; i++) {
    const merge = fences.merged.get(dotted(edit.at.slice(0, i)));
    const key = edit.at[i] as string;

    if (!merge || merge.own.has(key)) {
      continue;
    }

    // the merged key **itself**, set rather than dropped, is the one case that
    // works and is documented: `yaml` writes an own pair that shadows it and
    // the value round-trips. Deeper than that the own pair shadows a subtree it
    // was meant to edit, and a drop has nothing of its own to remove
    if (i === edit.at.length - 1 && !edit.drop) {
      continue;
    }

    throw new Error(
      edit.drop
        ? __`Cannot remove "${dotted(edit.at)}" from ${read.what}: it comes from the merge key on line ${merge.line}`
        : __`Cannot write "${dotted(edit.at)}" in ${read.what}: it comes from the merge key on line ${merge.line}`
    );
  }

  if (edit.drop) {
    const key = fences.keyAnchored.get(dotted(edit.at));

    if (key) {
      throw new Error(
        __`Cannot remove "${dotted(edit.at)}" from ${read.what}: its key carries an anchor another node aliases, on line ${key.line}`
      );
    }
  }

  if (edit.drop || edit.at.length === 0) {
    return;
  }

  // a scalar carrying an explicit tag re-stringifies whatever is set onto it,
  // because `setIn()` keeps the node and swaps its value. Measured, that was a
  // write that silently did not take and a write that produced an unreadable
  // file: `a: !!bool true` set to the string `'false'` left the file **byte
  // identical** and read back boolean `true`, and `a: !!int 5` set to `'nope'`
  // wrote `!!int .nan`, which the next read refuses with `Unresolved tag`.
  //
  // Refused unless the tag writes this value back **as itself**, which is a
  // question about the tag rather than about the value's `typeof`. That proxy
  // was the defect a review round measured: it compared `typeof edit.value`
  // against the type the scalar currently holds, so a *same-type* write that
  // the tag cannot spell went straight through -- `a: !!int 5` set to `1.5`
  // wrote `a: !!int 1.5`, which the next read refuses with `Unresolved tag`,
  // and `!!float 1.5` set to `2` wrote `a: !!float 2`, unreadable for the same
  // reason, because JS has no spelling of `2.0`. And `null` bypassed the guard
  // **entirely**, since `typeof null` is `'object'`: `!!bool true` set to
  // `null` wrote `a: !!bool false` and read back `false`, and `!!str 5` set to
  // `null` read back the string `"null"` -- silent wrong data, no throw.
  //
  // A **collection** is still exempt, and that is the one case the old
  // `'object'` test was right about: a scalar becoming a map or a sequence
  // replaces the node and its tag with it, which is the node genuinely going
  // rather than its value being rewritten
  const tag = fences.tagged.get(dotted(edit.at));

  if (tag && !isCollection(edit.value) && !tagTakes(tag.tag, edit.value)) {
    throw new Error(
      __`Cannot write "${dotted(edit.at)}" in ${read.what}: it carries the tag ${tag.tag} on line ${tag.line}, which would not write ${String(edit.value)} back as itself`
    );
  }
}

/**
 * An edit path spelled the way the **document** spells it.
 *
 * `editsFor()` diffs the value `toJS()` produced, so every segment it builds is
 * a string -- a mapping key stringified, and a sequence index as `String(i)`.
 * `setIn()` and `deleteIn()` match a path element against the node's own key,
 * and a YAML key is not always a string, so the two came apart in the two ways
 * a mismatch can:
 *
 * - **A write appended a second key and the file stopped parsing.** Measured,
 *   `writeSync({'1': 'b'})` over `1: a` left `1: a` and added `"1": b`, and the
 *   read then refused the result with `Map keys must be unique`. The same for
 *   `true: a`, `2.5: a` and `null: a`. No throw: `save()` exited normally having
 *   written a config nothing can load. That is the exact violation the
 *   uniqueness comparator in `options.ts` exists to refuse on the way *in* --
 *   `1: a` and `"1": b` are one path -- created by the way out.
 * - **A delete was a silent no-op.** `writeSync({name: 'x'})` over
 *   `1: a\nname: x\n` left `1: a` in place, where a string key was removed.
 *
 * So each segment is resolved against the document as the path is walked: a
 * mapping key keeps the **key's own value**, which is the number `1` rather
 * than the string `'1'`, and a sequence index becomes a **number**. The number
 * matters on its own -- `collectionFromPath` builds an array for a numeric key
 * and a mapping for a string one, so a new collection reached through a merge
 * key came out `{"1": 9}` where `[1, 9, 3]` was asked for.
 *
 * A segment the document does not have is kept as the string it is, which is a
 * new key and is correct: a key this write is adding is a string key.
 *
 * `String(value)` is the same widening `samePath()` compares with, deliberately
 * -- one rule for "the same path segment" rather than two that can disagree. A
 * **null** key cannot reach here, because `assertReadable()` refuses one.
 *
 * @param doc - The parsed document.
 * @param at - The path as `editsFor()` built it.
 * @returns The same path, each segment as the document spells it.
 */
function nativePath(doc: Document, at: readonly string[]): (string | number)[] {
  const out: (string | number)[] = [];
  let node: unknown = doc.contents;

  for (const segment of at) {
    if (isSeq(node)) {
      const index = Number(segment);
      out.push(index);
      node = Number.isInteger(index) ? node.items[index] : undefined;
      continue;
    }

    if (isMap(node)) {
      const pair = node.items.find(
        (it) => isScalar(it.key) && String((it.key as { value: unknown }).value) === segment
      );

      if (pair) {
        out.push((pair.key as { value: string | number }).value);
        node = pair.value;
        continue;
      }
    }

    out.push(segment);
    node = undefined;
  }

  return out;
}

/**
 * Gives a null root an empty mapping to be edited into, carrying its comments.
 *
 * `rootOf()` reads a null root as `{}`, so the diff against it emits ordinary
 * key inserts rather than a root edit -- and `setIn()` then needs a collection
 * to put them in. Two shapes reach here and only one of them is obvious:
 * measured, a comment-only file parses with `contents === null` and `setIn()`
 * works, while anything with a `---`, and an explicit `null` or `~`, parses
 * with `contents` a **scalar** holding null and `setIn()` throws `Expected a
 * YAML collection as document contents`.
 *
 * The comments are carried because that scalar is where they sit: a
 * `---\n# hi\n` keeps the comment on `contents.comment`, and `null # c\n` the
 * same, where a bare `# hi\n` keeps it on the document's own `commentBefore`
 * and needs nothing. Replacing the contents without carrying them is the silent
 * comment loss `rootOf()`'s own doc records, one step along.
 *
 * Called after the no-op return, so a write that asks for nothing still touches
 * nothing: a null root and an empty target produce no edits, the document is
 * left exactly as it parsed, and the file is not rewritten. Without that
 * ordering a no-op write of `# hi\n` rendered `# hi\n\n{}\n`.
 *
 * @param doc - The parsed document, which is modified where its root is null.
 */
function openRoot(doc: Document): void {
  const was: unknown = doc.contents;
  if (was !== null && !(isScalar(was) && was.value === null)) {
    return;
  }

  const map = doc.createNode({}) as Node & {
    comment?: string;
    commentBefore?: string;
  };

  // `yaml` types these as `string | null` where the node's own fields are
  // `string | undefined`, so the null is excluded rather than cast
  if (isScalar(was)) {
    if (typeof was.comment === 'string') {
      map.comment = was.comment;
    }
    if (typeof was.commentBefore === 'string') {
      map.commentBefore = was.commentBefore;
    }
  }

  doc.contents = map;
}

/**
 * Applies a value to a document, touching only what differs.
 *
 * Every edit is **checked before any is applied** by the pass below, which is
 * the rule `Show` keeps in the runtime: build first and touch nothing until
 * there is something to put there. What that pass checks is `assertEditable()`
 * and nothing else, which is narrower than this used to claim: `deleteIn()` and
 * `setIn()` can still throw out of `yaml` itself on the apply pass, and the
 * document is already part-modified when they do. Measured, an edit pair whose
 * second half was a delete through a merge key left `ok: 2` applied and then
 * threw -- so the **file** is untouched, because `store.ts` throws before
 * `writeAtomic()`, and the document handed in is not.
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

  openRoot(doc);

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
    const at = nativePath(doc, edit.at);

    if (edit.drop) {
      doc.deleteIn(at);
      continue;
    }
    doc.setIn(at, edit.value);
  }
}
