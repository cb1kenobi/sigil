/**
 * Whether the user is on a light background or a dark one.
 *
 * Every default colour sigil ships is a bet on dark, and there was nothing an
 * author or a theme could write to make one conditional. This is the input that
 * fixes that, and the whole of the feature is: get the value, put it on the media
 * context, and let the cascade do what it already does -- `@media
 * (prefers-color-scheme: light)` drops straight into the existing query grammar
 * beside `min-width` and `color-level`, with no new resolution path and nothing
 * added to the matching engine.
 *
 * Nothing here reads a stream or waits for anything: this module is the
 * *synchronous* half, which is an environment variable and some arithmetic. The
 * truthful half is an OSC 11 round trip through `@ttylabs/sigil/input`, and it
 * refines what this answers rather than replacing it.
 *
 * ```js
 * import { schemeFromEnv, schemeForBackground } from '@ttylabs/sigil/style';
 *
 * schemeFromEnv(); // 'light', 'dark', or undefined when nothing said
 * schemeForBackground(255, 255, 255); // 'light'
 * ```
 */

/** A light background or a dark one. The two values `prefers-color-scheme` takes. */
export type ColorScheme = 'dark' | 'light';

/**
 * The scheme a palette index means as a background.
 *
 * `COLORFGBG` carries `fg;bg` with the background as a palette index, and the
 * split is the one the sixteen already imply: black and the six dark hues are a
 * dark background, white and the nine bright ones are a light one. `8` is "bright
 * black", which is a dark grey in every theme that has an opinion, so it is on the
 * dark side despite the word "bright".
 *
 * Read as a table rather than as a range because the obvious arithmetic gets both
 * ends of the middle wrong: `bg < 8` calls `7` dark, and it is white, and it calls
 * `8` light, and it is a grey dark enough to put text on.
 */
const BACKGROUNDS: readonly ColorScheme[] = [
	'dark', // 0 black
	'dark', // 1 red
	'dark', // 2 green
	'dark', // 3 yellow
	'dark', // 4 blue
	'dark', // 5 magenta
	'dark', // 6 cyan
	'light', // 7 white
	'dark', // 8 bright black, which is a grey
	'light', // 9 bright red
	'light', // 10 bright green
	'light', // 11 bright yellow
	'light', // 12 bright blue
	'light', // 13 bright magenta
	'light', // 14 bright cyan
	'light', // 15 bright white
];

/**
 * Where the luminance of a background stops being dark.
 *
 * Half of full scale, which is the midpoint and not a tuned number: a threshold
 * fitted to a handful of terminal themes is a threshold that is wrong about the
 * next one. `should read the midpoint rather than the digits` is what pins it --
 * the property asserted is that the boundary sits at half, not that it sits at
 * `127.5`, so a change to how luminance is computed fails for the right reason.
 */
export const SCHEME_MIDPOINT: number = 127.5;

/**
 * The perceived brightness of a colour, on 0-255.
 *
 * ITU-R BT.601's weighting, which is what everything from a web accessibility
 * checker to `xterm` itself uses for this question. Deliberately *not* the Oklab
 * lightness the degrader computes, and the two are asking different things: the
 * degrader needs perceptual *distance* between two colours it is choosing
 * between, where Oklab is measurably better, and this needs a single scalar
 * compared against a midpoint, where a second colour-space conversion buys
 * nothing and costs a reader one more thing to hold.
 *
 * @param r - Red, 0-255.
 * @param g - Green, 0-255.
 * @param b - Blue, 0-255.
 * @returns The brightness, 0-255.
 */
export function luminance(r: number, g: number, b: number): number {
	return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * The scheme a background colour implies.
 *
 * @param r - Red, 0-255.
 * @param g - Green, 0-255.
 * @param b - Blue, 0-255.
 * @returns `'light'` for a background brighter than the midpoint.
 */
export function schemeForBackground(r: number, g: number, b: number): ColorScheme {
	return luminance(r, g, b) > SCHEME_MIDPOINT ? 'light' : 'dark';
}

/**
 * What the *user* said, which is the one answer nothing else may overrule.
 *
 * `SIGIL_COLOR_SCHEME` is namespaced on purpose. There is no cross-tool convention
 * for forcing a colour scheme in a terminal the way `NO_COLOR` is one for colour,
 * so an unnamespaced name would be claiming a standard that does not exist. It is
 * the recourse for the combination that really happens -- a terminal that sets no
 * `COLORFGBG` and answers no OSC 11 -- and it is a separate function from
 * `schemeFromEnv()` because it sits at a different place in the chain: a reply from
 * the terminal beats `COLORFGBG` and must not beat this. Reading both through one
 * function is what put a reply above the override for one commit.
 *
 * A value that is neither `light` nor `dark` falls through rather than deciding,
 * because a variable somebody exported wrong should not be a decision.
 *
 * @param env - The environment to read. Defaults to `process.env`.
 * @returns The forced scheme, or `undefined` when nothing forced one.
 */
export function forcedScheme(
	env: Record<string, string | undefined> = process.env
): ColorScheme | undefined {
	const forced = env.SIGIL_COLOR_SCHEME?.trim().toLowerCase();
	return forced === 'light' || forced === 'dark' ? forced : undefined;
}

/**
 * What the terminal put in the environment, which is a hint and not an answer.
 *
 * `COLORFGBG` is what rxvt, Konsole and several others set, and it is **frequently
 * stale or absent, and notoriously wrong under tmux** -- a multiplexer passes
 * through whatever was in its own environment when the *server* started, which is
 * whichever terminal happened to launch it rather than the one attached now. That
 * is exactly why it is the floor and not the answer: an OSC 11 reply refines it a
 * frame or two later, and being wrong until then is the price of having a
 * synchronous answer at all.
 *
 * The background is the **last** field rather than the second, because the variable
 * has two shapes in the wild: `15;0` and `15;default;0`. A field that is not a
 * palette index -- `default`, or anything unparseable -- is no answer rather than a
 * guess, which is the same rule an empty environment variable already follows in
 * the parser.
 *
 * @param env - The environment to read. Defaults to `process.env`.
 * @returns The scheme the background index implies, or `undefined`.
 */
export function schemeFromTerminalEnv(
	env: Record<string, string | undefined> = process.env
): ColorScheme | undefined {
	const fgbg = env.COLORFGBG;
	if (fgbg === undefined || fgbg.trim() === '') {
		return undefined;
	}

	const fields = fgbg.split(';');
	const background = fields[fields.length - 1].trim();
	if (!/^\d+$/.test(background)) {
		return undefined;
	}

	return BACKGROUNDS[Number.parseInt(background, 10)];
}

/**
 * The whole synchronous answer: what the user said, else what the terminal said.
 *
 * The one call for a caller with nothing else to order against --
 * `themedCascade()` and `renderToString()`, neither of which has a terminal reply
 * in play. A renderer does have one, so it reads the two halves separately and puts
 * the reply between them.
 *
 * @param env - The environment to read. Defaults to `process.env`.
 * @returns The scheme, or `undefined` when nothing said.
 */
export function schemeFromEnv(
	env: Record<string, string | undefined> = process.env
): ColorScheme | undefined {
	return forcedScheme(env) ?? schemeFromTerminalEnv(env);
}
