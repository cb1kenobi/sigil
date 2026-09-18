/**
 * Paints the frames a real terminal is allowed to disagree with us about.
 *
 *   pnpm build && node packages/sigil/scripts/terminal-probe.mjs
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
	if (!process.stdout.isTTY) {
		console.error('terminal-probe needs a real terminal; stdout is not a TTY.');
		process.exitCode = 1;
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
