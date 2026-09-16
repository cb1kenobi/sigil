/**
 * The characters a heading may not contain: C0, C1, and the two Unicode line
 * separators.
 *
 * Built from a string rather than written as a literal, because the formatter
 * turns a `\u` escape inside a regular expression into the character itself --
 * which for these is a raw control character in the source, and for one of them
 * a line break in the middle of the pattern.
 *
 * No `g` flag, so there is no `lastIndex` to carry between calls.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const controls = new RegExp('[\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F\\u2028\\u2029]');

/**
 * The titles help writes itself, which a group or a section may not take.
 *
 * Only one so far: the inherited options are listed under `Global options`, so a
 * group named `Global` would put a second heading of that name on the same
 * screen, describing options in a different scope.
 */
const taken = new Set(['global']);

/**
 * Whether a string can be a heading: one line, and something on it.
 *
 * @param value - The string to test.
 * @returns `true` when it can.
 */
export function isLabel(value: unknown): boolean {
	return typeof value === 'string' && !!value.trim() && !controls.test(value);
}

/**
 * Checks a string that becomes a section heading in generated output.
 *
 * Anything printed on a line of its own has to be one line: a newline in a
 * section title splits the heading in half and leaves the rest of it reading as
 * body text, and a stray control character moves the cursor somewhere nothing
 * else accounted for. Both come from a title assembled out of data rather than
 * typed by hand, which is exactly the case that is hard to notice.
 *
 * A tab is allowed through the gap at `	`, because the wrapper already turns
 * one into a space. Surrounding whitespace is trimmed rather than rejected, since
 * it changes nothing about what the heading means.
 *
 * @param value - The string to check.
 * @param what - What it is, for the error message.
 * @returns The trimmed string.
 */
export function assertSectionTitle(value: unknown, what: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TypeError(`Expected ${what} to be a non-empty string`);
	}

	const label = value.trim();

	if (controls.test(label)) {
		throw new TypeError(`Expected ${what} to be a single line with no control characters`);
	}

	if (taken.has(label.toLowerCase())) {
		throw new TypeError(
			`Expected ${what} not to be "${label}": help writes "Global options" itself, and two headings of one name on a screen describe options in different scopes`
		);
	}

	return label;
}
