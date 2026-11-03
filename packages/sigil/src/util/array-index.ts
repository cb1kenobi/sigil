/**
 * Whether a key is an **array index** rather than merely a canonical number: the
 * only kind of key `JSON.stringify` writes when it writes an array, and the only
 * kind a YAML sequence holds.
 *
 * `String(Number(key)) === key` alone is the second of those, which is what the
 * YAML store first tested: `-1`, `1.5`, `Infinity`, `NaN`, `4294967295` (one
 * past the last index there is) and `9007199254740991` all satisfy it, none of
 * them extends `length` or makes a hole for a hole check to catch, and each is
 * an own enumerable property a serializer drops in silence.
 *
 * One function for the output formats and the config stores, which each had a
 * spelling of their own -- a pattern here, a round trip there -- that agreed
 * about every key only because both were right. Published from
 * `@ttylabs/sigil/config` for the stores, and imported from here by
 * `format.ts`, which may not put the config chunk on its graph.
 *
 * @param key - The own enumerable key.
 * @returns Whether an array writes it as an element.
 */
export function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
