import { largeText, largeTextView, parseFlf, renderFiglet } from '@ttylabs/sigil/components';
import { box, renderToString } from '@ttylabs/sigil/element';
/**
 * Large text: a FIGlet renderer and the .flf format.
 *
 *   node demos/components/08-large-text.js
 *   node demos/components/08-large-text.js | cat     <- byte for byte the same run
 *   NO_COLOR=1 node demos/components/08-large-text.js
 *
 * A banner is static text, so there is nothing to repaint and a pipe gets exactly
 * what a terminal gets. The only thing that changes it is how much colour the
 * destination takes, which is what the last section is about.
 *
 * It reads no keys, so there is nothing here that needs a terminal on both sides.
 *
 * The font is `fonts/blocks.flf`, written for these demos. No third-party .flf is
 * committed anywhere in this repository and none is bundled in the runtime: the
 * notices inside the fonts the FIGlet distribution ships grant permission to
 * modify and say nothing about redistribution, and the look of a banner is the
 * app's choice anyway -- which is the whole reason the format is supported rather
 * than invented. There are hundreds of fonts written; `parseFlf()` reads one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const font = parseFlf(readFileSync(join(import.meta.dirname, 'fonts', 'blocks.flf'), 'utf8'));

console.log(largeText('sigil', { font }));

// what the header said. Worth printing because every one of these is a decision
// the renderer then has to make: the hardblank is the character that draws as a
// space and refuses to be smushed into, and the layout mode is how close adjacent
// characters sit
console.log(`
  height     ${font.height} rows
  hardblank  ${JSON.stringify(font.hardblank)}
  layout     ${font.layout.mode}
  rules      ${
		Object.entries(font.layout.rules)
			.filter(([, on]) => on)
			.map(([name]) => name)
			.join(', ') || 'none'
	}
  characters ${font.characters.size} of the 102 the format lists
  direction  ${font.direction}
`);

// the three answers to "how close do adjacent characters sit", which is the thing
// most fonts look wrong in the wrong one of. This font declares full width,
// because every glyph already carries a blank column of right bearing -- so the
// other two take that column away and the letters run into each other
for (const layout of ['full', 'kern', 'smush']) {
	console.log(`  layout: ${layout}${layout === font.layout.mode ? "   <- the font's own" : ''}`);
	console.log(largeText('ok', { font, layout }));
	console.log('');
}

// the word gap survives all three, and that is the hardblank doing its job: the
// space character is drawn out of hardblanks rather than out of spaces, so nothing
// slides into it. Drawn out of spaces it would collapse into its neighbours
console.log(`  a hardblank space, kerned:\n${largeText('hi ho', { font, layout: 'kern' })}\n`);

// a font is allowed to stop after ASCII 126, and this one does -- so the seven
// Deutsch characters the format lists next are not in it. A character the font
// does not have is left out rather than replaced by a guess at what its author
// would have drawn
console.log(`  "AÄB", where the font has no Ä:\n${largeText('AÄB', { font })}\n`);

// it is a node with an unusually tall intrinsic size and nothing above it knows
// that is what it is holding: this is an ordinary flex child inside an ordinary
// bordered box, measured and placed by the layout engine like any other
const { element, width } = largeTextView('2.0', { font });
console.log(
	renderToString(
		box(
			{
				'border-style': 'single',
				'flex-direction': 'column',
				'padding-left': 1,
				'padding-right': 1,
			},
			element
		),
		{ width: width + 4 }
	)
);
console.log('');

// and the rows on their own, with no element tree anywhere near them. `parseFlf()`
// and `renderFiglet()` are plain string functions, which is what makes the format
// testable against a character grid
console.log(`  renderFiglet() answers with rows:`);
for (const row of renderFiglet('hi', font)) {
	console.log(`  |${row}|`);
}

// no colour in the component's props, so a sheet is what colours it -- which is
// also what makes it themeable. `NO_COLOR=1` drops every sequence
console.log(`\n${largeText('done', { font, theme: '.sigil-large-text-body { color: cyan }' })}`);
