import type { Diagnostic } from '../src/build/diagnostic.js';
import { diagnosticsView, render, reportLevel, summaryView, TOOLCHAIN_CSS } from '../src/report.js';
import { ESC, hasAnsi, strip } from '@ttylabs/sigil/ansi';
import { stringWidth } from '@ttylabs/sigil/width';
import { MAX_WIDTH } from '@ttylabs/sigil/wrap';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The toolchain rendering its own output.
 *
 * Asserted against `report.ts` directly rather than through `run()`, because the
 * two things worth pinning here are invisible from there: a vitest worker's
 * stderr has no `columns` and no `isTTY`, so every render through the CLI comes
 * out at the fallback width with no colour -- which is the one case that cannot
 * fail. `ReportStream` is an interface for exactly this reason.
 */

/**
 * A terminal that takes colour. `FORCE_COLOR` rather than `isTTY` alone, because
 * a stream is only half of what `supportsColor()` reads: a vitest worker has no
 * `TERM` behind it, so an `isTTY: true` with the worker's own environment
 * detects level 0 and a test asserting colour would be asserting the one thing
 * that cannot happen.
 */
const WIDE = {
	env: { FORCE_COLOR: '3' },
	stream: { columns: 100, isTTY: true },
} as const;

/** A pipe, which is where a report takes no colour. */
const PLAIN = { env: {}, stream: { columns: 100, isTTY: false } } as const;

/** A diagnostic, with the fields a caller cares about. */
function diagnostic(over: Partial<Diagnostic> = {}): Diagnostic {
	return {
		column: 24,
		file: 'commands/build.ts',
		line: 12,
		message: 'something to say about it',
		severity: 'warning',
		...over,
	};
}

/**
 * The SGR parameters a render opened, whichever sequences they arrived in.
 *
 * Asserting on the parameters rather than on the bytes, which is the rule the
 * canvas diff's own tests follow: a transition combines what it closes with what
 * it opens, so green after bold is `ESC[22;32m` rather than `ESC[32m`. A test
 * that pinned the latter would be pinning one implementation of the transition
 * rather than the claim that something was drawn green.
 *
 * @param out - A rendered report.
 * @returns Every parameter it set, as numbers.
 */
function sgr(out: string): Set<number> {
	// built from the exported `ESC` rather than written as an escape in a
	// character class, which is this repo's own rule twice over: a raw control
	// character never sits in source, and a `no-control-regex` suppression is one
	// the formatter can detach from the line it was written over
	const sgrRE = new RegExp(`${ESC}\\[([\\d;]*)m`, 'g');
	const found = new Set<number>();
	for (const [, params] of out.matchAll(sgrRE)) {
		for (const part of (params ?? '').split(';')) {
			found.add(Number(part === '' ? '0' : part));
		}
	}
	return found;
}

/** What a report comes to, as lines, with the sequences taken back off. */
function lines(
	items: readonly Diagnostic[],
	to: { env?: Record<string, string | undefined>; stream: { columns: number; isTTY: boolean } }
): string[] {
	// the width comes from `render()` rather than from `to.stream.columns`, which
	// is the thing the builder signature exists to enforce: `terminalWidth()` caps
	// at `MAX_WIDTH`, so a test that declared its own width would be asserting
	// about a layout the renderer never performed
	//
	// stripped rather than rendered at level 0, so that the *layout* of a coloured
	// render is what is being read: a sequence takes no column, and a test that
	// rendered plain to measure alignment would not be measuring the coloured one.
	// `strip()` rather than a pattern of this file's own: what a sequence is has
	// one implementation, and it is the library's
	return render((width) => diagnosticsView(items, { width }), to)
		.split('\n')
		.map(strip);
}

describe('the toolchain report', () => {
	describe('a diagnostic', () => {
		it('should lead with the location and the severity, the way every compiler does', () => {
			expect(lines([diagnostic()], PLAIN)[0]).toBe(
				'commands/build.ts:12:24: warning: something to say about it'
			);
		});

		it('should leave out a line and column nothing knew', () => {
			expect(lines([diagnostic({ column: undefined, line: undefined })], PLAIN)[0]).toBe(
				'commands/build.ts: warning: something to say about it'
			);
		});

		it('should write paths with forward slashes whatever the platform spells', () => {
			expect(lines([diagnostic({ file: 'commands\\build.ts' })], PLAIN)[0]).toContain(
				'commands/build.ts:'
			);
		});

		it('should take paths relative to the app when asked', () => {
			const out = render(
				(width) =>
					diagnosticsView([diagnostic({ file: '/app/commands/build.ts' })], {
						relativeTo: () => 'commands/build.ts',
						width,
					}),
				PLAIN
			);

			expect(out).toContain('commands/build.ts:12:24:');
		});

		it('should wrap a long message in the column it started in, not back at the margin', () => {
			// the hanging indent, which is the whole reason this is a flex row with a
			// declared width rather than a string. A message that wrapped to column
			// zero would read as a second diagnostic
			const message = 'a message long enough that it cannot possibly fit on one line of this width';
			const out = lines([diagnostic({ message })], {
				env: {},
				stream: { columns: 60, isTTY: false },
			});
			const indent = 'commands/build.ts:12:24: warning: '.length;

			expect(out.length).toBeGreaterThan(1);
			for (const line of out.slice(1)) {
				expect(line.slice(0, indent).trim()).toBe('');
				expect(line.trim()).not.toBe('');
			}
			// and nothing was lost to the wrap
			expect(out.join(' ').replaceAll(/\s+/g, ' ')).toContain(message);
		});

		it('should never break the location across a wrap', () => {
			// a location split over two lines is one nothing can jump to, which is
			// what `white-space: nowrap` on the prefix is for
			const out = lines([diagnostic({ file: 'a/very/deeply/nested/commands/build.ts' })], {
				env: {},
				stream: { columns: 50, isTTY: false },
			});

			expect(out[0]).toContain('a/very/deeply/nested/commands/build.ts:12:24:');
		});

		it('should give up on two columns when there is no room for prose', () => {
			// the same threshold help's own list uses: below it, wrapping is a word
			// per line, so the location takes the line and the message goes under it
			const out = lines([diagnostic({ message: 'several words of explanation here' })], {
				env: {},
				stream: { columns: 40, isTTY: false },
			});

			expect(out[0]).toBe('commands/build.ts:12:24: warning:');
			expect(out[1]?.startsWith('  ')).toBe(true);
			expect(out.join(' ')).toContain('several words');
		});

		it('should keep a multi-line message verbatim rather than collapsing it', () => {
			// `typecheck.ts` puts a compiler's whole output in one when it exited
			// without saying anything parseable, and the indentation is the only
			// structure such a message has -- a paragraph would collapse it
			const message = 'the checker said:\n    error TS1005\n    error TS1109';
			const out = lines([diagnostic({ message, severity: 'error' })], WIDE);

			expect(out.some((line) => line.includes('    error TS1005'))).toBe(true);
		});

		it('should colour the severity on a terminal and nowhere else', () => {
			const warned = render((width) => diagnosticsView([diagnostic()], { width }), WIDE);
			const failed = render(
				(width) => diagnosticsView([diagnostic({ severity: 'error' })], { width }),
				WIDE
			);

			// yellow and red, from the toolchain's own sheet
			expect(sgr(warned)).toContain(33);
			expect(sgr(failed)).toContain(31);
			expect(hasAnsi(render((width) => diagnosticsView([diagnostic()], { width }), PLAIN))).toBe(
				false
			);
		});

		it('should write one row per diagnostic, in the order they were found', () => {
			const out = lines(
				[
					diagnostic({ file: 'first.ts', message: 'one' }),
					diagnostic({ file: 'second.ts', message: 'two' }),
				],
				WIDE
			);

			expect(out).toHaveLength(2);
			expect(out[0]).toContain('first.ts');
			expect(out[1]).toContain('second.ts');
		});

		it('should measure the prefix as it will be drawn, not as it was given', () => {
			// a tab measures nothing and draws a space, so a path holding one leaves
			// the message column a column out -- which is the defect `table()`
			// already carries an entry for, met here through a file name
			const out = lines([diagnostic({ file: 'a\tb.ts', message: 'x'.repeat(200) })], {
				env: {},
				stream: { columns: 60, isTTY: false },
			});

			// every wrapped line fits, which is what being a column out breaks
			for (const line of out) {
				expect(stringWidth(line)).toBeLessThanOrEqual(60);
			}
			expect(out[0]).toContain('a b.ts');
		});

		it('should keep a location wider than the terminal whole rather than cutting it', () => {
			// it overflows, and that is the rule help's labels already follow: the grid
			// a string is painted into is as wide as what came out, so a name longer
			// than the terminal survives and the terminal wraps it. Truncating instead
			// would give a location nothing can jump to, which is the whole reason the
			// prefix is `nowrap` -- so this is the one place a report is deliberately
			// wider than the width it was asked for
			const location = 'a/deeply/nested/path/to/commands/build.ts:120:34:';
			const out = lines(
				[diagnostic({ column: 34, file: 'a/deeply/nested/path/to/commands/build.ts', line: 120 })],
				{
					env: {},
					stream: { columns: 24, isTTY: false },
				}
			);

			expect(out[0]).toBe(`${location} warning:`);
			expect(stringWidth(out[0] ?? '')).toBeGreaterThan(24);
		});

		it('should stay inside the width it was laid out in, cap included', () => {
			// `terminalWidth()` caps at `MAX_WIDTH`, so a wide terminal is laid out
			// narrower than it is -- and the declared message column has to come from
			// the width the render actually used. Handing `render()` a finished tree
			// let a caller declare one for 200 inside a grid laid out for 100, and
			// since the grid grows to its content what came out was a 200-column line
			// with nothing truncated and nothing to say so. The builder signature
			// makes that unrepresentable; this pins the property it was breaking
			const out = lines([diagnostic({ message: 'word '.repeat(80).trim() })], {
				env: {},
				stream: { columns: 200, isTTY: false },
			});

			expect(out.length).toBeGreaterThan(1);
			for (const line of out) {
				expect(stringWidth(line)).toBeLessThanOrEqual(MAX_WIDTH);
			}
		});

		it('should be nothing at all when there is nothing to say', () => {
			expect(render((width) => diagnosticsView([], { width }), PLAIN)).toBe('');
		});
	});

	describe('the destination', () => {
		const stdout = process.stdout as { isTTY?: boolean };
		const was = stdout.isTTY;

		afterEach(() => {
			stdout.isTTY = was;
		});

		it('should ask the stream it is going to rather than the process', () => {
			// `supportsColor()` defaults to `process.stdout` whoever is asking, so a
			// report to stderr that reached for the process styler would put
			// sequences into `sigil check 2>log.txt` while being right about stdout.
			// Nothing was wrong before the report carried colour; colouring it is
			// what makes this load-bearing
			stdout.isTTY = true;

			expect(reportLevel({ env: {}, stream: { isTTY: false } })).toBe(0);
			expect(
				hasAnsi(
					render((width) => diagnosticsView([diagnostic()], { width }), {
						env: {},
						stream: { isTTY: false },
					})
				)
			).toBe(false);
		});

		it('should take its width from the stream as well', () => {
			const narrow = render(
				(width) =>
					summaryView(['a summary long enough to have to wrap somewhere along its length'], width),
				{ env: {}, stream: { columns: 20, isTTY: false } }
			);

			for (const line of narrow.split('\n')) {
				expect(stringWidth(line)).toBeLessThanOrEqual(20);
			}
			expect(narrow.split('\n').length).toBeGreaterThan(1);
		});
	});

	describe('a summary', () => {
		it('should style its runs rather than carrying its own sequences', () => {
			// a cell grid has nowhere to put a sequence that arrived inside a string
			// -- the painter strips them -- which is why this is runs and not a
			// template literal
			const out = render(
				(width) =>
					summaryView(
						[
							{ class: 'cli-app', text: 'myapp' },
							{ class: 'cli-ok', text: 'no problems found' },
						],
						width
					),
				WIDE
			);

			expect(sgr(out)).toContain(1); // bold, from .cli-app
			expect(sgr(out)).toContain(32); // green, from .cli-ok
			expect(strip(out)).toBe('myapp no problems found');
		});
	});

	describe('the stylesheet', () => {
		it("should be the app's own vocabulary rather than the framework's", () => {
			// the toolchain is an app: it draws nothing a theme is expected to
			// restyle, so it has no business in the `sigil-*` names FRAMEWORK_CSS
			// documents
			expect(TOOLCHAIN_CSS).not.toContain('.sigil-');
			expect(TOOLCHAIN_CSS).toContain('.cli-');
		});

		it('should set no layout property, which is the rule the framework sheet keeps', () => {
			// geometry stays in props, where the code that worked it out can see it:
			// a `padding-left` from a sheet is a number the arithmetic above never
			// heard about, and `box-sizing: border-box` takes it out of a width the
			// report measured
			for (const property of ['padding', 'margin', 'width', 'height', 'flex', 'box-sizing']) {
				expect(TOOLCHAIN_CSS).not.toContain(property);
			}
		});
	});
});
