import { isPlainObject } from './dotted.js';
import { scanJsonc } from './jsonc.js';
import {
	applyEdits,
	LINE_END,
	lineIndent,
	lineStartAt,
	ownLineIndent,
	type Edit,
	type Span,
} from './spans.js';

/**
 * Writing a JSONC file back without destroying it.
 *
 * ## The structure is scanned over the *blanked* text, and that is the whole
 * trick
 *
 * `scanJsonc()` replaces every comment and trailing comma with a space and
 * keeps every newline, so what it hands back is ordinary JSON **at the same
 * offsets as the source**. Its own doc comment says this editor works over the
 * original text with that same scan, and this is what that comes to: the
 * structural pass below reads the blanked text, where there are no comments and
 * no trailing commas and the grammar is plain JSON, and every span it records
 * is a span of the source. One grammar with two readers that cannot come to
 * disagree, because one feeds the other.
 *
 * So two texts are in play and each answers what it is for. **Structure** is
 * the blanked text's: where a value starts and ends, and -- because a comment
 * is whitespace there -- where the comma between two entries is, which is what
 * lets a comment sitting between them survive. **Trivia** is the source's: what
 * a line is indented by, whether a comment follows a value on its line, whether
 * the container spans lines at all.
 *
 * ## A node tree rather than a path-to-span index
 *
 * The obvious shared shape is a map from dotted path to span, and it cannot
 * answer the question insertion asks: where the closing brace is, whether the
 * container spans lines, what its last entry is indented by, whether a comma
 * already follows it. A tree carries all of that and the index is a walk of it,
 * so the tree is what is built.
 *
 * ## Minimal edits, which is what makes it lossless
 *
 * A scalar that changed has its span replaced. A key that is new is spliced in
 * after the last one. A key that is gone has its own span removed along with
 * exactly one comma. An object or array that is still an object or array is
 * walked into rather than reprinted, so a comment inside one survives a change
 * to a sibling. Nothing else is touched, and "nothing else" is literal: it is
 * the same bytes.
 */

/** What a value is, as far as editing cares. */
type NodeKind = 'array' | 'object' | 'scalar';

/** One value, with the span it occupies in the source. */
interface Node {
	/** The offset of the closing `}` or `]`, for a container. */
	readonly close?: number;
	/** The entries, for a container: an object's members or an array's elements. */
	readonly entries?: readonly Entry[];
	readonly kind: NodeKind;
	/** The offset of the opening `{` or `[`, for a container. */
	readonly open?: number;
	readonly span: Span;
}

/**
 * One thing inside a container.
 *
 * An object member and an array element are one shape here, because the comma
 * handling, the line handling and the indentation are the same question for
 * both and only the serialization of a *new* one differs. `key` is what says
 * which it is.
 */
interface Entry {
	/** The member's key, or nothing for an array element. */
	readonly key?: string;
	readonly node: Node;
	/** The key start to the value end for a member; the value's span for an element. */
	readonly span: Span;
}

/** What the walk needs that is not the tree. */
interface Ctx {
	/** The source with its comments and trailing commas blanked out. */
	readonly blank: string;
	/**
	 * Commas a removal deleted **on its own**, leaving the trivia after them.
	 *
	 * That is what happens when a comment sits in the gap: the comma goes and the
	 * comment stays, so an insertion anchored on the entry before it still has to
	 * go past that comment. The pair with `eaten` is what `insertInto()` reads --
	 * one records a comma whose line survived it and the other one whose did not.
	 */
	readonly cut: Set<number>;
	readonly edits: Edit[];
	/**
	 * Commas a removal swallowed into its own **range**, taking the gap with them.
	 *
	 * So there is nothing left between the entry before and what was removed, and
	 * an insertion has to anchor back at the value: anchoring past the comma would
	 * land inside the removal, which is an overlapping edit.
	 */
	readonly eaten: Set<number>;
	/** The line ending the document uses, so an inserted line matches it. */
	readonly eol: string;
	readonly source: string;
	/** One level of indentation, as this document writes it. */
	readonly step: string;
	/**
	 * Where the source's trailing commas are, which `blank` cannot say.
	 *
	 * The scan blanks one to a space, so it is whitespace to every walk over the
	 * blanked text -- and a comma in the source, which is why watching the source
	 * instead is no answer either: a comma inside a comment is a comma there too.
	 * So the scan reports the offsets and this is the only thing that can use
	 * them. Found by review, over a container whose every entry was removed and
	 * whose trailing comma was then left with nothing in front of it.
	 */
	readonly trailing: ReadonlySet<number>;
}

/** What `editJsonc()` takes beyond the two values. */
export interface EditOptions {
	/** The file, for a message. */
	readonly what: string;
}

/** The indentation a document with nothing to copy from gets. */
export const DEFAULT_STEP = '\t';

/** Nothing is being dropped, which is every array insertion and most object ones. */
const EMPTY: ReadonlySet<number> = new Set();

/** JSON's own whitespace, which is all the blanked text can hold between tokens. */
function isSpace(c: string | undefined): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** Whether a character ends a bare scalar. */
function isDelimiter(c: string | undefined): boolean {
	return c === undefined || c === ',' || c === '}' || c === ']' || isSpace(c);
}

/** Past the whitespace, which in the blanked text is past the comments too. */
function skipSpace(text: string, from: number): number {
	let i = from;
	while (i < text.length && isSpace(text[i])) {
		i++;
	}
	return i;
}

/**
 * Past a quoted string.
 *
 * `\\` escapes whatever follows, which is the only rule this needs -- what the
 * escape *means* is `JSON.parse`'s business, which is the same split the
 * scanner takes.
 *
 * @param text - The blanked text.
 * @param from - The offset of the opening quote.
 * @returns The offset just past the closing quote.
 */
function skipString(text: string, from: number): number {
	let i = from + 1;
	while (i < text.length) {
		if (text[i] === '\\') {
			i += 2;
			continue;
		}
		if (text[i] === '"') {
			return i + 1;
		}
		i++;
	}
	return text.length;
}

/**
 * Reads one value's structure out of the blanked text.
 *
 * Written to the JSON grammar with no error handling at all, which is sound
 * because `JSON.parse()` has already succeeded on this exact text: `editJsonc()`
 * parses before it structures, so there is no malformed input for this to meet
 * and no half-grammar for a guard to describe.
 *
 * @param text - The blanked text.
 * @param from - Where to start looking.
 * @returns The node and the offset just past it.
 */
function readNode(text: string, from: number): { end: number; node: Node } {
	const start = skipSpace(text, from);
	const c = text[start];

	if (c === '{' || c === '[') {
		const object = c === '{';
		const entries: Entry[] = [];
		let i = skipSpace(text, start + 1);

		while (i < text.length && text[i] !== (object ? '}' : ']')) {
			let key: string | undefined;
			let at = i;

			if (object) {
				const keyEnd = skipString(text, i);
				key = JSON.parse(text.slice(i, keyEnd)) as string;
				at = skipSpace(text, keyEnd) + 1;
			}

			const read = readNode(text, at);
			entries.push({
				...(key !== undefined && { key }),
				node: read.node,
				span: { end: read.node.span.end, start: i },
			});

			i = skipSpace(text, read.end);
			if (text[i] === ',') {
				i = skipSpace(text, i + 1);
			}
		}

		return {
			end: i + 1,
			node: {
				close: i,
				entries,
				kind: object ? 'object' : 'array',
				open: start,
				span: { end: i + 1, start },
			},
		};
	}

	const end = c === '"' ? skipString(text, start) : bareEnd(text, start);
	return { end, node: { kind: 'scalar', span: { end, start } } };
}

/** Past a `true`, a `false`, a `null` or a number. */
function bareEnd(text: string, from: number): number {
	let i = from;
	while (i < text.length && !isDelimiter(text[i])) {
		i++;
	}
	return i;
}

/**
 * Whether two values are the same as far as a JSON document is concerned, which
 * is **identity and nothing else**.
 *
 * A structural comparison was written here first and every branch of it was
 * dead, which a sabotage said and this proves: `node.kind` and `current` agree
 * by construction, because the node was scanned out of the same text
 * `JSON.parse` produced the value from. So `diffNode()` reaches this only where
 * the two *kinds* differ -- an object where the file has a scalar, a scalar
 * where it has an array -- and two values of different kinds are never the same
 * whatever the comparison does. Two plain objects or two arrays go to
 * `diffObject()` and `diffArray()` and never arrive here at all.
 *
 * Which also makes it the safe direction to be narrow in: this is what decides
 * "no edit", so a comparison that could answer `true` for two different
 * structures is the one answer that silently keeps a stale value in the file. A
 * `false` where they really were equal costs a no-op edit, and the write is
 * skipped when the text did not change.
 *
 * @param a - What the file holds.
 * @param b - What it should hold.
 * @returns Whether an edit can be skipped.
 */
function same(a: unknown, b: unknown): boolean {
	return a === b;
}

/**
 * Serializes a value at an indentation.
 *
 * `JSON.stringify` does the grammar, for the reason the scanner leaves the
 * value grammar to `JSON.parse`: a second implementation of how a number or an
 * escape is written is a second one to get wrong. What is added is the
 * document's own indentation and line ending, which `JSON.stringify` has no way
 * to know about.
 *
 * @param value - The value.
 * @param indent - What the line it lands on is indented by.
 * @param ctx - The document's step and line ending.
 * @returns The text.
 */
function serialize(value: unknown, indent: string, ctx: Ctx): string {
	// `undefined` is the one value `JSON.stringify` answers for with `undefined`
	// rather than a string, and `canRepresent()` is what keeps it from arriving.
	// A tripwire rather than a case anybody has, which is the line
	// `clipboardSequence()`'s own unreachable assertion takes
	const text = JSON.stringify(value, null, ctx.step);
	if (text === undefined) {
		throw new Error('A config value JSON cannot represent reached the writer');
	}
	return text.split('\n').join(ctx.eol + indent);
}

/** A member, as it is written. */
function member(key: string, value: unknown, indent: string, ctx: Ctx): string {
	return `${JSON.stringify(key)}: ${serialize(value, indent, ctx)}`;
}

/**
 * The comma between an entry and whatever follows it, if there is one.
 *
 * Asked of the **blanked** text, which is what makes a comment between the two
 * survive: a comment is whitespace there, so the scan walks past it and finds
 * the comma, and the removal below then takes the comma without the comment.
 *
 * A **trailing** comma is blanked as well, so the walk cannot use `skipSpace()`
 * -- it would step straight over the one character it is looking for. The scan's
 * own offsets are what tell the two apart, and without them a container being
 * emptied left its trailing comma behind: `{ "a": 1, }` came out `{ , }`, which
 * is not JSON and which this scanner then refuses as an elision.
 *
 * @param ctx - The texts.
 * @param from - Just past the entry.
 * @param limit - The closing brace, which bounds the search.
 * @returns The comma's offset, or `-1`.
 */
function commaAfter(ctx: Ctx, from: number, limit: number): number {
	let at = from;
	while (at < limit && !ctx.trailing.has(at) && isSpace(ctx.blank[at])) {
		at++;
	}
	return at < limit && (ctx.blank[at] === ',' || ctx.trailing.has(at)) ? at : -1;
}

/**
 * The comma before an entry, if there is one.
 *
 * @param ctx - The texts.
 * @param from - The entry's start.
 * @param limit - The opening brace, which bounds the search.
 * @returns The comma's offset, or `-1`.
 */
function commaBefore(ctx: Ctx, from: number, limit: number): number {
	let i = from;
	while (i > limit && isSpace(ctx.blank[i - 1])) {
		i--;
	}
	return i > limit && ctx.blank[i - 1] === ',' ? i - 1 : -1;
}

/**
 * Where an inserted member goes on a multi-line container's last line: past the
 * comma and past whatever trivia follows it, but before the line ends.
 *
 * The three cases this is for, and the first is why it cannot be a scan for the
 * next newline. A **block comment holding a line break** would have the insert
 * land inside the comment and break it, so comments are skipped as comments
 * rather than scanned past. A **line comment** ends at the line terminator,
 * which is exactly where the insert belongs, so the new member goes under it
 * and the comma stays in front of it. And a container whose **closing brace is
 * on this line** has no line to end, so the insert goes straight after the
 * value.
 *
 * @param ctx - The texts.
 * @param from - Just past the comma, or just past the value where there is none
 * or a removal swallowed it.
 * @param limit - The closing brace.
 * @returns Where to insert, which is `from` when the line does not end first.
 */
function lineTriviaEnd(ctx: Ctx, from: number, limit: number): number {
	let i = from;

	for (;;) {
		// the bound said rather than relied upon: deleting it changes no answer,
		// because the character at `limit` is the closing brace and the fallthrough
		// at the bottom returns `from` for one anyway. A declared survivor of the
		// sabotage pass, kept because a scan that walks to a limit should say what
		// the limit is rather than leave it to a reader to notice that a brace
		// happens to stop it
		if (i >= limit) {
			return from;
		}

		const c = ctx.source[i] as string;

		if (c === ' ' || c === '\t') {
			i++;
			continue;
		}

		if (LINE_END.test(c)) {
			return i;
		}

		if (c === '/' && ctx.source[i + 1] === '/') {
			while (i < limit && !LINE_END.test(ctx.source[i] as string)) {
				i++;
			}
			return i < limit ? i : from;
		}

		if (c === '/' && ctx.source[i + 1] === '*') {
			const close = ctx.source.indexOf('*/', i + 2);
			if (close === -1 || close + 2 > limit) {
				return from;
			}
			i = close + 2;
			continue;
		}

		return from;
	}
}

/** Whether a container spans more than one line in the source. */
function multiline(ctx: Ctx, node: Node): boolean {
	return LINE_END.test(ctx.source.slice(node.open as number, node.close as number));
}

/**
 * What an inserted entry is indented by.
 *
 * The last entry that **owns its line**, because that is the one a reader would
 * expect a new sibling to line up with -- and reading from the end rather than
 * the start so that `{ "a": 1,\n\t"b": 2 }` inherits `\t` rather than nothing.
 * Where no entry owns a line, the container's own line plus one step, which is
 * the only thing left to go on and is also the answer for an empty container.
 *
 * @param ctx - The texts.
 * @param node - The container.
 * @returns The indentation.
 */
function entryIndent(ctx: Ctx, node: Node): string {
	const entries = node.entries ?? [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const own = ownLineIndent(ctx.source, (entries[i] as Entry).span.start);
		if (own !== undefined) {
			return own;
		}
	}

	return lineIndent(ctx.source, node.open as number) + ctx.step;
}

/**
 * What a **new entry's own value** is laid out at, which is not where its
 * separator goes.
 *
 * The two part company on one line. A multi-line container puts the new entry
 * on a line of its own, so its value's continuation lines are indented by the
 * entry's indent. A single-line one puts the entry *beside* the last, so the
 * value lands on the container's own line and is indented by that -- and
 * reading the entry's indent there would push a nested object one level further
 * in than the line it sits on, which is `{"a": 1, "b": {\n\t\t"c": 2\n\t}}`.
 *
 * @param ctx - The texts.
 * @param node - The container.
 * @returns The indentation.
 */
function insertIndent(ctx: Ctx, node: Node): string {
	return multiline(ctx, node)
		? entryIndent(ctx, node)
		: lineIndent(ctx.source, node.open as number);
}

/**
 * Splices new entries into a container, in one edit plus a separating comma.
 *
 * All of them in one edit rather than one each, which is the comma rule rather
 * than a saving: two calls would each add a separating comma after the same
 * value, so `{ "a": 1 }` grown by two keys would come out `{ "a": 1,, ... }`.
 *
 * @param ctx - The texts and the edits.
 * @param node - The container.
 * @param blobs - The entries, already serialized.
 * @param drop - The indices being removed, which are the ones this may not
 * anchor on.
 */
function insertInto(
	ctx: Ctx,
	node: Node,
	blobs: readonly string[],
	drop: ReadonlySet<number>
): void {
	const entries = node.entries ?? [];
	const open = node.open as number;
	const close = node.close as number;
	const lines = multiline(ctx, node);
	const indent = entryIndent(ctx, node);
	// the last entry that is **staying**, because the anchor has to be an offset
	// the file will still have: anchoring on an entry that is being removed puts
	// the separator inside the removal, which is a dangling comma and invalid JSON
	const kept = entries.filter((_, i) => !drop.has(i));

	if (kept.length === 0) {
		// nothing to anchor on. An object whose every key is being replaced
		// anchors just inside the brace, which is the one offset no removal can
		// reach; a container that was empty to begin with anchors after whatever
		// trivia is already inside it, so that a comment somebody left in an empty
		// object stays in front of what is added. The whitespace the second case
		// walks back over is the source's, which is why a blanked comment cannot
		// be mistaken for it
		let at = open + 1;
		if (entries.length === 0) {
			at = close;
			while (at > open + 1 && isSpace(ctx.source[at - 1])) {
				at--;
			}
		}

		const text = lines
			? blobs.map((blob) => ctx.eol + indent + blob).join(',')
			: // a space either side, unless there is already whitespace before the
				// closing brace to serve as the second one
				` ${blobs.join(', ')}${at === close ? ' ' : ''}`;

		ctx.edits.push({ end: at, start: at, text });
		return;
	}

	const last = kept[kept.length - 1] as Entry;

	// the comma that already follows the last kept entry, which decides both
	// where this goes and whether a separator has to be written. Three answers
	// rather than two, because a removal may have taken it and what it took with
	// it is the question: `eaten` is a comma swallowed into a removal range, so
	// the gap after it went too and the anchor is back at the value -- anchoring
	// past it would land *inside* that range, which is an overlapping edit --
	// while `cut` is one deleted on its own, which is what happens when a comment
	// sits in the gap, so the comment is still there and still has to be gone
	// past.
	//
	// The first version read none of this: it anchored at the value whatever
	// followed, so `lineTriviaEnd()` met the comma at its first character and
	// bailed, and a new key was spliced in **front** of the last entry's own
	// inline comment -- which then read as a comment about the new key. Found by
	// review, and it is why the branch below is back after a sabotage pass had
	// proved it dead: the premise that deletion rested on was that `commaAfter()`
	// could not see a trailing comma, and an earlier round taught it to
	const comma = commaAfter(ctx, last.span.end, close);
	const eaten = comma !== -1 && ctx.eaten.has(comma);
	const reuse = comma !== -1 && !eaten && !ctx.cut.has(comma);
	const from = comma === -1 || eaten ? last.span.end : comma + 1;
	const at = lines ? lineTriviaEnd(ctx, from, close) : from;
	const sep = lines ? ctx.eol + indent : ' ';

	// the separator the last entry never needed, which goes directly after it
	// rather than at the insertion point: with a line comment in between, a comma
	// written after the comment would be *inside* it. Only where there is not
	// already one to serve, or the two make `1,,` and nothing parses
	if (!reuse) {
		ctx.edits.push({ end: last.span.end, start: last.span.end, text: ',' });
	}

	// and the user's trailing comma put back, where the one being reused is it.
	// It is no longer in front of what this adds -- the anchor is past it now --
	// so what used to be the trailing comma is a separator, and the style is kept
	// by writing one rather than by leaving one where it was
	const trail = reuse && ctx.trailing.has(comma) ? ',' : '';

	ctx.edits.push({
		end: at,
		start: at,
		text: blobs.map((blob) => sep + blob).join(',') + trail,
	});
}

/**
 * Removes entries from a container, taking one comma each.
 *
 * A **run** at a time rather than an entry, because a run's commas and its
 * lines are one question -- `runsOf()` has the measurement, and the entry at a
 * time left an indented blank line behind. So the span is the whole run's and
 * one comma is taken for it.
 *
 * The comma is decided against what **survives** rather than against what is
 * there: a run takes the comma that **follows** it, and only one with no
 * survivor after it and a survivor before it reaches backwards instead -- which
 * means a container being emptied takes every comma in it forwards, where a rule
 * about "no survivors either side" would leave a dangling one and write invalid
 * JSON. That is true of a **separator** comma and of a **trailing** one, and it
 * was true of the first alone until a review round: a trailing comma is blanked,
 * so the forward walk stepped over it and the emptied container kept it.
 * `commaAfter()` is where that is closed.
 *
 * Which comma it took is recorded on the `Ctx`, as `eaten` or `cut`, because
 * `insertInto()` has to know whether the comma after the last kept entry is
 * still going to be there and whether its line survived with it.
 *
 * The gap between the run and its comma is swallowed when it is whitespace
 * and left alone when it is not, which is what keeps a comment that sits there
 * -- at the cost of the whitespace around it, which is the lesser loss. What
 * that leaves is a comment on the **removed** entry's own line, which survives
 * onto the line above: preservation is this module's bias, and the residue is
 * that such a comment then reads as the surviving entry's. Written down rather
 * than closed, because the alternative is deleting a comment somebody wrote.
 *
 * @param ctx - The texts and the edits.
 * @param node - The container.
 * @param drop - The indices to remove.
 */
function removeFrom(ctx: Ctx, node: Node, drop: ReadonlySet<number>): void {
	const entries = node.entries ?? [];
	const open = node.open as number;
	const close = node.close as number;
	const survives = (from: number, to: number): boolean => {
		for (let i = from; i < to; i++) {
			if (!drop.has(i)) {
				return true;
			}
		}
		return false;
	};

	for (const [first, final] of runsOf(entries.length, drop)) {
		let { start } = (entries[first] as Entry).span;
		let { end } = (entries[final] as Entry).span;

		if (!survives(final + 1, entries.length) && survives(0, first)) {
			const comma = commaBefore(ctx, start, open);
			if (comma !== -1) {
				if (ctx.source.slice(comma + 1, start).trim() === '') {
					start = comma;
					ctx.eaten.add(comma);
				} else {
					ctx.edits.push({ end: comma + 1, start: comma, text: '' });
					ctx.cut.add(comma);
				}
			}
		} else {
			const comma = commaAfter(ctx, end, close);
			if (comma !== -1) {
				if (ctx.source.slice(end, comma).trim() === '') {
					end = comma + 1;
				} else {
					ctx.edits.push({ end: comma + 1, start: comma, text: '' });
				}
			}
		}

		// the trailing whitespace of what is being removed -- unless it is the
		// container's own padding before the closing brace, which belongs to the
		// container rather than to the run: `{ "a": 1 }` emptied has to keep the
		// space in front of its brace. And unless swallowing it would **glue** a
		// comment onto whatever precedes the range: `{ "a": 1,\n\t"b": 2 // on b\n}`
		// less `b` came out `"a": 1// on b`, where the comment reads as `a`'s and
		// the space is the only thing that was keeping them apart. Where what
		// precedes is itself whitespace, or the brace, there is nothing to glue to
		// and the space is still the run's -- which is what keeps `{ "a": 1 /* c */, }`
		// emptying to `{ /* c */ }` rather than to a double space. Found by review
		let ahead = end;
		while (ctx.source[ahead] === ' ' || ctx.source[ahead] === '\t') {
			ahead++;
		}
		const glues =
			ctx.source[ahead] === '/' &&
			(ctx.source[ahead + 1] === '/' || ctx.source[ahead + 1] === '*') &&
			start - 1 !== open &&
			!isSpace(ctx.source[start - 1]);
		if (ahead !== close && !glues) {
			end = ahead;
		}

		// and then the whole line where the run had one to itself, which is what an
		// editor does and is what stops a removal leaving an indented blank line
		// behind. It cannot fire for a run that reached backwards for its comma and
		// swallowed it, because the range then starts at that comma and a comma owns
		// no line.
		//
		// A comma still to come on that line goes with it, which is the half a
		// review round found: where the run reached backwards, the comma *after* it
		// is a trailing one the survivor above has no use for, and left where it was
		// it sat alone on an indented line of its own -- `{\n\t"a": 1 // keep a\n\t,\n}`.
		// Only where nothing but whitespace follows it, so a separator another run is
		// taking is never swallowed from under it
		const own = ownLineIndent(ctx.source, start) !== undefined;
		let tail = end;
		if (own && ctx.source[tail] === ',') {
			let after = tail + 1;
			while (ctx.source[after] === ' ' || ctx.source[after] === '\t') {
				after++;
			}
			if (LINE_END.test(ctx.source[after] ?? '')) {
				tail = after;
			}
		}

		if (own && LINE_END.test(ctx.source[tail] ?? '')) {
			start = lineStartAt(ctx.source, start);
			end = ctx.source.startsWith('\r\n', tail) ? tail + 2 : tail + 1;
		}

		ctx.edits.push({ end, start, text: '' });
	}
}

/**
 * The dropped indices as contiguous runs, each `[first, final]` inclusive.
 *
 * A run rather than an entry at a time, because a run's commas and its lines
 * are one question. With each entry answering for itself, one in the middle of
 * a dropped tail ended just before the comma the entry after it was taking --
 * so the line-removal above saw a comma rather than a line end, did not fire,
 * and left the run's first line behind as an indented blank one. Found by
 * review, over a tail of two.
 *
 * @param count - How many entries the container has.
 * @param drop - The indices being removed.
 * @returns The runs, in source order.
 */
function runsOf(count: number, drop: ReadonlySet<number>): Array<[number, number]> {
	const runs: Array<[number, number]> = [];

	for (let i = 0; i < count; i++) {
		if (!drop.has(i)) {
			continue;
		}

		let final = i;
		while (final + 1 < count && drop.has(final + 1)) {
			final++;
		}

		runs.push([i, final]);
		i = final;
	}

	return runs;
}

/** Walks one value, emitting the edits that turn `current` into `next`. */
function diffNode(ctx: Ctx, node: Node, current: unknown, next: unknown): void {
	if (node.kind === 'object' && isPlainObject(current) && isPlainObject(next)) {
		diffObject(ctx, node, current, next);
		return;
	}

	if (node.kind === 'array' && Array.isArray(current) && Array.isArray(next)) {
		diffArray(ctx, node, current, next);
		return;
	}

	if (!same(current, next)) {
		ctx.edits.push({
			end: node.span.end,
			start: node.span.start,
			text: serialize(next, lineIndent(ctx.source, node.span.start), ctx),
		});
	}
}

/**
 * An object against an object: each member walked, the gone ones removed, the
 * new ones spliced in.
 *
 * **Duplicate keys** are the one thing in here that reads as pedantry and is
 * not. `{"a":1,"a":2}` is legal JSON and `JSON.parse` answers `2`, so the last
 * member of a name is the live one -- which means a *change* edits that one and
 * leaves the shadowed ones shadowed, while a *removal* has to take every one of
 * them or the shadowed value becomes live and the round trip changes a value
 * nobody touched. That is the worst class of failure this writer can have, so it
 * is handled rather than hoped about.
 */
function diffObject(
	ctx: Ctx,
	node: Node,
	current: Record<string, unknown>,
	next: Record<string, unknown>
): void {
	const entries = node.entries ?? [];
	const live = new Map<string, Entry>();
	for (const entry of entries) {
		live.set(entry.key as string, entry);
	}

	const drop = new Set<number>();
	for (const [index, entry] of entries.entries()) {
		const key = entry.key as string;
		if (!Object.hasOwn(next, key)) {
			drop.add(index);
		} else if (live.get(key) === entry) {
			diffNode(ctx, entry.node, current[key], next[key]);
		}
	}

	if (drop.size > 0) {
		removeFrom(ctx, node, drop);
	}

	const indent = insertIndent(ctx, node);
	const added = Object.keys(next)
		.filter((key) => !live.has(key))
		.map((key) => member(key, next[key], indent, ctx));

	if (added.length > 0) {
		insertInto(ctx, node, added, drop);
	}
}

/**
 * An array against an array: element-wise by index, then the tail.
 *
 * By index rather than by identity, which is what makes a `push` one insertion
 * and an `unshift` a rewrite of every element plus one. The second is the worse
 * of the two and is still correct, and what it keeps is everything between the
 * elements -- so a comment on a line of its own inside a list survives either.
 */
function diffArray(ctx: Ctx, node: Node, current: unknown[], next: unknown[]): void {
	const entries = node.entries ?? [];
	const shared = Math.min(entries.length, next.length);

	for (let i = 0; i < shared; i++) {
		diffNode(ctx, (entries[i] as Entry).node, current[i], next[i]);
	}

	if (next.length < entries.length) {
		const drop = new Set<number>();
		for (let i = next.length; i < entries.length; i++) {
			drop.add(i);
		}
		removeFrom(ctx, node, drop);
		return;
	}

	if (next.length > entries.length) {
		const indent = insertIndent(ctx, node);
		insertInto(
			ctx,
			node,
			next.slice(entries.length).map((it) => serialize(it, indent, ctx)),
			EMPTY
		);
	}
}

/**
 * One level of indentation, as this document writes it.
 *
 * Read off the document rather than chosen, because the user's indentation
 * style is one of the things a write is not being asked to change. The first
 * container with an entry that owns a line and is indented further than the
 * container's own line answers it; a document with no such container -- one
 * written on a single line -- gets the default, which is a tab because that is
 * what npm writes into a `package.json` and what this repository's own
 * formatter uses.
 *
 * @param source - The file as it is.
 * @param root - The root node.
 * @returns The step.
 */
function detectStep(source: string, root: Node): string {
	const stack: Node[] = [root];

	while (stack.length > 0) {
		const node = stack.shift() as Node;
		const entries = node.entries;

		if (entries === undefined) {
			continue;
		}

		const base = lineIndent(source, node.open as number);

		for (const entry of entries) {
			const own = ownLineIndent(source, entry.span.start);
			if (own !== undefined && own.length > base.length && own.startsWith(base)) {
				return own.slice(base.length);
			}
		}

		for (const entry of entries) {
			stack.push(entry.node);
		}
	}

	return DEFAULT_STEP;
}

/**
 * Rewrites a JSONC source so that it holds a new value, changing nothing else.
 *
 * @param source - The file as it is.
 * @param next - What it should hold.
 * @param opts - The format and the file's name.
 * @returns The new text, which is the old text where nothing changed.
 * @throws If the source is not readable as the format it claims.
 */
export function editJsonc(source: string, next: unknown, opts: EditOptions): string {
	const scan = scanJsonc(source, opts.what);

	// parsed before it is structured, which is what lets the structural pass be
	// written to the grammar with no error handling: a text `JSON.parse` has
	// accepted has no malformed shape left in it for a guard to describe
	const current = JSON.parse(scan.json) as unknown;
	const root = readNode(scan.json, 0).node;

	const ctx: Ctx = {
		blank: scan.json,
		cut: new Set(),
		edits: [],
		eaten: new Set(),
		// the document's own line ending, so an inserted line does not mix them.
		// Three rather than two: a `\r`-only document is rare and a mixed ending is
		// **silent**, which is the combination `LINE_END` is written for and which
		// a review round found this half of. U+2028 and U+2029 are deliberately not
		// here -- they end a line to every reader worth agreeing with and nothing
		// writes a document in them, so inserting a `\n` into one is the subset
		// this claims to be rather than a lost case
		eol: source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n',
		source,
		step: detectStep(source, root),
		trailing: new Set(scan.trailing),
	};

	diffNode(ctx, root, current, next);

	return applyEdits(source, ctx.edits);
}
