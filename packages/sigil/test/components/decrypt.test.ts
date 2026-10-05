import { strip } from '../../src/ansi/strip.js';
import {
	ASCII,
	CP437,
	createDecrypt,
	decrypt,
	decryptedFrame,
	type DecryptFrame,
	decryptFrameAt,
	type DecryptPlan,
	decryptPlan,
	decryptReveal,
	type DecryptState,
	decryptState,
	decryptView,
	type MaskAlphabet,
	type Random,
	seeded,
} from '../../src/components/decrypt.js';
import {
	arrange,
	box,
	createTree,
	type Element,
	raw,
	renderToString,
	resolveStyles,
	selectableAt,
	text as textNode,
	toDisplayText,
} from '../../src/element/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { graphemes, stringWidth } from '../../src/width/index.js';
import { truncate, type TruncateMode, wrap } from '../../src/wrap/index.js';
import { screenSetup, setup } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The decrypt effect.
 *
 * Everything about this component is random, so the assertions are over a seeded
 * generator or over one that answers a constant -- which is the whole reason the
 * randomness is an option. The arithmetic is asserted against `decryptPlan()` and
 * `decryptFrameAt()`, which are pure and need no renderer; what the screen does
 * with it is the facade's block at the end.
 */

/** Written as a code rather than as a byte, because source carries no raw ESC. */
const ESC = String.fromCharCode(0x1b);

/** The clusters this file leans on, each a thing a naive mask would get wrong. */
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const FLAG = '\u{1F1EC}\u{1F1E7}';
const ACUTE = '́';
const CJK = '日本語';
const SURROGATE = '\uD800';

/**
 * A mask alphabet whose glyphs appear in no text this file decrypts.
 *
 * Disjointness is what makes "has this cell resolved?" answerable by comparing
 * the frame to the text: with an overlapping alphabet a masked cell can draw the
 * very character it is hiding, and every assertion about reveal order would be
 * true by luck some fraction of the time.
 */
const MARKS: MaskAlphabet = { narrow: ['#'], wide: ['##'] };

/** A generator that always answers the same thing. */
const flat =
	(value: number): Random =>
	() =>
		value;

/**
 * A generator that answers each of a list in turn, then begins again.
 *
 * What makes a *mixed* frame assertable: with one fraction per cell the reveal
 * times are the ones the test named rather than a seed's, so a moment says exactly
 * which cells are still hidden. A seeded plan can only be read back.
 */
const cycle =
	(...values: number[]): Random =>
	() => {
		const value = values.shift() as number;
		values.push(value);
		return value;
	};

/**
 * Every moment worth asking about between zero and the end, and a little past.
 *
 * @param plan - The plan to sweep.
 * @returns The times, in order.
 */
function sweep(plan: DecryptPlan): number[] {
	const end = Math.max(plan.duration, 1);
	const times = [0];
	for (let i = 1; i <= 40; i++) {
		times.push((end * i) / 40);
	}
	times.push(end, end + 1, end * 2);
	return times;
}

describe('seeded()', () => {
	it('should reproduce a run', () => {
		const a = seeded(7);
		const b = seeded(7);
		const first = Array.from({ length: 50 }, () => a());

		expect(first).to.deep.equal(Array.from({ length: 50 }, () => b()));
	});

	it('should answer inside the unit interval', () => {
		const random = seeded(1234);
		for (let i = 0; i < 2000; i++) {
			const value = random();
			expect(value).to.be.at.least(0);
			expect(value).to.be.lessThan(1);
		}
	});

	// xorshift32 has no way out of zero, so a seed of zero would answer zero
	// forever -- which is a generator that masks every cell with the same glyph
	it('should not be stuck on a seed of zero', () => {
		const random = seeded(0);
		const drawn = new Set(Array.from({ length: 20 }, () => random()));

		expect(drawn.size).to.be.greaterThan(1);
		expect(drawn.has(0)).to.equal(false);
	});
});

describe('decryptPlan()', () => {
	it('should hide every non-whitespace cell', () => {
		const plan = decryptPlan('ab cd', { random: flat(0) });
		const cells = plan.lines[0] as readonly { cluster: string; hidden: boolean }[];

		expect(cells.map((cell) => cell.cluster)).to.deep.equal(['a', 'b', ' ', 'c', 'd']);
		expect(cells.map((cell) => cell.hidden)).to.deep.equal([true, true, false, true, true]);
	});

	// the single detail that makes the effect work: the shape of the text stays
	// legible while not one word of it is
	it.each([' ', '\t', ' ', '　', ' '])('should never hide %j', (space) => {
		const plan = decryptPlan(`a${space}b`, { random: flat(0) });
		const cells = plan.lines[0] ?? [];
		// a tab is a space by the time the plan holds one, because the plan
		// normalises through `toDisplayText()` -- so what is looked for is what a
		// cell can hold rather than what the caller typed
		const want = toDisplayText(space);
		const found = cells.find((cell) => cell.cluster === want);

		expect(found?.hidden, `${JSON.stringify(space)} was hidden`).to.equal(false);
	});

	// the width rule taken to its end: a mark on its own has no cell, so a
	// one-column glyph over it would *add* a column, which is the reflow the rule
	// exists to prevent
	it('should never hide a cluster that occupies no column', () => {
		const plan = decryptPlan(`${ACUTE}a`, { random: flat(0) });
		const cells = plan.lines[0] ?? [];

		expect(cells.map((cell) => [cell.cluster, cell.width, cell.hidden])).to.deep.equal([
			[ACUTE, 0, false],
			['a', 1, true],
		]);
	});

	it('should read a wide cluster as two columns', () => {
		const plan = decryptPlan(`${CJK}${FLAG}${FAMILY}`, { random: flat(0) });
		const cells = plan.lines[0] ?? [];

		expect(cells.map((cell) => cell.width)).to.deep.equal([2, 2, 2, 2, 2]);
		expect(cells.every((cell) => cell.hidden)).to.equal(true);
	});

	it('should split on newlines and keep every line', () => {
		const plan = decryptPlan('a\n\nb');

		expect(plan.lines.length).to.equal(3);
		expect((plan.lines[1] ?? []).length).to.equal(0);
	});

	it('should spread the reveal times over the window after the jumble', () => {
		const plan = decryptPlan('abcdefghij', { jumble: 100, random: seeded(3), reveal: 1000 });

		for (const cell of plan.lines[0] ?? []) {
			expect(cell.reveal).to.be.at.least(100);
			expect(cell.reveal).to.be.at.most(1100);
		}
		// and not all at one moment, which is what a generator stuck on one value
		// would produce and what the effect would read as a wipe rather than a reveal
		expect(new Set((plan.lines[0] ?? []).map((cell) => cell.reveal)).size).to.be.greaterThan(5);
	});

	it('should report the moment the last cell resolves as the duration', () => {
		const plan = decryptPlan('abcdef', { jumble: 10, random: seeded(9), reveal: 90 });
		const latest = Math.max(...(plan.lines[0] ?? []).map((cell) => cell.reveal));

		expect(plan.duration).to.equal(latest);
	});

	// a text with nothing to hide has nothing to wait for, which is also what makes
	// it cost no timer at all
	it.each(['', '   ', '\n\n', ACUTE])('should have no duration for %j', (text) => {
		expect(decryptPlan(text, { random: flat(0) }).duration).to.equal(0);
	});

	// a reveal time past the window is an animation that never finishes, and
	// `await decrypt(text)` would simply never resolve
	it.each([
		['above one', 2],
		['far above one', 1e9],
		['negative', -1],
		['not a number', Number.NaN],
		['infinite', Number.POSITIVE_INFINITY],
	])('should clamp a generator that answers %s', (_name, value) => {
		const plan = decryptPlan('abc', { jumble: 100, random: flat(value), reveal: 1000 });

		for (const cell of plan.lines[0] ?? []) {
			expect(cell.reveal).to.be.at.least(100);
			expect(cell.reveal).to.be.at.most(1100);
		}
		expect(Number.isFinite(plan.duration)).to.equal(true);
	});

	// the typewriter's own rule for its interval: `Infinity >= 0` is true, and an
	// infinite jumble is a promise nothing will ever settle
	it.each([
		['negative', -500],
		['infinite', Number.POSITIVE_INFINITY],
		['not a number', Number.NaN],
	])('should fall back to the defaults for a %s duration', (_name, value) => {
		const plan = decryptPlan('a', { jumble: value, random: flat(0), reveal: value });

		expect(plan.duration).to.equal(2000);
	});

	it('should take a duration of zero at its word', () => {
		expect(decryptPlan('abc', { jumble: 0, random: flat(0.5), reveal: 0 }).duration).to.equal(0);
	});

	// the styled-input decision, measured rather than asserted: an element's text
	// cannot carry a sequence, because `toDisplayText()` removes the ESC and leaves
	// `[31m` to be drawn as characters
	it('should take the escape sequences out', () => {
		const plan = decryptPlan(`${ESC}[31mred${ESC}[39m`, { random: flat(0) });

		expect(plan.text).to.equal('red');
		expect((plan.lines[0] ?? []).map((cell) => cell.cluster).join('')).to.equal('red');
	});

	it('should say what an ordinary text says', () => {
		// the two `raw` layers paint the plan's own cells, so what a cell holds has to
		// be what any other text in this library would draw: a tab is a space, because
		// the grid models no tab stops, and a stray control character is nothing. While
		// the view was one `text` element this was the element's answer and the plan
		// never had to carry it -- `a\tb` drew `a b` through `toDisplayText()` and the
		// plan's own `\t` of width zero was never read. It is read now, so the plan
		// normalises too, and the pairing below is what keeps the two agreeing
		const plan = decryptPlan(`a\tb\r${SURROGATE}`, { random: flat(0) });

		expect(plan.text).to.equal(`a b${SURROGATE}`);
		expect(plan.text).to.equal(toDisplayText(`a\tb\r${SURROGATE}`));
	});
});

describe('decryptFrameAt()', () => {
	it('should mask every non-whitespace cell at the start', () => {
		const plan = decryptPlan('ab cd', { random: flat(0) });
		const frame = decryptFrameAt(plan, 0, MARKS, flat(0));

		expect(frame.text).to.equal('## ##');
		expect(frame.masked).to.equal(true);
	});

	it('should resolve a cell at its time and not before', () => {
		const plan = decryptPlan('abcdefghijklmnop', { jumble: 10, random: seeded(5), reveal: 500 });
		const cells = plan.lines[0] ?? [];

		for (const at of sweep(plan)) {
			const shown = graphemes(decryptFrameAt(plan, at, MARKS, flat(0)).text);

			for (const [index, cell] of cells.entries()) {
				const resolved = shown[index] === cell.cluster;
				expect(resolved, `cell ${index} at ${at}ms: reveal is ${cell.reveal}`).to.equal(
					at >= cell.reveal
				);
			}
		}
	});

	it('should have resolved everything by the end', () => {
		const plan = decryptPlan('the launch codes', { random: seeded(11) });
		const frame = decryptFrameAt(plan, plan.duration, MARKS, flat(0));

		expect(frame.text).to.equal('the launch codes');
		expect(frame.masked).to.equal(false);
	});

	it.each([
		'',
		'a',
		'   ',
		'one two three',
		'two\nlines',
		'a\n\nb',
		CJK,
		`${CJK} ${FLAG} ${FAMILY}`,
		`${ACUTE}a`,
		SURROGATE,
		'a\tb',
		'a\r\nb',
		'x'.repeat(400),
	])('should end at exactly what it says: %j', (text) => {
		const plan = decryptPlan(text, { random: seeded(2) });

		// what it *says* rather than what it was handed, which is the same thing for
		// every input with no control character in it. It never was the raw argument:
		// the plan has always stripped escape sequences, and it now normalises a tab to
		// the space any other text draws for one. Against the function rather than a
		// literal, so the two cannot drift apart
		expect(decryptFrameAt(plan, plan.duration, CP437, seeded(4)).text).to.equal(
			toDisplayText(text)
		);
		expect(decryptFrameAt(plan, plan.duration, CP437, seeded(4)).masked).to.equal(false);
	});

	// the mask has to be as wide as what it hides, or the text reflows as it
	// decrypts and lands back where it started
	it.each([CJK, `${CJK} ${FLAG}`, `a${FAMILY}b`, `${CJK}\n${FLAG}`, 'plain ascii'])(
		'should never change how wide a line is: %j',
		(text) => {
			for (const alphabet of [CP437, ASCII, MARKS]) {
				const plan = decryptPlan(text, { random: seeded(13) });
				const real = plan.text.split('\n');

				for (const at of sweep(plan)) {
					const lines = decryptFrameAt(plan, at, alphabet, seeded(17)).text.split('\n');
					expect(lines.length).to.equal(real.length);
					for (const [index, line] of lines.entries()) {
						expect(stringWidth(line), `line ${index} at ${at}ms of ${text}`).to.equal(
							stringWidth(real[index] as string)
						);
					}
				}
			}
		}
	);

	it('should keep the whitespace exactly where it was', () => {
		const text = toDisplayText('  indented\n\tand a tab  ');
		const plan = decryptPlan(text, { random: seeded(21) });

		for (const at of sweep(plan)) {
			const shown = graphemes(decryptFrameAt(plan, at, MARKS, seeded(22)).text);
			const real = graphemes(text);

			for (const [index, cluster] of real.entries()) {
				if (/^\s$/.test(cluster)) {
					expect(shown[index], `${index} at ${at}ms`).to.equal(cluster);
				}
			}
		}
	});

	it('should draw only from the alphabet it was given', () => {
		const plan = decryptPlan('secret message', { random: seeded(31) });
		const allowed = new Set(ASCII.narrow);

		for (const cluster of graphemes(decryptFrameAt(plan, 0, ASCII, seeded(32)).text)) {
			if (cluster !== ' ') {
				expect(allowed.has(cluster), `${cluster} is not in ASCII.narrow`).to.equal(true);
			}
		}
	});

	// there is no printable ASCII character two columns wide, so the ASCII set
	// pairs them -- which is what makes it able to cover a wide cell at all
	it('should cover a wide cell with two narrow glyphs from the ASCII set', () => {
		const plan = decryptPlan(CJK, { random: flat(0) });
		const frame = decryptFrameAt(plan, 0, ASCII, flat(0));

		expect(stringWidth(frame.text)).to.equal(6);
		expect(frame.text).to.match(/^[\x21-\x7e]{6}$/);
	});

	it('should re-randomize a hidden cell on every call', () => {
		const plan = decryptPlan('x'.repeat(30), { random: seeded(41) });
		const random = seeded(42);
		const first = decryptFrameAt(plan, 0, CP437, random).text;
		const second = decryptFrameAt(plan, 0, CP437, random).text;

		expect(second).not.to.equal(first);
	});

	// an empty list makes the pick answer `undefined`, which reaches the screen as
	// the word rather than as a glyph
	it.each([
		['both halves', { narrow: [], wide: [] }],
		['the narrow half', { narrow: [], wide: ASCII.wide }],
		['the wide half', { narrow: ASCII.narrow, wide: [] }],
	])('should fall back to the default alphabet when %s is empty', (_name, alphabet) => {
		const plan = decryptPlan(`a${CJK}`, { random: flat(0) });
		const frame = decryptFrameAt(plan, 0, alphabet as MaskAlphabet, flat(0));

		expect(frame.text).not.to.match(/undefined/);
		expect(stringWidth(frame.text)).to.equal(7);
	});

	it.each([
		['zero', 0],
		['just under one', 1 - 1e-12],
		['exactly one', 1],
		['above one', 5],
		['negative', -5],
		['not a number', Number.NaN],
	])('should draw a real glyph from a generator that answers %s', (_name, value) => {
		const plan = decryptPlan(`a${CJK}`, { random: flat(0) });
		const frame = decryptFrameAt(plan, 0, CP437, flat(value));

		expect(frame.text).not.to.match(/undefined/);
		expect(stringWidth(frame.text)).to.equal(7);
	});

	// both lists are drawn from, and each entry is the width its half promises
	it.each([
		['CP437', CP437],
		['ASCII', ASCII],
	])('should hold only glyphs of the width %s promises', (_name, alphabet) => {
		expect(alphabet.narrow.length).to.be.greaterThan(0);
		expect(alphabet.wide.length).to.be.greaterThan(0);

		for (const glyph of alphabet.narrow) {
			expect(stringWidth(glyph), `narrow ${glyph}`).to.equal(1);
		}
		for (const glyph of alphabet.wide) {
			expect(stringWidth(glyph), `wide ${glyph}`).to.equal(2);
		}
	});

	// a repeat is drawn twice as often as its neighbours, which is a thumb on the
	// scale nobody put there on purpose -- and `ASCII.wide` shipped with one
	it.each([
		['CP437', CP437],
		['ASCII', ASCII],
	])('should repeat no glyph in %s', (_name, alphabet) => {
		for (const half of ['narrow', 'wide'] as const) {
			const list = alphabet[half];
			expect(new Set(list).size, `${half} repeats something`).to.equal(list.length);
		}
	});
});

describe('decryptState()', () => {
	// the state this component exists to protect is the text, so the first frame is
	// nothing rather than the plaintext: a tree built before the driver has run must
	// not be the one place it leaks
	it('should start with nothing on screen rather than with the text', () => {
		const state = decryptState('secret');

		expect(state.text.get()).to.equal('secret');
		expect(state.frame.get()).to.deep.equal({ lines: [[]], masked: false, text: '' });
	});
});

describe('decryptedFrame()', () => {
	it('should hide nothing and say so', () => {
		const frame = decryptedFrame('ab cd');

		expect(frame.masked).to.equal(false);
		expect(frame.text).to.equal('ab cd');
		expect(frame.lines).to.deep.equal([
			[
				{ hidden: false, text: 'a', width: 1 },
				{ hidden: false, text: 'b', width: 1 },
				{ hidden: false, text: ' ', width: 1 },
				{ hidden: false, text: 'c', width: 1 },
				{ hidden: false, text: 'd', width: 1 },
			],
		]);
	});

	it('should split on newlines and keep every line', () => {
		expect(decryptedFrame('a\n\nb').lines.map((cells) => cells.length)).to.deep.equal([1, 0, 1]);
	});

	it('should take the escape sequences out, as the plan does', () => {
		const frame = decryptedFrame(`${ESC}[31mred`);

		expect(frame.text).to.equal('red');
		expect(frame.lines[0]).to.have.length(3);
	});

	it('should read a wide cluster as two columns', () => {
		expect(decryptedFrame(CJK).lines[0]?.map((cell) => cell.width)).to.deep.equal([2, 2, 2]);
	});
});

describe('decryptView()', () => {
	/**
	 * Renders a tree over a state, with the framework sheet behind it.
	 *
	 * Stripped, because a worker's own colour level is not this file's subject: the
	 * tests below that are about the styling ask for a level by name.
	 *
	 * @param state - What the tree reads.
	 * @param width - The width to render at.
	 * @returns What it draws, with the styling taken off.
	 */
	function draw(state: DecryptState, width = 40): string {
		return strip(renderToString(decryptView(state), { cascade: themedCascade(), width }));
	}

	/** The same, over a frame rather than over a state somebody has to build. */
	function drawFrame(frame: DecryptFrame, width = 40): string {
		const state = decryptState('');
		state.frame.set(frame);
		return draw(state, width);
	}

	/**
	 * A frame part way through, built so that which cells have resolved is known.
	 *
	 * `cycle()` makes the reveal times the fractions it was given rather than a
	 * seed's, so a time names exactly which cells are still hidden -- which is what
	 * every assertion about the two layers needs and what a seeded plan cannot say
	 * without being read back.
	 *
	 * @param text - What to decrypt.
	 * @param fractions - One per hidden cell, in order, cycled.
	 * @param at - How far through, in milliseconds.
	 * @returns The frame.
	 */
	function part(text: string, fractions: number[], at: number): DecryptFrame {
		const plan = decryptPlan(text, { jumble: 0, random: cycle(...fractions), reveal: 100 });
		return decryptFrameAt(plan, at, MARKS, flat(0));
	}

	/**
	 * What is in effect at each drawn column of a one-line render.
	 *
	 * The SGR *parameters* rather than a substring, which is this repository's own
	 * rule -- and per column rather than for the whole line, because what this
	 * component now claims is that two cells of one row are drawn differently. The
	 * state it keeps is the three transitions these assertions need: a reset
	 * clears, `22` takes the faint off and `39` takes a foreground off.
	 *
	 * @param out - A rendered line, sequences and all.
	 * @returns One entry per drawn cluster.
	 */
	function columns(out: string): { params: Set<string>; text: string }[] {
		const cells: { params: Set<string>; text: string }[] = [];
		const open = new Set<string>();
		const pattern = new RegExp(`${ESC}\\[([\\d;]*)m`, 'g');
		let at = 0;

		for (const match of out.matchAll(pattern)) {
			for (const cluster of graphemes(out.slice(at, match.index))) {
				cells.push({ params: new Set(open), text: cluster });
			}
			at = match.index + match[0].length;
			for (const param of (match[1] as string).split(';')) {
				if (param === '0' || param === '') {
					open.clear();
				} else if (param === '22') {
					open.delete('2');
				} else if (param === '39') {
					for (const held of open) {
						if (/^(?:3\d|9\d)$/.test(held)) {
							open.delete(held);
						}
					}
				} else {
					open.add(param);
				}
			}
		}
		for (const cluster of graphemes(out.slice(at))) {
			cells.push({ params: new Set(open), text: cluster });
		}

		return cells;
	}

	it('should draw the frame rather than the text', () => {
		const state = decryptState('secret');
		state.frame.set(part('secret', [1], 0));

		expect(draw(state)).to.equal('######');
	});

	it('should keep the lines of a block', () => {
		expect(drawFrame(decryptedFrame('a\nb'))).to.equal('a\nb');
	});

	// the headline of this component's second pass: the cipher and the plaintext are
	// two elements over one rectangle, so each resolves its own style and a character
	// takes the resolved colour the moment it lands rather than when the last one does
	it('should colour a character as it lands rather than when the last one does', () => {
		const cascade = themedCascade({ colorLevel: 3, colorScheme: 'dark' });
		const state = decryptState('ab');
		// the first cell resolves at once and the second at the end of the window
		state.frame.set(part('ab', [0, 1], 0));

		const out = renderToString(decryptView(state), { cascade, colorLevel: 3, width: 40 });
		const cells = columns(out);

		expect(strip(out)).to.equal('a#');
		expect(cells.map((cell) => cell.text)).to.deep.equal(['a', '#']);
		// 2 is faint, which is what `dim` emits: on the cipher cell and on nothing else
		expect(cells[0]?.params.has('2'), 'the resolved cell is de-emphasised').to.equal(false);
		expect(cells[1]?.params.has('2'), 'the hidden cell is not de-emphasised').to.equal(true);
	});

	// `dim` is the one declaration whose legibility depends on which way the
	// background goes, so it carries a light half on `gray` -- the same rule and the
	// same remedy `.sigil-prompt-hint` and help's own note already have
	it('should de-emphasise without dim on a light terminal', () => {
		const frame = part('ab', [0, 1], 0);

		const at = (scheme: 'dark' | 'light'): { params: Set<string>; text: string }[] => {
			const state = decryptState('ab');
			state.frame.set(frame);
			return columns(
				renderToString(decryptView(state), {
					cascade: themedCascade({ colorLevel: 3, colorScheme: scheme }),
					colorLevel: 3,
					colorScheme: scheme,
					width: 40,
				})
			);
		};

		const dark = at('dark');
		const light = at('light');

		// 2 is faint; 90 is the foreground of palette 8, which a light theme has to
		// render text in and so renders dark
		expect(dark[1]?.params.has('2'), 'dark lost its dim').to.equal(true);
		expect(light[1]?.params.has('2'), 'light still emits faint').to.equal(false);
		expect(light[1]?.params.has('90'), 'light has no de-emphasis at all').to.equal(true);
		// and the resolved cell is left alone either way, which is what the light half
		// moving onto the cipher class is for
		expect(dark[0]?.params.size, 'dark styled the resolved cell').to.equal(0);
		expect(light[0]?.params.size, 'light styled the resolved cell').to.equal(0);
		// and the glyphs are the same either way: only how they are drawn moved
		expect(dark.map((cell) => cell.text)).to.deep.equal(light.map((cell) => cell.text));
	});

	// the attributes go at level 0 along with the colour, so what is left is the
	// characters changing -- which is the whole effect, and it is still per character
	it('should draw nothing but the characters at colour level 0', () => {
		const state = decryptState('ab');
		state.frame.set(part('ab', [0, 1], 0));

		const out = renderToString(decryptView(state), {
			cascade: themedCascade({ colorLevel: 0 }),
			colorLevel: 0,
			width: 40,
		});

		expect(out).to.equal('a#');
	});

	// `min-width: 0` rather than the automatic minimum, which is the widest word:
	// without it an over-long word keeps its full width and the cells past the canvas
	// edge are dropped rather than broken, which is a frame wider than the terminal it
	// was asked to fit. Measured: 34 columns in a 12-column render
	it('should break a word longer than the width it was given', () => {
		const out = drawFrame(decryptedFrame('supercalifragilisticexpialidocious'), 12);

		expect(out.split('\n').length).to.be.greaterThan(1);
		for (const line of out.split('\n')) {
			expect(stringWidth(line), `${line} is wider than the render`).to.be.at.most(12);
		}
	});

	// the component wraps its own cells, because a cell is not a cluster -- an ASCII
	// substitute for a wide character is two of them -- so there is nothing to map
	// `wrap()`'s answer back through. What it must not do is break somewhere else
	// from the rest of the library, which is a differential rather than a rule said
	// twice
	it('should wrap where the wrapper does', () => {
		for (const text of [
			'one two three four five',
			'    indented text here that goes on',
			'  lead  and  double  spaces  ',
			'supercalifragilisticexpialidocious and more',
			'x verylongwordhererightherenow',
			'a\nbb cc\n\nddd',
			'trailing space ',
		]) {
			for (const width of [1, 2, 4, 6, 8, 12, 20, 24, 40]) {
				// a line's trailing blanks are dropped by the renderer, so they are
				// dropped here too: `wrap()` leaves an indent on a line of its own where
				// the word after it could not fit, and a row of spaces and an empty row
				// are the same row on screen
				const wrapped = wrap(text, { width })
					.split('\n')
					.map((line) => line.replace(/\s+$/u, ''))
					.join('\n');

				expect(
					drawFrame(decryptedFrame(text), width),
					`${JSON.stringify(text)} at ${width}`
				).to.equal(wrapped);
			}
		}
	});

	// the invariant the whole component rests on, read at the one place the
	// one-element view broke it: an ASCII substitute is two characters and a text
	// element could break *between* them, so a masked block wrapped into a different
	// number of rows from the one it resolves to
	it('should not reflow as it decrypts', () => {
		for (const text of [CJK, `${CJK} ${FLAG}`, `a${FAMILY}b`, 'one two three']) {
			for (const width of [1, 2, 3, 4, 5, 6, 8, 40]) {
				const plan = decryptPlan(text, { random: seeded(13) });
				const shape = (frame: DecryptFrame): number[] =>
					drawFrame(frame, width)
						.split('\n')
						.map((line) => stringWidth(line));
				const resolved = shape(decryptFrameAt(plan, plan.duration, ASCII, seeded(17)));

				for (const at of sweep(plan)) {
					for (const alphabet of [CP437, ASCII, MARKS]) {
						expect(
							shape(decryptFrameAt(plan, at, alphabet, seeded(19))),
							`${JSON.stringify(text)} at ${width} columns, ${at}ms`
						).to.deep.equal(resolved);
					}
				}
			}
		}
	});

	// a negative claim about every input is not established by tracing the route you
	// had in mind, so the degenerate ones are walked rather than reasoned about: what
	// each one draws once resolved, and that a frame with *every* cell hidden draws
	// the same shape as one with none -- which is the no-reflow rule read off the
	// render rather than off the frame's text
	it.each([
		['empty', '', ''],
		['whitespace only', '   ', ''],
		['one character', 'a', 'a'],
		['all wide', CJK, CJK],
		['a ZWJ sequence', FAMILY, FAMILY],
		['a flag', FLAG, FLAG],
		['a lone surrogate', SURROGATE, SURROGATE],
		['a lone combining mark', ACUTE, ''],
		['a tab', 'a\tb', 'a b'],
		['CRLF', 'a\r\nb', 'a\nb'],
		['a blank line', 'a\n\nb', 'a\n\nb'],
		['wider than the render', 'x'.repeat(30), 'xxxxxxxxxxxx\nxxxxxxxxxxxx\nxxxxxx'],
	])('should draw %s', (_name, text, expected) => {
		expect(drawFrame(decryptedFrame(text), 12)).to.equal(expected);

		const plan = decryptPlan(text, { random: seeded(5) });
		const shape = (frame: DecryptFrame): number[] =>
			drawFrame(frame, 12)
				.split('\n')
				.map((line) => stringWidth(line));
		const resolved = shape(decryptedFrame(text));

		for (const at of sweep(plan)) {
			for (const alphabet of [CP437, ASCII, MARKS]) {
				expect(shape(decryptFrameAt(plan, at, alphabet, seeded(9))), `${at}ms`).to.deep.equal(
					resolved
				);
			}
		}
	});

	// a cell of no width has no column to draw in, which is the same answer the plan
	// already gives it by never hiding it. It is also what keeps a control character
	// away from the cell grid, which throws on one rather than dropping it.
	//
	// A tab is deliberately *not* in this table: it is the one control character with
	// a column, because `toDisplayText()` turns it into a space and the plan now
	// normalises through that -- see `should say what an ordinary text says`
	it.each([
		['a carriage return', 'a\rb', 'ab'],
		['a lone combining mark', `${ACUTE}a`, 'a'],
		['a bell', 'a\u0007b', 'ab'],
	])('should draw nothing for %s, which occupies no column', (_name, text, expected) => {
		expect(drawFrame(decryptedFrame(text))).to.equal(expected);
	});

	// a cell whose *mask* holds one is the only way a positive-width cell can, which
	// is a caller's own alphabet rather than anything this component produces -- and
	// a throw from inside paint takes the frame and the renderer with it
	it('should draw nothing for a mask glyph that is a control character', () => {
		const plan = decryptPlan('ab', { random: flat(0) });
		const frame = decryptFrameAt(plan, 0, { narrow: ['\u0007'], wide: ['\u0007\u0007'] }, flat(0));

		expect(frame.text).to.equal('\u0007\u0007');
		expect(drawFrame(frame)).to.equal('');
	});

	// the plain layer's insets resolve against the host's padding box while the
	// cipher sits inside its padding, so a layer that painted at its own box would
	// put every resolved character to the left of the cipher it replaces
	it('should keep the two layers in register under a host with padding', () => {
		const state = decryptState('ab');
		state.frame.set(part('ab', [0, 1], 0));

		const out = strip(
			renderToString(decryptView(state), {
				cascade: themedCascade({
					theme: '.sigil-decrypt { padding-left: 2; padding-top: 1 }',
				}),
				width: 40,
			})
		);

		expect(out).to.equal('\n  a#');
	});

	// each layer says what changed about *itself*: the cipher is what measures the
	// block, so a new frame is a new size, and the plain layer's rectangle is its
	// insets and cannot move. A frame coalesces the two today -- a layout mark
	// repaints everything -- so this reads the marks rather than the picture
	it('should record a measure on the cipher and a repaint on the plain layer', () => {
		// a scheduler that runs what it is handed, so that writing the frame runs the
		// effect rather than leaving it on a microtask the assertion would precede
		const scope = createEffects();
		scope.setScheduler((run) => run());
		const state = decryptState('ab');

		createRoot((release) => {
			const root = decryptView(state);
			const tree = createTree(root);
			const [cipher, plain] = root.children;
			tree.take();

			state.frame.set(part('ab', [0, 1], 0));
			const marks = tree.take();

			expect(marks.layout.has(cipher as Element), 'the cipher did not record a measure').to.equal(
				true
			);
			expect(
				marks.paint.has(plain as Element),
				'the plain layer did not record a repaint'
			).to.equal(true);
			release();
			return undefined;
		}, scope.effect);
	});

	// which cells are break opportunities is asked of the plan rather than of what is
	// drawn, so an alphabet that happened to hold a space cannot break a jumbling line
	// where the resolved one does not -- which is the no-reflow rule again, one layer
	// along from the widths
	it('should take its breaks from the plan rather than from the glyphs', () => {
		const text = 'one two three four';
		const plan = decryptPlan(text, { random: seeded(23) });
		const blanks: MaskAlphabet = { narrow: [' '], wide: ['  '] };
		const shape = (frame: DecryptFrame): number[] =>
			drawFrame(frame, 9)
				.split('\n')
				.map((line) => line.length);
		const resolved = shape(decryptFrameAt(plan, plan.duration, blanks, flat(0)));

		for (const at of sweep(plan)) {
			expect(shape(decryptFrameAt(plan, at, blanks, flat(0))), `${at}ms`).to.have.length(
				resolved.length
			);
		}
	});

	// a width of nothing is no width to wrap at rather than a width of one, which is
	// the rule a text keeps: wrapping there is one row per character, and the measure
	// that comes back is a shape nobody asked for
	it('should not wrap at a width of nothing', () => {
		const state = decryptState('');
		state.frame.set(decryptedFrame('abcdef'));

		const out = renderToString(decryptView(state), {
			cascade: themedCascade({ theme: '.sigil-decrypt-cipher { width: 0 }' }),
			width: 40,
		});

		expect(strip(out)).to.equal('');
	});

	// the placement is cached for the frame it was taken of, and a width is half of
	// that key: a resize lays the same frame out again at another width, and rows kept
	// from the width before it are a block drawn for a terminal that has gone
	it('should place the cells again when the width changed', () => {
		const state = decryptState('');
		state.frame.set(decryptedFrame('one two three'));
		const tree = decryptView(state);
		const at = (width: number): string =>
			strip(renderToString(tree, { cascade: themedCascade(), width }));

		expect(at(40)).to.equal('one two three');
		expect(at(7)).to.equal('one two\nthree');
		// and back, because a cache that is right once is not a cache
		expect(at(40)).to.equal('one two three');
	});

	// the plain layer's box is the rectangle it paints in, which is what the insets
	// and the host's `position: relative` are for -- and it is what every pass that
	// reads boxes is told about it, the selection mask above all
	it('should give the plain layer the block its insets name', () => {
		const state = decryptState('ab');
		state.frame.set(part('ab', [0, 1], 0));
		const view = decryptView(state);
		// a root bigger than the block, so that resolving against the root rather than
		// against the host is a different answer
		const root = box({ 'flex-direction': 'column' }, view, textNode('below'));

		resolveStyles(root);
		arrange(root, { height: 4, width: 10 });
		const [cipher, plain] = view.children;

		// the host is stretched to the column's width and is one row tall, which is the
		// rectangle the insets name; the cipher is the two cells it measured
		expect(view.box).to.deep.equal({ height: 1, width: 10, x: 0, y: 0 });
		expect(plain?.box, 'the plain layer is not the block').to.deep.equal(view.box);
		expect(cipher?.box, 'the cipher is not its own content').to.deep.equal({
			height: 1,
			width: 2,
			x: 0,
			y: 0,
		});
	});

	// a `raw` is not selectable by default, which is right for a sparkline and wrong
	// for cells that *are* the text -- so each layer says `drawsText`, which changes
	// that default rather than answering over the top of it
	it('should let a selection copy what is on screen', () => {
		const state = decryptState('ab');
		state.frame.set(part('ab', [0, 1], 0));
		// a `true` writes nothing while nothing has been excluded -- the mask is only
		// built once something says no -- so the sparkline beside it is what makes the
		// answer observable at all, and is the shape `selectable` exists for
		const sparkline = raw({ measure: () => ({ height: 1, width: 2 }), paint: () => {} });
		const view = decryptView(state);
		// the sparkline *first*, so that the mask it writes is one the decrypt's own
		// layers could widen: a plain layer whose insets resolved against the root
		// rather than against the block would mark the row above it copyable
		const root = box({ 'flex-direction': 'column' }, sparkline, view);

		resolveStyles(root);
		arrange(root, { height: 4, width: 10 });
		const selectable = selectableAt(root, 10, 4);
		const [cipher, plain] = view.children;

		// each layer says so for itself. The two cannot be told apart by the mask,
		// because the plain layer's rectangle contains the cipher's and is written
		// last -- which is two guards covering for each other rather than one claim.
		//
		// And neither writes a `selectable` of its own, which is the half that makes
		// the test below possible: an answer here would beat an ancestor's
		expect(cipher?.drawsText, 'the cipher does not say').to.equal(true);
		expect(plain?.drawsText, 'the plain layer does not say').to.equal(true);
		expect(cipher?.selectable, 'the cipher answers rather than inheriting').to.equal(undefined);
		expect(plain?.selectable, 'the plain layer answers rather than inheriting').to.equal(undefined);

		expect(selectable, 'nothing was excluded at all').not.to.equal(undefined);
		expect(selectable?.(0, 1), 'the resolved cell cannot be copied').to.equal(true);
		expect(selectable?.(1, 1), 'the cipher cell cannot be copied').to.equal(true);
		// and the rule it is an exception to is still the rule, above it and under it
		expect(selectable?.(0, 0), 'a raw that draws no text can be copied').to.equal(false);
		expect(selectable?.(4, 0), 'the block widened the mask past itself').to.equal(false);
	});

	// the other half of `drawsText`, and the thing a `selectable: true` on each layer
	// could not do: it is a *default*, so a pane that excludes itself still excludes
	// the decrypt inside it, exactly as it reaches the texts inside it. Which is the
	// rule the mask is written around -- without this, a pane marked uncopyable had
	// its decrypt copied anyway
	it('should let a pane that excludes itself exclude the decrypt inside it', () => {
		const state = decryptState('ab');
		state.frame.set(part('ab', [0, 1], 0));
		const view = decryptView(state);
		const root = box({ 'flex-direction': 'column', selectable: false }, view);

		resolveStyles(root);
		arrange(root, { height: 4, width: 10 });
		const selectable = selectableAt(root, 10, 4);

		expect(selectable, 'nothing was excluded at all').not.to.equal(undefined);
		expect(selectable?.(0, 0), 'the resolved cell is still copyable').to.equal(false);
		expect(selectable?.(1, 0), 'the cipher cell is still copyable').to.equal(false);
	});

	// an explicit `selectable` on the block still beats both, which is what keeps
	// `drawsText` a default rather than a second mechanism: a caller who wants a
	// decrypt copyable inside a pane that is not says so, and is obeyed
	it('should let the block say so over a pane that excluded it', () => {
		const state = decryptState('ab');
		state.frame.set(part('ab', [0, 1], 0));
		const view = decryptView(state);
		view.setProp('selectable', true);
		// a sparkline, so that something has excluded and the mask exists at all
		const sparkline = raw({ measure: () => ({ height: 1, width: 2 }), paint: () => {} });
		const root = box({ 'flex-direction': 'column', selectable: false }, sparkline, view);

		resolveStyles(root);
		arrange(root, { height: 4, width: 10 });
		const selectable = selectableAt(root, 10, 4);

		expect(selectable?.(0, 1), 'the block was not obeyed').to.equal(true);
		expect(selectable?.(1, 1), 'the block was not obeyed').to.equal(true);
		expect(selectable?.(0, 0), 'the sparkline stopped being a sparkline').to.equal(false);
	});

	// the rows past the bottom of the box are not this component's to invent a policy
	// for, which is `paintText()`'s own rule -- and a cell past the right-hand edge is
	// the same sentence on the other axis, which is what `text-overflow: clip` means
	it('should draw no cell outside the box it was given', () => {
		const state = decryptState('');
		state.frame.set(decryptedFrame('abcdef\nghi'));

		// over a grid bigger than the boxes, which is what a canvas is and what an
		// auto-sized render is not: the rows a `renderToString()` grows to its content
		// hide this, because a cell painted past the grid is one the grid refuses
		const out = renderToString(decryptView(state), {
			cascade: themedCascade({
				theme: '.sigil-decrypt-cipher { height: 1; white-space: nowrap; width: 3 }',
			}),
			height: 3,
			width: 10,
		});

		// the second row is past the bottom of the box and the fourth column is past
		// its right-hand edge: neither is drawn, so neither is over whatever the layout
		// put there
		expect(strip(out).split('\n')).to.deep.equal(['abc', '', '']);
	});

	// `white-space: nowrap` is honoured because the one-element view honoured it for
	// free, and a property that quietly stopped working is worse than one that never
	// did
	it('should not wrap a block a sheet told not to', () => {
		const state = decryptState('');
		state.frame.set(decryptedFrame('one two three'));
		const at = (theme: string): string =>
			strip(renderToString(decryptView(state), { cascade: themedCascade({ theme }), width: 5 }));

		// one row rather than three, and what does not fit the canvas is clipped at the
		// edge -- which is `text-overflow`'s own initial value and what the one-element
		// view did with the same declaration
		expect(at('.sigil-decrypt-cipher { white-space: nowrap }')).to.equal('one t');
		expect(at('')).to.equal('one\ntwo\nthree');
	});

	/** A one-line `nowrap` block in five columns, cut however the mode says. */
	function cut(mode: string): string {
		const state = decryptState('');
		state.frame.set(decryptedFrame('one two three'));
		const theme = `.sigil-decrypt-cipher { text-overflow: ${mode}; white-space: nowrap }`;
		return strip(
			renderToString(decryptView(state), { cascade: themedCascade({ theme }), width: 5 })
		);
	}

	// and `text-overflow` the same way, which is what a `raw` costs unless the
	// component spends it: the paint walk cuts a *text* because it holds the string,
	// and a raw paints its own cells, so there is no output for the walk to cut. What
	// is shared is the decision rather than the drawing -- `cutAt()` -- because the
	// two layers each hand over part of a row and a painter-side cut would compute
	// the boundary from half of one
	it('should cut a line the way text-overflow says', () => {
		expect(cut('clip'), 'clip').to.equal('one t');
		expect(cut('ellipsis'), 'ellipsis').to.equal('one …');
		expect(cut('ellipsis-start'), 'ellipsis-start').to.equal('…hree');
		expect(cut('ellipsis-middle'), 'ellipsis-middle').to.equal('on…ee');
	});

	// the differential that makes the sharing structural rather than careful. For a
	// frame with nothing hidden a cell *is* a cluster, so the component's cell walk
	// and `truncate()`'s cluster walk are the same question asked of the same text --
	// and a divergence about where `ellipsis-middle` puts its odd column, or about a
	// wide cluster straddling a boundary, is a thing nothing else would catch
	it('should cut where the truncator does', () => {
		const modes: TruncateMode[] = ['clip', 'ellipsis', 'ellipsis-start', 'ellipsis-middle'];

		for (const text of ['one two three', 'abcdefghij', '日本語のテキスト', 'a日b語c']) {
			const state = decryptState('');
			state.frame.set(decryptedFrame(text));
			const view = decryptView(state);

			for (const mode of modes) {
				for (const width of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
					const theme = `.sigil-decrypt-cipher { text-overflow: ${mode}; white-space: nowrap }`;
					const out = strip(renderToString(view, { cascade: themedCascade({ theme }), width }));
					// trailing blanks are dropped per line, which is the one place the two
					// legitimately differ: a row of spaces and an empty row are one row
					const want = truncate(text, width, mode).replace(/\s+$/u, '');
					expect(out, `${text} ${mode} at ${width}`).to.equal(want);
				}
			}
		}
	});

	// an ellipsis is a cut *mark* rather than content, so neither layer owns it on
	// its own terms -- CSS gives it the block's style and there is no single block
	// style here, which is the whole reason there are two elements. It stands for the
	// run it replaced and takes the state of the first cell of that run, which is the
	// only answer that needs no new rule and is the honest thing for it to say: the
	// line is still decrypting and so is the mark
	it('should draw the mark as the cell it hides', () => {
		const theme = `
			.sigil-decrypt-cipher { color: red; dim: false; text-overflow: ellipsis; white-space: nowrap }
			.sigil-decrypt-plain { color: green }
		`;
		/** The mark's own column, with `at` deciding whether the cell under it resolved. */
		const mark = (at: number): Set<string> => {
			const state = decryptState('');
			// five cells in a four-column box, so the cut falls at the fourth -- which is
			// the one cell whose own reveal time decides anything here. The first three
			// land at once so that what is drawn is readable, and the fifth is behind the
			// mark whatever it is doing
			state.frame.set(part('abcde', [0, 0, 0, 0.5, 0], at));
			const out = renderToString(decryptView(state), {
				cascade: themedCascade({ colorLevel: 3, colorScheme: 'dark', theme }),
				colorLevel: 3,
				width: 4,
			});
			const drawn = columns(out);
			expect(drawn.map((c) => c.text).join(''), `at ${at}`).to.equal('abc…');
			return drawn[3]?.params ?? new Set();
		};

		// while the fourth cell is still ciphered the mark is the cipher's colour, and
		// once it has landed the mark lands with it
		expect([...mark(10)], 'the mark did not follow the cipher').to.include('31');
		expect([...mark(60)], 'the mark did not follow the plaintext').to.include('32');
	});

	// the cut is cached beside the placement, so what invalidates it has to include
	// the *mode*: a frame and a width that did not move are not enough, because a
	// sheet swapped at runtime moves neither. `touchSheets()` is exactly that -- one
	// view, one frame, one width, and a different answer -- and every other test here
	// builds a fresh view per mode, which is the one arrangement that cannot see it
	it('should notice a mode that changed under a frame that did not', () => {
		const state = decryptState('');
		state.frame.set(decryptedFrame('one two three'));
		const view = decryptView(state);
		const [cipher] = view.children;
		cipher?.setProp('white-space', 'nowrap');

		const at = (mode: string): string => {
			cipher?.setProp('text-overflow', mode);
			return strip(renderToString(view, { cascade: themedCascade(), width: 5 }));
		};

		expect(at('clip'), 'clip').to.equal('one t');
		expect(at('ellipsis'), 'the cut survived the mode').to.equal('one …');
		// and back, because a cache that is right once is not a cache
		expect(at('clip'), 'the cut survived the mode').to.equal('one t');
	});

	// `text-overflow` says what is *drawn* and never what a block wants, so the
	// measure reads the uncut rows. A measure that reported the cut width would make
	// the box as narrow as the cut it provoked -- which is why the cut cannot live in
	// `placeCells()` at all, and is the split `paintText()` already keeps
	it('should report what the block wants rather than what was drawn', () => {
		for (const mode of ['clip', 'ellipsis', 'ellipsis-start', 'ellipsis-middle']) {
			const state = decryptState('');
			state.frame.set(decryptedFrame('one two three'));
			const view = decryptView(state);
			const [cipher] = view.children;
			// props rather than a sheet, which beat it per property and need no cascade
			cipher?.setProp('white-space', 'nowrap');
			cipher?.setProp('text-overflow', mode);
			resolveStyles(view);

			expect(cipher?.measure?.(5).width, mode).to.equal(13);
		}
	});
});

describe('decryptReveal()', () => {
	/**
	 * Runs a reveal with no renderer at all, so a timer count means its own.
	 *
	 * The facade's clock is two clocks -- a step sets a signal and the frame loop
	 * decides when that reaches the screen -- and a frame is a timer too, so a test
	 * over a renderer cannot ask "is there a step pending" without counting the
	 * renderer's answer. This is the typewriter's own helper, for its reason.
	 *
	 * @param text - What to decrypt.
	 * @param opts - What to pass the reveal.
	 * @returns The state, a count of how often it finished, and a way to let go.
	 */
	function drive(
		text: string,
		opts: Partial<Parameters<typeof decryptReveal>[1]> = {}
	): { dispose: () => void; finished: () => number; state: DecryptState } {
		const scope = createEffects();
		scope.setScheduler((run) => run());
		const state = decryptState(text);
		let done = 0;
		const dispose = createRoot(
			(release) => {
				decryptReveal(state, {
					animate: () => true,
					interval: 10,
					jumble: 100,
					onDone: () => void done++,
					random: seeded(7),
					revealInterval: 20,
					reveal: 400,
					...opts,
				});
				return release;
			},
			scope.effect,
			(error) => {
				throw error;
			}
		);

		return { dispose, finished: () => done, state };
	}

	it('should mask the text on the first frame rather than one tick later', () => {
		vi.useFakeTimers();
		try {
			// a decrypt that showed the real text for one frame has given the answer away
			const it = drive('abcdef', { alphabet: MARKS, random: seeded(7) });

			expect(it.state.frame.get().text).to.equal('######');
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should redraw the mask on each tick', () => {
		vi.useFakeTimers();
		try {
			const it = drive('x'.repeat(30));
			const first = it.state.frame.get().text;

			vi.advanceTimersByTime(10);
			expect(it.state.frame.get().text).not.to.equal(first);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	// nms's two speeds, which are two intervals rather than two mechanisms
	it('should tick faster while jumbling than while resolving', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef', { interval: 10, jumble: 100, revealInterval: 50 });
			const drawn: string[] = [];

			// inside the jumble: a redraw every 10ms
			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(10);
				drawn.push(it.state.frame.get().text);
			}
			expect(new Set(drawn).size).to.be.greaterThan(1);

			// past it: 49ms buys nothing, and the 50th is the next frame
			vi.advanceTimersByTime(100);
			const settled = it.state.frame.get().text;
			vi.advanceTimersByTime(49);
			expect(it.state.frame.get().text).to.equal(settled);
			vi.advanceTimersByTime(1);
			expect(it.state.frame.get().text).not.to.equal(settled);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should hold no timer once everything has resolved', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef');
			expect(vi.getTimerCount()).to.equal(1);

			vi.advanceTimersByTime(2000);
			expect(it.state.frame.get()).to.deep.equal(decryptedFrame('abcdef'));
			expect(vi.getTimerCount()).to.equal(0);
			expect(it.finished()).to.equal(1);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(['', '   ', ACUTE, '\n\n'])('should start no timer at all for %j', (text) => {
		vi.useFakeTimers();
		try {
			const it = drive(text);

			expect(vi.getTimerCount()).to.equal(0);
			expect(it.finished()).to.equal(1);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should start no timer when it is not animating', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef', { animate: () => false });

			expect(vi.getTimerCount()).to.equal(0);
			expect(it.state.frame.get()).to.deep.equal(decryptedFrame('abcdef'));
			expect(it.finished()).to.equal(1);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should write the text with its sequences taken out when it is not animating', () => {
		vi.useFakeTimers();
		try {
			const it = drive(`${ESC}[31msecret${ESC}[39m`, { animate: () => false });

			expect(it.state.frame.get().text).to.equal('secret');
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should let go of its timer when it is disposed', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef');
			expect(vi.getTimerCount()).to.equal(1);

			it.dispose();
			expect(vi.getTimerCount()).to.equal(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should hold no timer the process has to wait for', () => {
		vi.useFakeTimers();
		try {
			let unreffed = 0;
			const real = globalThis.setTimeout;
			const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
				fn: () => void,
				ms?: number
			) => {
				const timer = real(fn, ms) as unknown as { unref?: () => void };
				const unref = timer.unref?.bind(timer);
				timer.unref = (): void => {
					unreffed++;
					unref?.();
				};
				return timer as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);

			const it = drive('abcdef');
			expect(unreffed).to.equal(1);

			it.dispose();
			spy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should take the clock it was given', () => {
		vi.useFakeTimers();
		try {
			let clock = 1000;
			const it = drive('abcdef', { jumble: 0, now: () => clock, reveal: 100 });

			expect(it.state.frame.get().masked).to.equal(true);
			// the clock rather than the timer is what decides a cell has resolved, so a
			// clock that does not move leaves the frame where it was however many
			// timers fire
			vi.advanceTimersByTime(1000);
			expect(it.state.frame.get().masked).to.equal(true);

			clock = 2000;
			vi.advanceTimersByTime(20);
			expect(it.state.frame.get()).to.deep.equal(decryptedFrame('abcdef'));
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	// once per *pass* rather than once per component, which the facade is what
	// narrows: the doc said "once" and the driver had never promised that
	it('should report again for a text that was replaced with nothing to hide', () => {
		vi.useFakeTimers();
		try {
			const it = drive('   ');
			expect(it.finished()).to.equal(1);

			it.state.text.set('  ');
			expect(it.finished()).to.equal(2);
			it.state.text.set(' ');
			expect(it.finished()).to.equal(3);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should restart over a text that changed under it', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef', { alphabet: MARKS });
			vi.advanceTimersByTime(2000);
			expect(it.state.frame.get().text).to.equal('abcdef');

			it.state.text.set('ghi');
			const frame = it.state.frame.get();
			expect(frame.masked).to.equal(true);
			expect(frame.text).to.equal('###');
			expect(frame.lines).to.deep.equal([
				[
					{ hidden: true, text: '#', width: 1 },
					{ hidden: true, text: '#', width: 1 },
					{ hidden: true, text: '#', width: 1 },
				],
			]);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('createDecrypt()', () => {
	describe('with no terminal', () => {
		it('should start no timer', () => {
			vi.useFakeTimers();
			try {
				const { ansi, terminal } = setup({ isTTY: false });
				createDecrypt({ ansi, terminal, text: 'secret' }).start();

				expect(vi.getTimerCount()).to.equal(0);
			} finally {
				vi.useRealTimers();
			}
		});

		// the live region's rule, and a component does not override it: a CI log full
		// of noise is worse than no effect at all
		it('should write the text once and resolve', async () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });

			await decrypt('the launch codes', { ansi, terminal });

			expect(stdout.text).to.equal('the launch codes\n');
		});

		it('should take the sequences out of what it writes', async () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });

			await decrypt(`${ESC}[31mred${ESC}[39m`, { ansi, terminal });

			expect(stdout.output).not.to.contain(ESC);
			expect(stdout.text).to.equal('red\n');
		});

		it('should answer the same way to a reduced-motion opt-out', async () => {
			const { ansi, stdout, terminal } = setup();

			await decrypt('secret', { ansi, reducedMotion: 'reduce', terminal });

			expect(stdout.text).to.contain('secret');
		});
	});

	describe('over a screen', () => {
		it('should jumble and then resolve into the text', () => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup({ columns: 30 });
				const it = createDecrypt({
					alphabet: MARKS,
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					jumble: 50,
					random: seeded(7),
					reveal: 200,
					revealInterval: 10,
					terminal: ui.terminal,
					text: 'secret',
				}).start();

				expect(ui.frame).to.equal('######');

				vi.advanceTimersByTime(1000);
				vi.advanceTimersToNextTimer();
				expect(ui.frame).to.equal('secret');
				expect(it.decrypting).to.equal(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should leave the text behind and give the screen back', async () => {
			const ui = screenSetup({ columns: 30 });

			await decrypt('secret', {
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				interval: 1,
				jumble: 0,
				random: seeded(7),
				reveal: 0,
				terminal: ui.terminal,
			});

			expect(ui.log).to.deep.equal(['secret']);
		});

		it('should snap to the finished text when it is stopped', () => {
			const ui = screenSetup({ columns: 30 });
			const it = createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				random: seeded(7),
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			expect(ui.frame).to.equal('######');
			it.stop();
			expect(ui.log).to.deep.equal(['secret']);
		});

		it('should leave nothing behind when it is cancelled', () => {
			const ui = screenSetup({ columns: 30 });
			const it = createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				random: seeded(7),
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			expect(ui.frame).to.equal('######');
			expect(it.decrypting).to.equal(true);

			it.cancel();
			expect(ui.log).to.deep.equal([]);
			// and it says it is over: the frame it was erased on is still a masked one,
			// so `decrypting` reads as true unless the cancel turns `running` off
			expect(it.decrypting).to.equal(false);
		});

		it('should snap to the finished text when it is stopped between frames', () => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup({ columns: 30 });
				const it = createDecrypt({
					alphabet: MARKS,
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					jumble: 100,
					random: seeded(7),
					reveal: 400,
					terminal: ui.terminal,
					text: 'secret',
				}).start();

				// a few ticks in, so the stop lands with a timer in flight and some of
				// the text still hidden
				vi.advanceTimersByTime(30);
				vi.advanceTimersToNextTimer();
				expect(ui.frame).to.equal('######');

				it.stop();
				expect(ui.log).to.deep.equal(['secret']);
				// and the timer it was holding goes with it, which is what says the
				// reveal really stopped rather than being left to run over a dead screen
				expect(vi.getTimerCount()).to.equal(0);
			} finally {
				vi.useRealTimers();
			}
		});

		// a negative claim about all inputs is not established by tracing the route
		// you had in mind, so this walks the degenerate ones rather than reasoning
		// about them: every one of these has to land its own text and let its timer go
		it.each([
			['empty', ''],
			['one space', ' '],
			['whitespace only', '   '],
			['one character', 'a'],
			['all wide', CJK],
			['a ZWJ sequence', FAMILY],
			['a flag', FLAG],
			['a lone combining mark', ACUTE],
			['a lone surrogate', SURROGATE],
			['a tab', 'a\tb'],
			['CRLF', 'a\r\nb'],
			['a newline', 'a\nb'],
			['a blank line', 'a\n\nb'],
			['longer than the terminal', 'x'.repeat(200)],
		])('should finish over %s', (_name, text) => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup({ columns: 30, rows: 24 });
				const it = createDecrypt({
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					jumble: 20,
					random: seeded(7),
					reveal: 80,
					revealInterval: 10,
					terminal: ui.terminal,
					text,
				}).start();

				vi.advanceTimersByTime(1000);
				vi.advanceTimersToNextTimer();

				expect(it.decrypting).to.equal(false);
				expect(vi.getTimerCount()).to.equal(0);
				it.stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it.each([
			['always zero', flat(0)],
			['just under one', flat(1 - 1e-12)],
			['exactly one', flat(1)],
			['above the range', flat(7)],
			['below it', flat(-7)],
			['not a number', flat(Number.NaN)],
			['infinite', flat(Number.POSITIVE_INFINITY)],
		])('should finish with a generator that answers %s', (_name, random) => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup({ columns: 40 });
				const it = createDecrypt({
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					jumble: 20,
					random,
					reveal: 80,
					revealInterval: 10,
					terminal: ui.terminal,
					text: `a ${CJK} b`,
				}).start();

				vi.advanceTimersByTime(1000);
				vi.advanceTimersToNextTimer();

				expect(it.decrypting).to.equal(false);
				expect(vi.getTimerCount()).to.equal(0);
				it.stop();
				expect(ui.log).to.deep.equal([`a ${CJK} b`]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should draw nothing at all until it is started', () => {
			const ui = screenSetup({ columns: 30 });
			createDecrypt({ ansi: ui.ansi, frameMs: 0, terminal: ui.terminal, text: 'secret' });

			expect(ui.log).to.deep.equal([]);
		});
	});

	describe('resolving', () => {
		/** A decrypt with nothing to wait for, over a recording stream. */
		function instant(text: string): ReturnType<typeof createDecrypt> {
			const { ansi, terminal } = setup({ isTTY: false });
			return createDecrypt({ ansi, terminal, text });
		}

		it('should resolve when everything has resolved', async () => {
			let over = false;
			const it = instant('secret').start();
			void it.done.then(() => void (over = true));

			await it.done;
			expect(over).to.equal(true);
			expect(it.decrypting).to.equal(false);
		});

		it('should resolve when it is stopped before the first frame', async () => {
			const it = instant('secret');
			it.stop();

			await it.done;
			expect(it.text).to.equal('secret');
		});

		it('should resolve when it is cancelled', async () => {
			const it = instant('secret').start();
			it.cancel();

			await it.done;
		});

		it.each([
			['stop', (it: ReturnType<typeof createDecrypt>) => it.stop()],
			['cancel', (it: ReturnType<typeof createDecrypt>) => it.cancel()],
		])('should settle once when %s is called twice', async (_name, end) => {
			let settled = 0;
			const it = instant('secret').start();
			void it.done.then(() => void settled++);

			end(it);
			end(it);
			await it.done;

			expect(settled).to.equal(1);
		});

		// a run that is over is over, and the state has to say so: with `running` left
		// on, the `stop()` below mounts a fresh renderer whose effect reads it as
		// still animating -- so it masks the text again and leaves *that* in the log
		it('should not decrypt again when it is stopped after it finished', async () => {
			const ui = screenSetup({ columns: 30 });
			const it = createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				interval: 1,
				jumble: 0,
				random: seeded(7),
				reveal: 0,
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			await it.done;
			it.stop();

			expect(ui.log).to.deep.equal(['secret', 'secret']);
		});

		// the final frame is painted before the screen is given back, because `done()`
		// leaves what is on screen where it is -- and what is on screen until then is
		// the frame before the one that resolved the last cell. Real timers and a
		// short run, because the completion has to arrive *from a timer*: a run that
		// resolves inside its own first frame has already been painted by `start()`
		it('should leave the resolved frame rather than the one before it', async () => {
			const ui = screenSetup({ columns: 30 });

			await decrypt('secret', {
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				interval: 1,
				jumble: 1,
				random: seeded(7),
				reveal: 1,
				revealInterval: 1,
				terminal: ui.terminal,
			});

			expect(ui.log).to.deep.equal(['secret']);
		});

		// a run started inside the window between a settle and the teardown it queued
		// owns the screen, and the settled run's teardown must not take it: without
		// the generation guard it disposed the renderer the new run had just built,
		// which clears the reveal's timer -- so the discriminator is that the second
		// run still has one and still arrives, rather than anything about the frame
		// that is on screen when it happens
		it('should not let a settled run tear down the one that replaced it', async () => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup({ columns: 30 });
				const it = createDecrypt({
					alphabet: MARKS,
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					jumble: 20,
					random: seeded(7),
					reveal: 80,
					revealInterval: 10,
					terminal: ui.terminal,
				});

				// whitespace has nothing to hide, so this run settles inside `start()` and
				// queues its teardown -- which is the window the second start lands in
				it.start('   ');
				it.start('secret');
				// one turn, which is all the chain the settle queued needs
				await Promise.resolve();

				expect(ui.frame).to.equal('######');
				expect(vi.getTimerCount(), 'the second run still has a reveal pending').to.be.greaterThan(
					0
				);

				vi.advanceTimersByTime(500);
				vi.advanceTimersToNextTimer();
				expect(ui.frame).to.equal('secret');
			} finally {
				vi.useRealTimers();
			}
		});

		it('should hand a fresh promise to a run that follows a settled one', async () => {
			const it = instant('secret').start();
			const first = it.done;
			await first;

			it.start('again');
			expect(it.done).not.to.equal(first);
			await it.done;
			expect(it.text).to.equal('again');
		});

		it('should settle a run once, whatever happens after it', async () => {
			let settled = 0;
			const it = instant('secret');
			void it.done.then(() => void settled++);

			// the second start is a second *run*, with a promise of its own -- which
			// is what `should hand a fresh promise` below is about. What this one says
			// is that it does not reach back and settle the first run again
			it.start();
			it.start();
			await it.done;

			expect(settled).to.equal(1);
		});

		// a start while a run is still going is the typewriter's no-op rather than a
		// second run: the signal refuses an equal write, so nothing is rescheduled
		it('should keep one promise while a run is still going', () => {
			const ui = screenSetup({ columns: 30 });
			const it = createDecrypt({
				ansi: ui.ansi,
				frameMs: 0,
				random: seeded(7),
				terminal: ui.terminal,
				text: 'secret',
			}).start();
			const first = it.done;

			it.start();
			expect(it.done).to.equal(first);
			it.cancel();
		});

		// the hang this found: a run started inside the window between a settle and
		// the teardown it queued reused the finished run's renderer, whose effect was
		// not dirty -- so nothing animated and nothing ever resolved
		it('should begin a fresh run started before the last one let go', async () => {
			const ui = screenSetup({ columns: 30 });
			const it = createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				interval: 1,
				jumble: 0,
				random: seeded(7),
				reveal: 0,
				terminal: ui.terminal,
			});

			it.start('one');
			// no await, so the teardown the settle queued has not run yet
			it.start('two');
			await it.done;

			expect(ui.log).to.deep.equal(['one', 'two']);
		});
	});

	describe('aborting', () => {
		it('should erase and resolve when the signal fires', () => {
			const ui = screenSetup({ columns: 30 });
			const control = new AbortController();
			createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				random: seeded(7),
				signal: control.signal,
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			expect(ui.frame).to.equal('######');
			control.abort();
			expect(ui.log).to.deep.equal([]);
		});

		it('should draw nothing for a signal that had already fired', async () => {
			const ui = screenSetup({ columns: 30 });
			const control = new AbortController();
			control.abort();

			const it = createDecrypt({
				ansi: ui.ansi,
				frameMs: 0,
				signal: control.signal,
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			await it.done;
			expect(ui.log).to.deep.equal([]);
		});

		/**
		 * A signal that records what was attached to it and what came off again.
		 *
		 * What the two assertions below are about is a *listener* rather than a wrong
		 * cell, and nothing an `AbortSignal` exposes can be asked how many it is
		 * holding -- so the thing being asserted has to be the calls. A stub rather
		 * than a spy over a real controller for the same reason: `addEventListener`
		 * is what has to be counted, and a real signal's is not ours to replace.
		 *
		 * @returns The stub, and what it saw.
		 */
		function watcher(): { added: () => number; removed: () => number; signal: AbortSignal } {
			let added = 0;
			let removed = 0;
			const signal = {
				aborted: false,
				addEventListener: (): void => void added++,
				removeEventListener: (): void => void removed++,
			};
			return {
				added: () => added,
				removed: () => removed,
				signal: signal as unknown as AbortSignal,
			};
		}

		// put back what you attached: a decrypt that finished must not leave a
		// listener on a signal the caller goes on using for the life of the process
		it('should take its listener off a signal it finished without', async () => {
			const ui = screenSetup({ columns: 30 });
			const watch = watcher();
			// a real run over a real clock, so that the listener is live while it is
			// animating: the no-terminal path settles inside `start()`, where the
			// removal and the attach cannot be told apart
			const it = createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				interval: 1,
				jumble: 1,
				random: seeded(7),
				reveal: 1,
				revealInterval: 1,
				signal: watch.signal,
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			expect(watch.added()).to.equal(1);
			expect(watch.removed()).to.equal(0);

			await it.done;
			expect(watch.removed()).to.equal(1);
		});

		// and a second start while a run is still going attaches nothing new: the
		// remover is one variable, so a second listener would leak the first
		it('should attach once however often it is started', () => {
			const ui = screenSetup({ columns: 30 });
			const watch = watcher();
			const it = createDecrypt({
				ansi: ui.ansi,
				frameMs: 0,
				random: seeded(7),
				signal: watch.signal,
				terminal: ui.terminal,
				text: 'secret',
			});

			it.start();
			it.start();
			it.start();

			expect(watch.added()).to.equal(1);
			it.cancel();
			expect(watch.removed()).to.equal(1);
		});
	});

	describe('the facade', () => {
		it('should write a line above the frame', () => {
			const ui = screenSetup({ columns: 30 });
			const it = createDecrypt({
				alphabet: MARKS,
				ansi: ui.ansi,
				frameMs: 0,
				random: seeded(7),
				terminal: ui.terminal,
				text: 'secret',
			}).start();

			it.write('a note');
			expect(ui.log).to.contain('a note');
			it.cancel();
		});

		it('should write a line straight out when nothing has claimed the screen', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			createDecrypt({ ansi, terminal, text: 'secret' }).write('a note');

			expect(stdout.text).to.equal('a note\n');
		});

		it('should decrypt the text it is assigned', () => {
			const { ansi, terminal } = setup({ isTTY: false });
			const it = createDecrypt({ ansi, terminal, text: 'one' }).start();

			it.text = 'two';
			expect(it.text).to.equal('two');
		});
	});
});
