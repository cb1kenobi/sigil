import { isPlainObject } from '@ttylabs/sigil/config';

/**
 * What YAML cannot hold, asked before a write rather than discovered after one.
 *
 * This is the **widest** of the three stores' answers and the only one that is
 * wider than JSON's, which is the finding rather than a convenience: YAML has a
 * spelling for things JSON does not, so refusing them here would be this store
 * declining to use its own format.
 *
 * ## What it allows that `jsonCanHold()` refuses
 *
 * - **`Infinity` and `-Infinity`**, written `.inf` and `-.inf`. They read back
 *   as themselves and `checkValue(Infinity, 'number')` takes one -- it refuses
 *   only `NaN` -- so the value survives a round trip and the next load. JSON
 *   rewrites both as `null`, which is why its store refuses them.
 *
 * ## What it allows that `@ttylabs/config-xml` refuses
 *
 * - **Every string there is.** XML refuses a whole class -- a C0 control, a lone
 *   surrogate, `U+FFFE`, a value whose own leading or trailing whitespace
 *   matters -- because XML has no escape for most of them and its parser
 *   normalizes the rest. YAML has a double-quoted scalar with an escape for
 *   everything, and `yaml` reaches for one when it has to: measured through a
 *   real UTF-8 file, `\u0001`, `\u0000`, `\u007f`, NEL, LS, PS, a bare CR, a
 *   CRLF, `U+FFFE`, both halves of a surrogate pair on their own, a byte order
 *   mark inside a value and `' padded '` each round-trip byte for byte.
 * - **Any key.** XML holds a key to the `Name` production; YAML quotes one. A
 *   key with a space, a colon, a newline or a control character in it
 *   round-trips. What a key still cannot be is unreachable-by-path, and that
 *   is **core's** refusal rather than this one's: `__proto__` and `constructor`
 *   are `Unsafe config key` out of `copyValue()`, which names the layer, and an
 *   empty key or one with a dot in it is allowed by core over a JSON layer too
 *   -- so this store allows both rather than inventing a refusal its sibling
 *   format does not have.
 *
 * ## What it refuses, each because the write would be silent
 *
 * Measured against `yaml` 2.9.1 by writing the value and reading it back:
 *
 * | value | `yaml` writes | reads back as |
 * | -- | -- | -- |
 * | `undefined` | `null` | `null` |
 * | `NaN` | `.nan` | `NaN`, which `checkValue()` refuses |
 * | a `bigint` | `10` | the **number** 10 |
 * | an invalid `Date` | `null` | `null` |
 * | a `Map` | its entries | a plain object |
 * | a `Set` | its members | an array |
 * | a class instance | its own keys | a plain object |
 * | a hole in an array | `null` | `null` |
 * | a function or a symbol | -- | `Tag not resolved`, thrown |
 *
 * Only the last is loud, and it is thrown out of `toString()` with neither the
 * path nor the file in it. The other eight are the silent-loss class every
 * decision in this package refuses.
 *
 * Not translated, which is the line `dotted.ts` draws in the runtime: a value
 * handed to `set()` is the **app's** own, and a user's file cannot hold anything
 * YAML cannot represent by construction -- so nothing a user writes reaches
 * this.
 */

/** Why YAML cannot hold a value, or nothing where it can. */
function why(value: unknown): string | undefined {
  switch (typeof value) {
    case 'bigint':
      // `String(10n)` is exact text, so unlike JSON -- which throws -- YAML
      // writes it happily. What refuses it is the other end: no data type reads
      // one back, so `'10'` on an `int` is the number 10 rather than `10n` and
      // the value does not survive a round trip under any declaration. Which is
      // `@ttylabs/config-xml`'s reason rather than JSON's
      return 'no YAML scalar reads back as a bigint';
    case 'function':
      return 'YAML has no function';
    case 'symbol':
      return 'YAML has no symbol';
    case 'undefined':
      return 'YAML writes undefined as null; delete the key instead';
    case 'number':
      // `Infinity` is `.inf` and reads back as itself, and `checkValue()` takes
      // one -- so it is allowed, which is the one place this store is wider
      // than JSON's. `NaN` is `.nan` and reads back as `NaN`, which
      // `checkValue()` refuses on a `number` setting: writing one produces a
      // config the next run cannot load, which is the same reasoning
      // `@ttylabs/config-xml` records for the text spelling
      return Number.isNaN(value) ? 'YAML writes NaN as .nan, which no load accepts' : undefined;
    default:
      return undefined;
  }
}

/** What YAML writes an object of no kind it knows as, which is its own keys. */
function asPlain(value: object): string {
  const name = value.constructor?.name ?? 'value';

  // not every refused object is written as a **mapping**, and saying so of all
  // of them contradicted the table this module's own doc carries: measured
  // through `Document.createNode()`, which is the call `setIn()` makes, a `Set`
  // stringifies as `[1, 2]`, a `Uint8Array` the same, and a boxed `new
  // Number(1)` as `1`. The refusal is right in every case; the sentence naming
  // the cause was wrong, which is the thing a table of patterns is criticised
  // for one module along
  return `YAML writes a ${name} of this kind as ${writtenAs(value)}`;
}

/**
 * What `createNode()` writes an object of this kind as.
 *
 * Measured against `Document.createNode()`, which is the call `setIn()` makes,
 * rather than reasoned about -- and it is three answers where the sentence this
 * replaces had one. A `Map` is a **mapping** although it is iterable, a `Set`,
 * a typed array and a generator are each a **sequence**, and a boxed `Number`,
 * `String` or `Boolean` is a **scalar**. A class instance is a mapping of its
 * own enumerable keys.
 */
function writtenAs(value: object): string {
  if (value instanceof Map) {
    return 'a plain mapping';
  }

  if (
    value instanceof Set ||
    ArrayBuffer.isView(value) ||
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  ) {
    return 'a sequence of its own members';
  }

  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return 'a plain scalar';
  }

  return 'a plain mapping';
}

/**
 * Whether YAML can hold a value, and where it cannot.
 *
 * Walks, because the offending value is almost never the one that was handed
 * over: `set('server', { retries: new Map() })` is a plain object holding
 * something that reads back as a different kind, and a refusal naming `server`
 * would be pointing at the thing that is fine.
 *
 * @param value - The value.
 * @param path - What to call it, which is a dotted path from the caller's own.
 * @returns `true`, or a sentence saying why not.
 */
export function yamlCanHold(value: unknown, path: string): true | string {
  // the objects this walk is inside, added and removed around the recursion
  // rather than only added, which is `jsonCanHold()`'s own rule and for its
  // reason: a value referenced twice is a DAG that YAML writes twice, and only
  // a genuine cycle is refused. **How** it writes it twice depends on the route
  // and this used to claim one of the two: one `createNode()` of
  // `{x: shared, y: shared}` really does write an anchor and an alias, and the
  // two `setIn()` calls `editsFor()` emits for two new keys write two plain
  // copies with no anchor at all -- measured. Neither loses a value, which is
  // all this guard is about
  return look(value, path, new WeakSet<object>()) ?? true;
}

/** The walk, with the objects it is inside. */
function look(
  value: unknown,
  where: string,
  seen: WeakSet<object>,
  unwrap = true
): string | undefined {
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

  // an **invalid** `Date` before the `toJSON` pass below, because its own
  // `toJSON` is what makes it silent: `new Date(NaN).toJSON()` is `null`, so
  // `yaml` writes `null` and the value is gone. Core's JSON store has the same
  // hole and closing it there is a change to what every app's `set()` accepts,
  // taken inside a sibling package's ticket -- so this store is narrower than
  // its sibling by exactly one value and says so
  if (value instanceof Date && Number.isNaN(value.getTime())) {
    return at('YAML writes an invalid Date as null');
  }

  // asked before the structure, because `yaml` asks it before the structure:
  // `createNode()` calls `toJSON` and writes whatever it answers, so walking
  // the value's own keys would refuse it for what it holds rather than for what
  // it says. A valid `Date` is the case that matters -- its JSON form is an ISO
  // string and `type: 'date'` reads one back, so it round-trips through the
  // schema exactly as it does on a JSON layer.
  //
  // What it answers is **checked**, which it was not: returning here meant any
  // object with a `toJSON` was representable whatever it then wrote. Measured,
  // `canRepresent` said yes and the write produced `null` for `() => undefined`,
  // the number `10` for `() => 10n`, a mapping for a `Map`, a sequence for a
  // `Set`, `{}` for `() => new Date(...)`, and a raw `Tag not resolved for
  // Function value` naming neither path nor file for `() => () => 1`. Every one
  // of those is a silent rewrite or an unnameable throw, which are the two
  // classes this function exists to refuse.
  //
  // `unwrap` goes false for the answer alone, because that is what `createNode`
  // does: it calls `toJSON` **once** per value and does not call it again on
  // what came back -- which is why a `toJSON` returning a `Date` writes `{}`
  // rather than an ISO string, and so is refused here structurally. Anything
  // *nested* inside the answer is a different value and gets its own single
  // application, which is what `unwrap` defaulting back to true on the
  // recursion below means
  if (unwrap && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    let said: unknown;
    try {
      said = (value as { toJSON: () => unknown }).toJSON();
    } catch (e: unknown) {
      return at(`its own toJSON threw: ${(e as Error).message.split('\n')[0] as string}`);
    }
    return look(said, where, seen, false);
  }

  const list = Array.isArray(value);
  if (!list && !isPlainObject(value)) {
    return at(asPlain(value));
  }

  // a **symbol** key and a non-index own property of an array are each dropped
  // on the way out, by this walk and by `editsFor()` alike, because both read
  // an object with `Object.entries` and an array by index. Measured,
  // `canRepresent` said yes and the write left the file untouched for
  // `{a: 1, [Symbol('k')]: 2}`, and wrote `[1, 2]` for an array carrying an own
  // `extra: 3`. A value that is silently not written is the class this function
  // exists to refuse, so it is named rather than dropped
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    return at(`YAML has no symbol key; ${String(symbols[0])} would be dropped`);
  }

  if (list) {
    const extra = Object.keys(value).find((key) => String(Number(key)) !== key);
    if (extra !== undefined) {
      return at(`YAML writes a sequence as its items; the property "${extra}" would be dropped`);
    }
  }

  seen.add(value);
  try {
    if (list) {
      // by index rather than through `map()`, because an array can have
      // **holes** and every array method skips one -- which is
      // `jsonCanHold()`'s own recorded finding, and `yaml` writes a hole as
      // `null` exactly as `JSON.stringify` does
      for (let i = 0; i < value.length; i++) {
        const label = where === '' ? `${i}` : `${where}.${i}`;

        if (!(i in value)) {
          return `YAML has no hole in a sequence; it writes one as null (at "${label}")`;
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
