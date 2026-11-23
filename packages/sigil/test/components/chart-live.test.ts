import { strip } from '../../src/ansi/index.js';
import {
  BarChart,
  describeLineChart,
  Gauge,
  LineChart,
  lineChart,
  type CrosshairLineChartProps,
  type LineChartProps,
  Series,
  Sparkline,
  sparkline,
} from '../../src/components/chart.js';
import { box, type Element, renderToLines, text } from '../../src/element/index.js';
import { ESCAPE_TIMEOUT, type DescribeOptions, type InputRouter } from '../../src/input/index.js';
import { runApp, useApp } from '../../src/renderer/app.js';
import { effect, flush, State } from '../../src/signals/index.js';
import { createTestTerminal, ctrl, frame, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, describe, expect, it } from 'vitest';

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
    ).toEqual(['mem █████░░░░░░  50%']);
  });

  it('should keep the bar where it is as the percentage gains a digit', async () => {
    const value = new State(0.09);
    const root = column(undefined, Gauge({ ascii: false, value }));
    expect(picture(root, 15)).toEqual(['░░░░░░░░░░   9%']);

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

/**
 * The crosshair: a rule at the sample under the pointer, and a tooltip saying the
 * values there. The pointer is a motion report on a test terminal, through
 * `runApp()`, since what the chart follows is the router's `hover` state and the
 * report's position -- neither of which a picture of the tree has.
 */
describe('LineChart, with a crosshair (SIG-464)', () => {
  const apps: { exit(code: number): void }[] = [];
  afterEach(() => {
    for (const app of apps.splice(0)) {
      app.exit(0);
    }
  });

  /**
   * A 30-column chart at the left of a 40-column screen, so a column past it is
   * off the chart. Four samples, `fit`: the gutter is one digit and its tick, so
   * the plot starts at column 3 and the samples are at columns 3, 12, 20 and 29.
   */
  async function mount(
    chart: (input: InputRouter) => Partial<CrosshairLineChartProps>,
    opts: { motion?: boolean } = {}
  ) {
    const term = createTestTerminal({ colorLevel: 0, columns: 40, rows: 8 });
    const app = runApp(
      () => {
        const input = useApp().input as InputRouter;
        return row(
          LineChart({
            ascii: false,
            crosshair: { input },
            props: { height: 6, width: 30 },
            series: [{ data: [1, 5, 3, 8], label: 'API' }],
            step: 'fit',
            ...chart(input),
          })
        );
      },
      {
        detect: false,
        mouse: opts.motion === false ? true : { motion: true },
        terminal: term.terminal,
      }
    );
    apps.push(app);
    await frame(app);
    return {
      /** The pointer onto a cell with nothing held; an SGR report counts from one. */
      move: async (x: number, y: number) => {
        await term.press(`${ESC}[<35;${x + 1};${y + 1}M`);
        await frame(app);
        await frame(app);
      },
      screen: () => term.viewport.map((line) => line.trimEnd()),
      term,
    };
  }

  /** The column of the axis tick the crosshair puts under its sample, or -1. */
  const tick = (screen: string[]): number => (screen[4] ?? '').indexOf('┴');

  it('should draw a rule at the sample nearest the pointer, and say its value beside it', async () => {
    const m = await mount(() => ({}));
    expect(tick(m.screen())).toBe(-1);

    // column 14 is nearer the second sample, at 12, than the third, at 20
    await m.move(14, 1);
    const screen = m.screen();
    expect(tick(screen)).toBe(12);
    // the rule runs down every row of the plot that no line is drawn through
    const ruled = screen.slice(0, 4).filter((line) => /[⡇⢸]/.test(line[12] ?? ''));
    expect(ruled.length).toBeGreaterThan(0);
    expect(screen.join('\n')).toContain('│ API 5 │');
  });

  it('should keep following a pointer that has moved on onto the readout', async () => {
    // the bubble is flush against the rule, so a pointer carrying on to the right
    // is over the bubble rather than the chart -- and is still the chart's
    const m = await mount(() => ({}));
    await m.move(14, 1);
    expect(m.screen()[1]?.slice(13, 22)).toBe('│ API 5 │');

    await m.move(18, 1);
    expect(tick(m.screen())).toBe(20);
    expect(m.screen().join('\n')).toContain('│ API 3 │');
  });

  it('should take the rule and the readout away when the pointer leaves the chart', async () => {
    const m = await mount(() => ({}));
    await m.move(14, 1);
    expect(tick(m.screen())).toBe(12);

    await m.move(35, 1);
    expect(tick(m.screen())).toBe(-1);
    expect(m.screen().join('\n')).not.toContain('API 5');
  });

  it('should draw nothing while the pointer is over the axis labels', async () => {
    const m = await mount(() => ({}));
    await m.move(0, 1);
    expect(tick(m.screen())).toBe(-1);
    expect(m.screen().join('\n')).not.toContain('│ API');
  });

  it('should follow nothing without motion tracking', async () => {
    const m = await mount(() => ({}), { motion: false });
    await m.move(14, 1);
    expect(tick(m.screen())).toBe(-1);
  });

  it('should hand text the sample and every series’ value there, and show only the rule for nothing', async () => {
    const seen: [number, readonly (number | undefined)[]][] = [];
    const m = await mount((input) => ({
      crosshair: {
        input,
        text: (index, values) => {
          seen.push([index, values]);
          return index === 3 ? '' : `day ${index}`;
        },
      },
      series: [
        { data: [1, 5, 3, 8], label: 'API' },
        { data: [2, Number.NaN, 4], label: 'Web' },
      ],
    }));
    await m.move(20, 1);
    // the shorter series ends with the longer one, so its third value is under
    // the longer one's fourth, and its first is under the second
    expect(seen.at(-1)).toEqual([2, [3, undefined]]);
    expect(m.screen().join('\n')).toContain('│ day 2 │');

    await m.move(29, 1);
    expect(seen.at(-1)).toEqual([3, [8, 4]]);
    expect(tick(m.screen())).toBe(29);
    expect(m.screen().join('\n')).not.toContain('day');
  });

  it('should say what is under a still pointer when the data moves', async () => {
    const data = new State<readonly number[]>([1, 5, 3, 8]);
    const m = await mount(() => ({ series: [{ data, label: 'API' }] }));
    await m.move(14, 1);
    expect(m.screen().join('\n')).toContain('API 5');

    data.set([1, 6, 3, 8]);
    await flush();
    await m.move(14, 1);
    expect(m.screen().join('\n')).toContain('API 6');
  });

  it('should find nothing left of a scrolling chart’s history, and the newest sample under the last column', async () => {
    // a step of one puts the four samples in the last two cells, two to a cell
    const m = await mount(() => ({ step: 1 }));
    await m.move(10, 1);
    expect(tick(m.screen())).toBe(-1);
    // two samples one cell, the pointer as near one as the other: the newer, so
    // the latest -- what a scrolling chart is read for -- is under the last column
    await m.move(28, 1);
    expect(tick(m.screen())).toBe(28);
    expect(m.screen().join('\n')).toContain('│ API 5 │');
    await m.move(29, 1);
    expect(tick(m.screen())).toBe(29);
    expect(m.screen().join('\n')).toContain('│ API 8 │');
  });

  it('should read the newest sample under the last column where fit puts several in a cell', async () => {
    // ninety samples over a plot of 27 cells, 54 dot columns: several to a cell
    const seen: number[] = [];
    const m = await mount((input) => ({
      crosshair: {
        input,
        text: (index) => {
          seen.push(index);
          return `day ${index}`;
        },
      },
      series: [{ data: Array.from({ length: 90 }, (_, i) => i % 7), label: 'API' }],
    }));
    await m.move(29, 1);
    expect(seen.at(-1)).toBe(89);
    // and a cell before it the newest of its own, which is not the nearest: plot
    // cell 17 is dots 34 and 35, and 59 is the last sample at or before dot 35,
    // `round(59 * 53 / 89)`
    await m.move(20, 1);
    expect(seen.at(-1)).toBe(59);
  });

  it('should snap a column left of the first sample drawn to the nearest one that is', async () => {
    // a plot two cells wide at a step of four: rounded from the left cell, the
    // nearest sample is one before the left edge, and the next one is drawn
    const m = await mount(() => ({
      axis: false,
      legend: false,
      props: { height: 2, width: 2 },
      series: [{ data: [1, 2, 3], label: 'API' }],
      step: 4,
    }));
    await m.move(0, 0);
    expect(m.screen().join('\n')).toContain('│ API 3 │');
  });

  it('should draw a line over the rule, and the rule over a shade', async () => {
    // ASCII, where a line is `*`, a shade `:` and the rule `|`, so each cell says
    // which of the three it is
    const m = await mount(() => ({ ascii: true, fill: true }));
    const before = m
      .screen()
      .slice(0, 4)
      .map((line) => line[12]);
    expect(before).toContain('*');
    expect(before).toContain(':');

    await m.move(14, 1);
    const after = m
      .screen()
      .slice(0, 4)
      .map((line) => line[12]);
    expect(after).toEqual(before.map((cell) => (cell === '*' ? '*' : '|')));
  });

  it('should point the readout at the rule inside a border and padding', async () => {
    const m = await mount(() => ({
      props: { 'border-style': 'round', height: 8, 'padding-left': 2, width: 30 },
    }));
    await m.move(14, 2);
    const screen = m.screen();
    const at = screen.findIndex((line) => line.includes('┴'));
    const column = (screen[at] ?? '').indexOf('┴');
    // the bubble's corner is beside the rule's top, which is the plot's first row
    expect(screen[1]?.[column + 1]).toBe('╭');
    expect(screen[2]).toContain('API');
  });

  it('should stop hearing the pointer when it goes', async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const term = createTestTerminal({ colorLevel: 0, columns: 40, rows: 8 });
    const app = runApp(
      () => {
        const input = useApp().input as InputRouter;
        // the router, with its mouse subscriptions counted
        const counted = new Proxy(input, {
          get(target, key) {
            if (key === 'onMouse') {
              return (handler: Parameters<InputRouter['onMouse']>[0]) => {
                subscribed += 1;
                const off = target.onMouse(handler);
                return () => {
                  unsubscribed += 1;
                  off();
                };
              };
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return LineChart({ ascii: false, crosshair: { input: counted }, data: [1, 2, 3] });
      },
      { detect: false, mouse: { motion: true }, terminal: term.terminal }
    );
    await frame(app);
    // the chart's own, and its tooltip's
    expect(subscribed).toBe(2);
    app.exit(0);
    await app.exited;
    expect(unsubscribed).toBe(subscribed);
  });

  it('should draw the rule as | and its tick as + in ASCII', async () => {
    const m = await mount(() => ({ ascii: true }));
    await m.move(14, 1);
    const screen = m.screen();
    expect(screen[4]?.[12]).toBe('+');
    expect(screen.slice(0, 4).some((line) => line[12] === '|')).toBe(true);
  });

  it('should refuse a crosshair that is not one', () => {
    expect(() => LineChart({ crosshair: 'yes' as never, data: [1] })).toThrow(/crosshair/);
    expect(() =>
      LineChart({ crosshair: { input: {} as InputRouter, text: 'API' as never }, data: [1] })
    ).toThrow(/crosshair text/);
  });
});

/**
 * The crosshair from the keyboard: a chart that has one takes the focus, shows
 * its rule at the newest sample while it has it, and Left and Right step it from
 * sample to sample with the same readout the pointer gets.
 */
describe('LineChart, with a crosshair from the keyboard (SIG-516)', () => {
  const apps: { exit(code: number): void }[] = [];
  afterEach(() => {
    for (const app of apps.splice(0)) {
      app.exit(0);
    }
  });

  /**
   * The same four-sample, 30-column chart as the pointer's: the samples are at
   * columns 3, 12, 20 and 29, and the axis tick under the rule is on screen row 4.
   */
  async function mount(
    chart: (input: InputRouter) => Partial<CrosshairLineChartProps> = () => ({}),
    colorLevel: 0 | 1 = 0
  ) {
    const term = createTestTerminal({ colorLevel, columns: 40, rows: 8 });
    let host: Element | undefined;
    const app = runApp(
      () => {
        const input = useApp().input as InputRouter;
        return row(
          (host = LineChart({
            ascii: false,
            crosshair: { input },
            props: { height: 6, width: 30 },
            series: [{ data: [1, 5, 3, 8], label: 'API' }],
            step: 'fit',
            ...chart(input),
          }))
        );
      },
      { detect: false, mouse: { motion: true }, terminal: term.terminal }
    );
    apps.push(app);
    await frame(app);
    const settle = async () => {
      await frame(app);
      await frame(app);
    };
    return {
      app,
      blur: async () => {
        app.input?.focus.focus(undefined);
        await settle();
      },
      chart: host as Element,
      /** Keys, one at a time, as a user types them. */
      key: async (...keys: string[]) => {
        for (const key of keys) {
          await term.press(key);
          await settle();
        }
      },
      move: async (x: number, y: number) => {
        await term.press(`${ESC}[<35;${x + 1};${y + 1}M`);
        await settle();
      },
      screen: () => term.viewport.map((line) => line.trimEnd()),
      term,
    };
  }

  const tick = (screen: string[]): number => (screen[4] ?? '').indexOf('┴');

  it('should take the focus, and put the rule and the readout at the newest sample while it has it', async () => {
    const m = await mount();
    expect(m.app.input?.focus.ring()).toStrictEqual([m.chart]);
    expect(tick(m.screen())).toBe(-1);

    await m.key(KEYS.tab);
    expect(m.app.input?.focus.current.get()).toBe(m.chart);
    expect(tick(m.screen())).toBe(29);
    expect(m.screen().join('\n')).toContain('API 8');

    await m.blur();
    expect(tick(m.screen())).toBe(-1);
    expect(m.screen().join('\n')).not.toContain('API 8');
  });

  it('should step the rule between samples with Left and Right, saying what the pointer would', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.left);
    expect(tick(m.screen())).toBe(20);
    expect(m.screen().join('\n')).toContain('│ API 3 │');

    await m.key(KEYS.left);
    expect(tick(m.screen())).toBe(12);
    expect(m.screen().join('\n')).toContain('│ API 5 │');

    await m.key(KEYS.right, KEYS.right);
    expect(tick(m.screen())).toBe(29);
    expect(m.screen().join('\n')).toContain('API 8');
  });

  it('should claim an arrow at either end of the series, and leave the rule where it is', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.right, KEYS.right);
    expect(tick(m.screen())).toBe(29);
    await m.key(KEYS.left, KEYS.left, KEYS.left, KEYS.left, KEYS.left);
    expect(tick(m.screen())).toBe(3);
  });

  it('should leave Up, Down, Shift and Ctrl with an arrow, and a paste, to what is around the chart', async () => {
    const seen: string[] = [];
    const term = createTestTerminal({ colorLevel: 0, columns: 40, rows: 8 });
    const app = runApp(
      () => {
        const input = useApp().input as InputRouter;
        return box(
          { onKey: (event) => void seen.push(event.key.name) },
          LineChart({
            ascii: false,
            crosshair: { input },
            props: { height: 6, width: 30 },
            series: [{ data: [1, 5, 3, 8], label: 'API' }],
            step: 'fit',
          })
        );
      },
      { detect: false, mouse: { motion: true }, terminal: term.terminal }
    );
    apps.push(app);
    await frame(app);
    const press = async (key: string) => {
      await term.press(key);
      await frame(app);
    };
    await press(KEYS.tab);
    await press(KEYS.up);
    await press(KEYS.down);
    await press(`${ESC}[1;2D`);
    await press(`${ESC}[1;5D`);
    await press(`${ESC}[1;3D`);
    await press(`${ESC}[200~x${ESC}[201~`);
    expect(seen.slice(0, 5)).toStrictEqual(['up', 'down', 'left', 'left', 'left']);
    seen.length = 5;
    // not moved: the rule is still at the newest sample
    expect((term.viewport[4] ?? '').indexOf('┴')).toBe(29);
    // a plain Left is the chart's, and so is a Right at the newest sample, where
    // it goes nowhere
    await press(KEYS.left);
    await press(KEYS.right);
    await press(KEYS.right);
    expect(seen).toHaveLength(5);
  });

  it('should hand the keyboard sample to the pointer while it moves, and take it back when the pointer leaves', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.left);
    expect(tick(m.screen())).toBe(20);

    await m.move(14, 1);
    expect(tick(m.screen())).toBe(12);
    await m.move(35, 1);
    expect(tick(m.screen())).toBe(20);
  });

  it('should step from the sample the pointer is on, and the keyboard is the rule from then on', async () => {
    const m = await mount();
    await m.key(KEYS.tab);
    await m.move(14, 1);
    expect(tick(m.screen())).toBe(12);
    await m.key(KEYS.right);
    expect(tick(m.screen())).toBe(20);
    // the pointer, still over the chart where it was, is not what the rule follows
    await m.key(KEYS.right);
    expect(tick(m.screen())).toBe(29);
  });

  it('should step from the rule the pointer has moved to, not from where the last key left it', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.left);
    expect(tick(m.screen())).toBe(20);
    await m.move(5, 1);
    expect(tick(m.screen())).toBe(3);
    await m.key(KEYS.right);
    expect(tick(m.screen())).toBe(12);
  });

  it('should keep the rule at the keyboard sample while the pointer is over the chart where there is none', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.left);
    // the axis labels, which hold no sample: the rule is the keyboard's still, and
    // so are the keys
    await m.move(0, 1);
    expect(tick(m.screen())).toBe(20);
    expect(m.screen().join('\n')).toContain('API 3');
    await m.key(KEYS.left);
    expect(tick(m.screen())).toBe(12);
  });

  it('should take the first arrow typed before any frame has drawn the focus', async () => {
    const m = await mount();
    await m.term.press(KEYS.tab);
    await m.term.press(KEYS.left);
    await m.key();
    await frame(m.app);
    expect(tick(m.screen())).toBe(20);
  });

  it('should step on from the oldest sample when the data shrinks under a rule far back', async () => {
    const data = new State<readonly number[]>(Array.from({ length: 30 }, (_, i) => i));
    const m = await mount(() => ({ series: [{ data, label: 'API' }] }));
    await m.key(KEYS.tab);
    for (let i = 0; i < 20; i++) {
      await m.term.press(KEYS.left);
    }
    await frame(m.app);
    data.set([0, 1, 2, 3]);
    await flush();
    await frame(m.app);
    await frame(m.app);
    // drawn at the oldest, and the first Right moves it
    expect(tick(m.screen())).toBe(3);
    await m.key(KEYS.right);
    expect(tick(m.screen())).toBe(12);
  });

  it('should keep the rule on a sample the plot draws when a resize narrows it', async () => {
    // a step of four across 27 cells shows 14 of the 30 samples; narrowed to 17
    // cells it shows 9, and a rule stood on the 14th is past the left edge
    const m = await mount(() => ({
      series: [{ data: Array.from({ length: 30 }, (_, i) => i), label: 'API' }],
      step: 4,
    }));
    await m.key(KEYS.tab);
    for (let i = 0; i < 20; i++) {
      await m.term.press(KEYS.left);
    }
    await frame(m.app);
    m.term.resize(20, 8);
    await frame(m.app);
    await frame(m.app);
    const screen = m.screen();
    expect(tick(screen)).toBeGreaterThanOrEqual(0);
    const at = Number(/API (\d+)/.exec(screen.join('\n'))?.[1]);
    expect(at).toBeGreaterThanOrEqual(21);
    // and the first Right after it moves on from there, rather than from a sample
    // the narrower plot no longer draws
    await m.key(KEYS.right);
    expect(m.screen().join('\n')).toContain(`API ${at + 1}`);
  });

  it('should start at the newest sample again after the focus has gone and come back', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.left, KEYS.left);
    expect(tick(m.screen())).toBe(12);
    await m.blur();
    await m.key(KEYS.tab);
    expect(tick(m.screen())).toBe(29);
  });

  it('should keep the sample it stands on as a live series is pushed to', async () => {
    const data = new Series(20, [1, 2, 3, 4]);
    const m = await mount(() => ({ series: [{ data, label: 'API' }], step: 1 }));
    await m.key(KEYS.tab, KEYS.left);
    const at = tick(m.screen());
    expect(m.screen().join('\n')).toContain('API 3');
    data.push(9);
    await flush();
    await frame(m.app);
    await frame(m.app);
    // one sample back from the newest, which is now the 4 that was newest
    expect(m.screen().join('\n')).toContain('API 4');
    expect(tick(m.screen())).toBe(at);
  });

  it('should stop at the oldest sample a scrolling chart has drawn', async () => {
    // a step of four across 27 plot cells holds 14 samples of the 30 given
    const m = await mount(() => ({
      series: [{ data: Array.from({ length: 30 }, (_, i) => i), label: 'API' }],
      step: 4,
    }));
    await m.key(KEYS.tab);
    // pressed faster than a frame, as a held key is
    for (let i = 0; i < 40; i++) {
      await m.term.press(KEYS.left);
    }
    await frame(m.app);
    await frame(m.app);
    expect(m.screen().join('\n')).toContain('API 17');
    expect(m.screen().join('\n')).not.toContain('API 16');
    // and Right comes back one sample at a time
    await m.key(KEYS.right);
    expect(m.screen().join('\n')).toContain('API 18');
  });

  it('should step through every sample where fit puts several in a cell, as the pointer cannot', async () => {
    const seen: number[] = [];
    const m = await mount((input) => ({
      crosshair: {
        input,
        text: (index) => {
          seen.push(index);
          return `day ${index}`;
        },
      },
      series: [{ data: Array.from({ length: 90 }, (_, i) => i % 7), label: 'API' }],
    }));
    await m.key(KEYS.tab);
    expect(seen.at(-1)).toBe(89);
    await m.key(KEYS.left, KEYS.left, KEYS.left);
    expect(seen.at(-1)).toBe(86);
  });

  it('should draw the rule in the accent while the chart has the focus, and muted otherwise', async () => {
    // a warn series, so that nothing else on the screen is the accent's cyan
    const m = await mount(
      () => ({ ascii: true, series: [{ data: [1, 5, 3, 8], label: 'API', role: 'warn' }] }),
      1
    );
    /** An SGR in `text` that sets palette colour `n` (0 to 7) as a foreground. */
    const sets = (text: string, n: number) =>
      new RegExp(`\\[(?:[0-9;]*;)?${30 + n}[;m]`).test(text);
    // a pointer over it without the focus: the muted role, which is not cyan
    await m.move(14, 1);
    const hovered = m.term.output;
    expect(hovered).toContain('|');
    expect(sets(hovered, 6)).toBe(false);
    await m.key(KEYS.tab);
    // the accent is cyan, and the rule is drawn in it
    expect(sets(m.term.output.slice(hovered.length), 6)).toBe(true);
  });

  it('should take no focus and no keys with focusable: false in its props', async () => {
    const m = await mount(() => ({ props: { focusable: false, height: 6, width: 30 } }));
    expect(m.app.input?.focus.ring()).toStrictEqual([]);
    await m.key(KEYS.tab, KEYS.left);
    expect(tick(m.screen())).toBe(-1);
  });

  it('should take no focus without a crosshair', async () => {
    const term = createTestTerminal({ colorLevel: 0, columns: 40, rows: 8 });
    const app = runApp(() => row(LineChart({ ascii: false, data: [1, 2, 3] })), {
      detect: false,
      terminal: term.terminal,
    });
    apps.push(app);
    await frame(app);
    expect(app.input?.focus.ring()).toStrictEqual([]);
  });

  it('should refuse an onKey in its props, which the chart owns', () => {
    const input = {} as InputRouter;
    expect(() =>
      // the type leaves it out, which is what this directive pins; the throw is for
      // a caller the type does not reach
      // @ts-expect-error a chart with a crosshair owns `onKey`
      LineChart({ crosshair: { input }, data: [1], props: { onKey: () => {} } })
    ).toThrow(/onKey/);
    // a chart without a crosshair owns no key
    expect(() => LineChart({ data: [1], props: { onKey: () => {} } })).not.toThrow();
  });

  it('should take h and l as Left and Right with vim, and no letter without it', async () => {
    const plain = await mount();
    await plain.key(KEYS.tab, 'h');
    expect(tick(plain.screen())).toBe(29);

    const m = await mount(() => ({ vim: true }));
    await m.key(KEYS.tab, 'h');
    expect(tick(m.screen())).toBe(20);
    expect(m.screen().join('\n')).toContain('│ API 3 │');
    await m.key('h', 'h', 'h');
    expect(tick(m.screen())).toBe(3);
    await m.key('l', 'l');
    expect(tick(m.screen())).toBe(20);
    // a capital is not the letter, and Ctrl with one is the app's
    await m.key('L', ctrl('l'));
    expect(tick(m.screen())).toBe(20);
  });

  it('should refuse vim that is not a boolean, or is given with no crosshair', () => {
    const input = {} as InputRouter;
    expect(() => LineChart({ crosshair: { input }, data: [1], vim: 'yes' as never })).toThrow(
      /vim to be a boolean/
    );
    expect(() => LineChart({ data: [1], vim: true } as never)).toThrow(/vim to have a crosshair/);
  });

  it('should jump to the oldest sample with Home and the newest with End', async () => {
    const m = await mount();
    await m.key(KEYS.tab, KEYS.home);
    expect(tick(m.screen())).toBe(3);
    expect(m.screen().join('\n')).toContain('│ API 1 │');
    await m.key(KEYS.end);
    expect(tick(m.screen())).toBe(29);
    expect(m.screen().join('\n')).toContain('API 8');
    // Home from the pointer's sample is the oldest too
    await m.move(12, 2);
    expect(tick(m.screen())).toBe(12);
    await m.key(KEYS.home);
    expect(tick(m.screen())).toBe(3);
  });

  it('should take the oldest sample the plot draws for Home, where the history runs off the left', async () => {
    const series = new Series(
      100,
      Array.from({ length: 100 }, (_, i) => i)
    );
    const m = await mount(() => ({ series: [{ data: series, label: 'API' }], step: 1 }));
    await m.key(KEYS.tab, KEYS.home);
    // 26 plot columns past a two-digit gutter hold 52 samples: the oldest drawn is
    // the 49th, not the first
    expect(tick(m.screen())).toBe(4);
    expect(m.screen().join('\n')).toContain('API 48');
    await m.key(KEYS.left);
    expect(tick(m.screen())).toBe(4);
    await m.key(KEYS.end);
    expect(m.screen().join('\n')).toContain('API 99');
  });

  describe('pinning a sample', () => {
    it('should keep the rule and its readout where Enter pinned it when the focus goes elsewhere', async () => {
      const m = await mount();
      await m.key(KEYS.tab, KEYS.left, KEYS.enter);
      expect(tick(m.screen())).toBe(20);
      await m.blur();
      expect(tick(m.screen())).toBe(20);
      expect(m.screen().join('\n')).toContain('│ API 3 │');
    });

    it('should unpin on a second Enter at the same sample, and the blur then shows none', async () => {
      const m = await mount();
      await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.enter);
      expect(tick(m.screen())).toBe(20);
      await m.blur();
      expect(tick(m.screen())).toBe(-1);
      expect(m.screen().join('\n')).not.toContain('│ API');
    });

    it('should move a pin with an Enter at another sample', async () => {
      const m = await mount();
      await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.left, KEYS.enter);
      await m.blur();
      expect(tick(m.screen())).toBe(12);
      expect(m.screen().join('\n')).toContain('│ API 5 │');
    });

    it('should start a refocus at the pinned sample rather than the newest', async () => {
      const m = await mount();
      await m.key(KEYS.tab, KEYS.home, KEYS.enter, KEYS.right);
      expect(tick(m.screen())).toBe(12);
      await m.blur();
      await m.key(KEYS.tab);
      expect(tick(m.screen())).toBe(3);
      // and the pin is still where a step from it goes on from
      await m.key(KEYS.right);
      expect(tick(m.screen())).toBe(12);
    });

    it('should let the pointer have the rule while it is over the chart, and give the pin back', async () => {
      const m = await mount();
      await m.key(KEYS.tab, KEYS.home, KEYS.enter);
      await m.blur();
      await m.move(29, 2);
      expect(tick(m.screen())).toBe(29);
      await m.move(39, 7);
      expect(tick(m.screen())).toBe(3);
    });

    it('should keep a pin on the same place on the screen as samples are pushed', async () => {
      const series = new Series(8, [1, 5, 3, 8]);
      const m = await mount(() => ({ series: [{ data: series, label: 'API' }], step: 4 }));
      await m.key(KEYS.tab, KEYS.left, KEYS.enter);
      await m.blur();
      const before = tick(m.screen());
      expect(before).toBeGreaterThan(-1);
      series.push(9);
      await m.key();
      expect(tick(m.screen())).toBe(before);
    });

    it('should keep a pinned readout through Escape', async () => {
      const m = await mount();
      await m.key(KEYS.tab, KEYS.left, KEYS.enter);
      await m.blur();
      await m.key(KEYS.escape);
      // a lone Escape is held back until nothing can follow it
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 20));
      await m.key();
      expect(m.screen().join('\n')).toContain('│ API 3 │');
      await m.move(12, 2);
      expect(m.screen().join('\n')).toContain('│ API 5 │');
    });

    it("should pin the sample the pointer's rule is on, where the pointer moved last", async () => {
      const m = await mount();
      await m.key(KEYS.tab);
      await m.move(12, 2);
      await m.key(KEYS.enter);
      await m.move(39, 7);
      await m.blur();
      expect(tick(m.screen())).toBe(12);
    });

    it('should unpin from the oldest sample once the data has shrunk past the pin', async () => {
      const data = new State(Array.from({ length: 100 }, (_, i) => i));
      const m = await mount(() => ({ series: [{ data, label: 'API' }], step: 1 }));
      await m.key(KEYS.tab, KEYS.home, KEYS.enter);
      await m.blur();
      expect(tick(m.screen())).toBe(4);
      // 51 samples back is past the start of 20, so the pin is drawn on the oldest
      data.set(Array.from({ length: 20 }, (_, i) => i));
      await m.key();
      expect(tick(m.screen())).toBe(4);
      // and Enter there is Enter on the pinned sample, which unpins it
      await m.key(KEYS.tab, KEYS.enter);
      await m.blur();
      expect(tick(m.screen())).toBe(-1);
    });

    describe('the pin marker (SIG-620)', () => {
      /** The columns of the pin's marker on the axis row, and on the plot's top row. */
      const marks = (screen: string[]) => [
        (screen[4] ?? '').indexOf('▲'),
        (screen[0] ?? '').indexOf('▼'),
      ];
      /** Every segment of the chart that carries the theme hook. */
      const pinSegments = (chart: Element): Element[] =>
        chart.children.flatMap((child) => [
          ...(child.classes.includes('sigil-chart-pin') ? [child] : []),
          ...pinSegments(child),
        ]);

      it('should mark a pinned sample on the axis and the plot while the rule is elsewhere', async () => {
        const m = await mount();
        await m.key(KEYS.tab, KEYS.left, KEYS.enter);
        // the rule is on the pin, which it already marks
        expect(marks(m.screen())).toStrictEqual([-1, -1]);
        await m.key(KEYS.home);
        expect(tick(m.screen())).toBe(3);
        expect(marks(m.screen())).toStrictEqual([20, 20]);
        // and it goes under a blur, which returns the rule to the pin
        await m.blur();
        expect(marks(m.screen())).toStrictEqual([-1, -1]);
        expect(tick(m.screen())).toBe(20);
      });

      it('should show it from a pointer elsewhere, and leave it where the pointer is on the pin', async () => {
        const m = await mount();
        await m.key(KEYS.tab, KEYS.left, KEYS.enter);
        await m.blur();
        await m.move(3, 2);
        expect(marks(m.screen())).toStrictEqual([20, 20]);
        await m.move(20, 2);
        expect(marks(m.screen())).toStrictEqual([-1, -1]);
      });

      it('should take the marker away when the pin is cleared, and not bring it back elsewhere', async () => {
        const m = await mount();
        await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.end);
        expect(marks(m.screen())[0]).toBe(20);
        // Enter on another sample moves the pin: one marker, never two
        await m.key(KEYS.home, KEYS.enter, KEYS.right);
        expect(marks(m.screen())[0]).toBe(3);
        // and Enter on the pin clears it, with the rule on the pin
        await m.key(KEYS.left, KEYS.enter, KEYS.right);
        expect(marks(m.screen())).toStrictEqual([-1, -1]);
        await m.blur();
        expect(marks(m.screen()).concat(tick(m.screen()))).toStrictEqual([-1, -1, -1]);
      });

      it('should draw it in a class a theme can style, and in ASCII at colour level 0', async () => {
        const m = await mount(() => ({ ascii: true }));
        await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.home);
        const screen = m.screen();
        expect((screen[4] ?? '').indexOf('^')).toBe(20);
        expect((screen[0] ?? '').indexOf('v')).toBe(20);
        expect(pinSegments(m.chart).map((el) => el.text)).toStrictEqual(['v', '^']);
        expect(pinSegments(m.chart)[0]?.classes).toContain('sigil-warn');
      });

      it('should leave a line where it is, and mark the axis alone where a line is in the cell', async () => {
        // the newest sample is the highest, so its top cell is the line's
        const m = await mount();
        await m.key(KEYS.tab, KEYS.enter, KEYS.home);
        const screen = m.screen();
        expect((screen[4] ?? '').indexOf('▲')).toBe(29);
        expect((screen[0] ?? '').indexOf('▼')).toBe(-1);
      });

      it('should keep a marker on the same place on the screen as samples are pushed', async () => {
        const series = new Series(8, [1, 5, 3, 8]);
        const m = await mount(() => ({ series: [{ data: series, label: 'API' }], step: 4 }));
        await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.home);
        const before = marks(m.screen());
        expect(before[0]).toBeGreaterThan(-1);
        series.push(9);
        await m.key();
        expect(marks(m.screen())).toStrictEqual(before);
      });

      it('should leave the marker off where the rule is in the pin cell, although another sample', async () => {
        // fit puts seven samples in a cell, so a step to the next is the same cell
        const m = await mount(() => ({
          series: [{ data: Array.from({ length: 200 }, (_, i) => i % 7), label: 'API' }],
        }));
        await m.key(KEYS.tab, KEYS.home, KEYS.enter, KEYS.right);
        expect(tick(m.screen())).toBe(3);
        expect(marks(m.screen())[0]).toBe(-1);
        await m.key(KEYS.end);
        expect(marks(m.screen())[0]).toBe(3);
      });

      it('should keep the marker on the pinned sample when the data shrinks under it', async () => {
        const data = new State(Array.from({ length: 100 }, (_, i) => i));
        const m = await mount(() => ({ series: [{ data, label: 'API' }], step: 1 }));
        await m.key(KEYS.tab, KEYS.home, KEYS.enter, KEYS.end);
        // more than fit, so the oldest drawn is not the first sample, and the pin is
        // still the oldest drawn when it was set at Home. (The clamp to the oldest is
        // the rule's own and is reached only by a plot that narrows, which this cannot do.)
        data.set(Array.from({ length: 60 }, (_, i) => i));
        await m.key();
        // the oldest drawn is where Home puts the rule, and a marker is where it is not
        await m.blur();
        await m.key(KEYS.tab, KEYS.home);
        const oldest = tick(m.screen());
        expect(oldest).toBeGreaterThan(-1);
        await m.key(KEYS.end);
        expect(marks(m.screen())[0]).toBe(oldest);
      });

      it('should mark a pin on a chart with no axis, in the plot alone', async () => {
        const m = await mount(() => ({ axis: false, props: { height: 6, width: 30 } }));
        await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.home);
        expect(m.screen().join('\n')).toContain('▼');
        expect(m.screen().join('\n')).not.toContain('▲');
      });

      describe('the readout beside it, with no axis row to fall back on (SIG-636)', () => {
        const words = 'a readout wide';
        /** A chart with no axis, whose readout is as wide as `words` says. */
        const mountBare = (say = words, more: Partial<{ maxWidth: number; side: 'top' }> = {}) =>
          mount((input) => ({
            axis: false,
            crosshair: { input, ...more, text: () => say },
            props: { height: 6, width: 30 },
          }));

        it('should put the bubble past a pin it would cover, so the marker shows', async () => {
          const m = await mountBare();
          // the pin is the second sample, in column 10, and the rule goes back to the first
          await m.key(KEYS.tab, KEYS.home, KEYS.right, KEYS.enter, KEYS.home);
          expect(tick(m.screen())).toBe(-1);
          const top = m.screen()[0] ?? '';
          expect(top.indexOf('▼')).toBe(10);
          // and the bubble starts in the next column, rather than beside the rule
          expect(top.indexOf('╭')).toBe(11);
        });

        it('should put it past the rule where it flips, so a pin on the far side shows', async () => {
          const m = await mountBare();
          // the newest sample is the rule, with 10 columns to its right on the screen
          // and a bubble of 18, so it goes to its left -- over the pin at column 19
          await m.key(KEYS.tab, KEYS.left, KEYS.enter, KEYS.end);
          const top = m.screen()[0] ?? '';
          expect(top.indexOf('▼')).toBe(19);
          // the bubble ends before the pin, with the rule on the other side of it
          expect(top.indexOf('╮')).toBeLessThan(19);
          expect(top.indexOf('╮')).toBeGreaterThan(-1);
        });

        it('should leave the bubble against the rule where the pin is out of its reach', async () => {
          // a bubble of 6 ends at column 6, and the pin is in column 19
          const m = await mountBare('ab');
          await m.key(KEYS.tab, KEYS.home, KEYS.right, KEYS.right, KEYS.enter, KEYS.home);
          const top = m.screen()[0] ?? '';
          expect(top.indexOf('▼')).toBe(19);
          expect(top.indexOf('╭')).toBe(1);
        });

        /** Pins the third sample (column 19) with the rule at the first, and returns the top row. */
        const farPin = async (m: Awaited<ReturnType<typeof mountBare>>) => {
          await m.key(KEYS.tab, KEYS.home, KEYS.right, KEYS.right, KEYS.enter, KEYS.home);
          return m.screen();
        };

        it('should reach exactly as far as the bubble is wide, and no further', async () => {
          // 15 words make a bubble of 19, which ends in column 19, the pin's; 14 end in 18
          const wide = await farPin(await mountBare('a readout wide!'));
          expect((wide[0] ?? '').indexOf('▼')).toBe(19);
          expect((wide[0] ?? '').indexOf('╭')).toBe(20);
          const narrow = await farPin(await mountBare('a readout wide'));
          expect((narrow[0] ?? '').indexOf('╭')).toBe(1);
        });

        it('should reach as far as the widest line of a readout of several', async () => {
          // the whole string is 17 wide and the widest line 14, which does not reach column 19
          const screen = await farPin(await mountBare('a readout wide\nab'));
          expect((screen[0] ?? '').indexOf('╭')).toBe(1);
        });

        it('should reach no further than the maxWidth it wraps at', async () => {
          // the words are 30 wide and the bubble 12, so the pin 19 columns off is clear of it
          const screen = await farPin(
            await mountBare('aaaa bbbb cccc dddd eeee ffff g', { maxWidth: 12 })
          );
          expect((screen[0] ?? '').indexOf('▼')).toBe(19);
          expect((screen[0] ?? '').indexOf('╭')).toBe(1);
        });

        it('should leave a bubble above or below the plot where it was', async () => {
          const m = await mountBare(words, { side: 'top' });
          await m.key(KEYS.tab, KEYS.home, KEYS.enter, KEYS.right);
          // the pin is in column 0 and the rule in column 10, where the bubble starts
          expect(m.screen().map((line) => line.indexOf('╭'))).toContain(10);
        });

        it('should keep the bubble against the rule where a line has the pin cell, which draws no marker', async () => {
          // the newest sample is the highest, so its top cell is the line's: nothing to cover
          const m = await mountBare('a readout wide');
          await m.key(KEYS.tab, KEYS.enter, KEYS.left);
          expect((m.screen()[0] ?? '').indexOf('╮')).toBeGreaterThan(19);
        });

        it('should leave the bubble where it was with no pin to keep clear of', async () => {
          const m = await mountBare();
          await m.key(KEYS.tab, KEYS.home);
          expect((m.screen()[0] ?? '').indexOf('╭')).toBe(1);
        });
      });
    });

    it('should claim Enter, Home and End while it has the focus', async () => {
      const seen: string[] = [];
      const term = createTestTerminal({ colorLevel: 0, columns: 40, rows: 8 });
      const app = runApp(
        () => {
          const input = useApp().input as InputRouter;
          return box(
            { onKey: (event) => void seen.push(event.key.name) },
            LineChart({
              ascii: false,
              crosshair: { input },
              props: { height: 6, width: 30 },
              series: [{ data: [1, 5, 3, 8], label: 'API' }],
              step: 'fit',
            })
          );
        },
        { detect: false, mouse: { motion: true }, terminal: term.terminal }
      );
      apps.push(app);
      await frame(app);
      await term.press(KEYS.tab);
      await term.press(KEYS.enter);
      await term.press(KEYS.home);
      await term.press(KEYS.end);
      await frame(app);
      expect(seen).toStrictEqual([]);
    });
  });

  it('should leave onKey out of the props type of a chart with a crosshair, and only of that one', () => {
    const input = {} as InputRouter;
    const plain: LineChartProps = { data: [1], props: { onKey: () => {} } };
    expect(plain.props?.onKey).toBeTypeOf('function');
    const owned: LineChartProps = { crosshair: { input }, data: [1], props: { focusable: false } };
    expect(owned.props?.focusable).toBe(false);
    // @ts-expect-error a chart with a crosshair owns `onKey`
    const bad: LineChartProps = { crosshair: { input }, data: [1], props: { onKey: () => {} } };
    expect(bad.props).toBeDefined();
    // @ts-expect-error `vim` is the crosshair's letters, so a chart with none takes none
    const letters: LineChartProps = { data: [1], vim: true };
    expect(letters.vim).toBe(true);
  });

  describe('describeLineChart', () => {
    function recorder() {
      const live: { keys: string; opts: DescribeOptions }[] = [];
      const router = {
        describe(keys: string, opts: DescribeOptions) {
          const entry = { keys, opts };
          live.push(entry);
          return () => void live.splice(live.indexOf(entry), 1);
        },
      };
      return { live, router, said: () => live.map((e) => `${e.keys} ${e.opts.description}`) };
    }
    /** A chart with a crosshair, which needs a router to be built over. */
    const chart = async () => (await mount()).chart;

    it('should describe Left and Right as move, scoped to the chart', async () => {
      const { live, router, said } = recorder();
      const host = await chart();
      describeLineChart(router, host);
      expect(said()).toStrictEqual([
        'left move',
        'right move',
        'home oldest',
        'end newest',
        'enter pin',
      ]);
      expect(live.every((e) => e.opts.scope === host)).toBe(true);
    });

    it('should rank Enter above the movement keys, as a list does, which a narrow footer keeps', async () => {
      const { live, router } = recorder();
      describeLineChart(router, await chart());
      const priority = (keys: string) => live.find((e) => e.keys === keys)?.opts.priority;
      expect(priority('left')).toBe(1);
      expect(priority('home')).toBe(1);
      expect(priority('enter')).toBe(2);
    });

    it("should describe h and l on the arrows' line only for a chart that takes them", async () => {
      const { router, said } = recorder();
      describeLineChart(router, (await mount(() => ({ vim: true }))).chart);
      expect(said().slice(0, 4)).toStrictEqual(['left move', 'right move', 'h move', 'l move']);
    });

    it('should take every description back off', async () => {
      const { live, router } = recorder();
      const off = describeLineChart(router, await chart(), await chart());
      expect(live).toHaveLength(10);
      off();
      expect(live).toHaveLength(0);
    });

    it('should refuse a chart with no crosshair, and describe nothing', async () => {
      const { live, router } = recorder();
      const host = await chart();
      expect(() => describeLineChart(router, host, LineChart({ data: [1] }))).toThrow(
        'Expected an element that LineChart() returned with a crosshair'
      );
      expect(live).toHaveLength(0);
    });
  });
});
