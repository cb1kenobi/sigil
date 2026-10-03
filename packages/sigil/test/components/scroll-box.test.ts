import { strip } from '../../src/ansi/index.js';
import type { Key } from '../../src/components/keys.js';
import { rowWindow, ScrollBox, thumbExtent } from '../../src/components/scroll-box.js';
import {
	arrange,
	box,
	type Element,
	renderToLines,
	resolveStyles,
	scrollBy,
	scrollIntoView,
	scrollRange,
	selectableAt,
	text,
} from '../../src/element/index.js';
import type { KeyEvent, MouseEvent } from '../../src/input/index.js';
import type { MouseButton, MouseEventKind, WheelDirection } from '../../src/input/mouse.js';
import { isKnownProperty } from '../../src/style/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scroll box: the clip, the bar, and the three ways to move it.
 *
 * Driven through the handlers the input router would call rather than through a
 * router, for the reason the mouse's own routing tests give: the rules a
 * component keeps are separable from the question of whether a report reached it,
 * and the second one is tested where the router is.
 */

/** Lays a tree out at a size, which is what writes the boxes and the extents. */
function lay(root: Element, width = 12, height = 4): Element {
	resolveStyles(root);
	arrange(root, { height, width });
	return root;
}

/** A scroll box over `count` one-row texts. */
function listBox(count: number, props: Record<string, number | string> = {}): Element {
	return ScrollBox({
		children: () =>
			box(
				{ 'flex-direction': 'column', id: 'rows' },
				...Array.from({ length: count }, (_, i) => text(`r${i}`, { focusable: true, id: `r${i}` }))
			),
		props: { height: 4, width: 12, ...props },
	});
}

/** The viewport inside a scroll box, found by the class it draws with. */
function viewportIn(host: Element): Element {
	const found = find(host, (e) => e.classes.includes('sigil-scroll-viewport'));
	if (!found) {
		throw new Error('no viewport');
	}
	return found;
}

function find(at: Element, want: (e: Element) => boolean): Element | undefined {
	if (want(at)) {
		return at;
	}
	for (const child of at.children) {
		const found = find(child, want);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function every(at: Element, out: Element[] = []): Element[] {
	out.push(at);
	for (const child of at.children) {
		every(child, out);
	}
	return out;
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function keyEvent(name: string): KeyEvent & { claimed: () => boolean } {
	let stopped = false;
	const key: Key = { ctrl: false, meta: false, name, sequence: '', shift: false };
	return {
		claimed: () => stopped,
		current: undefined,
		key,
		paste: false,
		stop(): void {
			stopped = true;
		},
		get stopped() {
			return stopped;
		},
		target: undefined,
	};
}

interface MouseInit {
	button?: MouseButton;
	kind: MouseEventKind;
	shift?: boolean;
	wheel?: WheelDirection;
	x?: number;
	y?: number;
}

/** A mouse event as the router builds one. */
function mouseEvent(init: MouseInit): MouseEvent & { claimed: () => boolean } {
	let stopped = false;
	return {
		button: init.button,
		claimed: () => stopped,
		ctrl: false,
		current: undefined,
		kind: init.kind,
		meta: false,
		shift: init.shift ?? false,
		stop(): void {
			stopped = true;
		},
		get stopped() {
			return stopped;
		},
		target: undefined,
		wheel: init.wheel,
		x: init.x ?? 0,
		y: init.y ?? 0,
	};
}

/** The rendered rows, with colour taken off so a picture reads as a picture. */
function picture(host: Element, width = 12, height = 4): string[] {
	return renderToLines(host, { cascade: themedCascade(), height, width }).map((line) =>
		strip(line).trimEnd()
	);
}

describe('thumbExtent', () => {
	it('should fill the track where the content fits', () => {
		expect(thumbExtent(6, 10, 10, 0)).toStrictEqual({ size: 6, start: 0 });
		expect(thumbExtent(6, 10, 4, 0)).toStrictEqual({ size: 6, start: 0 });
	});

	it('should never round the thumb away', () => {
		// the case a long log is: one row visible in ten thousand rounds to nothing,
		// and a scrollbar with nothing in it is a scrollbar that looks broken
		const { size } = thumbExtent(20, 1, 10_000, 0);
		expect(size).toBe(1);
	});

	it('should touch an end only at that end', () => {
		const track = 10;
		const content = 100;
		const view = 10;
		const span = thumbExtent(track, view, content, 0);

		expect(span.start).toBe(0);
		// one row in is not the top, whatever the ratio rounds to
		expect(thumbExtent(track, view, content, 1).start).toBeGreaterThan(0);
		// one row short of the end is not the end
		expect(thumbExtent(track, view, content, 89).start).toBeLessThan(track - span.size);
		expect(thumbExtent(track, view, content, 90).start).toBe(track - span.size);
	});

	it('should stay inside the track', () => {
		for (let offset = 0; offset <= 90; offset++) {
			const { size, start } = thumbExtent(10, 10, 100, offset);
			expect(start, `at ${offset}`).toBeGreaterThanOrEqual(0);
			expect(start + size, `at ${offset}`).toBeLessThanOrEqual(10);
		}
	});

	it('should answer for a track with no cells', () => {
		expect(thumbExtent(0, 4, 40, 0)).toStrictEqual({ size: 0, start: 0 });
	});
});

describe('a scroll box', () => {
	it('should clip its content and reserve a gutter', () => {
		const host = lay(listBox(8));
		const view = viewportIn(host);

		// twelve columns, one of them the bar
		expect(view.box?.width).toBe(11);
		expect(scrollRange(view)).toStrictEqual({ x: 0, y: 4 });
		expect(picture(host)).toStrictEqual([
			'r0         █',
			'r1         █',
			'r2         │',
			'r3         │',
		]);
	});

	it('should reserve the gutter whether or not anything can scroll', () => {
		// the whole argument for taking a cell rather than overlaying: a stable
		// gutter means nothing reflows when the content grows past the viewport
		const short = lay(listBox(2));
		const long = lay(listBox(40));

		expect(viewportIn(short).box?.width).toBe(11);
		expect(viewportIn(long).box?.width).toBe(11);
		// and content that fits fills the track rather than hiding it
		expect(picture(short)).toStrictEqual([
			'r0         █',
			'r1         █',
			'           █',
			'           █',
		]);
	});

	it('should scroll content that said it may be squeezed', () => {
		// the case a `flex-shrink: 0` on the content wrapper was written for, kept
		// after that declaration was deleted for failing its sabotage: the wrapper
		// really is squeezed to the room there is, and every line is still drawn and
		// still reachable, because the range and the paint both follow the extent of
		// what is inside the wrapper rather than the wrapper's own box
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
		const host = lay(
			ScrollBox({
				children: () => text(lines, { 'min-height': 0 }),
				props: { height: 4, width: 12 },
			})
		);

		expect(scrollRange(viewportIn(host)).y).toBe(6);
		viewportIn(host).scrollTo(0, 6);
		lay(host);
		expect(picture(host)[0]).toContain('line 6');
	});

	it('should give the whole width back when the bar is turned off', () => {
		const host = lay(
			ScrollBox({
				children: () => box({ 'flex-direction': 'column' }, text('r0'), text('r1'), text('r2')),
				props: { height: 2, width: 12 },
				scrollbar: false,
			}),
			12,
			2
		);
		expect(viewportIn(host).box?.width).toBe(12);
		expect(picture(host, 12, 2)).toStrictEqual(['r0', 'r1']);
	});

	it('should set no colour in a prop, because a theme could not reach one', () => {
		const host = lay(listBox(8));
		for (const element of every(host)) {
			for (const name of Object.keys(element.props)) {
				expect(isKnownProperty(name), `${name} is not a property`).toBe(true);
				expect(name, `${name} is a colour in a prop`).not.toMatch(/color/i);
			}
		}
	});

	it('should keep a class the caller gave it', () => {
		const host = ScrollBox({ children: () => box({}), props: { class: 'panel' } });
		expect(host.classes).toStrictEqual(['panel', 'sigil-scroll']);
	});
});

describe('scrolling a scroll box from the keyboard', () => {
	function driven(count = 20): { host: Element; press: (name: string) => boolean; view: Element } {
		const host = lay(listBox(count));
		const view = viewportIn(host);
		return {
			host,
			press(name: string): boolean {
				const event = keyEvent(name);
				host.onKey?.(event);
				lay(host);
				return event.claimed();
			},
			view,
		};
	}

	it('should move a row at a time', () => {
		const { press, view } = driven();
		expect(press('down')).toBe(true);
		expect(view.scroll?.y).toBe(1);
		expect(press('up')).toBe(true);
		expect(view.scroll?.y).toBe(0);
	});

	it('should page by the viewport less a row, so one line survives the jump', () => {
		const { press, view } = driven();
		expect(press('pagedown')).toBe(true);
		expect(view.scroll?.y).toBe(3);
		expect(press('pageup')).toBe(true);
		expect(view.scroll?.y).toBe(0);
	});

	it('should go to the ends', () => {
		const { press, view } = driven();
		expect(press('end')).toBe(true);
		expect(view.scroll?.y).toBe(16);
		expect(press('home')).toBe(true);
		expect(view.scroll?.y).toBe(0);
	});

	it('should claim a key for an axis it owns even where there is nowhere to go', () => {
		// Home in a list already at its top is still this box's key: letting it
		// bubble would scroll the pane around it instead
		const { press, view } = driven();
		expect(press('home')).toBe(true);
		expect(view.scroll?.y ?? 0).toBe(0);
	});

	it('should leave a key alone where the content fits, which is what chains', () => {
		const { press, view } = driven(2);
		expect(press('down')).toBe(false);
		expect(press('pagedown')).toBe(false);
		expect(view.scroll).toBeUndefined();
	});

	it('should leave an axis it does not own alone', () => {
		const { press } = driven();
		expect(press('left')).toBe(false);
		expect(press('right')).toBe(false);
	});

	it('should leave a key it has no answer for alone', () => {
		const { press } = driven();
		expect(press('a')).toBe(false);
		expect(press('tab')).toBe(false);
	});
});

describe('scrolling a scroll box with the wheel', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function driven(count = 400): {
		turn: (wheel: WheelDirection, shift?: boolean) => boolean;
		view: Element;
	} {
		const host = lay(listBox(count));
		const view = viewportIn(host);
		return {
			turn(wheel: WheelDirection, shift = false): boolean {
				const event = mouseEvent({ kind: 'wheel', shift, wheel });
				host.onMouse?.(event);
				lay(host);
				return event.claimed();
			},
			view,
		};
	}

	it('should move three lines a notch, which is the convention', () => {
		const { turn, view } = driven();
		expect(turn('down')).toBe(true);
		expect(view.scroll?.y).toBe(3);
	});

	it('should accelerate a flick and not a deliberate turn', () => {
		const { turn, view } = driven();

		// four notches well apart: three lines each, every time
		for (let i = 0; i < 4; i++) {
			turn('down');
			vi.advanceTimersByTime(500);
		}
		expect(view.scroll?.y).toBe(12);

		view.scrollTo(0, 0);
		// and four in a flick: the curve steps in after the second
		for (let i = 0; i < 4; i++) {
			turn('down');
			vi.advanceTimersByTime(20);
		}
		expect(view.scroll?.y).toBeGreaterThan(12);
	});

	it('should cap the acceleration', () => {
		// six hundred rows rather than ten thousand, which is what the cap needs: the
		// ceiling is forty notches times twelve lines, so the range only has to be
		// comfortably past 480 for it to be the binding constraint. The first version
		// used ten thousand and cost **fourteen seconds** -- forty `lay()` calls at
		// 350ms each, against this file's own ten-second timeout -- for an assertion
		// that reads the same at a twentieth of the size. A slow test is a flaky test
		// one busy machine later, which is the lesson `shake-walk.test.ts` already
		// carries about timing
		const { turn, view } = driven(600);
		for (let i = 0; i < 40; i++) {
			turn('down');
			vi.advanceTimersByTime(10);
		}
		// forty notches, each worth at most four times three lines -- and uncapped the
		// multiplier reaches twenty, so the total runs past the range and clamps at
		// 596, which is what this discriminates against
		expect(view.scroll?.y).toBeLessThanOrEqual(40 * 12);
		expect(view.scroll?.y).toBeGreaterThan(0);
	});

	it('should reset the streak when the direction reverses', () => {
		// reversing mid-flick must not launch the content the other way at full
		// speed, which is a scroll that overshoots the thing you were going back to
		const { turn, view } = driven();
		for (let i = 0; i < 8; i++) {
			turn('down');
			vi.advanceTimersByTime(10);
		}
		const at = view.scroll?.y ?? 0;
		turn('up');
		expect(at - (view.scroll?.y ?? 0)).toBe(3);
	});

	it('should leave the wheel alone where there is nowhere to go', () => {
		const { turn, view } = driven(2);
		expect(turn('down')).toBe(false);
		expect(view.scroll).toBeUndefined();
	});

	it('should leave a sideways turn alone on a vertical box', () => {
		const { turn } = driven();
		expect(turn('right')).toBe(false);
	});
});

describe('a scroll box bar', () => {
	function bar(host: Element): Element {
		const found = find(host, (e) => e.classes.includes('sigil-scroll-bar'));
		if (!found) {
			throw new Error('no bar');
		}
		return found;
	}

	// a ten-row viewport over twenty rows: a five-cell thumb on a ten-cell track
	// with five cells of span, so every number below is one somebody can check
	function driven(count = 20): { bar: Element; host: Element; view: Element } {
		const host = lay(listBox(count, { height: 10 }), 12, 10);
		return { bar: bar(host), host, view: viewportIn(host) };
	}

	function send(host: Element, target: Element, init: MouseInit): boolean {
		const event = mouseEvent(init);
		target.onMouse?.(event);
		lay(host, 12, 10);
		return event.claimed();
	}

	it('should page when the track below the thumb is clicked', () => {
		const { bar: it_, host, view } = driven();
		expect(send(host, it_, { kind: 'mousedown', x: 11, y: 9 })).toBe(true);
		expect(view.scroll?.y).toBe(9);
	});

	it('should page back when the track above the thumb is clicked', () => {
		const { bar: it_, host, view } = driven();
		view.scrollTo(0, 10);
		lay(host, 12, 10);
		expect(send(host, it_, { kind: 'mousedown', x: 11, y: 0 })).toBe(true);
		expect(view.scroll?.y).toBe(1);
	});

	it('should drag the thumb', () => {
		const { bar: it_, host, view } = driven(20);
		// the thumb starts at the top, so a press there grabs it
		expect(send(host, it_, { kind: 'mousedown', x: 11, y: 0 })).toBe(true);
		expect(view.scroll?.y ?? 0).toBe(0);

		send(host, it_, { kind: 'mousemove', x: 11, y: 5 });
		expect(view.scroll?.y).toBe(10);

		// and back, computed from the press rather than accumulated, so the round
		// trip lands exactly where it started
		send(host, it_, { kind: 'mousemove', x: 11, y: 0 });
		expect(view.scroll?.y).toBe(0);
	});

	it('should stop dragging on the release', () => {
		const { bar: it_, host, view } = driven();
		send(host, it_, { kind: 'mousedown', x: 11, y: 0 });
		expect(send(host, it_, { kind: 'mouseup', x: 11, y: 0 })).toBe(true);

		send(host, it_, { kind: 'mousemove', x: 11, y: 5 });
		expect(view.scroll?.y ?? 0).toBe(0);
	});

	it('should stop the click as well as the release, because they are two events', () => {
		// stopping an event stops it bubbling and does not cancel a different one,
		// so a component that owns a drag and does not want the derived click has
		// to say both -- the trap `05-drag.js` found
		const { bar: it_, host } = driven();
		expect(send(host, it_, { kind: 'click', x: 11, y: 0 })).toBe(true);
	});

	it('should leave a wheel over it to the box it belongs to', () => {
		const { bar: it_, host } = driven();
		expect(send(host, it_, { kind: 'wheel', wheel: 'down', x: 11, y: 0 })).toBe(false);
	});

	it('should leave a wheel alone while the thumb is held, not read it as a move', () => {
		// the kind check the bar opens with, and why it is a claim rather than a
		// saving: with a drag in progress, any event carrying a position reaches the
		// move branch -- so a wheel over a held thumb would scroll to wherever the
		// wheel was reported from and stop the report besides
		const { bar: it_, host, view } = driven();
		send(host, it_, { kind: 'mousedown', x: 11, y: 0 });
		const before = view.scroll?.y ?? 0;

		expect(send(host, it_, { kind: 'wheel', wheel: 'down', x: 11, y: 7 })).toBe(false);
		expect(view.scroll?.y ?? 0).toBe(before);
	});

	it('should draw the thumb where the content is', () => {
		const { host, view } = driven(20);
		const column = (): string =>
			picture(host, 12, 10)
				.map((line) => line.at(-1) ?? ' ')
				.join('');

		expect(column().startsWith('█')).toBe(true);
		view.scrollTo(0, 10);
		lay(host, 12, 10);
		expect(column().endsWith('█')).toBe(true);
	});
});

describe('a horizontal scroll box', () => {
	it('should scroll sideways with the arrows and leave the vertical keys alone', () => {
		const host = lay(
			ScrollBox({
				axis: 'horizontal',
				children: () => text('a long line of content', { 'white-space': 'nowrap' }),
				props: { height: 3, width: 10 },
			}),
			10,
			3
		);
		const view = viewportIn(host);

		expect(scrollRange(view).x).toBeGreaterThan(0);

		const right = keyEvent('right');
		host.onKey?.(right);
		lay(host, 10, 3);
		expect(right.claimed()).toBe(true);
		expect(view.scroll?.x).toBe(1);

		const down = keyEvent('down');
		host.onKey?.(down);
		expect(down.claimed()).toBe(false);
	});

	it('should take a shifted wheel sideways', () => {
		const host = lay(
			ScrollBox({
				axis: 'horizontal',
				children: () => text('a long line of content', { 'white-space': 'nowrap' }),
				props: { height: 3, width: 10 },
			}),
			10,
			3
		);
		const view = viewportIn(host);

		const event = mouseEvent({ kind: 'wheel', shift: true, wheel: 'down' });
		host.onMouse?.(event);
		expect(event.claimed()).toBe(true);
		expect(view.scroll?.x).toBe(3);
	});

	it('should draw its bar a column short of a vertical one, leaving the corner', () => {
		const host = lay(
			ScrollBox({
				axis: 'both',
				children: () => text('a long line of content', { 'white-space': 'nowrap' }),
				props: { height: 3, width: 10 },
			}),
			10,
			3
		);
		const rows = picture(host, 10, 3);
		// the last row is the horizontal bar, and its last cell is the corner
		expect(rows[2]?.length).toBeLessThan(10);
	});
});

describe('a scroll box read back as a string', () => {
	// SIG-130, on the component the defect was worst for. `picture()` above names
	// a height, which skips `renderToLines()`'s second pass entirely -- so every
	// other test in this file dodged it. With no height named, `arrangedExtent()`
	// used to report the fifty rows *inside* the clip: measured, a three-row box
	// over fifty rows came back as 50 lines, 47 of them blank
	it('should be as tall as its window rather than as tall as its content', () => {
		const host = listBox(50, { height: 3, width: 12 });

		const lines = renderToLines(host, { cascade: themedCascade(), width: 40 }).map((line) =>
			strip(line).trimEnd()
		);

		expect(lines).to.have.length(3);
		expect(lines[0]).to.contain('r0');
		expect(lines[2]).to.contain('r2');
	});
});

describe('rowWindow', () => {
	it('should hold no row until something says how tall the viewport is', () => {
		// a viewport with no cells in it can see nothing, which is the arithmetic said
		// plainly. SIG-131 answered the whole list here, on the ground that
		// under-building is a row nobody sees -- and `Element.onResize` is what moved
		// that premise: a frame lays out, tells the viewport its height, rebuilds and
		// lays out again before it paints, so this is a row one layout early
		expect(rowWindow(10_000, 1, 0, 0)).toStrictEqual({ first: 0, length: 0 });
		expect(rowWindow(10_000, 1, 500, -1)).toStrictEqual({ first: 0, length: 0 });
	});

	it('should hold the rows the viewport can see', () => {
		expect(rowWindow(100, 1, 0, 4)).toStrictEqual({ first: 0, length: 4 });
		expect(rowWindow(100, 1, 10, 4)).toStrictEqual({ first: 10, length: 4 });
		expect(rowWindow(100, 2, 0, 6)).toStrictEqual({ first: 0, length: 3 });
	});

	it('should hold one more row where the first is partly scrolled off', () => {
		// the row at the bottom edge is half on screen and has to be built; a window
		// short by it is a blank line that only appears at some offsets
		expect(rowWindow(100, 2, 1, 6)).toStrictEqual({ first: 0, length: 4 });
		expect(rowWindow(100, 3, 2, 6)).toStrictEqual({ first: 0, length: 3 });
	});

	it('should stop at the last row', () => {
		expect(rowWindow(6, 1, 4, 4)).toStrictEqual({ first: 4, length: 2 });
		// past the end is the caller's -- `scrollTo()` deliberately does not clamp
		expect(rowWindow(6, 1, 100, 4)).toStrictEqual({ first: 5, length: 1 });
	});

	it('should answer for a list with no rows', () => {
		expect(rowWindow(0, 1, 0, 4)).toStrictEqual({ first: 0, length: 0 });
		expect(rowWindow(-3, 1, 0, 4)).toStrictEqual({ first: 0, length: 0 });
	});

	it('should hold the row a viewport shorter than one row is looking at', () => {
		// what has to stay true with no floor under the length, which was deleted
		// for being unreachable
		expect(rowWindow(100, 10, 25, 1)).toStrictEqual({ first: 2, length: 1 });
		expect(rowWindow(100, 10, 0, 1)).toStrictEqual({ first: 0, length: 1 });
	});

	it('should hold every row a viewport can see, at every offset', () => {
		// the property rather than the cases: walked exhaustively, because this is
		// where every off-by-one a windowed list can have lives
		for (const step of [1, 2, 3, 5]) {
			const count = 40;
			for (const view of [1, 4, 7, 24]) {
				for (let offset = 0; offset <= count * step; offset++) {
					const at = rowWindow(count, step, offset, view);
					// past the end the window legitimately holds the last row and nothing
					// is visible at all, which is `scrollTo()` not clamping
					const inside = offset < count * step;
					for (let row = 0; row < count; row++) {
						const top = row * step;
						const seen = top < offset + view && offset < top + step;
						const has = row >= at.first && row < at.first + at.length;
						if (seen && !has) {
							throw new Error(
								`row ${row} is visible at offset ${offset} (step ${step}, view ${view}) ` +
									`and the window is ${at.first}..${at.first + at.length - 1}`
							);
						}
						// the other direction, or a window one row too long reads as correct:
						// over-building is safe and is still not what this answers
						if (inside && has && !seen) {
							throw new Error(
								`row ${row} is held at offset ${offset} (step ${step}, view ${view}) ` +
									`and the viewport cannot see it`
							);
						}
					}
				}
			}
		}
	});
});

describe('a windowed scroll box', () => {
	/**
	 * The same row a hand-built list and a windowed one are both made of.
	 *
	 * With a **background**, so that the differential below compares the width each
	 * row was placed at and not only the glyphs it drew. Without one the two sides
	 * agreed while the slots were 4 cells wide on one and 11 on the other, which is
	 * a differential that could not see the thing it was written for.
	 */
	const row = (i: number): Element =>
		text(`r${i}`, {
			'background-color': i % 3 === 0 ? 'blue' : 'red',
			focusable: true,
			id: `r${i}`,
		});

	/**
	 * What `rows` builds, assembled by hand: the baseline the window is diffed
	 * against.
	 *
	 * `flex-grow: 1` on the column and `flex-direction: column` on each slot are
	 * what make this the **same tree** rather than a similar one -- `rows` writes
	 * the direction on the component's own content box, so a hand-built list needs
	 * its wrapper to fill the same way or its rows are placed at their content
	 * width while the window's fill the line.
	 */
	function wholeBox(count: number, height = 1): Element {
		return ScrollBox({
			children: () =>
				box(
					{ 'flex-direction': 'column', 'flex-grow': 1 },
					...Array.from({ length: count }, (_, i) =>
						box({ 'flex-direction': 'column', 'flex-shrink': 0, height }, row(i))
					)
				),
			props: { height: 4, width: 12 },
		});
	}

	/** The rendered rows with their colour kept, which is what compares the widths. */
	function coloured(host: Element): string[] {
		return renderToLines(host, { cascade: themedCascade(), colorLevel: 3, height: 4, width: 12 });
	}

	function windowBox(count: number, height = 1): Element {
		return ScrollBox({ props: { height: 4, width: 12 }, rows: { count, height, row } });
	}

	/** Every row id the tree is holding, in order. */
	function held(host: Element): string[] {
		return every(host)
			.filter((e) => e.id?.startsWith('r'))
			.map((e) => e.id as string);
	}

	it('should paint what the whole list paints, and report the range it reports', () => {
		// the differential the whole thing rests on: a window that drew something
		// else would be faster and wrong, and a range off by a row is a scrollbar
		// describing the window instead of the content
		for (const height of [1, 2]) {
			for (const offset of [0, 1, 3, 50, 96 / height, 400]) {
				const whole = wholeBox(100, height);
				const win = windowBox(100, height);
				viewportIn(whole).scrollTo(0, offset);
				viewportIn(win).scrollTo(0, offset);
				lay(whole);
				lay(win);
				expect(coloured(win)).toStrictEqual(coloured(whole));
				expect(scrollRange(viewportIn(win))).toStrictEqual(scrollRange(viewportIn(whole)));
			}
		}
	});

	it('should build only the rows the viewport can see', () => {
		const win = lay(windowBox(10_000));
		expect(every(win).length).toBeLessThan(40);
		expect(held(win)).toStrictEqual(['r0', 'r1', 'r2', 'r3']);
		expect(every(wholeBox(10_000)).length).toBeGreaterThan(20_000);
	});

	it('should keep a row that stayed in the window, so the focus survives a notch', () => {
		// a list rebuilt wholesale would unmount the element holding the focus on
		// every wheel notch, and an unmounted focus is handed on by position
		const win = lay(windowBox(100));
		const kept = find(win, (e) => e.id === 'r2');
		viewportIn(win).scrollTo(0, 1);
		expect(find(win, (e) => e.id === 'r2')).toBe(kept);
		// still attached, which is the question the focus repair asks -- a row that
		// left the tree is one whose focus is handed on by position
		expect(kept?.parent).toBeDefined();
		expect(held(win)).toStrictEqual(['r1', 'r2', 'r3', 'r4']);
	});

	it('should follow a scrollIntoView that moved, which no handler of its own sees', () => {
		// `scrollIntoView()` is the writer the component does not own: the focus ring
		// calls it, and a row revealed by it would otherwise scroll under a window
		// built for where the list used to be
		const win = lay(windowBox(100));
		const edge = find(win, (e) => e.id === 'r3');
		expect(edge).toBeDefined();
		expect(scrollIntoView(edge as Element, { margin: 2 })).toBe(true);
		expect(viewportIn(win).scroll?.y).toBe(1);
		expect(held(win)).toStrictEqual(['r1', 'r2', 'r3', 'r4']);
		// and the row it was asked to reveal is still one of them
		expect(find(win, (e) => e.id === 'r3')).toBe(edge);
	});

	it('should mask the cells the whole list masks, so a selection copies the same', () => {
		for (const offset of [0, 40]) {
			const whole = wholeBox(100);
			const win = windowBox(100);
			viewportIn(whole).scrollTo(0, offset);
			viewportIn(win).scrollTo(0, offset);
			lay(whole);
			lay(win);
			const a = selectableAt(whole, 12, 4);
			const b = selectableAt(win, 12, 4);
			// both have a mask, and it is one that says something: the bar's two `raw`
			// elements default to unselectable, so the gutter column is `false` while
			// the rows are `true`. Without asserting that, two `undefined` masks or
			// two all-true ones would satisfy the comparison below having compared
			// nothing -- which is the shape the stripped picture differential had
			expect(a).toBeDefined();
			expect(b).toBeDefined();
			let refused = 0;
			for (let y = 0; a && b && y < 4; y++) {
				for (let x = 0; x < 12; x++) {
					expect(b(x, y)).toBe(a(x, y));
					if (!b(x, y)) {
						refused++;
					}
				}
			}
			expect(refused).toBe(4);
		}
	});

	it('should take either children or rows and never both', () => {
		// refused where the component is built, the way a command declaring a `path`
		// beside a `run` is: two answers to "what is the content" and no way to pick
		expect(() =>
			ScrollBox({ children: () => text('x'), rows: { count: 1, height: 1, row } })
		).toThrow(/either children or rows/);
		expect(() => ScrollBox({})).toThrow(/either children or rows/);
	});

	it('should bound the first window by the height the host declared', () => {
		// the viewport is inside the host, so a declared host height is never less
		// than the height the viewport gets -- which makes it a bound and not a guess
		const declared = ScrollBox({
			props: { height: 4, width: 12 },
			rows: { count: 500, height: 1, row },
		});
		expect(held(declared)).toStrictEqual(['r0', 'r1', 'r2', 'r3']);
		// and a string of digits is the other spelling of the same length
		const written = ScrollBox({
			props: { height: '4', width: 12 },
			rows: { count: 500, height: 1, row },
		});
		expect(held(written)).toStrictEqual(['r0', 'r1', 'r2', 'r3']);
	});

	it('should build no row where the host declares no height in cells', () => {
		// no bound is no window, and nothing is built until a layout says how tall the
		// viewport came out. That is `rowWindow()`'s rule met through the component,
		// and the half that makes it affordable is the one below: a frame fills it in
		// before it paints
		const loose = ScrollBox({ props: { width: 12 }, rows: { count: 40, height: 1, row } });
		expect(held(loose)).toStrictEqual([]);
		// a height a `Number()` cannot read as cells is no bound either, and the one
		// that matters is `'50%'`: `Number('50%')` is `NaN`, which would make the
		// window's own length `NaN` and leave it there -- no layout can repair a
		// `Math.max(anything, NaN)`, and the unchanged-window guard compares
		// `NaN === NaN` as false, so every sync would rebuild the same nothing
		for (const height of ['', ' ', '50%', 'auto', '4.5', '0x4']) {
			const odd = ScrollBox({ props: { height, width: 12 }, rows: { count: 7, height: 1, row } });
			expect(held(odd)).toStrictEqual([]);
		}
		// and the two of those the cascade will take are laid out and filled in, which
		// is what says the `NaN` costs one layout rather than every one of them. How
		// many rows a percentage or an `auto` comes to is not this test's business --
		// that the window stopped being empty and starts where the offset says is
		for (const height of ['50%', 'auto']) {
			const odd = ScrollBox({ props: { height, width: 12 }, rows: { count: 7, height: 1, row } });
			lay(odd);
			viewportIn(odd).scrollTo(0, 1);
			expect(held(odd)[0]).toBe('r1');
		}
		// and once it has been arranged, the arranged height is what it windows by
		lay(loose);
		viewportIn(loose).scrollTo(0, 10);
		expect(held(loose)).toStrictEqual(['r10', 'r11', 'r12', 'r13']);
	});

	it('should take its cross extent from the rows that were built', () => {
		// what windowing a vertical axis costs on the horizontal one: the extent is
		// the widest row that *exists*, so the range moves as you scroll down -- and
		// an offset the new range cannot hold is clamped, which reads as the view
		// jumping left. Pinned so that it is discovered here rather than in an app
		const wide = (i: number): Element =>
			text(i < 6 ? `r${i} ${'x'.repeat(20)}` : `r${i}`, { 'white-space': 'nowrap' });
		const host = ScrollBox({
			axis: 'both',
			props: { height: 4, width: 12 },
			rows: { count: 12, height: 1, row: wide },
		});
		const view = viewportIn(host);
		lay(host);
		expect(scrollRange(view).x).toBeGreaterThan(0);

		scrollBy(view, 10, 0);
		scrollBy(view, 0, 8);
		lay(host);
		expect(scrollRange(view).x).toBe(0);
		scrollBy(view, 1, 0);
		expect(view.scroll?.x).toBe(0);
	});

	it('should take it from the declared width where there is one', () => {
		// the fix, and it is `height`'s decision on the axis that is not windowed:
		// a declared row width makes the cross extent constant whichever rows are
		// in the window
		const wide = (i: number): Element =>
			text(i < 6 ? `r${i} ${'x'.repeat(20)}` : `r${i}`, { 'white-space': 'nowrap' });
		const host = ScrollBox({
			axis: 'both',
			props: { height: 4, width: 12 },
			rows: { count: 12, height: 1, row: wide, width: 24 },
		});
		const view = viewportIn(host);
		lay(host);
		const before = scrollRange(view).x;
		expect(before).toBeGreaterThan(0);

		scrollBy(view, 10, 0);
		scrollBy(view, 0, 8);
		lay(host);
		expect(scrollRange(view).x).toBe(before);
		scrollBy(view, 1, 0);
		expect(view.scroll?.x).toBe(11);
	});

	it('should take the larger of the arranged height and the declared one', () => {
		// a height of **0** is a measurement rather than "not arranged yet": a
		// bordered host of height 2 has a content box of zero, and reading that as
		// unknown built all five hundred rows
		const bordered = ScrollBox({
			props: { 'border-style': 'single', height: 2, width: 12 },
			rows: { count: 500, height: 1, row },
		});
		resolveStyles(bordered);
		arrange(bordered, { height: 2, width: 12 });
		expect(viewportIn(bordered).content?.height).toBe(0);
		viewportIn(bordered).scrollTo(0, 1);
		expect(held(bordered).length).toBeLessThan(5);
	});

	it('should let the arranged height beat a declared one the host outgrew', () => {
		// a host that can **grow** makes its declared height no bound at all, so the
		// arranged height has to win: `height: 10` with `flex-grow: 1` in a forty-row
		// parent is a viewport of forty, and keeping the ten left thirty rows blank
		const host = ScrollBox({
			props: { 'flex-grow': 1, height: 10, 'min-height': 0, width: 12 },
			rows: { count: 500, height: 1, row },
		});
		const root = box({ 'flex-direction': 'column', height: 40 }, host);
		resolveStyles(root);
		arrange(root, { height: 40, width: 12 });
		expect(viewportIn(host).content?.height).toBe(40);
		viewportIn(host).scrollTo(0, 1);
		// rows 1..40, which is the forty a forty-row viewport can see at offset one
		expect(held(host).length).toBe(40);
	});

	it('should commit nothing when a row builder throws', () => {
		// `rows.row()` is the caller's code, and the offset is already the new one by
		// the time the window is computed. Committing first left `at` claiming a
		// window the content box did not hold, and no later scroll to the same window
		// could repair it -- the guard would see nothing to do
		let fail = -1;
		const rows = {
			count: 100,
			height: 1,
			row: (i: number): Element => {
				if (i === fail) {
					throw new Error('from the row builder');
				}
				return row(i);
			},
		};
		const host = ScrollBox({ props: { height: 4, width: 12 }, rows });
		const view = viewportIn(host);
		lay(host);
		const before = held(host);
		const spacer = find(host, (e) => e.classes.includes('sigil-scroll-spacer'));

		fail = 5;
		expect(() => view.scrollTo(0, 5)).toThrow(/from the row builder/);
		// the window the content box holds, and the spacer that measures it, are the
		// ones from before
		expect(held(host)).toStrictEqual(before);
		expect(spacer?.props.height).toBe(0);
		// and so is the **offset**, which is the rest of the commit: `scrollTo()` had
		// already written it, so a throw that left it there would show the spacer
		// over a window built for somewhere else -- and `scrollTo(0, 5)` again is a
		// no-op, so nothing short of scrolling elsewhere could have repaired it
		expect(view.scroll?.y).toBe(0);

		// which is what makes the *same* offset reachable again once the builder
		// stops throwing. Asserted by retrying it directly rather than by going
		// somewhere else and back, which is what the first version of this did and
		// is the one sequence that cannot reach the equality check
		fail = -1;
		view.scrollTo(0, 5);
		expect(held(host)).toStrictEqual(['r5', 'r6', 'r7', 'r8']);
	});

	it('should draw the thumb at the ends, which it could not from what was built', () => {
		// the claim the demo leads with. The thumb reads `scrollRange()` plus the
		// viewport's own height, so a range describing the window rather than the
		// content would put it near the top forever -- and "it touches an end only
		// at that end" is the bar's own recorded rule, so the top and bottom cells
		// are what say the range is the whole list's
		const win = windowBox(500);
		const view = viewportIn(win);
		const column = (): string =>
			picture(win)
				.map((line) => line.at(-1) ?? ' ')
				.join('');

		view.scrollTo(0, 0);
		expect(column()).toBe('█│││');
		view.scrollTo(0, scrollRange(view).y);
		expect(column()).toBe('│││█');
		// and the whole list agrees, cell for cell, at both ends
		for (const offset of [0, 496]) {
			const whole = wholeBox(500);
			viewportIn(whole).scrollTo(0, offset);
			view.scrollTo(0, offset);
			lay(whole);
			lay(win);
			expect(column()).toBe(
				picture(whole)
					.map((line) => line.at(-1) ?? ' ')
					.join('')
			);
		}
	});

	it('should drag the thumb to the last row', () => {
		// the drag maps pointer movement onto `scrollRange()`, so it reaches the end
		// of the content rather than the end of the window
		const win = lay(windowBox(500));
		const bar = find(win, (e) => e.classes.includes('sigil-scroll-bar'));
		expect(bar).toBeDefined();
		bar?.onMouse?.(mouseEvent({ kind: 'mousedown', x: 11, y: 0 }));
		bar?.onMouse?.(mouseEvent({ kind: 'mousemove', x: 11, y: 99 }));
		expect(viewportIn(win).scroll?.y).toBe(scrollRange(viewportIn(win)).y);
		expect(held(win)).toStrictEqual(['r496', 'r497', 'r498', 'r499']);
	});

	it('should roll back to the offset the last settled window was for', () => {
		// not to zero, and not to the offset `scrollTo()` has just written. Rows three
		// cells tall so that a scroll *inside* one row takes the unchanged-window fast
		// path -- which still has to record the offset it settled at, or a later
		// failure rolls back past it to an older one
		let fail = -1;
		const rows = {
			count: 100,
			height: 3,
			row: (i: number): Element => {
				if (i === fail) {
					throw new Error('from the row builder');
				}
				return row(i);
			},
		};
		const host = ScrollBox({ props: { height: 4, width: 12 }, rows });
		const view = viewportIn(host);
		lay(host);
		expect(held(host)).toStrictEqual(['r0', 'r1']);

		// a scroll inside the first row: the window is the one already there, so this
		// goes through the fast path and nothing is rebuilt
		view.scrollTo(0, 1);
		expect(held(host)).toStrictEqual(['r0', 'r1']);

		// and now a window that has to build a row the builder refuses
		fail = 2;
		expect(() => view.scrollTo(0, 6)).toThrow(/from the row builder/);
		expect(view.scroll?.y).toBe(1);
		expect(held(host)).toStrictEqual(['r0', 'r1']);

		// the same thing again from an offset the *commit* path settled, rather than
		// the fast path: both have to record it, and a test that only reached one of
		// them left the other's assignment surviving its sabotage
		fail = -1;
		view.scrollTo(0, 6);
		expect(held(host)).toStrictEqual(['r2', 'r3']);
		fail = 4;
		expect(() => view.scrollTo(0, 12)).toThrow(/from the row builder/);
		expect(view.scroll?.y).toBe(6);
		expect(held(host)).toStrictEqual(['r2', 'r3']);
	});

	it('should still scroll from the keyboard and the wheel', () => {
		const win = lay(windowBox(100));
		const event = keyEvent('down');
		win.onKey?.(event);
		expect(event.claimed()).toBe(true);
		expect(viewportIn(win).scroll?.y).toBe(1);
		expect(held(win)).toStrictEqual(['r1', 'r2', 'r3', 'r4']);

		// the wheel as well, which this was named for and did not do: a notch is
		// three lines, and the window has to follow it
		const notch = mouseEvent({ kind: 'wheel', wheel: 'down' });
		win.onMouse?.(notch);
		expect(notch.claimed()).toBe(true);
		expect(viewportIn(win).scroll?.y).toBe(4);
		expect(held(win)).toStrictEqual(['r4', 'r5', 'r6', 'r7']);
	});

	it('should leave a children-built box sized the way it already was', () => {
		// the column is written only where `rows` is in play, and writing it
		// unconditionally is a visible change to every `children` list: the content
		// box's direction decides which axis its one child is *stretched* on, so a
		// bordered box went from content-width to the whole viewport's width
		const host = lay(
			ScrollBox({
				children: () =>
					box({ 'border-style': 'single', 'flex-direction': 'column' }, text('x'), text('y')),
				props: { height: 4, width: 12 },
			})
		);
		expect(picture(host)).toStrictEqual([
			'┌─┐        █',
			'│x│        █',
			'│y│        █',
			'└─┘        █',
		]);
	});

	it('should stack its rows, whatever a row element is', () => {
		// the content box's direction is the component's where `rows` is in play,
		// because the spacers are placed against it. Left at the default the slots
		// were laid out side by side: one row of content and a horizontal overflow
		const win = lay(windowBox(100));
		const boxes = held(win).map((id) => find(win, (e) => e.id === id)?.box?.y);
		expect(boxes).toStrictEqual([0, 1, 2, 3]);
	});
});

describe('a windowed list whose count changed', () => {
	const row = (i: number): Element => text(`r${i}`, { id: `r${i}` });

	it('should pick up the new count the next time the window is computed', () => {
		// `count` is read on every window rather than captured, which is the line a
		// command's own declaration draws between what is read on every parse and
		// what built the registry lookups. A log grows, and what the range is
		// computed from has to be able to follow it
		const rows = { count: 10, height: 1, row };
		const host = ScrollBox({ props: { height: 4, width: 12 }, rows });
		const view = viewportIn(host);
		resolveStyles(host);
		arrange(host, { height: 4, width: 12 });
		expect(scrollRange(view).y).toBe(6);

		rows.count = 40;
		// the next window is what reads it, which is the next time the offset moves
		view.scrollTo(0, 1);
		resolveStyles(host);
		arrange(host, { height: 4, width: 12 });
		expect(scrollRange(view).y).toBe(36);
	});

	it('should not be skipped by the unchanged-window guard', () => {
		// the guard compares what the last window was computed from, and a count
		// that grew while `first` and `length` stayed put is exactly the case it
		// would otherwise skip -- so the spacer below would keep its old height.
		// Rows three cells tall, because at one cell every offset is a different
		// window and the guard is never the thing that answers
		const rows = { count: 10, height: 3, row };
		const host = ScrollBox({ props: { height: 4, width: 12 }, rows });
		const view = viewportIn(host);
		resolveStyles(host);
		arrange(host, { height: 4, width: 12 });
		expect(scrollRange(view).y).toBe(26);

		rows.count = 40;
		// a scroll inside the first row: the offset moved, so the handler runs, and
		// the window it computes is the one that is already there
		view.scrollTo(0, 1);
		resolveStyles(host);
		arrange(host, { height: 4, width: 12 });
		expect(scrollRange(view).y).toBe(116);
	});
});

describe('a windowed list whose viewport changed height', () => {
	const row = (i: number): Element =>
		text(`r${i}`, { 'background-color': i % 3 === 0 ? 'blue' : 'red', id: `r${i}` });

	/** A list bounded by its parent rather than by a height of its own. */
	function loose(count: number, props: Record<string, number | string> = {}): Element {
		return ScrollBox({
			props: { 'flex-grow': 1, 'min-height': 0, width: 12, ...props },
			rows: { count, height: 1, row },
		});
	}

	/** The lines `renderToLines()` comes to, which is a frame rather than a layout. */
	const lines = (root: Element, height: number): string[] =>
		renderToLines(root, { cascade: themedCascade(), colorLevel: 3, height, width: 12 });

	/** Every row id the tree is holding, in order. */
	const held = (host: Element): string[] =>
		every(host)
			.filter((e) => e.id?.startsWith('r'))
			.map((e) => e.id as string);

	it('should rebuild the window when the viewport grew, which writes no offset', () => {
		// the defect SIG-132 is filed for, in the shape AGENTS.md recorded it: a list
		// bounded by its parent, laid out at ten rows and scrolled -- which narrows the
		// window to ten -- and then laid out at forty, where it held ten and left
		// thirty rows of the viewport blank until something scrolled. A resize writes
		// no offset, so `onScroll` never fires and the window had nothing to tell it
		const host = loose(500);
		const root = box({ 'flex-direction': 'column' }, host);
		lines(root, 10);
		viewportIn(host).scrollTo(0, 1);
		expect(held(host).length).toBe(10);

		const grown = lines(root, 40);
		// rows 1..40 is the forty a forty-row viewport can see at offset one
		expect(held(host).length).toBe(40);
		expect(grown.filter((line) => strip(line).trim().length > 1)).toHaveLength(40);
	});

	it('should rebuild it when the viewport shrank as well', () => {
		// the other direction, and it is the one that costs rather than the one that
		// looks broken: a window kept over a viewport that lost rows is slots built for
		// cells the clip now throws away
		const host = loose(500);
		const root = box({ 'flex-direction': 'column' }, host);
		lines(root, 40);
		expect(held(host).length).toBe(40);
		lines(root, 10);
		expect(held(host).length).toBe(10);
	});

	it('should paint what a list that declared the height paints', () => {
		// the differential: a window built from what the layout said has to come out
		// where a window built from a declaration does, at every offset and in colour
		// -- a width that differs is invisible until something paints a background
		for (const offset of [0, 1, 37, 400, 9000]) {
			const declared = ScrollBox({
				props: { height: 8, width: 12 },
				rows: { count: 500, height: 1, row },
			});
			const host = loose(500);
			const root = box({ 'flex-direction': 'column' }, host);
			viewportIn(declared).scrollTo(0, offset);
			viewportIn(host).scrollTo(0, offset);
			expect(lines(root, 8)).toStrictEqual(lines(declared, 8));
			expect(scrollRange(viewportIn(host))).toStrictEqual(scrollRange(viewportIn(declared)));
		}
	});

	it('should build only the rows the viewport can see for its first frame', () => {
		// the second symptom of the one cause, and the reason the pre-layout fallback
		// stopped being the whole list: nothing knows the height until a layout has
		// run, and a window built for an unknown viewport used to be every row -- which
		// is the whole list cascaded and arranged for a frame that shows twenty-four of
		// them. Measured by `scripts/benchmark-virtual-list.mjs`; counted here
		const host = loose(10_000);
		const root = box({ 'flex-direction': 'column' }, host);
		expect(every(root).length).toBeLessThan(20);
		lines(root, 24);
		expect(every(root).length).toBeLessThan(120);
		expect(held(host)[0]).toBe('r0');
		expect(held(host).length).toBe(24);
	});

	it('should leave a frame alone where no box changed size', () => {
		// the fast path, which is what keeps this free for every app that has no
		// windowed list in it and for every frame of one that does: `sync()` recomputes
		// from the offset and the height, so a layout that moved neither is one
		// `rowWindow()` call and no second layout
		const host = loose(500);
		const root = box({ 'flex-direction': 'column' }, host);
		lines(root, 10);
		const before = held(host);
		const builds: number[] = [];
		const counted = ScrollBox({
			props: { 'flex-grow': 1, 'min-height': 0, width: 12 },
			rows: {
				count: 500,
				height: 1,
				row: (i) => {
					builds.push(i);
					return row(i);
				},
			},
		});
		const countedRoot = box({ 'flex-direction': 'column' }, counted);
		lines(countedRoot, 10);
		const built = builds.length;
		lines(countedRoot, 10);
		expect(builds.length).toBe(built);
		expect(held(host)).toStrictEqual(before);
	});
});

describe('a windowed list whose viewport changed size without changing its window', () => {
	const row = (i: number): Element => text(`r${i}`, { id: `r${i}` });

	/**
	 * A box whose own **width** is a different number on every layout.
	 *
	 * Which is what makes a count of how many times it was told a count of
	 * *layouts*: an element whose size settles is collected once however many
	 * layouts a frame took. Sideways rather than taller, so that nothing it does
	 * changes the height of the scroll box beside it in a column.
	 */
	function layoutCounter(): { calls: () => number; element: Element } {
		let calls = 0;
		let width = 3;
		const element = box({ 'flex-shrink': 0, height: 1, width }, text('x'));
		element.onResize = () => {
			calls++;
			width = width === 3 ? 4 : 3;
			element.setProp('width', width);
			return false;
		};
		return { calls: () => calls, element };
	}

	it('should report no change where the window it recomputed is the one it has', () => {
		// the fast path's **return value**, which is what keeps a frame over a windowed
		// list at one layout. A viewport whose *width* moved is a viewport that resized
		// and a window that did not change: `sync()` recomputes, finds the same four
		// numbers, and has to say so -- a `true` there is a second layout on every such
		// frame, drawing exactly what the first one drew
		const host = ScrollBox({ props: { height: 8 }, rows: { count: 500, height: 1, row } });
		const counter = layoutCounter();
		const root = box({ 'flex-direction': 'column' }, host, counter.element);

		renderToLines(root, { cascade: themedCascade(), height: 10, width: 12 });
		const settled = counter.calls();
		// only the width, so the window cannot have moved
		renderToLines(root, { cascade: themedCascade(), height: 10, width: 13 });
		expect(counter.calls() - settled, 'one layout, because nothing reported a change').toBe(1);
		expect(viewportIn(host).content?.width).toBe(12);
	});
});
