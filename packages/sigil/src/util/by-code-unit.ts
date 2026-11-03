/**
 * Two strings in UTF-16 code-unit order, which is `Array.sort()`'s own default
 * said out loud for a sort that has a key.
 *
 * `localeCompare` is the wrong answer for anything a machine reads -- an order
 * that decides which command registers first, or bytes that are generated,
 * committed, compared or snapshot-tested: it reads the process locale, so the
 * same input orders differently on two machines. Measured by the reference,
 * which had it first: `localeCompare` puts `ä` before `a_b` under
 * `LANG=de_DE.UTF-8` and after `z` under `sv_SE.UTF-8`. And no locale agrees
 * with code-unit order about case -- `B` before `a` here, `a` before `B` under
 * every collation -- which is what lets a test tell the two apart without
 * setting one.
 *
 * It is the answer for a list a person reads as well, which is help's command
 * list and the palette's base order: one app's help should not list in two
 * orders on two machines either, and whether a list follows its reader's
 * language is the locale-aware sorting `src/i18n/AGENTS.md` records as out of
 * scope. See "Help sorts commands" in `src/help/AGENTS.md`.
 *
 * One function rather than one per caller, because two spellings of one rule is
 * how they come to disagree: the route walk, the completion spec, the command
 * surface, help and the palette all order the same registries, and each used to
 * say how separately. The toolchain has its own copy, for the reason its
 * `src/by-code-unit.ts` gives.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns Negative where `a` comes first, positive where `b` does, `0` where
 *   they are the same string.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
