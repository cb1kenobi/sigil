import { createProgress, renderBar } from '../../src/components/progress.js';
import { createSpinner, DOTS, LINE } from '../../src/components/spinner.js';
import { table } from '../../src/components/table.js';
import { stringWidth } from '../../src/width/index.js';
import { screenSetup, setup } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The spinner, the progress bar, and the table.
 *
 * All three are element trees now, so what a test reads is the screen rather
 * than the bytes: a frame is a diff against the one before it, and the last
 * write is a handful of changed cells rather than a picture of anything. The
 * table is the exception and still reads as a string, because a string is what
 * it produces.
 *
 * The rules about not having a terminal are asserted through the recording
 * stream, because there the claim is precisely about what was *written* -- one
 * line per change rather than one per frame.
 */

/**
 * Advances the spinner's own clock and then lets the frame it asked for run.
 *
 * A tick sets a signal, which asks the renderer for a frame rather than painting
 * one: the animation says *when the state changes* and the frame loop says when
 * that reaches the screen, which is the whole point of having a frame loop. The
 * two are separate timers, and vitest does not run a timer scheduled during an
 * advance within that same advance -- so a test that only advanced the interval
 * would be reading the frame before last.
 *
 * @param ms - How far to advance the spinner's interval.
 */
function animate(ms: number): void {
	vi.advanceTimersByTime(ms);
	vi.advanceTimersToNextTimer();
}

describe('createSpinner()', () => {
	it('should draw nothing until it is started', () => {
		const ui = screenSetup();
		createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'Building' });

		expect(ui.log).to.deep.equal([]);
	});

	it('should draw a frame and the text when started', () => {
		const ui = screenSetup();
		createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'Building' }).start();

		expect(ui.frame).to.equal(`${DOTS[0]} Building`);
	});

	it('should advance a frame per interval', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			// paced at zero, so the frame the tick asks for is the frame that runs:
			// the renderer coalesces to thirty a second, and a test that advanced
			// only the spinner's own interval would be reading the frame before last
			createSpinner({
				ansi: ui.ansi,
				frameMs: 0,
				interval: 10,
				terminal: ui.terminal,
				text: 'Building',
			}).start();

			animate(10);
			expect(ui.frame).to.equal(`${DOTS[1]} Building`);

			animate(10);
			expect(ui.frame).to.equal(`${DOTS[2]} Building`);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should wrap around the frames', () => {
		vi.useFakeTimers();
		try {
			const ui = screenSetup();
			createSpinner({
				ansi: ui.ansi,
				frameMs: 0,
				frames: LINE,
				interval: 10,
				terminal: ui.terminal,
				text: 'x',
			}).start();

			animate(10 * LINE.length);

			expect(ui.frame).to.equal(`${LINE[0]} x`);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should redraw when the text changes', () => {
		const ui = screenSetup();
		const spinner = createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'One' }).start();

		spinner.text = 'Two';

		expect(ui.frame).to.equal(`${DOTS[0]} Two`);
		expect(spinner.text).to.equal('Two');
	});

	it.each([
		['succeed', '✔'],
		['fail', '✖'],
		['warn', '⚠'],
		['info', 'ℹ'],
	])('should leave a marked line behind on %s', (method, symbol) => {
		const ui = screenSetup();
		const spinner = createSpinner({
			ansi: ui.ansi,
			terminal: ui.terminal,
			text: 'Working',
		}).start();

		(spinner[method as 'succeed'] as (text?: string) => void)('Finished');

		expect(ui.log).to.contain(`${symbol} Finished`);
		expect(spinner.spinning).to.equal(false);
	});

	it('should keep the current text when settled with nothing', () => {
		const ui = screenSetup();
		createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'Working' }).start().succeed();

		expect(ui.log).to.contain('✔ Working');
	});

	it('should erase on stop, leaving nothing', () => {
		const ui = screenSetup();
		const spinner = createSpinner({
			ansi: ui.ansi,
			terminal: ui.terminal,
			text: 'Working',
		}).start();

		spinner.stop();

		expect(ui.log).to.deep.equal([]);
	});

	it('should write a line that stays, above the spinner', () => {
		const ui = screenSetup();
		const spinner = createSpinner({
			ansi: ui.ansi,
			terminal: ui.terminal,
			text: 'Building',
		}).start();

		spinner.write('compiled foo.js');

		expect(ui.log).to.deep.equal(['compiled foo.js', `${DOTS[0]} Building`]);
	});

	// a disposed renderer paints nothing ever again, so keeping it made `start()`
	// after a settle a call that set `spinning` and changed the screen not at all
	it('should start again after it has settled', () => {
		const ui = screenSetup();
		const spinner = createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'One' }).start();

		spinner.succeed('First done');
		spinner.start('Two');

		expect(spinner.spinning).to.equal(true);
		expect(ui.log).to.deep.equal(['\u2714 First done', `${DOTS[0]} Two`]);
	});

	it('should start again after it was stopped', () => {
		const ui = screenSetup();
		const spinner = createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'One' }).start();

		spinner.stop();
		spinner.start('Two');

		expect(ui.log).to.deep.equal([`${DOTS[0]} Two`]);
	});

	describe('when there is no terminal', () => {
		// a timer waking the process eighty times a second to render nothing
		it('should not start a timer', () => {
			vi.useFakeTimers();
			try {
				const { ansi, terminal } = setup({ isTTY: false });
				createSpinner({ ansi, terminal, text: 'Building' }).start();

				expect(vi.getTimerCount()).to.equal(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should write one line per text change, not per frame', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			const spinner = createSpinner({ ansi, terminal, text: 'Building' }).start();

			spinner.text = 'Building';
			spinner.text = 'Linking';
			spinner.succeed('Done');

			expect(stdout.text).to.equal('Building\nLinking\n✔ Done\n');
		});
	});
});

describe('renderBar()', () => {
	it('should fill in proportion', () => {
		expect(renderBar(0, 10, '#', '-')).to.equal('----------');
		expect(renderBar(0.5, 10, '#', '-')).to.equal('#####-----');
		expect(renderBar(1, 10, '#', '-')).to.equal('##########');
	});

	it('should clamp what is out of range', () => {
		expect(renderBar(-1, 4, '#', '-')).to.equal('----');
		expect(renderBar(2, 4, '#', '-')).to.equal('####');
		expect(renderBar(Number.NaN, 4, '#', '-')).to.equal('----');
	});

	// a bar measured in characters is twice the width it was asked for, and wraps
	it('should keep to its width when the characters are wide', () => {
		const bar = renderBar(0.5, 10, '█', '░');
		expect(stringWidth(bar)).to.equal(10);

		const wide = renderBar(0.5, 10, '🟩', '⬜');
		expect(stringWidth(wide)).to.be.lessThanOrEqual(10);
	});

	it('should always draw at least one cell', () => {
		expect(renderBar(1, 0, '#', '-')).to.equal('#');
	});
});

describe('createProgress()', () => {
	it('should draw at zero when created', () => {
		const ui = screenSetup();
		createProgress({ ansi: ui.ansi, barWidth: 10, terminal: ui.terminal, text: 'Files' });

		expect(ui.frame).to.equal(
			'Files \u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%'
		);
	});

	it('should move forward on tick', () => {
		const ui = screenSetup();
		const bar = createProgress({ ansi: ui.ansi, barWidth: 10, terminal: ui.terminal, total: 10 });

		bar.tick();
		expect(bar.current).to.equal(1);
		expect(ui.frame).to.contain('10%');

		bar.tick(4);
		expect(ui.frame).to.contain('50%');
	});

	it('should clamp to the total', () => {
		const ui = screenSetup();
		const bar = createProgress({ ansi: ui.ansi, terminal: ui.terminal, total: 5 });

		bar.tick(99);
		expect(bar.current).to.equal(5);

		bar.current = -3;
		expect(bar.current).to.equal(0);
	});

	it('should redraw when the total changes', () => {
		const ui = screenSetup();
		const bar = createProgress({ ansi: ui.ansi, barWidth: 10, terminal: ui.terminal, total: 10 });

		bar.current = 5;
		expect(ui.frame).to.contain('50%');

		bar.total = 20;
		expect(ui.frame).to.contain('25%');
	});

	it('should finish at the total on done', () => {
		const ui = screenSetup();
		const bar = createProgress({ ansi: ui.ansi, barWidth: 4, terminal: ui.terminal, total: 10 });

		bar.done('Copied');

		expect(bar.current).to.equal(10);
		expect(ui.log.join('\n')).to.contain('Copied');
		expect(ui.log.join('\n')).to.contain('100%');
	});

	it('should size the bar to the terminal when not told', () => {
		const ui = screenSetup({ columns: 60 });
		createProgress({ ansi: ui.ansi, terminal: ui.terminal });

		// a third of sixty, and the bar is the only wide run of block characters
		const bar = ui.frame.match(/[\u2591\u2588]+/)?.[0] ?? '';
		expect(stringWidth(bar)).to.equal(20);
	});

	it('should keep the bar within its bounds on a very wide terminal', () => {
		const ui = screenSetup({ columns: 400 });
		createProgress({ ansi: ui.ansi, terminal: ui.terminal });

		const bar = ui.frame.match(/[\u2591\u2588]+/)?.[0] ?? '';
		expect(stringWidth(bar)).to.equal(40);
	});

	describe('when there is no terminal', () => {
		// a bar whose last word is 90% is one the reader cannot tell from a build
		// that stopped there
		it('should say it finished whatever step divides into', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			const bar = createProgress({ ansi, step: 30, terminal, text: 'Files', total: 100 });

			for (let i = 0; i < 100; i++) {
				bar.tick();
			}

			expect(stdout.text).to.equal('Files 0%\nFiles 30%\nFiles 60%\nFiles 90%\nFiles 100%\n');
		});

		// a bar redrawn a thousand times is a thousand lines of nothing
		it('should write a line every step percent', () => {
			const { ansi, stdout, terminal } = setup({ isTTY: false });
			const bar = createProgress({ ansi, step: 25, terminal, text: 'Files', total: 100 });

			for (let i = 0; i < 100; i++) {
				bar.tick();
			}

			expect(stdout.text).to.equal('Files 0%\nFiles 25%\nFiles 50%\nFiles 75%\nFiles 100%\n');
		});
	});
});

describe('table()', () => {
	// `padCell()` was ordinary string work and a cell with a tab in it came back
	// as a string; a cell grid refuses a control character, so it threw instead
	it('should take a control character in a cell', () => {
		const tab = String.fromCharCode(9);
		const bell = String.fromCharCode(7);

		expect(
			table([
				[`a${tab}b`, 'x'],
				['c', 'y'],
			])
		).to.equal('a b  x\nc    y');
		expect(table([[`a${bell}b`]])).to.equal('ab');
	});

	// a row of a table is a line: a cell two lines tall would push every row after
	// it down and leave the column beside it looking at the wrong row
	it('should put a cell with a newline on one line', () => {
		expect(table([['a\nb', 'x']])).to.equal('a b  x');
	});

	it('should align columns to their widest cell', () => {
		const out = table([
			['a', 'one'],
			['bbb', 'two'],
		]);

		expect(out).to.equal('a    one\nbbb  two');
	});

	it('should read column names off the first row', () => {
		const { ansi } = setup();
		const out = table([{ name: 'foo', size: 1 }], { ansi });

		expect(out.split('\n')[0]).to.equal('name  size');
	});

	it('should take declared columns', () => {
		const { ansi } = setup();
		const out = table([{ a: 1, b: 2 }], {
			ansi,
			columns: [{ header: 'B', key: 'b' }],
		});

		expect(out).to.equal('B\n2');
	});

	it('should right align a column', () => {
		const { ansi } = setup();
		const out = table(
			[
				['a', '1'],
				['b', '1000'],
			],
			{ ansi, columns: [{}, { align: 'right' }] }
		);

		expect(out).to.equal('a     1\nb  1000');
	});

	it('should truncate to a maxWidth', () => {
		const { ansi } = setup();
		const out = table([['a very long cell indeed']], {
			ansi,
			columns: [{ maxWidth: 10 }],
		});

		expect(out).to.equal('a very lo…');
	});

	it('should line up columns of wide characters', () => {
		const { ansi } = setup();
		const out = table(
			[
				['日本', 'x'],
				['a', 'y'],
			],
			{ ansi }
		);

		// both second columns start at the same display column, which is what
		// lining up means -- and is not what counting characters would give
		const [first, second] = out.split('\n');
		expect(stringWidth(first.slice(0, first.indexOf('x')))).to.equal(
			stringWidth(second.slice(0, second.indexOf('y')))
		);
	});

	it('should indent and space as told', () => {
		const { ansi } = setup();
		const out = table([['a', 'b']], { ansi, gap: 4, indent: 2 });

		expect(out).to.equal('  a    b');
	});

	// trailing spaces are invisible and make a copied line longer than it shows
	it('should not pad the last column', () => {
		const { ansi } = setup();
		const out = table(
			[
				['a', 'long'],
				['b', 'x'],
			],
			{ ansi }
		);

		expect(out.split('\n')[1]).to.equal('b  x');
	});

	it('should fill in a missing cell', () => {
		const { ansi } = setup();
		const out = table([{ a: 1, b: 2 }, { a: 3 }], { ansi });

		expect(out.split('\n')[2]).to.equal('3');
	});

	it('should return nothing for no rows', () => {
		expect(table([])).to.equal('');
	});
});
