import { strip } from '../ansi/strip.js';
import { wideRanges } from './east-asian-width.js';

export { unicodeVersion, wideRanges } from './east-asian-width.js';

/**
 * Characters that print nothing and move the cursor nowhere.
 *
 * - `Mn` and `Me` are the marks that draw on top of the character before them:
 *   a combining acute, a variation selector, an enclosing keycap.
 * - `Cf` is the format characters -- the zero width space, the joiner, the
 *   bidi controls, the byte order mark.
 * - `Cc` is the C0 and C1 controls. A tab and a newline are in here, which is
 *   deliberate: neither has a width, they have an effect, and resolving that
 *   effect means knowing where on the line they are. Expand tabs and split
 *   lines before measuring.
 * - `Default_Ignorable_Code_Point` catches the rest, including the Hangul
 *   fillers and the tag characters, which fall into none of the categories
 *   above.
 *
 * These come from the runtime's own Unicode tables rather than from the
 * generated one next door, which is only needed for East Asian Width -- the one
 * property ECMAScript has no escape for.
 */
const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]$/u;

/**
 * A character that a terminal draws as an emoji by default, and therefore two
 * columns wide whatever its East Asian Width says.
 */
const emojiPresentation = /^\p{Emoji_Presentation}$/u;

/**
 * A character that can be drawn as an emoji when asked to be -- which the
 * presentation selector is what asks. It is a wider set than the one above and
 * includes the ASCII digits, `#`, and `*`, which is what makes a keycap
 * sequence two columns.
 */
const emoji = /^\p{Emoji}$/u;

/**
 * The Hangul jamo that draw inside the syllable they belong to: the medial
 * vowels and final consonants, in both the original block and Extended-B. A
 * leading consonant is Wide and carries the syllable's two columns; these add
 * nothing to it.
 *
 * They are not in any of the zero-width categories above and there is no
 * property escape that selects them -- their Grapheme_Cluster_Break value is
 * what says so, and ECMAScript exposes no such escape -- so they are listed.
 * This is the same special case every `wcwidth` carries.
 */
const hangulZeroWidth = [
	[0x1160, 0x11ff], // Hangul Jamo: medial vowels and final consonants
	[0xd7b0, 0xd7ff], // Hangul Jamo Extended-B: the same two, and unassigned tail
] as const;

/** Nothing outside printable ASCII, where one code unit is one column. */
const asciiOnly = /^[\x20-\x7E]*$/;

/** The emoji presentation selector, which asks for an emoji rendering. */
const VS16 = 0xfe0f;

let segmenter: Intl.Segmenter | undefined;

/**
 * How many columns a string occupies in a terminal.
 *
 * Three things make this more than `str.length`:
 *
 * - Escape sequences occupy nothing, so they are stripped first.
 * - A character is not a column. `Intl.Segmenter` splits the text into grapheme
 *   clusters -- one family emoji is eleven code units, one flag is four, and
 *   each is one cluster the terminal draws once.
 * - A cluster is not a column either. An East Asian character takes two, and so
 *   does anything drawn as an emoji.
 *
 * Measure one line at a time: a tab and a newline have an effect rather than a
 * width, and both count zero here.
 *
 * @param str - The string to measure.
 * @returns The number of columns.
 */
export function stringWidth(str: string): number {
	if (asciiOnly.test(str)) {
		// the overwhelmingly common case, and no segmentation can change it
		return str.length;
	}

	const text = strip(str);
	if (asciiOnly.test(text)) {
		return text.length;
	}

	let width = 0;
	for (const cluster of graphemes(text)) {
		width += graphemeWidth(cluster);
	}
	return width;
}

/**
 * Splits a string into grapheme clusters -- what a reader would call a
 * character, and what a terminal draws as one.
 *
 * This is what keeps a wrap from cutting a flag in half.
 *
 * It knows nothing about escape sequences, and it is not a way to walk styled
 * text: the clusters of `ESC[31ma` include `[`, `3`, `1`, and `m`, which are not
 * characters anything draws. Text with sequences in it has to have them split
 * out first -- which is the wrapper's job, because it needs them kept and put
 * back, not removed.
 *
 * @param str - The string to split.
 * @returns The clusters, in order.
 */
export function graphemes(str: string): string[] {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	const clusters: string[] = [];
	for (const { segment } of segmenter.segment(str)) {
		clusters.push(segment);
	}
	return clusters;
}

/**
 * How many columns one grapheme cluster occupies.
 *
 * There are two rules, and which one applies is the whole of it.
 *
 * An emoji cluster is two columns however many characters it is made of. That
 * is the one case where a cluster is not the sum of its parts: a four-person
 * family is four emoji and three joiners, and a terminal draws one glyph two
 * columns wide.
 *
 * Everything else is the sum. A cluster is a base plus what attaches to it, and
 * what attaches is usually invisible -- a combining accent, a virama, a
 * joiner -- so the sum is usually just the base. It is not always: a Devanagari
 * vowel sign is a spacing mark, and a terminal advances the cursor for it, so
 * `का` is two columns rather than one. Summing is also what gets a
 * cluster right when the base is *not* first, which happens with the Arabic and
 * Indic characters that prefix one.
 *
 * @param cluster - The cluster to measure. A string of more than one cluster is
 * measured as whichever one it starts with.
 * @returns The number of columns.
 */
export function graphemeWidth(cluster: string): number {
	const first = cluster.codePointAt(0);

	if (first === undefined) {
		return 0;
	}

	if (isEmoji(cluster, first)) {
		return 2;
	}

	let width = 0;
	for (const char of cluster) {
		width += charWidth(char.codePointAt(0)!);
	}
	return width;
}

/**
 * Whether a cluster is drawn as a single emoji glyph, which is two columns.
 *
 * Either the base is a character that is an emoji on its own -- and then
 * whatever follows it is a joiner, a skin tone, another emoji joined to it, or a
 * mark, none of which add a column -- or it is a character that becomes one when
 * the presentation selector asks it to.
 *
 * The selector has to come immediately after the base to be asking about the
 * base, which is what `U+00A9 U+0301 U+FE0F` is not: a copyright sign with an
 * accent on it, followed by a selector that selects nothing.
 *
 * @param cluster - The cluster to test.
 * @param first - Its first code point.
 * @returns `true` when the cluster is one emoji.
 */
function isEmoji(cluster: string, first: number): boolean {
	const base = String.fromCodePoint(first);

	if (emojiPresentation.test(base)) {
		return true;
	}

	return emoji.test(base) && cluster.codePointAt(base.length) === VS16;
}

/**
 * How many columns one code point occupies on its own.
 *
 * Callers measuring text want `stringWidth()`; this is the lookup underneath
 * it, and it knows nothing about the cluster a code point may belong to.
 *
 * @param codePoint - The code point to measure.
 * @returns 0, 1, or 2.
 */
export function charWidth(codePoint: number): number {
	// ASCII first: it is most of every string a CLI prints
	if (codePoint >= 0x20 && codePoint < 0x7f) {
		return 1;
	}

	const char = String.fromCodePoint(codePoint);

	if (zeroWidth.test(char)) {
		return 0;
	}

	for (const [start, end] of hangulZeroWidth) {
		if (codePoint >= start && codePoint <= end) {
			return 0;
		}
	}

	if (emojiPresentation.test(char) || isWide(codePoint)) {
		return 2;
	}

	return 1;
}

/**
 * Whether a code point's East Asian Width is Wide or Fullwidth, by binary
 * search over the generated ranges.
 *
 * @param codePoint - The code point to look up.
 * @returns `true` when it occupies two columns.
 */
function isWide(codePoint: number): boolean {
	let low = 0;
	let high = wideRanges.length / 2 - 1;

	while (low <= high) {
		const mid = (low + high) >> 1;
		const start = wideRanges[mid * 2]!;
		const end = wideRanges[mid * 2 + 1]!;

		if (codePoint < start) {
			high = mid - 1;
		} else if (codePoint > end) {
			low = mid + 1;
		} else {
			return true;
		}
	}

	return false;
}
