import { createFullscreenCanvas, createInlineCanvas } from '../../src/canvas/index.js';
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
		expect(out).not.toMatch(/\u001B|\r/);
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
