import { createInlineCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { render } from '../../src/renderer/index.js';
import { Cascade, parseStylesheet } from '../../src/style/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { Screen, screenStream } from '../canvas/screen.js';
import { describe, expect, it } from 'vitest';

/**
 * The mouse through the whole stack: a renderer, a real inline canvas, a real
 * cursor report, and a click.
 *
 * Everything in `test/input/mouse-router.test.ts` hands the router a canvas that
 * already knows where it sits, which is the only way to test the routing rules on
 * their own. This is the other half, and it is the half nothing else can say: the
 * canvas is anchored wherever the log left it, its origin is learnt by asking, and
 * a report naming a screen cell has to reach the element that was painted there.
 */

const ESC = String.fromCharCode(0x1b);

interface Harness {
	feed: (chunk: string) => void;
	screen: Screen;
	terminal: Terminal;
}

/** A terminal whose output is a screen model and whose input is a TTY. */
function harness(width = 30, height = 12): Harness {
	const screen = new Screen(width, height);
	const stream = screenStream(screen);
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	const stdin = {
		isTTY: true,
		off(event: string, fn: (...args: unknown[]) => void) {
			listeners.get(event)?.delete(fn);
			return this;
		},
		on(event: string, fn: (...args: unknown[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(fn);
			return this;
		},
		pause() {
			return this;
		},
		resume() {
			return this;
		},
		setEncoding() {
			return this;
		},
		setRawMode() {
			return this;
		},
	};

	const terminal = createTerminal({
		env: {},
		isTTY: true,
		proc: { on() {}, pid: 1, removeListener() {} } as never,
		stderr: stream as never,
		stdin: stdin as never,
		stdout: stream as never,
	});

	return {
		feed(chunk: string) {
			for (const fn of listeners.get('data') ?? []) {
				fn(chunk);
			}
		},
		screen,
		terminal,
	};
}

/** Answers the cursor report the backend is waiting for, from the model. */
function answerCursor(h: Harness): void {
	h.feed(`${ESC}[${h.screen.row + 1};${h.screen.column + 1}R`);
}

/** Lets the microtasks a settled probe queues run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the mouse over a rendered tree', () => {
	it('should reach the element that was painted where the report says', async () => {
		const h = harness();
		// two rows of log above the region, so the canvas's own rows are nowhere near
		// the top of the screen and the origin is a number only a probe can supply
		h.terminal.write('building...\r\nstill building...\r\n');

		const rows: Element[] = ['one', 'two', 'three'].map((name) =>
			box({ height: 1, id: name, width: 12 }, text(name))
		);
		const backend = createInlineCanvas({ height: 3, terminal: h.terminal, width: 12 });
		const view = render(() => box({ 'flex-direction': 'column', id: 'app' }, ...rows), {
			backend,
			terminal: h.terminal,
		});

		const seen: string[] = [];
		for (const row of rows) {
			row.onMouse = (event) => void seen.push(`${row.id}:${event.kind}`);
		}

		const input = createInput({
			mouse: { surface: view.backend },
			root: view.root,
			terminal: h.terminal,
		});
		answerCursor(h);
		await flush();

		// the frame really is where the model says, which is what the report names
		expect(h.screen.written).toEqual(['building...', 'still building...', 'one', 'two', 'three']);

		// screen row 4 is `two`, one-based, which is the second row of a canvas that
		// starts on screen row 3
		h.feed(`${ESC}[<0;1;4M`);
		h.feed(`${ESC}[<0;1;4m`);

		expect(seen).toEqual(['two:mousedown', 'two:mouseup', 'two:click']);
		input.stop();
		view.dispose();
	});

	it('should learn where the canvas moved to after a line was written above it', async () => {
		const h = harness();
		const target = box({ height: 1, id: 'target', width: 12 }, text('here'));
		const backend = createInlineCanvas({ height: 1, terminal: h.terminal, width: 12 });
		const view = render(() => box({ id: 'app' }, target), {
			backend,
			terminal: h.terminal,
		});

		const seen: string[] = [];
		target.onMouse = (event) => void seen.push(event.kind);

		const input = createInput({
			mouse: { surface: view.backend },
			root: view.root,
			terminal: h.terminal,
		});
		answerCursor(h);
		await flush();

		h.feed(`${ESC}[<0;1;1M`);
		expect(seen).toEqual(['mousedown']);

		// a line above the region is one of the three things that throws the anchor
		// away, and the canvas is a row further down afterwards
		view.backend.write('a log line');
		expect(view.backend.origin).toBeUndefined();

		// the report that finds out is the one that pays for it
		seen.length = 0;
		h.feed(`${ESC}[<0;1;2M`);
		expect(seen).toEqual([]);

		answerCursor(h);
		await flush();
		h.feed(`${ESC}[<0;1;2M`);
		expect(seen).toEqual(['mousedown']);

		input.stop();
		view.dispose();
	});

	it('should restyle and repaint from a hover, with no component code at all', async () => {
		const h = harness(14, 10);
		const sheet = parseStylesheet('#tile { color: gray } #tile:hover { color: red }');
		const tile = box({ height: 1, id: 'tile', width: 4 }, text('tile'));
		const backend = createInlineCanvas({ height: 1, terminal: h.terminal, width: 4 });
		const view = render(() => box({ id: 'app' }, tile), {
			backend,
			cascade: new Cascade([sheet]),
			colorLevel: 1,
			terminal: h.terminal,
		});

		const input = createInput({
			mouse: { motion: true, surface: view.backend },
			root: view.root,
			terminal: h.terminal,
		});
		answerCursor(h);
		await flush();

		const before = tile.style.color;
		h.feed(`${ESC}[<35;1;1M`);
		// the hit test set a state, the state marked the tree, and the frame the mark
		// asked for re-matched the sheet. Nothing in between is a component's
		view.frame();

		// the innermost element under the pointer is the text inside the tile, and the
		// tile is hovered too -- `:hover` is set on the whole chain, because in CSS the
		// pointer is inside every box that contains it
		expect(input.hovered?.type).toBe('text');
		expect(tile.states).toContain('hover');
		expect(tile.style.color).not.toBe(before);

		input.stop();
		view.dispose();
	});
});
