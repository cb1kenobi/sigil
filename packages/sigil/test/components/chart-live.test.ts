import { strip } from '../../src/ansi/index.js';
import {
  BarChart,
  Gauge,
  LineChart,
  lineChart,
  Series,
  Sparkline,
  sparkline,
} from '../../src/components/chart.js';
import { box, type Element, renderToLines, text } from '../../src/element/index.js';
import { effect, flush, State } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The live charts: fed from a signal, a `Series` or a function, and drawn at the
 * size the layout gave them.
 *
 * Every assertion about what is drawn is a picture, for the reason the layout
 * tests are: a failing one prints the two grids and says where each character
 * landed. `ascii: false` is passed everywhere so that the machine running this
 * cannot decide between block characters and ASCII.
 */

const ESC = String.fromCharCode(0x1b);

/** The tree as it is drawn, as rows: no colour and no trailing blanks. */
function picture(root: Element, width: number, height?: number): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, height, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** The tree as it is drawn at sixteen colours, one string per row. */
function coloured(root: Element, width: number, height?: number): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 1, height, width });
}

/** A column, which stretches what is in it across its width. */
function column(height: number | undefined, ...children: Element[]): Element {
  return box(
    { 'flex-direction': 'column', ...(height === undefined ? {} : { height }) },
    ...children
  );
}

/** A row, which sizes what is in it along its width. */
function row(...children: Element[]): Element {
  return box({ 'flex-direction': 'row' }, ...children);
}

describe('Series', () => {
  it('should keep the latest samples up to its capacity, oldest first', () => {
    const series = new Series(3, [1, 2]);
    expect(series.get()).toEqual([1, 2]);
    series.push(3, 4);
    expect(series.get()).toEqual([2, 3, 4]);
    expect(series.length).toBe(3);
    series.push(5, 6, 7, 8);
    expect(series.get()).toEqual([6, 7, 8]);
  });

  it('should read a sample from either end, as at() does', () => {
    const series = new Series(4, [1, 2, 3, 4, 5]);
    expect(series.at(0)).toBe(2);
    expect(series.at(-1)).toBe(5);
    expect(series.at(-4)).toBe(2);
    expect(series.at(4)).toBeUndefined();
    expect(series.at(-5)).toBeUndefined();
    expect(series.at(Number.NaN)).toBeUndefined();
  });

  it('should hand back one frozen array until something changes', () => {
    const series = new Series(3, [1]);
    const first = series.get();
    expect(Object.isFrozen(first)).toBe(true);
    expect(series.get()).toBe(first);
    series.push(2);
    expect(series.get()).not.toBe(first);
    expect(first).toEqual([1]);
  });

  it('should be emptied by clear()', () => {
    const series = new Series(3, [1, 2]);
    series.clear();
    expect(series.get()).toEqual([]);
    series.push(9);
    expect(series.get()).toEqual([9]);
  });

  it('should wake an effect that read it when it is pushed to or cleared', async () => {
    const series = new Series(3);
    const seen: (readonly number[])[] = [];
    const stop = effect(() => {
      seen.push(series.get());
    });

    series.push(1);
    await flush();
    series.push(2, 3);
    await flush();
    series.clear();
    await flush();
    // nothing to clear, and nothing pushed: neither is a change
    series.clear();
    series.push();
    await flush();
    stop();

    expect(seen).toEqual([[], [1], [1, 2, 3], []]);
  });

  it('should refuse a capacity that is not a whole number of samples', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Series(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('Sparkline', () => {
  it('should be as wide as the layout made it, with the latest sample at the right', () => {
    const data = new Series(30, [1, 3, 2, 5, 4, 8, 6, 7, 2, 1]);
    expect(picture(column(undefined, Sparkline({ ascii: false, data })), 16)).toEqual([
      '      ▁▃▂▅▄█▆▇▂▁',
    ]);
  });

  it('should show the latest end of a series longer than its width, scaled over what it shows', () => {
    // the 100 is off the left edge, so it is not what the shown values are scaled to
    const data = [100, 1, 2, 3, 4, 5, 6, 7, 8];
    expect(picture(column(undefined, Sparkline({ ascii: false, data })), 8)).toEqual(['▁▂▃▄▅▆▇█']);
  });

  it('should be the picture sparkline() prints, on one row as wide as the series', () => {
    const data = [3, 9, 1, 4, 7, 7, 2, 0, 5];
    expect(picture(row(Sparkline({ ascii: false, data })), 40)).toEqual([
      sparkline(data, { ascii: false, colorLevel: 0 }),
    ]);
  });

  it('should ask for a column a sample of its capacity where the layout leaves the size to it', () => {
    const data = new Series(12, [1, 2, 3]);
    const chart = Sparkline({ ascii: false, data });
    picture(row(chart, text('|')), 40);
    expect(chart.box?.width).toBe(12);
  });

  it('should take what a row leaves it with flex: 1', () => {
    const data = new Series(60, [1, 2, 3, 4]);
    expect(
      picture(
        row(text('cpu '), Sparkline({ ascii: false, data, props: { flex: 1 } }), text(' 4%')),
        20
      )
    ).toEqual(['cpu          ▁▃▆█ 4%']);
  });

  it('should grow back to what it asks for once a row that squeezed it has room again', () => {
    // the chart's rows are not what it asks the layout for: drawn in flow, a chart
    // squeezed to six columns would ask for six from then on
    const data = new Series(12, [1, 2, 3, 4, 5, 6, 7, 8]);
    const chart = Sparkline({ ascii: false, data });
    const root = row(text('cpu '), chart, text('|'));

    // the label's trailing space gives way too, which is the layout's rule for text
    expect(picture(root, 11)).toEqual(['cpu▁▂▃▅▆▇█|']);
    expect(chart.box?.width).toBe(7);
    expect(picture(root, 40)).toEqual(['cpu    ▁▂▃▄▅▆▇█|']);
    expect(chart.box?.width).toBe(12);
  });

  it('should stack the eighths into an area as tall as the layout made it', () => {
    const data = [0, 4, 8, 12, 16, 20, 24];
    expect(
      picture(column(3, Sparkline({ ascii: false, data, props: { 'flex-grow': 1 } })), 7, 3)
    ).toEqual(['     ▄█', '  ▁▅███', '▁▅█████']);
  });

  it('should leave a gap for a sample that is not a number', () => {
    expect(
      picture(column(undefined, Sparkline({ ascii: false, data: [1, Number.NaN, 3] })), 3)
    ).toEqual(['▁ █']);
  });

  it('should scale to min and max when they are given', () => {
    expect(
      picture(column(undefined, Sparkline({ ascii: false, data: [0, 50], max: 100, min: 0 })), 2)
    ).toEqual(['▁▅']);
  });

  it('should redraw when the series it reads is pushed to', async () => {
    const data = new Series(5, [1, 2, 3]);
    const root = column(undefined, Sparkline({ ascii: false, data }));
    expect(picture(root, 5)).toEqual(['  ▁▅█']);

    data.push(0, 6);
    await flush();
    expect(picture(root, 5)).toEqual(['▂▃▅▁█']);
  });

  it('should redraw when a State or a function it reads changes', async () => {
    const values = new State<readonly number[]>([1, 2]);
    const scale = new State(2);
    const fromState = Sparkline({ ascii: false, data: values });
    const fromFunction = Sparkline({
      ascii: false,
      data: () => values.get().map((v) => v * scale.get()),
      min: 0,
      max: 8,
    });
    const root = column(undefined, fromState, fromFunction);
    expect(picture(root, 2)).toEqual(['▁█', '▃▅']);

    values.set([2, 1]);
    scale.set(4);
    await flush();
    expect(picture(root, 2)).toEqual(['█▁', '█▅']);
  });

  it('should draw in ASCII where it is asked to', () => {
    expect(picture(column(undefined, Sparkline({ ascii: true, data: [0, 1, 2, 3] })), 4)).toEqual([
      '_:+#',
    ]);
  });
});

describe('LineChart', () => {
  it('should put the latest sample at the right edge, two to a cell, and scroll as it is pushed to', async () => {
    const data = new Series(20, [0, 1, 2, 3]);
    const root = column(
      undefined,
      LineChart({ ascii: false, axis: false, data, height: 1, max: 3, min: 0 })
    );
    expect(picture(root, 6)).toEqual(['    ⡠⠊']);

    data.push(3, 3);
    await flush();
    expect(picture(root, 6)).toEqual(['   ⡠⠊⠉']);
  });

  it('should be the picture lineChart() prints at the same size with step fit', () => {
    const data = [3, 4, 4, 6, 9, 14, 18, 17, 15, 12, 10, 12, 16, 21, 26, 24];
    const live = LineChart({ ascii: false, data, height: 4, step: 'fit' });
    expect(picture(column(undefined, live), 30)).toEqual(
      lineChart(data, { ascii: false, colorLevel: 0, height: 4, width: 30 })
        .split('\n')
        .map((line) => line.trimEnd())
    );
  });

  it('should give the plot the rows the axis, the x labels and the legend do not take', () => {
    const chart = LineChart({
      ascii: false,
      data: [1, 2, 3],
      props: { 'flex-grow': 1 },
      series: undefined,
      xLabels: ['then', 'now'],
    });
    const lines = picture(column(7, chart), 20, 7);
    // five plot rows, the axis and the x labels
    expect(lines).toHaveLength(7);
    expect(lines[4]).toMatch(/^1 ┤/);
    expect(lines[5]).toBe(`  └${'─'.repeat(17)}`);
    expect(lines[6]).toBe(`   then${' '.repeat(10)}now`);
  });

  it('should label a value every four rows or so on a plot tall enough to have room', () => {
    const chart = LineChart({ ascii: false, data: [0, 80], height: 9, max: 80, min: 0 });
    const gutter = picture(column(undefined, chart), 12).map((line) => line.slice(0, 4));
    expect(gutter).toEqual([
      '80 ┤',
      '   │',
      '   │',
      '   │',
      '40 ┤',
      '   │',
      '   │',
      '   │',
      ' 0 ┤',
      '   └',
    ]);
  });

  it('should draw several series, each in its own role, with a legend under the axis', () => {
    const chart = LineChart({
      ascii: false,
      height: 2,
      max: 1,
      min: 0,
      series: [
        { data: [1, 1, 1, 1], label: 'rx' },
        { data: [0, 0, 0, 0], label: 'tx' },
      ],
    });
    const root = column(undefined, chart);

    // four samples, a dot column each, at the right of an eleven-cell plot
    expect(picture(root, 14)).toEqual([
      `1 ┤${' '.repeat(9)}⠉⠉`,
      `0 ┤${' '.repeat(9)}⣀⣀`,
      `  └${'─'.repeat(11)}`,
      '   ⣿ rx  ⣿ tx',
    ]);

    const lines = coloured(root, 14);
    // the first is the chart's accent and the second the next role along, warn
    expect(lines[0]).toContain(`${ESC}[36m`);
    expect(lines[0]).not.toContain(`${ESC}[33m`);
    expect(lines[1]).toContain(`${ESC}[33m`);
    expect(lines[1]).not.toContain(`${ESC}[36m`);
    expect(lines[3]).toContain(`${ESC}[36m⣿`);
    expect(lines[3]).toContain(`${ESC}[33m⣿`);
  });

  it('should draw both lines through a cell they share, in the colour of the later one', () => {
    const series = [
      { data: [0, 1], role: 'success' as const },
      { data: [1, 0], role: 'error' as const },
    ];
    const both = LineChart({ ascii: false, axis: false, height: 1, series, step: 'fit' });
    const alone = (i: number) =>
      picture(
        column(
          undefined,
          LineChart({ ascii: false, axis: false, height: 1, series: [series[i]!], step: 'fit' })
        ),
        1
      )[0];

    const drawn = picture(column(undefined, both), 1)[0] as string;
    // the union of the two cells' dots, and the error role on top
    const union = String.fromCodePoint(
      (alone(0)!.codePointAt(0)! - 0x2800) | (alone(1)!.codePointAt(0)! - 0x2800) | 0x2800
    );
    expect(drawn).toBe(union);
    const line = coloured(column(undefined, both), 1)[0] as string;
    expect(line).toContain(`${ESC}[31m`);
    expect(line).not.toContain(`${ESC}[32m`);
  });

  it('should cut a legend that does not fit, with an ellipsis on the last entry it has room for', () => {
    const chart = LineChart({
      ascii: false,
      axis: false,
      height: 1,
      series: [
        { data: [1], label: 'received' },
        { data: [1], label: 'transmitted' },
        { data: [1], label: 'dropped' },
      ],
    });
    expect(picture(column(undefined, chart), 18)[1]).toBe('⣿ received  ⣿ tra…');
    // and one with room for no more than its ellipsis is left out
    expect(picture(column(undefined, chart), 15)[1]).toBe('⣿ received');
  });

  it('should take several series through lineChart() too', () => {
    const lines = lineChart(
      [
        { data: [0, 0], label: 'a' },
        { data: [1, 1], label: 'b' },
      ],
      { ascii: false, axis: false, colorLevel: 0, height: 1, width: 8 }
    ).split('\n');
    expect(lines).toEqual(['⣉⣉⣉⣉⣉⣉⣉⣉', '⣿ a  ⣿ b']);
  });

  it('should refuse a chart with nothing to draw, and a step that is not a whole number of dots', () => {
    expect(() => LineChart({ ascii: false })).toThrow(TypeError);
    expect(() => LineChart({ ascii: false, data: [1], step: 0 })).toThrow(RangeError);
    expect(() => LineChart({ ascii: false, data: [1], step: 1.5 })).toThrow(RangeError);
  });
});

describe('BarChart', () => {
  it('should give the bars the width the labels and the values leave', async () => {
    const data = new State<Record<string, number>>({ build: 12, lint: 2, test: 7 });
    const root = column(undefined, BarChart({ ascii: false, data }));
    expect(picture(root, 20)).toEqual([
      'build ███████████ 12',
      'lint  █▉           2',
      'test  ██████▍      7',
    ]);

    data.set({ build: 12, lint: 12, test: 12 });
    await flush();
    expect(picture(root, 20)).toEqual([
      'build ███████████ 12',
      'lint  ███████████ 12',
      'test  ███████████ 12',
    ]);
  });

  it('should share the width out between vertical bars and give them the rows the labels leave', () => {
    const chart = BarChart({
      ascii: false,
      data: { a: 4, b: 2 },
      direction: 'vertical',
      props: { 'flex-grow': 1 },
    });
    expect(picture(column(4, chart), 7, 4)).toEqual(['███', '███ ███', ' 4   2', ' a   b']);
  });

  it('should draw a bar in the role it names over the chart’s', () => {
    const chart = BarChart({
      ascii: false,
      data: [
        { label: 'ok', value: 1 },
        { label: 'bad', role: 'error', value: 1 },
      ],
    });
    const lines = coloured(column(undefined, chart), 12);
    expect(lines[0]).toContain(`${ESC}[36m`);
    expect(lines[1]).toContain(`${ESC}[31m`);
  });
});

describe('Gauge', () => {
  it('should give the bar the width its label and its figure leave', () => {
    expect(
      picture(column(undefined, Gauge({ ascii: false, label: 'mem', value: 0.5 })), 20)
    ).toEqual(['mem ██████░░░░░  50%']);
  });

  it('should keep the bar where it is as the percentage gains a digit', async () => {
    const value = new State(0.09);
    const root = column(undefined, Gauge({ ascii: false, value }));
    expect(picture(root, 15)).toEqual(['█░░░░░░░░░   9%']);

    value.set(0.1);
    await flush();
    expect(picture(root, 15)).toEqual(['█░░░░░░░░░  10%']);
  });

  it('should change role at a threshold as the value it reads moves', async () => {
    const value = new State(0.5);
    const root = column(
      undefined,
      Gauge({ ascii: false, role: 'none', thresholds: { error: 0.9 }, value })
    );
    expect(coloured(root, 12)[0]).not.toContain(`${ESC}[31m`);
    value.set(0.95);
    await flush();
    expect(coloured(root, 12)[0]).toContain(`${ESC}[31m`);
  });

  it('should refuse a range with no extent where it is built', () => {
    expect(() => Gauge({ max: 1, min: 1, value: 1 })).toThrow(RangeError);
  });
});

describe('a live chart’s host', () => {
  it('should refuse an onResize in its props, which is the chart’s', () => {
    expect(() => Sparkline({ data: [1], props: { onResize: () => false } as never })).toThrow(
      /onResize/
    );
  });

  it('should keep an app’s classes beside its own', () => {
    const chart = Gauge({ class: 'cpu wide', value: 0.5 });
    expect(chart.classes).toEqual(
      expect.arrayContaining(['sigil-chart', 'sigil-chart-gauge', 'cpu', 'wide'])
    );
  });

  it('should leave a row that did not change as it was', async () => {
    const data = new Series(10, [1, 2, 3]);
    const chart = LineChart({ ascii: false, data, height: 2, xLabels: ['then', 'now'] });
    const root = column(undefined, chart);
    picture(root, 20);
    const labels = () => chart.children[1]?.children.at(-1)?.children[0];
    const before = labels();
    expect(before?.text).toContain('then');

    data.push(4);
    await flush();
    picture(root, 20);
    expect(labels()).toBe(before);
  });
});
