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
	it('should hold every row until something says how tall the viewport is', () => {
		// the deliberate fallback: over-building is a slow frame and under-building
		// is a row that is not on screen, so the unknown case resolves to the
		// expensive answer rather than to the wrong one
		expect(rowWindow(10_000, 1, 0, 0)).toStrictEqual({ first: 0, length: 10_000 });
		expect(rowWindow(10_000, 1, 500, -1)).toStrictEqual({ first: 0, length: 10_000 });
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
					for (let row = 0; row < count; row++) {
						const top = row * step;
						const seen = top < offset + view && offset < top + step;
						const held = row >= at.first && row < at.first + at.length;
						if (seen && !held) {
							throw new Error(
								`row ${row} is visible at offset ${offset} (step ${step}, view ${view}) ` +
									`and the window is ${at.first}..${at.first + at.length - 1}`
							);
						}
					}
				}
			}
		}
	});
});

describe('a windowed scroll box', () => {
	/** The same row a hand-built list and a windowed one are both made of. */
	const row = (i: number): Element => text(`r${i}`, { focusable: true, id: `r${i}` });

	/** What `rows` builds, assembled by hand: the baseline the window is diffed against. */
	function wholeBox(count: number, height = 1): Element {
		return ScrollBox({
			children: () =>
				box(
					{ 'flex-direction': 'column' },
					...Array.from({ length: count }, (_, i) => box({ 'flex-shrink': 0, height }, row(i)))
				),
			props: { height: 4, width: 12 },
		});
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
				expect(picture(win)).toStrictEqual(picture(whole));
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
			expect(Boolean(b)).toBe(Boolean(a));
			for (let y = 0; a && b && y < 4; y++) {
				for (let x = 0; x < 12; x++) {
					expect(b(x, y)).toBe(a(x, y));
				}
			}
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

	it('should build the whole list where the host declares no height in cells', () => {
		// no bound is no window, and the answer is the expensive one rather than the
		// wrong one -- superseded by the arranged height from the first scroll on
		const loose = ScrollBox({ props: { width: 12 }, rows: { count: 40, height: 1, row } });
		expect(held(loose).length).toBe(40);
		// `Number('')` and `Number(' ')` are both 0, so a height nobody wrote must
		// not read as a bound of nothing
		expect(
			held(ScrollBox({ props: { height: '', width: 12 }, rows: { count: 7, height: 1, row } }))
				.length
		).toBe(7);
		expect(
			held(ScrollBox({ props: { height: '50%', width: 12 }, rows: { count: 7, height: 1, row } }))
				.length
		).toBe(7);
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

	it('should still scroll from the keyboard and the wheel', () => {
		const win = lay(windowBox(100));
		const event = keyEvent('down');
		win.onKey?.(event);
		expect(event.claimed()).toBe(true);
		expect(viewportIn(win).scroll?.y).toBe(1);
		expect(held(win)).toStrictEqual(['r1', 'r2', 'r3', 'r4']);
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
