/**
 * Whether anything should move.
 *
 * `prefers-reduced-motion` has a real analogue in a terminal, and it is sharper
 * than the web's: a pipe, a file and a CI log have no frames at all, so an
 * animation that ticks into one writes a line per tick into something nobody
 * will ever watch play. That is the same distinction the live region already
 * makes for a spinner, generalized -- and the renderer is what knows whether
 * there is a terminal, so what lives here is the type and the override.
 *
 * ```js
 * import { forcedMotion } from '@ttylabs/sigil/style';
 *
 * forcedMotion();  // 'reduce' with SIGIL_REDUCED_MOTION=1, else undefined
 * ```
 */

/** Whether animations run, in `prefers-reduced-motion`'s own vocabulary. */
export type ReducedMotion = 'no-preference' | 'reduce';

/**
 * The user's override, if they set one.
 *
 * `SIGIL_REDUCED_MOTION` is namespaced for the reason `SIGIL_COLOR_SCHEME` is:
 * there is no cross-tool convention for this the way `NO_COLOR` is one for
 * colour, so an unnamespaced name would be claiming a standard that does not
 * exist. It reads the same vocabulary a boolean property does -- `1`, `on`,
 * `yes`, `true` -- plus `reduce` and `no-preference`, because those are the
 * words the media feature itself uses and somebody who has read the sheet will
 * type one of them.
 *
 * A value that is neither falls through rather than deciding, which is the rule
 * `SIGIL_COLOR_SCHEME` already follows: a variable somebody exported wrong
 * should not be a decision. An **empty** variable is unset, the way an empty
 * environment variable is in the parser.
 *
 * @param env - The environment. The process's, by default.
 * @returns The preference, or `undefined` where nobody said.
 */
export function forcedMotion(
	env: Record<string, string | undefined> = process.env
): ReducedMotion | undefined {
	const raw = env.SIGIL_REDUCED_MOTION?.trim().toLowerCase();
	if (!raw) {
		return undefined;
	}
	if (raw === 'reduce' || raw === '1' || raw === 'on' || raw === 'yes' || raw === 'true') {
		return 'reduce';
	}
	if (raw === 'no-preference' || raw === '0' || raw === 'off' || raw === 'no' || raw === 'false') {
		return 'no-preference';
	}
	return undefined;
}
