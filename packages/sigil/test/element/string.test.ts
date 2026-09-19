import { ATTR, DEFAULT_COLOR, palette } from '../../src/canvas/index.js';
import { box, paragraph, renderToLines, renderToString, text } from '../../src/element/index.js';
import { Cascade, parseStylesheet } from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Rendering a tree to a string.
 *
 * The end everything that produces text rather than frames goes through: the
 * table, the help screen, and anything else laid out by the layout engine and
 * read back as lines. What is asserted here is the part that is this module's --
 * what a line ends in, what is cut off it, and how wide the grid it was painted
 * into turned out to be. The layout itself has its own tests.
 */

const ESC = String.fromCharCode(0x1b);

/** A cascade over one sheet, so a test can say what something should look like. */
function sheets(css: string): Cascade {
	return new Cascade([parseStylesheet(css)]);
}

describe('renderToString()', () => {
	it('should lay a tree out and read it back', () => {
		const tree = box({ 'flex-direction': 'column' }, text('one'), text('two'));

		expect(renderToString(tree, { colorLevel: 0, width: 20 })).to.equal('one\ntwo');
	});

	it('should measure its own height when none is given', () => {
		const tree = box({ 'flex-direction': 'column' }, text('a'), text('b'), text('c'));

		expect(renderToLines(tree, { colorLevel: 0, width: 10 })).to.have.length(3);
	});

	it('should keep to a height it was given', () => {
		const tree = box({ 'flex-direction': 'column' }, text('a'), text('b'), text('c'));

		expect(renderToLines(tree, { colorLevel: 0, height: 2, width: 10 })).to.deep.equal(['a', 'b']);
	});

	// a line that ends in spaces copies wrong and takes more of the screen than
	// it shows
	it('should drop the blanks off the end of a line', () => {
		const tree = box({ 'flex-direction': 'row', width: 20 }, text('hi', { width: 10 }));

		expect(renderToString(tree, { colorLevel: 0, width: 20 })).to.equal('hi');
	});

	// a blank carrying a background is part of the picture, not padding
	it('should keep a trailing blank that shows something', () => {
		const tree = box({ 'flex-direction': 'row', width: 20 }, text('hi', { width: 4 }));

		const line = renderToString(tree, {
			cascade: sheets('text { background-color: blue }'),
			colorLevel: 1,
			width: 20,
		});

		expect(line).to.contain('hi  ');
	});

	// one line joined onto another, or written into a log beside something else,
	// must not carry its colour into what follows
	it('should end every line in the state it began in', () => {
		const tree = box({ 'flex-direction': 'column' }, text('red', { class: 'a' }), text('plain'));

		const [first, second] = renderToLines(tree, {
			cascade: sheets('.a { color: red }'),
			colorLevel: 1,
			width: 10,
		});

		expect(first).to.equal(`${ESC}[31mred${ESC}[0m`);
		expect(second).to.equal('plain');
	});

	// a paragraph is a row of one-word elements, so the gap between two of them
	// is an unpainted cell -- and closing the style at every space turned one dim
	// parenthetical into a sequence per word
	it('should not close a style over a blank that shows nothing', () => {
		const tree = paragraph([{ class: 'note', text: 'two dim words' }]);

		expect(
			renderToString(tree, { cascade: sheets('.note { dim: true }'), colorLevel: 1, width: 40 })
		).to.equal(`${ESC}[2mtwo dim words${ESC}[0m`);
	});

	// a flag name longer than the terminal is printed whole, on the rule that the
	// name surviving beats the line being tidy -- and a grid the width of the
	// screen has no columns to put it in
	it('should widen the grid to what did not fit', () => {
		const tree = box({}, text('--an-extremely-long-option-name', { 'white-space': 'nowrap' }));

		expect(renderToString(tree, { colorLevel: 0, width: 10 })).to.equal(
			'--an-extremely-long-option-name'
		);
	});

	// a row's intrinsic height is taken with every child offered the whole content
	// box while placement hands each one a share, so a block that wraps further
	// than it measured reaches past the rows reserved for it. The grid is sized by
	// what the layout came to rather than by what it asked for, so nothing is
	// lost -- the row it takes from its neighbour is the known bug this does not
	// close, and a declared width is the way round it
	it('should be as tall as the layout turned out to be', () => {
		const tree = box(
			{ 'flex-direction': 'column', 'row-gap': 1 },
			box(
				{ 'column-gap': 1, 'flex-direction': 'row' },
				text('label', { 'flex-shrink': 0, 'white-space': 'nowrap' }),
				paragraph(['one two three four five six seven'], { 'flex-basis': 0, 'flex-grow': 1 })
			),
			text('after')
		);

		expect(renderToLines(tree, { colorLevel: 0, width: 20 })).to.deep.equal([
			'label one two three',
			'      four five six',
			'      seven',
			'after',
		]);
	});

	// the same tree with the column said out loud, which is what help does: a
	// declared width is measured at the width it will be placed at, so the block
	// after it gets the row it was promised
	it('should reserve the right rows for a description told its width', () => {
		const tree = box(
			{ 'flex-direction': 'column', 'row-gap': 1 },
			box(
				{ 'column-gap': 1, 'flex-direction': 'row' },
				text('label', { 'flex-shrink': 0, 'white-space': 'nowrap' }),
				paragraph(['one two three four five six seven'], { 'flex-shrink': 0, width: 13 })
			),
			text('after')
		);

		expect(renderToLines(tree, { colorLevel: 0, width: 20 })).to.deep.equal([
			'label one two three',
			'      four five six',
			'      seven',
			'',
			'after',
		]);
	});

	// the sheets are the caller's, and a media context left behind would be the
	// next frame's answer to a question about a screen this render was not about
	it('should put the cascade back the way it found it', () => {
		const cascade = sheets('text { color: red }');
		cascade.media = { colorLevel: 3, height: 24, width: 80 };

		renderToString(text('x'), { cascade, colorLevel: 0, width: 5 });

		expect(cascade.media).to.deep.equal({ colorLevel: 3, height: 24, width: 80 });
	});

	// level 0 is plain text, attributes included, which is what the styler has
	// always meant by it
	it('should draw no styling at all at level 0', () => {
		const tree = text('loud', { class: 'a' });

		expect(
			renderToString(tree, {
				cascade: sheets('.a { color: red; font-weight: bold }'),
				colorLevel: 0,
				width: 10,
			})
		).to.equal('loud');
	});
});

describe('text-overflow', () => {
	const cut = (mode: string) =>
		renderToString(
			box({}, text('abcdefgh', { 'text-overflow': mode, 'white-space': 'nowrap', width: 4 })),
			{
				colorLevel: 0,
				width: 20,
			}
		);

	it('should cut at the end by default', () => {
		expect(cut('clip')).to.equal('abcd');
	});

	it('should mark where it cut', () => {
		expect(cut('ellipsis')).to.equal('abc…');
		expect(cut('ellipsis-start')).to.equal('…fgh');
		expect(cut('ellipsis-middle')).to.equal('ab…h');
	});

	it('should leave a line that fits alone', () => {
		const tree = box(
			{},
			text('abc', { 'text-overflow': 'ellipsis', 'white-space': 'nowrap', width: 8 })
		);

		expect(renderToString(tree, { colorLevel: 0, width: 20 })).to.equal('abc');
	});
});

describe('paragraph()', () => {
	it('should wrap its words like prose', () => {
		expect(
			renderToString(paragraph(['one two three four'], { width: 9 }), {
				colorLevel: 0,
				width: 20,
			})
		).to.equal('one two\nthree\nfour');
	});

	it('should style each run on its own', () => {
		const tree = paragraph([{ text: 'plain' }, { class: 'note', text: 'dim' }], { width: 20 });

		expect(
			renderToString(tree, { cascade: sheets('.note { dim: true }'), colorLevel: 1, width: 20 })
		).to.equal(`plain ${ESC}[2mdim${ESC}[0m`);
	});

	// `wrap()` breaks a word that cannot fit, and a paragraph that disagreed with
	// the wrapper about that would be a block wider than it was asked to be. What
	// does differ is what follows the break: a broken word is one item and an item
	// is a rectangle, so the next word starts on the line after it rather than
	// beside the last of its rows -- which is the same thing having no inline
	// layout costs everywhere else here
	it('should break a word too long for the line', () => {
		expect(
			renderToString(paragraph(['a supercalifragilistic b'], { width: 8 }), {
				colorLevel: 0,
				width: 8,
			})
		).to.equal('a\nsupercal\nifragili\nstic\nb');
	});

	it('should ignore a run with nothing in it', () => {
		expect(
			renderToString(paragraph(['a', '', '  ', 'b'], { width: 20 }), { colorLevel: 0, width: 20 })
		).to.equal('a b');
	});

	// the attributes that show on a space, which is what decides both whether a
	// trailing blank may be cut and whether one may be left in an open style
	it('should keep an underlined blank between two words', () => {
		const tree = paragraph([{ class: 'u', text: 'a b' }], { width: 20 });
		const line = renderToString(tree, {
			cascade: sheets('.u { text-decoration: underline }'),
			colorLevel: 1,
			width: 20,
		});

		// the space is written outside the underline rather than inside it, which
		// is the other half of the rule above: an underlined blank shows
		expect(line).to.equal(`${ESC}[4ma${ESC}[24m ${ESC}[4mb${ESC}[0m`);
	});
});

describe('the cell styles a resolved style paints with', () => {
	it('should be the attributes and the colours', () => {
		// pinned here because `renderToString()` is the shortest path from a
		// stylesheet to bytes, and these are the two halves of what a cell holds
		expect(ATTR.bold).to.be.a('number');
		expect(palette(1)).to.not.equal(DEFAULT_COLOR);
	});
});
