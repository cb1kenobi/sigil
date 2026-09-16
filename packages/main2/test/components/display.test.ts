import { createProgress, renderBar } from '../../src/components/progress.js';
import { createSpinner, DOTS, LINE } from '../../src/components/spinner.js';
import { padCell, table, truncateCell } from '../../src/components/table.js';
import { stringWidth } from '../../src/width/index.js';
import { setup } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

describe('createSpinner()', () => {
	it('should draw a frame and the text when started', () => {
		const { ansi, region, stdout } = setup();

		createSpinner({ ansi, region, text: 'Building' }).start();

		expect(stdout.frame).to.equal(`${DOTS[0]} Building`);
	});

	it('should advance a frame per interval', () => {
		vi.useFakeTimers();
		try {
			const { ansi, region, stdout } = setup();
			createSpinner({ ansi, interval: 10, region, text: 'Building' }).start();

			vi.advanceTimersByTime(10);
			expect(stdout.frame).to.equal(`${DOTS[1]} Building`);

			vi.advanceTimersByTime(10);
			expect(stdout.frame).to.equal(`${DOTS[2]} Building`);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should wrap around the frames', () => {
		vi.useFakeTimers();
		try {
			const { ansi, region, stdout } = setup();
			createSpinner({ ansi, frames: LINE, interval: 10, region, text: 'x' }).start();

			vi.advanceTimersByTime(10 * LINE.length);

			expect(stdout.frame).to.equal(`${LINE[0]} x`);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should redraw when the text changes', () => {
		const { ansi, region, stdout } = setup();
		const spinner = createSpinner({ ansi, region, text: 'One' }).start();

		spinner.text = 'Two';

		expect(stdout.frame).to.equal(`${DOTS[0]} Two`);
		expect(spinner.text).to.equal('Two');
	});

	it.each([
		['succeed', '✔'],
		['fail', '✖'],
		['warn', '⚠'],
		['info', 'ℹ'],
	])('should leave a marked line behind on %s', (method, symbol) => {
		const { ansi, region, stdout } = setup();
		const spinner = createSpinner({ ansi, region, text: 'Working' }).start();

		(spinner[method as 'succeed'] as (text?: string) => void)('Finished');

		expect(stdout.text).to.contain(`${symbol} Finished`);
		expect(spinner.spinning).to.equal(false);
	});

	it('should keep the current text when settled with nothing', () => {
		const { ansi, region, stdout } = setup();
		createSpinner({ ansi, region, text: 'Working' }).start().succeed();

		expect(stdout.text).to.contain('✔ Working');
	});

	it('should erase on stop, leaving nothing', () => {
		const { ansi, region, stdout } = setup();
		const spinner = createSpinner({ ansi, region, text: 'Working' }).start();

		stdout.written.length = 0;
		spinner.stop();

		expect(stdout.text).to.equal('');
	});

	it('should write a line that stays, above the spinner', () => {
		const { ansi, region, stdout } = setup();
		const spinner = createSpinner({ ansi, region, text: 'Building' }).start();

		stdout.written.length = 0;
		spinner.write('compiled foo.js');

		expect(stdout.text).to.contain('compiled foo.js');
		expect(stdout.frame).to.equal(`${DOTS[0]} Building`);
	});

	describe('when there is no terminal', () => {
		// a timer waking the process eighty times a second to render nothing
		it('should not start a timer', () => {
			vi.useFakeTimers();
			try {
				const { ansi, region } = setup({ isTTY: false });
				createSpinner({ ansi, region, text: 'Building' }).start();

				expect(vi.getTimerCount()).to.equal(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should write one line per text change, not per frame', () => {
			const { ansi, region, stdout } = setup({ isTTY: false });
			const spinner = createSpinner({ ansi, region, text: 'Building' }).start();

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
		const { ansi, region, stdout } = setup();
		createProgress({ ansi, barWidth: 10, region, text: 'Files' });

		expect(stdout.frame).to.equal('Files ░░░░░░░░░░ 0%');
	});

	it('should move forward on tick', () => {
		const { ansi, region, stdout } = setup();
		const bar = createProgress({ ansi, barWidth: 10, region, total: 10 });

		bar.tick();
		expect(bar.current).to.equal(1);
		expect(stdout.frame).to.contain('10%');

		bar.tick(4);
		expect(stdout.frame).to.contain('50%');
	});

	it('should clamp to the total', () => {
		const { ansi, region } = setup();
		const bar = createProgress({ ansi, region, total: 5 });

		bar.tick(99);
		expect(bar.current).to.equal(5);

		bar.current = -3;
		expect(bar.current).to.equal(0);
	});

	it('should redraw when the total changes', () => {
		const { ansi, region, stdout } = setup();
		const bar = createProgress({ ansi, barWidth: 10, region, total: 10 });

		bar.current = 5;
		expect(stdout.frame).to.contain('50%');

		bar.total = 20;
		expect(stdout.frame).to.contain('25%');
	});

	it('should finish at the total on done', () => {
		const { ansi, region, stdout } = setup();
		const bar = createProgress({ ansi, barWidth: 4, region, total: 10 });

		bar.done('Copied');

		expect(bar.current).to.equal(10);
		expect(stdout.text).to.contain('Copied');
		expect(stdout.text).to.contain('100%');
	});

	it('should size the bar to the terminal when not told', () => {
		const { ansi, region, stdout } = setup({ columns: 60 });
		createProgress({ ansi, region });

		// a third of sixty, and the bar is the only wide run of block characters
		const bar = stdout.frame.match(/[░█]+/)?.[0] ?? '';
		expect(stringWidth(bar)).to.equal(20);
	});

	it('should keep the bar within its bounds on a very wide terminal', () => {
		const { ansi, region, stdout } = setup({ columns: 400 });
		createProgress({ ansi, region });

		const bar = stdout.frame.match(/[░█]+/)?.[0] ?? '';
		expect(stringWidth(bar)).to.equal(40);
	});

	describe('when there is no terminal', () => {
		// a bar redrawn a thousand times is a thousand lines of nothing
		it('should write a line every step percent', () => {
			const { ansi, region, stdout } = setup({ isTTY: false });
			const bar = createProgress({ ansi, region, step: 25, text: 'Files', total: 100 });

			for (let i = 0; i < 100; i++) {
				bar.tick();
			}

			expect(stdout.text).to.equal('Files 0%\nFiles 25%\nFiles 50%\nFiles 75%\nFiles 100%\n');
		});
	});
});

describe('padCell()', () => {
	it('should pad to a width', () => {
		expect(padCell('ab', 5)).to.equal('ab   ');
		expect(padCell('ab', 5, 'right')).to.equal('   ab');
		expect(padCell('ab', 5, 'center')).to.equal(' ab  ');
	});

	it('should leave a cell that is already wide enough', () => {
		expect(padCell('abcdef', 3)).to.equal('abcdef');
	});

	// padEnd counts UTF-16 code units, so a CJK cell comes out half a column short
	it('should pad by columns rather than characters', () => {
		expect(stringWidth(padCell('日本', 8))).to.equal(8);
		expect(stringWidth(padCell('🙂', 8))).to.equal(8);
	});
});

describe('truncateCell()', () => {
	it('should leave a cell that fits', () => {
		expect(truncateCell('abc', 5)).to.equal('abc');
	});

	it('should cut with an ellipsis', () => {
		expect(truncateCell('abcdef', 4)).to.equal('abc…');
	});

	it('should never exceed the width it was given', () => {
		for (const width of [1, 2, 3, 6]) {
			expect(stringWidth(truncateCell('abcdefghij', width))).to.be.lessThanOrEqual(width);
			expect(stringWidth(truncateCell('日本語のテキスト', width))).to.be.lessThanOrEqual(width);
		}
	});

	// slicing mid-pair leaves half a code point, and slicing before a combining
	// mark leaves it to attach to whatever follows
	it('should cut on grapheme clusters', () => {
		const cut = truncateCell('🙂🙂🙂🙂', 5);
		expect(cut).to.equal('🙂🙂…');
		// two double-width emoji and the ellipsis, which is five columns and three
		// code points -- the point being that no half pair was left behind
		expect(stringWidth(cut)).to.equal(5);
	});

	it('should return nothing for no width', () => {
		expect(truncateCell('abc', 0)).to.equal('');
	});
});

describe('table()', () => {
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
