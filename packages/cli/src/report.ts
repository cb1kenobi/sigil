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
 * ## A terminal gets the laid-out form; a pipe gets one line per diagnostic
 *
 * This is `tsc --pretty`'s split and it exists for the reason that flag does. A
 * wrapped diagnostic is easier for a person to read and **worse** for everything
 * else: `grep "a string literal"` stops matching the moment the wrap falls
 * between "string" and "literal", and that is the one output people really do
 * pipe into tooling. So whether there is a terminal decides *what is drawn*
 * rather than only how -- which is the rule the spinner and the progress bar
 * already follow, down to the promise that comes with it: **the piped output is
 * byte for byte what it was** before any of this was rendered.
 *
 * The two cannot drift apart in the part that matters, because the location is
 * `diagnosticLocation()`'s and both forms print it. What differs is the wrapping
 * and the colour, which is what the destination was asked about.
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

import { type Diagnostic, diagnosticLocation, formatDiagnostic } from './build/index.ts';
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
import { parseStylesheet, type Stylesheet } from '@ttylabs/sigil/style';
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
 * The toolchain's sheet, parsed once.
 *
 * Once for the reason `frameworkSheet()` is: a `Stylesheet` is frozen and a
 * `Cascade` only reads it, so parsing it per report would be the same work twice
 * a run with nothing about it that can differ between two callers. It is also
 * where a typo in the sheet surfaces -- an unknown property is an error rather
 * than a skipped declaration -- so the first report of a run is what raises it,
 * which is why the tests render.
 */
let sheet: Stylesheet | undefined;

/**
 * The stylesheet a report is drawn with.
 *
 * @returns The sheet, at origin `app`.
 */
function toolchainSheet(): Stylesheet {
	sheet ??= parseStylesheet(TOOLCHAIN_CSS);
	return sheet;
}

/**
 * The narrowest a message column may be before a diagnostic gives up on two
 * columns, which is the number help's own list uses.
 *
 * Below it, wrapping is a word per line -- and a `file:line:column:` prefix is
 * long enough that a narrow terminal reaches this often rather than as an edge
 * case.
 */
const MIN_MESSAGE = 20;

/**
 * Whitespace a message's author meant, which makes it output rather than prose.
 *
 * A newline or a run of two or more spaces. Either one is structure a paragraph
 * would destroy, and both arrive the same way: something captured text and put it
 * in a diagnostic.
 */
const VERBATIM = /\n|  /;

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
 * It takes a **builder** rather than a tree, because the width is the one thing
 * a report's caller and its renderer both have to know and must never disagree
 * about. A diagnostic's message column is a *declared* width -- it has to be,
 * for the reason `diagnosticRow()` records -- so the caller subtracts from the
 * width it thinks the report is being laid out in, while `renderToString()` lays
 * it out in the width this function works out. Handing the tree in meant those
 * were two computations of one number: `terminalWidth()` caps at `MAX_WIDTH`, so
 * a caller that took `stream.columns` for the width instead declared a message
 * column for a 200-column terminal inside a grid laid out for 100 -- and the
 * grid grows to its content, so what came out was a 200-column line that the
 * terminal then wrapped raggedly, with nothing truncated and nothing to say so.
 * Passing the width *to* the builder is what makes that unrepresentable rather
 * than a rule to remember.
 *
 * @param build - What to draw, given the width it will be drawn in.
 * @param to - Where it is going.
 * @returns The lines, with no trailing newline.
 */
export function render(build: (width: number) => Element, to: Destination | ReportStream): string {
	const dest = destination(to);
	// normalized the way `renderToString()` normalizes it, so that the number the
	// builder is given is the number it is laid out in rather than one rounding
	// away from it
	const width = Math.max(1, Math.floor(terminalWidth({ env: dest.env, stream: dest.stream })));

	return renderToString(build(width), {
		cascade: themedCascade({ sheets: [toolchainSheet()] }),
		colorLevel: reportLevel(dest),
		width,
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
	opts: { width: number }
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
function diagnosticRow(diagnostic: Diagnostic, opts: { width: number }): Element {
	const { message, severity } = diagnostic;

	// the location and the severity are one unwrappable prefix, because breaking
	// inside `file:12:3` gives a location nothing can jump to. It comes from
	// `diagnosticLocation()` rather than being rebuilt here, which is what makes
	// the claim that both forms print the same location true rather than merely
	// intended -- the first version of this rebuilt it, and a tab in the path was
	// then a different location on a terminal than in a pipe
	const location = oneLine(`${diagnosticLocation(diagnostic)}: `);
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

	// a message whose whitespace is structure is output somebody captured rather
	// than prose -- `typecheck.ts` puts a compiler's whole stdout in one when it
	// exited without saying anything parseable -- so it keeps its own spacing.
	// `nowrap` is what that takes and `normal` is not enough: `normal` honours the
	// author's newlines and then *reflows* each line, so a code line wrapped and
	// the caret under it no longer sat beneath what it pointed at -- which is the
	// opposite of printing it as it stands. Overflowing instead is the rule the
	// location prefix already follows, and the grid grows to its content, so
	// nothing is lost.
	//
	// A run of two spaces counts as well as a newline, because a paragraph splits
	// on `/\s+/`: `expected '  ' here` came out as `expected ' ' here`, so the
	// terminal disagreed with the pipe about what the message said. One rule --
	// whitespace the author put there is structure -- rather than two.
	const body = (props: { 'padding-left'?: number; width: number }): Element => {
		if (!VERBATIM.test(message)) {
			return paragraph([message], { 'flex-shrink': 0, ...props });
		}

		// its own width wherever it overhangs, which is the rule help's own labels
		// follow and the trap that `nowrap` walks into without it: `text-overflow`
		// bites on a line wider than the box it was given, so a declared column
		// narrower than the content silently *cut* the dump -- a code line came out
		// as `const x = "hello h` with the rest gone. Overflowing is the honest
		// answer and costs nothing, because the grid grows to its content.
		// Measured as it will be drawn, for the reason the prefix is
		const natural = Math.max(
			...toDisplayText(message)
				.split('\n')
				.map((line) => stringWidth(line))
		);

		// the padding is *inside* the width, because `box-sizing` starts at
		// `border-box` -- so a width of exactly `natural` leaves the content two
		// columns short in the stacked case and cuts the end off each line. That is
		// the border-box rule this repo already records for a themed table cell, met
		// from the other side
		const pad = props['padding-left'] ?? 0;

		return textNode(message, {
			'flex-shrink': 0,
			'white-space': 'nowrap',
			...props,
			width: Math.max(props.width, natural + pad),
		});
	};

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

/**
 * Whether a destination is a terminal to lay a report out for.
 *
 * The one question behind the two forms. Not the colour level, which answers
 * something else: `NO_COLOR` on a real terminal means "no colour", not "no
 * layout", and a report that unwrapped itself over it would be reading one
 * setting as though it were another.
 *
 * @param to - The destination.
 * @returns Whether it is a terminal.
 */
function isTerminal(to: Destination | ReportStream): boolean {
	return destination(to).stream.isTTY === true;
}

/**
 * Writes every diagnostic to a stream, in the form that stream wants.
 *
 * @param diagnostics - What the build found.
 * @param opts - What to write paths relative to, and where to write.
 */
export function writeDiagnostics(
	diagnostics: readonly Diagnostic[],
	opts: { relativeTo?: (file: string) => string; stream: ReportStream & { write(s: string): void } }
): void {
	if (!diagnostics.length) {
		// nothing at all rather than a blank line: `renderToString()` is never less
		// than one row, so rendering an empty report writes one empty line
		return;
	}

	const { relativeTo, stream } = opts;
	// applied here and nowhere else, so both forms are handed the same diagnostic
	// and `diagnosticLocation()` is the only thing that formats a location
	const shown = relativeTo
		? diagnostics.map((d) => ({ ...d, file: relativeTo(d.file) }))
		: diagnostics;

	if (!isTerminal(stream)) {
		stream.write(`${shown.map((d) => formatDiagnostic(d)).join('\n')}\n`);
		return;
	}

	stream.write(`${render((width) => diagnosticsView(shown, { width }), stream)}\n`);
}

/**
 * Writes a summary to a stream, in the form that stream wants.
 *
 * The plain form is the runs joined by a space, which is what they read as with
 * the styling taken off -- so a summary is the same words either way and only a
 * pipe is spared the wrap.
 *
 * @param runs - What the line says.
 * @param stream - Where to write it.
 */
export function writeSummary(
	runs: readonly (TextRun | string)[],
	stream: ReportStream & { write(s: string): void }
): void {
	const plain = (): string =>
		runs.map((run) => (typeof run === 'string' ? run : run.text)).join(' ');

	stream.write(
		`\n${isTerminal(stream) ? render((width) => summaryView(runs, width), stream) : plain()}\n`
	);
}

/**
 * Writes a block of prose, wrapped to the destination.
 *
 * Prose, unlike a diagnostic or a summary, is wrapped **whatever** the
 * destination is, and the difference is what the text is *for*. A diagnostic is
 * a record: something greps it, something jumps to it, and a wrap through the
 * middle of a message breaks both -- so off a terminal it stays on one line. A
 * note is a paragraph somebody reads, and `sigil add | less` is still somebody
 * reading it, so the answer there is the fallback width rather than one endless
 * line. This is what the hand-wrapped strings it replaced were reaching for and
 * could not have: they were broken at about seventy columns once, by hand, which
 * is ragged at forty and needlessly narrow at two hundred.
 *
 * @param runs - The prose, as runs.
 * @param stream - Where to write it.
 */
export function writeNote(
	runs: readonly (TextRun | string)[],
	stream: ReportStream & { write(s: string): void }
): void {
	stream.write(`${render((width) => summaryView(runs, width), stream)}\n`);
}
