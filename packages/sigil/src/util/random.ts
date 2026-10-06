/**
 * A source of randomness, in `[0, 1)`, and a seeded one to inject.
 *
 * Here rather than beside either of its callers because there are two of them
 * now and the rule `seeded()` was written under is that there is "one algorithm
 * in this repository rather than two". The decrypt component needs one so a run
 * reproduces; a mask generator needs one for the same reason and may not import
 * it from `src/components/`, since that is the direction the dependency already
 * runs -- a component imports the canvas. Shipping a second xorshift32 in
 * `src/canvas/` would be the thing that comment refuses.
 *
 * Both barrels re-export it, so `@ttylabs/sigil/components` and
 * `@ttylabs/sigil/canvas` each answer for the generator their own documentation
 * says is injectable, and a caller that wants a mask does not drag the component
 * stack in to get a seed.
 */

/**
 * A source of randomness, in `[0, 1)`.
 *
 * Injectable because it is what makes a run reproducible, and "run it and look"
 * is not a test. What a reader does with a value outside the range is the
 * reader's: this type promises a fraction and every caller here clamps rather
 * than trusting one.
 */
export type Random = () => number;

/**
 * A seeded generator, so that a run reproduces.
 *
 * xorshift32, which is the generator the layout fuzzer and the signals stress
 * tests already use. It is shipped because a module whose documentation says the
 * randomness is injectable should carry the thing to inject: a demo that
 * reproduces and a test that asserts both want one, and reaching for a package
 * would break the rule that this runtime has no dependencies.
 *
 * **It cold-starts small, and that is worth knowing before seeding per
 * iteration.** The first draw is very nearly linear in the seed: measured,
 * `seeded(1)()` is 6.30e-5, `seeded(2)()` is 1.26e-4 and `seeded(240)()` is
 * 1.51e-2 -- so a loop that builds a fresh generator per round and reads a size
 * out of the first draw gets the same smallest size every round, for every seed
 * up to a couple of thousand. A fuzzer doing exactly that chose its grid width as
 * `1 + floor(random() * 7)` and got **1 for all 240 of its seeds**, which is a
 * grid too narrow to hold a wide cluster at all -- so the corpus contained none,
 * and it passed with the code it was checking deleted. One generator across the
 * loop is the shape to copy, which is what `test/layout/random.ts`'s caller
 * already does -- only its first tree is cold -- and a per-iteration seed wants a
 * handful of discarded draws.
 *
 * @param seed - Any integer. Zero is read as a fixed non-zero seed, because
 *   xorshift32 has no way out of it.
 * @returns The generator.
 */
export function seeded(seed: number): Random {
	let state = seed >>> 0 || 0x9e37_79b9;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_0000_0000;
	};
}
