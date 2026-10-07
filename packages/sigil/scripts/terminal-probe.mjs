/**
 * Paints the frames a real terminal is allowed to disagree with us about.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --detect
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --mouse
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --clipboard
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --qrcode
 *
 * `test/canvas/diff.test.ts` replays the diff's output against `FakeTerminal`,
 * a model written in this repo. That is the right way to test a diff -- it pins
 * the claim rather than the bytes -- and it has one gap it cannot close on its
 * own: the model and the implementation share an author and a mental model, so
 * an assumption that is wrong in both passes green forever.
 *
 * Every probe below exists because the canvas makes a factual claim about
 * terminals that only a terminal can falsify. Run it in each one you care about
 * -- Ghostty, iTerm2, Terminal.app, Windows Terminal, tmux, and over ssh, which
 * is its own answer -- and read the "expect" line against what you see.
 *
 * Imports `dist/` rather than `src/` deliberately: what ships is what should be
 * probed, and the bundler is one more thing between the source and the screen.
 */
import {
	ATTR,
	createCanvas,
	createFullscreenCanvas,
	createInlineCanvas,
	palette,
	rgb,
} from '../dist/canvas.mjs';
import { terminal } from '../dist/terminal.mjs';

const WIDTH = 40;

/** Moves the cursor to the canvas's top-left, which is what `present()` assumes. */
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';

/**
 * @param {string} title
 * @param {string} expect - What a terminal that agrees with us shows.
 * @param {(canvas: import('../dist/canvas.mjs').Canvas) => void} run
 */
const probe = (title, expect, run) => ({ title, expect, run });

export const PROBES = [
	probe(
		'wide cluster at the last column',
		'the last column is blank; no half-glyph, and nothing wrapped to the next row',
		(canvas) => {
			// `put()` refuses a wide cluster with one column left, because half a
			// glyph is worse than a gap. A terminal that wraps instead of refusing
			// would put the other half on the next row -- and the diff would then be
			// describing a screen that is one cell out from what it believes
			canvas.paint((p) => {
				p.text(0, 0, '.'.repeat(WIDTH - 1));
				p.text(WIDTH - 1, 0, '漢');
				p.text(0, 1, 'row two should start clean');
			});
		}
	),

	probe(
		'deferred wrap',
		'"EDGE" ends the first row; "next" starts the second, not appended to the first',
		(canvas) => {
			// Writing the final column arms the terminal's pending-wrap flag rather
			// than advancing the cursor. `DiffResult.wrapPending` says so, and a
			// backend that writes straight after without repositioning depends on it.
			// A terminal that wraps immediately lands this on the wrong row
			canvas.paint((p) => {
				p.text(WIDTH - 4, 0, 'EDGE');
				p.text(0, 1, 'next');
			});
		}
	),

	probe(
		'the bottom row, and CUD past it',
		'all four rows visible; the top row did not scroll off',
		(canvas) => {
			// Downward movement is CUD, which stops at the bottom margin and never
			// scrolls -- which is why a backend must give the canvas its rows before
			// presenting. If that is wrong anywhere, an inline canvas paints every
			// row onto one line
			canvas.paint((p) => {
				for (let y = 0; y < canvas.height; y++) {
					p.text(0, y, `row ${y} ${'-'.repeat(WIDTH - 8)}`);
				}
			});
		}
	),

	probe(
		'combining marks and ZWJ sequences',
		'each cluster occupies the columns the ruler marks; nothing is split or doubled',
		(canvas) => {
			// `graphemes()` decides what one cell holds. Terminals disagree about
			// this more than about anything else here, and a disagreement shifts
			// every subsequent column on the row
			canvas.paint((p) => {
				p.text(0, 0, '0123456789'.repeat(4).slice(0, WIDTH), { fg: palette(8) });
				// escaped rather than literal: these must stay decomposed, and a tool
				// that NFC-normalizes this file would precompose them and leave the
				// probe passing while testing nothing
				p.text(0, 1, 'e\u0301 a\u0300 n\u0303 o\u0308');
				p.text(0, 2, '\u{1F469}\u200D\u{1F4BB} \u{1F3F4}\u200D\u2620\uFE0F');
				p.text(0, 3, '\u{1F1EF}\u{1F1F5} \u{1F44D}\u{1F3FD}');
			});
		}
	),

	probe(
		'extended colour, semicolon form',
		'a 256-colour ramp and a truecolour ramp, both smooth and both fully coloured',
		(canvas) => {
			// The diff emits `38;5;n` and `38;2;r;g;b` rather than the colon form
			// ITU T.416 specifies, because the misreading is what got implemented
			// everywhere. A terminal that only accepts the colon form shows this
			// as literal text or as nothing
			canvas.paint((p) => {
				p.text(0, 0, '256:');
				for (let i = 0; i < WIDTH; i++) {
					p.fill(i, 1, 1, 1, { bg: palette(16 + i) });
				}
				p.text(0, 2, 'rgb:');
				for (let i = 0; i < WIDTH; i++) {
					const v = Math.round((i / (WIDTH - 1)) * 255);
					p.fill(i, 3, 1, 1, { bg: rgb(v, 64, 255 - v) });
				}
			});
		}
	),

	probe(
		'attributes, and closing them',
		'each label renders with its own attribute only; nothing bleeds rightward',
		(canvas) => {
			// A style is emitted as a transition from the previous cell's, so an
			// attribute that the terminal fails to close keeps going. Reading the
			// plain text at the end of each row is the check
			canvas.paint((p) => {
				const rows = [
					['bold', ATTR.bold],
					['dim', ATTR.dim],
					['italic', ATTR.italic],
					['underline', ATTR.underline],
					['inverse', ATTR.inverse],
					['strikethrough', ATTR.strikethrough],
				];
				rows.forEach(([label, attrs], y) => {
					p.text(0, y, label, { attrs });
					p.text(16, y, 'plain after');
				});
			});
		}
	),
];

/**
 * The incremental probe is separate because it needs two frames: the whole
 * point is what the *second* `present()` emits.
 */
export const INCREMENTAL = {
	title: 'incremental diff and the gap threshold',
	expect: 'only the marked cells change; the rest of the row does not flicker or move',
	run(canvas, write) {
		canvas.paint((p) => {
			p.text(0, 0, '.'.repeat(WIDTH));
			p.text(0, 1, '.'.repeat(WIDTH));
			p.text(0, 3, 'watch row 0 and row 1 only');
		});
		write(HOME + canvas.present({ full: true }).output);

		// two changes with a one-cell gap between them: shorter than a cursor
		// move, so the diff should paint straight through rather than move
		canvas.paint((p) => {
			const row = '.'.repeat(WIDTH).split('');
			row[10] = 'X';
			row[12] = 'X';
			p.text(0, 0, row.join(''));
			// and two far apart, which should be two runs with a move between them
			const other = '.'.repeat(WIDTH).split('');
			other[2] = 'Y';
			other[WIDTH - 3] = 'Y';
			p.text(0, 1, other.join(''));
			p.text(0, 3, 'watch row 0 and row 1 only');
		});
		const result = canvas.present();
		write(HOME + result.output);
		return result;
	},
};

/**
 * The backends, which claim things about the screen rather than about a rect.
 *
 * `test/canvas/backend.test.ts` replays them against a screen model with
 * scrollback and an alternate buffer, and that model has the same gap every
 * model here has: it agrees with the implementation by construction. These are
 * the three claims a terminal is allowed to disagree with.
 */
export const BACKENDS = [
	{
		title: 'inline canvas at the bottom of the screen',
		expect:
			'the log lines above stay put, and the two-row frame repaints in place three times without leaving copies behind',
		async run(pause) {
			const backend = createInlineCanvas({ height: 2 });
			for (const n of [1, 2, 3]) {
				backend.render((p) => {
					p.text(0, 0, `frame ${n} of 3`);
					p.text(0, 1, '='.repeat(n * 6));
				});
				await pause(400);
			}
			backend.write('a line written above the region');
			await pause(600);
			backend.done();
		},
	},

	{
		title: 'inline canvas written to while it is drawing',
		expect: 'each written line lands above the frame, in order, with the frame still at the bottom',
		async run(pause) {
			const backend = createInlineCanvas({ height: 1 });
			for (const n of [1, 2, 3]) {
				backend.render((p) => p.text(0, 0, `working (${n})`));
				backend.write(`line ${n}`);
				await pause(400);
			}
			backend.stop();
		},
	},

	{
		title: 'alternate screen',
		expect:
			'the screen switches to a blank one, then comes back with this log exactly as it was -- scrollback included, and the cursor visible',
		async run(pause) {
			const backend = createFullscreenCanvas();
			backend.render((p) => {
				p.text(0, 0, 'the alternate screen');
				p.text(0, 2, 'your log is not here, and comes back untouched');
			});
			backend.write('this was written while full screen');
			await pause(1500);
			backend.done();
		},
	},

	{
		title: 'line endings in raw mode',
		expect:
			'the two lines below are flush left. Stair-stepped means ONLCR is off and a bare \\n does not reach column zero',
		async run(pause) {
			terminal.setRawMode(true);
			try {
				process.stdout.write('first line\r\nsecond line\r\n');
				await pause(800);
			} finally {
				terminal.setRawMode(false);
			}
		},
	},
];

/**
 * The capability detector, against a real terminal.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --detect
 *
 * Every other probe in this file paints a frame and asks a human to read it. This
 * one is the reverse, and it is here for the same reason: the detector makes claims
 * only a terminal can falsify, and the suite cannot make any of them. A test can
 * feed `ESC P > | Ghostty 1.0.1 ST` to the router and assert what it does with it;
 * nothing in a test can say whether Ghostty *sends* that, whether it sends it
 * before the DA1 written after it, whether DECRQM is implemented at all, or how
 * long any of it takes -- and the default timeout is a number about the last of
 * those.
 *
 * So this prints what your terminal actually answered, byte for byte, with the
 * round trip timed. Run it in each one you care about, and over ssh and inside
 * tmux, which are their own answers.
 */
async function detect() {
	const { createInput, detectCapabilities, queryCursor, queryMode } =
		await import('../dist/input.mjs');
	const { supportsColor } = await import('../dist/ansi.mjs');
	const { schemeFromEnv } = await import('../dist/style.mjs');

	const show = (s) => JSON.stringify(s).replaceAll('\\u001b', 'ESC ').replaceAll('\\u0007', ' BEL');

	const router = createInput({ paste: false });
	try {
		const inferred = supportsColor();
		write(`inferred from the environment: colour level ${inferred}\r\n`);
		write(`  colour scheme: ${schemeFromEnv() ?? '<nothing said>'}`);
		write(` COLORFGBG=${process.env.COLORFGBG ?? '<unset>'}`);
		write(` SIGIL_COLOR_SCHEME=${process.env.SIGIL_COLOR_SCHEME ?? '<unset>'}\r\n`);
		write(`  TERM=${process.env.TERM ?? '<unset>'}`);
		write(` COLORTERM=${process.env.COLORTERM ?? '<unset>'}`);
		write(` TERM_PROGRAM=${process.env.TERM_PROGRAM ?? '<unset>'}\r\n\r\n`);

		const at = Date.now();
		const caps = await detectCapabilities(router, {
			background: true,
			colorLevel: inferred,
			geometry: true,
		});
		const took = Date.now() - at;

		write(`the batched probe came back in ${took}ms\r\n`);
		write(`  answered: ${caps.responded}\r\n`);
		write(`  name: ${caps.name ?? '<nothing>'}  version: ${caps.version ?? '<nothing>'}\r\n`);
		write(`  device: ${caps.device ? caps.device.join(';') : '<nothing>'}\r\n`);
		write(`  cell: ${caps.cell ? `${caps.cell.width}x${caps.cell.height}px` : '<nothing>'}\r\n`);
		write(
			`  text area: ${caps.pixels ? `${caps.pixels.width}x${caps.pixels.height}px` : '<nothing>'}\r\n`
		);
		write(`  colour level refined to: ${caps.colorLevel ?? `<unchanged, ${inferred}>`}\r\n`);
		write(
			`  background: ${caps.background ? `rgb(${caps.background.r}, ${caps.background.g}, ${caps.background.b})` : '<nothing>'}\r\n`
		);
		write(`  colour scheme: ${caps.colorScheme ?? '<nothing>'}\r\n`);
		write(`  replies, in the order they arrived:\r\n`);
		for (const reply of caps.replies) {
			write(`    ${reply.kind.padEnd(8)} ${show(reply.sequence)}\r\n`);
		}

		// the sentinel's own claim, and the one the timeout default rests on: a number
		// anywhere near 250 on a local terminal means the default is wrong
		write(`\r\nthe claim: DA1 came back, so ${took}ms is a round trip rather than a deadline.\r\n`);
		write(`  a local terminal should be single-digit ms; ~250 means it hit the timeout.\r\n\r\n`);

		const cursor = await queryCursor(router);
		write(
			`cursor position: ${cursor ? `row ${cursor.row}, column ${cursor.column}` : '<nothing>'}\r\n`
		);

		for (const mode of [2004, 1006, 1049, 9999]) {
			write(`  mode ${mode}: ${(await queryMode(router, mode)) ?? '<nothing>'}\r\n`);
		}
		write(
			`\r\nthe claim only a terminal can settle: the scheme above matches what you see.\r\n` +
				`  a light terminal reporting "dark", or either reporting "<nothing>", is the\r\n` +
				`  OSC 11 half not working here -- and if COLORFGBG disagrees with it, that is\r\n` +
				`  the variable being stale, which is why it is the floor and not the answer.\r\n\r\n`
		);

		write(
			`  expect 9999 to be "unrecognised" rather than "<nothing>": that is DECRQM\r\n` +
				`  telling a mode that is off from one it has never heard of, which is the whole\r\n` +
				`  reason to ask it. "<nothing>" for all four means no DECRQM at all.\r\n`
		);
	} finally {
		router.stop();
	}
}

/**
 * Mouse tracking, against a real terminal.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --mouse
 *
 * The mouse is the layer with the most claims a test cannot make, because every
 * one of them is about what a terminal *sends* rather than about what this reads.
 * A test can feed `ESC [ < 0 ; 10 ; 5 M` to the router and assert where it lands;
 * nothing in a test can say whether your terminal sends that rather than the
 * legacy encoding, whether `1003` reports motion here at all, whether a click
 * past column 223 survives, or whether the inline origin arithmetic comes out
 * right on a screen it did not simulate.
 *
 * So this turns tracking on and prints what arrives beside what the library made
 * of it. Token by token rather than byte for byte -- `ESC [ < 0 ; 41 ; 13 M`,
 * spaced the way this repository spells a sequence in prose -- which is not
 * cosmetic and is the whole of SIG-128: `showSpaced` below carries the citation.
 * `--detect` really does print byte for byte, because nothing there is a mouse
 * report and nothing there arms iTerm2's echo detector. Run it in each terminal
 * you care about, and over ssh and inside tmux, which are their own answers.
 *
 * It is the one mode here that writes a mode the terminal has to be taken back
 * out of, so everything is behind a `finally`: a shell left reporting the mouse
 * puts `ESC [ < 35 ; 40 ; 12 M` into whatever you type next, every time the
 * pointer crosses the window.
 */
async function mouse() {
	const { createInput, queryCursor, queryMode } = await import('../dist/input.mjs');
	const { createInlineCanvas } = await import('../dist/canvas.mjs');

	/**
	 * One report, spelled the way this repository spells a sequence in prose:
	 * `ESC [ < 0 ; 41 ; 13 M`, a space between every token and a run of digits
	 * kept whole.
	 *
	 * Spaced rather than verbatim, and that is the whole of SIG-128. iTerm2
	 * watches for a mouse report being **printed to the screen**, because that is
	 * what a stuck mouse looks like: the TUI died, tracking stayed on, and the
	 * shell is now echoing the reports. The check is
	 * `-[PTYSession detectTurdsForReportData:type:]`, which takes the report, drops
	 * the `ESC` and the two bytes after it and every byte under 32, and arms a
	 * regular expression over the next 100ms of screen text for whatever is left --
	 * `0;41;13M` for the press above. A verbatim `"ESC [<0;41;13M"` holds that run
	 * exactly, so the one app that has to print a report was telling iTerm2 it was
	 * the one app that must not: it offered to turn mouse reporting off, mid-probe,
	 * and it was reading the stream correctly. A space between the tokens breaks
	 * the run and nothing else, and the parameters are easier to read besides.
	 *
	 * `--detect` keeps its own verbatim `show()` on purpose. These answer two
	 * questions rather than one: there, fidelity is the point and no mouse report
	 * is involved, so nothing arms the detector.
	 *
	 * @param {string} str
	 * @returns {string}
	 */
	const showSpaced = (str) =>
		`"${(str.match(/[0-9]+|[\s\S]/g) ?? [])
			.map((tok) => {
				if (tok === '\u001b') return 'ESC';
				if (tok === '\u0007') return 'BEL';
				if (tok.length === 1 && (tok < ' ' || tok === '\u007f')) {
					return `\\x${tok.charCodeAt(0).toString(16).padStart(2, '0')}`;
				}
				return tok;
			})
			.join(' ')}"`;

	/**
	 * A second `data` listener, so the bytes can be shown beside the reading.
	 *
	 * The router drops a mouse report whether or not anybody asked for tracking --
	 * it is not a key, and putting one in somebody's answer is the failure that rule
	 * exists for -- so there is no way to see the raw sequence through it. A probe is
	 * the one caller entitled to look: it is a diagnostic rather than an app.
	 *
	 * @param {(chunk: string) => void} onChunk
	 * @returns {() => void} Removes it.
	 */
	const tap = (onChunk) => {
		const fn = (chunk) => onChunk(String(chunk));
		process.stdin.on('data', fn);
		return () => void process.stdin.removeListener('data', fn);
	};

	/**
	 * The whole screen as a surface, for the steps that are about the wire.
	 *
	 * Truthful rather than a stand-in: these steps treat the screen as the canvas,
	 * so a report's coordinates really are this canvas's, less the one-based offset.
	 * The step that is about *translation* points `target` at a real inline canvas
	 * instead.
	 */
	const screen = {
		get height() {
			return terminal.height;
		},
		locate: () => Promise.resolve(true),
		origin: { x: 0, y: 0 },
		get width() {
			return terminal.width;
		},
		toCanvas: (column, row) => ({ x: column - 1, y: row - 1 }),
	};

	/**
	 * What the router translates against, swapped rather than rebuilt.
	 *
	 * A router chooses its surface and its tracking mode when it is built, so the
	 * first version of this made one per step -- and what that came to on the wire
	 * was **fourteen mode changes in under two seconds**, twice inside the same
	 * millisecond. A mode that flickers is indistinguishable from an app that has
	 * lost track of whether it turned one on, so it was worth fixing whatever else
	 * was true.
	 *
	 * What this comment used to say next is that iTerm2's offer to turn mouse
	 * reporting off was iTerm2 spotting the churn. It was not: there is no
	 * mode-churn heuristic anywhere in iTerm2, and the dialog is the echo detector
	 * `showSpaced` above carries the citation for. The giveaway was already written
	 * down -- the dialog survived this fix -- and it should have been read as the
	 * attribution failing rather than as a second cause. SIG-128.
	 *
	 * The surface is the half that does not need a new router, so it delegates and
	 * one router covers every button-event step. Only the tracking mode is left, and
	 * that really does change once.
	 */
	let target = screen;
	const surface = {
		get height() {
			return target.height;
		},
		locate: (probe) => target.locate(probe),
		get origin() {
			return target.origin;
		},
		toCanvas: (column, row) => target.toCanvas(column, row),
		get width() {
			return target.width;
		},
	};

	/**
	 * Waits for one of a few keys, through the router that owns stdin.
	 *
	 * `onMatch` runs **synchronously**, inside the router's dispatch, which is the
	 * whole reason it is a parameter rather than something the caller does after
	 * the await. The router's `data` listener was attached when the router was
	 * built and `live()`'s raw tap afterwards, so on the chunk holding the quit key
	 * the router dispatches first and the tap runs second -- in the same `emit`,
	 * before any promise continuation. A flag set here is therefore visible to the
	 * tap; one set after `await untilKey(...)` is not, and the chunk has already
	 * been recorded by then.
	 *
	 * @param {import('../dist/input.mjs').InputRouter} router
	 * @param {string[]} names
	 * @param {() => void} [onMatch] - Runs before the promise resolves.
	 * @returns {Promise<string>}
	 */
	const untilKey = (router, names, onMatch) =>
		new Promise((resolve) => {
			const off = router.bind((event) => {
				const name = event.key.ctrl && event.key.name === 'c' ? 'abort' : event.key.name;
				if (name === 'abort' || names.includes(name)) {
					event.stop();
					off();
					onMatch?.();
					resolve(name);
				}
			});
		});

	let step = 0;
	/**
	 * @param {string} title
	 * @param {string} claim - What a terminal that agrees with us does.
	 */
	const heading = (title, claim) => {
		step++;
		write(`\r\n[${step}] ${title}\r\n`);
		write(`    the claim: ${claim}\r\n\r\n`);
	};

	/** True once the reader has asked to stop. */
	let aborted = false;

	/**
	 * Runs one live step, dumping what arrives until `q`.
	 *
	 * Takes the router rather than building one, which is the whole of the fix
	 * described on `surface` above: a step is a subscription and a wait, and neither
	 * needs the tracking mode touched.
	 *
	 * **Every report that arrives prints something**, which is the property three
	 * separate reports from a real terminal were about: a step that only printed what
	 * it was looking for went silent while working perfectly, and a silent screen is
	 * indistinguishable from a step that does nothing. So what a step's own `render`
	 * declines to describe gets a fallback line rather than nothing, and silence now
	 * means what it should -- that no report arrived at all, which is a finding.
	 *
	 * `silent` is the one opt-out and it exists for one step: the inline-origin one
	 * holds an anchored canvas, and a write underneath that scrolls the frame out
	 * from under the origin it learnt. That step draws its feedback into the frame.
	 *
	 * @param {import('../dist/input.mjs').InputRouter} router
	 * @param {(event: object) => string | undefined} render - What to print per event.
	 * @param {{ raw?: boolean, silent?: boolean }} opts
	 */
	const live = async (router, render, opts = {}) => {
		const lines = [];

		// the chunk holding `q` is not a report, and it is the one chunk every raw
		// step is guaranteed to receive on every run -- so recording it printed
		// `raw "q"` under a heading claiming every raw line holds `ESC [ <`. Set
		// from inside the router's dispatch, which runs before the tap on that same
		// chunk; see `untilKey`. A key pressed *mid*-step is still shown, which is
		// why the heading says "of a report" rather than "every line"
		let quitting = false;
		const untap =
			opts.raw === true
				? tap((chunk) => {
						if (!quitting) {
							lines.push(`      raw  ${showSpaced(chunk)}`);
						}
					})
				: () => {};
		const off = router.onMouse((event) => {
			const line = render(event);
			if (line !== undefined) {
				lines.push(`      ${line}`);
			} else if (opts.silent !== true) {
				lines.push(`      (${event.kind} -- arrived, but is not what this step is about)`);
			}
		});

		// drained on a timer rather than written from the handler: a motion report
		// per cell of travel is a lot of writes, and a probe that cannot keep up is
		// a probe measuring itself
		const timer = setInterval(() => {
			while (lines.length > 0) {
				write(`${lines.shift()}\r\n`);
			}
		}, 50);

		try {
			const key = await untilKey(router, ['q'], () => void (quitting = true));
			if (key === 'abort') {
				aborted = true;
			}
		} finally {
			clearInterval(timer);
			while (lines.length > 0) {
				write(`${lines.shift()}\r\n`);
			}
			untap();
			off();
		}
	};

	write(CLEAR + HOME + SHOW_CURSOR);
	write('mouse tracking, against this terminal. q moves on, Ctrl-C stops.\r\n');

	/**
	 * The button-event router, which every step but one shares.
	 *
	 * @type {import('../dist/input.mjs').InputRouter | undefined}
	 */
	let buttons;

	try {
		// ---------------------------------------------------------------- the window
		heading(
			'the window',
			'a terminal wider than 223 columns is what the legacy encoding cannot describe'
		);
		write(`    ${terminal.width} columns x ${terminal.height} rows\r\n`);
		write(
			terminal.width > 223
				? '    wide enough to test the column that broke X10.\r\n'
				: '    narrower than 224, so the column-223 step below is skipped. Widen the\r\n' +
						'    window and run again if you want that one.\r\n'
		);

		// tracking goes on once, here, and stays on until the 1003 step swaps it
		buttons = createInput({ mouse: { surface }, paste: false });

		// ----------------------------------------------------------------- the modes
		heading(
			'the modes, and whether DECRQM says they took',
			'1002 and 1006 read "set" while tracking is on; 1003 reads "reset"'
		);
		{
			let answered = 0;
			for (const mode of [1002, 1003, 1006]) {
				const state = await queryMode(buttons, mode);
				if (state !== undefined) {
					answered++;
				}
				write(`    mode ${mode}: ${state ?? '<nothing>'}\r\n`);
			}
			write(
				answered === 0
					? '\r\n    No DECRQM here at all, which is not a failure: it is the same answer\r\n' +
							'    --detect gets for 9999, and the modes may still be working. The steps\r\n' +
							'    below are what actually settle that.\r\n'
					: answered === 3
						? '\r\n    Three answers, so this terminal can be asked what it is doing -- which is\r\n' +
							'    the distinction DECRQM exists for: a mode that is off, and one it has\r\n' +
							'    never heard of, are different answers.\r\n'
						: `\r\n    ${answered} of three answered. A mix is worth knowing and is not a failure\r\n` +
							'    either: an unanswered query is silence, which reads the same as a mode\r\n' +
							'    this terminal does not implement DECRQM for. The steps below are what\r\n' +
							'    actually settle whether tracking works.\r\n'
			);
		}
		if (aborted) return;

		// ------------------------------------------------- every report, raw and read
		heading(
			'every report, token by token and as this library read it',
			'every raw line of a report holds "ESC [ <" -- one holding "ESC [ M" is the legacy encoding'
		);
		// the spacing is said here as well as after the step, because the only time
		// it can mislead is while somebody is reading a line against what they
		// believe the terminal sent -- which is during the clicking, not after `q`
		write(
			'    click, drag and scroll anywhere. q when you have seen enough.\r\n' +
				'    The raw lines are spaced -- the spaces are not in the report.\r\n\r\n'
		);
		await live(
			buttons,
			(event) => {
				const mods = [event.ctrl && 'ctrl', event.meta && 'alt', event.shift && 'shift']
					.filter(Boolean)
					.join('+');
				return (
					`read ${event.kind.padEnd(10)} at (${event.x}, ${event.y})` +
					`  button=${event.button ?? '-'}  wheel=${event.wheel ?? '-'}` +
					(mods ? `  ${mods}` : '')
				);
			},
			{ raw: true }
		);
		write(
			'\r\n    If those raw lines started "ESC [ M" instead, mode 1006 did not take and\r\n' +
				'    this library reads nothing else -- deliberately, because that encoding puts\r\n' +
				'    a coordinate in one byte of 32+n and cannot say "column 300". Worth knowing\r\n' +
				'    that it is worse than that here: stdin is decoded as UTF-8, so a byte past\r\n' +
				'    127 is not even a character, which is column 95 rather than 223.\r\n' +
				'\r\n    The raw lines are spaced -- "ESC [ < 0 ; 41 ; 13 M" rather than the bytes\r\n' +
				'    run together -- and that is not decoration. iTerm2 watches for a mouse\r\n' +
				'    report being printed to the screen, since that is what a stuck mouse looks\r\n' +
				'    like, and a verbatim line held the exact run it looks for: it offered to\r\n' +
				'    turn mouse reporting off in the middle of this probe, correctly. A space\r\n' +
				'    between the tokens breaks the run and nothing else.\r\n'
		);
		if (aborted) return;

		// ---------------------------------------------------------------- 1002 motion
		heading(
			'motion under 1002, which is the default',
			'moves arrive only while a button is held, and stop the moment you let go'
		);
		write('    press and drag, then release and keep moving. q to move on.\r\n\r\n');
		{
			let held = 0;
			let loose = 0;
			let down = false;
			// printed as it arrives rather than counted in silence. The first version
			// only counted, so a step whose whole subject is "reports stream while you
			// drag and stop when you let go" showed nothing at all until you pressed q --
			// which reads as a step that does not work, and was reported as one
			await live(buttons, (event) => {
				if (event.kind === 'mousedown') {
					down = true;
					return 'press -- moves should stream from here';
				}
				if (event.kind === 'mouseup') {
					down = false;
					return 'release -- moves should stop now';
				}
				if (event.kind !== 'mousemove') {
					return undefined;
				}
				if (down) {
					held++;
					return `move (${event.x}, ${event.y})  held`;
				}
				loose++;
				return `move (${event.x}, ${event.y})  NOTHING HELD`;
			});
			write(`    ${held} moves with a button held, ${loose} with nothing held.\r\n`);
			write(
				loose === 0
					? '    Which is 1002 doing exactly what it says.\r\n'
					: '    Moves with nothing held under 1002 means this terminal is reporting more\r\n' +
							'    than it was asked for, which is worth knowing but costs nothing here.\r\n'
			);
		}
		if (aborted) return;

		// ----------------------------------------------------------------- the wheel
		heading(
			'the wheel, and whether this one tilts',
			'up and down always; left and right only from a tilt wheel or a trackpad'
		);
		write('    scroll, and scroll sideways if you can. q to move on.\r\n\r\n');
		{
			const seen = new Set();
			// every turn, not the first of each direction. Printing only what was new
			// meant the step went silent after up and down and stayed silent however
			// much you scrolled, which is a working step that reads as a broken one --
			// the third time that shape was reported, and now a rule rather than a slip
			await live(buttons, (event) => {
				if (event.kind !== 'wheel') {
					return undefined;
				}
				const novel = !seen.has(event.wheel);
				seen.add(event.wheel);
				return (
					`wheel ${String(event.wheel).padEnd(5)} at (${event.x}, ${event.y})` +
					(novel ? '  <- first of this direction' : '')
				);
			});
			write(`    directions this terminal sent: ${[...seen].join(', ') || '<none>'}\r\n`);
		}
		if (aborted) return;

		// ------------------------------------------------------------ past column 223
		if (terminal.width > 223) {
			heading(
				'a click past column 223',
				'the column this reports is the column you clicked -- the one X10 cannot reach'
			);
			write('    click in the rightmost part of the window. q to move on.\r\n\r\n');
			let furthest = 0;
			await live(buttons, (event) => {
				if (event.kind !== 'mousedown') {
					return undefined;
				}
				furthest = Math.max(furthest, event.x + 1);
				return `column ${event.x + 1}`;
			});
			write(`    furthest column reported: ${furthest}\r\n`);
			write(
				furthest > 223
					? '    Past 223 and correct, which is the whole argument for SGR.\r\n'
					: '    Nothing past 223 was clicked, so this step said nothing. Try again further\r\n' +
							'    right.\r\n'
			);
			if (aborted) return;
		}

		// ------------------------------------------------------- the origin round trip
		heading(
			'the inline origin, end to end',
			'clicking the target reports exactly the cell it is drawn in'
		);
		write(
			'    An inline canvas does not know which screen row it is on -- the log above\r\n' +
				'    it moves -- so it asks, with a cursor report. This is that arithmetic against\r\n' +
				'    a screen nothing simulated. Click the * below. q to move on.\r\n\r\n'
		);
		{
			const spot = { x: 12, y: 2 };
			const backend = createInlineCanvas({ height: 5, terminal, width: 40 });

			/** Repaints the box in place, which moves nothing and re-anchors nothing. */
			const paint = (note) => {
				backend.render((p) => {
					p.text(0, 0, '+--------------------------------------+');
					p.text(0, 1, '|                                      |');
					p.text(0, 2, '|                                      |');
					p.text(0, 3, '|                                      |');
					p.text(0, 4, '+--------------------------------------+');
					p.text(spot.x, spot.y, '*');
					p.text(2, 3, note.padEnd(36).slice(0, 36));
				});
			};

			paint('click the * above');

			// the router now translates against the canvas rather than the screen, and
			// is asked to learn where it sits. Asked here rather than left to the first
			// report that cannot be placed, which is what the router does on its own:
			// that costs one click, and a step whose first click does nothing is a step
			// nobody trusts the rest of
			target = backend;
			const located = await backend.locate(() => queryCursor(buttons));

			const found = { got: undefined, hit: false };
			await live(
				buttons,
				(event) => {
					if (event.kind !== 'mousedown') {
						return undefined;
					}
					found.got = { x: event.x, y: event.y };
					found.hit = event.x === spot.x && event.y === spot.y;
					// painted *into* the canvas, and nothing is written around it -- which is
					// the rule this whole step is about, and which the first version broke.
					// An inline canvas holds rows at a position it learnt once; a `write()` to
					// stdout underneath it scrolls the screen, so the box walks up and the
					// canvas goes on believing the row it started at. What that came to was
					// reported exactly: the target stopped taking clicks and the last few
					// printed lines took them instead, because that is where the canvas still
					// thought it was. `backend.write()` is the way to put a line above a live
					// region, and it re-anchors -- so a step that wants feedback without
					// re-learning its origin has to draw the feedback in the frame
					paint(`pressed (${event.x}, ${event.y})${found.hit ? '  -- that is the *' : ''}`);
					return undefined;
				},
				{ silent: true }
			);

			// read before the canvas is finished with, not after: `done()` gives the
			// rows back, and giving the rows back is exactly what makes the origin
			// unknown again. Reading it afterwards reported "<unknown>" beside a press
			// that had translated perfectly, which is two lines contradicting each
			// other -- and is the first thing driving this probe turned up
			const learnt = backend.origin;
			target = screen;
			backend.done();

			write(`\r\n    origin the canvas learnt: ${JSON.stringify(learnt) ?? '<unknown>'}\r\n`);
			write(`    the * is drawn at: ${JSON.stringify(spot)}\r\n`);
			write(`    your last press translated to: ${JSON.stringify(found.got) ?? '<no press>'}\r\n`);
			write(
				found.hit
					? '    Which matches, so the cursor report and the arithmetic over it are right\r\n' +
							'    on this terminal.\r\n'
					: '    If you clicked the * and that does not match, the origin is wrong here --\r\n' +
							'    which is either the cursor report or what this made of it, and is the one\r\n' +
							'    thing in the mouse path no test can check.\r\n'
			);
			if (!located) {
				write(
					'    No cursor report came back at all, which is the same terminal --detect\r\n' +
						'    reports "<nothing>" for. Without one an inline canvas cannot place a\r\n' +
						'    report, and every click above was dropped rather than misread.\r\n'
				);
			}
		}
		if (aborted) return;

		// --------------------------------------------------- what it takes away
		heading(
			'what tracking takes away, and which key gets it back',
			'selection is gone while tracking is on, and some modifier overrides it'
		);
		write(
			'    try to select some text above by dragging. Then again holding shift, and\r\n' +
				'    again holding alt/option. One of them should give you a selection.\r\n' +
				'    q to move on.\r\n\r\n'
		);
		{
			// the reports *are* the answer here: a drag that reaches the app is a drag
			// the terminal did not keep for itself, and the modifier that gets selection
			// back is the one that makes these stop. A step that printed nothing left
			// the reader to infer both halves from an empty screen
			let quiet = 0;
			await live(buttons, (event) => {
				if (event.kind !== 'mousemove' && event.kind !== 'mousedown') {
					return undefined;
				}
				quiet++;
				return `${event.kind.padEnd(10)} at (${event.x}, ${event.y})  -- the app got this, not the terminal`;
			});
			write(
				quiet === 0
					? '\r\n    Nothing arrived at all, which means the terminal kept every drag for\r\n' +
							'    itself -- so tracking is not actually on here.\r\n'
					: '\r\n    Every line above is a drag the terminal handed to the app instead of\r\n' +
							'    selecting with it. The modifier that gets selection back is the one that\r\n' +
							'    makes those stop.\r\n'
			);
		}
		write(
			'\r\n    A terminal reporting the mouse stops doing its own selection, so an app\r\n' +
				"    that turns tracking on has, from the user's point of view, broken copy and\r\n" +
				'    paste.\r\n\r\n' +
				"    Which modifier gets it back is the terminal's own and is nothing an app can\r\n" +
				'    influence or detect: shift in xterm and most of what followed it, and\r\n' +
				'    **alt/option in iTerm2, where shift does nothing at all**. Whichever worked\r\n' +
				'    just now is the answer for this one, and it is the thing to put in your own\r\n' +
				'    docs -- because the first person to hit it will assume the app broke.\r\n'
		);
		if (aborted) return;

		// ---------------------------------------------------------------- 1003 motion
		//
		// last, and that is the mode churn again rather than a change of subject: this
		// is the one step that needs a different tracking mode, so putting it at the
		// end means the mode changes exactly once in the whole run
		buttons.stop();
		buttons = undefined;

		heading(
			'motion under 1003, which is what :hover costs',
			'a report per cell the pointer crosses, held or not -- this is the wire cost'
		);
		write('    move the pointer around without pressing anything. q to finish.\r\n\r\n');
		{
			const router = createInput({ mouse: { motion: true, surface }, paste: false });
			try {
				let moves = 0;
				const at = Date.now();
				await live(router, (event) => {
					if (event.kind !== 'mousemove') {
						return undefined;
					}
					moves++;
					// one line per cell the pointer crosses, which is unreadable on purpose:
					// that is what the wire is carrying, and a step that summarised it would
					// be describing the cost rather than showing it
					return `move (${event.x}, ${event.y})`;
				});
				const secs = Math.max(1, Math.round((Date.now() - at) / 1000));
				write(`    ${moves} motion reports in about ${secs}s, with nothing held.\r\n`);
				write(
					moves === 0
						? '    None at all means 1003 is not implemented here, and :hover cannot work.\r\n'
						: '    That rate, forever, over whatever link this is, is why 1003 is opt-in.\r\n'
				);
			} finally {
				router.stop();
			}
		}
	} finally {
		// whatever happened, the terminal stops reporting: each router puts its own
		// mode back, and this is the backstop for a throw between the two of them
		buttons?.stop();
		terminal.restore();
		write(SHOW_CURSOR + '\r\n');
	}
}

/**
 * OSC 52, against a real terminal.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --clipboard
 *
 * The one layer where **nothing** can be verified from inside the process, which
 * is what makes it the sharpest case for a probe. A terminal does not answer an
 * OSC 52: there is no reply, no DECRQM, no second query that says whether the
 * first one landed -- so `ClipboardCopy.written` is honestly limited to "the
 * bytes reached the stream", and every question past that needs a human with a
 * clipboard. A test can assert what `clipboardSequence()` builds; nothing in a
 * test can say whether *your* terminal honours it, what it caps the payload at,
 * whether tmux passes it through, or whether the primary selection means
 * anything where you are.
 *
 * So each step writes one payload and asks you to paste it somewhere. Run it in
 * each terminal you care about, and over ssh and inside tmux, which are their own
 * answers -- and are the whole reason OSC 52 exists.
 *
 * Nothing here is a mode, so there is nothing to put back: OSC 52 is a write.
 * That is why this mode has no `finally` where `--mouse` has one.
 */
async function clipboard() {
	const { CLIPBOARD_LIMIT, clipboardSequence, copyToClipboard } =
		await import('../dist/terminal.mjs');

	let step = 0;
	/**
	 * @param {string} title
	 * @param {string} claim - What a terminal that honours this does.
	 */
	const heading = (title, claim) => {
		step++;
		write(`\r\n[${step}] ${title}\r\n`);
		write(`    the claim: ${claim}\r\n\r\n`);
	};

	/** Writes a payload and reports what went out, which is all this can know. */
	const send = (text, opts = {}) => {
		const copy = copyToClipboard(terminal, text, opts);
		write(
			`    written=${copy.written}  bytes=${copy.bytes}` +
				`  truncated=${copy.truncated}  refused=${copy.refused ?? 'no'}\r\n`
		);
		return copy;
	};

	/** Waits, so that each step's payload is the one on the clipboard. */
	const next = async (prompt = 'paste it somewhere, then press a key') => {
		write(`\r\n    ${prompt} `);
		const pressed = await key();
		write('\r\n');
		return pressed !== '\u0003';
	};

	write(CLEAR + HOME + SHOW_CURSOR);
	write('OSC 52, against this terminal. Ctrl-C stops.\r\n');

	// ------------------------------------------------------------ the environment
	heading(
		'what decides whether any of this works',
		'the variables below are what a reader needs to interpret every step after it'
	);
	write(`    TERM_PROGRAM=${process.env.TERM_PROGRAM ?? '<unset>'}`);
	write(`  TERM=${process.env.TERM ?? '<unset>'}\r\n`);
	write(`    TMUX=${process.env.TMUX ? 'set' : '<unset>'}`);
	write(`  STY=${process.env.STY ?? '<unset>'}`);
	write(`  SSH_TTY=${process.env.SSH_TTY ?? '<unset>'}\r\n`);
	if (process.env.TMUX) {
		write(
			'\r\n    Inside tmux. OSC 52 only reaches the outer terminal with\r\n' +
				'      set -g set-clipboard on\r\n' +
				'    and tmux may handle it itself instead, putting the text in a tmux\r\n' +
				'    buffer rather than on the system clipboard -- which is a different\r\n' +
				'    thing that pastes with a different keystroke. Worth knowing which\r\n' +
				'    one you got.\r\n'
		);
	}
	if (process.env.SSH_TTY) {
		write(
			'\r\n    Over ssh, which is the case OSC 52 exists for: the terminal holds\r\n' +
				'    the clipboard, so the remote end can reach it with no channel of its\r\n' +
				'    own. If this works here and nowhere else, that is still the win.\r\n'
		);
	}

	// ------------------------------------------------------------ does it work
	heading(
		'an ordinary copy',
		'the text below is on your clipboard; several terminals refuse this by default'
	);
	const marker = `sigil-osc52-${Date.now()}`;
	write(`    sending: ${marker}\r\n`);
	send(marker);
	write(
		'\r\n    Paste. The marker above means it worked. Nothing, or whatever you had\r\n' +
			'    copied before, means this terminal refused it -- which is a setting and\r\n' +
			'    not a bug: a remote process writing your clipboard is a real hazard, so\r\n' +
			'    look for "allow clipboard access" or similar.\r\n'
	);
	if (!(await next())) return;

	// --------------------------------------------------- the injection that is not
	heading(
		'a payload full of control characters',
		'your window title did not change, nothing beeped, and the paste is literal'
	);
	// the reason OSC 52 is base64: an OSC runs until its terminator, so a control
	// character inside the payload would end the sequence early and the rest would
	// reach the terminal as commands. The guard is in the encoder, which is why a
	// caller can hand it anything
	const nasty = `before${ESC_CHAR}]0;PWNED${ESC_CHAR}\\${BEL_CHAR}after`;
	write(`    sending: ${JSON.stringify(nasty).replaceAll('\\u001b', 'ESC ')}\r\n`);
	send(nasty);
	write(
		'\r\n    A title that now says PWNED, or a beep, means the payload escaped its\r\n' +
			'    own sequence -- which base64 is supposed to make impossible. The paste\r\n' +
			'    should contain those bytes as text.\r\n'
	);
	if (!(await next())) return;

	// ------------------------------------------------------------------ the cap
	heading(
		'the payload cap, which no terminal will tell you',
		`${CLIPBOARD_LIMIT} bytes is what every OSC 52 tool assumes; yours may be far lower`
	);
	write(
		'    Each size below ends with its own marker. Paste after each one and\r\n' +
			"    note the last size whose marker arrives -- that is this terminal's cap,\r\n" +
			'    and it is the number the default is a guess about.\r\n\r\n'
	);
	for (const size of [1_000, 10_000, CLIPBOARD_LIMIT]) {
		const tail = `[END-${size}]`;
		const body = 'x'.repeat(Math.max(0, size - tail.length)) + tail;
		write(`    ${String(size).padStart(6)} bytes: `);
		const copy = clipboardSequence(body);
		write(`sequence is ${copy.sequence.length} bytes on the wire\r\n`);
		send(body);
		if (!(await next(`paste and look for ${tail}, then press a key`))) return;
	}
	write(
		'    A size that silently did nothing is the failure this cap exists for:\r\n' +
			'    a terminal handed too much drops the whole sequence, which is why the\r\n' +
			'    default refuses rather than sending and hoping.\r\n'
	);

	// ------------------------------------------------------------ over the cap
	heading(
		'over the cap, refused and then truncated',
		'the first writes nothing at all; the second writes exactly the cap'
	);
	const huge = 'y'.repeat(CLIPBOARD_LIMIT + 1_000);
	write('    refused:   ');
	send(huge);
	write('    truncated: ');
	send(huge, { truncate: true });
	write(
		'\r\n    The refusal is the default because a dropped sequence is silent: a\r\n' +
			'    caller that asked for 80 KB and got nothing has no way to find out.\r\n'
	);
	if (!(await next('press a key'))) return;

	// ----------------------------------------------------------- the primary one
	heading(
		'the primary selection',
		'on X11 this is what middle-click pastes; elsewhere it is usually ignored'
	);
	send(`sigil-primary-${Date.now()}`, { target: 'primary' });
	write(
		'\r\n    Middle-click somewhere that takes text. Nothing happening here is the\r\n' +
			'    ordinary answer outside X11 and is not a failure.\r\n'
	);
	if (!(await next('press a key'))) return;

	// ------------------------------------------------------------- what is out
	heading(
		'reading is not implemented, deliberately',
		'nothing below is written, and that is the whole step'
	);
	write(
		'    `ESC ] 52 ; c ; ? ST` asks the terminal to send the clipboard back on\r\n' +
			'    stdin, which is a remote process exfiltrating whatever you last copied.\r\n' +
			'    It is disabled by default nearly everywhere, for that reason, and sigil\r\n' +
			'    does not write it. Paste arrives through bracketed paste instead, which\r\n' +
			'    you have to actually perform.\r\n'
	);
}

/** Written with `fromCharCode` for the reason the rest of this repo is. */
const ESC_CHAR = String.fromCharCode(0x1b);
const BEL_CHAR = String.fromCharCode(0x07);

/** @returns {Promise<string>} The key pressed. */
function key() {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const raw = stdin.isTTY;
		if (raw) {
			stdin.setRawMode(true);
		}
		stdin.resume();
		stdin.once('data', (data) => {
			if (raw) {
				stdin.setRawMode(false);
			}
			stdin.pause();
			resolve(data.toString());
		});
	});
}

/**
 * A QR code, against a real terminal and a real camera.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --qrcode
 *
 * **The check is to scan these with a phone.** That sentence is the whole of why
 * this mode exists, and it is a sharper version of `--clipboard`'s argument: there
 * the answer lives in somebody's paste buffer, and here it lives in a camera's
 * locate-and-decode pipeline, which is not a thing any process can ask about.
 *
 * What *is* already settled without a camera, so that nobody re-establishes it
 * here: every matrix this component produces is compared module for module
 * against a reference encoder's in `test/components/qrcode.test.ts`, and the
 * drawn glyphs have been turned back into pixels and decoded by an independent
 * decoder -- 168 of 168, over seven payloads, four levels, both forms and all
 * three polarities. So the encoder is not what this mode is about.
 *
 * What it is about is the three things that need your terminal and your phone:
 *
 * - whether your **font** draws a contiguous half block. `▀` and `▄`
 *   have to meet exactly, and several fonts draw them a pixel short at small
 *   sizes -- which is a light seam through every second module row and is the one
 *   failure the compact form has that the large form does not.
 * - whether your **colours** have the contrast a camera needs. The code is drawn
 *   at palette index 0 on index 7, which is whatever your theme renders those as.
 * - whether the **quiet zone** earns its place where you are. Measured against a
 *   software decoder, a code with no quiet zone against a dark background is not
 *   found at all while one module of it is enough; the spec asks for four because
 *   a camera at an angle through a blur needs more than a clean bitmap does.
 *
 * Nothing here is a mode and nothing is queried, so there is nothing to put back
 * -- which is `--clipboard`'s position rather than `--mouse`'s.
 */
async function qrcodeProbe() {
	const { qrcode, encodeQr } = await import('../dist/components.mjs');
	const { strip } = await import('../dist/ansi.mjs');
	const { stringWidth } = await import('../dist/width.mjs');

	let step = 0;
	/**
	 * @param {string} title
	 * @param {string} claim - What a terminal and a scanner that agree show.
	 */
	const heading = (title, claim) => {
		step++;
		write(`\r\n[${step}] ${title}\r\n`);
		write(`    the claim: ${claim}\r\n\r\n`);
	};

	/** Writes a code, with every newline turned into a CRLF for raw mode. */
	const show = (text, opts) => {
		const out = qrcode(text, opts);
		write(`${out.replaceAll('\n', '\r\n')}\r\n`);
		return out;
	};

	const next = async (prompt = 'scan it, then press a key') => {
		write(`\r\n    ${prompt} `);
		const pressed = await key();
		write('\r\n');
		return pressed !== '\u0003';
	};

	write(CLEAR + HOME + SHOW_CURSOR);
	write('QR codes, against this terminal and your phone. Ctrl-C stops.\r\n');

	const url = 'https://github.com/cb1kenobi/sigil';
	const code = encodeQr(url);
	write(
		`\r\nthe payload is ${url}\r\n` +
			`mode ${code.mode}, version ${code.version} (${code.size} modules square), ` +
			`level ${code.ecc}, mask ${code.mask}\r\n`
	);

	// ------------------------------------------------------------------- compact
	heading(
		'the compact form: a half block per cell',
		'it scans, and no light seam runs through it -- a seam is your font drawing ' +
			'the two half blocks a pixel short of each other'
	);
	const compact = show(url);
	// measured through `strip()` and `stringWidth()` rather than with
	// `String.length`, because every line above colour level 0 carries the SGR that
	// paints the two colours -- so a 29-column code has a 41-character line
	const drawnLines = compact.split('\n');
	write(`\r\n    ${stringWidth(strip(drawnLines[0]))} columns by ${drawnLines.length} lines\r\n`);
	if (!(await next())) {
		return;
	}

	// --------------------------------------------------------------------- large
	write(CLEAR + HOME);
	heading(
		'the large form: two columns per module',
		'it scans, and it has no half blocks in it at all -- so a terminal where ' +
			'this one scans and the one before it does not is a font problem rather ' +
			'than a code problem'
	);
	show(url, { form: 'large' });
	if (!(await next())) {
		return;
	}

	// ------------------------------------------------------------------ polarity
	write(CLEAR + HOME);
	heading(
		'the inverted form, which is what a pipe and NO_COLOR get on a DARK terminal',
		'it scans too, and it is correctly polarised rather than merely readable: ' +
			'at colour level 0 there is nothing to paint the two colours with, so the ' +
			'light modules are the drawn ones and the terminal supplies the dark, ' +
			'which puts dark modules on dark and light on light exactly as the painted ' +
			'codes do. A scanner that reads those and refuses this one is telling you ' +
			"about your terminal's own contrast rather than about the polarity"
	);
	show(url, { colorLevel: 0, colorScheme: 'dark' });
	if (!(await next())) {
		return;
	}

	// ------------------------------------------------- the fourth of the four
	write(CLEAR + HOME);
	heading(
		'the large form, inverted: what a pipe gets at the bigger size',
		'it scans. This is the fourth of the four -- two forms times two ' +
			'polarities -- and it is here because the module doc claims both forms at ' +
			'both polarities and for one commit the probe drew three of them. A ' +
			'review round found the sentence rather than the gap'
	);
	show(url, { colorLevel: 0, colorScheme: 'dark', form: 'large' });
	if (!(await next())) {
		return;
	}

	// ---------------------------------------------------------------- quiet zone
	write(CLEAR + HOME);
	heading(
		'no quiet zone at all',
		'this is the one that is expected to be HARDER to scan, or to fail. The ' +
			'dark modules at the edge touch the terminal background, which is what a ' +
			'quiet zone exists to stop -- a software decoder finds nothing here and ' +
			'finds a code with one module of quiet zone'
	);
	show(url, { quietZone: 0 });
	if (!(await next('try to scan it, then press a key'))) {
		return;
	}

	// --------------------------------------------------------------------- level
	write(CLEAR + HOME);
	heading(
		'the smallest and the largest error correction',
		'both scan. L is the smaller code and H is the one that survives a thumb ' +
			'over the corner, which is damage a screen does not have -- so M is the ' +
			'default and this is what the two ends cost'
	);
	for (const ecc of ['L', 'H']) {
		const one = encodeQr(url, { ecc });
		write(`    level ${ecc}: version ${one.version}, ${one.size} modules square\r\n\r\n`);
		show(url, { ecc });
		write('\r\n');
	}
	if (!(await next())) {
		return;
	}

	// ------------------------------------------------------------------- braille
	write(CLEAR + HOME);
	heading(
		'braille, which is the form this component refuses to offer',
		'this is expected NOT to scan. A Dots cell is 2x4, so a module would be ' +
			'half a column by a quarter of a cell -- square, and four times smaller ' +
			'again -- and a braille cell does not tile: the dots are discrete, with ' +
			'gaps about as wide as the dots, so a dark region is a dotted texture ' +
			'rather than a module. A software decoder finds nothing in it. If your ' +
			'phone reads this, say so, because it is the measurement that would ' +
			'reopen the decision'
	);
	write(braille(code).replaceAll('\n', '\r\n'));
	write('\r\n');
	await next('try to scan it, then press a key');

	write(
		'\r\nIf every step but the last two scanned, this component works on this ' +
			'terminal.\r\nIf the compact form seamed and the large form did not, it is ' +
			'the font.\r\n'
	);
}

/**
 * The refused braille form, drawn here so that the refusal is falsifiable.
 *
 * Eight modules per cell, two across and four down, which is the geometry the
 * component's own notes work out and reject. It is in the probe rather than in
 * the component because an API that promises something unscannable is worse than
 * one that leaves it out -- and a refusal nobody can check is worth less than one
 * somebody can.
 *
 * @param {{ modules: readonly (readonly boolean[])[], size: number }} code
 * @returns {string} The code, in braille.
 */
function braille(code) {
	const quiet = 4;
	const span = code.size + quiet * 2;
	const dark = (x, y) =>
		x >= quiet &&
		y >= quiet &&
		x < quiet + code.size &&
		y < quiet + code.size &&
		code.modules[y - quiet][x - quiet];

	// the dot order inside a braille cell, which is the one thing about the
	// encoding that is not a straight bit index: the eighth and seventh dots were
	// added after the first six, so the low six bits go down the two columns and
	// the high two are the bottom row
	const BITS = [
		[0, 3],
		[1, 4],
		[2, 5],
		[6, 7],
	];

	const lines = [];
	for (let cy = 0; cy < Math.ceil(span / 4); cy++) {
		let line = '';
		for (let cx = 0; cx < Math.ceil(span / 2); cx++) {
			let bits = 0;
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					// inverted, for the reason the component inverts at level 0: a
					// braille dot is drawn in the foreground, which on a dark
					// terminal is the light colour
					if (!dark(cx * 2 + dx, cy * 4 + dy)) {
						bits |= 1 << BITS[dy][dx];
					}
				}
			}
			line += String.fromCodePoint(0x2800 + bits);
		}
		lines.push(line);
	}

	return `${lines.join('\n')}\n`;
}

const write = (s) => process.stdout.write(s);

async function main() {
	// both halves. Every mode here reads what you press -- the frame probes wait for a
	// key, `--detect` waits for a reply, `--mouse` waits for a pointer -- and a query
	// is written to the output while its answer arrives on the input, so a guard that
	// asked about one of them let `| cat` through from a terminal
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		console.error('terminal-probe needs a real terminal on both stdin and stdout.');
		process.exitCode = 1;
		return;
	}

	// the detector is text rather than a frame, and it needs stdin rather than a
	// human reading the screen -- so it is its own mode instead of one more probe
	if (process.argv.includes('--detect')) {
		await detect();
		return;
	}

	// and the mouse is text plus one canvas, and needs a hand on the pointer rather
	// than an eye on a frame, so it is its own mode for the same reason
	if (process.argv.includes('--mouse')) {
		await mouse();
		return;
	}

	// and the clipboard is text plus a human with a paste buffer, which is the one
	// layer where nothing at all can be verified from inside the process
	if (process.argv.includes('--clipboard')) {
		await clipboard();
		return;
	}

	// and a QR code is text plus a human with a camera, which is the one claim
	// here that not even a second process could settle
	if (process.argv.includes('--qrcode')) {
		await qrcodeProbe();
		return;
	}

	const height = 6;
	write(HIDE_CURSOR);

	try {
		for (const [i, p] of [...PROBES, INCREMENTAL].entries()) {
			const canvas = createCanvas({ width: WIDTH, height });
			write(CLEAR + HOME);
			write(`[${i + 1}/${PROBES.length + 1}] ${p.title}\r\n`);
			write(`expect: ${p.expect}\r\n\r\n`);

			// the canvas starts on the row after the header, so give it its rows
			// first: relative movement cannot scroll, and CUD stops at the margin
			write('\n'.repeat(height - 1) + `\x1b[${height - 1}A`);
			const top = `\x1b[s`;
			write(top);

			const result = p.run(canvas, (s) => write(s.replace(HOME, '\x1b[u')));
			if (result === undefined) {
				const first = canvas.present({ full: true });
				write('\x1b[u' + first.output);
			}

			write(`\x1b[${height + 1}B\r\n\r\npress any key (q to quit)...`);
			const k = await key();
			if (k === 'q' || k === '\x03') {
				return;
			}
		}

		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		for (const [i, p] of BACKENDS.entries()) {
			write(CLEAR + HOME);
			write(`[backend ${i + 1}/${BACKENDS.length}] ${p.title}\r\n`);
			write(`expect: ${p.expect}\r\n\r\n`);
			write('log line one\r\nlog line two\r\nlog line three\r\n');

			// the backends hide the cursor themselves and put it back, so this one
			// gets out of their way rather than holding it hidden across them
			write(SHOW_CURSOR);
			await p.run(pause);

			write(`\r\npress any key (q to quit)...`);
			const k = await key();
			write(HIDE_CURSOR);
			if (k === 'q' || k === '\x03') {
				return;
			}
		}
	} finally {
		write(SHOW_CURSOR + '\r\n');
	}
}

// importable for a headless smoke test; only probes when run directly
if (import.meta.filename === process.argv[1]) {
	await main();
}
