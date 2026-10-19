import { isPlainObject } from '@ttylabs/sigil/config';
import { __ } from '@ttylabs/sigil/i18n';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  visit,
  type Document,
  type LineCounter,
  type Node,
} from 'yaml';

/**
 * Reading a YAML document as a config value, and refusing the ones that would
 * read as something other than what they say.
 *
 * Almost all of this is the parser's: `yaml` resolves scalars, aliases and merge
 * keys, and `toJS()` hands back the plain value a layer merges. What is here is
 * the four shapes it resolves to something **wrong** rather than refusing, each
 * measured against `yaml` 2.9.1:
 *
 * - a tag outside the core schema, which resolves to a JS value no other layer
 *   format can produce;
 * - a key that is not a scalar, which `toJS()` stringifies *and prints a node
 *   process warning about to stderr*;
 * - a recursive alias, whose value is a cycle;
 * - a forward alias, which `toJS()` **throws** on rather than reporting -- and
 *   so does `toString()`, which is what makes refusing it here load bearing
 *   rather than tidy: the fidelity round trip in `store.ts` renders the
 *   unmodified document, so a forward alias threw out of *that* with neither
 *   the path nor a line in it, before the read was reached at all.
 *
 * Everything else `yaml` already reports, and reports better than a second walk
 * would: a multi-document stream is `MULTIPLE_DOCS`, two keys that name one path
 * are `DUPLICATE_KEY` through `options.ts`'s comparator, and a syntax error is
 * what it is -- each with a line, which is why `doc.errors` is consulted rather
 * than reimplemented.
 */

/** The seven tags YAML 1.2's core schema has. */
const CORE_TAGS: ReadonlySet<string> = new Set([
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:str',
]);

/** What a read needs besides the document. */
export interface ReadShape {
  /** Lines from offsets, for a message that can point at one. */
  lines: LineCounter;
  /** What to call the document in a message, which is its path. */
  what: string;
}

/** The line an offset is on, 1-based, or 0 where there is no offset to read. */
function lineAt(node: Node, read: ReadShape): number {
  const at = node.range?.[0];
  return at === undefined ? 0 : read.lines.linePos(at).line;
}

/**
 * Refuses a document that would read as something other than what it says.
 *
 * Walked **before** `toJS()` rather than after, which is not an ordering nicety
 * for the key case: a collection key makes `toJS()` print
 * `Warning: Keys with collection values will be stringified...` to **stderr**
 * through `process.emitWarning`, and a CLI writing to stderr because somebody's
 * config has an exotic key in it is not something to let happen and then
 * explain.
 *
 * @param doc - The parsed document.
 * @param read - The line counter and the path.
 * @throws If the document holds one of the four shapes.
 */
export function assertReadable(doc: Document, read: ReadShape): void {
  // the first thing the parser had to say, which already carries a line and
  // says it better than this could: a multi-document stream, two keys naming one
  // path, a syntax error. `prettyErrors` is off, so the message is one line
  const first = doc.errors[0];
  if (first) {
    throw new Error(__`Failed to parse ${read.what}: ${first.message.split('\n')[0] as string}`);
  }

  // an unresolved tag is a **warning** rather than an error -- measured -- and
  // `yaml` resolves it to the scalar's own text, so `a: !custom 5` reads as the
  // string `'5'` and the tag is gone. Which is the parses-and-does-the-wrong-
  // thing shape, so it is read off the warnings rather than left
  const unresolved = doc.warnings.find((it) => it.code === 'TAG_RESOLVE_FAILED');
  if (unresolved) {
    throw new Error(
      __`Failed to parse ${read.what}: ${unresolved.message.split('\n')[0] as string}`
    );
  }

  let fault: string | undefined;
  // the anchors `visit()` has passed, which is document order -- so an alias
  // whose source is not in here yet points **forward**. YAML requires an anchor
  // to be defined before the alias that refers to it, and `yaml` reports
  // nothing about one: `doc.errors` is empty, and `toJS()` and `toString()`
  // each throw `Unresolved alias` with nothing a reader can act on
  const anchors = new Set<string>();

  const anchorOf = (node: Node): void => {
    const name = (node as { anchor?: string }).anchor;
    if (typeof name === 'string') {
      anchors.add(name);
    }
  };

  const tagged = (node: Node): void => {
    const tag = (node as { tag?: string }).tag;
    if (fault === undefined && tag !== undefined && !CORE_TAGS.has(tag)) {
      // outside the core schema, and `yaml` resolves several of these to a JS
      // value no text format can hand back: `!!set` is a `Set`, `!!omap` a
      // `Map`, `!!binary` a `Buffer`, `!!timestamp` a `Date`. Each reaches the
      // merge as a **leaf** -- `isPlainObject()` says so -- which means an app
      // gets a value no sibling layer could have produced and this store's own
      // `canRepresent()` then refuses to write it back. Refused where it was
      // read instead, which is where the line is
      fault = __`${read.what}:${lineAt(node, read)}: the tag ${tag} is outside YAML 1.2's core schema`;
    }
  };

  visit(doc, {
    Alias(_key, node, path) {
      if (fault !== undefined) {
        return;
      }
      tagged(node);
      if (!anchors.has(node.source)) {
        fault = __`${read.what}:${lineAt(node, read)}: the alias *${node.source} comes before the anchor it refers to`;
        return;
      }
      // an alias whose own anchor is on one of its ancestors is a **cycle**, and
      // `toJS()` builds it: measured, `a: &x\n  b: *x` answers a value where
      // `v.a.b === v.a`. Core refuses a cycle on the way into a layer, so this
      // is the same refusal with a line on it rather than a second opinion
      for (const up of path) {
        if ((up as { anchor?: string }).anchor === node.source) {
          fault = __`${read.what}:${lineAt(node, read)}: the alias *${node.source} refers to itself`;
          return;
        }
      }
    },
    Map(_key, node) {
      if (fault !== undefined) {
        return;
      }
      tagged(node);
      anchorOf(node);
      for (const pair of node.items) {
        const key = pair.key as Node | null;
        // a scalar key is a path segment, whatever its own type: `1: a` reads
        // as the path `1`, which is where `{"1": "a"}` puts it in JSON. A
        // **collection** key is the one that has no path at all, and it is the
        // one `toJS()` would warn about on stderr
        if (key && !isScalar(key)) {
          fault = __`${read.what}:${lineAt(key, read)}: a mapping key is a ${isSeq(key) ? 'sequence' : 'mapping'}, which names no config path`;
          return;
        }
      }
    },
    Scalar(_key, node) {
      if (fault === undefined) {
        tagged(node);
        anchorOf(node);
      }
    },
    Seq(_key, node) {
      if (fault === undefined) {
        tagged(node);
        anchorOf(node);
      }
    },
  });

  if (fault !== undefined) {
    throw new Error(fault);
  }
}

/**
 * A copy in which an anchor and the aliases to it are **separate values**.
 *
 * `toJS()` resolves an alias to the *same object* the anchor resolved to --
 * measured, `base: &b {p: 1}` with `c: *b` answers a value where
 * `v.base === v.c` -- so a write to one path moves another. Which is a defect
 * rather than a nicety, and it is the write path that finds it: `overlay()`
 * applies a claimed `c.p` and the shared object makes `base.p` move with it, so
 * the diff reports **two** edits where one was asked for and the refusal then
 * names `base` -- a path the caller never mentioned. A refusal that names the
 * wrong path is worse than one that names none, because it is believed.
 *
 * Nothing in `yaml` turns the sharing off and `structuredClone()` preserves it
 * by design, so the copy is written: a plain recursive walk with **no memo**,
 * which is what duplicates each occurrence rather than linking them. A cycle
 * cannot reach here, because `assertReadable()` refuses a recursive alias --
 * and `maxAliasCount` bounds how many aliases a document may have at all, so an
 * unshared copy is bounded too.
 *
 * It also makes this store's own answer the same shape every other store's is:
 * core copies a layer's value on the way in, so the sharing never reached a
 * merged view -- but an app calling `store.readSync()` directly would have had
 * one value where `json()` hands over two.
 *
 * ## The assignment is `defineProperty`, which is not a style choice
 *
 * `out[key] = ...` with a key of `__proto__` goes through `Object.prototype`'s
 * own accessor and sets the copy's **prototype** rather than writing a
 * property -- which is the hazard `dotted.ts` in the runtime is written at
 * length about, reintroduced by a function added to fix something else. A YAML
 * file really can hold that key: `toJS()` hands it over as an **own** property,
 * measured, so core's `copyValue()` refuses it with `Unsafe config key` and
 * names the layer. This copy has to preserve it as own for that refusal to
 * happen at all -- without which the copy's prototype became the value,
 * `isPlainObject()` then said the document was not a mapping, and what a user
 * saw was `must hold an object` about a file whose real problem is a key nobody
 * should be able to write. Found by a test that had passed before this function
 * existed.
 */
function unshare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(unshare);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, it] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value: unshare(it),
        writable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * A document's value.
 *
 * `toJS()`'s, which is what resolves the aliases and the merge keys this store
 * reads -- so there is one implementation of what a `<<` means and it is the
 * parser's. Two things happen around it.
 *
 * It is **wrapped**, because it throws for an alias that points at an anchor
 * later in the document: measured, `b: *x` above `a: &x 1` leaves `doc.errors`
 * empty and `toJS()` raises `Unresolved alias`. `assertReadable()` refuses that
 * document first, so what is left reaching this catch is a shape neither it nor
 * `doc.errors` has met -- kept as a tripwire, because what it stands against is
 * a parser error escaping with neither the path nor a line in it.
 *
 * And it is **unshared**, for the reason above.
 *
 * @param doc - The parsed document.
 * @param read - The line counter and the path.
 * @returns The value.
 * @throws If the value cannot be built.
 */
export function readDocument(doc: Document, read: ReadShape): unknown {
  try {
    return unshare(doc.toJS());
  } catch (e: unknown) {
    throw new Error(
      __`Failed to read ${read.what}: ${(e as Error).message.split('\n')[0] as string}`
    );
  }
}

/** Whether a node carries an anchor something else could alias. */
export function anchored(node: unknown): boolean {
  return (
    (isMap(node) || isSeq(node) || isScalar(node)) &&
    typeof (node as { anchor?: string }).anchor === 'string'
  );
}

/** Whether a node is an alias. */
export function aliased(node: unknown): boolean {
  return isAlias(node);
}
