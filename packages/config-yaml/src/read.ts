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
 * the shapes it resolves to something **wrong** rather than refusing, each
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
 *   the path nor a line in it, before the read was reached at all;
 * - an integer whose digits the double does not hold, which reads back as a
 *   different integer with nothing said;
 * - a null key, a `NaN` key, and a numeric key whose source denotes a
 *   different number than the path it lands on -- three ways for a key to
 *   name a path that is not the one the file wrote.
 *
 * Everything else `yaml` already reports, and reports better than a second walk
 * would: a multi-document stream is `MULTIPLE_DOCS`, two keys that name one path
 * are `DUPLICATE_KEY` through `options.ts`'s comparator, and a syntax error is
 * what it is -- each with a line, which is why `doc.errors` is consulted rather
 * than reimplemented.
 */

/**
 * An integer as YAML 1.2's core schema spells one.
 *
 * The sign is decimal-only, which is the production rather than an oversight.
 * Read against a scalar's own `source`, so that a float whose value happens to
 * be integral -- `1e21`, `1.5e20` -- is not mistaken for one.
 */
const INTEGER_SOURCE = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;

/**
 * The canonical decimal a numeric literal denotes, or `undefined` where the
 * source is not a finite decimal one.
 *
 * `digits` with the leading and trailing zeros gone, times ten to the `exp`, so
 * that one real number has exactly one spelling: `2.50` and `2.5` both come
 * back `25e-1`, and `1e21` and `1000000000000000000000` both come back `1e21`.
 * That is what makes it safe to compare a key's **source** against the path it
 * lands on -- the question is whether the two denote the same number, never
 * whether they are spelled the same way.
 *
 * `undefined` for a hex or octal source, which `INTEGER_SOURCE` already
 * answers for, and for `.inf` and `.nan`, which are not decimals at all.
 */
function decimalOf(source: string): string | undefined {
  const parts = /^([-+]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([-+]?[0-9]+))?$/.exec(source);

  if (parts === null) {
    return undefined;
  }

  const int = parts[2] ?? '';
  const frac = parts[3] ?? '';

  if (int === '' && frac === '') {
    return undefined;
  }

  const digits = `${int}${frac}`.replace(/^0+/, '');

  if (digits === '') {
    return '0';
  }

  const trimmed = digits.replace(/0+$/, '');
  const exp = Number(parts[4] ?? '0') - frac.length + (digits.length - trimmed.length);

  return `${parts[1] === '-' ? '-' : ''}${trimmed}e${exp}`;
}

/**
 * The seven tags YAML 1.2's core schema has, plus the non-specific one.
 *
 * `!` is **not** outside the schema: it says "resolve this by the schema" and
 * for a scalar the core schema resolves it to the scalar's own text, so
 * `a: ! true` is the string `"true"` and `a: ! 8080` the string `"8080"`. Both
 * are values this store can hold and write back, and refusing them was a false
 * refusal of a document with nothing wrong with it -- measured, with no error
 * and no warning from the parser either. On a **collection** `yaml` rewrites
 * `!` to the core map or seq tag before this walk sees it, so the scalar
 * spelling is the only one that ever arrives.
 */
const CORE_TAGS: ReadonlySet<string> = new Set([
  '!',
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
 * @throws If the document holds one of the shapes the module header lists.
 */
export function assertReadable(doc: Document, read: ReadShape): void {
  // the first thing the parser had to say, which already carries a line and
  // says it better than this could: a multi-document stream, two keys naming one
  // path, a syntax error. `prettyErrors` is the parser's **default**, which is
  // on -- this comment used to say it was off -- so the message is several
  // lines and the first of them is the one with the line number in it, which is
  // what `split` below takes. Setting it off to match the old sentence would
  // leave `Map keys must be unique` with no line at all
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

  // an integer the source names and JS cannot hold is a **different integer**,
  // which is the one failure a caller cannot detect -- and is the framework's
  // own recorded rule: the parser's `int` data type throws on exactly this
  // rather than handing back `...992` for `...993`. `yaml` resolves the core int
  // tag with `parseInt` and `intAsBigInt` is off, so measured,
  // `a: 9007199254740993` read as `9007199254740992` with no error, and the hex
  // spelling `0x20000000000001` read the same. Turning `intAsBigInt` on is not
  // the fix: every integer in every document would become a `bigint`, which
  // `checkValue()` then refuses on a `number` setting.
  //
  // Asked of the scalar's **own source text** rather than of its value, for two
  // reasons a review round measured. A value-only test fires on a **float**
  // whose value happens to be integral: `a: 1e21` and `a: 1.5e20` were each
  // refused as "the integer", although the file wrote a float and the double
  // holds it exactly. And the test is **exactness** rather than the
  // `Number.isSafeInteger` distinctness this first used, which refused 2^53
  // itself -- a value the file names unambiguously. `BigInt` of the source
  // against `BigInt` of the value is exact and base-agnostic, so the hex and
  // octal spellings need no normalizing: `0x20000000000001` is
  // `9007199254740993n` against the `9007199254740992n` the double holds, while
  // `150000000000000000000` and `9007199254740992` each come back equal and are
  // taken. What it refuses is exactly the set whose digits do not survive, and
  // the message names both numbers because the digits are what is lost.
  //
  // `canRepresent()` refuses the mirror of this set, which is what stops the
  // store writing a file its own next read would refuse -- and the mirror is
  // the *same* rule asked of the other side: this refuses a **source** whose
  // digits the double does not hold, and that refuses a **double** whose
  // printing is not the double.
  const counted = (node: Node): void => {
    const value = (node as { value?: unknown }).value;
    const source = (node as { source?: unknown }).source;

    if (
      fault !== undefined ||
      typeof value !== 'number' ||
      typeof source !== 'string' ||
      !INTEGER_SOURCE.test(source)
    ) {
      return;
    }

    // a source so long the double cannot hold it at all, where `BigInt()` of
    // the value throws rather than disagreeing
    if (!Number.isFinite(value)) {
      fault = __`${read.what}:${lineAt(node, read)}: the integer ${source} is larger than this runtime can hold at all`;
      return;
    }

    if (BigInt(source) !== BigInt(value)) {
      fault = __`${read.what}:${lineAt(node, read)}: the integer ${source} is not exactly representable; it would read back as ${String(value)}`;
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
          // an **alias** is a third kind and used to be reported as a mapping,
          // which is a sentence about a construct that is not there: `*id : 1`
          // names an alias, and what it would have resolved to is a plain
          // object rather than a key
          const kind = isAlias(key) ? 'an alias' : isSeq(key) ? 'a sequence' : 'a mapping';
          fault = __`${read.what}:${lineAt(key, read)}: a mapping key is ${kind}, which names no config path`;
          return;
        }
        // and a **null** key names none either, which is the rule above one
        // case short. The JSON analogy it rests on says `'null'` --
        // `JSON.stringify({[null]: 1})` is `{"null":1}` -- and `toJS()` says
        // `''`, which no dotted path can address, since `get('')` is the whole
        // merged view. Measured, keeping it was a silent data drop: `null: a`
        // beside `"": b` read as `{"": "b"}` with the value `a` gone, no error
        // and nothing thrown. `yaml` is not even consistent with itself about
        // it -- a null key copied by a `<<` lands on `'null'` while the direct
        // key lands on `''`, so one document read two paths for one key.
        //
        // An **empty-string** key is deliberately still taken: it is equally
        // unreachable, and it is what the user literally wrote and what a JSON
        // layer holds, so refusing it would invent a divergence from the
        // sibling store. A null key is a *different* key `yaml` maps onto that
        // same unreachable path, and inconsistently
        if (key && isScalar(key) && key.value === null) {
          fault = __`${read.what}:${lineAt(key, read)}: a null mapping key names no config path`;
          return;
        }

        // a **`NaN`** key names a path no write can ever reach, which is a
        // different thing from the null key above and is why it is refused
        // here rather than guarded in the writer. `yaml` matches a pair by its
        // key's own value and `NaN !== NaN`, so `setIn([NaN], v)` appends a
        // *second* pair -- measured, editing `.nan: a` produced
        // `.nan: a\n? .nan\n: B\n`, which this store's own reader then
        // refuses as a duplicate -- and `deleteIn([NaN])` answers `false`, so
        // a delete is a silent no-op with the key still there. Neither half
        // can be fixed in the writer: there is no spelling of the segment that
        // reaches the pair. `.inf` is **not** refused with it, because
        // `Infinity === Infinity` and a write addresses one perfectly well
        if (key && isScalar(key) && typeof key.value === 'number' && Number.isNaN(key.value)) {
          fault = __`${read.what}:${lineAt(key, read)}: a NaN mapping key names a config path no write can address`;
          return;
        }

        // and a numeric key whose **source denotes a different number than the
        // path does** is a path silently renamed. The integer guard below
        // catches the integer spellings; a float-spelled one escapes it,
        // because a float value rounding is ordinary float semantics and is
        // deliberately allowed. For a *key* it is not ordinary: the key is a
        // path segment, so `9007199254740993.0: a` read back as the path
        // `9007199254740992` is a setting that is simply not where the file
        // put it. Measured, and the same digits in integer form are refused,
        // so the two spellings disagreed. Compared as canonical decimals
        // rather than as text, or every ordinary float spelling -- `2.50`
        // against the path `2.5` -- would be refused with it
        if (key && isScalar(key) && typeof key.value === 'number' && key.source !== undefined) {
          const wrote = decimalOf(key.source);

          if (wrote !== undefined && wrote !== decimalOf(String(key.value))) {
            fault = __`${read.what}:${lineAt(key, read)}: the mapping key ${key.source} names the config path ${String(key.value)}, which is a different number`;
            return;
          }
        }
      }
    },
    Scalar(_key, node) {
      if (fault === undefined) {
        tagged(node);
        counted(node);
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
 * and `maxAliasCount` bounds the **product of resolutions** rather than how
 * many aliases a document may have -- this used to say the second -- so an
 * unshared copy is bounded too. It is left at `toJS()`'s own default of 100,
 * which is the resource-exhaustion guard doing its job rather than something
 * this store has to set.
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
 * `doc.errors` has met -- which this used to call a tripwire for a case nobody
 * has. **Two shapes a file can hold reach it**, and both are a user's file
 * rather than a hypothetical: a merge source that is not a map (`<<: 1`, an
 * empty `<<:`, `<<: [1, 2]`) throws `Merge sources must be maps or map
 * aliases`, and one anchor aliased past `toJS()`'s own `maxAliasCount` throws
 * `Excessive alias count indicates a resource exhaustion attack`. The wrap is
 * what puts the file on each of those; neither carries a line, which is the
 * honest limit of it.
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

/**
 * The mapping a document's root holds.
 *
 * One reader of one rule, because there were two and they disagreed. A YAML
 * document whose root resolves to `null` -- a comment-only file, a bare `---`
 * or `...`, an explicit `null` or `~` -- is an **empty config** rather than a
 * document holding `null`: `raw.trim()` cannot see any of those, so this is
 * where they land. And a root that is neither a mapping nor null is refused,
 * because merging it would make every key of every layer below it vanish.
 *
 * Both of those used to live in `store.ts`'s read path alone, while its write
 * path cast `readDocument()`'s `unknown` to a record and handed it to
 * `overlay()`. Measured, that was a crash, a silent comment loss or a silent
 * byte change depending on which door the caller came in: `set()` plus `save()`
 * threw `TypeError: Cannot set properties of null` naming no file; `apply()`
 * plus `save()` **succeeded** and dropped the file's comment with `wouldLose`
 * absent, which is this package's headline guarantee broken with nothing
 * reported; and `writeSync(readSync().value)` rewrote `null # c` to `{}`. The
 * cast is what silenced the type system, so the return type is the guard now.
 *
 * @param doc - The parsed document.
 * @param read - The line counter and the path.
 * @returns The root mapping, or `{}` where the root resolves to null.
 * @throws If the root is neither a mapping nor null.
 */
export function rootOf(doc: Document, read: ReadShape): Record<string, unknown> {
  const value = readDocument(doc, read);

  if (value === null || value === undefined) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error(__`${read.what} must hold an object`);
  }

  return value;
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
