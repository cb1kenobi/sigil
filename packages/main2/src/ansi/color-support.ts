/**
 * How much color the destination can render.
 *
 * `0` is not "no terminal", it is "write no escape sequences at all" -- the
 * styler short-circuits and hands the text straight back.
 */
export type ColorLevel = 0 | 1 | 2 | 3;

export interface ColorSupportOptions {
	/** The environment to read. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * Whether the destination is a terminal. Defaults to the stream's `isTTY`,
	 * and to `false` when there is no stream -- a caller that passes neither is
	 * asking about a destination nothing can be assumed about.
	 */
	isTTY?: boolean;
	/** The platform to detect for. Defaults to `process.platform`. */
	platform?: string;
	/** The stream the output is bound for. Defaults to `process.stdout`. */
	stream?: { isTTY?: boolean };
}

/**
 * Detects the color level of a stream.
 *
 * Precedence, highest first:
 *
 * 1. `FORCE_COLOR` -- `0`/`false` disables, `1`/`true`/empty is 16 colors,
 *    `2` is 256, `3` is truecolor, and anything higher clamps to 3. It wins
 *    over `NO_COLOR` and over the TTY check, because forcing color through a
 *    pipe is the entire reason it exists; a variable exported once in a shell
 *    profile should not be the thing a caller cannot override.
 * 2. `NO_COLOR`, set to anything but the empty string -- disables. This is
 *    the [no-color.org](https://no-color.org) convention.
 * 3. `TERM=dumb` -- disables.
 * 4. Not a TTY -- disables.
 * 5. `COLORTERM`, `TERM_PROGRAM`, `TERM`, and the CI variables, which is
 *    where the level actually comes from on a real terminal.
 *
 * @param opts - The stream and environment to detect for.
 * @returns The detected level.
 */
export function supportsColor(opts: ColorSupportOptions = {}): ColorLevel {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	const forced = forceColorLevel(env);

	if (forced !== undefined) {
		return forced;
	}

	if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
		return 0;
	}

	if (env.TERM === 'dumb') {
		return 0;
	}

	const stream = 'stream' in opts ? opts.stream : process.stdout;
	const isTTY = opts.isTTY ?? stream?.isTTY ?? false;
	if (!isTTY) {
		return 0;
	}

	return ttyColorLevel(env, platform);
}

/**
 * Reads `FORCE_COLOR`.
 *
 * @param env - The environment to read.
 * @returns The forced level, or `undefined` when the variable is unset.
 */
function forceColorLevel(env: Record<string, string | undefined>): ColorLevel | undefined {
	const value = env.FORCE_COLOR;

	if (value === undefined) {
		return undefined;
	}

	if (value === 'false') {
		return 0;
	}

	// `FORCE_COLOR=` with nothing after it is how a shell says "yes, whatever
	// you can do", so it means the same as `1` rather than the same as `0`
	if (value === '' || value === 'true') {
		return 1;
	}

	const level = Number.parseInt(value, 10);
	if (Number.isNaN(level)) {
		// something unparseable is still someone asking for color
		return 1;
	}

	return Math.min(Math.max(level, 0), 3) as ColorLevel;
}

/**
 * The level of a destination already known to be a terminal.
 *
 * @param env - The environment to read.
 * @param platform - The platform to detect for.
 * @returns The detected level.
 */
function ttyColorLevel(env: Record<string, string | undefined>, platform: string): ColorLevel {
	const { COLORTERM, TERM = '', TERM_PROGRAM } = env;

	if (COLORTERM === 'truecolor' || COLORTERM === '24bit') {
		return 3;
	}

	if (TERM_PROGRAM === 'iTerm.app' || TERM_PROGRAM === 'vscode' || TERM_PROGRAM === 'WezTerm') {
		return 3;
	}

	if (TERM_PROGRAM === 'Apple_Terminal') {
		// Terminal.app renders the 256-color palette but not truecolor
		return 2;
	}

	if (platform === 'win32') {
		// Windows Terminal does truecolor; conhost on any Windows release Node
		// still runs on does 256
		return env.WT_SESSION !== undefined ? 3 : 2;
	}

	// the `-direct` terminfo entries are the direct-color ones
	if (/-direct\d*$/i.test(TERM)) {
		return 3;
	}

	if (/-256(?:color)?$/i.test(TERM)) {
		return 2;
	}

	if (/^(?:screen|xterm|vt100|vt220|rxvt|konsole|gnome|alacritty|kitty|foot)/i.test(TERM)) {
		return 2;
	}

	if (/(?:color|ansi|cygwin|linux)/i.test(TERM)) {
		return 1;
	}

	if (COLORTERM !== undefined) {
		return 1;
	}

	return ciColorLevel(env);
}

/**
 * The level of a CI runner. Called only for a destination that claims to be a
 * TTY, which most CI runners do not -- a CI job that wants color sets
 * `FORCE_COLOR` and never reaches here.
 *
 * @param env - The environment to read.
 * @returns The detected level.
 */
function ciColorLevel(env: Record<string, string | undefined>): ColorLevel {
	if (env.GITHUB_ACTIONS !== undefined || env.GITEA_ACTIONS !== undefined) {
		return 3;
	}

	if (env.CI !== undefined) {
		// Travis, CircleCI, Buildkite, GitLab, and the rest render the basic
		// 16; TeamCity's own renderer does too
		return 1;
	}

	if (env.TEAMCITY_VERSION !== undefined) {
		return 1;
	}

	return 0;
}

let current: ColorLevel | undefined;

/**
 * The color level everything the styler writes is rendered at.
 *
 * Detected from `process.stdout` and the environment on first read, not at
 * import, so an app that adjusts its environment before printing still gets
 * the level it asked for.
 *
 * @returns The current level.
 */
export function getColorLevel(): ColorLevel {
	current ??= supportsColor();
	return current;
}

/**
 * Overrides the detected color level, or clears the override.
 *
 * @param level - The level to use, or `undefined` to detect it again.
 */
export function setColorLevel(level: ColorLevel | undefined): void {
	assertColorLevel(level);
	current = level;
}

/**
 * Validates a color level.
 *
 * @param level - The level to check, or `undefined` for "detect it".
 */
export function assertColorLevel(level: ColorLevel | undefined): void {
	if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 3)) {
		throw new Error(`Invalid color level "${level}"; expected 0, 1, 2, or 3`);
	}
}
