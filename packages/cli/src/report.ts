/**
 * The toolchain's own output, as element trees.
 *
 * `@ttylabs/cli` is the acceptance test for the framework, and the half of that
 * which was still outstanding is this one: it routed its own commands and was
 * built by itself, and then it printed its reports with `process.stderr.write()`
 * and a template string. A framework whose own toolchain assembles text by hand
 * has not been tested by anyone who had to live with its renderer.
 *
 * So a diagnostic is a flex row, a summary is a paragraph of styled runs, and
 * both go through `renderToString()` -- the same layout engine, painter and cell
 * grid a canvas uses, read back as lines. `table()` was already doing this for
 * the command tree and the chunk sizes; this is the rest of what the toolchain
 * says.
 *
 * ## There is no live display here, and that is measured rather than assumed
 *
 * SIG-78 asked whether "a scrolling log with progress underneath" works on the
 * inline canvas, which is the case the canvas ticket was parked over. The
 * toolchain turns out not to be that case, and every candidate was measured
 * before anything was written:
 *
 * - **`sigil build`** is 286ms for five hundred commands, and the read passes
 *   plus the type check are 140ms on this package. A progress display over a
 *   sub-second build is theatre.
 * - **The type check** is the one step that spawns a compiler, and TypeScript
 *   7's native port answers in 97ms here and 364ms on a fresh scaffold, most of
 *   that being process startup. Still not animation territory.
 * - **`sigil new`'s install** looked like the best candidate and is the most
 *   instructive refusal. Piped, a package manager detects no TTY and says
 *   *nothing at all* until it is finished: npm's four lines of output all
 *   arrived at 3907ms of a 3928ms run. There is no log to scroll and no
 *   progress to report, so a bar there would be inventing one. Given a TTY it
 *   is worse than useless -- pnpm drives the cursor itself, writing `ESC[1A`
 *   and an erase-display to repaint its own progress, which is precisely the
 *   "write above the region" that makes an inline canvas throw its anchor away.
 *   The manager already owns a live region; a canvas underneath it would be
 *   painting into rows something else is moving.
 *
 * Which leaves `stdio: 'inherit'` as the right answer for an install -- the
 * manager's own progress, unmediated -- and leaves this module rendering text.
 * That is a finding rather than a gap: the question the ticket asked has an
 * answer, and the answer is that this toolchain is not where a live region
 * earns its keep.
 *
 * ## The report asks the stream it is going to
 *
 * Diagnostics and summaries go to stderr; `--tree` and the chunk sizes go to
 * stdout, so that a tree can be piped without losing the problems. Those are two
 * destinations and they are not interchangeable: `sigil check 2>log.txt` with a
 * terminal on stdout is a stderr that takes no colour and a stdout that does,
 * and `supportsColor()` defaults to `process.stdout` -- so a report that reached
 * for the process's own styler would put escape sequences in that file and be
 * right about the wrong stream. Nothing was wrong before this module, because
 * the diagnostics carried no colour to put anywhere; colouring them is what
 * makes the rule load-bearing, so it is written down rather than left to the
 * default. The width is the same question and gets the same answer.
 */

import { type Diagnostic, displayPath } from './build/index.ts';
import { type ColorLevel, supportsColor } from '@ttylabs/sigil/ansi';
import {
	box,
	type Element,
	paragraph,
	renderToString,
	text as textNode,
	type TextRun,
	toDisplayText,
} from '@ttylabs/sigil/element';
import { themedCascade } from '@ttylabs/sigil/theme';
import { stringWidth } from '@ttylabs/sigil/width';
import { terminalWidth } from '@ttylabs/sigil/wrap';

/**
 * The toolchain's own classes, at origin `app`.
 *
 * Its own rather than the framework's, because the toolchain is an *app*: it
 * draws nothing a theme is expected to restyle, so it has no business in the
 * `sigil-*` vocabulary `FRAMEWORK_CSS` documents. The prefix is `cli-` for the
 * same reason, and the sheet is parsed at origin `app` -- which is the later
 * origin, so these beat the framework's defaults with an ordinary rule and no
 * `!important`. That an app sheet can do that is the thing worth proving here.
 *
 * Colours and attributes only, which is the rule the framework sheet keeps for
 * itself: the geometry is in props, where the code that worked it out can see
 * it.
 */
export const TOOLCHAIN_CSS = `
.cli-error { color: red }
.cli-warning { color: yellow }
.cli-location { dim: true }
.cli-app { font-weight: bold }
.cli-entry { dim: true }
.cli-note { dim: true }
.cli-ok { color: green }
`;

/**
 * The narrowest a message column may be before a diagnostic gives up on two
 * columns, which is the number help's own list uses.
 *
 * Below it, wrapping is a word per line -- and a `file:line:column:` prefix is
 * long enough that a narrow terminal reaches this often rather than as an edge
 * case.
 */
const MIN_MESSAGE = 20;

/** A stream a report can be written to, and asked about. */
export interface ReportStream {
	readonly columns?: number;
	readonly isTTY?: boolean;
}

/** Where a report is going, and what can be read about it. */
export interface Destination {
	/**
	 * The environment to detect from. Defaults to `process.env`.
	 *
	 * Threaded rather than left to the default because the stream is only half of
	 * the answer: `FORCE_COLOR`, `NO_COLOR`, `TERM` and `COLUMNS` all outrank what
	 * the stream says, which is what makes `FORCE_COLOR=3 sigil check | cat` work
	 * -- and it is the only way a test can ask about a terminal, since a vitest
	 * worker's stderr is a pipe with no `TERM` behind it.
	 */
	readonly env?: Record<string, string | undefined>;
	/** The stream it is written to. */
	readonly stream: ReportStream;
}

/**
 * Lays a report out for the stream it is bound for.
 *
 * Both halves of "what does this look like" are asked of that destination rather
 * than of the process: see the note above about `sigil check 2>log.txt`.
 *
 * @param element - The tree.
 * @param to - Where it is going.
 * @returns The lines, with no trailing newline.
 */
export function render(element: Element, to: Destination | ReportStream): string {
	const dest = destination(to);

	return renderToString(element, {
		cascade: themedCascade({ sheets: [TOOLCHAIN_CSS] }),
		colorLevel: reportLevel(dest),
		width: terminalWidth({ env: dest.env, stream: dest.stream }),
	});
}

/**
 * How much colour a destination takes.
 *
 * @param to - The destination.
 * @returns Its colour level.
 */
export function reportLevel(to: Destination | ReportStream): ColorLevel {
	const dest = destination(to);

	return supportsColor({ env: dest.env, stream: dest.stream });
}

/**
 * A destination, from either spelling.
 *
 * A bare stream is the ordinary call and reads the process's environment, which
 * is what every caller in this package wants; the long form is for a caller that
 * has an environment of its own to ask about.
 *
 * @param to - What the caller passed.
 * @returns It as a destination.
 */
function destination(to: Destination | ReportStream): Destination {
	return 'stream' in to ? to : { stream: to };
}

/**
 * A prefix as it will be drawn, on one line.
 *
 * Both halves are about the arithmetic below adding up, and both are the rules
 * `table()` records for a cell. `toDisplayText()` is what a `text` element
 * actually draws -- a tab becomes a space, and everything else a terminal has no
 * glyph for is dropped -- so it is what has to be measured. And a newline
 * becomes a space, because a diagnostic's location is one line by construction:
 * a prefix that wrapped would leave the message indented against a line it does
 * not belong to.
 *
 * @param value - The prefix.
 * @returns It, on one line, as it will be drawn.
 */
function oneLine(value: string): string {
	return toDisplayText(value).replaceAll('\n', ' ');
}

/**
 * Every diagnostic, as a block of rows.
 *
 * One tree for the whole report rather than one per diagnostic: a report is one
 * thing, and it is one cascade and one layout pass instead of a pair per line.
 *
 * @param diagnostics - What the build found.
 * @param opts - What to write paths relative to, and how wide.
 * @returns The rows.
 */
export function diagnosticsView(
	diagnostics: readonly Diagnostic[],
	opts: { relativeTo?: (file: string) => string; width: number }
): Element {
	return box(
		{ 'flex-direction': 'column' },
		...diagnostics.map((diagnostic) => diagnosticRow(diagnostic, opts))
	);
}

/**
 * One diagnostic: where it is, how much it means, and what to do about it.
 *
 * `file:line:column: severity: message` is what an editor, a terminal and a CI
 * log all already know how to read, so the shape is `formatDiagnostic()`'s and
 * only the drawing is new. What the drawing adds is the two things a string
 * cannot: the severity is coloured, and a message too long for the line wraps
 * in the column it started in rather than back at the margin -- which is the
 * hanging indent help gets from a flex row with a declared width.
 *
 * Declared, not grown into. A row's intrinsic height is taken with every child
 * offered the whole content box while placement hands each one a share, so a
 * message that wraps to three lines in its share measures two in the room it was
 * offered and the row after it is painted over the third. That is a known bug
 * with a known way round it, and the way round it is this subtraction.
 *
 * @param diagnostic - The diagnostic.
 * @param opts - What to write paths relative to, and how wide.
 * @returns The row.
 */
function diagnosticRow(
	diagnostic: Diagnostic,
	opts: { relativeTo?: (file: string) => string; width: number }
): Element {
	const { column, file, line, message, severity } = diagnostic;
	const shown = displayPath(opts.relativeTo ? opts.relativeTo(file) : file);
	const at =
		line === undefined ? shown : `${shown}:${line}${column === undefined ? '' : `:${column}`}`;

	// the location and the severity are one unwrappable prefix, because breaking
	// inside `file:12:3` gives a location nothing can jump to
	const location = oneLine(`${at}: `);
	const label = oneLine(`${severity}: `);
	const prefix: Element[] = [
		textNode(location, { class: 'cli-location', 'white-space': 'nowrap' }),
		textNode(label, { class: `cli-${severity}`, 'white-space': 'nowrap' }),
	];

	// measured as it will be *drawn*, which is the rule a table cell already
	// follows: a tab measures nothing and draws a space, so measuring the raw
	// string leaves the message column a column out per tab -- and a path really
	// can hold one. `oneLine()` is the other half, since a prefix two lines tall
	// would put the message beside the wrong one
	const room = opts.width - stringWidth(location) - stringWidth(label);

	// a message carrying a newline is output somebody captured rather than prose
	// -- `typecheck.ts` puts a compiler's whole stdout in one when it exited
	// without saying anything parseable -- so it is a `text` and keeps its own
	// spacing. A paragraph would collapse the runs of spaces that are the only
	// structure such a message has
	const body = (props: Record<string, number>): Element =>
		message.includes('\n')
			? textNode(message, { 'flex-shrink': 0, ...props })
			: paragraph([message], { 'flex-shrink': 0, ...props });

	// not enough room left to read as prose: the location takes the line and the
	// message is indented under it, which is what help's list does at the same
	// threshold and for the same reason
	if (room < MIN_MESSAGE) {
		return box(
			{ 'align-items': 'flex-start', 'flex-direction': 'column' },
			box({ 'flex-direction': 'row' }, ...prefix),
			body({ 'padding-left': 2, width: Math.max(3, opts.width) })
		);
	}

	return box(
		{ 'align-items': 'flex-start', 'flex-direction': 'row' },
		...prefix,
		body({ width: room })
	);
}

/**
 * The line that says what was read and how it went.
 *
 * Runs rather than a string carrying its own escapes, which is the rule help's
 * parentheticals already follow: a cell grid has nowhere to put a sequence that
 * arrived inside a string, and the painter strips them. So the app is bold, the
 * entry it was read from is dim, and the verdict is coloured by what it says.
 *
 * @param runs - The runs, in order.
 * @param width - How wide to wrap at.
 * @returns The line.
 */
export function summaryView(runs: readonly (TextRun | string)[], width: number): Element {
	return paragraph(runs, { width });
}
