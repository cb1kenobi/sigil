/**
 * Paints the frames a real terminal is allowed to disagree with us about.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --detect
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs --mouse
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
 * So this turns tracking on and prints what arrives, byte for byte, beside what
 * the library made of it. Run it in each terminal you care about, and over ssh
 * and inside tmux, which are their own answers.
 *
 * It is the one mode here that writes a mode the terminal has to be taken back
 * out of, so everything is behind a `finally`: a shell left reporting the mouse
 * puts `ESC [ < 35 ; 40 ; 12 M` into whatever you type next, every time the
 * pointer crosses the window.
 */
async function mouse() {
	const { createInput, parseMouseReport, queryMode } = await import('../dist/input.mjs');
	const { createInlineCanvas } = await import('../dist/canvas.mjs');

	const show = (str) => JSON.stringify(str).replaceAll('\\u001b', 'ESC ');

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
	 * The step that is about *translation* uses a real inline canvas instead.
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
	 * Waits for one of a few keys, through the router that owns stdin.
	 *
	 * @param {import('../dist/input.mjs').InputRouter} router
	 * @param {string[]} names
	 * @returns {Promise<string>}
	 */
	const untilKey = (router, names) =>
		new Promise((resolve) => {
			const off = router.bind((event) => {
				const name = event.key.ctrl && event.key.name === 'c' ? 'abort' : event.key.name;
				if (name === 'abort' || names.includes(name)) {
					event.stop();
					off();
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
	 * Runs one live step with tracking on, dumping what arrives until `q`.
	 *
	 * A router per step rather than one for all of them, because the tracking mode
	 * is chosen when the router is built -- which is also what lets the `1002` and
	 * `1003` steps be an A/B rather than a description.
	 *
	 * @param {{ motion?: boolean, raw?: boolean, surface?: object }} opts
	 * @param {(event: object) => string | undefined} render - What to print per event.
	 */
	const live = async (opts, render) => {
		const lines = [];
		const untap =
			opts.raw === false ? () => {} : tap((chunk) => lines.push(`      raw  ${show(chunk)}`));
		const router = createInput({
			mouse: { motion: opts.motion === true, surface: opts.surface ?? screen },
			paste: false,
		});

		try {
			router.onMouse((event) => {
				const line = render(event);
				if (line !== undefined) {
					lines.push(`      ${line}`);
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

			const key = await untilKey(router, ['q']);
			clearInterval(timer);
			while (lines.length > 0) {
				write(`${lines.shift()}\r\n`);
			}
			if (key === 'abort') {
				aborted = true;
			}
		} finally {
			untap();
			router.stop();
		}
	};

	write(CLEAR + HOME + SHOW_CURSOR);
	write('mouse tracking, against this terminal. q moves on, Ctrl-C stops.\r\n');

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

		// ----------------------------------------------------------------- the modes
		heading(
			'the modes, and whether DECRQM says they took',
			'1002 and 1006 read "set" while tracking is on; 1003 reads "reset"'
		);
		{
			const router = createInput({ mouse: { surface: screen }, paste: false });
			try {
				let answered = 0;
				for (const mode of [1002, 1003, 1006]) {
					const state = await queryMode(router, mode);
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
			} finally {
				router.stop();
			}
		}
		if (aborted) return;

		// ------------------------------------------------- every report, raw and read
		heading(
			'every report, as bytes and as this library read it',
			'every raw line holds "ESC [ <" -- one holding "ESC [ M" is the legacy encoding'
		);
		write('    click, drag and scroll anywhere. q when you have seen enough.\r\n\r\n');
		await live({}, (event) => {
			const mods = [event.ctrl && 'ctrl', event.meta && 'alt', event.shift && 'shift']
				.filter(Boolean)
				.join('+');
			return (
				`read ${event.kind.padEnd(10)} at (${event.x}, ${event.y})` +
				`  button=${event.button ?? '-'}  wheel=${event.wheel ?? '-'}` +
				(mods ? `  ${mods}` : '')
			);
		});
		write(
			'\r\n    If those raw lines started "ESC [ M" instead, mode 1006 did not take and\r\n' +
				'    this library reads nothing else -- deliberately, because that encoding puts\r\n' +
				'    a coordinate in one byte of 32+n and cannot say "column 300". Worth knowing\r\n' +
				'    that it is worse than that here: stdin is decoded as UTF-8, so a byte past\r\n' +
				'    127 is not even a character, which is column 95 rather than 223.\r\n'
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
			await live({ raw: false }, (event) => {
				if (event.kind === 'mousedown') down = true;
				if (event.kind === 'mouseup') down = false;
				if (event.kind !== 'mousemove') return undefined;
				if (down) {
					held++;
				} else {
					loose++;
				}
				return undefined;
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

		// ---------------------------------------------------------------- 1003 motion
		heading(
			'motion under 1003, which is what :hover costs',
			'a report per cell the pointer crosses, held or not -- this is the wire cost'
		);
		write('    move the pointer around without pressing anything. q to move on.\r\n\r\n');
		{
			let moves = 0;
			const at = Date.now();
			await live({ motion: true, raw: false }, (event) => {
				if (event.kind === 'mousemove') moves++;
				return undefined;
			});
			const secs = Math.max(1, Math.round((Date.now() - at) / 1000));
			write(`    ${moves} motion reports in about ${secs}s, with nothing held.\r\n`);
			write(
				moves === 0
					? '    None at all means 1003 is not implemented here, and :hover cannot work.\r\n'
					: '    That rate, forever, over whatever link this is, is why 1003 is opt-in.\r\n'
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
			await live({ raw: false }, (event) => {
				if (event.kind !== 'wheel') return undefined;
				if (seen.has(event.wheel)) return undefined;
				seen.add(event.wheel);
				return `first ${event.wheel} at (${event.x}, ${event.y})`;
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
			await live({ raw: false }, (event) => {
				if (event.kind !== 'mousedown') return undefined;
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
			const target = { x: 12, y: 2 };
			const backend = createInlineCanvas({ height: 5, terminal, width: 40 });
			backend.render((p) => {
				p.text(0, 0, '+--------------------------------------+');
				p.text(0, 1, '|                                      |');
				p.text(0, 2, '|                                      |');
				p.text(0, 3, '|                                      |');
				p.text(0, 4, '+--------------------------------------+');
				p.text(target.x, target.y, '*');
			});

			const router = createInput({ mouse: { surface: backend }, paste: false });
			try {
				// the router asks once when it starts, so give the reply a moment to land
				await new Promise((resolve) => setTimeout(resolve, 300));
				const found = { hit: false, got: undefined };
				router.onMouse((event) => {
					if (event.kind !== 'mousedown') return;
					found.got = { x: event.x, y: event.y };
					found.hit = event.x === target.x && event.y === target.y;
				});
				const key = await untilKey(router, ['q']);
				if (key === 'abort') aborted = true;

				// read before the canvas is finished with, not after: `done()` gives the
				// rows back, and giving the rows back is exactly what makes the origin
				// unknown again. Reading it afterwards reported "<unknown>" beside a
				// press that had translated perfectly, which is two lines contradicting
				// each other -- and is the first thing driving this probe turned up
				const learnt = backend.origin;
				backend.done();

				write(`\r\n    origin the canvas learnt: ${JSON.stringify(learnt) ?? '<unknown>'}\r\n`);
				write(`    the * is drawn at: ${JSON.stringify(target)}\r\n`);
				write(
					`    your last press translated to: ${JSON.stringify(found.got) ?? '<no press>'}\r\n`
				);
				write(
					found.hit
						? '    Which matches, so the cursor report and the arithmetic over it are right\r\n' +
								'    on this terminal.\r\n'
						: '    If you clicked the * and that does not match, the origin is wrong here --\r\n' +
								'    which is either the cursor report or what this made of it, and is the one\r\n' +
								'    thing in the mouse path no test can check.\r\n'
				);
				if (learnt === undefined) {
					write(
						'    An unknown origin means no cursor report came back at all, which is the\r\n' +
							'    same terminal the --detect mode reports "<nothing>" for.\r\n'
					);
				}
			} finally {
				router.stop();
				backend.stop();
			}
		}
		if (aborted) return;

		// --------------------------------------------------- what it takes away
		heading(
			'what tracking takes away',
			'selecting text with the pointer does not work while it is on; shift-drag may'
		);
		write('    try to select some text above, then try again holding shift. q to finish.\r\n\r\n');
		await live({ raw: false }, () => undefined);
		write(
			'\r\n    A terminal reporting the mouse stops doing its own selection, so an app\r\n' +
				"    that turns tracking on has, from the user's point of view, broken copy and\r\n" +
				'    paste. Shift-drag overrides it in most terminals and not all -- which one\r\n' +
				'    this is, is the thing only this step can tell you.\r\n'
		);
	} finally {
		// whatever happened, the terminal stops reporting: every router above puts its
		// own mode back, and this is the backstop for a throw between two of them
		terminal.restore();
		write(SHOW_CURSOR + '\r\n');
	}
}

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
