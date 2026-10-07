import { strip } from '@ttylabs/sigil/ansi';
import { encodeQr, qrcode } from '@ttylabs/sigil/components';
import { stringWidth } from '@ttylabs/sigil/width';

/**
 * A QR code: the encoder, and the two ways to draw one in cells.
 *
 *   node demos/components/10-qrcode.js
 *   node demos/components/10-qrcode.js | cat     <- a different code, on purpose
 *   NO_COLOR=1 node demos/components/10-qrcode.js
 *   SIGIL_COLOR_SCHEME=light NO_COLOR=1 node demos/components/10-qrcode.js
 *
 * **The check is to scan one of these with a phone.** Everything a test can say
 * about this component it already says -- every matrix here is compared against a
 * reference encoder's, module for module -- and what no test can say is whether
 * your terminal's font draws a contiguous half block, whether your colours have
 * the contrast a camera needs, and whether your scanner reads the result. That
 * one needs a camera.
 *
 * Without a terminal it is the same component and a *different drawing*, which is
 * the one thing in this file worth knowing before running it. At colour level 0
 * -- a pipe, or NO_COLOR -- there is nothing to paint the two colours with, so the
 * component draws the other modules: whichever colour the terminal's foreground
 * already is becomes the dark half of the code. So a piped run is block
 * characters with not one escape sequence in it, correctly polarised for a dark
 * terminal, and `SIGIL_COLOR_SCHEME=light` flips it back.
 *
 * It reads no keys, so there is nothing here that needs a terminal on both sides.
 */

const url = 'https://github.com/cb1kenobi/sigil';

/**
 * How big a drawn code is, in cells.
 *
 * `String.length` is the wrong answer and is the obvious one: above colour level
 * 0 every line carries the SGR that paints the two colours, so a code's first
 * line is a dozen characters longer than it is columns wide -- and this demo
 * printed the character count for a round.
 * Stripping and then measuring display columns is what every other size in this
 * repository is measured through, for the same reason the table's own column
 * widths are.
 *
 * @param {string} drawn - What `qrcode()` answered.
 * @returns {string} The size, as columns by lines.
 */
function sizeOf(drawn) {
	const lines = drawn.split('\n');
	return `${stringWidth(strip(lines[0]))} columns by ${lines.length} lines`;
}

console.log(`
  Scan these. That is the only check that matters, and it is the one
  nothing in the test suite can make.

  ${url}
`);

// the compact form, which is the one the ticket described: a half block per cell,
// so one cell holds two vertically stacked modules and a module comes out one
// column by half a cell -- which on a terminal whose cells are about twice as
// tall as they are wide is about square
const compact = qrcode(url);
console.log(`  compact -- ${sizeOf(compact)}\n`);
console.log(compact);

// and the large one, which is two columns per module and one row: the same
// symbol, about square again, and twice the size on both axes. What to reach for
// when a scanner is struggling or the font is small
const large = qrcode(url, { form: 'large' });
console.log(`\n  large -- ${sizeOf(large)}\n`);
console.log(large);

// what the encoder chose, which is most of what there is to get wrong
const code = encodeQr(url);
console.log(`
  mode     ${code.mode}
  version  ${code.version}, which is ${code.size} modules square
  level    ${code.ecc}
  mask     ${code.mask} of the eight, chosen by the spec's penalty score
`);

// the four levels, so that what error correction costs in size is a thing on
// screen rather than a number in a table. H recovers about thirty per cent of a
// damaged symbol and is one version larger than L for this payload -- a screen is
// not damaged, which is why the default is M. The loop prints the real versions
// rather than a number in this comment, which is what the comment said wrongly
// for a commit
console.log('  what each error-correction level costs, for this payload:\n');
for (const ecc of ['L', 'M', 'Q', 'H']) {
	const one = encodeQr(url, { ecc });
	const drawn = qrcode(url, { ecc });
	console.log(
		`    ${ecc}  version ${String(one.version).padStart(2)}, ` +
			`${String(one.size).padStart(3)} modules square, ` +
			sizeOf(drawn)
	);
}

// the quiet zone, which is the thing most hand-rolled terminal QR renderers lose.
// Four light modules on every side is what a scanner locates the symbol against,
// and a code drawn flush against a text run is frequently unscannable -- so it is
// in the matrix rather than in padding, where a theme cannot take it away. The one
// below is drawn with **none**, and it is here to be the harder scan: the codes
// above have their quiet zone and this one does not
console.log(`
  and the same code with no quiet zone, which is the thing to try scanning
  second: a scanner that reads the one above and not this one is the quiet
  zone earning its place.
`);
console.log(qrcode(url, { quietZone: 0 }));

console.log(`
  Both forms hold the same symbol -- the compact one is the large one with
  its rows folded two to a cell. If one scans and the other does not, that
  is your terminal's font rather than the code: the half blocks have to
  meet, and some fonts draw them a pixel short at small sizes.

  scripts/terminal-probe.mjs --qrcode is the same claim with more of it,
  including the braille rendering this component deliberately does not
  offer and which is expected not to scan.
`);
