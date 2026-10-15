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
    case 'string':
      return value.trim() === value
        ? undefined
        : 'XML trims a value, so leading or trailing whitespace would not survive a round trip';
    default:
      return undefined;
  }
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
        const inner = look(it, where === '' ? key : `${where}.${key}`, seen);
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
