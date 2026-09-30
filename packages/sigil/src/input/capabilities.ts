/**
 * Asking the terminal what it is, instead of guessing from `TERM`.
 *
 * Everything sigil knows about the terminal it is talking to, it infers from
 * environment variables: `supportsColor()` reads `TERM`, `COLORTERM` and
 * `NO_COLOR` and produces a `ColorLevel`, and the whole degradation ladder hangs
 * off that one guess. `scripts/terminal-probe.mjs` exists because the canvas
 * makes claims only a real terminal can falsify; this is the same idea at run
 * time -- stop guessing where the terminal will answer.
 *
 * ```js
 * const caps = await detectCapabilities(input);
 * caps.name; // 'ghostty', from XTVersion
 * ```
 *
 * **A CLI must not pay a round trip to print one line**, which is what makes
 * this different from a TUI framework's version of it. OpenTUI and Ink probe at
 * startup because they are always an app; sigil is a parser first, and
 * `mycli --version` has to stay as fast as it is. So detection is lazy and
 * opt-in, performed by a renderer that mounted and by nothing else -- never
 * `main()`, never `parse()`, never the help screen, never `renderToString()`.
 * Environment inference stays the default answer and the synchronous one;
 * probing *refines* it and never gates it, and the first frame does not wait.
 * This is not a startup phase, it is a signal that settles a frame or two in.
 *
 * Two things are load bearing here and both are about being wrong in the right
 * direction.
 *
 * A reply arrives **on stdin, interleaved with whatever the user is typing**, so
 * one of these read as a key is `[?1006;2$y` in somebody's password. That is
 * `isCapabilityResponse()`'s job, and it is conservative the other way too: a
 * sequence it wrongly claims is a reply is a key the user pressed and lost, so
 * it claims only the shapes that cannot be a key. The one shape that can be
 * both -- a cursor position report, which is byte for byte Shift-F3 under
 * xterm's `modifyFunctionKeys` -- is claimed only while a request for one is
 * outstanding, and is deliberately not part of the unconditional set.
 *
 * And **a terminal that does not understand a query answers nothing**, so every
 * probe needs a deadline. The trick that makes the deadline cheap is a sentinel:
 * DA1 is the one query every terminal back to a real VT100 answers, so it is
 * written last and its reply means every query before it has either been
 * answered or never will be. A probe therefore normally finishes in one round
 * trip rather than in one timeout, and the timeout is what is left for a
 * terminal that answers nothing at all.
 */

import { ESC } from '../ansi/codes.js';
import type { ColorLevel } from '../ansi/color-support.js';
// `style/scheme.js` rather than `style/index.js`, for the reason the renderer
// reaches for this file rather than for the router: that module is a table and two
// arithmetic functions with no imports of its own, and the style barrel is 42 kB
import { type ColorScheme, schemeForBackground } from '../style/scheme.js';
import type { InputRouter } from './index.js';

/** What a reply turned out to be. */
export type CapabilityKind =
	/** A DA1 or DA2 reply: what the terminal claims to be. */
	| 'device'
	/** An XTVersion reply: the terminal's own name and version. */
	| 'version'
	/** A DECRPM reply: whether a mode is actually set. */
	| 'mode'
	/** A cursor position report. */
	| 'cursor'
	/** A window-op reply carrying a pixel geometry. */
	| 'size'
	/** An OSC reply. Its command is the first parameter and the rest is `text`. */
	| 'osc'
	/** A control string this does not interpret, which is still not a key. */
	| 'string';

/**
 * One reply, read.
 *
 * `sequence` is kept whole because a caller may know something about a reply
 * that this does not -- a terminal-specific DA1 parameter, an OSC command
 * nothing here asks for -- and because a test that asserts on the bytes is
 * asserting on what the terminal sent rather than on this reading of it.
 */
export interface CapabilityReply {
	readonly kind: CapabilityKind;
	/**
	 * The numeric parameters, where they are numbers.
	 *
	 * Empty parameters come through as `0`, which is what a terminal means by one:
	 * every parameter in the sequences read here defaults to zero when it is
	 * omitted. A non-numeric payload is not here at all and is in `text`.
	 */
	readonly params: readonly number[];
	/** The private-use prefix, where there was one: `?` for DA1, `>` for DA2. */
	readonly prefix: string;
	readonly sequence: string;
	/** The payload of a string reply, with the introducer and terminator off. */
	readonly text: string;
}

/** BEL and the C1 spelling of ST, which are two of the three ways a string ends. */
const BEL = String.fromCharCode(0x07);
const C1_ST = String.fromCharCode(0x9c);

const CSI = `${ESC}[`;
const OSC = `${ESC}]`;
const ST = `${ESC}\\`;

/**
 * Device attributes: the cheapest "is anybody there" probe, and the sentinel.
 *
 * Every terminal answers it, which is the whole reason it is written last in a
 * batch. What it says is coarse -- a VT level and a list of options -- and it is
 * not read for a capability so much as for the fact that it came back.
 */
export const DA1: string = `${CSI}c`;

/** Secondary device attributes: a firmware version, which almost nothing keys on. */
export const DA2: string = `${CSI}>c`;

/**
 * The terminal's own name and version, which is what capability tables key on.
 *
 * Answered as a DCS: `ESC P > | Ghostty 1.0.1 ESC \`. A terminal that does not
 * know the query answers nothing, which is itself informative -- everything that
 * implements it is recent.
 */
export const XTVERSION: string = `${CSI}>q`;

/** Where the cursor is. Also the inline backend's anchor. */
export const CURSOR_POSITION: string = `${CSI}6n`;

/** The text area in pixels, answered as `CSI 4 ; height ; width t`. */
export const TEXT_AREA_PIXELS: string = `${CSI}14t`;

/** One cell in pixels, answered as `CSI 6 ; height ; width t`. */
export const CELL_PIXELS: string = `${CSI}16t`;

/**
 * Asks whether a private mode is set.
 *
 * @param mode - The mode number, as in `CSI ? 1006 h`.
 * @returns The DECRQM sequence.
 */
export function requestMode(mode: number): string {
	return `${CSI}?${mode}$p`;
}

/**
 * Asks the terminal for its background colour.
 *
 * The reply is `OSC 11 ; rgb:RRRR/GGGG/BBBB` and the components are **sixteen
 * bits per channel** in the common form, so they are scaled rather than
 * truncated. Read by `prefers-color-scheme`; here because a query belongs with
 * the other queries.
 */
export const BACKGROUND_COLOR: string = `${OSC}11;?${ST}`;

/** Asks the terminal for its foreground colour, which is `10` rather than `11`. */
export const FOREGROUND_COLOR: string = `${OSC}10;?${ST}`;

/**
 * What DECRPM says about a mode.
 *
 * The numbers are DEC's: `0` is a mode the terminal has never heard of, which is
 * the answer that matters, since it is the difference between "the mode is off"
 * and "asking was pointless".
 */
export type ModeState = 'permanently-reset' | 'permanently-set' | 'reset' | 'set' | 'unrecognised';

const MODE_STATES: Record<number, ModeState> = {
	0: 'unrecognised',
	1: 'set',
	2: 'reset',
	3: 'permanently-set',
	4: 'permanently-reset',
};

/**
 * A CSI, taken apart: the prefix, the parameters, the intermediates, the final.
 *
 * Built from `ESC` with `new RegExp` rather than written as a literal, which is
 * this repository's rule twice over: no raw control character in source, and no
 * `no-control-regex` suppression for a formatter to detach from the line it was
 * written over. `src/ansi/strip.ts` already spells its own patterns this way.
 */
const CSI_RE = new RegExp(`^${ESC}\\[([<=>?]?)([\\d;:]*)([ -/]*)([@-~])$`);

/** A control string: the introducer, the payload, and the terminator. */
const STRING_RE = new RegExp(`^${ESC}([\\]P^_X])([\\s\\S]*?)(?:${BEL}|${C1_ST}|${ESC}\\\\)$`);

/** An OSC payload: the numeric command, then everything else. */
const OSC_RE = /^(\d+)(?:;([\s\S]*))?$/;

/**
 * Reads a sequence as a capability reply, whatever else it might also be.
 *
 * Includes the shapes `isCapabilityResponse()` refuses to claim on its own,
 * because the gate and the reading are two questions: a cursor position report
 * parses perfectly well and is only *taken* while a request for one is
 * outstanding.
 *
 * @param sequence - Exactly what the terminal sent, as one whole sequence.
 * @returns The reply, or `undefined` when this is not one at all.
 */
export function parseCapabilityResponse(sequence: string): CapabilityReply | undefined {
	const string = STRING_RE.exec(sequence);
	if (string) {
		const introducer = string[1];
		const text = string[2];
		if (introducer === ']') {
			// the command is the first parameter, so `OSC 11 ; rgb:...` reads as
			// command 11 with the colour as its text. An OSC with no command at all is
			// still a reply and still not a key, so it comes through with none
			const osc = OSC_RE.exec(text);
			return osc
				? reply('osc', sequence, '', osc[2] ?? '', [Number.parseInt(osc[1], 10)])
				: reply('string', sequence, '', text);
		}
		if (introducer === 'P') {
			// `ESC P > | name ST` is XTVersion. Anything else arriving as a DCS is an
			// answer to something this does not ask, so it is a reply without being a
			// version -- read as a version only where it carries the marker saying so
			return text.startsWith('>|')
				? reply('version', sequence, '>', text.slice(2))
				: reply('string', sequence, '', text);
		}
		// APC, PM and SOS are not framed by the decoder, so nothing reaches here
		// with one. Read rather than refused, because what would be wrong about
		// refusing is that it is still not a key
		return reply('string', sequence, '', text);
	}

	const csi = CSI_RE.exec(sequence);
	if (!csi) {
		return undefined;
	}

	const prefix = csi[1];
	const params = csi[2];
	const intermediates = csi[3];
	const final = csi[4];

	// DECRPM: `CSI ? Pd ; Ps $ y`. Nothing a keyboard sends carries a `$`
	// intermediate, so this needs no prefix to be unambiguous
	if (final === 'y' && intermediates === '$') {
		return reply('mode', sequence, prefix, '', numbers(params));
	}

	// DA1 is `CSI ? ... c` and DA2 is `CSI > ... c`. A bare `CSI c` is the
	// *request*, which nothing sends to us, so the prefix is what makes this a
	// reply rather than a guess
	if (final === 'c' && (prefix === '?' || prefix === '>')) {
		return reply('device', sequence, prefix, '', numbers(params));
	}

	// a window-op reply: `CSI 4 ; height ; width t` for the text area and
	// `CSI 6 ; h ; w t` for a cell. Exactly three parameters, because the requests
	// are one or two and a reply is what has all three
	if (final === 't' && intermediates === '' && /^\d+;\d+;\d+$/.test(params)) {
		return reply('size', sequence, prefix, '', numbers(params));
	}

	// CPR: `CSI row ; column R`, or `CSI ? row ; column R` for DECXCPR. Parsed
	// here and gated in `isCapabilityResponse()`, for the reason recorded there
	if (final === 'R' && intermediates === '' && /^\d+;\d+$/.test(params)) {
		return reply('cursor', sequence, prefix, '', numbers(params));
	}

	return undefined;
}

function reply(
	kind: CapabilityKind,
	sequence: string,
	prefix: string,
	text: string,
	params: readonly number[] = []
): CapabilityReply {
	return Object.freeze({ kind, params: Object.freeze(params), prefix, sequence, text });
}

/** `1;2` as `[1, 2]`, and an omitted parameter as the zero a terminal means by it. */
function numbers(params: string): number[] {
	return params === ''
		? []
		: params.split(';').map((part) => {
				// a sub-parameter (`1:2`) is read as its first component: nothing here
				// asks a question whose answer uses one, and taking the whole string
				// through `Number()` would answer `NaN`
				const value = Number.parseInt(part.split(':')[0], 10);
				return Number.isNaN(value) ? 0 : value;
			});
}

/**
 * Whether a sequence is a terminal's reply rather than a key that was pressed.
 *
 * Asked of every decoded sequence before it is dispatched, which is what keeps a
 * reply out of a text prompt. It is deliberately *narrow*: everything claimed
 * here is a shape no keyboard produces, because being wrong in this direction
 * loses a key the user pressed.
 *
 * What is claimed:
 *
 * - any well-framed OSC or DCS control string, since neither is ever a key --
 *   `ESC ]` and `ESC P` alone are Alt-] and Alt-Shift-P, and those are not
 *   framed as control strings at all;
 * - DECRPM, `CSI ? Pd ; Ps $ y`, on the `$` intermediate no keyboard sends;
 * - device attributes, `CSI ? ... c` and `CSI > ... c`, on the private prefix a
 *   bare request does not carry;
 * - a three-parameter window-op reply, `CSI 4 ; h ; w t`.
 *
 * What is **not** claimed, and each is a decision rather than an omission:
 *
 * - a cursor position report. `CSI 1 ; 2 R` is a CPR *and* it is Shift-F3 under
 *   xterm's `modifyFunctionKeys`, so nothing about the bytes can tell them
 *   apart. A reply is only ever a reply to a request, so the router claims one
 *   only while a request for one is outstanding -- which is `QueryOptions.cursor`
 *   and is the honest version of this function rather than a hole in it;
 * - an unfinished sequence. `CSI` on its own, or `CSI ? 1006 ; 2` with its `$y`
 *   still on the wire, is not a reply yet, and claiming it would swallow the key
 *   a user pressed while it was arriving -- which is the failure the decoder
 *   already carries an entry for;
 * - a mouse report. `CSI < 0 ; 10 ; 5 M` leads with the private `<` and ends on
 *   `M`, which is neither a shape here nor a key: it is `parseMouseReport()`'s, and
 *   the router asks that separately. The two are disjoint by construction, so
 *   neither has to know about the other;
 * - a focus report, `CSI I` and `CSI O`, for the same reason: unsolicited
 *   terminal chatter rather than an answer to anything.
 *
 * @param sequence - Exactly what the terminal sent, as one whole sequence.
 * @returns Whether it is unambiguously a reply.
 */
export function isCapabilityResponse(sequence: string): boolean {
	const found = parseCapabilityResponse(sequence);
	return found !== undefined && found.kind !== 'cursor';
}

/**
 * How long a probe waits for a terminal that answers nothing at all.
 *
 * 250 milliseconds. The sentinel is what usually ends a probe -- DA1 comes back
 * in one round trip and says every earlier query has been answered or never will
 * be -- so this is the fallback for a terminal that does not even answer that,
 * which in practice means something that is not a terminal at all.
 *
 * The asymmetry is not the one `ESCAPE_TIMEOUT` has, and that is why the number
 * is five times larger. Too short there types a stray character into an answer;
 * too short *here* silently reports no capabilities, which means a colour level
 * and a colour scheme that are wrong with nothing to point at -- and it is easy
 * to be too short, because a transatlantic ssh round trip is around 150ms before
 * the terminal has done anything and tmux adds a pass of its own. Too long costs
 * nothing a user can see, because the first frame does not wait for this: it
 * costs a timer held open and, while it is open, a `CSI ... R` read as a reply
 * rather than as Shift-F3. So the number is set well clear of the failure that is
 * invisible, and the one it trades against is bounded and cheap.
 */
export const QUERY_TIMEOUT: number = 250;

/** What a probe writes and how long it waits. */
export interface QueryOptions {
	/**
	 * Whether to claim a cursor position report while this query is outstanding.
	 *
	 * Off by default, because `CSI 1 ; 2 R` is also Shift-F3 and a reply nobody
	 * asked for must not cost a key. A caller that asked for one says so.
	 */
	cursor?: boolean;
	/** Milliseconds to wait. Defaults to `QUERY_TIMEOUT`. */
	timeout?: number;
	/**
	 * Resolves the probe early.
	 *
	 * Handed each reply and everything collected so far. The batched probe uses it
	 * for the DA1 sentinel, which is what turns a deadline into a round trip.
	 */
	until?: (reply: CapabilityReply, all: readonly CapabilityReply[]) => boolean;
	/** The bytes to write, in one write. */
	write: string;
}

/** What a terminal turned out to be. */
export interface Capabilities {
	/** One cell in pixels, from `CSI 16 t`. */
	readonly cell?: { readonly height: number; readonly width: number };
	/**
	 * The colour level the reply refines the environment's guess to.
	 *
	 * Absent when nothing said. Present only where it is *higher* than what was
	 * inferred, which is the direction that is safe: see `refineColorLevel()`.
	 */
	readonly colorLevel?: ColorLevel;
	/** What DA1 said, as its raw parameters. */
	readonly device?: readonly number[];
	/** The terminal's own name, lowercased, from XTVersion. */
	readonly name?: string;
	/** The terminal's background, from an OSC 11 reply, on 0-255 per channel. */
	readonly background?: ReportedColor;
	/**
	 * The scheme that background implies.
	 *
	 * Absent where nothing answered, which is the case the environment is still the
	 * answer for. Present here it is the *truthful* one: `COLORFGBG` is frequently
	 * stale and notoriously wrong under tmux, and this is the terminal itself.
	 */
	readonly colorScheme?: ColorScheme;
	/** The text area in pixels, from `CSI 14 t`. */
	readonly pixels?: { readonly height: number; readonly width: number };
	/** Every reply, in the order it arrived, for anything that wants to look again. */
	readonly replies: readonly CapabilityReply[];
	/** Whether anything answered at all. */
	readonly responded: boolean;
	/** The version string XTVersion carried, unparsed. */
	readonly version?: string;
}

/**
 * The shapes an OSC 10 or 11 reply carries a colour in.
 *
 * `rgb:RRRR/GGGG/BBBB` is what xterm specifies and what nearly everything writes,
 * and the components are **sixteen bits per channel**: `ffff`, not `ff`. They are
 * *scaled* rather than truncated, because truncating reads `rgb:1c1c/...` as 0x1c
 * only by luck -- a terminal that answers `rgb:1/2/3`, which is legal and means
 * full scale over one hex digit, would come out as almost black. Each component is
 * read as a fraction of the full scale its own digit count implies, which is the
 * one reading that is right for all four widths.
 *
 * `#RRGGBB` is the other form some terminals answer with, and `rgba:` carries an
 * alpha this has no use for and ignores.
 */
const COLOR_RE = /^rgba?:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})(?:\/[\da-f]{1,4})?$/i;

/**
 * The `#` form, which X11 defines at four widths rather than one.
 *
 * `#RGB`, `#RRGGBB`, `#RRRGGGBBB` and `#RRRRGGGGBBBB`, each digit group a fraction
 * of its own full scale exactly as in `rgb:` -- so `#fff` is white and not
 * `#0f0f0f`. Written as one group of 3, 6, 9 or 12 and split in three afterwards,
 * because four alternations of three capture groups is the same rule said four
 * times.
 */
const HASH_RE = /^#((?:[\da-f]{3}){1,4})$/i;

/** A colour a terminal reported, on 0-255 per channel. */
export interface ReportedColor {
	readonly b: number;
	readonly g: number;
	readonly r: number;
}

/**
 * Reads the colour out of an OSC 10 or 11 reply's payload.
 *
 * @param text - What followed the `10;` or `11;`.
 * @returns The colour on 0-255 per channel, or `undefined` for a shape this does
 *   not read. Two of those are legal and deliberate: an X11 colour *name* like
 *   `white`, which would need that database to resolve, and the `rgbi:` intensity
 *   form, which is floating point per channel and which nothing observed in the
 *   wild answers with. Either way the environment's answer stands, which is the
 *   same outcome as a terminal that said nothing.
 */
export function parseReportedColor(text: string): ReportedColor | undefined {
	const trimmed = text.trim();

	const rgb = COLOR_RE.exec(trimmed);
	if (rgb) {
		return Object.freeze({
			b: scale(rgb[3]),
			g: scale(rgb[2]),
			r: scale(rgb[1]),
		});
	}

	const hash = HASH_RE.exec(trimmed);
	if (hash) {
		const each = hash[1].length / 3;
		return Object.freeze({
			b: scale(hash[1].slice(each * 2)),
			g: scale(hash[1].slice(each, each * 2)),
			r: scale(hash[1].slice(0, each)),
		});
	}

	return undefined;
}

/**
 * One component, as a fraction of the full scale its digit count implies.
 *
 * `ffff` over four digits and `ff` over two are both full scale, so the divisor is
 * `16**digits - 1` rather than a fixed `0xffff`. Rounded rather than floored,
 * because the midpoint the scheme is decided against sits between two values and a
 * floor moves every component down half a step.
 */
function scale(digits: string): number {
	const full = 16 ** digits.length - 1;
	return Math.round((Number.parseInt(digits, 16) / full) * 255);
}

/** Which capabilities to ask for. */
export interface DetectOptions {
	/** Ask for the background colour, for `prefers-color-scheme`. Off by default. */
	background?: boolean;
	/** Ask for the cell and text-area pixel geometry. Off by default. */
	geometry?: boolean;
	/** What the environment inferred, which a reply may only refine upwards. */
	colorLevel?: ColorLevel;
	/** Milliseconds to wait. Defaults to `QUERY_TIMEOUT`. */
	timeout?: number;
	/** Ask the terminal for its name and version. On by default. */
	version?: boolean;
}

/**
 * The terminals whose own name is a promise of truecolour.
 *
 * Read only to *raise* a level, never to lower one, which is the whole of what
 * makes a table like this safe to ship. A name that is not here changes nothing,
 * so the failure mode of being out of date is the status quo rather than a wrong
 * answer -- and a terminal that answers XTVersion at all is recent, which is why
 * a short list covers most of what a reply can be.
 */
const TRUECOLOR = new Set([
	'alacritty',
	'contour',
	'foot',
	'ghostty',
	'iterm2',
	'kitty',
	'mintty',
	'rio',
	'wezterm',
]);

/**
 * `xterm` is deliberately not on that list, and it is the instructive omission.
 *
 * It answers XTVersion from patch 331, so it is exactly the kind of name a table
 * like this is tempted by -- and it renders direct colour only with the `-direct`
 * terminfo entries, which `supportsColor()` already reads off `TERM`. Adding it
 * would raise the level for every ordinary `xterm-256color` session on the
 * strength of a reply that says nothing about colour. `konsole` and `wayst` are
 * out for the weaker version of the same reason: whether they answer this query
 * at all is not something this repository has measured.
 */

/**
 * What a version reply refines the inferred colour level to.
 *
 * Upwards only, and never off a floor of zero. Both halves matter. Zero is what
 * `NO_COLOR` and a pipe produce, and a probe that raised it would override a
 * choice the user or the destination already made -- the same rule the degrader
 * keeps for a declared palette colour. And lowering is refused because
 * `COLORTERM=truecolor` is a thing people export on purpose, often precisely
 * because their terminal is behind a multiplexer that under-reports: a reply
 * saying `tmux` would otherwise undo it.
 *
 * What this does *not* do is prove the level, and the honest alternative was
 * measured and rejected. Setting `SGR 38;2;1;2;3` and reading it back with
 * DECRQSS is the truthful probe -- a terminal that quantizes answers `38;5;N` --
 * and it means writing a colour to the screen mid-frame and depending on
 * DECRQSS, which is implemented by a narrower set of terminals than XTVersion
 * is. A name is weaker evidence and it costs nothing to be wrong about.
 *
 * @param name - What the terminal called itself, lowercased.
 * @param inferred - What the environment said.
 * @returns The refined level, or `undefined` when nothing changes.
 */
export function refineColorLevel(
	name: string | undefined,
	inferred: ColorLevel | undefined
): ColorLevel | undefined {
	if (name === undefined || inferred === undefined || inferred === 0) {
		return undefined;
	}
	// matched whole rather than by prefix, which was the first spelling and is
	// loose in the direction that costs: `name` is already the first token with any
	// `(version)` taken off, so a prefix test buys nothing and would read a terminal
	// called `footer` as `foot`
	return TRUECOLOR.has(name) && inferred < 3 ? 3 : undefined;
}

/**
 * Asks the terminal everything, in one round trip.
 *
 * Batched rather than one probe per capability, and the argument is arithmetic:
 * a round trip is one RTT, and five of them in sequence over an ssh link with a
 * 150ms RTT is three quarters of a second where one write is 150ms. The
 * objection to batching -- that it answers questions nobody asked -- is answered
 * by the options rather than by the shape: nothing is written that the caller did
 * not ask for, and what is *always* written is DA1, which is the sentinel and is
 * the cheapest sequence there is.
 *
 * Replies are matched by shape rather than by position, because a terminal that
 * does not understand one query answers nothing for it and everything after it
 * would then be attributed to the wrong question.
 *
 * @param router - The thing that owns stdin. A private listener here would be
 *   the exact failure the router exists to replace.
 * @param opts - Which capabilities to ask for.
 * @returns What came back. A terminal that said nothing resolves with nothing
 *   rather than rejecting, because that is an answer and a probe that threw would
 *   take a frame down over it. A query that could not be *written* propagates, for
 *   the reason `InputRouter.query()` gives: a broken stream is not a quiet
 *   terminal.
 */
export async function detectCapabilities(
	router: InputRouter,
	opts: DetectOptions = {}
): Promise<Capabilities> {
	const parts: string[] = [];
	if (opts.version !== false) {
		parts.push(XTVERSION);
	}
	if (opts.background) {
		parts.push(BACKGROUND_COLOR);
	}
	if (opts.geometry) {
		parts.push(CELL_PIXELS, TEXT_AREA_PIXELS);
	}
	// last, always: its reply is what says the ones before it are answered or
	// never will be
	parts.push(DA1);

	const replies = await router.query({
		timeout: opts.timeout,
		until: (it) => it.kind === 'device' && it.prefix === '?',
		write: parts.join(''),
	});

	return readCapabilities(replies, opts.colorLevel);
}

/**
 * Turns a set of replies into capabilities.
 *
 * Separate from the probe so that it can be tested against replies a test wrote
 * rather than against a terminal, which is the only place most of these shapes
 * can come from at all.
 *
 * @param replies - What came back.
 * @param inferred - What the environment said the colour level was.
 * @returns The capabilities.
 */
export function readCapabilities(
	replies: readonly CapabilityReply[],
	inferred?: ColorLevel
): Capabilities {
	let background: ReportedColor | undefined;
	let cell: { height: number; width: number } | undefined;
	let device: readonly number[] | undefined;
	let name: string | undefined;
	/**
	 * Every name that answered, because more than one thing may.
	 *
	 * tmux answers XTVersion itself and can pass the outer terminal's answer
	 * through as well, and taking the first would let a `tmux 3.4` hide the
	 * `ghostty 1.1.0` behind it. Since a refinement only ever *raises*, the
	 * permissive reading is the safe one: if anything that answered is known to do
	 * truecolour, it does. `name` stays the first, which is what a caller reading it
	 * back means by "what is this terminal".
	 */
	const names: string[] = [];
	let pixels: { height: number; width: number } | undefined;
	let version: string | undefined;

	for (const it of replies) {
		if (it.kind === 'device' && it.prefix === '?' && device === undefined) {
			device = it.params;
		} else if (it.kind === 'version') {
			// `Ghostty 1.0.1`, `WezTerm 20240203-110809`, `kitty 0.32.2`, `foot(1.16.2)`
			const match = /^([^\s(]+)[\s(]*(.*?)\)?$/.exec(it.text.trim());
			const found = (match?.[1] ?? it.text.trim()).toLowerCase();
			names.push(found);
			if (name === undefined) {
				// the first is what the terminal in front of us called itself, which is
				// what a caller wants to read back
				name = found;
				version = match?.[2] === '' ? undefined : match?.[2];
			}
		} else if (it.kind === 'osc' && it.params[0] === 11 && background === undefined) {
			// the first one that can be *read*, which is not the same as the first, and
			// the difference matters: a terminal may legally answer `white`, and giving
			// up there would throw away a second reply that does say something. A reply
			// this cannot read is no answer, so it does not close the question -- while a
			// reply it can read does, because a terminal answers a question once and
			// anything after it is somebody else's answer to the same one.
			//
			// Which falls out of the guard above rather than needing a `?? background`
			// after it: the branch is only entered while nothing has been read, so there
			// is never a value here for an unreadable reply to overwrite. One was written
			// and taken out again -- a line that can be deleted with the suite still green
			// reads as load-bearing and is not
			background = parseReportedColor(it.text);
		} else if (it.kind === 'size') {
			// the reply's first parameter says which question it answers: 6 is a cell
			// and 4 is the text area. The *request* numbers are 16 and 14, which is
			// the pair that is easy to write down the wrong way round
			const box = { height: it.params[1] ?? 0, width: it.params[2] ?? 0 };
			if (it.params[0] === 6) {
				cell = box;
			} else if (it.params[0] === 4) {
				pixels = box;
			}
		}
	}

	let colorLevel: ColorLevel | undefined;
	for (const it of names) {
		colorLevel = refineColorLevel(it, inferred) ?? colorLevel;
	}

	return Object.freeze({
		...(background ? { background } : {}),
		...(cell ? { cell: Object.freeze(cell) } : {}),
		...(colorLevel === undefined ? {} : { colorLevel }),
		...(background
			? { colorScheme: schemeForBackground(background.r, background.g, background.b) }
			: {}),
		...(device ? { device } : {}),
		...(name === undefined ? {} : { name }),
		...(pixels ? { pixels: Object.freeze(pixels) } : {}),
		...(version === undefined ? {} : { version }),
		replies: Object.freeze([...replies]),
		responded: replies.length > 0,
	});
}

/**
 * Asks whether a private mode is actually set.
 *
 * Which is a stronger thing to know than whether we asked for it: a mode a
 * terminal has never heard of is silently ignored, so an app that turned mouse
 * tracking on has no way to find out that nothing happened. DECRPM says, and it
 * distinguishes "off" from "never heard of it", which is the distinction that
 * matters.
 *
 * What this deliberately does **not** do is make `Terminal.restore()` put back
 * what was actually set rather than what it believes it set. That is the
 * stronger version of "put back what you attached" and it is unreachable:
 * `restore()` runs from an `exit` handler and from a signal handler, where there
 * is no turn of the event loop left to await a reply in. A restore can only ever
 * put back what it knows, and this is for a *read* rather than for a teardown.
 *
 * @param router - The thing that owns stdin.
 * @param mode - The mode number, as in `CSI ? 1006 h`.
 * @param opts - How long to wait.
 * @returns What the terminal said, or `undefined` for no usable answer -- which
 *   is not the same as `'unrecognised'`, since that is one. `undefined` covers a
 *   terminal that stayed silent and a reply outside DEC's five states, including a
 *   DECRPM with no second parameter; a caller can do the same thing about both,
 *   which is why they are not told apart.
 */
export async function queryMode(
	router: InputRouter,
	mode: number,
	opts: { timeout?: number } = {}
): Promise<ModeState | undefined> {
	const replies = await router.query({
		timeout: opts.timeout,
		// the sentinel again, and it has to be in `until` as well as in the write or
		// it is decoration: a terminal that does not know DECRQM answers only the
		// DA1, and without that second clause the probe waits out the whole deadline
		// to learn something it already knew
		until: (it) =>
			(it.kind === 'mode' && it.params[0] === mode) || (it.kind === 'device' && it.prefix === '?'),
		write: `${requestMode(mode)}${DA1}`,
	});

	const found = replies.find((it) => it.kind === 'mode' && it.params[0] === mode);
	return found ? MODE_STATES[found.params[1]] : undefined;
}

/**
 * Asks where the cursor is.
 *
 * The one query whose reply cannot be told from a key by its bytes, so it is the
 * one that passes `cursor: true` -- and the window in which `CSI 1 ; 2 R` is read
 * as a position rather than as Shift-F3 is exactly the length of this call.
 *
 * @param router - The thing that owns stdin.
 * @param opts - How long to wait.
 * @returns The one-based row and column, or `undefined` when nothing answered.
 */
export async function queryCursor(
	router: InputRouter,
	opts: { timeout?: number } = {}
): Promise<{ column: number; row: number } | undefined> {
	const replies = await router.query({
		cursor: true,
		timeout: opts.timeout,
		until: (it) => it.kind === 'cursor',
		// no DA1 sentinel: a terminal that answers DA1 and not CPR does not exist,
		// and a DA1 reply arriving *first* would end the probe before the position
		// did -- which is the sentinel working against the one query it cannot help
		write: CURSOR_POSITION,
	});

	const found = replies.find((it) => it.kind === 'cursor');
	return found ? { column: found.params[1], row: found.params[0] } : undefined;
}
