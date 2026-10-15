import { isPlainObject } from '@ttylabs/sigil/config';

/**
 * What XML cannot hold, asked before a write rather than discovered after one.
 *
 * `canRepresent()` exists for exactly this and is synchronous for exactly this
 * reason: a format that cannot hold what it was handed says so at the `set()`
 * that wrote it, naming the layer and the format, rather than at a `save()` in
 * an exit handler. TOML's missing `null` is the case the interface was drawn
 * for; XML has four of its own, and three of them are **this store's mapping**
 * rather than the format's.
 *
 * Not translated. A value handed to `set()` is the app's own, and nothing a
 * *file* holds can provoke any of these -- which is the line the runtime's
 * `represent.ts` and `dotted.ts` already draw.
 *
 * ## What the format cannot hold
 *
 * `null` and `undefined`, because XML has no such thing: a key set to one would
 * have to be an empty element, which reads back as the empty string. Core drops
 * a key holding either before it reaches a store, so this is reachable only
 * through a `write()` a caller made directly -- which is public API, and is the
 * same reason `jsonCanHold()` is asked at both doors.
 *
 * Everything else is written as a **string**, which is the saving this format
 * gets rather than a cost: XML has no scalar kind, so a number, a boolean and a
 * `Date` all reach the file as text and `checkValue()` coerces them back
 * through the schema -- exactly as an environment variable already reaches an
 * option. What a value without a schema reads back as is a string, which is
 * documented rather than refused: refusing it would refuse the format's own
 * nature.
 *
 * ## What this store's mapping cannot distinguish
 *
 * Two pairs of values share one spelling, and in each case the one that is kept
 * is the one a round trip needs:
 *
 * - **`{}` against `''`.** An element with nothing in it serializes as `<a/>`
 *   whichever it came from, so the mapping has to pick, and it picks `''` --
 *   because that is what `set('host', '')` writes, so the round trip holds for
 *   the value an app can actually set. Which makes an empty object the one that
 *   is refused, and the way to clear a subtree is `delete()`. The **document**
 *   is exempt, because there `{}` is an empty config rather than a setting: it
 *   is what a store over a file nobody has written yet reads, and `<config/>`
 *   reads back as `{}` by the root rule.
 * - **`['']` against `[]`.** An empty list writes one empty element and a
 *   declared `multiple` path reads an empty single occurrence back as `[]`, so a
 *   list whose one item is the empty string is the same bytes. Exactly that
 *   array is refused -- `['a', '', 'b']` is three occurrences and reads back
 *   whole, so only the single-item case is ambiguous.
 *
 * ## And a string whose own whitespace is load bearing
 *
 * A leaf's text and an attribute's value are both **trimmed** on the way in,
 * for the reason `read.ts` gives: whitespace around a value in XML is layout.
 * So a string that does not trim to itself is one this store would write and
 * read back as something else, and a round trip that quietly changes a value is
 * the failure every other decision in this module refuses. Refused instead, and
 * the message says what it is -- which is honest and inconvenient, in the
 * direction this repository already picks over silent and wrong.
 */

/**
 * Whether a code point is one XML 1.0 cannot hold, or one this parser changes.
 *
 * Two sets in one predicate, because what a caller can do about either is the
 * same thing. Measured character by character rather than read off the spec,
 * and the first set is the one that matters: `@xmldom/xmldom` writes a C0
 * control **raw** and then parses it back, so the file round-trips here and is
 * rejected by every conforming tool -- a store writing a file nobody else can
 * read, with nothing saying so.
 *
 * - **Forbidden by XML 1.0's `Char` production**: C0 except tab, newline and
 *   carriage return; a lone surrogate; U+FFFE and U+FFFF. `Char` is
 *   `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`,
 *   so the range stopping at U+FFFD is why the last two are in. U+007F to
 *   U+009F **are** legal and are not here, which is the one place reading the
 *   production rather than guessing changed the answer.
 * - **Changed by this parser**: a carriage return becomes a newline, which is
 *   XML's own line-ending normalization, and NEL (U+0085) becomes a newline in
 *   text and a space in an attribute, which is XML 1.1's. Measured both ways.
 *
 * A lone surrogate is in both sets: it is illegal *and* it reaches the file as
 * U+FFFD, so the value changes even where a tool would read it.
 *
 * ## Code points rather than a character class, which is this repository's rule
 *
 * A class of `\u0000`-escapes is what `no-control-regex` is about, and the
 * recorded answer is not to suppress it: a suppression a formatter can detach
 * from the line it was written over is one that stops working without anybody
 * editing anything, which happened once already in the toolchain's copy of the
 * escape pass. `\p{Cc}` is the usual way out and is the **wrong set** here --
 * it is C0, `DEL` and C1, where this wants C0 minus three and neither `DEL` nor
 * C1. So the ranges are named as numbers, which carries no control character
 * escaped or otherwise and leaves nothing to keep in place.
 */
function badChar(code: number): boolean {
  // C0, except the three XML's own `Char` production keeps
  if (code < 0x20) {
    return code !== 0x09 && code !== 0x0a;
  }
  // a carriage return is legal and is normalized to a newline, so it is in the
  // second set rather than the first -- which the branch above would have said
  // too, and is split out so the reason is readable
  return code === 0x0d || code === 0x85 || code === 0xfffe || code === 0xffff;
}

/**
 * The first code point of a string that XML cannot carry, or nothing.
 *
 * Walked by code **point** rather than by code unit, so that an astral
 * character is one character rather than two surrogates -- which is what lets a
 * **lone** surrogate be the thing that is refused: iterating a string yields a
 * paired surrogate as one code point above U+FFFF and an unpaired one as itself.
 * So the check is "is this code point in the surrogate range at all", and it is
 * only ever true for a lone one.
 */
function firstBadChar(value: string): number | undefined {
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (badChar(code) || (code >= 0xd800 && code <= 0xdfff)) {
      return code;
    }
  }
  return undefined;
}

/** Why XML cannot hold a value, or nothing where it can. */
function why(value: unknown): string | undefined {
  if (value === null) {
    return 'XML has no null; delete the key instead';
  }

  switch (typeof value) {
    case 'undefined':
      return 'XML has no undefined; delete the key instead';
    case 'function':
      return 'XML has no function';
    case 'symbol':
      return 'XML has no symbol';
    case 'bigint':
      // unlike JSON's reason, which is that `JSON.stringify` **throws**:
      // `String(10n)` is exact text, so the refusal is not inherited. It is
      // that no schema type reads one back -- `'10'` on an `int` is the number
      // `10` rather than `10n` -- so a bigint round-trips to a different value
      // under every declaration, where `8080` round-trips to itself
      return 'XML has no bigint, and no data type reads one back';
    case 'number':
      // `NaN` reaches the file as the text `NaN`, which `transformValue()`
      // **refuses** on a `number` setting -- so writing one produces a config
      // the next run cannot load. `Infinity` happens to read back, and is
      // refused with it rather than explained: one rule is worth more than a
      // divergence from `jsonCanHold()` that has to be remembered
      return Number.isFinite(value) ? undefined : `XML has no ${value}`;
    case 'string': {
      if (value.trim() !== value) {
        return 'XML trims a value, so leading or trailing whitespace would not survive a round trip';
      }
      const bad = firstBadChar(value);
      if (bad !== undefined) {
        return `XML cannot carry U+${bad.toString(16).toUpperCase().padStart(4, '0')} in a value`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Whether a name is one an element can have.
 *
 * XML 1.0's `Name` production **without the colon**, which is the one
 * deliberate narrowing: a colon makes a prefixed name, and this mapping's own
 * rule is that a prefix is not part of a path -- so a key called `a:b` would
 * write an element whose local name is `b` under a prefix `a` and read back as
 * `b`. Measured: `createElementNS(null, 'a:b')` throws
 * `prefix is non-null and namespace is null`, which is a DOM error naming
 * nothing a caller can act on.
 *
 * Which is the whole reason this is here: without it `set('1bad', 'v')`
 * reached `write()` and threw `invalid character in qualified name "1bad"` --
 * `@xmldom/xmldom`'s own message, with neither the file nor the path in it, at
 * a `save()` rather than at the `set()` that wrote it. `canRepresent()` is
 * synchronous for exactly that.
 */
const NAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';

/** A name an element can have: the `Name` production, minus the colon. */
const NAME = new RegExp(
  `^[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`,
  'u'
);

/** Whether a path segment or a key can be an element name. */
function nameable(name: string): boolean {
  return NAME.test(name);
}

/**
 * Whether this store can hold a value, and where it cannot.
 *
 * Walks, for `jsonCanHold()`'s reason: the offending value is almost never the
 * one that was handed over, so `set('server', { name: ' x ' })` names
 * `server.name` rather than `server`.
 *
 * @param value - The value.
 * @param path - What to call it, which is a dotted path from the caller's own.
 * @returns `true`, or a sentence saying why not.
 */
export function xmlCanHold(value: unknown, path: string): true | string {
  // the path's own segments first, because the message should name the segment
  // rather than the value sitting at it: `set('1bad', 'v')` is a *name* XML
  // cannot have, and nothing about `'v'` is wrong. Split here rather than
  // through `segments()`, which refuses an unsafe key and an empty one with its
  // own messages -- those are already refused one layer up, and this answers a
  // different question about the same string
  for (const part of path ? path.split('.') : []) {
    if (!nameable(part)) {
      return `XML has no element called "${part}"${path === part ? '' : ` (at "${path}")`}`;
    }
  }

  // the objects this walk is inside, so a cycle is a refusal rather than a
  // hang -- added and removed around the recursion, which is `copyInto()`'s own
  // rule: a value referenced twice is a DAG that writes twice, and only a
  // genuine cycle is refused
  return look(value, path, new WeakSet<object>()) ?? true;
}

/** The walk, with the objects it is inside. */
function look(value: unknown, where: string, seen: WeakSet<object>): string | undefined {
  const at = (answer: string): string => (where === '' ? answer : `${answer} (at "${where}")`);
  const answer = why(value);

  if (answer !== undefined) {
    return at(answer);
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  if (seen.has(value)) {
    return at('a value that refers back to itself');
  }

  // a `Date` is the one non-plain object that gets through, and its ISO form is
  // why: `transformValue(iso, 'date')` reads one back, so a `Date` really does
  // round-trip where a `Map` reaches the file as `[object Map]`. The same
  // reasoning `jsonCanHold()` records for letting a `toJSON` through, narrowed
  // to the one case the schema can read -- a general `toJSON` rule would have
  // to answer what to do when one returns structure, and nothing needs it
  if (value instanceof Date) {
    return undefined;
  }

  const list = Array.isArray(value);

  // a `Map`, a `Set`, a class instance: each reaches a file as whatever
  // `String()` makes of it, which is `[object Map]`. Refused rather than
  // written, which is the silent-rewrite class `jsonCanHold()` exists for
  if (!list && !isPlainObject(value)) {
    return at(`XML has no way to write a ${(value as object).constructor?.name ?? 'value'}`);
  }

  if (list) {
    if (value.length === 1 && value[0] === '') {
      return at(
        'a list of one empty string is the same bytes as an empty list, so it cannot be told apart'
      );
    }
  } else if (Object.keys(value).length === 0 && where !== '') {
    // except at the top, which is the **document** rather than a setting: an
    // empty one is `<config/>` and the root rule reads that back as `{}`, so
    // `write({})` round-trips and is what a store over a file nobody has
    // written yet is handed. `set('server', {})` is the refused case, and it is
    // the one somebody means something by
    return at('an empty object is the same bytes as an empty string, so it cannot be told apart');
  }

  seen.add(value);
  try {
    if (list) {
      // by index rather than through `map()`, because an array can have holes
      // and every array method skips one -- the finding `jsonCanHold()` records
      for (let i = 0; i < value.length; i++) {
        const label = where === '' ? `${i}` : `${where}.${i}`;

        if (!(i in value)) {
          return `XML has no hole in a list (at "${label}")`;
        }

        const inner = look(value[i], label, seen);
        if (inner !== undefined) {
          return inner;
        }
      }
    } else {
      for (const [key, it] of Object.entries(value)) {
        const label = where === '' ? key : `${where}.${key}`;

        // the keys as well as the path, because `write()` is handed a whole
        // document and the path it is asked about is `''`: a key nothing ever
        // passed to `set()` -- one that came off an `apply()`, or out of
        // another layer -- reaches the DOM with no segment check behind it
        if (!nameable(key)) {
          return `XML has no element called "${key}"${where === '' ? '' : ` (at "${where}")`}`;
        }

        const inner = look(it, label, seen);
        if (inner !== undefined) {
          return inner;
        }
      }
    }
  } finally {
    seen.delete(value);
  }

  return undefined;
}
