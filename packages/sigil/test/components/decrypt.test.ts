import { strip } from '../../src/ansi/strip.js';
import {
	ASCII,
	CP437,
	createDecrypt,
	decrypt,
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
import { renderToString } from '../../src/element/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { graphemes, stringWidth } from '../../src/width/index.js';
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
		const found = cells.find((cell) => cell.cluster === space);

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

	it('should leave everything else to the element to draw', () => {
		// a tab, a carriage return and a lone surrogate are not this component's to
		// sanitize: they are the element's, exactly as for every other built-in
		const plan = decryptPlan(`a\tb\r${SURROGATE}`, { random: flat(0) });

		expect(plan.text).to.equal(`a\tb\r${SURROGATE}`);
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
	])('should end at exactly what it was given: %j', (text) => {
		const plan = decryptPlan(text, { random: seeded(2) });

		expect(decryptFrameAt(plan, plan.duration, CP437, seeded(4)).text).to.equal(text);
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
		const text = '  indented\n\tand a tab  ';
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
		expect(state.frame.get()).to.deep.equal({ masked: false, text: '' });
	});
});

describe('decryptView()', () => {
	/**
	 * Renders a tree over a state, with the framework sheet behind it.
	 *
	 * Stripped, because a worker's own colour level is not this file's subject: the
	 * two tests below that are about the styling ask for a level by name.
	 *
	 * @param state - What the tree reads.
	 * @returns What it draws, with the styling taken off.
	 */
	function draw(state: DecryptState, width = 40): string {
		return strip(renderToString(decryptView(state), { cascade: themedCascade(), width }));
	}

	it('should draw the frame rather than the text', () => {
		const state = decryptState('secret');
		state.frame.set({ masked: true, text: '######' });

		expect(draw(state)).to.equal('######');
	});

	it('should keep the lines of a block', () => {
		const state = decryptState('a\nb');
		state.frame.set({ masked: false, text: 'a\nb' });

		expect(draw(state)).to.equal('a\nb');
	});

	// the state class is how a sheet reaches the reveal beat, and the component
	// carries no colour of its own for a theme to have to fight
	it('should mark the block while anything is still hidden', () => {
		const cascade = themedCascade({ colorLevel: 3, colorScheme: 'dark' });
		const state = decryptState('ab');

		state.frame.set({ masked: true, text: '##' });
		const hidden = renderToString(decryptView(state), { cascade, colorLevel: 3, width: 40 });

		state.frame.set({ masked: false, text: 'ab' });
		const shown = renderToString(decryptView(state), { cascade, colorLevel: 3, width: 40 });

		// dim while hidden, and nothing once it has resolved
		expect(hidden).to.contain(`${ESC}[2m`);
		expect(shown).not.to.contain(`${ESC}[2m`);
		expect(strip(hidden)).to.equal('##');
		expect(strip(shown)).to.equal('ab');
	});

	// `min-width: 0` rather than the automatic minimum, which for a text is its
	// longest word: without it an over-long word keeps its full width and is cut off
	// at the canvas edge rather than broken, which is a frame wider than the terminal
	// it was asked to fit. Measured: 34 columns in a 12-column render
	it('should break a word longer than the width it was given', () => {
		const state = decryptState('');
		state.frame.set({ masked: false, text: 'supercalifragilisticexpialidocious' });

		for (const line of draw(state, 12).split('\n')) {
			expect(stringWidth(line), `${line} is wider than the render`).to.be.at.most(12);
		}
	});

	// `dim` is the one declaration whose legibility depends on which way the
	// background goes, so it carries a light half on `gray` -- the same rule and the
	// same remedy `.sigil-prompt-hint` and help's own note already have
	it('should de-emphasise without dim on a light terminal', () => {
		const state = decryptState('ab');
		state.frame.set({ masked: true, text: '##' });

		const at = (scheme: 'dark' | 'light'): string =>
			renderToString(decryptView(state), {
				cascade: themedCascade({ colorLevel: 3, colorScheme: scheme }),
				colorLevel: 3,
				colorScheme: scheme,
				width: 40,
			});

		// the SGR *parameters* rather than a substring, which is this repository's
		// rule: `2m` also matches the `[22m` that closes bold
		const params = (out: string): Set<string> =>
			new Set(
				[...out.matchAll(new RegExp(`${ESC}\\[([\\d;]*)m`, 'g'))].flatMap((m) =>
					(m[1] as string).split(';')
				)
			);

		const dark = at('dark');
		const light = at('light');

		// 2 is faint, which is what `dim` emits; 90 is the foreground of palette 8
		expect(params(dark).has('2'), 'dark lost its dim').to.equal(true);
		expect(params(light).has('2'), 'light still emits faint').to.equal(false);
		expect(params(light).has('90'), 'light has no de-emphasis at all').to.equal(true);
		// and the glyphs are the same either way: only how they are drawn moved
		expect(strip(light)).to.equal(strip(dark));
	});

	// the attributes go at level 0 along with the colour, so what is left is the
	// characters changing -- which is the whole effect
	it('should draw nothing but the characters at colour level 0', () => {
		const state = decryptState('ab');
		state.frame.set({ masked: true, text: '##' });

		const out = renderToString(decryptView(state), {
			cascade: themedCascade({ colorLevel: 0 }),
			colorLevel: 0,
			width: 40,
		});

		expect(out).to.equal('##');
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
			expect(it.state.frame.get()).to.deep.equal({ masked: false, text: 'abcdef' });
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
			expect(it.state.frame.get()).to.deep.equal({ masked: false, text: 'abcdef' });
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
			expect(it.state.frame.get()).to.deep.equal({ masked: false, text: 'abcdef' });
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
			expect(it.state.frame.get()).to.deep.equal({ masked: true, text: '###' });
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
