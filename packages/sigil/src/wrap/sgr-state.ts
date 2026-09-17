import { CSI, ESC, sgr } from '../ansi/codes.js';

/**
 * What a wrapped line has to put back.
 *
 * Wrapping styled text means breaking in the middle of it, and a style left
 * open across a break bleeds into the margin -- which for a background color is
 * visible, and for anything reading the output line by line is wrong. So each
 * line closes what it left open and the next one opens it again, and knowing
 * what to open again means knowing what was in effect at the break.
 *
 * That is not the same as replaying every sequence seen so far. `ESC[31m`
 * followed by `ESC[32m` leaves green in effect, not both, and `ESC[0m` leaves
 * nothing. Attributes replace each other within a slot, so the state is one
 * entry per slot rather than a list of sequences.
 */
export interface SgrState {
	/** Whether anything at all is in effect. */
	readonly active: boolean;
	/** Reads the sequence that turns off everything in effect. */
	close(): string;
	/** Reads the sequence that puts back everything in effect. */
	open(): string;
	/** Applies one SGR sequence. Anything else is ignored. */
	apply(sequence: string): void;
	/** Forgets everything in effect. */
	reset(): void;
}

/**
 * The slots an SGR parameter can occupy. One entry per slot, because a
 * parameter replaces whatever held its slot before: two foreground colors in a
 * row leave the second one in effect, and remembering the first would put the
 * wrong color back.
 *
 * Named rather than numbered so that the table below reads as what it is.
 */
type Slot =
	| 'intensity'
	| 'italic'
	| 'underline'
	| 'blink'
	| 'inverse'
	| 'hidden'
	| 'strikethrough'
	| 'overline'
	| 'foreground'
	| 'background'
	| 'underlineColor';

/**
 * Which slot each SGR parameter fills, and what closes that slot.
 *
 * The parameters that only close a slot -- 22 through 29, 39, 49, 55, 59 -- are
 * absent on purpose: applying one clears its slot rather than filling it, which
 * is what `closes` below says.
 */
const slots: Record<number, Slot> = {
	1: 'intensity',
	2: 'intensity',
	3: 'italic',
	4: 'underline',
	5: 'blink',
	6: 'blink',
	7: 'inverse',
	8: 'hidden',
	9: 'strikethrough',
	21: 'underline', // doubly underlined
	53: 'overline',
	58: 'underlineColor',
	// the colors, including the 38/48 forms that carry their own parameters
	30: 'foreground',
	31: 'foreground',
	32: 'foreground',
	33: 'foreground',
	34: 'foreground',
	35: 'foreground',
	36: 'foreground',
	37: 'foreground',
	38: 'foreground',
	90: 'foreground',
	91: 'foreground',
	92: 'foreground',
	93: 'foreground',
	94: 'foreground',
	95: 'foreground',
	96: 'foreground',
	97: 'foreground',
	40: 'background',
	41: 'background',
	42: 'background',
	43: 'background',
	44: 'background',
	45: 'background',
	46: 'background',
	47: 'background',
	48: 'background',
	100: 'background',
	101: 'background',
	102: 'background',
	103: 'background',
	104: 'background',
	105: 'background',
	106: 'background',
	107: 'background',
};

/** The parameter that empties each slot, which is what closing one writes. */
const closes: Record<Slot, number> = {
	background: 49,
	blink: 25,
	foreground: 39,
	hidden: 28,
	intensity: 22,
	inverse: 27,
	italic: 23,
	overline: 55,
	strikethrough: 29,
	underline: 24,
	underlineColor: 59,
};

/** Which parameter closes which slot, for reading a sequence's parameters. */
const closedBy = new Map<number, Slot>(
	Object.entries(closes).map(([slot, code]) => [code, slot as Slot])
);

/**
 * How many parameters 38, 48, and 58 take in their semicolon form, counting
 * themselves and the mode: `38;5;n` is a palette index and takes three,
 * `38;2;r;g;b` is a color and takes five. Keyed on the mode, which is the
 * parameter right after the 38.
 *
 * A mode that is neither is a malformed sequence, and taking the rest of it is
 * the only safe reading -- guessing a shorter run would leave its tail to be
 * read as attributes of their own.
 */
const extendedLengths: Record<number, number> = { 2: 5, 5: 3 };

/**
 * The attributes that take a color rather than being one. In the colon form
 * they carry it themselves and are one parameter; in the semicolon form the
 * color is spread over the parameters after them.
 */
const extendable = new Set([38, 48, 58]);

/**
 * Tracks what a stream of SGR sequences leaves in effect.
 *
 * @returns The state, empty.
 */
export function createSgrState(): SgrState {
	// insertion ordered, so putting styles back writes them in the order they
	// were set. Nothing depends on that order, but stable output does.
	const state = new Map<Slot, string>();

	return {
		get active() {
			return state.size > 0;
		},

		apply(sequence: string): void {
			const params = sgrParams(sequence);
			if (params === undefined) {
				return;
			}

			for (let i = 0; i < params.length; i++) {
				const { code, text } = params[i]!;

				// a reset, and the sequence that carries no parameters at all
				if (code === 0) {
					state.clear();
					continue;
				}

				const closed = closedBy.get(code);
				if (closed !== undefined) {
					state.delete(closed);
					continue;
				}

				const slot = slots[code];
				if (slot === undefined) {
					// something this does not model -- a font, a framing attribute, an
					// ideogram mark. Ignoring it loses it across a break, which is better
					// than guessing at a slot and losing something else with it.
					continue;
				}

				// the parameter is stored as it was written rather than rebuilt from
				// its leading number, so a sub-parameter survives: `4:3` is a curly
				// underline and `4` is a straight one, and the difference is only in
				// the part a number would throw away
				if (extendable.has(code) && !text.includes(':')) {
					// the semicolon form spreads one color over several parameters
					const length = extendedLengths[params[i + 1]?.code ?? -1];

					if (length === undefined || i + length > params.length) {
						// a color naming no mode, or one whose parameters run out before it
						// does. Storing it would be worse than losing it: the parameters of
						// whatever comes next would be written after it on the way back and
						// read as the rest of the color, so `ESC[38;5m` followed by `ESC[1m`
						// would reopen as `ESC[38;5;1m` -- a valid color, and not the one
						// anybody wrote. The rest of the sequence belongs to this color, so
						// it goes with it.
						i = params.length;
						continue;
					}

					state.set(
						slot,
						params
							.slice(i, i + length)
							.map((param) => param.text)
							.join(';')
					);
					i += length - 1;
					continue;
				}

				state.set(slot, text);
			}
		},

		close(): string {
			if (state.size === 0) {
				return '';
			}
			// one sequence rather than one per slot, and the slots that are actually
			// open rather than a blanket reset: a reset would also undo anything the
			// surrounding output had set that this text never touched
			return sgr([...state.keys()].map((slot) => closes[slot]).join(';'));
		},

		open(): string {
			return state.size === 0 ? '' : sgr([...state.values()].join(';'));
		},

		reset(): void {
			state.clear();
		},
	};
}

/** One parameter of an SGR sequence, as a number and as it was written. */
interface SgrParam {
	/** The leading number, which is what names the attribute. */
	code: number;
	/** The parameter exactly as written, sub-parameters and all. */
	text: string;
}

/**
 * The parameters of an SGR sequence.
 *
 * Both readings are kept because both are needed. The number is what says which
 * attribute this is; the text is what has to be written back, and rebuilding it
 * from the number would throw away a sub-parameter -- the `3` of `ESC[4:3m` is
 * the difference between a curly underline and a straight one, and the channels
 * of `ESC[38:2:...m` are the color itself.
 *
 * A sub-parameter belongs to the parameter in front of it rather than standing
 * on its own, which is why `code` reads only up to the colon.
 *
 * @param sequence - The sequence to read.
 * @returns The parameters, or `undefined` when the sequence is not an SGR.
 */
function sgrParams(sequence: string): SgrParam[] | undefined {
	const body = sgrBody(sequence);

	if (body === undefined) {
		return undefined;
	}

	// an SGR with no parameters means the same as `0`
	if (body === '') {
		return [{ code: 0, text: '0' }];
	}

	return body.split(';').map((text) => ({ code: Number.parseInt(text, 10) || 0, text }));
}

/**
 * The parameters of an SGR sequence, unparsed, or `undefined` when the sequence
 * is something else. Cursor movement and hyperlinks pass through wrapping
 * untouched; only the attributes have to be put back.
 *
 * @param sequence - The sequence to read.
 * @returns The text between the introducer and the `m`.
 */
function sgrBody(sequence: string): string | undefined {
	const prefix = sequence.startsWith(`${ESC}[`) ? 2 : sequence.startsWith(CSI) ? 1 : 0;

	if (prefix === 0 || !sequence.endsWith('m')) {
		return undefined;
	}

	const body = sequence.slice(prefix, -1);
	return /^[\d;:]*$/.test(body) ? body : undefined;
}
