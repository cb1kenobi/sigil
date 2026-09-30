import { ESC } from '../ansi/codes.js';

/**
 * The cursor and erase sequences, which are CSI rather than SGR.
 *
 * `src/ansi/codes.ts` is the SGR table -- codes that end in `m` and describe how
 * text looks. These end in other letters and describe where the cursor is and
 * what is on the screen, which is a different question with a different owner:
 * the styler never moves the cursor, and the terminal never styles anything.
 *
 * Written out rather than generated, for the same reason the SGR table is: the
 * name a caller types and the sequence the terminal receives sit on one line.
 */

/** Hides the cursor. A repaint with it visible flickers it across the line. */
export const HIDE_CURSOR: string = `${ESC}[?25l`;

/** Shows the cursor. Whatever hid it owes the terminal this one. */
export const SHOW_CURSOR: string = `${ESC}[?25h`;

/** Erases from the cursor to the end of the line, leaving the cursor put. */
export const ERASE_LINE_END: string = `${ESC}[K`;

/** Erases the whole line the cursor is on, leaving the cursor put. */
export const ERASE_LINE: string = `${ESC}[2K`;

/**
 * Erases from the cursor to the end of the screen.
 *
 * What a repaint clears: the cursor goes to the first row of the live region
 * and everything from there down goes, which is one sequence rather than an
 * erase per row and does not care how many rows the last frame wrapped to.
 */
export const ERASE_DOWN: string = `${ESC}[0J`;

/** Moves the cursor to column one of the line it is on. */
export const CURSOR_HOME: string = `\r`;

/**
 * Moves the cursor up.
 *
 * Zero is not "up none" to a terminal -- `ESC[0A` moves up one, because the
 * parameter defaults to 1 when it is absent or zero -- so no sequence is written
 * at all for a request to move nowhere.
 *
 * @param n - How many rows.
 * @returns The sequence, or an empty string.
 */
export function cursorUp(n: number): string {
	return n > 0 ? `${ESC}[${n}A` : '';
}

/**
 * Moves the cursor down. Zero writes nothing, as with `cursorUp()`.
 *
 * @param n - How many rows.
 * @returns The sequence, or an empty string.
 */
export function cursorDown(n: number): string {
	return n > 0 ? `${ESC}[${n}B` : '';
}

/**
 * Moves the cursor right. Zero writes nothing, as with `cursorUp()`.
 *
 * @param n - How many columns.
 * @returns The sequence, or an empty string.
 */
export function cursorRight(n: number): string {
	return n > 0 ? `${ESC}[${n}C` : '';
}

/**
 * Moves the cursor to the top-left of the screen.
 *
 * `CURSOR_HOME` is a carriage return, which is the *line's* home; this is the
 * screen's. A full-screen backend positions absolutely rather than relatively,
 * because it owns every row and has no log above it to be careful of.
 */
export const CURSOR_TOP_LEFT: string = `${ESC}[H`;

/**
 * Switches to the alternate screen buffer, which has no scrollback of its own.
 *
 * `1049` rather than `47` or `1047`: it saves the cursor, switches, and clears
 * in one sequence, and it is what every terminal worth supporting implements.
 * The pair of these is what makes a full-screen app leave the user's scrollback
 * exactly as it found it.
 */
export const ENTER_ALT_SCREEN: string = `${ESC}[?1049h`;

/** Returns to the main screen. Whatever left it owes the terminal this one. */
export const LEAVE_ALT_SCREEN: string = `${ESC}[?1049l`;

/**
 * Asks the terminal to wrap a paste in markers.
 *
 * Without it a pasted block arrives as though it had been typed, so a newline in
 * the middle of it is Enter and a text input submits half an address. With it
 * the paste arrives between `ESC [ 200 ~` and `ESC [ 201 ~`, and what is between
 * them is content rather than keys.
 */
export const ENABLE_PASTE: string = `${ESC}[?2004h`;

/** Stops the markers. Whatever asked for them owes the terminal this one. */
export const DISABLE_PASTE: string = `${ESC}[?2004l`;

/** What a bracketed paste starts with. */
export const PASTE_START: string = `${ESC}[200~`;

/** What a bracketed paste ends with. */
export const PASTE_END: string = `${ESC}[201~`;

/**
 * Asks the terminal to report the mouse in the SGR encoding.
 *
 * `1006` is not optional and is never written on its own: the legacy encoding
 * puts a coordinate in one byte of `32 + n`, so it runs out at column 223, and
 * what that looks like is an app ignoring clicks down the right-hand side of a
 * wide window. Enabled *before* a tracking mode and disabled *after* one, so
 * there is never a window in which the mouse is being reported in an encoding
 * nothing here reads.
 */
export const ENABLE_MOUSE_SGR: string = `${ESC}[?1006h`;

/** Stops the SGR encoding. Whatever asked for it owes the terminal this one. */
export const DISABLE_MOUSE_SGR: string = `${ESC}[?1006l`;

/**
 * Button-event tracking: presses, releases, and motion while a button is held.
 *
 * The default, because the alternative reports every cell the pointer crosses
 * forever over what may be an ssh link. What it costs is `:hover`, which needs to
 * know where the pointer is when nobody is pressing anything.
 */
export const ENABLE_MOUSE_BUTTONS: string = `${ESC}[?1002h`;

/** Stops button-event tracking. */
export const DISABLE_MOUSE_BUTTONS: string = `${ESC}[?1002l`;

/**
 * Any-event tracking: every cell the pointer crosses, held or not.
 *
 * What `:hover` actually needs, and opt-in for the reason it is not the default:
 * this is a report per cell of pointer travel, for as long as the app runs.
 */
export const ENABLE_MOUSE_MOTION: string = `${ESC}[?1003h`;

/** Stops any-event tracking. */
export const DISABLE_MOUSE_MOTION: string = `${ESC}[?1003l`;
