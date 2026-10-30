/**
 * Charts: a sparkline, a bar chart, a braille line chart and a gauge.
 *
 * All four are pure functions from numbers to a block of text, drawn as an element
 * tree and printed with `renderToString()` the way `table()` and `note()` are, so
 * the colour is a theme role and a theme can restyle every chart at once. None of
 * them has a live form: a chart of a series that changes is a chart the app
 * rebuilds, and `chartView()`'s trees are what it puts inside its own.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import { Dots } from '../canvas/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { terminalWidth, truncate } from '../wrap/index.js';
import { unicodeSupported } from './note.js';
import { renderBar } from './progress.js';

/** Which role a chart takes its colour from. `none` is the terminal's own foreground. */
export type ChartRole = 'accent' | 'error' | 'info' | 'none' | 'success' | 'warn';

export interface ChartOptions extends StyledOptions {
  /**
   * Draw with ASCII only. Defaults to what `unicodeSupported()` says of `env` and
   * `platform`, since block elements and braille are not safe where box drawing is
   * not.
   */
  ascii?: boolean;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** Which role colours the data. Defaults to `accent`. */
  role?: ChartRole;
}

export interface ScaleOptions {
  /** The value drawn as the top. Defaults to the largest value. */
  max?: number;
  /** The value drawn as the bottom. Defaults to the smallest value. */
  min?: number;
}

export interface SparklineOptions extends ChartOptions, ScaleOptions {
  /**
   * The most columns to draw. A longer series is cut to its **latest** values,
   * since a sparkline is a trend and the end of it is the part that is news.
   */
  width?: number;
}

export interface BarDatum {
  /** What the bar is. */
  label: string;
  /** How long the bar is. */
  value: number;
}

/** Bars, as a list or as an object whose keys are the labels. */
export type BarData = readonly BarDatum[] | Readonly<Record<string, number>>;

export interface BarChartOptions extends ChartOptions, ScaleOptions {
  /**
   * The width of a vertical bar, and so of its column. Defaults to the widest
   * label or value, so that neither is cut.
   */
  barWidth?: number;
  /** How a number is written. Defaults to at most two decimals. */
  format?: (value: number) => string;
  /** The columns between one vertical bar and the next. Defaults to 1. */
  gap?: number;
  /** How tall a vertical chart is, in rows. Defaults to 8. */
  height?: number;
  /** The widest a label may be before it is cut. Defaults to its own width. */
  labelWidth?: number;
  /** Whether to write each value. Defaults to true. */
  showValues?: boolean;
  /** `horizontal` bars grow rightwards, `vertical` upwards. Defaults to `horizontal`. */
  direction?: 'horizontal' | 'vertical';
  /** The widest a horizontal chart may be. Defaults to `terminalWidth()`. */
  width?: number;
}

export interface LineChartOptions extends ChartOptions, ScaleOptions {
  /** Whether to draw the value labels and the axes. Defaults to true. */
  axis?: boolean;
  /** How a number is written. Defaults to at most two decimals. */
  format?: (value: number) => string;
  /** How tall the plot is, in rows. Defaults to 8. */
  height?: number;
  /** The widest the whole chart may be. Defaults to `terminalWidth()`. */
  width?: number;
  /** What the first and last points are, set under the axis. */
  xLabels?: readonly [string, string];
}

export interface GaugeOptions extends ChartOptions, ScaleOptions {
  /** A figure to write in place of the percentage, such as `512 MiB / 1 GiB`. */
  detail?: string;
  /** A label before the bar. */
  label?: string;
  /** `block` is a bar like `progress()`'s; `line` is a thin one. Defaults to `block`. */
  style?: 'block' | 'line';
  /**
   * The ratios at which the bar changes role. A ratio at or over `warn` is drawn
   * in `warn` and at or over `error` in `error`; neither is set by default.
   */
  thresholds?: { error?: number; warn?: number };
  /** How wide the bar itself is. Defaults to 20. */
  width?: number;
}

/** A run of one role, and the unit a chart is built out of. */
interface Segment {
  readonly role?: string;
  readonly text: string;
}

type Row = readonly Segment[];

/** What a chart draws: its rows, and how wide the widest is. */
interface Drawing {
  readonly kind: string;
  readonly rows: readonly Row[];
}

/** The element tree for a chart, and the room it was drawn for. */
export interface ChartView {
  readonly element: Element;
  readonly width: number;
}

/** Eight heights, lowest first. */
export const SPARK_BLOCKS = '▁▂▃▄▅▆▇█';

/** The same eight for a terminal that cannot be trusted with block elements. */
export const SPARK_ASCII = '_.:-=+*#';

/** One to seven eighths of a cell, filling from the left. */
const EIGHTHS_ACROSS = '▏▎▍▌▋▊▉';

/** The default height, in rows, of a plot. */
const DEFAULT_HEIGHT = 8;

const ROLES: Record<ChartRole, string | undefined> = {
  accent: 'sigil-accent',
  error: 'sigil-error',
  info: 'sigil-info',
  none: undefined,
  success: 'sigil-success',
  warn: 'sigil-warn',
};

/**
 * @param value - Anything.
 * @returns Whether it is a number a chart can place.
 */
function isPlottable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The bounds of a scale.
 *
 * Only a bound the caller did not give is read off the data. A series with nothing
 * plottable in it scales over 0 to 1, which is arbitrary and harmless: nothing is
 * drawn against it. A series entirely above or below a bound the caller gave
 * leaves the other bound on the wrong side of it, and that is flattened onto the
 * given one rather than inverted.
 *
 * @param values - What is being drawn.
 * @param opts - The bounds the caller gave.
 * @returns The bottom and the top.
 */
function bounds(values: readonly unknown[], opts: ScaleOptions): [number, number] {
  const given = (n: number | undefined): n is number => isPlottable(n);

  if (given(opts.min) && given(opts.max) && opts.max < opts.min) {
    throw new RangeError(`max (${opts.max}) must not be less than min (${opts.min})`);
  }

  const found = values.filter(isPlottable);
  const low = given(opts.min) ? opts.min : found.length > 0 ? Math.min(...found) : 0;
  const high = given(opts.max) ? opts.max : found.length > 0 ? Math.max(...found) : 1;

  return [low, Math.max(low, high)];
}

/**
 * Where a value falls on a scale.
 *
 * A scale with no extent, such as a series of one repeated value, puts everything
 * in the middle: a flat line is a line, and bottom would read as nothing there.
 *
 * @param value - The value.
 * @param low - The bottom of the scale.
 * @param high - The top of the scale.
 * @returns A ratio from 0 to 1.
 */
function ratioOf(value: number, low: number, high: number): number {
  if (high === low) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/**
 * Where a bar's value sits on its scale: `ratioOf()`, except that a scale with no
 * extent draws nothing rather than half a bar.
 *
 * A bar is a length from a baseline, so with every value equal to that baseline
 * -- all zeros, which is an idle period or a count of no errors -- there is
 * nothing to draw, and the mid-scale answer `ratioOf()` gives a flat line would
 * show activity that is not there.
 *
 * @param value - The value.
 * @param low - The bottom of the scale.
 * @param high - The top of the scale.
 * @returns A ratio from 0 to 1.
 */
function barRatioOf(value: number, low: number, high: number): number {
  return high === low ? 0 : ratioOf(value, low, high);
}

/**
 * A number as a chart writes it: whole, or to at most two decimals.
 *
 * @param value - The number.
 * @returns The text.
 */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * @param opts - The chart's options.
 * @returns Whether to draw with ASCII.
 */
function asciiOnly(opts: ChartOptions): boolean {
  return opts.ascii ?? !unicodeSupported(opts.env, opts.platform);
}

/**
 * @param opts - The chart's options.
 * @returns The class a segment of data takes, if it takes one.
 */
function roleOf(opts: ChartOptions): string | undefined {
  return ROLES[opts.role ?? 'accent'];
}

/**
 * Pads a string out to a number of columns.
 *
 * @param value - The string.
 * @param width - The columns to fill.
 * @param side - Which side the string sits on.
 * @returns The padded string.
 */
function pad(value: string, width: number, side: 'center' | 'left' | 'right' = 'left'): string {
  const room = Math.max(0, width - stringWidth(value));

  if (side === 'right') {
    return ' '.repeat(room) + value;
  }

  if (side === 'center') {
    const before = Math.floor(room / 2);
    return ' '.repeat(before) + value + ' '.repeat(room - before);
  }

  return value + ' '.repeat(room);
}

/**
 * A positive whole number from a setting, or the default.
 *
 * @param value - What the caller gave.
 * @param fallback - What to use when that is nothing.
 * @returns The count.
 */
function count(value: number | undefined, fallback: number): number {
  return isPlottable(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * A drawing as an element tree.
 *
 * Every segment is `white-space: pre` and unshrinkable, because the chart has
 * already been fitted to its width and a gap is part of the data: a sparkline's
 * missing sample is a space, and a layout that collapsed it would close the gap.
 *
 * @param drawing - The rows.
 * @returns The tree.
 */
function viewOf(drawing: Drawing): ChartView {
  const width = Math.max(
    1,
    ...drawing.rows.map((row) => stringWidth(row.map((s) => s.text).join('')))
  );

  const rows = drawing.rows.map((row) => {
    // a row with nothing in it is a box with no height, and a blank row inside a
    // chart is a row
    const segments = row.filter((segment) => segment.text !== '');
    const nodes = (segments.length > 0 ? segments : [{ text: ' ' } as Segment]).map((segment) =>
      textNode(segment.text, {
        class: `sigil-chart-${drawing.kind}-part${segment.role ? ` ${segment.role}` : ''}`,
        'flex-shrink': 0,
        // a text drops the whitespace at the end of its last line, so a segment of
        // padding is nothing at all unless it is given the room it stands for
        width: stringWidth(segment.text),
        'white-space': 'pre',
      })
    );

    return box({ class: `sigil-chart-${drawing.kind}-row` }, ...nodes);
  });

  return {
    element: box(
      { class: `sigil-chart sigil-chart-${drawing.kind}`, 'flex-direction': 'column' },
      ...rows
    ),
    width,
  };
}

/**
 * A drawing as the lines it prints.
 *
 * @param drawing - The rows.
 * @param opts - The colour to draw at.
 * @returns The chart, with no trailing newline.
 */
function print(drawing: Drawing, opts: ChartOptions): string {
  const { element, width } = viewOf(drawing);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  });
}

/**
 * The text of a sparkline.
 *
 * @param values - The series.
 * @param opts - The width and the scale.
 * @returns The characters, one per value.
 */
function sparkText(values: readonly number[], opts: SparklineOptions): string {
  const limit = opts.width === undefined ? values.length : count(opts.width, values.length);
  const shown = values.length > limit ? values.slice(values.length - limit) : values;
  const glyphs = asciiOnly(opts) ? SPARK_ASCII : SPARK_BLOCKS;
  const [low, high] = bounds(shown, opts);

  return shown
    .map((value) => {
      // a missing sample is a gap, not the lowest bar: zero and nothing are
      // different answers and a trend line should not blur them
      if (!isPlottable(value)) {
        return ' ';
      }

      // a series with no extent sits on the fourth glyph, the middle of eight
      return glyphs[high === low ? 3 : Math.round(ratioOf(value, low, high) * 7)] as string;
    })
    .join('');
}

/**
 * Builds the element tree for a sparkline.
 *
 * @param values - The series. A value that is not a finite number is a gap.
 * @param opts - The width, the scale and the role.
 * @returns The tree, and the room it takes.
 */
export function sparklineView(values: readonly number[], opts: SparklineOptions = {}): ChartView {
  return viewOf({
    kind: 'sparkline',
    rows: [[{ role: roleOf(opts), text: sparkText(values, opts) }]],
  });
}

/**
 * A series as a row of block characters, each as tall as its value.
 *
 * Eight heights, so it is a trend and not a measurement: reading a number off a
 * sparkline is what `barChart()` is for. It is one line, which is the point -- a
 * latency trend beside a command's name in a status line.
 *
 * A `NaN` or a missing sample is a space. The scale is the shown values' own
 * unless `min` and `max` are given, and an app that draws several wants them
 * given so that two charts mean the same height.
 *
 * @param values - The series.
 * @param opts - The width, the scale and the role.
 * @returns The line, with no trailing newline.
 */
export function sparkline(values: readonly number[], opts: SparklineOptions = {}): string {
  return print(
    {
      kind: 'sparkline',
      rows: [[{ role: roleOf(opts), text: sparkText(values, opts) }]],
    },
    opts
  );
}

/**
 * @param data - The bars, as given.
 * @returns A list of them.
 */
function datums(data: BarData): BarDatum[] {
  return Array.isArray(data)
    ? [...(data as readonly BarDatum[])]
    : Object.entries(data as Record<string, number>).map(([label, value]) => ({ label, value }));
}

/**
 * One line, with the escape sequences and line breaks a label might carry gone.
 *
 * @param value - The label.
 * @returns The label as a single line.
 */
function singleLine(value: string): string {
  return String(value).replaceAll(/\s+/g, ' ').trim();
}

/**
 * A horizontal bar, in cells and eighths of a cell.
 *
 * @param ratio - How long, 0 to 1.
 * @param cells - How many cells the bar may span.
 * @param plain - Whether to use `#` and whole cells.
 * @returns The bar, not padded.
 */
function barAcross(ratio: number, cells: number, plain: boolean): string {
  if (plain) {
    return '#'.repeat(Math.round(ratio * cells));
  }

  // a value above the bottom is at least one eighth of a cell: rounding a small
  // value to nothing draws it as zero, which is a different statement
  const eighths = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * cells * 8));
  const whole = Math.floor(eighths / 8);
  const part = eighths % 8;

  return '█'.repeat(whole) + (part > 0 ? (EIGHTHS_ACROSS[part - 1] as string) : '');
}

/**
 * Builds the rows of a horizontal bar chart.
 *
 * @param data - The bars.
 * @param opts - The width and the scale.
 * @returns The rows.
 */
function horizontalBars(data: readonly BarDatum[], opts: BarChartOptions): Row[] {
  const format = opts.format ?? formatNumber;
  const [low, high] = bounds(
    data.map((d) => d.value),
    { max: opts.max, min: opts.min ?? Math.min(0, ...data.map((d) => d.value).filter(isPlottable)) }
  );
  const labels = data.map((d) => singleLine(d.label));
  const cap = count(opts.labelWidth, Infinity);
  const labelWidth = Math.min(cap, Math.max(0, ...labels.map((label) => stringWidth(label))));
  const values = data.map((d) => (isPlottable(d.value) ? format(d.value) : '-'));
  const showValues = opts.showValues !== false;
  const valueWidth = showValues ? Math.max(0, ...values.map((value) => stringWidth(value))) : 0;
  const total = count(opts.width, terminalWidth({ env: opts.env }));
  // the label and the value each take a column of space beside the bar
  const room = Math.max(
    1,
    total - labelWidth - (labelWidth > 0 ? 1 : 0) - (showValues ? valueWidth + 1 : 0)
  );
  const plain = asciiOnly(opts);
  const role = roleOf(opts);

  return data.map((datum, i) => {
    const label = truncate(labels[i] as string, labelWidth, 'ellipsis');
    const ratio = isPlottable(datum.value) ? barRatioOf(datum.value, low, high) : 0;
    const bar = barAcross(ratio, room, plain);
    const row: Segment[] = [];

    if (labelWidth > 0) {
      row.push({ text: `${pad(label, labelWidth)} ` });
    }
    row.push({ role, text: bar }, { text: ' '.repeat(room - stringWidth(bar)) });
    if (showValues) {
      row.push({ text: ` ${pad(values[i] as string, valueWidth, 'right')}` });
    }

    return row;
  });
}

/**
 * Builds the rows of a vertical bar chart.
 *
 * @param data - The bars.
 * @param opts - The height, the column width and the scale.
 * @returns The rows.
 */
function verticalBars(data: readonly BarDatum[], opts: BarChartOptions): Row[] {
  const format = opts.format ?? formatNumber;
  const [low, high] = bounds(
    data.map((d) => d.value),
    { max: opts.max, min: opts.min ?? Math.min(0, ...data.map((d) => d.value).filter(isPlottable)) }
  );
  const labels = data.map((d) => singleLine(d.label));
  const values = data.map((d) => (isPlottable(d.value) ? format(d.value) : '-'));
  const showValues = opts.showValues !== false;
  const height = count(opts.height, DEFAULT_HEIGHT);
  const gap = ' '.repeat(
    Number.isInteger(opts.gap) && (opts.gap as number) >= 0 ? (opts.gap as number) : 1
  );
  // wide enough that neither a value nor a label is cut, unless the caller said
  const widest = Math.max(
    1,
    ...labels.map((label) => stringWidth(label)),
    ...(showValues ? values.map((value) => stringWidth(value)) : [])
  );
  const column = count(opts.barWidth, widest);
  const plain = asciiOnly(opts);
  const role = roleOf(opts);

  // a bar's height in eighths of a row; a value above the bottom is at least one
  const eighths = data.map((datum) => {
    const ratio = isPlottable(datum.value) ? barRatioOf(datum.value, low, high) : 0;
    return plain
      ? Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * height)) * 8
      : Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * height * 8));
  });

  const rows: Row[] = [];
  for (let r = height - 1; r >= 0; r--) {
    const row: Segment[] = [];
    data.forEach((_, i) => {
      const fill = Math.min(8, Math.max(0, (eighths[i] as number) - r * 8));
      const glyph = fill === 0 ? ' ' : fill === 8 ? '█' : (SPARK_BLOCKS[fill - 1] as string);
      const cell = (plain && fill > 0 ? '#' : glyph).repeat(column);
      if (i > 0) {
        row.push({ text: gap });
      }
      row.push({ role: fill > 0 ? role : undefined, text: cell });
    });
    rows.push(row);
  }

  const line = (texts: readonly string[]): Row[] => [
    texts.flatMap((value, i) => [
      ...(i > 0 ? [{ text: gap }] : []),
      { text: pad(truncate(value, column, 'ellipsis'), column, 'center') },
    ]),
  ];

  if (showValues) {
    rows.push(...line(values));
  }
  rows.push(...line(labels));

  return rows;
}

/**
 * Builds the rows of a bar chart.
 *
 * @param data - The bars.
 * @param opts - How to draw them.
 * @returns The drawing.
 */
function barDrawing(data: BarData, opts: BarChartOptions): Drawing {
  const list = datums(data);
  const rows =
    list.length === 0
      ? []
      : opts.direction === 'vertical'
        ? verticalBars(list, opts)
        : horizontalBars(list, opts);

  return { kind: 'bar', rows };
}

/**
 * Builds the element tree for a bar chart.
 *
 * @param data - The bars: `{ label, value }` in a list, or an object of numbers.
 * @param opts - The direction, the room and the scale.
 * @returns The tree, and the room it takes.
 */
export function barChartView(data: BarData, opts: BarChartOptions = {}): ChartView {
  return viewOf(barDrawing(data, opts));
}

/**
 * Bars with labels, to compare a handful of numbers.
 *
 * Horizontal by default, which is the form that holds long labels and reads in a
 * terminal's own direction. Bars grow from zero, or from the lowest value where
 * some are negative -- the least bar is then empty, which is a rule about a bar
 * having a length rather than a sign. Pass `min` to start elsewhere. A value above
 * the bottom of the scale is always at least an eighth of a cell, so a small
 * number is not drawn as none.
 *
 * @param data - The bars: `{ label, value }` in a list, or an object of numbers.
 * @param opts - The direction, the room and the scale.
 * @returns The chart, with no trailing newline. Nothing, for no data.
 */
export function barChart(data: BarData, opts: BarChartOptions = {}): string {
  const drawing = barDrawing(data, opts);

  return drawing.rows.length === 0 ? '' : print(drawing, opts);
}

/**
 * Builds the rows of a line chart.
 *
 * @param values - The series.
 * @param opts - The room, the scale and the axes.
 * @returns The drawing.
 */
function lineDrawing(values: readonly number[], opts: LineChartOptions): Drawing {
  const format = opts.format ?? formatNumber;
  const axis = opts.axis !== false;
  const height = count(opts.height, DEFAULT_HEIGHT);
  const [low, high] = bounds(values, opts);
  const topLabel = axis ? format(high) : '';
  const bottomLabel = axis ? format(low) : '';
  const gutter = Math.max(stringWidth(topLabel), stringWidth(bottomLabel));
  const total = count(opts.width, terminalWidth({ env: opts.env }));
  // the labels, a space and the axis take their columns before the plot does
  const plotWidth = Math.max(1, total - (axis ? gutter + 2 : 0));
  const plain = asciiOnly(opts);
  const role = roleOf(opts);

  const dots = new Dots(plotWidth, height);
  const place = (value: number): number =>
    high === low
      ? Math.round((dots.dotHeight - 1) / 2)
      : Math.round((1 - ratioOf(value, low, high)) * (dots.dotHeight - 1));
  const across = (i: number): number =>
    values.length === 1
      ? Math.round((dots.dotWidth - 1) / 2)
      : Math.round((i * (dots.dotWidth - 1)) / (values.length - 1));

  let previous: [number, number] | undefined;
  values.forEach((value, i) => {
    if (!isPlottable(value)) {
      // a missing sample breaks the line rather than being bridged: bridging
      // draws data that was not there
      previous = undefined;
      return;
    }

    const point: [number, number] = [across(i), place(value)];
    if (previous === undefined) {
      dots.set(point[0], point[1]);
    } else {
      dots.line(previous[0], previous[1], point[0], point[1]);
    }
    previous = point;
  });

  const rows: Row[] = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < plotWidth; x++) {
      const cell = dots.charAt(x, y);
      line += cell === undefined ? ' ' : plain ? '*' : cell;
    }

    const row: Segment[] = [];
    if (axis) {
      const label = y === 0 ? topLabel : y === height - 1 ? bottomLabel : '';
      const tick = label === '' ? (plain ? '|' : '│') : plain ? '+' : '┤';
      row.push({ text: `${pad(label, gutter, 'right')} ${tick}` });
    }
    row.push({ role, text: line });
    rows.push(row);
  }

  if (axis) {
    rows.push([
      {
        text: `${' '.repeat(gutter)} ${plain ? '+' : '└'}${(plain ? '-' : '─').repeat(plotWidth)}`,
      },
    ]);

    const [start, end] = opts.xLabels ?? ['', ''];
    if (start !== '' || end !== '') {
      const first = truncate(singleLine(start), plotWidth, 'ellipsis');
      // the end label is dropped where it would run into the start one
      const last =
        stringWidth(first) + 1 + stringWidth(singleLine(end)) <= plotWidth ? singleLine(end) : '';
      rows.push([
        {
          text: `${' '.repeat(gutter + 2)}${first}${' '.repeat(plotWidth - stringWidth(first) - stringWidth(last))}${last}`,
        },
      ]);
    }
  }

  return { kind: 'line', rows };
}

/**
 * Builds the element tree for a line chart.
 *
 * @param values - The series.
 * @param opts - The room, the scale and the axes.
 * @returns The tree, and the room it takes.
 */
export function lineChartView(values: readonly number[], opts: LineChartOptions = {}): ChartView {
  return viewOf(lineDrawing(values, opts));
}

/**
 * A series as a line, drawn in braille.
 *
 * Eight dots to a cell -- two across and four down -- so a plot eighty columns wide
 * is a hundred and sixty samples across, which is the whole reason to draw one
 * rather than a staircase of block characters. A braille cell carries one
 * foreground, so there is **one series**, in one role. The axes name the top and the
 * bottom of the scale and nothing between: a terminal's rows are too few to hang
 * ticks on.
 *
 * Where the terminal cannot be trusted with braille the line is drawn with `*` at
 * the same resolution reduced to a cell.
 *
 * @param values - The series. A value that is not a finite number breaks the line.
 * @param opts - The room, the scale and the axes.
 * @returns The chart, with no trailing newline.
 */
export function lineChart(values: readonly number[], opts: LineChartOptions = {}): string {
  return print(lineDrawing(values, opts), opts);
}

/**
 * Builds the rows of a gauge.
 *
 * @param value - How full.
 * @param opts - The label, the width and the thresholds.
 * @returns The drawing.
 */
function gaugeDrawing(value: number, opts: GaugeOptions): Drawing {
  const low = isPlottable(opts.min) ? opts.min : 0;
  const high = isPlottable(opts.max) ? opts.max : 1;

  if (high <= low) {
    throw new RangeError(`max (${high}) must be greater than min (${low})`);
  }

  const ratio = isPlottable(value) ? ratioOf(value, low, high) : 0;
  const plain = asciiOnly(opts);
  const [filled, empty] =
    opts.style === 'line' ? (plain ? ['=', '-'] : ['━', '─']) : plain ? ['#', '-'] : ['█', '░'];
  const width = count(opts.width, 20);

  const thresholds = opts.thresholds ?? {};
  const role =
    thresholds.error !== undefined && ratio >= thresholds.error
      ? ROLES.error
      : thresholds.warn !== undefined && ratio >= thresholds.warn
        ? ROLES.warn
        : roleOf(opts);

  const row: Segment[] = [];
  if (opts.label) {
    row.push({ text: `${singleLine(opts.label)} ` });
  }
  // the bar's own arithmetic, asked of each half: `renderBar()` with one of the
  // two characters empty draws only the other, so the cell count and the rounding
  // are the progress bar's rather than a second copy
  row.push(
    { role, text: renderBar(ratio, width, filled, '') },
    { role: 'sigil-muted', text: renderBar(ratio, width, '', empty) },
    {
      text: ` ${opts.detail === undefined ? `${Math.round(ratio * 100)}%` : singleLine(opts.detail)}`,
    }
  );

  return { kind: 'gauge', rows: [row] };
}

/**
 * Builds the element tree for a gauge.
 *
 * @param value - How full.
 * @param opts - The label, the width and the thresholds.
 * @returns The tree, and the room it takes.
 */
export function gaugeView(value: number, opts: GaugeOptions = {}): ChartView {
  return viewOf(gaugeDrawing(value, opts));
}

/**
 * A value against its range, on one line.
 *
 * `progress()` is for work in flight: it is live, it moves, and it falls back to
 * a percentage where there is no terminal. A gauge is a **reading** -- memory in
 * use, a disk's fill, a quota -- printed once, and it can be coloured by how bad
 * the reading is. They share the bar arithmetic because that is what a bar is, and
 * nothing else.
 *
 * `value` is a ratio unless `max` says otherwise, so `gauge(0.63)` and
 * `gauge(63, { max: 100 })` print the same line.
 *
 * @param value - How full, between `min` and `max`.
 * @param opts - The label, the width and the thresholds.
 * @returns The line, with no trailing newline.
 */
export function gauge(value: number, opts: GaugeOptions = {}): string {
  return print(gaugeDrawing(value, opts), opts);
}
