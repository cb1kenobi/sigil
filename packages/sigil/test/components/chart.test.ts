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
    expect(rows.join('\n')).not.to.match(/[⠀-⣿┤└─│]/);
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

  it('should round the bar the way the progress bar does', () => {
    // renderBar() rounds, and a gauge borrowing its arithmetic has to agree
    expect(meter(0.34, { width: 10 })).to.equal('███░░░░░░░ 34%');
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
