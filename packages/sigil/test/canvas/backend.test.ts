import {
	createFullscreenCanvas,
	createInlineCanvas,
	maskThreshold,
	wipeMask,
} from '../../src/canvas/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { Screen, screenStream } from './screen.js';
import { describe, expect, it } from 'vitest';

/**
 * The backends, replayed against a screen rather than asserted as bytes.
 *
 * What a backend claims is "after these frames, this is what the user is looking
 * at", and the interesting half of that claim is the part the canvas cannot see:
 * the log above the region, which scrolls, and the rows below it, which do not
 * exist until something has made room for them.
 */

interface Harness {
	screen: Screen;
	stream: ReturnType<typeof screenStream>;
	terminal: Terminal;
}

function harness(width = 20, height = 6): Harness {
	const screen = new Screen(width, height);
	const stream = screenStream(screen);
	const terminal = createTerminal({
		env: {},
		isTTY: true,
		// nothing here installs signal handlers on the real process
		proc: { on() {}, pid: 1, removeListener() {} } as never,
		// the screen stands in for both, so the guard a terminal puts on its
		// streams lands here rather than on the process's own stderr -- a listener
		// per terminal, and a suite builds a great many of them
		stderr: stream as never,
		stdin: undefined,
		stdout: stream as never,
	});
	return { screen, stream, terminal };
}

/** A canvas painted with one line of text per row, for reading back. */
const lines =
	(...rows: string[]) =>
	(painter: { text: (x: number, y: number, s: string) => unknown }) => {
		for (const [y, row] of rows.entries()) {
			painter.text(0, y, row);
		}
	};

describe('the inline backend', () => {
	it('should make room for its rows before painting into them', () => {
		// downward movement is CUD, which stops at the bottom margin and never
		// scrolls -- so a canvas rendered with the cursor on the last row of the
		// screen would paint every one of its rows onto that line. The newlines are
		// what scroll the log up to make room
		const { screen, terminal } = harness(20, 4);
		terminal.write('one\r\ntwo\r\nthree\r\n');
		expect(screen.row).toBe(3);

		const backend = createInlineCanvas({ height: 3, terminal });
		backend.render(lines('a', 'b', 'c'));

		// the log scrolled up by the two rows the region needed beyond the one it
		// was standing on, and every row of the frame is on a row of its own
		expect(screen.written).toEqual(['one', 'two', 'three', 'a', 'b', 'c']);
	});

	it('should repaint in place rather than below itself', () => {
		const { screen, terminal } = harness(20, 6);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 2, terminal });

		backend.render(lines('first', 'second'));
		backend.render(lines('third', 'fourth'));
		backend.render(lines('fifth', 'sixth'));

		expect(screen.written).toEqual(['log', 'fifth', 'sixth']);
	});

	it('should write above the region and keep the region below it', () => {
		const { screen, terminal } = harness(20, 6);
		const backend = createInlineCanvas({ height: 2, terminal });

		backend.render(lines('spin', 'bar'));
		backend.write('a line that stays');
		backend.write('and another');

		expect(screen.written).toEqual(['a line that stays', 'and another', 'spin', 'bar']);
	});

	it('should leave the frame and put the cursor below it on done()', () => {
		const { screen, terminal } = harness(20, 6);
		const backend = createInlineCanvas({ height: 2, terminal });

		backend.render(lines('done', 'here'));
		backend.done();
		terminal.write('after\r\n');

		expect(screen.written).toEqual(['done', 'here', 'after']);
	});

	it('should leave nothing behind on stop()', () => {
		const { screen, terminal } = harness(20, 6);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 2, terminal });

		backend.render(lines('going', 'away'));
		backend.stop();
		terminal.write('after\r\n');

		expect(screen.written).toEqual(['log', 'after']);
	});

	it('should scroll the log to grow, and repaint whole', () => {
		const { screen, terminal } = harness(20, 6);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 1, terminal });

		backend.render(lines('one'));
		backend.resize(20, 3);
		backend.render(lines('one', 'two', 'three'));

		expect(screen.written).toEqual(['log', 'one', 'two', 'three']);
	});

	it('should repaint at the new width when the terminal resizes', () => {
		const { screen, stream, terminal } = harness(20, 6);
		const backend = createInlineCanvas({ height: 1, terminal });

		backend.render(lines('hello'));
		expect(backend.width).toBe(20);

		stream.resize(10, 6);
		// the canvas follows the screen, because a canvas wider than the screen is
		// one whose rows the terminal wraps -- and a wrapped row is a row the cursor
		// arithmetic does not know about
		expect(backend.width).toBe(10);

		backend.render(lines('hello again'));
		expect(screen.written).toEqual(['hello agai']);
	});

	it('should keep a width it was given', () => {
		const { stream, terminal } = harness(20, 6);
		const backend = createInlineCanvas({ height: 1, terminal, width: 8 });

		backend.render(lines('hi'));
		stream.resize(40, 6);
		expect(backend.width).toBe(8);
	});

	it('should hide the cursor while it draws and put it back', () => {
		const { screen, terminal } = harness(20, 6);
		const backend = createInlineCanvas({ height: 1, terminal });

		backend.render(lines('x'));
		expect(screen.cursorHidden).toBe(true);
		backend.done();
		expect(screen.cursorHidden).toBe(false);
	});

	it('should give the region up when something else claims it', () => {
		const { screen, terminal } = harness(20, 6);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 2, terminal });
		backend.render(lines('mine', 'still'));

		// a prompt, say, which is a second holder of a claim that has one
		terminal.claimLive();

		expect(backend.active).toBe(false);
		// erased on the way out, so the evictor starts on a clean line
		expect(screen.written).toEqual(['log']);

		// and an evicted backend does not take the screen back
		backend.render(lines('not', 'mine'));
		expect(screen.written).toEqual(['log']);
	});

	it('should collapse a transition to its end state when this is not a terminal', () => {
		// a pipe has no frames, so a dissolve there would be one line of
		// half-dissolved content per tick down a log file -- the failure the
		// reduced-motion rule names one layer up, where an animation with no screen
		// to play on is "one that has already finished".
		//
		// It falls out rather than being arranged, and that is the part worth
		// pinning: the plain path writes text and deliberately never calls
		// `canvas.present()`, because there is nothing to repaint -- so `front` is
		// never written, `snapshot()` holds nothing, a layer over it has no occupied
		// cell to composite, and every frame is the new state. A caller gets the end
		// state and one line of log, with the same six lines of transition code that
		// dissolves on a terminal.
		const chunks: string[] = [];
		const terminal = createTerminal({
			env: {},
			isTTY: false,
			proc: { on() {}, pid: 1, removeListener() {} } as never,
			stdin: undefined,
			stdout: { write: (chunk: string) => void chunks.push(chunk) } as never,
		});
		const backend = createInlineCanvas({ height: 1, terminal, width: 4 });
		const { canvas } = backend;

		backend.render(lines('old.'));
		expect(canvas.snapshot().toString()).toBe('');

		const mask = wipeMask(4, 1, 'left');
		canvas.layers.push({ cells: canvas.snapshot(), mask, x: 0, y: 0 });
		for (let step = 4; step >= 0; step--) {
			mask.threshold = maskThreshold(step / 4);
			backend.render(lines('new.'));
		}
		canvas.layers.length = 0;

		expect(
			chunks
				.join('')
				.split('\n')
				.filter(Boolean)
				.map((line) => line.trimEnd())
		).toEqual(['old.', 'new.']);
	});

	it('should write plain frames when this is not a terminal', () => {
		// a pipe, a file, a CI log: no cursor to move and nothing to repaint, so
		// this is captured as bytes rather than replayed onto a screen
		const chunks: string[] = [];
		const terminal = createTerminal({
			env: {},
			isTTY: false,
			proc: { on() {}, pid: 1, removeListener() {} } as never,
			stdin: undefined,
			stdout: { write: (chunk: string) => void chunks.push(chunk) } as never,
		});
		const backend = createInlineCanvas({ height: 1, terminal });

		backend.render(lines('working'));
		// the same frame twice is not two lines down a log file
		backend.render(lines('working'));
		backend.render(lines('done'));

		// no escape sequences, no carriage returns, one line per change
		const out = chunks.join('');
		expect(out).not.toContain('\u001B');
		expect(out).not.toContain('\r');
		expect(
			out
				.split('\n')
				.filter(Boolean)
				.map((line) => line.trimEnd())
		).toEqual(['working', 'done']);
	});
});

describe('the full-screen backend', () => {
	it('should draw on the alternate screen and leave the log alone', () => {
		const { screen, terminal } = harness(20, 4);
		terminal.write('log line\r\n');

		const backend = createFullscreenCanvas({ terminal });
		backend.render(lines('dashboard', 'second row'));

		expect(screen.alternate).toBe(true);
		expect(screen.viewport).toEqual(['dashboard', 'second row', '', '']);

		backend.stop();

		// back on the main screen, with the log exactly as it was found
		expect(screen.alternate).toBe(false);
		expect(screen.written).toEqual(['log line']);
	});

	it('should size itself to the screen and follow it', () => {
		const { stream, terminal } = harness(20, 4);
		const backend = createFullscreenCanvas({ terminal });

		backend.render(lines('x'));
		expect([backend.width, backend.height]).toEqual([20, 4]);

		stream.resize(30, 8);
		expect([backend.width, backend.height]).toEqual([30, 8]);
	});

	it('should hold what was written and flush it to the main screen', () => {
		// the alternate buffer has no scrollback and is thrown away wholesale when
		// it is left, so there is no "above the region" to write to. Held rather
		// than dropped: a log line the app thought it wrote is worse than a late one
		const { screen, terminal } = harness(20, 4);
		const backend = createFullscreenCanvas({ terminal });

		backend.render(lines('running'));
		backend.write('something happened');
		expect(screen.viewport).toEqual(['running', '', '', '']);

		backend.done();
		expect(screen.written).toEqual(['something happened']);
	});

	it('should come back from the alternate screen however the process ends', () => {
		// a CLI that dies on the alternate buffer and never comes back has eaten
		// the user's terminal, so leaving it is `restore()`'s, next to the cursor
		// and raw mode, rather than something a backend has to remember
		const { screen, terminal } = harness(20, 4);
		const backend = createFullscreenCanvas({ terminal });

		backend.render(lines('oh no'));
		expect(screen.alternate).toBe(true);

		terminal.restore();
		expect(screen.alternate).toBe(false);
		expect(screen.cursorHidden).toBe(false);
	});
});

/**
 * Where a canvas sits, which is the one thing a mouse report needs and a canvas
 * deliberately does not know.
 *
 * Read back off the screen model rather than asserted as arithmetic: the claim is
 * that a report naming the cell a glyph is on translates to the coordinate that
 * glyph was painted at, and only a model with a cursor in it can say that.
 */
describe('translating a screen coordinate', () => {
	/** A cursor position report, one-based, as a terminal would answer it. */
	const probe = (screen: Screen) => () =>
		Promise.resolve({ column: screen.column + 1, row: screen.row + 1 });

	it('should be free for a full-screen canvas', async () => {
		// the alternate buffer starts at the top-left of the screen, so there is
		// nothing to ask and no round trip to pay
		const { screen, terminal } = harness(20, 6);
		const backend = createFullscreenCanvas({ terminal });
		backend.render(lines('a', 'b'));

		expect(backend.origin).toEqual({ x: 0, y: 0 });
		expect(await backend.locate(probe(screen))).toBe(true);
		expect(backend.toCanvas(1, 1)).toEqual({ x: 0, y: 0 });
		expect(backend.toCanvas(5, 3)).toEqual({ x: 4, y: 2 });
	});

	it('should not answer for an inline canvas until it has asked', async () => {
		const { screen, terminal } = harness(20, 6);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 2, terminal });

		// nothing on screen to be relative to: the rows are not reserved yet, so the
		// cursor is wherever the log left it and says nothing about a canvas. And the
		// probe is never *called*, which is the observable half -- a round trip whose
		// answer cannot be used is one not worth writing
		let asked = 0;
		const counted = () => {
			asked++;
			return probe(screen)();
		};

		expect(await backend.locate(counted)).toBe(false);
		expect(asked).toBe(0);
		expect(backend.origin).toBeUndefined();
		expect(backend.toCanvas(1, 1)).toBeUndefined();
	});

	it('should find the row the inline canvas was actually painted on', async () => {
		const { screen, terminal } = harness(20, 6);
		terminal.write('one\r\ntwo\r\n');
		const backend = createInlineCanvas({ height: 2, terminal });
		backend.render(lines('top', 'bottom'));

		expect(screen.written).toEqual(['one', 'two', 'top', 'bottom']);
		expect(await backend.locate(probe(screen))).toBe(true);
		// two rows of log above it, so the canvas's first row is screen row three
		expect(backend.origin).toEqual({ x: 0, y: 2 });
		expect(backend.toCanvas(1, 3)).toEqual({ x: 0, y: 0 });
		expect(backend.toCanvas(1, 4)).toEqual({ x: 0, y: 1 });
	});

	it('should translate a point outside the canvas rather than refusing it', () => {
		// whether a point is on the canvas is the router's question, because that is
		// where the capture rule lives: a drag that wandered off the region still
		// reports to whatever the press landed on, and it needs the coordinate to do it
		const { terminal } = harness(20, 6);
		const backend = createFullscreenCanvas({ terminal });
		expect(backend.toCanvas(1, 1)).toEqual({ x: 0, y: 0 });
		expect(backend.toCanvas(40, 30)).toEqual({ x: 39, y: 29 });
	});

	it('should forget where it is when the rows are given up', async () => {
		const { screen, terminal } = harness(20, 8);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 2, terminal });
		backend.render(lines('a', 'b'));
		await backend.locate(probe(screen));
		expect(backend.origin).toEqual({ x: 0, y: 1 });

		// a line written above the region is one of the three things that throws the
		// anchor away, and the canvas is a row further down afterwards
		backend.write('another log line');
		expect(backend.origin).toBeUndefined();

		await backend.locate(probe(screen));
		expect(backend.origin).toEqual({ x: 0, y: 2 });
	});

	it('should forget where it is on a resize', async () => {
		const { screen, terminal } = harness(20, 8);
		const backend = createInlineCanvas({ height: 2, terminal });
		backend.render(lines('a', 'b'));
		await backend.locate(probe(screen));
		expect(backend.origin).toEqual({ x: 0, y: 0 });

		backend.resize(20, 3);
		expect(backend.origin).toBeUndefined();
	});

	it('should refuse a reply that describes an anchor which has since gone', async () => {
		// a cursor report comes back a round trip later, so the position it names is
		// where the cursor was when the query went out. A frame in between moves the
		// cursor and not the origin, which is why the row is captured -- but a
		// *re-anchor* in between moves the origin too, and then the answer is about a
		// canvas that is somewhere else
		const { screen, terminal } = harness(20, 8);
		const backend = createInlineCanvas({ height: 2, terminal });
		backend.render(lines('a', 'b'));

		const pending = backend.locate(() => {
			// the terminal answers, and the region is given up before the reply lands
			backend.write('a log line');
			return Promise.resolve({ column: screen.column + 1, row: screen.row + 1 });
		});

		expect(await pending).toBe(false);
		expect(backend.origin).toBeUndefined();
	});

	it('should keep a reply that a repaint moved the cursor under', async () => {
		// the other half of the same rule: a frame between the question and the answer
		// is not a re-anchor, so the captured row is what makes the answer still good.
		// The repaint has to *move* the cursor for this to assert anything, which is
		// what the third row does -- the diff leaves the cursor on the last row it
		// touched, so a frame that only changes the first row leaves it two rows higher
		const { screen, terminal } = harness(20, 8);
		terminal.write('log\r\n');
		const backend = createInlineCanvas({ height: 3, terminal });
		backend.render(lines('a', 'b', 'c'));
		expect(screen.row).toBe(3);

		const found = await backend.locate(() => {
			// the terminal answers where the cursor is now, and the frame that lands
			// before the reply does moves it
			const answer = { column: screen.column + 1, row: screen.row + 1 };
			backend.render(lines('x', 'b', 'c'));
			expect(screen.row).toBe(1);
			return Promise.resolve(answer);
		});

		expect(found).toBe(true);
		// one row of log above it, whatever the cursor did in between
		expect(backend.origin).toEqual({ x: 0, y: 1 });
	});

	it('should answer nothing from a terminal that did not', async () => {
		const { terminal } = harness(20, 6);
		const backend = createInlineCanvas({ height: 1, terminal });
		backend.render(lines('a'));

		expect(await backend.locate(() => Promise.resolve(undefined))).toBe(false);
		expect(backend.origin).toBeUndefined();
	});
});

describe('the screen model itself', () => {
	/**
	 * Reverse video is the one piece of styling this model keeps, for the reason
	 * its own doc gives: a prompt's caret *is* styling, so a model holding
	 * characters alone cannot see it at all. These are its reader's own claims.
	 */
	describe('reverse video', () => {
		function after(...chunks: string[]): { column: number; row: number } | undefined {
			const screen = new Screen(10, 2);
			for (const chunk of chunks) {
				screen.write(chunk);
			}
			return screen.lastInverse;
		}

		it('should record the cell a reverse-video write landed in', () => {
			expect(after('ab\u001b[7mc')).to.deep.equal({ column: 2, row: 0 });
		});

		it('should record nothing where none was written', () => {
			expect(after('abc')).to.equal(undefined);
		});

		it('should read a transition parameter by parameter', () => {
			// a transition combines what it closes with what it opens, so matching the
			// whole string would be pinning one spelling of it
			expect(after('\u001b[0;7ma')).to.deep.equal({ column: 0, row: 0 });
			expect(after('\u001b[7ma\u001b[27;32mb')).to.deep.equal({ column: 0, row: 0 });
		});

		it('should read a bare reset as turning it off', () => {
			expect(after('\u001b[7ma\u001b[mb')).to.deep.equal({ column: 0, row: 0 });
		});

		it('should not read an extended colour channel as reverse video', () => {
			// the bug AGENTS.md records twice, made a third time by a naive walk: the
			// canvas emits `38;2;7;7;7` for an `rgb(7, 7, 7)`, and a reader that does not
			// skip an extended colour's own parameters latches on a *channel* -- after
			// which every cell is recorded as the caret
			expect(after('\u001b[38;2;7;7;7mabc'), 'a truecolor channel').to.equal(undefined);
			expect(after('\u001b[38;5;7mabc'), 'a 256-colour index').to.equal(undefined);
			expect(after('\u001b[48;2;0;7;0mabc'), 'a background channel').to.equal(undefined);
			expect(after('\u001b[58;5;7mabc'), 'an underline colour').to.equal(undefined);
			// six parameters rather than five, which only an *empty* colour space says
			expect(after('\u001b[38;2;;7;7;7mabc'), 'the long spelling').to.equal(undefined);
			// and a non-empty colour space is as plausible a red channel, so five it is:
			// `38;2;1;7;0;0` is a colour and a trailing `0`, which is a reset
			expect(after('\u001b[7ma\u001b[38;2;1;7;0;0mb'), 'a colour space that is set').to.deep.equal({
				column: 0,
				row: 0,
			});
		});

		it('should still see an attribute written beside an extended colour', () => {
			// the skip must not swallow what came before it
			expect(after('\u001b[7;38;2;7;7;7ma')).to.deep.equal({ column: 0, row: 0 });
		});

		it('should leave a colon-form colour alone, which carries no parameters after it', () => {
			expect(after('\u001b[38:2::7:7:7mabc')).to.equal(undefined);
		});
	});
});
