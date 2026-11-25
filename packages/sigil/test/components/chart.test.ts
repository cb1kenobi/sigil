import { strip } from '../../src/ansi/index.js';
import {
  barChart,
  barChartView,
  type BarChartOptions,
  gauge,
  type GaugeOptions,
  gaugeView,
  lineChart,
  type LineChartOptions,
  lineChartView,
  SPARK_ASCII,
  SPARK_BLOCKS,
  sparkline,
  type SparklineOptions,
  sparklineView,
} from '../../src/components/chart.js';
import { stringWidth } from '../../src/width/index.js';
import { growthOf } from '../growth.js';
import { describe, expect, it } from 'vitest';

/**
 * Every chart here is read as the lines it prints.
 *
 * `env` is pinned to an empty one on linux so that what a developer's own `TERM`
 * says cannot decide between block characters and ASCII, and the colour level to
 * none so the lines are plain unless a test asks for colour.
 */
const plain = { colorLevel: 0 as const, env: {}, platform: 'linux' };

function spark(values: number[], opts: SparklineOptions = {}): string {
  return sparkline(values, { ...plain, ...opts });
}

function bars(data: Parameters<typeof barChart>[0], opts: BarChartOptions = {}): string[] {
  return barChart(data, { ...plain, width: 30, ...opts }).split('\n');
}

function line(values: number[], opts: LineChartOptions = {}): string[] {
  return lineChart(values, { ...plain, height: 4, width: 20, ...opts }).split('\n');
}

function meter(value: number, opts: GaugeOptions = {}): string {
  return gauge(value, { ...plain, ...opts });
}

const ESC = String.fromCharCode(0x1b);

describe('sparkline()', () => {
  it('should draw one block character per value, lowest to highest', () => {
    expect(spark([0, 1, 2, 3, 4, 5, 6, 7])).to.equal(SPARK_BLOCKS);
  });

  it('should scale to the smallest and largest value when given no bounds', () => {
    expect(spark([10, 20, 30])).to.equal('▁▅█');
  });

  it('should scale to min and max when they are given, so two charts mean the same height', () => {
    expect(spark([50], { max: 100, min: 0 })).to.equal('▅');
    expect(spark([50], { max: 1000, min: 0 })).to.equal('▁');
  });

  it('should clamp a value outside the bounds it was given', () => {
    expect(spark([-5, 500], { max: 100, min: 0 })).to.equal('▁█');
  });

  it('should leave a gap for a value that is not a number rather than the lowest block', () => {
    expect(spark([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5])).to.equal('▁ ▅ █');
  });

  it('should draw a series with no extent in the middle rather than at the bottom', () => {
    expect(spark([4, 4, 4])).to.equal('▄▄▄');
  });

  it('should keep the latest values when the series is wider than the room', () => {
    expect(spark([9, 9, 9, 1, 2, 3], { width: 3 })).to.equal('▁▅█');
  });

  it('should scale over the values it shows and not the ones it cut', () => {
    // 100 was cut off the left, so it must not flatten what is left to the floor
    expect(spark([100, 1, 2, 3], { width: 3 })).to.equal('▁▅█');
  });

  it('should print nothing for no values', () => {
    expect(spark([])).to.equal('');
  });

  it('should refuse a max under the min', () => {
    expect(() => spark([1, 2], { max: 1, min: 5 })).to.throw(RangeError, 'must not be less');
  });

  it('should draw with ASCII where the terminal cannot be trusted with blocks', () => {
    expect(spark([0, 1, 2, 3, 4, 5, 6, 7], { ascii: true })).to.equal(SPARK_ASCII);
    expect(spark([1, 2], { env: { TERM: 'linux' } })).to.equal('_#');
  });

  it('should colour the data in the accent role and write nothing at colour level 0', () => {
    expect(sparkline([1, 2, 3], { ...plain, colorLevel: 0 })).not.to.contain(ESC);
    expect(sparkline([1, 2, 3], { ...plain, colorLevel: 1 })).to.contain(ESC);
  });

  it('should leave the data in the terminal colour with role none', () => {
    expect(sparkline([1, 2, 3], { ...plain, colorLevel: 1, role: 'none' })).not.to.contain(ESC);
  });

  it('should hand back the same line through its view as through the string form', () => {
    const { element, width } = sparklineView([1, 2, 3], plain);

    expect(width).to.equal(3);
    expect(element.classes).to.include('sigil-chart-sparkline');
  });

  it('should keep a leading gap, which a text would otherwise collapse', () => {
    expect(spark([Number.NaN, 1, 2, 3])).to.equal(' ▁▅█');
  });
});

describe('barChart()', () => {
  describe('horizontal', () => {
    it('should line up the labels, the bars and the values in columns', () => {
      const rows = bars({ build: 10, test: 5, lint: 1 }, { width: 24 });

      expect(rows).to.deep.equal([
        'build ███████████████ 10',
        'test  ███████▌         5',
        'lint  █▌               1',
      ]);
    });

    it('should fill the width it was given and no more', () => {
      const rows = bars({ a: 3, bb: 2, ccc: 1 }, { width: 40 });

      for (const row of rows) {
        expect(stringWidth(row)).to.be.at.most(40);
      }
      expect(stringWidth(rows[0] as string)).to.equal(40);
    });

    it('should draw a fraction of a cell with the eighth-block that matches it', () => {
      // 4 of 8 over 8 cells is 4 whole cells
      expect(bars({ a: 4, b: 8 }, { showValues: false, width: 10 })[0]).to.equal('a ████');
      // 1 of 16 over 8 cells is half a cell
      expect(bars({ a: 1, b: 16 }, { showValues: false, width: 10 })[0]).to.equal('a ▌');
    });

    it('should draw a value above the bottom as at least an eighth of a cell', () => {
      expect(bars({ a: 0.001, b: 1000 }, { showValues: false, width: 10 })[0]).to.equal('a ▏');
    });

    it('should draw nothing for a zero', () => {
      expect(bars({ a: 0, b: 4 }, { showValues: false, width: 10 })[0]).to.equal('a');
    });

    it('should draw nothing for any bar when every value is zero', () => {
      expect(bars({ a: 0, b: 0 }, { showValues: false, width: 10 })).to.deep.equal(['a', 'b']);
    });

    it('should take the bars from a list of labelled values as well as from an object', () => {
      expect(bars([{ label: 'x', value: 2 }], { showValues: false, width: 6 })).to.deep.equal([
        'x ████',
      ]);
    });

    it('should draw a label with its escape sequences gone, as every other component does', () => {
      // SIG-242: the chart's own copy of the label rule collapsed whitespace and
      // never stripped, under a comment saying it did -- so a styled label had
      // its `ESC` dropped by the grid and `[31m` drawn in its place, and was
      // measured three columns wider than what was left. It is `labelLine()`
      // now, the note's, the badge's, the rule's and the tabs' rule
      const red = `${ESC}[31mred${ESC}[39m`;

      expect(bars({ [red]: 2, blue: 2 }, { showValues: false, width: 10 })).to.deep.equal([
        'red  █████',
        'blue █████',
      ]);
    });

    it('should cut a label to labelWidth', () => {
      const rows = bars({ 'a long label': 1 }, { labelWidth: 5, width: 20 });

      expect(rows[0]?.startsWith('a lo… ')).to.equal(true);
    });

    it('should write a value that is not a number as a dash and draw no bar for it', () => {
      expect(bars({ a: Number.NaN, b: 2 }, { width: 12 })[0]).to.equal('a          -');
    });

    it('should format a value with the function it was given', () => {
      expect(bars({ a: 1 }, { format: (n) => `${n}ms`, width: 12 })[0]).to.equal('a ██████ 1ms');
    });

    it('should round a value to two decimals', () => {
      expect(bars({ a: 1.23456 }, { width: 12 })[0]).to.contain('1.23');
    });

    it('should start at the lowest value where some are negative', () => {
      const rows = bars({ a: -2, b: 2 }, { showValues: false, width: 10 });

      expect(rows[0]).to.equal('a');
      expect(rows[1]).to.equal('b ████████');
    });

    it('should draw whole cells of # in ASCII', () => {
      expect(bars({ a: 1, b: 2 }, { ascii: true, showValues: false, width: 8 })).to.deep.equal([
        'a ###',
        'b ######',
      ]);
    });

    it('should print nothing for no data', () => {
      expect(barChart({}, plain)).to.equal('');
      expect(barChart([], plain)).to.equal('');
    });
  });

  describe('vertical', () => {
    it('should draw columns that grow upwards with the value and the label below', () => {
      const rows = bars({ aa: 4, bb: 2 }, { direction: 'vertical', height: 2 });

      expect(rows).to.deep.equal(['██', '██ ██', '4  2', 'aa bb']);
    });

    it('should draw a partial block at the top of a bar', () => {
      const rows = bars({ a: 3, b: 4 }, { direction: 'vertical', height: 2, showValues: false });

      // 3 of 4 over two rows is 12 of 16 eighths: a full row and half of the next
      expect(rows).to.deep.equal(['▄ █', '█ █', 'a b']);
    });

    it('should draw no column at all when every value is zero', () => {
      const rows = bars({ a: 0, b: 0 }, { direction: 'vertical', height: 2, showValues: false });

      expect(rows.join('\n')).to.not.match(/[\u2581-\u2588]/);
      expect(rows.at(-1)).to.equal('a b');
    });

    it('should widen a column to the widest label or value so that neither is cut', () => {
      const rows = bars({ lint: 1 }, { direction: 'vertical', height: 1 });

      expect(rows.at(-1)).to.equal('lint');
      expect(stringWidth(rows[0] as string)).to.equal(4);
    });

    it('should leave a bar its own width when barWidth is given', () => {
      const rows = bars(
        { a: 1, b: 1 },
        { barWidth: 3, direction: 'vertical', height: 1, showValues: false }
      );

      expect(rows).to.deep.equal(['███ ███', ' a   b']);
    });

    it('should space the columns by gap', () => {
      const rows = bars(
        { a: 1, b: 1 },
        { direction: 'vertical', gap: 3, height: 1, showValues: false }
      );

      expect(rows).to.deep.equal(['█   █', 'a   b']);
    });

    it('should leave the value row out with showValues false', () => {
      const rows = bars({ a: 1 }, { direction: 'vertical', height: 1, showValues: false });

      expect(rows).to.deep.equal(['█', 'a']);
    });

    it('should draw whole rows of # in ASCII', () => {
      const rows = bars(
        { a: 2, b: 1 },
        { ascii: true, direction: 'vertical', height: 2, showValues: false }
      );

      expect(rows).to.deep.equal(['#', '# #', 'a b']);
    });
  });

  // SIG-664: a vertical chart ignored `width`, so it was a column and a gap for
  // every bar -- about two cells a bar -- and 200,000 bars were 400,000 columns of
  // 8 rows of segments, which ran a main thread out of heap
  describe('vertical, fitted to its width', () => {
    const digits = (n: number, from = 0): { label: string; value: number }[] =>
      Array.from({ length: n }, (_, i) => ({ label: String(from + i), value: from + i + 1 }));

    it('should narrow the columns to fit the width, cutting what no longer fits', () => {
      const data = [1, 2, 3, 4].map((value) => ({ label: 'abcdef', value }));
      const rows = bars(data, { direction: 'vertical', height: 1, showValues: false, width: 15 });

      // four bars and three gaps are 12 cells at three apiece, and the natural six
      // would have been 27
      expect(rows).to.deep.equal(['▂▂▂ ▄▄▄ ▆▆▆ ███', 'ab… ab… ab… ab…']);
    });

    it('should show the latest bars that fit, and no more, once each is a column', () => {
      const rows = bars(digits(10), {
        direction: 'vertical',
        height: 1,
        showValues: false,
        width: 9,
      });

      // five columns and four gaps, and what is shown is the end of the list
      expect(rows).to.deep.equal(['▅ ▆ ▆ ▇ █', '5 6 7 8 9']);
    });

    it('should fit as many bars as the width has columns for, whatever the gap', () => {
      const rows = bars(digits(10), {
        direction: 'vertical',
        gap: 0,
        height: 1,
        showValues: false,
        width: 4,
      });

      expect(rows).to.deep.equal(['▆▆▇█', '6789']);
    });

    it('should keep a barWidth it was given, and drop bars to fit it', () => {
      const rows = bars(digits(5), {
        barWidth: 3,
        direction: 'vertical',
        height: 1,
        showValues: false,
        width: 11,
      });

      // three bars of three and two gaps are 11
      expect(rows).to.deep.equal(['▅▅▅ ▆▆▆ ███', ' 2   3   4']);
    });

    it('should cut a barWidth wider than the chart to the chart', () => {
      const rows = bars([{ label: 'a', value: 1 }], {
        barWidth: 9,
        direction: 'vertical',
        height: 1,
        showValues: false,
        width: 4,
      });

      expect(rows).to.deep.equal(['████', ' a']);
    });

    it('should scale over the bars it shows, as a sparkline does over its samples', () => {
      const rows = bars(
        [100, 1, 2].map((value, i) => ({ label: String(i), value })),
        { direction: 'vertical', height: 1, min: 0, showValues: false, width: 3 }
      );

      // the 100 is not shown, so the 2 is the tallest and there is no room for the
      // scale to be what an absent bar made it
      expect(rows).to.deep.equal(['▄ █', '1 2']);
    });

    it('should not widen a chart that already fits', () => {
      const rows = bars(digits(2), {
        direction: 'vertical',
        height: 1,
        showValues: false,
        width: 80,
      });

      expect(rows.map((row) => stringWidth(row))).to.deep.equal([3, 3]);
    });

    it('should take the latest keys of an object too', () => {
      const data = Object.fromEntries(digits(10).map((d) => [d.label, d.value]));
      const rows = bars(data, { direction: 'vertical', height: 1, showValues: false, width: 5 });

      expect(rows.at(-1)).to.equal('7 8 9');
    });

    it('should default to the terminal as a horizontal chart does', () => {
      const rows = barChart(
        digits(40).map((d) => ({ ...d, label: d.label.slice(-1) })),
        {
          ...plain,
          direction: 'vertical',
          env: { COLUMNS: '10' },
          height: 1,
          showValues: false,
        }
      ).split('\n');

      // ten columns with a gap between each is the latest five
      expect(rows.at(-1)).to.equal('5 6 7 8 9');
    });

    it('should not hold a chart to the 100 columns prose wraps at when the terminal has more', () => {
      const data = Array.from({ length: 36 }, (_, i) => ({ label: `m${i % 10}x`, value: i + 1 }));
      const rows = barChart(data, {
        ...plain,
        direction: 'vertical',
        env: { COLUMNS: '200' },
        height: 1,
        showValues: false,
      }).split('\n');

      // 36 columns of three and 35 gaps are 143, which fits 200 and not 100
      expect(rows.at(-1)).to.not.contain('…');
      expect(stringWidth(rows.at(-1) as string)).to.equal(36 * 3 + 35);
    });

    it('should read a barWidth that is not a width as none, as it always did', () => {
      const data = ['Jan', 'Feb', 'Mar'].map((label, i) => ({ label, value: i + 1 }));

      for (const barWidth of [0, -2, Number.NaN]) {
        expect(
          bars(data, { barWidth, direction: 'vertical', height: 1, showValues: false }).at(-1)
        ).to.equal('Jan Feb Mar');
      }
    });

    // counted rather than timed, and then compared at two sizes: the elements a
    // chart builds are the thing that ran out of heap, and they are the same at
    // 200,000 bars as at sixty
    it('should build no more elements than the width has room for, at any number of bars', () => {
      const data = Array.from({ length: 200_000 }, (_, i) => ({ label: 'x', value: i % 7 }));
      const { element, width } = barChartView(data, {
        ...plain,
        direction: 'vertical',
        height: 3,
        showValues: false,
        width: 40,
      });

      expect(width).to.be.at.most(40);
      // three rows and the labels, each of the twenty bars and nineteen gaps
      expect(element.children.length).to.equal(4);
      for (const row of element.children) {
        expect(row.children.length).to.be.at.most(39);
      }
    });

    it('should cost the same to draw 128,000 bars as 16,000, which is what fitting is', () => {
      const make = (length: number) =>
        Array.from({ length }, (_, i) => ({ label: 'x', value: i % 7 }));
      const draw = (data: ReturnType<typeof make>): unknown =>
        barChartView(data, { ...plain, direction: 'vertical', width: 40 });

      // linear in the number of bars is 8, which is what drawing every one was; a
      // chart that draws what fits reads the same at both, and 4 is half of linear
      expect(
        growthOf(draw, make(16_000), make(128_000), 8, 'vertical barChart', 1, 4)
      ).to.be.lessThan(4);
    });
  });

  // SIG-684: a horizontal chart is a row a bar, and nothing said how many rows it
  // had -- so 200,000 bars were 200,000 rows, as a vertical chart's were 400,000
  // columns before SIG-664
  describe('horizontal, fitted to its height', () => {
    const digits = (n: number, from = 0): { label: string; value: number }[] =>
      Array.from({ length: n }, (_, i) => ({ label: String(from + i), value: from + i + 1 }));

    it('should show the latest bars that fit the height, and no more', () => {
      const rows = bars(digits(10), { height: 3, showValues: false, width: 8 });

      expect(rows.map((row) => row.slice(0, 1))).to.deep.equal(['7', '8', '9']);
    });

    it('should scale over the bars shown, as a vertical chart does', () => {
      const rows = bars(
        [100, 1, 2].map((value, i) => ({ label: String(i), value })),
        { height: 2, min: 0, showValues: false, width: 6 }
      );

      // the 100 is not shown, so the 2 is the longest
      expect(rows).to.deep.equal(['1 ██', '2 ████']);
    });

    it('should take the latest keys of an object too', () => {
      const data = Object.fromEntries(digits(10).map((d) => [d.label, d.value]));
      const rows = bars(data, { height: 2, showValues: false, width: 5 });

      expect(rows.map((row) => row.slice(0, 1))).to.deep.equal(['8', '9']);
    });

    it('should draw every bar it has the rows for, as it always did', () => {
      expect(bars(digits(40), { showValues: false, width: 8 })).to.have.length(40);
      expect(bars(digits(3), { height: 9, showValues: false, width: 8 })).to.have.length(3);
    });

    it('should read a height that is not a number of rows as none', () => {
      for (const height of [0, -2, Number.NaN]) {
        expect(bars(digits(5), { height, showValues: false, width: 8 })).to.have.length(5);
      }
    });

    it('should draw no more than 1,000 rows when nothing says', () => {
      expect(bars(digits(1500), { showValues: false, width: 8 })).to.have.length(1000);
    });

    // counted rather than timed, and then compared at two sizes
    it('should build no more elements than the height has rows for, at any number of bars', () => {
      const data = Array.from({ length: 200_000 }, (_, i) => ({ label: 'x', value: i % 7 }));
      const { element } = barChartView(data, { ...plain, height: 5, width: 20 });

      expect(element.children.length).to.equal(5);
      expect(barChartView(data, { ...plain, width: 20 }).element.children.length).to.equal(1000);
    });

    it('should not ask the caller to format a bar that is not drawn', () => {
      const data = Array.from({ length: 200_000 }, (_, i) => ({ label: 'x', value: i % 7 }));
      let calls = 0;
      barChart(data, {
        ...plain,
        format: (value) => {
          calls++;
          return String(value);
        },
        height: 3,
        width: 20,
      });

      expect(calls).to.equal(3);
    });

    it('should cost the same to draw 128,000 bars as 16,000, which is what fitting is', () => {
      const make = (length: number) =>
        Array.from({ length }, (_, i) => ({ label: 'x', value: i % 7 }));
      const draw = (data: ReturnType<typeof make>): unknown =>
        barChartView(data, { ...plain, width: 40 });

      expect(
        growthOf(draw, make(16_000), make(128_000), 8, 'horizontal barChart', 1)
      ).to.be.lessThan(4);
    });
  });

  // SIG-686: a tab is drawn as a space and measured as nothing, so a `format()`
  // that wrote one drew a column more than it had made room for
  describe('a format() that returns a tab', () => {
    const tabbed = (value: number): string => `${value}\t%`;

    it('should draw a horizontal chart with the value as `5 %`, in the width it was given', () => {
      const rows = bars({ a: 5, b: 10 }, { format: tabbed, width: 14 });

      expect(rows).to.deep.equal(['a ███▌     5 %', 'b ███████ 10 %']);
      expect(barChartView({ a: 5, b: 10 }, { ...plain, format: tabbed, width: 14 }).width).to.equal(
        14
      );
    });

    it('should make a vertical column as wide as `10 %`, so neither value is cut', () => {
      const rows = bars(
        { a: 5, b: 10 },
        { direction: 'vertical', format: tabbed, height: 2, width: 14 }
      );

      expect(rows).to.deep.equal(['     ████', '████ ████', '5 %  10 %', ' a    b']);
    });

    it('should make the axis of a line chart as wide as `10 %`', () => {
      const rows = line([0, 10], { format: tabbed, height: 3, width: 12 });

      expect(rows).to.deep.equal(['10 % ┤    ⡠⠊', '     │  ⡠⠊', ' 0 % ┤⡠⠊', '     └──────']);
    });
  });

  it('should hand back a tree and the room it takes through its view', () => {
    const { element, width } = barChartView({ a: 1, b: 2 }, { ...plain, width: 12 });

    expect(width).to.equal(12);
    expect(element.classes).to.include('sigil-chart-bar');
  });
});

describe('lineChart()', () => {
  it('should draw the series in braille with the top and bottom of the scale on the axis', () => {
    const rows = line([0, 10]);

    expect(rows[0]).to.match(/^10 ┤/);
    expect(rows[3]).to.match(/^ 0 ┤/);
    expect(rows.at(-1)).to.match(/^ {2} └─+$/);
    expect(rows.join('')).to.match(/[⠁-⣿]/);
  });

  it('should rise from the bottom left to the top right for a rising series', () => {
    const rows = line([0, 1, 2, 3, 4], { axis: false, height: 4, width: 8 });
    const first = rows.findIndex((row) => /\S/.test(row.slice(0, 2)));
    const last = rows.findIndex((row) => /\S/.test(row.slice(-2)));

    expect(first).to.equal(3);
    expect(last).to.equal(0);
  });

  it('should be exactly as wide as it was asked for, axis and all', () => {
    for (const row of line([1, 5, 2, 8, 3], { width: 30 }).slice(0, 4)) {
      expect(stringWidth(row)).to.be.at.most(30);
    }
    expect(stringWidth(line([1, 5, 2, 8, 3], { width: 30 }).at(-1) as string)).to.equal(30);
  });

  it('should be as tall as height rows of plot plus the axis', () => {
    expect(line([1, 2, 3], { height: 6 })).to.have.length(7);
    expect(line([1, 2, 3], { axis: false, height: 6 })).to.have.length(6);
  });

  it('should draw no axis or labels with axis false', () => {
    const rows = line([1, 2, 3], { axis: false });

    expect(rows.join('')).not.to.contain('┤');
    expect(rows.join('')).not.to.contain('└');
  });

  it('should leave a break in the line for a value that is not a number', () => {
    const joined = line([5, 5, 5, Number.NaN, 5, 5, 5], { axis: false, height: 1, width: 8 })[0];
    const bridged = line([5, 5, 5, 5, 5, 5, 5], { axis: false, height: 1, width: 8 })[0];

    expect(joined).not.to.equal(bridged);
    expect(joined?.replaceAll(/\s/g, '')).not.to.equal('');
  });

  it('should draw a series of one repeated value as a line across the middle', () => {
    const rows = line([3, 3, 3, 3], { axis: false, height: 3, width: 6 });

    expect(rows[0]?.trim()).to.equal('');
    expect(rows[1]?.trim()).not.to.equal('');
    expect(rows[2]?.trim()).to.equal('');
  });

  it('should draw a single value as a single dot', () => {
    const rows = line([7], { axis: false, height: 2, width: 4 });

    expect(rows.join('').replaceAll(/\s/g, '')).to.have.length(1);
  });

  it('should label the first and last points under the axis', () => {
    const rows = line([1, 2], { width: 20, xLabels: ['start', 'end'] });

    expect(rows.at(-1)).to.match(/^ {3}start {7,}end$/);
  });

  it('should drop the end label where it would run into the start one', () => {
    const rows = line([1, 2], { width: 12, xLabels: ['a long start', 'the end'] });

    expect(rows.at(-1)).not.to.contain('the end');
  });

  it('should write the labels with the function it was given', () => {
    const rows = line([0, 250], { format: (n) => `${n}ms` });

    expect(rows[0]).to.match(/^250ms ┤/);
    expect(rows[3]).to.match(/^ {2}0ms ┤/);
  });

  it('should scale to min and max when they are given', () => {
    const rows = line([5], { axis: false, height: 2, max: 100, min: 0, width: 2 });

    expect(rows[0]?.trim()).to.equal('');
    expect(rows[1]?.trim()).not.to.equal('');
  });

  it('should draw with * and ASCII axes where the terminal cannot be trusted with braille', () => {
    const rows = line([0, 5, 10], { ascii: true });

    expect(rows.join('\n')).to.contain('*');
    expect(rows.join('\n')).not.to.match(/[\u2800-\u28FF┤└─│]/);
    expect(rows.at(-1)).to.match(/\+-+$/);
  });

  it('should hand back a tree and the room it takes through its view', () => {
    const { element, width } = lineChartView([1, 2, 3], { ...plain, width: 20 });

    expect(width).to.equal(20);
    expect(element.classes).to.include('sigil-chart-line');
  });

  it('should draw an empty series as an empty plot rather than throwing', () => {
    expect(() => line([])).not.to.throw();
  });
});

/**
 * `fill`: the plot under a line shaded in a screen of every other dot, which is a
 * braille cell's `⠅` -- a quarter of its dots, so the line over it is still the
 * densest thing in the plot where there is no colour to tell the two apart.
 */
describe('lineChart() with fill (SIG-464)', () => {
  /** A cell's dots, as the bits a braille character adds to U+2800. */
  const dots = (cell: string | undefined): number =>
    cell === undefined || cell === ' ' ? 0 : (cell.codePointAt(0) as number) - 0x2800;

  it('should shade under the line down to the bottom, and leave the line as it was', () => {
    const opts = { axis: false, height: 2, width: 4 };
    const filled = line([0, 4, 0], { ...opts, fill: true });
    const bare = line([0, 4, 0], opts);

    expect(filled).toEqual([' ⡰⢧', '⡰⠅⠅⢧']);
    expect(bare).toEqual([' ⡰⢣', '⡰⠁ ⢣']);
    // every dot of the line is still there, and the shade only adds to it
    for (const [y, row] of bare.entries()) {
      for (const [x, cell] of [...row].entries()) {
        expect(dots([...(filled[y] ?? '')][x]) & dots(cell)).toBe(dots(cell));
      }
    }
  });

  it('should shade nothing unless asked', () => {
    expect(line([0, 4, 0], { axis: false, height: 2, width: 4 }).join('')).not.toContain('⠅');
  });

  it('should leave the shade broken where the line is', () => {
    const rows = line([4, 4, Number.NaN, 4, 4], { axis: false, fill: true, height: 2, width: 5 });
    // the missing sample is a column with nothing in it, shade included
    expect([...(rows[1] ?? '')][2]).toBe(' ');
  });

  it('should shade with : under a * line in ASCII', () => {
    expect(line([0, 4, 0], { ascii: true, axis: false, fill: true, height: 2, width: 4 })).toEqual([
      ' **',
      '**:*',
    ]);
  });

  it('should let a series say for itself, over the chart', () => {
    const top = { data: [8, 8, 8, 8] };
    const bottom = { data: [2, 2, 2, 2], fill: false };
    const both = lineChart([top, bottom], {
      ...plain,
      axis: false,
      fill: true,
      height: 2,
      max: 8,
      min: 0,
      width: 4,
    }).split('\n');
    // the upper one shaded by the chart's fill, the lower one not by its own
    expect(both[0]).toBe('⠍⠍⠍⠍');
    expect(both[1]).toBe('⠒⠒⠒⠒');
  });

  it('should never draw a shade over a line, whichever series it belongs to', () => {
    // the upper series' shade reaches the lower line's row, and the lower line,
    // unshaded, is drawn there alone: a line beats a shade in the cell they share
    const rows = lineChart(
      [
        { data: [8, 8, 8, 8], fill: true },
        { data: [2, 2, 2, 2], role: 'error' },
      ],
      { ...plain, axis: false, height: 2, max: 8, min: 0, width: 4 }
    ).split('\n');
    expect(rows[1]).toBe('⠒⠒⠒⠒');
  });

  it('should colour the shade in its series role, and give it a class a theme can reach', () => {
    const out = lineChart([0, 4, 0], {
      ...plain,
      axis: false,
      colorLevel: 1,
      fill: true,
      height: 2,
      role: 'success',
      width: 4,
    });
    // one green run: the line and the shade under it are one role
    expect(out.split('\n')[1]).toBe(`${ESC}[32m⡰⠅⠅⢧${ESC}[0m`);

    const { element } = lineChartView([0, 4, 0], {
      ...plain,
      axis: false,
      fill: true,
      height: 2,
      width: 4,
    });
    const segments = element.children.flatMap((row) => row.children);
    const shade = segments.find((segment) => segment.classes.includes('sigil-chart-area'));
    // the cell of shade alone: the one beside it holds the line's dots too, and is the line's
    expect(shade?.text).toBe('⠅');
    expect(shade?.classes).toEqual(
      expect.arrayContaining(['sigil-chart-series-1', 'sigil-accent'])
    );
  });
});

/**
 * The scale used to be read with `Math.min(...values)` and `Math.max(...values)`,
 * which put every value on the stack as an argument and threw `RangeError:
 * Maximum call stack size exceeded` -- past about 125,000 values on a main
 * thread, which is where an app runs. A vitest worker has four times the stack
 * and survives 300,000, so a million is what fails here; the bar chart and the
 * table, which cost seconds of elements at that size, are run at 200,000 on a
 * real main thread in `data-sized.test.ts`.
 */
describe('a series longer than a call has room for arguments', () => {
  it('should draw a line chart of it, scaled to its least and greatest value', () => {
    const LONG = 1_000_000;
    const values = Array.from({ length: LONG }, (_, i) => (i === LONG - 1 ? 10 : i % 7));

    const rows = line(values);

    expect(rows[0]).to.match(/^10 ┤/);
    expect(rows[3]).to.match(/^ 0 ┤/);
  });
});

/**
 * What the scale reads off a series that is not an ordinary one. Written down
 * when the spread above became a loop, and passing before and after it: a loop
 * that read `NaN` or an empty list differently from `Math.min()` would move one
 * of these.
 */
describe('the scale of an unusual series', () => {
  const cases: Record<string, number[]> = {
    empty: [],
    equal: [3, 3, 3],
    infinite: [1, Infinity, -Infinity, 3],
    nan: [1, NaN, 3],
    negative: [-2, -1, -5],
    one: [5],
  };
  const labelled = (values: number[]) => values.map((value, i) => ({ label: `v${i}`, value }));

  it('should draw the same line chart of each', () => {
    const drawn = Object.fromEntries(
      Object.entries(cases).map(([name, values]) => [name, line(values)])
    );

    expect(drawn).to.deep.equal({
      empty: ['1 ┤', '  │', '  │', '0 ┤', '  └─────────────────'],
      equal: ['3 ┤', '  │', '  │⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉', '3 ┤', '  └─────────────────'],
      infinite: ['3 ┤                ⠈', '  │', '  │', '1 ┤⡀', '  └─────────────────'],
      nan: ['3 ┤                ⠈', '  │', '  │', '1 ┤⡀', '  └─────────────────'],
      negative: [
        '-1 ┤ ⣀⣀⠤⠤⠒⠒⠉⠑⢄',
        '   │⠉         ⠑⢄',
        '   │            ⠑⢄',
        '-5 ┤              ⠑⢄',
        '   └────────────────',
      ],
      one: ['5 ┤', '  │', '  │        ⠈', '5 ┤', '  └─────────────────'],
    });
  });

  it('should draw the same horizontal bar chart of each', () => {
    const drawn = Object.fromEntries(
      Object.entries(cases).map(([name, values]) => [name, bars(labelled(values))])
    );

    expect(drawn).to.deep.equal({
      empty: [''],
      equal: [
        'v0 █████████████████████████ 3',
        'v1 █████████████████████████ 3',
        'v2 █████████████████████████ 3',
      ],
      infinite: [
        'v0 ████████▍                 1',
        'v1                           -',
        'v2                           -',
        'v3 █████████████████████████ 3',
      ],
      nan: [
        'v0 ████████▍                 1',
        'v1                           -',
        'v2 █████████████████████████ 3',
      ],
      negative: [
        'v0 ██████████████████       -2',
        'v1 ████████████████████████ -1',
        'v2                          -5',
      ],
      one: ['v0 █████████████████████████ 5'],
    });
  });

  it('should draw the same vertical bar chart of each', () => {
    const drawn = Object.fromEntries(
      Object.entries(cases).map(([name, values]) => [
        name,
        bars(labelled(values), { direction: 'vertical', height: 3 }),
      ])
    );

    expect(drawn).to.deep.equal({
      empty: [''],
      equal: ['██ ██ ██', '██ ██ ██', '██ ██ ██', '3  3  3', 'v0 v1 v2'],
      infinite: ['         ██', '         ██', '██       ██', '1  -  -  3', 'v0 v1 v2 v3'],
      nan: ['      ██', '      ██', '██    ██', '1  -  3', 'v0 v1 v2'],
      negative: ['▂▂ ██', '██ ██', '██ ██', '-2 -1 -5', 'v0 v1 v2'],
      one: ['██', '██', '██', '5', 'v0'],
    });
  });
});

describe('gauge()', () => {
  it('should draw a bar filled to the ratio and the percentage after it', () => {
    expect(meter(0.5, { width: 10 })).to.equal('█████░░░░░ 50%');
  });

  it('should read the value against max and min', () => {
    expect(meter(512, { max: 1024, width: 10 })).to.equal(meter(0.5, { width: 10 }));
    expect(meter(15, { max: 20, min: 10, width: 10 })).to.equal(meter(0.5, { width: 10 }));
  });

  it('should put the label before the bar', () => {
    expect(meter(0, { label: 'Disk', width: 4 })).to.equal('Disk ░░░░ 0%');
  });

  it('should write the detail in place of the percentage', () => {
    expect(meter(0.5, { detail: '512 MiB / 1 GiB', width: 4 })).to.equal('██░░ 512 MiB / 1 GiB');
  });

  it('should clamp a value outside its range', () => {
    expect(meter(5, { width: 4 })).to.equal('████ 100%');
    expect(meter(-5, { width: 4 })).to.equal('░░░░ 0%');
  });

  it('should draw a thin bar with style line', () => {
    expect(meter(0.5, { style: 'line', width: 4 })).to.equal('━━── 50%');
  });

  it('should draw with ASCII where the terminal cannot be trusted with blocks', () => {
    expect(meter(0.5, { ascii: true, width: 4 })).to.equal('##-- 50%');
    expect(meter(0.5, { ascii: true, style: 'line', width: 4 })).to.equal('==-- 50%');
  });

  it('should fill the bar the way the progress bar does', () => {
    // renderBar() rounds down, and a gauge borrowing its arithmetic has to agree
    expect(meter(0.36, { width: 10 })).to.equal('███░░░░░░░ 36%');
  });

  it('should not draw a gauge full beside a figure that says 100%', () => {
    expect(meter(0.996, { width: 10 })).to.equal('█████████░ 99%');
    expect(meter(1, { width: 10 })).to.equal('██████████ 100%');
    expect(meter(7, { max: 7, width: 13 })).to.equal(`${'█'.repeat(13)} 100%`);
  });

  it('should change role at the thresholds it was given', () => {
    const at = (value: number): string =>
      gauge(value, {
        ...plain,
        colorLevel: 1,
        role: 'none',
        thresholds: { error: 0.9, warn: 0.7 },
        width: 4,
      });

    // the empty part is always dim, so the escape the test looks for is the colour's
    expect(at(0.5)).not.to.contain(`${ESC}[33m`);
    expect(at(0.5)).not.to.contain(`${ESC}[31m`);
    expect(at(0.7)).to.contain(`${ESC}[33m`);
    expect(at(0.95)).to.contain(`${ESC}[31m`);
  });

  it('should keep the empty part out of the role the filled part is drawn in', () => {
    const out = gauge(0.5, { ...plain, colorLevel: 1, role: 'success', width: 4 });

    expect(strip(out)).to.equal('██░░ 50%');
    expect(out.indexOf('██')).to.be.lessThan(out.indexOf('░░'));
  });

  it('should refuse a range with no extent', () => {
    expect(() => meter(1, { max: 5, min: 5 })).to.throw(RangeError, 'must be greater than min');
  });

  it('should draw a value that is not a number as empty', () => {
    expect(meter(Number.NaN, { width: 4 })).to.equal('░░░░ 0%');
  });

  it('should hand back a tree and the room it takes through its view', () => {
    const { element, width } = gaugeView(0.5, { ...plain, width: 4 });

    expect(width).to.equal(8);
    expect(element.classes).to.include('sigil-chart-gauge');
  });
});
