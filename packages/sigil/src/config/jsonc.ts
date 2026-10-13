import { __ } from '../i18n/index.js';
import { LINE_END, lineAt } from './spans.js';

/**
 * JSONC, as the two things it adds to JSON and nothing else.
 *
 * ## It strips rather than parses
 *
 * The obvious shape is a JSON parser that happens to allow comments, and it is
 * the wrong one: `JSON.parse` is the reference implementation of the JSON value
 * grammar -- `-0`, `1e400`, a surrogate pair written `\\uD83D\\uDE00`, the exact
 * set of legal escapes -- and a second one here would be a second grammar to
 * get wrong in a way nobody notices until a number comes back slightly
 * different. So this scans only for what JSONC *adds*: a comment and a trailing
 * comma. Each is replaced with a space, every newline is kept, and what comes
 * out is ordinary JSON at the **same offsets** -- so `JSON.parse`'s own message
 * still points at the character it was about, and SIG-154's span editor works
 * over the original text with this same scan.
 *
 * ## What it is not
 *
 * Not JSON5. No single-quoted strings, no unquoted keys, no `+1`, no hex, no
 * `NaN`. This is the flavour `tsconfig.json` and VS Code's settings are written
 * in, which is what people mean by a `.jsonc`, and widening it would be
 * inventing a dialect that other tools cannot read.
 */

/** A comment this scan found, for a store that has to report what it holds. */
export interface JsoncComment {
	/** 1-based line it starts on. */
	line: number;
	/** The comment text, including its introducer. */
	text: string;
}

/** What a scan produced. */
export interface JsoncScan {
	/** The comments, in the order they appear. */
	comments: JsoncComment[];
	/** The source with its comments and trailing commas blanked out. */
	json: string;
	/** Whether a trailing comma was found. */
	trailingCommas: boolean;
}

/** The byte order mark, which `JSON.parse` refuses and an editor writes. */
const BOM = '\uFEFF';

/**
 * Finds the comments and trailing commas in a JSONC source.
 *
 * @param text - The source.
 * @param allow - Whether the extensions are allowed. A `.json` file is scanned
 * with this off, so that a comment in one is reported as a comment -- which is
 * a message somebody can act on, where `JSON.parse`'s `Unexpected token /` is
 * one they have to work out.
 * @param what - The file, for the message.
 * @returns The scan.
 * @throws If an extension is found and not allowed, or a string or block
 * comment is never closed.
 */
export function scanJsonc(text: string, allow: boolean, what: string): JsoncScan {
	// a leading byte order mark is what an editor writes and what `JSON.parse`
	// refuses, and it is not a character the document holds -- blanked rather
	// than trimmed, so every offset after it still means what it meant
	const source = text.startsWith(BOM) ? ` ${text.slice(1)}` : text;

	const out: string[] = [];
	const comments: JsoncComment[] = [];
	let trailingCommas = false;

	// where the last comma was written, so that a `}` or `]` reached with nothing
	// but trivia in between can go back and blank it. `-1` is "no comma is
	// pending", which every value, key and brace resets it to
	let pendingComma = -1;

	// the last character that was not trivia, because a trailing comma is one
	// that *separated* something: after an opener or another comma there is
	// nothing in front of it, so `[,]` is an elision rather than a trailing comma
	// and belongs to `JSON.parse` to refuse. Blanking it read `[,]` as `[]` and
	// `{,}` as `{}`, which is wider than the flavour this claims to be -- VS
	// Code's own parser refuses both -- and is the scanner mis-classifying its
	// one rule rather than a format decision
	let last = '';
	let i = 0;

	/** Blanks a run, keeping its newlines so that line numbers survive. */
	const blank = (from: number, to: number) => {
		for (let j = from; j < to; j++) {
			out.push(source[j] === '\n' ? '\n' : ' ');
		}
	};

	while (i < source.length) {
		const c = source[i] as string;

		if (c === '"') {
			// a string is copied whole, because `//` inside one is not a comment and
			// a `,` inside one is not a comma. `\\` escapes the next character
			// whatever it is, which is the only rule this needs -- what the escape
			// *means* is `JSON.parse`'s business
			const start = i;
			let closed = false;
			i++;
			while (i < source.length) {
				if (source[i] === '\\') {
					i += 2;
					continue;
				}
				if (source[i] === '"') {
					i++;
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) {
				throw new Error(__`Unterminated string in ${what} on line ${lineAt(source, start)}`);
			}
			// a `\\` at the very end walked the cursor past the source, and `slice()`
			// clamps -- so the copy below would hand `JSON.parse` a string that ends
			// mid-escape. It cannot be reached, because walking past the end is
			// exactly the case `closed` is false for
			i = Math.min(i, source.length);
			out.push(source.slice(start, i));
			pendingComma = -1;
			last = '"';
			continue;
		}

		if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
			const start = i;
			const block = source[i + 1] === '*';
			let end: number;

			if (block) {
				const close = source.indexOf('*/', i + 2);
				if (close === -1) {
					throw new Error(__`Unterminated comment in ${what} on line ${lineAt(source, start)}`);
				}
				end = close + 2;
			} else {
				// a line comment ends at **any** line terminator, not at `\n` alone.
				// A classic-Mac `\r`-only file ran the comment to the end of the
				// document, so `{ "a": 1 // c\r "b": 2 }` blanked a real key and
				// `JSON.parse` succeeded as `{ "a": 1 }` -- a key dropped with no
				// error at all. Found by review. `\u2028` and `\u2029` are line
				// terminators to JavaScript and to every JSONC reader worth agreeing
				// with, so they end one too
				end = i + 2;
				while (end < source.length && !LINE_END.test(source[end] as string)) {
					end++;
				}
			}

			if (!allow) {
				throw new Error(__`Comments are not allowed in ${what}, on line ${lineAt(source, start)}`);
			}

			comments.push({ line: lineAt(source, start), text: source.slice(start, end) });
			blank(start, end);
			i = end;
			// a comment is trivia, so it neither opens nor closes the window a
			// pending comma is waiting in: `[1, /* two */]` is a trailing comma
			continue;
		}

		if (c === ',') {
			// armed only where something precedes it to have been separated
			pendingComma = last === '' || last === '[' || last === '{' || last === ',' ? -1 : out.length;
			out.push(c);
			last = c;
			i++;
			continue;
		}

		if (c === '}' || c === ']') {
			if (pendingComma !== -1) {
				if (!allow) {
					throw new Error(
						__`Trailing commas are not allowed in ${what}, on line ${lineAt(source, i)}`
					);
				}
				out[pendingComma] = ' ';
				trailingCommas = true;
			}
			pendingComma = -1;
			out.push(c);
			last = c;
			i++;
			continue;
		}

		// whitespace is the only other thing that may sit between a comma and a
		// closing brace; anything else is a value, which means the comma was a
		// separator rather than a trailing one
		if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
			pendingComma = -1;
			last = c;
		}

		out.push(c);
		i++;
	}

	return { comments, json: out.join(''), trailingCommas };
}

/**
 * Parses a JSON or JSONC source.
 *
 * @param text - The source.
 * @param allow - Whether comments and trailing commas are allowed.
 * @param what - The file, for the message.
 * @returns The value and the comments that were in it.
 * @throws If it is not readable as the format it claims.
 */
export function parseJsonc(
	text: string,
	allow: boolean,
	what: string
): { comments: JsoncComment[]; value: unknown } {
	const scan = scanJsonc(text, allow, what);

	try {
		return { comments: scan.comments, value: JSON.parse(scan.json) as unknown };
	} catch (e: unknown) {
		// the outer frame is a key and the inner half is V8's own English, which is
		// the split `Invalid JSON: {0}` already takes: a translator gets the
		// sentence and the engine's message arrives as data
		throw new Error(__`Failed to parse ${what}: ${(e as Error).message}`);
	}
}
