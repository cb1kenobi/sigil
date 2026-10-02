import { strip } from '../../src/ansi/index.js';
import type { Key } from '../../src/components/keys.js';
import { ScrollBox, thumbExtent } from '../../src/components/scroll-box.js';
import {
	arrange,
	box,
	type Element,
	renderToLines,
	resolveStyles,
	scrollRange,
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
