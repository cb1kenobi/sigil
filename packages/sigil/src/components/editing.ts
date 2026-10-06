/**
 * The editing rules a text field keeps, in one place because there are two
 * fields.
 *
 * Everything here was settled by the single-line prompt and is the half of it
 * that is easy to get wrong: a cursor is an offset into the value rather than an
 * index into its clusters, it only ever lands where `graphemes()` says one
 * character ends and the next begins, and an insertion is the one edit that does
 * not move by whole clusters. A multiline field is those rules over a list of
 * lines, so the rules are shared rather than written twice -- which is the whole
 * of what the extraction buys: `test/components/prompt.test.ts` is the
 * regression suite for it, and a second copy of `boundary()` is how the two come
 * to disagree about where a backspace lands.
 *
 * What is **not** here is anything about a field's shape. These are functions of
 * a string and an offset, so they are testable with neither a terminal nor a
 * tree -- which is the rule the layout engine and the selector engine already
 * keep, and is why word movement could be written for the multiline field and
 * unit-tested before either field had a row in it.
 */

import { graphemes } from '../width/index.js';
import type { Key } from './keys.js';

/**
 * A C0 or C1 control character.
 *
 * `decodeKeys()` names every C0 byte -- as Enter, Tab, Backspace, or Ctrl with a
 * letter -- so the only one that reaches a field as a character is a C1, which a
 * paste can carry. It draws as nothing or as a command, and neither is something
 * to put in an answer.
 *
 * Not global, deliberately: a global pattern carries `lastIndex` between calls,
 * so the second cluster asked about would be searched from wherever the first
 * stopped.
 */
const CONTROL_CHAR = /^\p{Cc}$/u;

/**
 * A cluster that is nothing but whitespace, which is what a word ends at.
 *
 * `\s+` rather than `\s`, because a cluster may be more than one code point and
 * one of the ones that is matters here: `graphemes()` keeps `\r\n` together, so
 * `^\s$` read a CRLF as a *word* character and word movement walked straight
 * over a line break. A field normalizes its own line endings, so that pair only
 * reaches this from a value a caller handed in -- which is exactly the input a
 * guard like this is for.
 */
const SPACE_CLUSTER = /^\s+$/u;

/** Every run of whitespace, which a one-line field flattens a paste into. */
const PASTED_BREAK = /\s+/gu;

/** A line ending in any of its three spellings. */
const LINE_BREAK = /\r\n|\r|\n/gu;

/** What an edit leaves behind: the value, and where the cursor ended up. */
export interface Edit {
	/** Where the cursor is, as an offset into `value`. */
	cursor: number;
	/** What has been typed. */
	value: string;
}

/**
 * Whether a cluster is a control character a field refuses to hold.
 *
 * @param cluster - One grapheme cluster.
 * @returns Whether it is one.
 */
export function isControlChar(cluster: string): boolean {
	return CONTROL_CHAR.test(cluster);
}

/**
 * Whether a cluster is whitespace, which is what a word and a wrap break end at.
 *
 * @param cluster - One grapheme cluster.
 * @returns Whether it is.
 */
export function isSpaceCluster(cluster: string): boolean {
	return SPACE_CLUSTER.test(cluster);
}

/**
 * The offset of the cluster boundary one step from `at`.
 *
 * The cursor is an offset into the value rather than an index into its clusters,
 * so that inserting and slicing stay ordinary string work -- but it only ever
 * lands where `graphemes()` says one character ends and the next begins.
 * `cursor ± 1` walks UTF-16 code units instead: an emoji is two of them, so a
 * backspace over one left a lone surrogate in the value and every edit after it
 * was working on a string no terminal can draw.
 *
 * An offset that is somehow not on a boundary snaps to one rather than being
 * refused, because the alternative to moving is a cursor that cannot move.
 *
 * @param value - What has been typed.
 * @param at - Where the cursor is.
 * @param direction - `-1` for the boundary before it, `1` for the one after.
 * @returns The offset, clamped to the ends of the value.
 */
export function boundary(value: string, at: number, direction: -1 | 1): number {
	let offset = 0;
	let previous = 0;

	for (const cluster of graphemes(value)) {
		offset += cluster.length;

		if (direction === 1) {
			if (offset > at) {
				return offset;
			}
		} else if (offset >= at) {
			return previous;
		}

		previous = offset;
	}

	return direction === 1 ? value.length : previous;
}

/**
 * Where an offset lands once the clusters around it are taken into account.
 *
 * An insertion is the one edit that does not move by whole clusters: what was
 * typed can join the cluster that follows the cursor rather than standing on its
 * own. A combining mark with nothing before it is its own cluster, so typing a
 * letter in front of one makes the two a single cluster two code units long and
 * leaves the cursor one unit into it -- and the backspace after that splits the
 * pair and leaves the mark behind, which is the same damage the astral case
 * causes with a surrogate.
 *
 * @param value - What has been typed.
 * @param at - The offset to place.
 * @returns `at` when it is already a boundary, else the end of the cluster it
 *   fell inside.
 */
export function snap(value: string, at: number): number {
	let offset = 0;

	for (const cluster of graphemes(value)) {
		if (offset >= at) {
			return offset;
		}
		offset += cluster.length;
	}

	return value.length;
}

/**
 * Types text in at the cursor, which is what a key and a paste both are.
 *
 * @param value - What has been typed.
 * @param cursor - Where the caret is.
 * @param input - What to insert.
 * @returns The value and the cursor after it.
 */
export function insertAt(value: string, cursor: number, input: string): Edit {
	if (input === '') {
		return { cursor, value };
	}

	const next = value.slice(0, cursor) + input + value.slice(cursor);
	return { cursor: snap(next, cursor + input.length), value: next };
}

/**
 * Takes the cluster before the cursor out, which is backspace.
 *
 * @param value - What has been typed.
 * @param cursor - Where the caret is.
 * @returns The value and the cursor after it.
 */
export function deleteBefore(value: string, cursor: number): Edit {
	const start = boundary(value, cursor, -1);
	if (start >= cursor) {
		return { cursor, value };
	}
	return { cursor: start, value: value.slice(0, start) + value.slice(cursor) };
}

/**
 * Takes the cluster after the cursor out, which is the delete key.
 *
 * @param value - What has been typed.
 * @param cursor - Where the caret is.
 * @returns The value and the cursor after it, which does not move.
 */
export function deleteAfter(value: string, cursor: number): Edit {
	return { cursor, value: value.slice(0, cursor) + value.slice(boundary(value, cursor, 1)) };
}

/**
 * Takes out everything between two offsets, leaving the cursor at the earlier.
 *
 * @param value - What has been typed.
 * @param from - One end.
 * @param to - The other.
 * @returns The value and the cursor after it.
 */
export function deleteRange(value: string, from: number, to: number): Edit {
	const start = Math.max(0, Math.min(from, to));
	const end = Math.min(value.length, Math.max(from, to));
	if (start >= end) {
		return { cursor: start, value };
	}
	return { cursor: start, value: value.slice(0, start) + value.slice(end) };
}

/**
 * The start of the word before `at`.
 *
 * Over the whitespace first and then over the word, which is `backward-word`:
 * a cursor sitting just after a word's last character has to end at that word's
 * start rather than at the gap it is in.
 *
 * **A line break is whitespace, so word movement crosses one.** That is what
 * readline and emacs both do in a buffer with newlines in it, and the
 * alternative -- stopping at the start of the line -- is a second rule that
 * Home already keeps. What it costs is that Ctrl-Left at the start of a line
 * lands on the last word of the line above, which is where the word is.
 *
 * @param value - What has been typed.
 * @param at - Where the caret is.
 * @returns The offset, which is a cluster boundary.
 */
export function wordBefore(value: string, at: number): number {
	const limit = Math.max(0, Math.min(at, value.length));
	/** The start offset of each cluster that begins before `limit`. */
	const starts: number[] = [];
	/** Whether each of those is whitespace. */
	const blanks: boolean[] = [];
	let offset = 0;

	for (const cluster of graphemes(value)) {
		if (offset >= limit) {
			break;
		}
		starts.push(offset);
		blanks.push(SPACE_CLUSTER.test(cluster));
		offset += cluster.length;
	}

	let i = starts.length;
	while (i > 0 && blanks[i - 1]) {
		i--;
	}
	while (i > 0 && !blanks[i - 1]) {
		i--;
	}

	return starts[i] ?? limit;
}

/**
 * The end of the word after `at`.
 *
 * Over the whitespace first and then over the word, which is `forward-word`, so
 * that it lands *after* the next word rather than in front of it. A line break
 * is whitespace here too, for the reason `wordBefore()` records.
 *
 * @param value - What has been typed.
 * @param at - Where the caret is.
 * @returns The offset, which is a cluster boundary.
 */
export function wordAfter(value: string, at: number): number {
	const from = Math.max(0, Math.min(at, value.length));
	let offset = 0;
	/** Whether a word has been entered, which is when its end is worth stopping at. */
	let inWord = false;

	for (const cluster of graphemes(value)) {
		const end = offset + cluster.length;

		// a cluster `from` falls inside has already been passed: the cursor is on a
		// boundary by construction, and a value handed in by a caller is the one
		// place it may not be
		if (end > from) {
			if (SPACE_CLUSTER.test(cluster)) {
				if (inWord) {
					return offset;
				}
			} else {
				inWord = true;
			}
		}

		offset = end;
	}

	return value.length;
}

/**
 * What a key types, or nothing when it is not a character.
 *
 * A printable key is anything that named itself rather than a key this knows
 * about: a character arrives with its name and its sequence the same string,
 * while a named key's name is one the terminal never sent -- `up` for `ESC [ A`,
 * `tab` for a `\t`. Space is named, and is still a character.
 *
 * **What is inserted is the sequence rather than the name**, so that the two can
 * never disagree.
 *
 * @param k - The key.
 * @returns What to insert, or `undefined`.
 */
export function typedText(k: Key): string | undefined {
	if (k.ctrl || k.meta) {
		return undefined;
	}
	if (k.name !== 'space' && k.name !== k.sequence) {
		return undefined;
	}

	const ch = k.name === 'space' ? ' ' : k.sequence;
	return isControlChar(ch) ? undefined : ch;
}

/**
 * A pasted block as one line, which is what a single-line field inserts.
 *
 * Every run of whitespace becomes one space: obeying a line break is what makes
 * a paste submit half an address, which is the whole reason a terminal brackets
 * a paste in the first place.
 *
 * **This and `pastedBlock()` are the two halves of a deliberate inversion**, and
 * they are next to each other so that the inversion is visible rather than
 * discovered. A single-line field flattens the breaks because it has one line to
 * put them on; a multiline field keeps them, because keeping them is the entire
 * point of having more than one line. Either field obeying the other's rule is
 * the obvious bug: a flattening textarea cannot be used to write a commit
 * message, and an obedient one-line field submits a fragment.
 *
 * @param block - What was pasted.
 * @returns What to insert.
 */
export function pastedLine(block: string): string {
	return [...graphemes(block.replaceAll(PASTED_BREAK, ' '))]
		.filter((cluster) => !isControlChar(cluster))
		.join('');
}

/**
 * A pasted block with its line breaks kept, which is what a multiline field
 * inserts.
 *
 * Normalized to `\n` first, so that a block copied out of a CRLF file carries no
 * `\r` into the value: a field's value uses one spelling of a line break and
 * nothing else, which is what lets every rule below count lines by splitting on
 * it.
 *
 * A **tab is kept**, which is the one exception to dropping the control
 * characters and is the lesser of two wrongs. It draws as a space, because that
 * is what every other text in this library draws for one -- the grid models no
 * tab stops, so a tab that measured one width and painted another would take a
 * column off every cell to its right. Dropping it instead takes the indentation
 * out of pasted code altogether, which is a worse answer than one column of it.
 *
 * @param block - What was pasted.
 * @returns What to insert.
 */
export function pastedBlock(block: string): string {
	return [...graphemes(block.replaceAll(LINE_BREAK, '\n'))]
		.filter((cluster) => cluster === '\n' || cluster === '\t' || !isControlChar(cluster))
		.join('');
}
