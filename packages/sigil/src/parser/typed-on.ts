import type { InternalOption, ParseState } from '../types.js';

/**
 * Whether argv typed a flag on.
 *
 * Typed and true: a default or an environment variable can give a flag a value
 * without anybody asking for it, and `--help=false` is somebody typing it and
 * saying no. **Any** typed true wins, in either order, which is where the flags
 * the parser owns part company with every valued option in a schema: those are
 * last-wins by destination, and `--quiet --quiet=false` is quiet.
 *
 * One function for `--help`, `--version` and `--quiet`, which each wrote it out
 * -- the second two byte for byte, with a comment saying so and naming the two
 * copies disagreeing as the cost of deleting a line from one of them. The
 * three flags of this shape read argv the same way, and a function they share is
 * what makes that a fact rather than a promise.
 *
 * @param state - The parse state.
 * @param option - The flag to look for, or nothing where the app declared its
 *   own and the parser added none.
 * @returns `true` when argv turned it on.
 */
export function typedOn(state: ParseState, option: InternalOption | undefined): boolean {
  // a fast path rather than a guard: a `ParsedOption` carries a required
  // `option`, so an `undefined` one matches nothing and the scan answers
  // `false` either way. What it skips is a walk of `state.$` for every app that
  // declared its own
  if (!option) {
    return false;
  }

  return state.$.some(
    (parsed) => parsed.type === 'Option' && parsed.option === option && parsed.value === true
  );
}
