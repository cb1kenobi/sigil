import {
	assertColorLevel,
	type ColorLevel,
	type ColorSupportOptions,
	getColorLevel,
	setColorLevel,
	supportsColor,
} from './color-support.js';
import { hasAnsi, strip } from './strip.js';
import { createStyler, type Styler } from './style.js';

export { codes, CSI, ESC, type StyleName } from './codes.js';
export { type ColorLevel, type ColorSupportOptions, supportsColor } from './color-support.js';
export { hasAnsi, matcher as ansiMatcher, strip } from './strip.js';
export { type Styler, type Styles } from './style.js';

/**
 * The styler, plus the handful of things that are about the module rather than
 * about one chain.
 */
export interface Ansi extends Styler {
	/**
	 * How much color is written: `0` none, `1` the basic 16, `2` the 256-color
	 * palette, `3` truecolor. Detected on first use; assigning overrides the
	 * detection, and assigning `undefined` restores it.
	 *
	 * The level is read when text is rendered, so lowering it downsamples chains
	 * that were built before the change rather than leaving them to write
	 * sequences the terminal cannot render.
	 *
	 * Reading it always answers with a level; only the assignment accepts
	 * `undefined`, so a caller never has to guard a read for a value it cannot
	 * return.
	 */
	get level(): ColorLevel;
	set level(level: ColorLevel | undefined);
	/** Whether a string contains an escape sequence. */
	hasAnsi(str: string): boolean;
	/** Removes every escape sequence from a string. */
	strip(str: string): string;
	/** Detects the color level of a stream. */
	supportsColor(opts?: ColorSupportOptions): ColorLevel;
}

/**
 * Styles terminal output, and takes the styling back out again.
 *
 * Every style name is a property that returns another styler, so styles compose
 * by reading them off one another:
 *
 * ```js
 * ansi.bold.underline('Usage:');
 * ansi.hex('#5f87af')('mycli');
 * ansi.strip(styled); // the same text with nothing left to render
 * ```
 *
 * This instance is bound to `process.stdout`. Anything written somewhere else
 * wants its own, from `createAnsi()`: stderr and stdout are not the same
 * destination, and one of them being redirected says nothing about the other.
 *
 * Nothing here is a dependency: this is the `chalk` and `strip-ansi` that a
 * zero-dependency library cannot install.
 */
export const ansi: Ansi = decorate(createStyler(getColorLevel) as Ansi, {
	get: getColorLevel,
	set: setColorLevel,
});

export interface CreateAnsiOptions extends ColorSupportOptions {
	/**
	 * The level to render at, skipping detection. Equivalent to assigning
	 * `level` straight after.
	 */
	level?: ColorLevel;
}

/**
 * Builds a styler with a color level of its own.
 *
 * The point is a second destination. `ansi` reads `process.stdout`, and a
 * program that also writes to stderr cannot use one level for both: a piped
 * stdout and a stderr still on the terminal are the common case, not the exotic
 * one, and a single level renders one of them wrong.
 *
 * ```js
 * const err = createAnsi({ stream: process.stderr });
 * process.stderr.write(err.red('Something broke') + '\n');
 * ```
 *
 * @param opts - The level to use, or the stream and environment to detect one
 * from.
 * @returns The styler.
 */
export function createAnsi(opts: CreateAnsiOptions = {}): Ansi {
	let override = opts.level;
	let detected: ColorLevel | undefined;

	if (override !== undefined) {
		assertColorLevel(override);
	}

	const get = (): ColorLevel => override ?? (detected ??= supportsColor(opts));

	return decorate(createStyler(get) as Ansi, {
		get,
		set(level: ColorLevel | undefined) {
			assertColorLevel(level);
			override = level;
			// a level that was detected before the override went on is stale once it
			// comes back off, since the destination may have changed underneath
			detected = undefined;
		},
	});
}

/**
 * Adds what belongs to a root styler rather than to a chain built from it.
 *
 * @param styler - The root styler.
 * @param level - The accessors backing `level`.
 * @returns The same styler.
 */
function decorate(
	styler: Ansi,
	level: { get(): ColorLevel; set(level: ColorLevel | undefined): void }
): Ansi {
	return Object.defineProperties(styler, {
		hasAnsi: { configurable: true, value: hasAnsi, writable: true },
		level: { configurable: true, get: level.get, set: level.set },
		strip: { configurable: true, value: strip, writable: true },
		supportsColor: { configurable: true, value: supportsColor, writable: true },
	});
}

export default ansi;
