/**
 * A QR code: the encoder, and the two ways to draw one in cells.
 *
 * A device-pairing code, a one-time-password URI, a link to the docs for the
 * error that just printed. The thing a CLI wants here is a code somebody can
 * point a phone at, which makes this the one component in this package whose
 * correctness no test in it can establish -- see "What only a phone can settle"
 * below, and `scripts/terminal-probe.mjs --qrcode`.
 *
 * ```js
 * import { qrcode } from '@ttylabs/sigil/components';
 *
 * console.log(qrcode('https://example.com'));
 * console.log(qrcode('https://example.com', { form: 'large' }));
 * ```
 *
 * ## The encoder is written here, and that is the hard constraint rather than a
 * preference
 *
 * `@ttylabs/sigil` has zero production dependencies, so `qrcode` and every
 * package like it is out: mode selection, the bit stream, Reed-Solomon over
 * GF(256), version and error-correction selection, the function patterns, the
 * eight data masks and the penalty score that picks one, and the BCH-coded
 * format and version information are all here. That is the same answer ANSI
 * handling, text wrapping, `which`, dotenv, the East Asian Width table and the
 * `.flf` parser each got.
 *
 * `encodeQr()` is a pure function of a string and some options, and imports
 * nothing from the element tree, the renderer or the cascade -- which is what
 * separability actually buys: a matrix is produced and checked with no component
 * runtime anywhere, and its tests are a grid of `#` and `.`.
 *
 * It is **not** a subpath of its own, for `parseFlf()`'s reason: a
 * `@ttylabs/sigil/qrcode` entry is permanent API surface whose only consumer is
 * the component beside it, and the property that makes the encoder testable is
 * that it is a pure function rather than that it sits behind a module boundary.
 * One file is also one `sigil add` entry, so ejecting the component takes the
 * encoder with it, which is what somebody ejecting it wants.
 *
 * ## A module has to come out square, which is what decides the two forms
 *
 * A terminal cell is about twice as tall as it is wide, so a module drawn as one
 * cell is a module twice as tall as it is wide -- and a scanner locating a
 * 21-module symbol stretched 1:2 is being asked to do something it was not
 * designed for. Both forms here are about square:
 *
 * - **`compact`**, which is the one the ticket describes: a half block per cell,
 *   so one cell holds two vertically stacked modules and a module is one column
 *   by half a cell. A version 1 symbol with its quiet zone is 29 columns by 15
 *   rows.
 * - **`large`**: two columns per module and one row, so a module is two columns
 *   by one cell. The same symbol is 58 columns by 29 rows -- twice the size on
 *   both axes, which is what "can we offer a large version too?" was asking for,
 *   and what to reach for when a scanner is struggling or the font is small.
 *
 * One column by one row is the obvious third form and it is the squashed one, so
 * it is not offered. Braille is the obvious fourth and is the interesting
 * refusal: a `Dots` cell is 2x4, so a module would be half a column by a quarter
 * of a cell, which is square on both axes and four times smaller again -- and a
 * braille cell does not *tile*. The dots are discrete, with gaps about as wide as
 * the dots themselves, so a dark region is a dotted texture rather than a module
 * and a camera samples the gap as often as the dot. `Dots` is monochrome besides,
 * which is one foreground for a cell that may hold eight modules of two colours.
 * The probe draws one anyway, labelled as the form that is expected *not* to
 * scan, because an unfalsifiable refusal is worth less than one somebody can
 * check.
 *
 * ## One `text` element, and no `raw`
 *
 * The rows are joined with newlines into one `nowrap` `text`, which is
 * `largeTextView()`'s shape and for its reasons: a `nowrap` text is one line per
 * newline whatever room it was offered, so the intrinsic size falls out, the
 * measurement is cached per resolved style, and there is no second implementation
 * of what a string measures to.
 *
 * `raw` is what a grid of cells with a colour each wants, and the glyph set is
 * exactly why this is not that. `▀` fills its upper half with the
 * *foreground* and its lower half with the *background*, so the four glyphs
 * `█ ▀ ▄` and a space spell all four combinations of two modules
 * out of **one** foreground and one background -- which the cascade supplies once
 * for the whole code. A QR has two colours in it, not one per cell, so what a
 * `raw` would buy is a colour per half-cell that nothing here needs; it would
 * also make the code uncopyable, since `selectable` defaults to false on a `raw`
 * and a QR pasted into a chat window as block characters is a reasonable thing to
 * want. `Pixels` is the same answer one layer down: it is 1x2 half blocks with a
 * colour per half, which is the compact form with the per-half colour this does
 * not need.
 *
 * ## The quiet zone is in the matrix, not in padding
 *
 * The spec's four light modules on every side are what a scanner locates the
 * symbol against, and a code drawn flush against a text run is frequently
 * unscannable. They are emitted as rows and columns of light modules rather than
 * as CSS padding, and that is structural rather than tidy: padding is in *cells*,
 * and in the compact form one cell is two modules vertically and one
 * horizontally, so four modules of quiet zone is two cells of padding on one axis
 * and four on the other -- a per-form asymmetry that a theme writing
 * `.sigil-qrcode { padding: 1 }` would silently change, which is the number this
 * file already records a theme must never be able to move. In the matrix it
 * cannot be lost: a theme's padding can only add to it.
 *
 * The compact form pads an odd row count by one more light row, which is the
 * bottom quiet zone going from four modules to five. Four is a minimum in the
 * spec, so that is legal; the alternative is a last cell whose lower half is
 * neither light nor dark.
 *
 * ## Which colour is which, and what a QR code is at colour level 0
 *
 * A scanner expects dark modules on a light background. A terminal is usually
 * light-on-dark, so "dark module = the terminal's foreground" is an *inverted*
 * code -- which most modern readers take and some do not. So at any colour level
 * above zero the component paints its own two colours, `.sigil-qrcode-body`
 * carries `color: black; background-color: white`, and the dark modules are the
 * drawn glyph. Palette indices rather than hex, which is the rule a named colour
 * here already follows: the basic sixteen are whatever the user's terminal theme
 * says they are, and a theme has to render text in both of them.
 *
 * At level 0 every colour and attribute is dropped -- a pipe and `NO_COLOR` are
 * the two ways there -- so painting is not available and the only two colours
 * left are the terminal's own. The answer is to **draw the other modules**:
 * whichever module colour matches the foreground is the one that gets a glyph, so
 * on a dark terminal the light modules are drawn as blocks and the dark ones are
 * left as background. That is one expression -- `colorLevel === 0 && scheme ===
 * 'dark'` -- and it means a piped code is still correctly polarised, in block
 * characters, with not one escape sequence in it. The quiet zone comes out as a
 * border of drawn blocks there, which is what makes it light on screen.
 *
 * `invert` overrides it, for a caller who knows something about the destination
 * that the level and the scheme do not say.
 *
 * ## What only a phone can settle
 *
 * `encodeQr()`'s matrix is checked against reference vectors in
 * `test/components/qrcode-vectors.ts`, which were generated by a third-party
 * encoder rather than by this one -- a decoder written beside the encoder from
 * the same mental model passes green forever on an assumption wrong in both, and
 * this repository already records that failure for the canvas diff's model
 * terminal. What no test here can say is whether *your* terminal's font draws a
 * contiguous half block, whether your colours have the contrast a camera needs,
 * and whether your scanner reads the result. That is
 * `scripts/terminal-probe.mjs --qrcode`, which prints both forms at both
 * polarities and says in as many words that the check is to scan them with a
 * phone.
 *
 * ## What is deliberately out
 *
 * **Kanji mode.** It encodes a Shift-JIS double byte in 13 bits, which is a
 * second character encoding table for a mode that only pays for text that is
 * entirely Japanese -- and every modern reader expects UTF-8 in byte mode, which
 * is what a `日本語` payload gets here. The byte-mode answer is one version
 * larger for such a string and is the one that round-trips.
 *
 * **ECI and a declared charset.** Byte mode's bytes are UTF-8 with no ECI header,
 * which is what every library writes by default and what every reader assumes.
 * An ECI header declaring UTF-8 is legal, is ignored by some readers, and is
 * refused by a few.
 *
 * **Structured append.** Splitting a payload across several symbols needs a way
 * to draw several codes and a reader that reassembles them, and nothing has asked.
 *
 * **A mounted form.** A QR code does not animate: it is a thing printed into a
 * log beside everything else, which is why the facade is a string the way
 * `table()` and `largeText()` are.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { type ColorScheme, DEFAULT_MEDIA, schemeFromEnv } from '../style/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';

/** How much of a symbol may be lost and still read: about 7, 15, 25 and 30 per cent. */
export type QrEcc = 'L' | 'M' | 'Q' | 'H';

/** How a segment's characters are packed into bits. */
export type QrMode = 'numeric' | 'alphanumeric' | 'byte';

/** The highest version there is, which is 177 modules square. */
const MAX_VERSION = 40;

/**
 * How many error-correction codewords each block carries, by version.
 *
 * Index 0 is unused so that `[version]` reads as the version. These two tables
 * and nothing else are the spec's capacity data: everything else -- how many
 * codewords a version holds, how many characters a mode fits -- is derived from
 * the symbol's own geometry below, which is 80 numbers rather than the 160-entry
 * capacity table the same information is usually written as.
 */
const ECC_PER_BLOCK: Readonly<Record<QrEcc, readonly number[]>> = {
	H: [
		0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	L: [
		0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
		30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	M: [
		0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
		28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	],
	Q: [
		0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
		30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
};

/** How many error-correction blocks a symbol is split into, by version. */
const BLOCKS: Readonly<Record<QrEcc, readonly number[]>> = {
	H: [
		0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
		40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
	],
	L: [
		0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
		15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
	],
	M: [
		0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
		26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
	],
	Q: [
		0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
		34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
	],
};

/** The two format-information bits each level is written as. */
const ECC_BITS: Readonly<Record<QrEcc, number>> = { H: 2, L: 1, M: 0, Q: 3 };

/** The four-bit mode indicator each mode is written as. */
const MODE_BITS: Readonly<Record<QrMode, number>> = { alphanumeric: 2, byte: 4, numeric: 1 };

/**
 * How many bits a mode's character count is written in, by version band.
 *
 * The three entries are versions 1-9, 10-26 and 27-40, which is the spec's own
 * banding and the reason the version has to be chosen before the bit stream can
 * be built -- and the reason choosing it is a loop rather than arithmetic: a
 * payload that fits version 9 at a ten-bit count may not fit version 10 at a
 * twelve-bit one, so each version is asked about its own encoding.
 */
const COUNT_BITS: Readonly<Record<QrMode, readonly [number, number, number]>> = {
	alphanumeric: [9, 11, 13],
	byte: [8, 16, 16],
	numeric: [10, 12, 14],
};

/** The forty-five characters alphanumeric mode can spell, in the order it packs them. */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** A parsed, masked, finished symbol. */
export interface QrCode {
	/** Which error-correction level it carries. */
	readonly ecc: QrEcc;
	/** Which of the eight data masks was applied, 0 to 7. */
	readonly mask: number;
	/**
	 * The modules, `[y][x]`, true for dark.
	 *
	 * The **symbol** and not the quiet zone, which is what the spec calls the
	 * symbol and what every encoder reports: a version 1 code is 21 rows of 21.
	 * The quiet zone is the renderer's, for the reason this module's notes give.
	 */
	readonly modules: readonly (readonly boolean[])[];
	/** How the payload was packed. */
	readonly mode: QrMode;
	/** How many modules on a side, which is `version * 4 + 17`. */
	readonly size: number;
	/** The version, 1 to 40. */
	readonly version: number;
}

/* -------------------------------------------------------------------------- *
 * GF(256)
 * -------------------------------------------------------------------------- */

/**
 * `EXP[i]` is 2 to the `i` in GF(256), and `LOG[v]` is the inverse.
 *
 * The field is the spec's: modulo the primitive polynomial x^8 + x^4 + x^3 + x^2
 * + 1, which is 0x11D. Built once at module load rather than per encode, because
 * it is 512 bytes and the same for every code there has ever been.
 */
const EXP = new Uint8Array(255);
const LOG = new Uint8Array(256);

{
	let value = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = value;
		LOG[value] = i;
		// the shift, with the reduction when it carries out of eight bits
		value <<= 1;
		if ((value & 0x100) !== 0) {
			value ^= 0x11d;
		}
	}
}

/**
 * Two field elements multiplied.
 *
 * Zero is the one case the logarithms cannot answer -- `LOG[0]` is not a
 * logarithm -- so it is answered before them.
 *
 * @param a - One element.
 * @param b - The other.
 * @returns The product.
 */
function multiply(a: number, b: number): number {
	if (a === 0 || b === 0) {
		return 0;
	}
	return EXP[(LOG[a] + LOG[b]) % 255];
}

/**
 * The Reed-Solomon generator polynomial for a number of ECC codewords.
 *
 * The product of `(x - 2^i)` for `i` from zero, which the spec writes out per
 * block size and which is one line of arithmetic instead. Returned
 * highest-degree-last, so `[i]` lines up with the divisor loop below.
 *
 * @param degree - How many ECC codewords.
 * @returns The coefficients, without the leading 1.
 */
function generator(degree: number): Uint8Array {
	const result = new Uint8Array(degree);
	result[degree - 1] = 1;

	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = multiply(result[j], root);
			if (j + 1 < degree) {
				result[j] ^= result[j + 1];
			}
		}
		root = multiply(root, 2);
	}

	return result;
}

/**
 * The ECC codewords for one block.
 *
 * Polynomial long division of the data by the generator, in GF(256), which is
 * the remainder -- so a block's data followed by its remainder is divisible by
 * the generator, and that is the whole of what a decoder checks.
 *
 * @param data - The block's data codewords.
 * @param degree - How many ECC codewords to produce.
 * @returns The remainder.
 */
function remainder(data: Uint8Array, degree: number): Uint8Array {
	const gen = generator(degree);
	const result = new Uint8Array(degree);

	for (const byte of data) {
		const factor = byte ^ (result[0] ?? 0);
		result.copyWithin(0, 1);
		result[degree - 1] = 0;
		for (let i = 0; i < degree; i++) {
			result[i] ^= multiply(gen[i], factor);
		}
	}

	return result;
}

/* -------------------------------------------------------------------------- *
 * Geometry, and what a version holds
 * -------------------------------------------------------------------------- */

/**
 * Where the alignment patterns' centres sit, for a version.
 *
 * The spec tabulates these and they are derivable: the first is always column
 * six, the last is always seven in from the far edge, and the rest are spread
 * evenly between them on an even step. Version 32 is the one the formula misses
 * -- its own step is 26 rather than the 28 the division comes to -- which is a
 * wart in the spec rather than in the arithmetic, and is why it is named.
 *
 * @param version - 1 to 40.
 * @returns The centres, ascending. Empty for version 1, which has none.
 */
function alignmentCentres(version: number): number[] {
	if (version === 1) {
		return [];
	}

	const count = Math.floor(version / 7) + 2;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
	const result = [6];

	for (let pos = version * 4 + 10; result.length < count; pos -= step) {
		result.splice(1, 0, pos);
	}

	return result;
}

/**
 * How many modules a version has left for data and ECC, before any of it is
 * written.
 *
 * The square, less the three finders and their separators, the two timing
 * patterns, the format information, the alignment patterns, and -- from version
 * seven -- the version information. Derived rather than tabulated because it is
 * a fact about the geometry above: a table of it is a second statement of
 * `alignmentCentres()` that can disagree with it.
 *
 * @param version - 1 to 40.
 * @returns The module count.
 */
function rawModules(version: number): number {
	let result = (16 * version + 128) * version + 64;

	if (version >= 2) {
		const count = Math.floor(version / 7) + 2;
		// each alignment pattern is 25 modules, less the 10 the timing pattern
		// already counted for the ones that sit on it, less the 55 the three
		// finders already counted for the three corners that have none
		result -= (25 * count - 10) * count - 55;
		if (version >= 7) {
			result -= 36;
		}
	}

	return result;
}

/**
 * How many data codewords a version and level hold.
 *
 * @param version - 1 to 40.
 * @param ecc - The level.
 * @returns The count.
 */
function dataCodewords(version: number, ecc: QrEcc): number {
	return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[ecc][version] * BLOCKS[ecc][version];
}

/** Which of the three count-indicator bands a version is in. */
function band(version: number): 0 | 1 | 2 {
	return version <= 9 ? 0 : version <= 26 ? 1 : 2;
}

/* -------------------------------------------------------------------------- *
 * The payload
 * -------------------------------------------------------------------------- */

/** The narrowest mode that can spell every character of a string. */
function modeFor(value: string): QrMode {
	if (/^\d*$/.test(value)) {
		return 'numeric';
	}
	// the forty-five alphanumeric characters, written as a class rather than
	// checked against `ALPHANUMERIC` so that a reader can see the set is the
	// digits, the upper-case letters, and nine punctuation marks
	if (/^[\dA-Z $%*+\-./:]*$/.test(value)) {
		return 'alphanumeric';
	}
	return 'byte';
}

/**
 * How many bits a payload takes in a mode, not counting the header.
 *
 * @param value - The payload.
 * @param mode - The mode.
 * @param bytes - The UTF-8 bytes, for byte mode.
 * @returns The bit count.
 */
function payloadBits(value: string, mode: QrMode, bytes: Uint8Array): number {
	if (mode === 'numeric') {
		// three digits in ten bits, and the remainder in four or seven
		const groups = Math.floor(value.length / 3);
		const left = value.length % 3;
		return groups * 10 + (left === 0 ? 0 : left * 3 + 1);
	}
	if (mode === 'alphanumeric') {
		// two characters in eleven bits, and a leftover one in six
		return Math.floor(value.length / 2) * 11 + (value.length % 2) * 6;
	}
	return bytes.length * 8;
}

/** How many characters a mode's count indicator is counting. */
function charCount(value: string, mode: QrMode, bytes: Uint8Array): number {
	return mode === 'byte' ? bytes.length : value.length;
}

/** A growable list of bits, as 0 and 1. */
type Bits = number[];

/**
 * Appends a value's low `count` bits, most significant first.
 *
 * @param bits - The buffer.
 * @param value - The value.
 * @param count - How many bits.
 */
function push(bits: Bits, value: number, count: number): void {
	for (let i = count - 1; i >= 0; i--) {
		bits.push((value >>> i) & 1);
	}
}

/**
 * The payload's own bits, in a mode.
 *
 * @param bits - The buffer.
 * @param value - The payload.
 * @param mode - The mode.
 * @param bytes - The UTF-8 bytes, for byte mode.
 */
function pushPayload(bits: Bits, value: string, mode: QrMode, bytes: Uint8Array): void {
	if (mode === 'numeric') {
		for (let i = 0; i < value.length; i += 3) {
			const group = value.slice(i, i + 3);
			push(bits, Number(group), group.length * 3 + 1);
		}
		return;
	}

	if (mode === 'alphanumeric') {
		for (let i = 0; i < value.length; i += 2) {
			const high = ALPHANUMERIC.indexOf(value[i]);
			if (i + 1 < value.length) {
				push(bits, high * 45 + ALPHANUMERIC.indexOf(value[i + 1]), 11);
			} else {
				push(bits, high, 6);
			}
		}
		return;
	}

	for (const byte of bytes) {
		push(bits, byte, 8);
	}
}

/**
 * The data codewords for a payload at a version and level, padded to capacity.
 *
 * The terminator is up to four zero bits rather than always four, because a
 * payload that exactly fills its capacity has no room for them -- the spec says
 * the terminator is shortened or omitted there, and a fixed four would push such
 * a payload into the next version for nothing. The pad bytes after it are
 * `0xEC 0x11` alternating, which is what the spec names.
 *
 * @param value - The payload.
 * @param mode - The mode.
 * @param bytes - The UTF-8 bytes, for byte mode.
 * @param version - 1 to 40.
 * @param ecc - The level.
 * @returns The codewords.
 */
function codewordsFor(
	value: string,
	mode: QrMode,
	bytes: Uint8Array,
	version: number,
	ecc: QrEcc
): Uint8Array {
	const capacity = dataCodewords(version, ecc) * 8;
	const bits: Bits = [];

	push(bits, MODE_BITS[mode], 4);
	push(bits, charCount(value, mode, bytes), COUNT_BITS[mode][band(version)]);
	pushPayload(bits, value, mode, bytes);

	// the spec's rule, and a sabotage of it is *equivalent* rather than caught, so
	// it says so here: the four bits a full payload has no room for are zeros, and
	// the loop below writes them past the end of a `Uint8Array`, which drops them
	// -- so the bytes agree either way. It stays because what the function means is
	// "the terminator is shortened at capacity" rather than "a typed array is
	// tolerant of an overflow", and the day the buffer stops being one is the day
	// that difference is a wrong codeword
	for (let i = 0; i < 4 && bits.length < capacity; i++) {
		bits.push(0);
	}
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}

	const result = new Uint8Array(capacity / 8);
	for (const [i, bit] of bits.entries()) {
		result[i >>> 3] |= bit << (7 - (i & 7));
	}
	for (let i = bits.length / 8, pad = 0xec; i < result.length; i++, pad ^= 0xfd) {
		result[i] = pad;
	}

	return result;
}

/**
 * The data and ECC codewords, interleaved as the spec orders them.
 *
 * A symbol is split into blocks of two sizes -- the short ones first -- and the
 * codewords are taken a column at a time across the blocks so that a burst of
 * damage is spread over every block rather than destroying one. The short
 * blocks have no codeword in the last data column, which is the one place the
 * walk has to skip.
 *
 * @param data - The data codewords.
 * @param version - 1 to 40.
 * @param ecc - The level.
 * @returns Every codeword the symbol carries, in the order it is written.
 */
function interleave(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
	const blockCount = BLOCKS[ecc][version];
	const eccLength = ECC_PER_BLOCK[ecc][version];
	const total = Math.floor(rawModules(version) / 8);
	const shortLength = Math.floor(total / blockCount) - eccLength;
	// how many of the blocks are the short ones
	const shortCount = blockCount - (total % blockCount);

	const blocks: Uint8Array[] = [];
	const checks: Uint8Array[] = [];

	for (let i = 0, at = 0; i < blockCount; i++) {
		const length = shortLength + (i < shortCount ? 0 : 1);
		const block = data.subarray(at, at + length);
		at += length;
		blocks.push(block);
		checks.push(remainder(block, eccLength));
	}

	const result = new Uint8Array(total);
	let out = 0;

	for (let column = 0; column <= shortLength; column++) {
		for (const [i, block] of blocks.entries()) {
			// the short blocks' missing last column, which is the whole of the
			// irregularity: every other column is present in every block
			if (column < shortLength || i >= shortCount) {
				result[out++] = block[column];
			}
		}
	}
	for (let column = 0; column < eccLength; column++) {
		for (const check of checks) {
			result[out++] = check[column];
		}
	}

	return result;
}

/* -------------------------------------------------------------------------- *
 * The matrix
 * -------------------------------------------------------------------------- */

/** A matrix being built: the modules, and which of them a mask may not touch. */
interface Grid {
	/** True where a function pattern or an information area has been written. */
	readonly fixed: boolean[][];
	/** True for dark. */
	readonly modules: boolean[][];
	/** Modules on a side. */
	readonly size: number;
}

/** An empty grid. */
function emptyGrid(size: number): Grid {
	return {
		fixed: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
		modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
		size,
	};
}

/**
 * Writes one module and marks it as a function pattern.
 *
 * Out of bounds is ignored rather than refused, because the separators and the
 * finders are written as rectangles that hang off the edge of the symbol by
 * design -- the alternative is three sets of bounds arithmetic at the call
 * sites, each of which can be wrong on its own.
 */
function fix(grid: Grid, x: number, y: number, dark: boolean): void {
	if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) {
		return;
	}
	grid.modules[y][x] = dark;
	grid.fixed[y][x] = true;
}

/** The three finders, their separators, the timing patterns and the dark module. */
function drawFunctionPatterns(grid: Grid, version: number): void {
	const size = grid.size;

	// the timing patterns: row six and column six, alternating from the finder's
	// own edge, which is what makes them line up with it
	for (let i = 0; i < size; i++) {
		const dark = i % 2 === 0;
		fix(grid, 6, i, dark);
		fix(grid, i, 6, dark);
	}

	// the three finders, each a 7x7 target with a one-module light separator
	// around it. The separator is written as the ring of the 9x9 so that the
	// corner cases fall off the edge rather than being enumerated
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4],
	]) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const reach = Math.max(Math.abs(dx), Math.abs(dy));
				fix(grid, cx + dx, cy + dy, reach !== 2 && reach <= 3);
			}
		}
	}

	// the alignment patterns: a 5x5 target at every pair of centres, except the
	// three pairs that would sit on a finder
	const centres = alignmentCentres(version);
	for (const [i, cy] of centres.entries()) {
		for (const [j, cx] of centres.entries()) {
			const corner =
				(i === 0 && j === 0) ||
				(i === 0 && j === centres.length - 1) ||
				(i === centres.length - 1 && j === 0);
			if (corner) {
				continue;
			}
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					fix(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
				}
			}
		}
	}

	// the information areas are reserved before the data is placed, so that the
	// zigzag skips them, and written afterwards once the mask is known
	drawFormat(grid, 'L', 0, true);
	if (version >= 7) {
		drawVersion(grid, version, true);
	}

	// and the dark module, which is one module that is always dark and is the
	// one piece of the format area that carries no information
	fix(grid, 8, size - 8, true);
}

/**
 * The fifteen format bits: two for the level, three for the mask, ten of BCH.
 *
 * BCH(15,5) over the generator 0x537, then exclusive-ored with 0x5412 -- which is
 * what stops the all-zero format, L with mask 0, being fifteen light modules a
 * scanner cannot locate.
 *
 * @param ecc - The level.
 * @param mask - 0 to 7.
 * @returns The bits, as a fifteen-bit value.
 */
function formatBits(ecc: QrEcc, mask: number): number {
	const data = (ECC_BITS[ecc] << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) {
		rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	}
	return ((data << 10) | rem) ^ 0x5412;
}

/**
 * The eighteen version bits: six for the version and twelve of BCH.
 *
 * BCH(18,6) over the generator 0x1f25, with no final exclusive-or -- the spec
 * has none here, because the smallest version that carries this is seven and
 * seven is not zero.
 *
 * @param version - 7 to 40.
 * @returns The bits, as an eighteen-bit value.
 */
function versionBits(version: number): number {
	let rem = version;
	for (let i = 0; i < 12; i++) {
		rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	}
	return (version << 12) | rem;
}

/**
 * Writes the format information, twice.
 *
 * Every symbol carries it in two places so that a symbol with one corner damaged
 * is still readable, and the two are written in opposite bit orders, which is
 * the spec's layout rather than anything derivable.
 *
 * @param grid - The grid.
 * @param ecc - The level.
 * @param mask - 0 to 7.
 * @param reserve - Whether this is the reservation pass, before the data.
 */
function drawFormat(grid: Grid, ecc: QrEcc, mask: number, reserve = false): void {
	const bits = reserve ? 0 : formatBits(ecc, mask);
	const size = grid.size;

	// the copy around the top-left finder, least significant bit first, skipping
	// the two modules row six and column six already own
	for (let i = 0; i <= 5; i++) {
		fix(grid, 8, i, ((bits >>> i) & 1) === 1);
	}
	fix(grid, 8, 7, ((bits >>> 6) & 1) === 1);
	fix(grid, 8, 8, ((bits >>> 7) & 1) === 1);
	fix(grid, 7, 8, ((bits >>> 8) & 1) === 1);
	for (let i = 9; i < 15; i++) {
		fix(grid, 14 - i, 8, ((bits >>> i) & 1) === 1);
	}

	// and the copy split between the other two finders
	for (let i = 0; i < 8; i++) {
		fix(grid, size - 1 - i, 8, ((bits >>> i) & 1) === 1);
	}
	for (let i = 8; i < 15; i++) {
		fix(grid, 8, size - 15 + i, ((bits >>> i) & 1) === 1);
	}
}

/**
 * Writes the version information, twice, for version seven and up.
 *
 * @param grid - The grid.
 * @param version - 7 to 40.
 * @param reserve - Whether this is the reservation pass, before the data.
 */
function drawVersion(grid: Grid, version: number, reserve = false): void {
	const bits = reserve ? 0 : versionBits(version);
	const size = grid.size;

	for (let i = 0; i < 18; i++) {
		const dark = ((bits >>> i) & 1) === 1;
		const a = Math.floor(i / 3);
		const b = (i % 3) + size - 11;
		// a 3x6 block below the top-right finder and its transpose to the right of
		// the bottom-left one
		fix(grid, b, a, dark);
		fix(grid, a, b, dark);
	}
}

/**
 * Writes the codewords into whatever modules are left.
 *
 * Two modules wide, upward then downward, from the right -- and column six is
 * skipped whole, because it is the vertical timing pattern. The last few modules
 * of a symbol are the remainder bits the spec leaves light.
 *
 * @param grid - The grid.
 * @param codewords - Every codeword, interleaved.
 */
function drawCodewords(grid: Grid, codewords: Uint8Array): void {
	const size = grid.size;
	let at = 0;

	for (let right = size - 1; right >= 1; right -= 2) {
		// the pair that would straddle the vertical timing pattern is shifted one
		// left, and the shift *carries*: the pairs after it are 3-2 and 1-0 rather
		// than 4-3 and 2-1. Written as an assignment to the loop variable for that
		// reason -- a local computed from `right` leaves column 0 unvisited and
		// column 4 visited twice, which is a symbol that differs from every other
		// encoder's in its last four columns and in nothing else. Caught by the
		// reference vectors, which is what they are for
		if (right === 6) {
			right = 5;
		}

		for (let step = 0; step < size; step++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				// which way this pair runs: the pairs alternate, counted from the
				// right-hand edge, so the shift above flips it for everything left
				// of the timing pattern -- which is the spec's layout and not a
				// consequence of the shift being written this way
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - step : step;

				if (!grid.fixed[y][x] && at < codewords.length * 8) {
					grid.modules[y][x] = ((codewords[at >>> 3] >>> (7 - (at & 7))) & 1) === 1;
					at++;
				}
			}
		}
	}
}

/** Whether a mask covers a module. */
function masked(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
}

/** Exclusive-ors a mask over every module a function pattern does not own. */
function applyMask(grid: Grid, mask: number): void {
	for (let y = 0; y < grid.size; y++) {
		for (let x = 0; x < grid.size; x++) {
			if (!grid.fixed[y][x] && masked(mask, x, y)) {
				grid.modules[y][x] = !grid.modules[y][x];
			}
		}
	}
}

/** The two eleven-module windows rule three counts, as the spec draws them. */
const FINDER_LIKE: readonly boolean[][] = [
	[true, false, true, true, true, false, true, false, false, false, false],
	[false, false, false, false, true, false, true, true, true, false, true],
];

/**
 * How bad a masked symbol looks, by the spec's four rules.
 *
 * Lower is better and the four are summed, so this is one number per mask and
 * the lowest wins. The weights are the spec's: 3, 3, 40 and 10.
 *
 * Rule three is the one worth reading twice. It is looking for the finder
 * pattern's own 1:1:3:1:1 ratio with four light modules on one side, which is
 * what a locating scanner is hunting for -- so a mask that puts one in the data
 * is a mask that gives a scanner a fourth corner to find. Both orientations are
 * counted at every position in both axes, which is the reading every encoder
 * takes and which is what makes the chosen mask agree with theirs.
 *
 * @param grid - The grid, masked.
 * @returns The score.
 */
function penalty(grid: Grid): number {
	const size = grid.size;
	let score = 0;

	// rule one: a run of five or more of one colour, in a row or a column
	for (const byRow of [true, false]) {
		for (let a = 0; a < size; a++) {
			let run = 1;
			let last = byRow ? grid.modules[a][0] : grid.modules[0][a];
			for (let b = 1; b < size; b++) {
				const here = byRow ? grid.modules[a][b] : grid.modules[b][a];
				if (here === last) {
					run++;
				} else {
					if (run >= 5) {
						score += run - 2;
					}
					last = here;
					run = 1;
				}
			}
			if (run >= 5) {
				score += run - 2;
			}
		}
	}

	// rule two: every 2x2 block of one colour, which is three per block and
	// therefore three per *overlapping* position rather than per tiling
	for (let y = 0; y + 1 < size; y++) {
		for (let x = 0; x + 1 < size; x++) {
			const here = grid.modules[y][x];
			if (
				here === grid.modules[y][x + 1] &&
				here === grid.modules[y + 1][x] &&
				here === grid.modules[y + 1][x + 1]
			) {
				score += 3;
			}
		}
	}

	// rule three: a finder-like run
	for (let a = 0; a < size; a++) {
		for (let b = 0; b + 11 <= size; b++) {
			for (const window of FINDER_LIKE) {
				let rowHit = true;
				let columnHit = true;
				for (let i = 0; i < 11; i++) {
					if (grid.modules[a][b + i] !== window[i]) {
						rowHit = false;
					}
					if (grid.modules[b + i][a] !== window[i]) {
						columnHit = false;
					}
				}
				if (rowHit) {
					score += 40;
				}
				if (columnHit) {
					score += 40;
				}
			}
		}
	}

	// rule four: how far the proportion of dark modules is from half, in steps
	// of five per cent
	let dark = 0;
	for (const row of grid.modules) {
		for (const module of row) {
			if (module) {
				dark++;
			}
		}
	}
	const percent = (dark * 100) / (size * size);
	score += Math.floor(Math.abs(percent - 50) / 5) * 10;

	return score;
}

/* -------------------------------------------------------------------------- *
 * The encoder
 * -------------------------------------------------------------------------- */

export interface QrEncodeOptions {
	/**
	 * How much error correction, L through H. Defaults to `M`.
	 *
	 * `M` because it is the level every generator defaults to and the one the
	 * recovery it buys -- about fifteen per cent -- is worth its size for: `L` is
	 * a smaller code that a camera at an angle loses, and `H` is a much larger one
	 * for damage a screen does not have.
	 */
	ecc?: QrEcc;
	/**
	 * Which of the eight data masks to use. Defaults to the lowest-penalty one.
	 *
	 * Worth having for a test and for nothing else: the spec's penalty rules are
	 * what pick a mask that a scanner can read, and overriding them is asking for
	 * a code with a finder-like run in its data.
	 */
	mask?: number;
	/**
	 * The smallest version to use, 1 to 40. Defaults to 1.
	 *
	 * A floor rather than an answer: a payload that does not fit the version named
	 * here moves up until it does, because the alternative is refusing a code over
	 * a size preference. A caller who wants a bigger code than the payload needs
	 * -- so that a run of codes is all one size -- says so here.
	 */
	version?: number;
}

/**
 * Encodes a string as a QR symbol.
 *
 * The narrowest mode that can spell the whole string is chosen -- numeric,
 * then alphanumeric, then byte with UTF-8 -- and then the smallest version at or
 * above `version` that the payload fits at the chosen level.
 *
 * **Segments are deliberately not mixed, and what that costs is measured rather
 * than argued.** A payload split into a numeric run and a byte run can be a
 * version smaller than one segment of either, and `QR_SEGMENTS` in
 * `test/components/qrcode-vectors.ts` is the same payloads through a reference
 * encoder's own segment optimiser: 26 of 28 come out the same version either way,
 * including an https URL, an otpauth URI, a vCard and a network credential.
 * `tel:+15551234567` is one version larger here, and a label followed by a
 * hundred and twenty digits -- which is the worst case this shape has -- is four.
 * So the decision is free for what a CLI draws and is not free for a payload that
 * is mostly one long run of a narrower mode. The shape of the fix is a dynamic
 * program over the three modes per version, iterated over the versions because
 * the count indicator gets wider at 10 and 27; it wants a caller who has met the
 * second case before the surface for it is invented.
 *
 * @param value - The payload.
 * @param opts - The level, the version floor, and the mask.
 * @returns The symbol.
 * @throws If the string is empty, if it does not fit version 40, or if an option
 *   is out of range.
 */
export function encodeQr(value: string, opts: QrEncodeOptions = {}): QrCode {
	// a symbol of nothing is a symbol that scans to nothing, which is a worse
	// answer than an error: a caller interpolating a value that turned out to be
	// empty gets told where, rather than a code somebody photographs twice
	if (value === '') {
		throw new Error('A QR code needs something to encode');
	}

	const ecc = opts.ecc ?? 'M';
	if (!Object.hasOwn(ECC_BITS, ecc)) {
		throw new Error(`Unknown QR error-correction level "${ecc}": expected L, M, Q or H`);
	}

	const floor = opts.version ?? 1;
	if (!Number.isInteger(floor) || floor < 1 || floor > MAX_VERSION) {
		throw new Error(`QR version must be a whole number from 1 to ${MAX_VERSION}, got ${floor}`);
	}

	const mask = opts.mask;
	if (mask !== undefined && (!Number.isInteger(mask) || mask < 0 || mask > 7)) {
		throw new Error(`QR mask must be a whole number from 0 to 7, got ${mask}`);
	}

	const mode = modeFor(value);
	const bytes = mode === 'byte' ? new TextEncoder().encode(value) : new Uint8Array(0);

	// the version is a search rather than a division, because the count indicator
	// gets wider at versions 10 and 27: a payload that fits version 9 may not fit
	// version 10, so each one is asked about its own encoding
	let version = floor;
	while (
		version <= MAX_VERSION &&
		4 + COUNT_BITS[mode][band(version)] + payloadBits(value, mode, bytes) >
			dataCodewords(version, ecc) * 8
	) {
		version++;
	}
	if (version > MAX_VERSION) {
		const held = Math.floor((dataCodewords(MAX_VERSION, ecc) * 8 - 4 - 14) / 8);
		throw new Error(
			`This payload needs more than a version ${MAX_VERSION} QR code holds at level ${ecc}: ` +
				`${mode === 'byte' ? bytes.length : value.length} characters against about ${held} ` +
				`bytes. A lower error-correction level holds more.`
		);
	}

	const size = version * 4 + 17;
	const codewords = interleave(codewordsFor(value, mode, bytes, version, ecc), version, ecc);

	// every mask is a whole grid, because the mask is chosen by how the *finished*
	// symbol scores and the format information is part of what is scored
	let best: Grid | undefined;
	let chosen = 0;
	let score = Number.POSITIVE_INFINITY;

	for (const candidate of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
		const grid = emptyGrid(size);
		drawFunctionPatterns(grid, version);
		drawCodewords(grid, codewords);
		applyMask(grid, candidate);
		drawFormat(grid, ecc, candidate);
		if (version >= 7) {
			drawVersion(grid, version);
		}

		const here = penalty(grid);
		// strictly less, so that a tie keeps the lower-numbered mask -- which is
		// what every encoder does and is the only thing that makes the choice
		// reproducible
		if (here < score) {
			best = grid;
			chosen = candidate;
			score = here;
		}
	}

	// `best` is written on the first pass of a loop that always runs at least
	// once, and the assertion is the type's rather than a guard anybody can reach
	if (best === undefined) {
		throw new Error('No QR mask was evaluated');
	}

	return { ecc, mask: chosen, modules: best.modules, mode, size, version };
}

/* -------------------------------------------------------------------------- *
 * Drawing
 * -------------------------------------------------------------------------- */

/** How many cells a module gets. */
export type QrForm =
	/** A half block per cell: one column by half a cell per module. */
	| 'compact'
	/** Two columns by one cell per module. */
	| 'large';

/**
 * The four glyphs the compact form spells two modules with.
 *
 * `█` is a full block, `▀` an upper half and `▄` a lower half, and
 * what makes them enough is that the half blocks fill one half with the
 * foreground and the other with the background -- so two modules of two colours
 * are one cell of one foreground and one background, whichever way round they
 * are. Written as escapes rather than literally because `▀` and `▄` are
 * a glance apart in a diff and getting them the wrong way round draws a code
 * nothing can read.
 */
const UPPER = '▀';
const LOWER = '▄';
const BOTH = '█';
const NEITHER = ' ';

/** The spec's quiet zone, in modules, on every side. */
const QUIET = 4;

export interface QrLinesOptions {
	/** How many cells a module gets. Defaults to `compact`. */
	form?: QrForm;
	/**
	 * Whether the light modules are the drawn ones rather than the dark.
	 *
	 * Defaults to false, which is what a destination that can paint its own two
	 * colours wants. `qrcodeView()` is what works out when it should be true.
	 */
	invert?: boolean;
	/**
	 * How many light modules on every side. Defaults to the spec's four.
	 *
	 * A number of **modules** rather than of cells, so it is the same four on
	 * every side in both forms. Widening it is what to do when a scanner is
	 * struggling; `0` is for a caller whose surroundings are already light, and
	 * what it costs is the thing the quiet zone is for.
	 */
	quietZone?: number;
}

/**
 * Draws a symbol as lines of cells.
 *
 * Every line is the same length, which is what lets the body's background paint
 * a rectangle. The compact form pads an odd module-row count with one more light
 * row -- the spec's quiet zone is a minimum, so a fifth row on the bottom is
 * legal where a half-filled last cell is not.
 *
 * @param code - The symbol.
 * @param opts - The form, the polarity and the quiet zone.
 * @returns One string per line of cells.
 * @throws If the quiet zone is not a whole number of modules.
 */
export function qrLines(code: QrCode, opts: QrLinesOptions = {}): string[] {
	const quiet = opts.quietZone ?? QUIET;
	if (!Number.isInteger(quiet) || quiet < 0) {
		throw new Error(`A QR quiet zone must be a whole number of modules from 0, got ${quiet}`);
	}

	const form = opts.form ?? 'compact';
	const invert = opts.invert ?? false;
	const span = code.size + quiet * 2;

	/** Whether the module at a grid position is the one that gets a glyph. */
	const drawn = (x: number, y: number): boolean => {
		const inside = x >= quiet && y >= quiet && x < quiet + code.size && y < quiet + code.size;
		// outside the symbol is the quiet zone, which is light
		const dark = inside && code.modules[y - quiet][x - quiet];
		return dark !== invert;
	};

	if (form === 'large') {
		return Array.from({ length: span }, (_, y) => {
			let line = '';
			for (let x = 0; x < span; x++) {
				line += drawn(x, y) ? BOTH + BOTH : NEITHER + NEITHER;
			}
			return line;
		});
	}

	// one more light row where the count is odd, so that no cell holds half a
	// module. Reading past the grid is what `drawn()` already answers for, so the
	// extra row needs no case of its own -- only the row count does
	const rows = span + (span % 2);

	return Array.from({ length: rows / 2 }, (_, cell) => {
		let line = '';
		for (let x = 0; x < span; x++) {
			const upper = drawn(x, cell * 2);
			const lower = drawn(x, cell * 2 + 1);
			line += upper ? (lower ? BOTH : UPPER) : lower ? LOWER : NEITHER;
		}
		return line;
	});
}

export interface QrViewOptions extends StyledOptions, QrEncodeOptions, QrLinesOptions {}

/**
 * Whether the light modules are the ones to draw.
 *
 * One expression and one place that reads it: at any colour level above zero the
 * body paints its own black on white and the dark modules are drawn, and at level
 * zero there is nothing to paint with, so the drawn modules have to be the ones
 * whose colour the terminal's foreground already is. The scheme defaults the way
 * `themedCascade()` defaults it -- `SIGIL_COLOR_SCHEME`, then `COLORFGBG`, then
 * dark -- because the two are answering the same question about the same
 * destination and reading it twice is how they come to disagree.
 *
 * @param opts - The level, the scheme, and an explicit override.
 * @returns Whether to invert.
 */
function polarity(opts: QrViewOptions): boolean {
	if (opts.invert !== undefined) {
		return opts.invert;
	}

	const level = opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level;
	if (level > 0) {
		return false;
	}

	const scheme: ColorScheme = opts.colorScheme ?? schemeFromEnv() ?? DEFAULT_MEDIA.colorScheme;
	return scheme === 'dark';
}

/**
 * The code, as an element tree.
 *
 * One `nowrap` `text` of the lines, inside a box that carries the component
 * class. The colours are the sheet's: `.sigil-qrcode-body` is black on white,
 * which is what makes the light modules light rather than "whatever was behind
 * the code", and it is on the body rather than on the box because
 * `background-color` does not inherit.
 *
 * A caller putting this in a tree of their own has to pass the colour level their
 * renderer is at, because the level is what decides which modules are drawn and
 * this is not a mounted component with a media context to read.
 *
 * @param value - The payload.
 * @param opts - The encoding, the form, and the theme.
 * @returns The tree, how wide it wants to be, and the symbol it drew.
 */
export function qrcodeView(
	value: string,
	opts: QrViewOptions = {}
): { code: QrCode; element: Element; width: number } {
	const code = encodeQr(value, opts);
	const lines = qrLines(code, { ...opts, invert: polarity(opts) });

	return {
		code,
		element: box(
			{ class: 'sigil-qrcode' },
			textNode(lines.join('\n'), {
				class: 'sigil-qrcode-body',
				'white-space': 'nowrap',
			})
		),
		// every line is the same length and every glyph is one column wide -- which
		// is checked rather than assumed, since U+2588 is East Asian Width Ambiguous
		// and a width table that read it as two would draw a code twice as wide as
		// it measures
		width: lines[0]?.length ?? 1,
	};
}

export interface QrcodeOptions extends QrViewOptions {}

/**
 * Renders a string as a QR code.
 *
 * A facade over `qrcodeView()`, the way `table()` and `largeText()` are over
 * theirs: the tree is laid out and painted onto a grid of its own, and what comes
 * back is the grid read as lines.
 *
 * @param value - The payload.
 * @param opts - The encoding, the form, and the theme.
 * @returns The code, with no trailing newline.
 * @throws Whatever `encodeQr()` throws.
 */
export function qrcode(value: string, opts: QrcodeOptions = {}): string {
	const { element, width } = qrcodeView(value, opts);

	return renderToString(element, {
		cascade: themedCascade(opts),
		colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
		colorScheme: opts.colorScheme,
		width,
	});
}
