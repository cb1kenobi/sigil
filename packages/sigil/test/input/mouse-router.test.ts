import { arrange, box, type Element, resolveStyles } from '../../src/element/index.js';
import { createInput, type InputRouter, type MouseEvent } from '../../src/input/index.js';
import { Cascade, parseStylesheet, Restyler } from '../../src/style/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import {
	DISABLE_MOUSE_BUTTONS,
	DISABLE_MOUSE_MOTION,
	DISABLE_MOUSE_SGR,
	ENABLE_MOUSE_BUTTONS,
	ENABLE_MOUSE_MOTION,
	ENABLE_MOUSE_SGR,
} from '../../src/terminal/sequences.js';
import { describe, expect, it } from 'vitest';

/**
 * Where a mouse report goes.
 *
 * Driven by feeding the bytes a terminal would send, like the key tests next
 * door: what arrives is a string, and `mouse.test.ts` already pins the reading of
 * one. What is new here is the hit test, the capture, the derived events, and
 * `:hover`.
 */

const ESC = String.fromCharCode(0x1b);

/** `CSI < Cb ; Cx ; Cy M`, in the terminal's own one-based screen coordinates. */
const sgr = (cb: number, column: number, row: number, final = 'M') =>
	`${ESC}[<${cb};${column};${row}${final}`;

/** A press, a release, a motion and a wheel turn of the left button. */
const press = (column: number, row: number) => sgr(0, column, row);
const release = (column: number, row: number) => sgr(0, column, row, 'm');
const drag = (column: number, row: number) => sgr(32, column, row);
const move = (column: number, row: number) => sgr(35, column, row);
const wheelUp = (column: number, row: number) => sgr(64, column, row);

/** A cursor position report, which is what `locate()`'s probe is waiting for. */
const cursorAt = (column: number, row: number) => `${ESC}[${row};${column}R`;

/** Lets the microtasks a settled probe queues actually run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A canvas that knows where it sits, which is all the router asks of one. */
function surface(
	opts: { height?: number; origin?: { x: number; y: number }; width?: number } = {}
) {
	let origin = 'origin' in opts ? opts.origin : { x: 0, y: 0 };
	return {
		asked: 0,
		height: opts.height ?? 6,
		async locate(probe: () => Promise<{ column: number; row: number } | undefined>) {
			this.asked++;
			const found = await probe();
			if (!found) {
				return false;
			}
			origin = { x: 0, y: 0 };
			return true;
		},
		get origin() {
			return origin;
		},
		/** Lets a test move the canvas, or forget where it is. */
		set origin(next: { x: number; y: number } | undefined) {
			origin = next;
		},
		toCanvas(column: number, row: number) {
			return origin ? { x: column - 1 - origin.x, y: row - 1 - origin.y } : undefined;
		},
		width: opts.width ?? 10,
	};
}

interface Harness {
	feed: (chunk: string) => void;
	out: string[];
	terminal: Terminal;
}

/** A terminal whose stdin is a TTY nothing is typing on. */
function harness(): Harness {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const out: string[] = [];

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
		stderr: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
		stdin: stdin as never,
		stdout: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
	});

	return {
		feed(chunk: string) {
			for (const fn of listeners.get('data') ?? []) {
				fn(chunk);
			}
		},
		out,
		terminal,
	};
}

/** What each element saw, as `<id>:<kind>`, in the order it saw it. */
function record(elements: readonly Element[]): string[] {
	const seen: string[] = [];
	for (const element of elements) {
		element.onMouse = (event: MouseEvent) => void seen.push(`${element.id}:${event.kind}`);
	}
	return seen;
}

/**
 * A tree laid out inside a ten-by-six canvas.
 *
 * ```
 * 0123456789
 * ┌────┐····  row 0  outer, holding `left` and `right`
 * │left│····  row 1
 * ```
 *
 * `left` and `right` are two-by-two boxes side by side at the top-left, inside a
 * six-by-four `outer`, inside a root that fills the canvas.
 */
function tree(): { all: Element[]; left: Element; outer: Element; right: Element; root: Element } {
	const left = box({ height: 2, id: 'left', width: 2 });
	const right = box({ height: 2, id: 'right', width: 2 });
	const outer = box({ height: 4, id: 'outer', width: 6 }, left, right);
	const root = box({ height: 6, id: 'root', width: 10 }, outer);

	resolveStyles(root);
	arrange(root, { height: 6, width: 10 });

	return { all: [left, right, outer, root], left, outer, right, root };
}

describe('a mouse report reaching the tree', () => {
	it('should bubble from the element under it up through its ancestors', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		// screen column 1, row 1 is canvas (0, 0), which is inside `left`
		feed(press(1, 1));

		expect(seen).toEqual(['left:mousedown', 'outer:mousedown', 'root:mousedown']);
	});

	it('should stop where something stopped it', () => {
		const { feed, terminal } = harness();
		const { all, outer, root } = tree();
		const seen = record(all);
		outer.onMouse = (event) => {
			seen.push(`outer:${event.kind}`);
			event.stop();
		};
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));

		expect(seen).toEqual(['left:mousedown', 'outer:mousedown']);
	});

	it('should say where the event is, in the canvas cells', () => {
		const { feed, terminal } = harness();
		const { root } = tree();
		const seen: Array<{ x: number; y: number }> = [];
		root.onMouse = (event) => void seen.push({ x: event.x, y: event.y });
		createInput({ mouse: { surface: surface() }, root, terminal });

		// one-based on the wire, zero-based here
		feed(press(3, 2));
		expect(seen).toEqual([{ x: 2, y: 1 }]);
	});

	it('should read the canvas origin rather than the screen', () => {
		const { feed, terminal } = harness();
		const { root } = tree();
		const seen: Array<{ x: number; y: number }> = [];
		root.onMouse = (event) => void seen.push({ x: event.x, y: event.y });
		// two rows of log above the region, which is what an inline canvas normally is
		createInput({ mouse: { surface: surface({ origin: { x: 0, y: 2 } }) }, root, terminal });

		feed(press(1, 3));
		expect(seen).toEqual([{ x: 0, y: 0 }]);
	});

	it('should drop a press that landed off the canvas', () => {
		// on the log above the region, or on whatever else is sharing the screen:
		// dropped rather than clamped, which is the whole reason the rect is asked about
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		// the router's own handlers too, which is what makes this "dropped" rather than
		// "landed on no element": a press with no target would still reach those
		input.onMouse(() => void seen.push('router'));

		feed(press(20, 1));
		feed(press(1, 20));
		expect(seen).toEqual([]);
	});

	it('should reach the router with no target where it landed on no element', () => {
		// inside the canvas and outside every box, which is the one thing only a
		// router-level handler can see
		const { feed, terminal } = harness();
		const seen: Array<Element | undefined> = [];
		const small = box({ height: 1, id: 'small', width: 1 });
		resolveStyles(small);
		arrange(small, { height: 6, width: 10 });

		const input = createInput({ mouse: { surface: surface() }, root: small, terminal });
		input.onMouse((event) => void seen.push(event.target));

		feed(press(5, 4));
		expect(seen).toEqual([undefined]);
	});

	it('should never reach a key handler', () => {
		// a report is not a key: read as one it is `unknown` today, and the day
		// somebody makes that insertable it is `<0;1;1M` in an answer
		const { feed, terminal } = harness();
		const { root } = tree();
		const keys: string[] = [];
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.bind((event) => void keys.push(event.key.name));

		feed(press(1, 1));
		expect(keys).toEqual([]);

		feed('a');
		expect(keys).toEqual(['a']);
	});

	it('should drop a report even with tracking off, because it is still not a key', () => {
		// a terminal some other program left in a tracking mode, or one still reporting
		// after this router turned the mode off
		const { feed, terminal } = harness();
		const { root } = tree();
		const keys: string[] = [];
		const input = createInput({ root, terminal });
		input.bind((event) => void keys.push(event.key.name));

		feed(press(1, 1));
		expect(keys).toEqual([]);
	});
});

describe('the router-level handlers', () => {
	it('should run after the tree rather than before it', () => {
		// which is the opposite of `bind()`, and the whole of what the mouse does
		// differently: a binding goes first so an app cannot be made unquittable, and
		// nothing about the mouse has that shape
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.onMouse(() => void seen.push('router'));

		feed(press(1, 1));
		expect(seen.at(-1)).toBe('router');
	});

	it('should not run where the tree stopped the event', () => {
		const { feed, terminal } = harness();
		const { left, root } = tree();
		const seen: string[] = [];
		left.onMouse = (event) => event.stop();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.onMouse(() => void seen.push('router'));

		feed(press(1, 1));
		expect(seen).toEqual([]);
	});

	it('should have no current element, because the event is past the tree', () => {
		const { feed, terminal } = harness();
		const { root } = tree();
		const seen: Array<Element | undefined> = [];
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.onMouse((event) => void seen.push(event.current));

		feed(press(1, 1));
		expect(seen).toEqual([undefined]);
	});

	it('should not give a handler registered mid-dispatch the event that registered it', () => {
		// the copy. Without it, whether the new handler runs depends on where in the
		// iteration it joined, which is order-dependent and unexplainable
		const { feed, terminal } = harness();
		const { root } = tree();
		const seen: string[] = [];
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		const late = () => void seen.push('late');
		input.onMouse(() => {
			seen.push('first');
			input.onMouse(late);
		});

		feed(press(1, 1));
		expect(seen).toEqual(['first']);

		feed(press(1, 1));
		expect(seen).toEqual(['first', 'first', 'late']);
	});

	it('should not run a handler that unsubscribed during the dispatch', () => {
		// and the membership check. The copy costs this half back, because a snapshot
		// still holds the handler that has just gone -- each alone gives one of the two
		const { feed, terminal } = harness();
		const { root } = tree();
		const seen: string[] = [];
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		let off = () => {};
		input.onMouse(() => {
			seen.push('first');
			off();
		});
		off = input.onMouse(() => void seen.push('second'));

		// registration order is iteration order, so the remover runs first and `second`
		// is still in the snapshot when the walk reaches it -- which is the only
		// ordering where this assertion means anything, and the reason it is written
		// this way round
		feed(press(1, 1));
		expect(seen).toEqual(['first']);

		feed(press(1, 1));
		expect(seen).toEqual(['first', 'first']);
	});
});

describe('a click', () => {
	it('should follow a press and a release on the same element', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(release(2, 2));

		expect(seen.filter((it) => it.startsWith('left:'))).toEqual([
			'left:mousedown',
			'left:mouseup',
			'left:click',
		]);
	});

	it('should land on the nearest box containing both ends', () => {
		// a press on the text inside a button and a release on the button's padding is
		// a click on the button, which is the DOM's rule and what everybody expects
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		// pressed in `left`, released in `right`: their nearest common box is `outer`
		feed(press(1, 1));
		feed(release(3, 1));

		expect(seen.filter((it) => it.endsWith(':click'))).toEqual(['outer:click', 'root:click']);
	});

	it('should not follow a release that landed off the canvas', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(release(40, 1));

		expect(seen.filter((it) => it.endsWith(':click'))).toEqual([]);
	});

	it('should follow a release that something stopped, because they are two events', () => {
		// stopping an event stops it *bubbling*; it does not cancel a different one,
		// which is the DOM's rule. Gating the click on the `mouseup` was the first
		// answer and a demo found it: a slider stops the mouseup because it owns the
		// drag, and then silently lost the clicks it also wanted -- with nothing to
		// point at, since both spellings look identical from outside
		const { feed, terminal } = harness();
		const { left, outer, root } = tree();
		const seen: string[] = [];
		left.onMouse = (event) => {
			seen.push(`left:${event.kind}`);
			if (event.kind === 'mouseup') {
				event.stop();
			}
		};
		outer.onMouse = (event) => void seen.push(`outer:${event.kind}`);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(release(1, 1));

		expect(seen).toEqual([
			'left:mousedown',
			'outer:mousedown',
			// the mouseup stopped where it was told to and went no further up
			'left:mouseup',
			// and the click is its own event, which bubbles as one
			'left:click',
			'outer:click',
		]);
	});

	it('should still be stoppable itself', () => {
		// the other half: what a stopped `click` stops is the click
		const { feed, terminal } = harness();
		const { left, outer, root } = tree();
		const seen: string[] = [];
		left.onMouse = (event) => {
			seen.push(`left:${event.kind}`);
			if (event.kind === 'click') {
				event.stop();
			}
		};
		outer.onMouse = (event) => void seen.push(`outer:${event.kind}`);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(release(1, 1));

		expect(seen.filter((it) => it.endsWith(':click'))).toEqual(['left:click']);
	});

	it('should drop a release of a press this app never saw', () => {
		// pressed on the log above the region and released inside it: not this app's
		// event, and not a click either
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(release(1, 1));
		expect(seen.filter((it) => it.endsWith(':click'))).toEqual([]);
		// the release itself is still reported, because it did land here
		expect(seen).toContain('left:mouseup');
	});
});

describe('the capture', () => {
	it('should send a drag to whatever the press landed on, wherever it went', () => {
		// without it a drag that wandered off the region would never be told it ended:
		// the release arrives outside the rect, dropping it is what "dropped rather than
		// clamped" says, and a component tracking the press waits forever
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(drag(40, 1));
		feed(release(40, 1));

		expect(seen.filter((it) => it.startsWith('left:'))).toEqual([
			'left:mousedown',
			'left:mousemove',
			'left:mouseup',
		]);
	});

	it('should report a captured position even where it is off the canvas', () => {
		// which is what the web does with `clientX` during a drag, and is why a
		// scrollbar can work out how far the pointer travelled
		const { feed, terminal } = harness();
		const { left, root } = tree();
		const seen: Array<{ x: number; y: number }> = [];
		left.onMouse = (event) => void seen.push({ x: event.x, y: event.y });
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(drag(40, 1));

		expect(seen).toEqual([
			{ x: 0, y: 0 },
			{ x: 39, y: 0 },
		]);
	});

	it('should keep the press and the release apart per button', () => {
		const { feed, terminal } = harness();
		const { left, right, root } = tree();
		const seen: string[] = [];
		left.onMouse = (event) => void seen.push(`left:${event.kind}`);
		right.onMouse = (event) => void seen.push(`right:${event.kind}`);
		createInput({ mouse: { surface: surface() }, root, terminal });

		// left button pressed in `left`, right button pressed in `right`
		feed(press(1, 1));
		feed(sgr(2, 3, 1));
		// and each released over the other one, which each of them still owns
		feed(release(3, 1));
		feed(sgr(2, 1, 1, 'm'));

		expect(seen).toEqual(['left:mousedown', 'right:mousedown', 'left:mouseup', 'right:mouseup']);
	});

	it('should not read a press as a captured event, because it is what creates one', () => {
		// a second press for a button already held went to whatever the first one
		// landed on rather than to what is under the pointer now
		const { feed, terminal } = harness();
		const { left, right, root } = tree();
		const seen: string[] = [];
		left.onMouse = (event) => void seen.push(`left:${event.kind}`);
		right.onMouse = (event) => void seen.push(`right:${event.kind}`);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(press(3, 1));

		expect(seen).toEqual(['left:mousedown', 'right:mousedown']);
	});

	it('should drop a motion outside the canvas with nothing held', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		const input = createInput({ mouse: { motion: true, surface: surface() }, root, terminal });
		// the router's handlers too: there is no move to report about a canvas the
		// pointer is not over, and a target of nothing would still reach those
		input.onMouse((event) => void seen.push(`router:${event.kind}`));

		feed(move(40, 1));
		expect(seen.filter((it) => it.endsWith(':mousemove'))).toEqual([]);
	});

	it('should drop a release of a press it never saw, landing off the canvas', () => {
		// not this app's event in either direction: it did not start here and it did not
		// end here
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.onMouse((event) => void seen.push(`router:${event.kind}`));

		feed(release(40, 1));
		expect(seen).toEqual([]);
	});
});

describe('hover', () => {
	it('should be nothing at all without motion tracking', () => {
		// with nothing reporting where the pointer is between clicks, "under the
		// pointer" has no answer -- and a hover set from a press would stick to
		// whatever was clicked with nothing to clear it. So `:hover` matches nothing,
		// exactly as it did before there was a mouse
		const { feed, terminal } = harness();
		const { left, root } = tree();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		feed(drag(1, 1));

		expect(input.hovered).toBeUndefined();
		expect(left.states).toEqual([]);
	});

	it('should set the state on the whole chain, not only the innermost box', () => {
		// in CSS the pointer is inside every box that contains it, which is what makes
		// a `.row:hover` rule match the row when the pointer is over the text inside it
		const { feed, terminal } = harness();
		const { left, outer, right, root } = tree();
		const input = createInput({ mouse: { motion: true, surface: surface() }, root, terminal });

		feed(move(1, 1));

		expect(input.hovered).toBe(left);
		expect(left.states).toEqual(['hover']);
		expect(outer.states).toEqual(['hover']);
		expect(root.states).toEqual(['hover']);
		expect(right.states).toEqual([]);
	});

	it('should restyle through the cascade, which is what the selector was waiting for', () => {
		// `:hover` has always parsed and matched nothing, on the explicit ground that
		// the selector engine must not assume it never will. This is what makes it true
		const { feed, terminal } = harness();
		const sheet = parseStylesheet('#left { color: blue } #left:hover { color: red }');
		const { left, root } = tree();

		/** A fresh restyler each time, so nothing here depends on invalidation. */
		const settle = () => {
			resolveStyles(root, new Restyler(new Cascade([sheet])));
			return left.style.color;
		};

		const before = settle();
		createInput({ mouse: { motion: true, surface: surface() }, root, terminal });
		feed(move(1, 1));

		expect(settle()).not.toBe(before);
	});

	it('should enter outermost first and leave innermost first', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { motion: true, surface: surface() }, root, terminal });

		feed(move(1, 1));
		expect(seen.filter((it) => it.endsWith(':mouseenter'))).toEqual([
			'root:mouseenter',
			'outer:mouseenter',
			'left:mouseenter',
		]);

		seen.length = 0;
		// out of the tree entirely: everything is left, from the inside out
		feed(move(40, 1));
		expect(seen).toEqual(['left:mouseleave', 'outer:mouseleave', 'root:mouseleave']);
	});

	it('should not leave a parent the pointer never left', () => {
		// which is exactly why the DOM has two spellings of this event: a bubbling
		// leave would say the pointer left `outer` when it moved between its children
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { motion: true, surface: surface() }, root, terminal });

		feed(move(1, 1));
		seen.length = 0;
		feed(move(3, 1));

		expect(seen.filter((it) => it.endsWith('enter') || it.endsWith('leave'))).toEqual([
			'left:mouseleave',
			'right:mouseenter',
		]);
	});

	it('should fire nothing when the pointer moved inside the same box', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { motion: true, surface: surface() }, root, terminal });

		feed(move(1, 1));
		seen.length = 0;
		feed(move(2, 2));

		expect(seen.filter((it) => it.endsWith('enter') || it.endsWith('leave'))).toEqual([]);
		expect(seen).toEqual(['left:mousemove', 'outer:mousemove', 'root:mousemove']);
	});

	it('should follow the pointer during a drag, while the target stays captured', () => {
		// which is what a browser does: the *target* is captured, and where the pointer
		// is, is still where it is
		const { feed, terminal } = harness();
		const { left, right, root } = tree();
		const input = createInput({ mouse: { motion: true, surface: surface() }, root, terminal });
		const targets: Array<string | undefined> = [];
		input.onMouse((event) => void targets.push(event.target?.id));

		feed(press(1, 1));
		feed(drag(3, 1));

		expect(input.hovered).toBe(right);
		expect(left.states).toEqual([]);
		// the move still went to what the press landed on
		expect(targets.at(-1)).toBe('left');
	});

	it('should set the state before a handler is told about it', () => {
		const { feed, terminal } = harness();
		const { left, root } = tree();
		const seen: string[][] = [];
		left.onMouse = (event) => {
			if (event.kind === 'mouseenter') {
				seen.push([...left.states]);
			}
		};
		createInput({ mouse: { motion: true, surface: surface() }, root, terminal });

		feed(move(1, 1));
		expect(seen).toEqual([['hover']]);
	});
});

describe('the wheel', () => {
	it('should turn over whatever is under the pointer, with no motion tracked', () => {
		// a report *is* a position, so this needs no motion to know where the pointer
		// is: the turn carries its own coordinates
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(wheelUp(1, 1));
		expect(seen).toEqual(['left:wheel', 'outer:wheel', 'root:wheel']);
	});

	it('should say which way it turned', () => {
		const { feed, terminal } = harness();
		const { root } = tree();
		const seen: Array<string | undefined> = [];
		root.onMouse = (event) => void seen.push(event.wheel);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(wheelUp(1, 1));
		feed(sgr(65, 1, 1));
		expect(seen).toEqual(['up', 'down']);
	});

	it('should be dropped off the canvas', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(wheelUp(40, 1));
		expect(seen).toEqual([]);
	});
});

describe('click-to-focus', () => {
	/** The same tree with `outer` focusable, which is the ordinary shape. */
	function focusable(): { left: Element; outer: Element; root: Element } {
		const left = box({ height: 2, id: 'left', width: 2 });
		const outer = box({ focusable: true, height: 4, id: 'outer', width: 6 }, left);
		const root = box({ height: 6, id: 'root', width: 10 }, outer);
		resolveStyles(root);
		arrange(root, { height: 6, width: 10 });
		return { left, outer, root };
	}

	it('should focus the nearest focusable ancestor of what was pressed', () => {
		const { feed, terminal } = harness();
		const { outer, root } = focusable();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		expect(input.focus.current.get()).toBe(outer);
		expect(outer.states).toEqual(['focus']);
	});

	it('should be suppressed by stopping the press, the way Tab is', () => {
		// which is the mouse's default action: a component that wants the press for
		// itself keeps the focus where it was
		const { feed, terminal } = harness();
		const { left, root } = focusable();
		left.onMouse = (event) => event.stop();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		expect(input.focus.current.get()).toBeUndefined();
	});

	it('should be suppressed by a router handler too', () => {
		const { feed, terminal } = harness();
		const { root } = focusable();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.onMouse((event) => event.stop());

		feed(press(1, 1));
		expect(input.focus.current.get()).toBeUndefined();
	});

	it('should leave the focus alone where nothing under the pointer is focusable', () => {
		// a browser blurs there; this does not, because what that comes to in a
		// terminal is the keyboard stopping because the pointer brushed a border
		const { feed, terminal } = harness();
		const { outer, root } = focusable();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });
		input.focus.focus(outer);

		// row 5 is inside the root and below `outer`, which is four rows tall
		feed(press(1, 5));
		expect(input.focus.current.get()).toBe(outer);
	});

	it('should not follow a release', () => {
		const { feed, terminal } = harness();
		const { root } = focusable();
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		feed(release(1, 1));
		expect(input.focus.current.get()).toBeUndefined();
	});
});

describe('learning where the canvas is', () => {
	it('should ask once when the router starts', () => {
		const { terminal } = harness();
		const { root } = tree();
		const it = surface();
		createInput({ mouse: { surface: it }, root, terminal });

		// so the common case -- a canvas nothing has re-anchored since -- does not lose
		// its first click to finding out where it is
		expect(it.asked).toBe(1);
	});

	it('should ask through the router, which is what owns stdin', async () => {
		// a cursor report arrives interleaved with what the user is typing, so the
		// asking is the router's and only the arithmetic is the backend's -- and the
		// reply is taken out of the key stream rather than typed into somebody's answer
		const { feed, terminal } = harness();
		const { root } = tree();
		const keys: string[] = [];
		const it = surface({ origin: undefined });
		const input = createInput({ mouse: { surface: it }, root, terminal });
		input.bind((event) => void keys.push(event.key.name));

		feed(cursorAt(1, 1));
		await flush();

		expect(it.origin).toEqual({ x: 0, y: 0 });
		expect(keys).toEqual([]);
	});

	it('should ask again when the canvas has forgotten, and drop the report that found out', async () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		const it = surface();
		const input = createInput({ mouse: { surface: it }, root, terminal });
		feed(cursorAt(1, 1));
		await flush();

		// a resize, a line written above the region, an eviction: one report is what
		// that costs, and it is paid once per re-anchor
		it.origin = undefined;
		feed(press(1, 1));
		expect(seen).toEqual([]);
		expect(it.asked).toBe(2);

		// and the next one lands, because by then the canvas knows where it is
		feed(cursorAt(1, 1));
		await flush();
		feed(press(1, 1));
		expect(seen).toEqual(['left:mousedown', 'outer:mousedown', 'root:mousedown']);
		input.stop();
	});

	it('should ask once for a burst of reports it cannot place', async () => {
		// one probe outstanding at a time: a pointer dragged across a canvas that has
		// forgotten where it is would otherwise write a cursor query per cell
		const { feed, terminal } = harness();
		const { root } = tree();
		const it = surface();
		createInput({ mouse: { surface: it }, root, terminal });
		feed(cursorAt(1, 1));
		await flush();

		it.origin = undefined;
		feed(press(1, 1) + drag(2, 2) + release(2, 2));
		expect(it.asked).toBe(2);
	});
});

describe('the tracking mode', () => {
	it('should be asked for and put back', () => {
		const { out, terminal } = harness();
		const { root } = tree();
		const input = createInput({ mouse: { surface: surface() }, paste: false, root, terminal });

		expect(out.join('')).toContain(ENABLE_MOUSE_SGR + ENABLE_MOUSE_BUTTONS);

		input.stop();
		expect(out.join('')).toContain(DISABLE_MOUSE_BUTTONS + DISABLE_MOUSE_SGR);
	});

	it('should ask for any-event tracking where motion was asked for', () => {
		const { out, terminal } = harness();
		const { root } = tree();
		const input = createInput({
			mouse: { motion: true, surface: surface() },
			paste: false,
			root,
			terminal,
		});

		expect(out.join('')).toContain(ENABLE_MOUSE_SGR + ENABLE_MOUSE_MOTION);

		input.stop();
		expect(out.join('')).toContain(DISABLE_MOUSE_MOTION + DISABLE_MOUSE_SGR);
	});

	it('should ask for nothing where nobody asked for the mouse', () => {
		const { out, terminal } = harness();
		const { root } = tree();
		createInput({ paste: false, root, terminal });
		expect(out.join('')).toBe('');
	});

	it('should put back only what it turned on', () => {
		// a router built inside an app that is already tracking must not turn tracking
		// off when it stops: the app is still reading reports
		const { out, terminal } = harness();
		const { root } = tree();
		terminal.enableMouse();
		const input = createInput({ mouse: { surface: surface() }, paste: false, root, terminal });

		input.stop();
		expect(out.join('')).not.toContain(DISABLE_MOUSE_SGR);
	});

	it('should clear the hover states on the way out', () => {
		// nothing will ever clear them otherwise -- the reports have stopped -- so a
		// highlight would outlive the tracking that produced it
		const { feed, terminal } = harness();
		const { left, outer, root } = tree();
		const input = createInput({ mouse: { motion: true, surface: surface() }, root, terminal });

		feed(move(1, 1));
		expect(left.states).toEqual(['hover']);

		input.stop();
		expect(left.states).toEqual([]);
		expect(outer.states).toEqual([]);
		expect(input.hovered).toBeUndefined();
	});

	it('should read nothing once it has stopped', () => {
		const { feed, terminal } = harness();
		const { all, root } = tree();
		const seen = record(all);
		const input = createInput({ mouse: { surface: surface() }, root, terminal });

		input.stop();
		feed(press(1, 1));
		expect(seen).toEqual([]);
	});
});

describe('a clipped box', () => {
	it('should not be hittable where an ancestor clips it', () => {
		// the same rectangle paint drew inside, which is the whole reason `arrange()`
		// carries it rather than each walk working it out
		const { feed, terminal } = harness();
		const tall = box({ height: 6, id: 'tall', width: 4 });
		const root = box({ height: 2, id: 'root', overflow: 'hidden', width: 10 }, tall);
		resolveStyles(root);
		arrange(root, { height: 6, width: 10 });

		const seen = record([tall, root]);
		createInput({ mouse: { surface: surface() }, root, terminal });

		feed(press(1, 1));
		expect(seen).toEqual(['tall:mousedown', 'root:mousedown']);

		seen.length = 0;
		// canvas row 2 is inside the child's own box and outside what its parent clips
		// to, so there is nothing drawn there for a click to land on
		feed(press(1, 3));
		expect(seen).toEqual([]);
	});
});

/** A router built with no `root`, which is a legitimate thing to have. */
describe('a router with no tree', () => {
	it('should report to its own handlers and hit-test nothing', () => {
		const { feed, terminal } = harness();
		const input: InputRouter = createInput({ mouse: { surface: surface() }, terminal });
		const seen: Array<string | undefined> = [];
		input.onMouse((event) => void seen.push(event.target?.id));

		feed(press(1, 1));
		expect(seen).toEqual([undefined]);
	});
});
