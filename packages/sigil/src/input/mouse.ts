/**
 * What a terminal sends when the mouse moves, and what it means.
 *
 * A mouse report arrives on stdin interleaved with what the user is typing,
 * which is why it belongs to the thing that owns stdin rather than to a listener
 * of its own -- the same argument the capability replies next door are read for.
 * The decoder already frames one as a single read: `isParameter()` reads the
 * private-use `<` this leads with, which it was widened to do precisely so that
 * `ESC [ < 0 ; 1 ; 1 M` did not end at the `<` and leave `0;1;1M` to be typed
 * into somebody's answer a character at a time.
 *
 * **Only the SGR encoding (`1006`) is read, and that is a decision rather than a
 * gap.** The legacy X10 encoding writes a coordinate as one byte of `32 + n`, so
 * it runs out at column 223 -- an ordinary width on a wide monitor, and a failure
 * that looks like the app ignoring clicks down the right-hand side. There is no
 * reason to accept an encoding that cannot describe the screen it is reporting
 * about, and a terminal old enough to lack SGR reports nothing here rather than
 * reporting the left two thirds of itself.
 *
 * **Never print a report's own bytes where the user can see them.** A terminal
 * cannot tell an app that is reading the reports from a shell that is echoing
 * them, so some of them watch for exactly that: iTerm2 reduces every report it
 * sends to its printable digits -- `0;41;13M` for a press at column 41, row 13 --
 * and if that run turns up in the next 100ms of screen text it offers to turn
 * mouse reporting off, mid-run, over an app behaving perfectly. It is right to:
 * that is precisely what a TUI which died with tracking on leaves behind. So a
 * debug line, a log or a `--verbose` dump prints what a report *meant* rather
 * than what it *was*, and where the bytes are genuinely the subject it spaces
 * them -- `ESC [ < 0 ; 41 ; 13 M` says the same thing and is not the thing.
 * `scripts/terminal-probe.mjs --mouse` is the one caller that has to show them
 * and does it that way for this reason.
 */

import { ESC } from '../ansi/codes.js';

/**
 * An SGR report: `CSI < Cb ; Cx ; Cy M` for a press or a motion, `m` for a
 * release.
 *
 * Anchored, and the parameter count is exact. A CSI ending on `M` with anything
 * else in it is not this -- and being wrong about that costs a key the user
 * pressed, which is the same asymmetry `isCapabilityResponse()` is written for.
 */
const SGR_RE = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);

/**
 * Which button a report is about.
 *
 * The three every mouse has are named. The four xterm spells with bit 128 are
 * not: they are buttons 8 to 11 on the wire, a mouse maps them to whatever it
 * likes, and calling 8 and 9 `back` and `forward` -- which is what a browser
 * does with them -- would claim a mapping the terminal never made.
 */
export type MouseButton = 'extra1' | 'extra2' | 'extra3' | 'extra4' | 'left' | 'middle' | 'right';

/** Which way the wheel turned. Left and right are a tilt wheel or a trackpad. */
export type WheelDirection = 'down' | 'left' | 'right' | 'up';

/**
 * What a mouse report turns into.
 *
 * `mousedown`, `mouseup`, `mousemove` and `wheel` are the four a terminal
 * actually sends; `click`, `mouseenter` and `mouseleave` are derived by the
 * router from those. One vocabulary rather than two, so that a report's kind is
 * an event's kind with no table in between.
 */
export type MouseEventKind =
	| 'click'
	| 'mousedown'
	| 'mouseenter'
	| 'mouseleave'
	| 'mousemove'
	| 'mouseup'
	| 'wheel';

/** The four kinds a terminal reports. The other three are derived. */
export type MouseReportKind = 'mousedown' | 'mousemove' | 'mouseup' | 'wheel';

/**
 * One report, read.
 *
 * The coordinates are the terminal's own: **one-based, and in screen
 * coordinates**. Translating them into a canvas is the backend's, because a
 * canvas is a rect that deliberately does not know where it sits -- so nothing
 * here guesses at an origin it has no way to learn.
 */
export interface MouseReport {
	/**
	 * The button, where there is one.
	 *
	 * `undefined` for a wheel, which is not a button, and for motion with nothing
	 * held -- which xterm spells as button `3`, the same low bits a release used
	 * to carry in an encoding this does not read.
	 */
	readonly button: MouseButton | undefined;
	/** The screen column, one-based, exactly as the terminal wrote it. */
	readonly column: number;
	readonly ctrl: boolean;
	readonly kind: MouseReportKind;
	/** Alt, which xterm calls meta and reports in the same bit. */
	readonly meta: boolean;
	/** The screen row, one-based, exactly as the terminal wrote it. */
	readonly row: number;
	readonly shift: boolean;
	/** Which way the wheel turned, for a `wheel` report and nothing else. */
	readonly wheel: WheelDirection | undefined;
}

/** The low two bits, for an ordinary button. */
const BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right'];

/** The low two bits, where bit 128 says this is one of buttons 8 to 11. */
const EXTRAS: readonly MouseButton[] = ['extra1', 'extra2', 'extra3', 'extra4'];

/** The low two bits, where bit 64 says this is the wheel. */
const WHEEL: readonly WheelDirection[] = ['up', 'down', 'left', 'right'];

/**
 * Reads an SGR mouse report.
 *
 * @param sequence - Exactly what the terminal sent, as one whole sequence.
 * @returns The report, or `undefined` when this is not one.
 */
export function parseMouseReport(sequence: string): MouseReport | undefined {
	const found = SGR_RE.exec(sequence);
	if (!found) {
		return undefined;
	}

	const cb = Number.parseInt(found[1], 10);
	const column = Number.parseInt(found[2], 10);
	const row = Number.parseInt(found[3], 10);
	const released = found[4] === 'm';

	// the modifier bits, which every kind of report carries
	const shift = (cb & 4) !== 0;
	const meta = (cb & 8) !== 0;
	const ctrl = (cb & 16) !== 0;
	const low = cb & 3;

	// the wheel, read off bit 64 whatever the final byte says. A terminal sends a
	// wheel turn as a press and never as a release, so the `m` spelling is one
	// nothing produces -- and a turn is still a turn if one ever does, which is a
	// better answer than a release of a button that was never held
	if ((cb & 64) !== 0) {
		return Object.freeze({
			button: undefined,
			column,
			ctrl,
			kind: 'wheel' as const,
			meta,
			row,
			shift,
			wheel: WHEEL[low],
		});
	}

	const extra = (cb & 128) !== 0;
	const motion = (cb & 32) !== 0;

	return Object.freeze({
		// low bits of `3` with no extra bit is xterm's "no button": what
		// any-event tracking reports for the pointer crossing a cell with nothing
		// held. A release carries the bits of the button that was let go, so it is
		// the final byte rather than the bits that says a report is one
		button: extra ? EXTRAS[low] : low === 3 ? undefined : BUTTONS[low],
		column,
		ctrl,
		kind: released
			? ('mouseup' as const)
			: motion
				? ('mousemove' as const)
				: ('mousedown' as const),
		meta,
		row,
		shift,
		wheel: undefined,
	});
}
