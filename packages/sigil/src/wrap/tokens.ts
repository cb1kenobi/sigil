import { matcher } from '../ansi/strip.js';
import { graphemes, graphemeWidth } from '../width/index.js';

/**
 * One piece of styled text that nothing is allowed to break inside.
 *
 * There are two kinds and they are handled in opposite ways. A `sequence`
 * occupies no columns and must survive verbatim or in a form the state tracker
 * rebuilds. A `cluster` is one thing a terminal draws, of a known width, and is
 * the smallest thing a line can be broken between.
 */
export interface Token {
	text: string;
	type: 'cluster' | 'sequence';
	width: number;
}

/**
 * Splits styled text into the pieces a wrapper may reorder and the pieces it may
 * not touch.
 *
 * This is what neither `graphemes()` nor `strip()` can do on its own.
 * Segmenting the raw text would make `[`, `3`, `1`, and `m` into characters to
 * be counted and wrapped; stripping first would lose the styling the output is
 * supposed to keep. So the sequences are found first and everything between them
 * is segmented.
 *
 * @param text - The text to split.
 * @returns The tokens, in order.
 */
export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const sequences = matcher();
	let index = 0;

	for (const match of text.matchAll(sequences)) {
		// a zero-length match would not advance, and the matcher cannot produce
		// one -- every alternative requires an introducer -- but a guard here is
		// cheaper than an infinite loop if that ever stops being true
		if (match[0] === '') {
			continue;
		}

		if (match.index > index) {
			pushClusters(tokens, text.slice(index, match.index));
		}

		tokens.push({ text: match[0], type: 'sequence', width: 0 });
		index = match.index + match[0].length;
	}

	if (index < text.length) {
		pushClusters(tokens, text.slice(index));
	}

	return tokens;
}

/**
 * Segments a run of text with no sequences in it.
 *
 * @param tokens - The list to append to.
 * @param text - The run to segment.
 */
function pushClusters(tokens: Token[], text: string): void {
	for (const cluster of graphemes(text)) {
		tokens.push({ text: cluster, type: 'cluster', width: graphemeWidth(cluster) });
	}
}
