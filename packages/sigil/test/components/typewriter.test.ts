import {
	byLine,
	byWord,
	createTypewriter,
	revealSteps,
	typewriterReveal,
	typewriterState,
	type TypewriterState,
	typewriterView,
} from '../../src/components/typewriter.js';
import { renderToString } from '../../src/element/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { createEffects, State } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { graphemes } from '../../src/width/index.js';
import { screenSetup, setup } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The typewriter.
 *
 * What a test reads is the screen rather than the bytes, for the reason the
 * spinner's tests do: a frame is a diff against the one before it. The rules about
 * not having a terminal are asserted through the recording stream instead, because
 * there the claim really is about what was *written* -- one line rather than one
 * per character.
 */

/** The clusters this file leans on, each a thing a column sweep would cut up. */
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const FLAG = '\u{1F1EC}\u{1F1E7}';
const ACUTE = '́';
const KEYCAP = '1️⃣';

/** Written as a code rather than as a byte, because source carries no raw ESC. */
const ESC = String.fromCharCode(0x1b);

/**
 * Advances the reveal's own clock and then lets the frame it asked for run.
 *
 * A step sets a signal, which asks the renderer for a frame rather than painting
 * one -- the same two clocks the spinner's tests have to advance, and for the same
 * reason: vitest does not run a timer scheduled during an advance within that same
 * advance, so advancing only the interval reads the frame before last.
 *
 * @param ms - How far to advance.
 */
function type(ms: number): void {
	vi.advanceTimersByTime(ms);
	vi.advanceTimersToNextTimer();
}

describe('byWord()', () => {
	it('should put whitespace in front of the word it belongs to', () => {
		expect(byWord('one two three')).to.deep.equal(['one', ' two', ' three']);
	});

	// a chunk that reveals nothing is a step in which the screen does not change,
	// which reads as a dropped frame rather than as typing. Text with no word in it
	// at all is the exception below, because there is nothing for its whitespace to
	// travel to
	it('should never produce a chunk that is only whitespace', () => {
		for (const value of ['  a  b  ', '\n\na\n', '\t x', 'a   ', ' a']) {
			for (const chunk of byWord(value)) {
				expect(chunk.trim(), `${JSON.stringify(value)} -> ${JSON.stringify(chunk)}`).not.to.equal(
					''
				);
			}
		}
	});

	// whitespace-only input has no word to attach to, so it is one chunk of its own
	it('should keep whitespace-only text as one chunk', () => {
		expect(byWord('   ')).to.deep.equal(['   ']);
		expect(byWord('')).to.deep.equal([]);
	});

	it.each(['one two three', '  leading', 'trailing   ', 'a\nb c', '', '   ', `one ${FAMILY} two`])(
		'should join back to what it was given: %j',
		(value) => {
			expect(byWord(value).join('')).to.equal(value);
		}
	);
});

describe('byLine()', () => {
	it('should put the break in front of the line it opens', () => {
		expect(byLine('one\ntwo')).to.deep.equal(['one', '\ntwo']);
	});

	it('should keep a blank line as its own chunk', () => {
		expect(byLine('a\n\nb')).to.deep.equal(['a', '\n', '\nb']);
	});

	it('should have nothing to reveal for an empty string', () => {
		expect(byLine('')).to.deep.equal([]);
		expect(byWord('')).to.deep.equal([]);
	});

	it('should not open with a chunk that reveals nothing', () => {
		// `'\na'.split()` leads with an empty piece, and a chunk that puts nothing on
		// screen is a step in which the screen does not change
		expect(byLine('\na')).to.deep.equal(['\na']);
	});

	it.each(['one\ntwo', 'a\n\nb', '\nleading', 'trailing\n', '', 'one line'])(
		'should join back to what it was given: %j',
		(value) => {
			expect(byLine(value).join('')).to.equal(value);
		}
	);
});

describe('revealSteps()', () => {
	it('should step one grapheme cluster at a time', () => {
		expect(revealSteps('abc', graphemes).map((s) => s.chunk)).to.deep.equal(['a', 'b', 'c']);
	});

	// the whole reason this reveals by chunk rather than by column: a sweep would
	// cut a family emoji into pieces and show half a glyph
	it.each([
		['a ZWJ sequence', FAMILY],
		['a flag', FLAG],
		['a keycap', KEYCAP],
		['a combining mark', `a${ACUTE}`],
		['a spacing mark', 'का'],
	])('should never split %s', (_name, cluster) => {
		const steps = revealSteps(cluster, graphemes);
		expect(steps).to.have.length(1);
		expect(steps[0]?.chunk).to.equal(cluster);
	});

	it('should have nothing to do with an empty string', () => {
		expect(revealSteps('', graphemes)).to.deep.equal([]);
	});

	// the chunker decides where the steps land and the *string* decides what is
	// shown, which is what makes any chunker safe to pass
	it('should end at the whole string even when the chunker loses characters', () => {
		const lossy = (value: string): string[] => [value.slice(0, 2)];
		const steps = revealSteps('abcdef', lossy);

		expect(steps.at(-1)?.end).to.equal(6);
		expect(steps.map((s) => s.chunk).join('')).to.equal('abcdef');
	});

	it('should reveal everything in one step for a chunker that returns nothing', () => {
		expect(revealSteps('abc', () => [])).to.deep.equal([{ chunk: 'abc', end: 3 }]);
	});

	it('should drop a chunk that adds nothing', () => {
		expect(revealSteps('ab', () => ['', 'a', '', 'b']).map((s) => s.chunk)).to.deep.equal([
			'a',
			'b',
		]);
	});

	it('should clamp a chunk that runs past the end', () => {
		expect(revealSteps('ab', () => ['abcdef'])).to.deep.equal([{ chunk: 'ab', end: 2 }]);
	});

	it('should take the chunk text out of the string rather than from the chunker', () => {
		// a `Pace` pausing after a full stop is asking about the text, and the two
		// part company exactly when the chunker is wrong
		const steps = revealSteps('ab', () => ['xx']);
		expect(steps[0]?.chunk).to.equal('ab');
	});

	it.each(['', 'a', 'hello world', `${FAMILY}${FLAG}`, 'a\nb'])(
		'should have steps whose chunks rebuild the text: %j',
		(value) => {
			const steps = revealSteps(value, graphemes);
			expect(steps.map((s) => s.chunk).join('')).to.equal(value);
			expect(steps.at(-1)?.end ?? 0).to.equal(value.length);
		}
	);
});

describe('typewriterView()', () => {
	const draw = (text: string, revealed: number, cursor?: string, width = 20): string => {
		const state = typewriterState(text);
		state.revealed.set(revealed);
		return renderToString(typewriterView(state, { cursor }), {
			cascade: themedCascade(),
			colorLevel: 0,
			width,
		});
	};

	it('should show the revealed prefix and nothing after it', () => {
		expect(draw('hello', 3)).to.equal('hel');
	});

	it('should draw the cursor at the write head', () => {
		expect(draw('hello', 3, '#')).to.equal('hel#');
	});

	// the write head is where the next character goes, and a finished line has no
	// next character -- which is also what keeps a cursor out of the log
	it('should drop the cursor once there is nothing left to reveal', () => {
		expect(draw('hello', 5, '#')).to.equal('hello');
	});

	/**
	 * `-1` rather than some larger negative, which is what makes this say anything.
	 *
	 * `String.slice` reads a negative end as an offset from the far end, so
	 * `'abc'.slice(0, -1)` is `'ab'` -- a position of `-1` without the clamp shows
	 * every character but the last. A position past `-length` clamps to nothing on
	 * its own, which is why the first fixture here was `-5` and survived its
	 * sabotage: the one negative where `slice` happens to agree.
	 */
	it('should clamp a position past either end of the text', () => {
		expect(draw('abc', 99, '#')).to.equal('abc');
		expect(draw('abc', -1, '#')).to.equal('#');
		expect(draw('abc', -99, '#')).to.equal('#');
		expect(draw('abc', Number.NaN, '#')).to.equal('#');
	});

	/**
	 * The measurement that decided the cursor.
	 *
	 * A caret beside a `text` is a second flex item placed beside that text's
	 * *box*, so for text that wraps it lands at the end of the **first** row. A
	 * character inside the string follows the last character wherever it went.
	 */
	it('should keep the cursor at the write head through a wrap', () => {
		expect(draw('aaa bbb ccc ddd', 10, '#', 11)).to.equal('aaa bbb cc#');
		expect(draw('aaa bbb ccc ddd', 13, '#', 11)).to.equal('aaa bbb ccc\nd#');
	});

	it('should keep the cursor at the write head through a broken over-long word', () => {
		expect(draw('supercalifragilistic', 8, '#', 6)).to.equal('superc\nal#');
	});

	it('should keep the newlines the text was written with', () => {
		expect(draw('one\n\ntwo', 8, '#')).to.equal('one\n\ntwo');
		expect(draw('one\ntwo', 4, '#')).to.equal('one\n#');
	});

	it('should not split a wide cluster', () => {
		// one step for the family, so there is no reveal in which half of it shows
		expect(draw(FAMILY, 0, '#')).to.equal('#');
		expect(draw(FAMILY, FAMILY.length, '#')).to.equal(FAMILY);
	});

	it('should wrap the same way a bare text does when there is no cursor', () => {
		const text = 'aaa bbb ccc ddd eee';
		expect(draw(text, text.length, undefined, 11)).to.equal('aaa bbb ccc\nddd eee');
	});

	// it carries no width of its own, because both paths that draw it are bounded
	// already: the renderer measures an auto-width canvas at the terminal and caps
	// it there, and this lays out at the width it was given
	it('should wrap at the width it is laid out in', () => {
		expect(draw('aaa bbb ccc ddd eee', 19, undefined, 11)).to.equal('aaa bbb ccc\nddd eee');
		expect(draw('aaa bbb ccc ddd eee', 19, undefined, 40)).to.equal('aaa bbb ccc ddd eee');
	});

	// the limitation the glyph design comes with, pinned rather than left to be
	// discovered: a text of nothing but spaces measures zero at `white-space:
	// normal`, which is the defect the choice list's pointer column records, so a
	// cursor has to be something that draws
	it('should draw nothing for a cursor that is whitespace', () => {
		expect(draw('ab', 1, ' ')).to.equal('a');
		expect(draw('ab', 1, '')).to.equal('a');
	});

	it.each([
		['a wide cluster', '漢'],
		['a flag', FLAG],
		['more than one character', '<>'],
	])('should draw %s as the cursor', (_name, cursor) => {
		expect(draw('ab', 1, cursor)).to.equal(`a${cursor}`);
	});

	// a cursor glyph is a character rather than an attribute over a cell, which is
	// what makes it survive the level at which the prompt's caret is deliberately
	// not drawn at all
	it('should draw the cursor at colour level 0', () => {
		expect(draw('ab', 1, '█')).to.equal('a█');
	});

	// the classes are the whole of what a theme can reach, so a rename is a theme
	// that silently stops applying. Nothing else in a build can say so: the registry
	// reads them out of the source, so it agrees with whatever the source says
	it.each(['sigil-typewriter', 'sigil-typewriter-text'])(
		'should draw the text through .%s',
		(hook) => {
			const state = typewriterState('ab');
			state.revealed.set(2);
			const themed = renderToString(typewriterView(state), {
				cascade: themedCascade({ theme: `.${hook} { color: magenta }` }),
				colorLevel: 1,
				width: 20,
			});

			expect(themed).to.equal(`${ESC}[35mab${ESC}[0m`);
		}
	);
});

describe('typewriterReveal()', () => {
	/**
	 * Runs a reveal with no renderer at all, so a timer count means its own.
	 *
	 * The facade's clock is two clocks -- a step sets a signal and the frame loop
	 * decides when that reaches the screen -- and a frame is a timer too, so a test
	 * over a renderer cannot ask "is there a step pending" without counting the
	 * renderer's answer as well. An owner over a scope whose scheduler flushes where
	 * it is asked leaves exactly one kind of timer in the process, which is the one
	 * these assertions are about. What the screen does with it is the facade's block
	 * below.
	 *
	 * @param text - What to type.
	 * @param opts - What to pass the reveal.
	 * @returns The state, and a way to let go of it.
	 */
	function drive(
		text: string,
		opts: Parameters<typeof typewriterReveal>[1] = { animate: () => true }
	): { dispose: () => void; state: TypewriterState } {
		const scope = createEffects();
		scope.setScheduler((run) => run());
		const state = typewriterState(text);
		const dispose = createRoot(
			(release) => {
				typewriterReveal(state, opts);
				return release;
			},
			scope.effect,
			(error) => {
				throw error;
			}
		);

		return { dispose, state };
	}

	it('should reveal the first chunk on the first frame', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abc');
			expect(it.state.revealed.get()).to.equal(1);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should reveal one chunk per interval', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abc', { animate: () => true, interval: 10 });

			expect(it.state.revealed.get()).to.equal(1);
			vi.advanceTimersByTime(10);
			expect(it.state.revealed.get()).to.equal(2);
			vi.advanceTimersByTime(10);
			expect(it.state.revealed.get()).to.equal(3);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	// the last chunk schedules nothing, so a finished typewriter holds no timer and
	// a CLI that prints one line never acquires a frame loop
	it('should hold no timer once there is nothing left to reveal', () => {
		vi.useFakeTimers();
		try {
			const it = drive('ab', { animate: () => true, interval: 10 });
			expect(vi.getTimerCount()).to.equal(1);

			vi.advanceTimersByTime(10);
			expect(it.state.revealed.get()).to.equal(2);
			expect(vi.getTimerCount()).to.equal(0);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should hold no timer for a single chunk', () => {
		vi.useFakeTimers();
		try {
			const it = drive('a', { animate: () => true, interval: 10 });
			expect(it.state.revealed.get()).to.equal(1);
			expect(vi.getTimerCount()).to.equal(0);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should hold no timer and reveal everything where nothing should move', () => {
		vi.useFakeTimers();
		try {
			const it = drive('hello', { animate: () => false, interval: 10 });
			expect(it.state.revealed.get()).to.equal(5);
			expect(vi.getTimerCount()).to.equal(0);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should reveal everything at once for an empty text', () => {
		vi.useFakeTimers();
		try {
			const it = drive('', { animate: () => true, interval: 10 });
			expect(it.state.revealed.get()).to.equal(0);
			expect(vi.getTimerCount()).to.equal(0);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should let go of its timer when it is disposed', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef', { animate: () => true, interval: 10 });
			expect(vi.getTimerCount()).to.equal(1);

			it.dispose();
			expect(vi.getTimerCount()).to.equal(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should take the pace a caller supplies, per chunk', () => {
		vi.useFakeTimers();
		try {
			const seen: string[] = [];
			const it = drive('a.b', {
				animate: () => true,
				pace: (chunk) => {
					seen.push(chunk);
					return chunk === '.' ? 100 : 10;
				},
			});

			// the delay before a chunk is the one the chunk in front of it earned, so
			// the pause belongs to the chunk that ends with the full stop
			vi.advanceTimersByTime(10);
			expect(it.state.revealed.get()).to.equal(2);
			vi.advanceTimersByTime(99);
			expect(it.state.revealed.get()).to.equal(2);
			vi.advanceTimersByTime(1);
			expect(it.state.revealed.get()).to.equal(3);

			// and the last chunk's delay is never asked for, because nothing follows it
			expect(seen).to.deep.equal(['a', '.']);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should hand the pace the index of the chunk whose delay it is', () => {
		vi.useFakeTimers();
		try {
			const seen: number[] = [];
			const it = drive('abc', {
				animate: () => true,
				pace: (_chunk, index) => {
					seen.push(index);
					return 10;
				},
			});

			vi.advanceTimersByTime(30);
			expect(seen).to.deep.equal([0, 1]);
			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['a negative delay', -50],
		['zero', 0],
	])('should take %s as no wait at all', (_name, delay) => {
		vi.useFakeTimers();
		try {
			const it = drive('abc', { animate: () => true, pace: () => delay });

			vi.advanceTimersToNextTimer();
			expect(it.state.revealed.get()).to.equal(2);
			vi.advanceTimersToNextTimer();
			expect(it.state.revealed.get()).to.equal(3);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	// `NaN` would schedule immediately and reveal the whole text in one macrotask,
	// which is the one failure that looks like the feature being broken
	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
	])('should fall back to the interval for a pace of %s', (_name, delay) => {
		vi.useFakeTimers();
		try {
			const it = drive('abc', { animate: () => true, interval: 25, pace: () => delay });

			vi.advanceTimersByTime(24);
			expect(it.state.revealed.get()).to.equal(1);
			vi.advanceTimersByTime(1);
			expect(it.state.revealed.get()).to.equal(2);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['a negative interval', -5, 40],
		['a NaN interval', Number.NaN, 40],
		// `Infinity >= 0` is true, so a bare comparison let this through and
		// `setTimeout` read it as 1: an interval asking for "never" got "as fast as
		// possible", which is the opposite answer
		['an infinite interval', Number.POSITIVE_INFINITY, 40],
	])('should fall back to the default for %s', (_name, interval, expected) => {
		vi.useFakeTimers();
		try {
			const it = drive('abc', { animate: () => true, interval });

			vi.advanceTimersByTime(expected - 1);
			expect(it.state.revealed.get()).to.equal(1);
			vi.advanceTimersByTime(1);
			expect(it.state.revealed.get()).to.equal(2);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * The one piece of caller code the timer must not run.
	 *
	 * A `pace` that throws from inside a `setTimeout` is an uncaught exception: node
	 * prints a stack and the process goes, which skips the renderer's teardown and is
	 * the opposite of the rule that a CLI shows a message. Proved before it was fixed,
	 * with real timers: the reveal stopped four characters in and vitest reported an
	 * unhandled error. Asserted here as the structural property instead of as the
	 * crash, because the crash is not something a test can survive asking for.
	 */
	it('should ask the pace nothing from inside a timer', () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const it = drive('abcdef', {
				animate: () => true,
				pace: () => {
					calls++;
					return 10;
				},
			});

			// every chunk but the last, taken when the steps were
			expect(calls).to.equal(5);

			vi.advanceTimersByTime(100);
			expect(it.state.revealed.get()).to.equal(6);
			expect(calls).to.equal(5);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should re-chunk no more than once per text change', () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const counted = (value: string): string[] => {
				calls++;
				return graphemes(value);
			};
			const it = drive('abcdefgh', { animate: () => true, chunk: counted, interval: 1 });

			// a reveal that re-chunked per step would be quadratic in the length of
			// the text, for an answer that cannot have changed
			vi.advanceTimersByTime(100);
			expect(it.state.revealed.get()).to.equal(8);
			expect(calls).to.equal(1);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should take a chunker that loses characters', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef', {
				animate: () => true,
				chunk: (value) => [value.slice(0, 2)],
				interval: 10,
			});

			expect(it.state.revealed.get()).to.equal(2);
			vi.advanceTimersByTime(10);
			// the forced last step is what keeps a lossy chunker from stranding the
			// reveal one character short with the cursor still on
			expect(it.state.revealed.get()).to.equal(6);

			it.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	describe('when the text changes under it', () => {
		it('should continue from where it had got to when the text is extended', () => {
			vi.useFakeTimers();
			try {
				const it = drive('ab', { animate: () => true, interval: 10 });
				vi.advanceTimersByTime(10);
				expect(it.state.revealed.get()).to.equal(2);

				it.state.text.set('abcd');
				expect(it.state.revealed.get()).to.equal(2);

				vi.advanceTimersByTime(10);
				expect(it.state.revealed.get()).to.equal(3);

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		// restarting instead would retype the whole answer on every token a stream
		// appends, which is the case this exists for
		it('should not retype what is already on screen', () => {
			vi.useFakeTimers();
			try {
				const it = drive('ab', { animate: () => true, interval: 10 });
				vi.advanceTimersByTime(10);

				// exactly where it was, rather than merely no further back: an append
				// that moved the position at all would be revealing early, and `>=`
				// would have held for that as readily as for the right answer
				const before = it.state.revealed.get();
				for (const more of ['c', 'd', 'e']) {
					it.state.text.set(it.state.text.get() + more);
					expect(it.state.revealed.get()).to.equal(before);
				}

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should re-reveal from the point where the two texts part', () => {
			vi.useFakeTimers();
			try {
				const it = drive('abcdef', { animate: () => true, interval: 10 });
				vi.advanceTimersByTime(50);
				expect(it.state.revealed.get()).to.equal(6);

				it.state.text.set('abXYZ');
				// `ab` is still right, so it stays; everything after it is new
				expect(it.state.revealed.get()).to.equal(2);

				vi.advanceTimersByTime(10);
				expect(it.state.revealed.get()).to.equal(3);

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should clamp back when the text gets shorter', () => {
			vi.useFakeTimers();
			try {
				const it = drive('abcdef', { animate: () => true, interval: 10 });
				vi.advanceTimersByTime(50);

				it.state.text.set('ab');
				expect(it.state.revealed.get()).to.equal(2);
				expect(vi.getTimerCount()).to.equal(0);

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		/**
		 * The case that made the position an offset rather than a count of chunks.
		 *
		 * Typing a combining mark onto an `a` that is already on screen makes the two
		 * one cluster, so a position of 1 is a cluster boundary that has stopped being
		 * one. The reveal has to snap forward to the end of the step it fell into; the
		 * first version gave up instead and stalled for the rest of the process.
		 */
		it('should not stall when a chunk boundary stops being one', () => {
			vi.useFakeTimers();
			try {
				const it = drive('ab', { animate: () => true, interval: 10 });
				expect(it.state.revealed.get()).to.equal(1);

				it.state.text.set(`a${ACUTE}b`);
				// the accented `a` is one cluster two code units long
				expect(it.state.revealed.get()).to.equal(2);

				vi.advanceTimersByTime(10);
				expect(it.state.revealed.get()).to.equal(3);

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		/**
		 * Swapping one emoji for another leaves the position on the surrogate the two
		 * share, which is not a boundary of either text.
		 *
		 * Measured before it was fixed: the frame drew a lone high surrogate for one
		 * step and the next step repaired it. Moving the position forward to the end of
		 * the step it fell inside is what closes it, and it is the same rule the
		 * combining mark needs -- which is why it is one rule rather than a special
		 * case for the first step.
		 */
		it('should never leave half a cluster on screen', () => {
			vi.useFakeTimers();
			try {
				const it = drive('x\u{1F600}', { animate: () => true, interval: 10 });
				vi.advanceTimersByTime(10);
				expect(it.state.revealed.get()).to.equal(3);

				it.state.text.set('x\u{1F601}');

				// `x` plus the high surrogate is what the two share; the step it fell
				// inside ends past it
				expect(it.state.revealed.get()).to.equal(3);
				expect(it.state.text.get().slice(0, it.state.revealed.get())).to.equal('x\u{1F601}');

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should restart from nothing when the first character changed', () => {
			vi.useFakeTimers();
			try {
				const it = drive('abc', { animate: () => true, interval: 10 });
				vi.advanceTimersByTime(20);
				expect(it.state.revealed.get()).to.equal(3);

				it.state.text.set('xyz');
				expect(it.state.revealed.get()).to.equal(1);

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should reveal the whole of a changed text at once where nothing moves', () => {
			vi.useFakeTimers();
			try {
				const it = drive('ab', { animate: () => false });
				expect(it.state.revealed.get()).to.equal(2);

				it.state.text.set('abcdef');
				expect(it.state.revealed.get()).to.equal(6);
				expect(vi.getTimerCount()).to.equal(0);

				it.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should finish the reveal when it stops being allowed to animate', () => {
			vi.useFakeTimers();
			try {
				const running = new State(true);
				const state = typewriterState('abcdef');
				const scope = createEffects();
				scope.setScheduler((run) => run());
				const dispose = createRoot(
					(release) => {
						typewriterReveal(state, { animate: () => running.get(), interval: 10 });
						return release;
					},
					scope.effect,
					(error) => {
						throw error;
					}
				);

				expect(state.revealed.get()).to.equal(1);
				running.set(false);

				// which is how `done()` finishes: turning it off is the one path, rather
				// than a second mechanism that writes the position itself
				expect(state.revealed.get()).to.equal(6);
				expect(vi.getTimerCount()).to.equal(0);

				dispose();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	/**
	 * A `pace` that writes the position is the last word, not the first.
	 *
	 * The effect used to compute where to go from a position read *before* it ran
	 * the caller's code, and then write it -- so a `skip()` from inside a `pace`
	 * was set and immediately undone, and the reveal carried on typing. Settling the
	 * position before the delays are asked for is the fix, and the ordering is the
	 * whole of it.
	 */
	it('should let a pace that moves the position have the last word', () => {
		vi.useFakeTimers();
		try {
			const state = typewriterState('hello');
			const scope = createEffects();
			scope.setScheduler((run) => run());
			const dispose = createRoot(
				(release) => {
					typewriterReveal(state, {
						animate: () => true,
						interval: 10,
						pace: () => {
							state.revealed.set(state.text.get().length);
							return 10;
						},
					});
					return release;
				},
				scope.effect,
				(error) => {
					throw error;
				}
			);

			expect(state.revealed.get()).to.equal(5);
			expect(vi.getTimerCount()).to.equal(0);

			vi.advanceTimersByTime(100);
			expect(state.revealed.get()).to.equal(5);

			dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should not be undone by a step that was already in flight', () => {
		vi.useFakeTimers();
		try {
			const it = drive('abcdef', { animate: () => true, interval: 10 });
			expect(it.state.revealed.get()).to.equal(1);

			// a skip, with a timer armed for the step after `a`
			it.state.revealed.set(6);

			// exactly one interval, which is what makes this say anything: a step that
			// had captured where it was going writes a position behind the skip and
			// then schedules, so advancing far enough lets it catch back up to the end
			// -- the first version of this advanced 100ms and passed with the text
			// having come back off the screen and gone on again
			vi.advanceTimersByTime(10);
			expect(it.state.revealed.get()).to.equal(6);
			expect(vi.getTimerCount()).to.equal(0);

			vi.advanceTimersByTime(100);
			expect(it.state.revealed.get()).to.equal(6);

			it.dispose();
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

			const it = drive('abc', { animate: () => true, interval: 10 });
			expect(unreffed).to.equal(1);

			it.dispose();
			spy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('createTypewriter()', () => {
	it('should draw nothing until it is started', () => {
		const ui = screenSetup();
		createTypewriter({ ansi: ui.ansi, terminal: ui.terminal, text: 'Hello' });

		expect(ui.log).to.deep.equal([]);
	});

	it('should draw the first chunk when started', () => {
		const ui = screenSetup();
		createTypewriter({ ansi: ui.ansi, frameMs: 0, terminal: ui.terminal, text: 'Hello' }).start();

		expect(ui.frame).to.equal('H');
	});

	it('should type a chunk per interval', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'Hi',
			}).start();

			expect(ui.frame).to.equal('H');
			type(10);
			expect(ui.frame).to.equal('Hi');
		} finally {
			vi.useRealTimers();
		}
	});

	it('should type by word when asked to', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			createTypewriter({
				ansi: ui.ansi,
				chunk: byWord,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'one two',
			}).start();

			expect(ui.frame).to.equal('one');
			type(10);
			expect(ui.frame).to.equal('one two');
		} finally {
			vi.useRealTimers();
		}
	});

	it('should take the text from start()', () => {
		const ui = screenSetup();
		const it = createTypewriter({ ansi: ui.ansi, frameMs: 0, terminal: ui.terminal }).start('Hey');

		expect(it.text).to.equal('Hey');
		expect(ui.frame).to.equal('H');
	});

	it('should reveal the rest on skip()', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'Hello',
			}).start();

			expect(it.revealing).to.equal(true);
			it.skip();

			expect(ui.frame).to.equal('Hello');
			expect(it.revealed).to.equal('Hello');
			expect(it.revealing).to.equal(false);
			// the pending step must not put it back
			type(100);
			expect(ui.frame).to.equal('Hello');
		} finally {
			vi.useRealTimers();
		}
	});

	it('should keep typing after a skip when more arrives', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'ab',
			}).start();

			it.skip();
			it.append('cd');

			expect(it.revealed).to.equal('ab');
			expect(it.revealing).to.equal(true);
			type(10);
			expect(ui.frame).to.equal('abc');
		} finally {
			vi.useRealTimers();
		}
	});

	// there is no guard for either of these: the signal refuses an equal write, so
	// what used to be a guard was a guard that could not fire. The properties are
	// asserted instead, which is what the guards were standing for
	it('should change nothing on an append of nothing', () => {
		const { ansi, stdout, terminal } = setup({ isTTY: false });
		const it = createTypewriter({ ansi, terminal, text: 'ab' }).start();

		it.append('');
		it.append('');

		expect(it.text).to.equal('ab');
		expect(stdout.text).to.equal('ab\n');
	});

	// a skip before there is anything to skip is a skip of nothing, so the reveal
	// that follows starts where a reveal starts. The position is kept per mount, and
	// nothing was mounted
	it('should type from the beginning when it is started after a skip', () => {
		const ui = screenSetup();
		const it = createTypewriter({
			ansi: ui.ansi,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'abc',
		});

		it.skip();
		expect(ui.log).to.deep.equal([]);

		it.start();
		expect(it.revealed).to.equal('a');
	});

	it('should change nothing on a second start()', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'abc',
			}).start();

			type(10);
			expect(it.revealed).to.equal('ab');

			// a restart would retype from the beginning, and rescheduling would stall
			// the step that is already pending
			it.start();
			expect(it.revealed).to.equal('ab');
			type(10);
			expect(it.revealed).to.equal('abc');
		} finally {
			vi.useRealTimers();
		}
	});

	it('should leave the whole text behind on done()', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'Hello',
			}).start();

			it.done();

			expect(ui.frame).to.equal('Hello');
			expect(it.revealing).to.equal(false);
			expect(vi.getTimerCount()).to.equal(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should leave the text done() was handed, whole', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'Hello',
			}).start();

			// the new text shares no prefix with what is on screen, so a reveal still
			// running would clamp back and leave a truncated line in the log
			it.done('Goodbye now');

			expect(ui.frame).to.equal('Goodbye now');
		} finally {
			vi.useRealTimers();
		}
	});

	it('should leave its text on a done() it was never started for', () => {
		const ui = screenSetup();
		createTypewriter({ ansi: ui.ansi, frameMs: 0, terminal: ui.terminal, text: 'Hello' }).done();

		expect(ui.frame).to.equal('Hello');
	});

	it('should erase on stop()', () => {
		const ui = screenSetup();
		const it = createTypewriter({
			ansi: ui.ansi,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'Hello',
		}).start();

		it.stop();

		expect(ui.log).to.deep.equal([]);
		expect(it.revealing).to.equal(false);
	});

	it('should mount again when started after it finished', () => {
		const ui = screenSetup();
		const it = createTypewriter({
			ansi: ui.ansi,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'ab',
		}).start();

		it.done();
		it.start('cd');

		expect(ui.frame).to.equal('c');
	});

	it('should draw a cursor while it is typing and not after', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				cursor: '█',
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'ab',
			}).start();

			expect(ui.frame).to.equal('a█');
			type(10);
			expect(ui.frame).to.equal('ab');
			it.done();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should report what is on screen', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'abc',
			}).start();

			expect(it.revealed).to.equal('a');
			type(10);
			expect(it.revealed).to.equal('ab');
		} finally {
			vi.useRealTimers();
		}
	});

	it('should not be revealing before it is started', () => {
		const ui = screenSetup();
		const it = createTypewriter({ ansi: ui.ansi, terminal: ui.terminal, text: 'abc' });

		expect(it.revealing).to.equal(false);
	});

	it('should re-reveal from the common prefix when the text is assigned', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'abcd',
			}).start();

			type(10);
			expect(it.revealed).to.equal('ab');

			it.text = 'abZZ';
			expect(it.revealed).to.equal('ab');
			expect(ui.frame).to.equal('ab');
		} finally {
			vi.useRealTimers();
		}
	});

	// the other half of the entry above: a pace that starts throwing once the
	// renderer is up is reported where a component's throw is reported, rather than
	// escaping into a timer nothing is watching
	it('should report a pace that throws after it is mounted', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			const errors: unknown[] = [];
			let armed = false;
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				onError: (error) => errors.push(error),
				pace: () => {
					if (armed) {
						throw new Error('pace boom');
					}
					return 10;
				},
				terminal: ui.terminal,
				text: 'abcd',
			}).start();

			type(30);
			expect(it.revealed).to.equal('abcd');
			expect(errors).to.deep.equal([]);

			armed = true;
			it.append('efgh');

			expect(errors.map(String)).to.deep.equal(['Error: pace boom']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should write a line above the frame', () => {
		const ui = screenSetup();
		const it = createTypewriter({
			ansi: ui.ansi,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'Hello',
		}).start();

		it.write('a line that stays');

		expect(ui.log).to.contain('a line that stays');
	});

	// nothing in the suite asked this before, and the mount is where a theme and a
	// colour level have to arrive: a cascade built from nothing would draw every
	// built-in at the framework's defaults with the caller's sheet dropped
	it('should draw through the theme it was given', () => {
		const ui = screenSetup();
		createTypewriter({
			colorLevel: 1,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'ab',
			theme: '.sigil-typewriter-text { color: magenta }',
		})
			.start()
			.done();

		expect(ui.output).to.contain(`${ESC}[35m`);
	});

	it('should write a line with nothing mounted', () => {
		const { ansi, stdout, terminal } = setup();
		createTypewriter({ ansi, terminal, text: 'Hello' }).write('standalone');

		expect(stdout.text).to.equal('standalone\n');
	});

	it('should wrap within the terminal rather than past it', () => {
		const ui = screenSetup({ columns: 11 });
		const it = createTypewriter({
			ansi: ui.ansi,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'aaa bbb ccc ddd',
		}).start();

		it.skip();

		expect(ui.log.filter((line) => line !== '')).to.deep.equal(['aaa bbb ccc', 'ddd']);
	});

	// the canvas is capped at the terminal either way, so a word that keeps its own
	// width is one cut off at the canvas edge rather than broken
	it('should break a word longer than the terminal rather than losing its tail', () => {
		const ui = screenSetup({ columns: 6 });
		const it = createTypewriter({
			ansi: ui.ansi,
			frameMs: 0,
			terminal: ui.terminal,
			text: 'supercalifragilistic',
		}).start();

		it.skip();

		expect(ui.log.filter((line) => line !== '').join('')).to.equal('supercalifragilistic');
	});

	describe('with no terminal', () => {
		it('should start no timer', () => {
			vi.useFakeTimers();
			try {
				const { ansi, terminal } = setup({ isTTY: false });
				createTypewriter({ ansi, interval: 10, terminal, text: 'Hello' }).start();

				expect(vi.getTimerCount()).to.equal(0);
			} finally {
				vi.useRealTimers();
			}
		});

		// losing this means a build log with one line per keystroke
		it('should write the whole text at once', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			const it = createTypewriter({ ansi, interval: 10, terminal, text: 'Hello there' }).start();
			it.done();

			expect(stdout.text).to.equal('Hello there\n');
		});

		it('should write one line per change rather than one per character', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			const it = createTypewriter({ ansi, terminal, text: 'one' }).start();
			it.append(' two');
			it.done();

			expect(stdout.text).to.equal('one\none two\n');
		});

		it('should draw no cursor', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			createTypewriter({ ansi, cursor: '█', terminal, text: 'Hi' }).start().done();

			expect(stdout.text).to.equal('Hi\n');
		});
	});

	describe('under a reduced-motion opt-out', () => {
		// a screen that exists and a preference that says nothing should move is the
		// same question as a pipe, which is why one flag answers both
		it('should reveal the whole text at once', () => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup();
				createTypewriter({
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					reducedMotion: 'reduce',
					terminal: ui.terminal,
					text: 'Hello',
				}).start();

				expect(ui.frame).to.equal('Hello');
				expect(vi.getTimerCount()).to.equal(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should still type where the preference says nothing', () => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup();
				createTypewriter({
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					reducedMotion: 'no-preference',
					terminal: ui.terminal,
					text: 'Hello',
				}).start();

				expect(ui.frame).to.equal('H');
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('over the clusters a column sweep would cut up', () => {
		it.each([
			['a ZWJ sequence', FAMILY],
			['a flag', FLAG],
			['a keycap', KEYCAP],
		])('should reveal %s whole or not at all', (_name, cluster) => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup();
				createTypewriter({
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					terminal: ui.terminal,
					text: `${cluster}x`,
				}).start();

				expect(ui.frame).to.equal(cluster);
				type(10);
				expect(ui.frame).to.equal(`${cluster}x`);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should reveal a combining mark with the letter it sits on', () => {
			vi.useFakeTimers();
			try {
				const ui = screenSetup();
				createTypewriter({
					ansi: ui.ansi,
					frameMs: 0,
					interval: 10,
					terminal: ui.terminal,
					text: `a${ACUTE}b`,
				}).start();

				expect(ui.frame).to.equal(`a${ACUTE}`);
				type(10);
				expect(ui.frame).to.equal(`a${ACUTE}b`);
			} finally {
				vi.useRealTimers();
			}
		});

		// a cluster of no width is a step in which nothing changes, which is what
		// typing a lone mark looks like and is not something to refuse.
		//
		// The step has to be asserted as well as the blank screen: a blank screen is
		// what a `start()` that did nothing at all also leaves, so on its own this
		// said only "no throw and no garbage"
		it('should take a lone combining mark', () => {
			const ui = screenSetup();
			const it = createTypewriter({
				ansi: ui.ansi,
				frameMs: 0,
				terminal: ui.terminal,
				text: ACUTE,
			}).start();

			expect(it.revealed).to.equal(ACUTE);
			expect(it.revealing).to.equal(false);
			expect(ui.log.join('')).to.equal('');
		});
	});
});
