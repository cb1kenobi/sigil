/**
 * Hyperlinks, which a cell carries the way it carries a colour.
 *
 *   node demos/canvas/03-links.js
 *   node demos/canvas/03-links.js | cat     <- the same bytes, uninterpreted
 *
 * Ctrl-click or Cmd-click the underlined text. In a terminal that does not
 * implement OSC 8 you get the same words with no link and nothing broken, which
 * is why the underline and the colour are worth setting too: they are what says
 * "this is a link" when the link itself is invisible.
 *
 * `link` is a field on the style, not a region beside the grid, because that is
 * what OSC 8 is -- terminal state that applies to what is written after it until
 * it changes, exactly like bold. So it interns, compares and diffs with
 * everything else, and a cell still holds one integer.
 */
import { ATTR, createCanvas, palette } from '@ttylabs/sigil/canvas';

const WIDTH = 64;
const HEIGHT = 8;

const here = new URL('.', import.meta.url).href;

/** How a link looks when the terminal cannot make it one. */
const linked = (url) => ({ attrs: ATTR.underline, fg: palette(4), link: url });

const rows = [
	['chalk', '5.6.2', 'https://www.npmjs.com/package/chalk'],
	['picocolors', '1.1.1', 'https://www.npmjs.com/package/picocolors'],
	['kleur', '4.1.5', 'https://www.npmjs.com/package/kleur'],
];

const canvas = createCanvas({ width: WIDTH, height: HEIGHT });

canvas.paint((p) => {
	p.text(0, 0, 'dependencies', { attrs: ATTR.bold });

	rows.forEach(([name, version, url], i) => {
		const y = i + 2;
		p.text(2, y, name, linked(url));
		p.text(16, y, version, { fg: palette(8) });
	});

	// a path is the other thing worth linking: most terminals open file:// in
	// whatever the system has registered, which is usually the editor
	p.text(0, 6, 'declared in', { fg: palette(8) });
	p.text(12, 6, 'demos/canvas/03-links.js', linked(`${here}03-links.js`));
});

// rows first, then back to the top left: movement is relative and cannot scroll
process.stdout.write('\n'.repeat(HEIGHT));
process.stdout.write(`[${HEIGHT}A`);
const withLinks = canvas.present({ full: true });
process.stdout.write(withLinks.output);
process.stdout.write(`[${HEIGHT}B\r\n`);

// This line is not underlined and not a link. `\x1b[0m` does not close OSC 8 --
// SGR and OSC are separate state -- so the diff emits the closing sequence
// itself at the end of a frame. Without it, everything printed after the canvas
// would still be pointing at the last cell's URL
console.log('this line is not a link');
console.log();

// What the links cost. A link is part of the style, so it is emitted once per
// run rather than once per cell, the same as a colour
canvas.paint((p) => {
	p.text(0, 0, 'dependencies', { attrs: ATTR.bold });
	rows.forEach(([name, version], i) => {
		p.text(2, i + 2, name, { attrs: ATTR.underline, fg: palette(4) });
		p.text(16, i + 2, version, { fg: palette(8) });
	});
	p.text(0, 6, 'declared in', { fg: palette(8) });
	p.text(12, 6, 'demos/canvas/03-links.js', { attrs: ATTR.underline, fg: palette(4) });
});
const withoutLinks = canvas.present({ full: true });

console.log(`with links     ${String(withLinks.output.length).padStart(4)} bytes`);
console.log(`without them   ${String(withoutLinks.output.length).padStart(4)} bytes`);
console.log();

// A URL is usually built from something -- a package name, a branch, a path --
// and an OSC sequence runs until its terminator, so a control character inside
// one ends it early and everything after it reaches the terminal as commands.
// Refused rather than emitted
try {
	canvas.paint((p) => p.text(0, 0, 'x', { link: `https://example.dev; rm -rf /` }));
} catch (err) {
	console.log(`a link with a control character is refused:\n  ${err.message}`);
}
