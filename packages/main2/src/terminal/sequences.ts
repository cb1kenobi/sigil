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
