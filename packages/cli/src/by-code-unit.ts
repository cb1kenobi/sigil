/**
 * Two strings in UTF-16 code-unit order, which is `Array.sort()`'s own default
 * said out loud for a sort that has a key.
 *
 * The toolchain's copy of `byCodeUnit()` in `@ttylabs/sigil`'s
 * `src/util/by-code-unit.ts`, and a copy on purpose: this package reaches that
 * one only through a published subpath, and exporting a comparator from one
 * would promise every app a function that is a line long and is not what the
 * framework is for. The rule is the same and so is the body, which is what
 * keeps two copies from disagreeing -- there is nothing in it to drift.
 *
 * Not `localeCompare`, for what a machine reads and for what a person reads
 * alike: it reads the process locale, so the same input orders differently on
 * two machines -- `ä` before `a_b` under `de_DE` and after `z` under `sv_SE`,
 * and `a` before `B` under every collation where code units put `B` first.
 * One copy for the package rather than one per caller, which is the same
 * reason the framework has one.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns Negative where `a` comes first, positive where `b` does, `0` where
 *   they are the same string.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
