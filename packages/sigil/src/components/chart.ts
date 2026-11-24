/**
 * Charts: a sparkline, a bar chart, a braille line chart and a gauge.
 *
 * Each comes twice. `sparkline()`, `barChart()`, `lineChart()` and `gauge()` are
 * pure functions from numbers to a block of text, drawn as an element tree and
 * printed with `renderToString()` the way `table()` and `note()` are, and the
 * `*View()` beside each is that tree at a size the caller names. `Sparkline`,
 * `LineChart`, `BarChart` and `Gauge` are the same drawings as live elements: fed
 * from a signal, a `Series` or a function, redrawn when what they read changes,
 * and drawn at the size the layout gave them. Both read the same drawing code, so
 * a printed chart and a live one at the same size are the same picture.
 *
 * ```js
 * import { LineChart, Series, Sparkline } from '@ttylabs/sigil/components/chart';
 *
 * const load = new Series(120);
 * setInterval(() => load.push(sample()), 1000);
 *
 * Sparkline({ data: load, max: 100, min: 0, props: { 'flex-grow': 1 } });
 * LineChart({ series: [{ data: load, label: 'load' }], props: { 'flex-grow': 1 } });
 * ```
 */

import { Dots } from '../canvas/index.js';
import {
  box,
  type Element,
  type ElementPropsWithout,
  raw,
  renderToString,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions, KeyEvent } from '../input/index.js';
import type { Box } from '../layout/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { maxOf, minOf, stringWidth } from '../width/index.js';
import { terminalWidth, truncate } from '../wrap/index.js';
import { colorLevelOf } from './color-level.js';
import { labelLine, unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import { progressPercent, renderBar } from './progress.js';
import { attachTooltip, type TooltipHandle, type TooltipOptions } from './tooltip.js';

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
  /** The role this one bar is drawn in, over the chart's own. */
  role?: ChartRole;
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

/**
 * Where a live chart's data comes from.
 *
 * The values themselves, anything with a `get()` -- a `State`, a `Computed`, a
 * `Series` -- or a function. A signal or a function is read inside an effect, so
 * the chart redraws when what it read changes.
 */
export type ChartSource<T> = T | { get(): T } | (() => T);

/** One line on a line chart. */
export interface LineChartSeries {
  /** The values. A value that is not a finite number breaks the line. */
  data: ChartSource<readonly number[]>;
  /**
   * Whether to shade the plot under the line, down to the bottom of the scale, in
   * the line's role. Defaults to the chart's `fill`.
   */
  fill?: boolean;
  /** What the series is, written in the legend. */
  label?: string;
  /**
   * Which role the line is drawn in. Defaults to the chart's `role` for the
   * first series and to `warn`, `success`, `info` and `error` for the ones after
   * it, in that order -- a series whose colour means something should say so.
   */
  role?: ChartRole;
}

export interface LineChartOptions extends ChartOptions, ScaleOptions {
  /** Whether to draw the value labels and the axes. Defaults to true. */
  axis?: boolean;
  /**
   * Whether to shade the plot under each line, down to the bottom of the scale, in
   * the line's role -- an area chart. A series' own `fill` overrides it. Defaults
   * to false.
   */
  fill?: boolean;
  /** How a number is written. Defaults to at most two decimals. */
  format?: (value: number) => string;
  /** How tall the plot is, in rows. Defaults to 8. */
  height?: number;
  /** Whether to write each labelled series under the chart. Defaults to whether any has a label. */
  legend?: boolean;
  /**
   * How far apart two samples are, in braille dot columns -- two to a cell -- with
   * the latest at the right edge and what does not fit cut from the left; or
   * `fit`, which spreads every sample across the width. `LineChart`'s is `1`,
   * since a printed chart is a whole series and a live one is a window onto one.
   * Defaults to `fit`.
   */
  step?: number | 'fit';
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
  /** The classes the run takes beside the part class: a role, a series. */
  readonly role?: string;
  readonly text: string;
}

type Row = readonly Segment[];

/** What a chart draws: its rows, and how wide the widest is. */
interface Drawing {
  /** Where a line chart drew its crosshair, and what is under it. */
  readonly crosshair?: CrosshairAt;
  readonly kind: string;
  /**
   * The cell column, from the chart's left edge, of the plot marker of a pinned
   * sample the rule is not on: what the readout's bubble keeps clear of.
   * `undefined` with no pin, where the rule stands in the pin's cell, and where a
   * line has the top cell.
   */
  readonly pinned?: number;
  readonly rows: readonly Row[];
  /**
   * The samples a line chart drew, whether or not a crosshair stands on one: how
   * many the longest series has, and the oldest the plot shows, which a scrolling
   * chart's left edge may leave after the first. `undefined` with no samples.
   */
  readonly samples?: SamplesDrawn;
}

/** What a key needs to know about the samples to step between them. */
interface SamplesDrawn {
  /** How many samples the longest series has. */
  readonly count: number;
  /** The oldest sample drawn. */
  readonly first: number;
}

/** The sample a line chart's crosshair stands on. */
interface CrosshairAt {
  /** The cell column it is drawn in, from the chart's left edge. */
  readonly column: number;
  /** Which sample, counted along the longest series. */
  readonly index: number;
  /** The plot's rows, which the crosshair runs down. */
  readonly rows: number;
  /** Each series' value there, or `undefined` where it has none. */
  readonly values: readonly (number | undefined)[];
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

/** The width a live line or bar chart asks for when nothing says otherwise. */
const DEFAULT_WIDTH = 40;

/**
 * The fewest cells of words a readout bubble is cut down to beside a pin and the rule:
 * under it the room is better spent beside the rule alone, where there is more.
 */
const MIN_READOUT = 3;

/** How wide a gauge's bar is when nothing says otherwise. */
const DEFAULT_GAUGE_BAR = 20;

const ROLES: Record<ChartRole, string | undefined> = {
  accent: 'sigil-accent',
  error: 'sigil-error',
  info: 'sigil-info',
  none: undefined,
  success: 'sigil-success',
  warn: 'sigil-warn',
};

/**
 * The roles a second, third, fourth and fifth series take when they name none.
 *
 * The roles that carry a colour, in an order that keeps neighbours apart in the
 * framework's own sheet -- cyan, yellow, green, blue, red -- and with `error`
 * last, since red reads as something wrong.
 */
const SERIES_ROLES: readonly ChartRole[] = ['accent', 'warn', 'success', 'info', 'error'];

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
  const low = given(opts.min) ? opts.min : found.length > 0 ? minOf(found) : 0;
  const high = given(opts.max) ? opts.max : found.length > 0 ? maxOf(found) : 1;

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
function roleOf(opts: { role?: ChartRole }): string | undefined {
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
 * Reads a chart's source once.
 *
 * Inside an effect this is the read that subscribes it: a `State`, a `Series` or
 * a function that reads signals is what makes the chart redraw.
 *
 * @param source - The values, a signal, or a function.
 * @returns What it holds now.
 */
function read<T>(source: ChartSource<T>): T {
  if (typeof source === 'function') {
    return (source as () => T)();
  }
  if (
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    typeof (source as { get?: unknown }).get === 'function'
  ) {
    return (source as { get(): T }).get();
  }
  return source as T;
}

/**
 * A text for one segment of a row.
 *
 * Every segment is `white-space: pre` and unshrinkable, because the chart has
 * already been fitted to its width and a gap is part of the data: a sparkline's
 * missing sample is a space, and a layout that collapsed it would close the gap.
 *
 * @param kind - Which chart.
 * @param segment - The run.
 * @returns The text.
 */
function segmentNode(kind: string, segment: Segment): Element {
  return textNode(segment.text, {
    class: `sigil-chart-${kind}-part${segment.role ? ` ${segment.role}` : ''}`,
    'flex-shrink': 0,
    // the room a segment stands for, which is also what `pre` measures it
    // at. Written when `pre` was read as `normal` and a segment of padding
    // measured nothing (SIG-207); the two now say the same thing
    width: stringWidth(segment.text),
    'white-space': 'pre',
  });
}

/**
 * A row's segments with the empty ones dropped, and a blank one where that leaves
 * nothing: a row with nothing in it is a box with no height, and a blank row
 * inside a chart is a row.
 *
 * @param row - The row.
 * @returns What is drawn for it.
 */
function drawnSegments(row: Row): Row {
  const segments = row.filter((segment) => segment.text !== '');
  return segments.length > 0 ? segments : [{ text: ' ' }];
}

/**
 * A drawing as an element tree.
 *
 * @param drawing - The rows.
 * @returns The tree.
 */
function viewOf(drawing: Drawing): ChartView {
  const width = maxOf(
    drawing.rows.map((row) => stringWidth(row.map((s) => s.text).join(''))),
    1
  );

  // appended one at a time rather than spread into `box()`: a horizontal chart
  // has a row per bar, and a vertical one a segment per bar in each row, and
  // either can be more than a call has room for arguments
  const element = box({
    class: `sigil-chart sigil-chart-${drawing.kind}`,
    'flex-direction': 'column',
  });
  for (const row of drawing.rows) {
    const line = box({ class: `sigil-chart-${drawing.kind}-row` });
    for (const segment of drawnSegments(row)) {
      line.append(segmentNode(drawing.kind, segment));
    }
    element.append(line);
  }

  return { element, width };
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
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  });
}

/** What a sparkline is drawn at. */
interface SparkLayout extends ScaleOptions {
  readonly ascii: boolean;
  /** The columns: one per sample, the latest at the right. */
  readonly columns: number;
  /** Whether a series shorter than `columns` is padded on the left, so its latest sample sits at the right edge. */
  readonly fill: boolean;
  readonly role: string | undefined;
  /** The rows: one is a sparkline, more is the same eighths stacked into an area. */
  readonly rows: number;
}

/**
 * The rows of a sparkline.
 *
 * Each column is a sample, drawn as a column of eighths `rows * 8` tall. The least
 * plottable sample is one eighth rather than nothing, so on one row this is the
 * eight block heights a sparkline has always been -- the lowest glyph for the
 * least value, the middle one for a series with no extent.
 *
 * @param values - The series.
 * @param layout - The size, the scale and the glyphs.
 * @returns The rows.
 */
function sparkRows(values: readonly number[], layout: SparkLayout): Row[] {
  const { columns, rows } = layout;
  const shown = values.length > columns ? values.slice(values.length - columns) : values;
  const glyphs = layout.ascii ? SPARK_ASCII : SPARK_BLOCKS;
  const [low, high] = bounds(shown, layout);
  const levels = rows * 8;

  // a column's height in eighths, or `undefined` for a gap: a missing sample is
  // a gap, not the lowest bar -- zero and nothing are different answers and a
  // trend line should not blur them
  const heights: (number | undefined)[] = shown.map((value) => {
    if (!isPlottable(value)) {
      return undefined;
    }
    // a series with no extent sits in the middle, which on one row is the
    // fourth glyph of eight
    return high === low
      ? Math.round(levels / 2)
      : 1 + Math.round(ratioOf(value, low, high) * (levels - 1));
  });
  const lead = layout.fill ? Math.max(0, columns - shown.length) : 0;

  const out: Row[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    let line = ' '.repeat(lead);
    for (const height of heights) {
      const fill = height === undefined ? 0 : Math.min(8, Math.max(0, height - r * 8));
      line += fill === 0 ? ' ' : (glyphs[fill - 1] as string);
    }
    out.push([{ role: layout.role, text: line }]);
  }
  return out;
}

/**
 * The rows of a printed sparkline: one row, cut to the width it was given.
 *
 * @param values - The series.
 * @param opts - The width and the scale.
 * @returns The drawing.
 */
function sparkDrawing(values: readonly number[], opts: SparklineOptions): Drawing {
  return {
    kind: 'sparkline',
    rows: sparkRows(values, {
      ascii: asciiOnly(opts),
      columns: opts.width === undefined ? values.length : count(opts.width, values.length),
      fill: false,
      max: opts.max,
      min: opts.min,
      role: roleOf(opts),
      rows: 1,
    }),
  };
}

/**
 * Builds the element tree for a sparkline.
 *
 * @param values - The series. A value that is not a finite number is a gap.
 * @param opts - The width, the scale and the role.
 * @returns The tree, and the room it takes.
 */
export function sparklineView(values: readonly number[], opts: SparklineOptions = {}): ChartView {
  return viewOf(sparkDrawing(values, opts));
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
  return print(sparkDrawing(values, opts), opts);
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
 * The bounds of a bar chart: from zero, or from the lowest value where some are
 * negative, unless the caller says.
 *
 * @param data - The bars.
 * @param opts - The bounds the caller gave.
 * @returns The bottom and the top.
 */
function barBounds(data: readonly BarDatum[], opts: ScaleOptions): [number, number] {
  return bounds(
    data.map((d) => d.value),
    { max: opts.max, min: opts.min ?? minOf(data.map((d) => d.value).filter(isPlottable), 0) }
  );
}

/**
 * The class one bar is drawn with: its own role where it names one.
 *
 * @param datum - The bar.
 * @param role - The chart's.
 * @returns The class.
 */
function barRole(datum: BarDatum, role: string | undefined): string | undefined {
  return datum.role === undefined ? role : ROLES[datum.role];
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
  const [low, high] = barBounds(data, opts);
  const labels = data.map((d) => labelLine(d.label));
  const cap = count(opts.labelWidth, Infinity);
  const labelWidth = Math.min(
    cap,
    maxOf(
      labels.map((label) => stringWidth(label)),
      0
    )
  );
  const values = data.map((d) => (isPlottable(d.value) ? format(d.value) : '-'));
  const showValues = opts.showValues !== false;
  const valueWidth = showValues
    ? maxOf(
        values.map((value) => stringWidth(value)),
        0
      )
    : 0;
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
    row.push(
      { role: barRole(datum, role), text: bar },
      { text: ' '.repeat(room - stringWidth(bar)) }
    );
    if (showValues) {
      row.push({ text: ` ${pad(values[i] as string, valueWidth, 'right')}` });
    }

    return row;
  });
}

/**
 * The column a vertical bar takes: the widest label or value, so that neither is
 * cut.
 *
 * @param data - The bars.
 * @param opts - The format and the values.
 * @returns The width.
 */
function naturalColumn(
  data: readonly BarDatum[],
  opts: Pick<BarChartOptions, 'format' | 'showValues'>
): number {
  const format = opts.format ?? formatNumber;
  const showValues = opts.showValues !== false;
  const labels = maxOf(
    data.map((d) => stringWidth(labelLine(d.label))),
    1
  );
  return showValues
    ? maxOf(
        data.map((d) => stringWidth(isPlottable(d.value) ? format(d.value) : '-')),
        labels
      )
    : labels;
}

/**
 * @param opts - The chart's options.
 * @returns The columns between two vertical bars.
 */
function gapOf(opts: { gap?: number }): number {
  return Number.isInteger(opts.gap) && (opts.gap as number) >= 0 ? (opts.gap as number) : 1;
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
  const [low, high] = barBounds(data, opts);
  const labels = data.map((d) => labelLine(d.label));
  const values = data.map((d) => (isPlottable(d.value) ? format(d.value) : '-'));
  const showValues = opts.showValues !== false;
  const height = count(opts.height, DEFAULT_HEIGHT);
  const gap = ' '.repeat(gapOf(opts));
  const column = count(opts.barWidth, naturalColumn(data, opts));
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
    data.forEach((datum, i) => {
      const fill = Math.min(8, Math.max(0, (eighths[i] as number) - r * 8));
      const glyph = fill === 0 ? ' ' : fill === 8 ? '█' : (SPARK_BLOCKS[fill - 1] as string);
      const cell = (plain && fill > 0 ? '#' : glyph).repeat(column);
      if (i > 0) {
        row.push({ text: gap });
      }
      row.push({ role: fill > 0 ? barRole(datum, role) : undefined, text: cell });
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

/** One line of a line chart, read and given its classes. */
interface PlotSeries {
  /** The classes its cells take: its series hook, and its role. */
  readonly classes: string;
  /** Whether the plot under it is shaded. */
  readonly fill: boolean;
  readonly label: string | undefined;
  readonly values: readonly number[];
}

/** What a line chart is drawn at. */
interface LineLayout extends ScaleOptions {
  readonly ascii: boolean;
  readonly axis: boolean;
  /**
   * How many samples before the newest the keyboard stands on, for the crosshair
   * where there is no pointer; `undefined` draws none.
   */
  readonly back?: number;
  /** Whether the chart has the focus, which the rule says by its colour. */
  readonly focused?: boolean;
  readonly format: (value: number) => string;
  /** How tall the plot is, in rows, with the axis and the legend not counted. */
  readonly height: number;
  readonly legend: boolean;
  /**
   * The cell column the pointer is over, from the chart's left edge, for the
   * crosshair; `undefined` draws none.
   */
  readonly pointer?: number;
  /**
   * How many samples before the newest the pinned one is, or `undefined` for none.
   * Marked on the plot and the axis wherever the crosshair is not.
   */
  readonly pinned?: number;
  readonly step: number | 'fit';
  /** How wide the whole chart is. */
  readonly width: number;
  readonly xLabels: readonly [string, string] | undefined;
}

/**
 * Which plot rows carry a value on the axis, top first.
 *
 * The top and the bottom always, and one every four rows or so between them once
 * the plot is tall enough to have room: a plot of eight rows has none between,
 * which is what a printed chart drew before a chart could be the height of a
 * panel, and a plot of thirty has seven.
 *
 * @param height - The plot's rows.
 * @returns The rows, top first.
 */
function tickRows(height: number): number[] {
  if (height <= 1) {
    return [0];
  }
  const intervals = Math.max(1, Math.floor((height - 1) / 4));
  return Array.from({ length: intervals + 1 }, (_, i) =>
    Math.round((i * (height - 1)) / intervals)
  );
}

/**
 * The series, read and given their classes.
 *
 * @param list - The series.
 * @param role - The chart's role, which the first takes when it names none.
 * @param fill - The chart's `fill`, which a series that says nothing takes.
 * @returns The series, read.
 */
function plotSeries(
  list: readonly LineChartSeries[],
  role: ChartRole | undefined,
  fill: boolean | undefined
): PlotSeries[] {
  return list.map((series, i) => {
    const fallback =
      i === 0 ? (role ?? 'accent') : (SERIES_ROLES[i % SERIES_ROLES.length] as ChartRole);
    const cls = ROLES[series.role ?? fallback];
    return {
      classes: `sigil-chart-series-${i + 1}${cls ? ` ${cls}` : ''}`,
      fill: (series.fill ?? fill) === true,
      label: series.label === undefined ? undefined : labelLine(series.label),
      values: read(series.data),
    };
  });
}

/** The classes a cell of the crosshair takes: its hook, and the muted role. */
const CROSSHAIR_CLASSES = 'sigil-chart-crosshair sigil-muted';

/**
 * The same while the chart has the focus: the accent role in place of the muted
 * one, and a hook of its own.
 */
const CROSSHAIR_FOCUS_CLASSES = 'sigil-chart-crosshair sigil-chart-crosshair-focus sigil-accent';

/**
 * The classes the pin's marker takes: its hook, and the warn role, which is neither
 * the muted rule nor the accent the focus is shown in.
 */
const PIN_CLASSES = 'sigil-chart-pin sigil-warn';

/**
 * Which dots of a braille cell are set, as the bits `Dots` keeps them in.
 *
 * @param dots - The grid, or nothing.
 * @param x - Cell column.
 * @param y - Cell row.
 * @returns The mask, `0` for none.
 */
function maskAt(dots: Dots | undefined, x: number, y: number): number {
  const cell = dots?.charAt(x, y);
  return cell === undefined ? 0 : (cell.codePointAt(0) as number) - 0x2800;
}

/**
 * @param mask - A cell's dots.
 * @returns The braille character that draws them.
 */
function braille(mask: number): string {
  return String.fromCodePoint(0x2800 + mask);
}

/**
 * Shades the plot under a line: a screen of every other dot across and down, from
 * just below the line's highest dot in each dot column to the bottom.
 *
 * A quarter of the dots rather than all of them, so the shade is a tint and the
 * line over it is still a line where there is no colour to tell them apart: a
 * solid shade is a block whose top edge is the line, and a second series drawn
 * across it is lost. The screen is laid on the plot rather than on each series,
 * so two shaded series meeting in one cell agree about which dots a shade has. A
 * dot column the line does not reach -- a gap in the data, or the plot before the
 * first sample -- is not shaded, since there is nothing there to be under.
 *
 * @param line - The series' own line.
 * @param area - Where the shade is drawn.
 */
function shadeUnder(line: Dots, area: Dots): void {
  for (let x = 0; x < line.dotWidth; x++) {
    let top = -1;
    for (let y = 0; y < line.dotHeight; y++) {
      if (line.get(x, y)) {
        top = y;
        break;
      }
    }
    if (top < 0) {
      continue;
    }
    for (let y = top + 1; y < line.dotHeight; y++) {
      if (x % 2 === 0 && y % 2 === 0) {
        area.set(x, y);
      }
    }
  }
}

/**
 * The sample nearest a cell column of the plot, counted along the longest
 * series.
 *
 * Nearest the middle of the cell, so the crosshair snaps to a sample rather than
 * standing between two: seven days across a wide plot are seven places it can be.
 * Where several samples are drawn in the pointer's cell -- two at a step of one,
 * or many where `fit` spreads more samples than the plot has dot columns -- it is
 * the **newest** of them, and two equally near go to the newer, so the latest
 * sample, which is the one a chart is read for, is always under the last column.
 * A column before the first sample a scrolling chart has drawn is none, as is one
 * outside the plot.
 *
 * @param column - The cell column, from the plot's left edge.
 * @param plotWidth - The plot's width in cells.
 * @param longest - How many samples the longest series has.
 * @param step - The chart's step.
 * @param across - A sample's dot column.
 * @returns The sample, or `undefined` for none.
 */
function sampleUnder(
  column: number,
  plotWidth: number,
  longest: number,
  step: number | 'fit',
  across: (k: number) => number
): number | undefined {
  if (!Number.isInteger(column) || column < 0 || column >= plotWidth || longest === 0) {
    return undefined;
  }
  const dot = column * 2 + 0.5;
  const last = plotWidth * 2 - 1;
  let k: number;
  if (step === 'fit') {
    k =
      longest === 1
        ? 0
        : Math.min(longest - 1, Math.max(0, Math.round((dot * (longest - 1)) / last)));
  } else {
    // samples back from the latest, rounded half towards the latest
    k = longest - 1 - Math.ceil((last - dot) / step - 0.5);
    // rounded onto a sample past the left edge, the nearest one drawn is the next
    if (k >= 0 && across(k) < 0) {
      k += 1;
    }
    if (k < 0 || k >= longest || across(k) < 0) {
      return undefined;
    }
  }
  // and on to the newest drawn in the same cell, which the nearest need not be
  // where a cell holds several
  while (k + 1 < longest && Math.floor(across(k + 1) / 2) === column) {
    k += 1;
  }
  return k;
}

/**
 * Builds the rows of a line chart.
 *
 * Every series is drawn into its own braille grid and into one they share. A
 * cell's character is the shared grid's, so two lines through one cell are both
 * there; its colour is the **last** series with a dot in it, which is the order a
 * painter draws in and the order a reader can predict -- the series listed last
 * is on top. A filled series' shade and the crosshair go under every line, the
 * crosshair over the shade.
 *
 * @param list - The series.
 * @param layout - The room, the scale and the axes.
 * @returns The drawing.
 */
function lineDrawing(list: readonly PlotSeries[], layout: LineLayout): Drawing {
  const { axis, format, height, step } = layout;
  const plain = layout.ascii;
  const longest = maxOf(
    list.map((s) => s.values.length),
    0
  );

  /** The plot's width at a gutter, the scale of what it shows there, and the labels on it. */
  const fit = (gutter: number) => {
    const plotWidth = Math.max(1, layout.width - (axis ? gutter + 2 : 0));
    const dotWidth = plotWidth * 2;
    const shown = list.map((series) => {
      const n = series.values.length;
      if (step === 'fit') {
        return series.values;
      }
      // the latest sample at the right edge, each one `step` dots before the
      // next, and what falls off the left is not scaled over
      const visible = Math.min(n, Math.floor((dotWidth - 1) / step) + 1);
      return series.values.slice(n - visible);
    });
    const [low, high] = bounds(shown.flat(), layout);
    const ticks = tickRows(height).map((row) => ({
      row,
      text: format(height <= 1 ? high : high - (row / (height - 1)) * (high - low)),
    }));
    const widest = axis ? Math.max(0, ...ticks.map((tick) => stringWidth(tick.text))) : 0;
    return { high, low, plotWidth, ticks, widest };
  };

  // the gutter is as wide as the labels, the labels are the scale's, and where
  // the series is cut to the plot the scale is what is shown -- so it is asked
  // until it settles, which it does at once unless a label gains a digit
  let gutter = 0;
  let at = fit(gutter);
  for (let tries = 0; tries < 4 && at.widest !== gutter; tries++) {
    gutter = at.widest;
    at = fit(gutter);
  }
  gutter = Math.max(gutter, at.widest);
  const { high, low, plotWidth, ticks } = at;

  const union = new Dots(plotWidth, height);
  const grids = list.map(() => new Dots(plotWidth, height));
  const areas = list.map((series) => (series.fill ? new Dots(plotWidth, height) : undefined));
  const place = (value: number): number =>
    high === low
      ? Math.round((union.dotHeight - 1) / 2)
      : Math.round((1 - ratioOf(value, low, high)) * (union.dotHeight - 1));
  /**
   * The dot column of a sample, counted along the longest series: every series
   * ends at the right edge together, at its latest sample.
   */
  const across = (k: number): number => {
    if (step === 'fit') {
      // one series alone spans the width as it always did
      return longest === 1
        ? Math.round((union.dotWidth - 1) / 2)
        : Math.round((k * (union.dotWidth - 1)) / (longest - 1));
    }
    return union.dotWidth - 1 - (longest - 1 - k) * step;
  };

  list.forEach((series, s) => {
    const values = series.values;
    const n = values.length;
    const grid = grids[s] as Dots;
    const offset = longest - n;

    let previous: [number, number] | undefined;
    // one sample before the left edge is still drawn to, so a line that scrolls
    // off enters from the edge rather than starting a dot in
    const first = step === 'fit' ? 0 : Math.max(0, n - Math.floor((union.dotWidth - 1) / step) - 2);
    for (let i = first; i < n; i++) {
      const value = values[i];
      if (!isPlottable(value)) {
        // a missing sample breaks the line rather than being bridged: bridging
        // draws data that was not there
        previous = undefined;
        continue;
      }
      const point: [number, number] = [across(offset + i), place(value)];
      for (const dots of [grid, union]) {
        if (previous === undefined) {
          dots.set(point[0], point[1]);
        } else {
          dots.line(previous[0], previous[1], point[0], point[1]);
        }
      }
      previous = point;
    }

    const area = areas[s];
    if (area !== undefined) {
      shadeUnder(grid, area);
    }
  });

  const plotLeft = axis ? gutter + 2 : 0;
  // the oldest sample the plot draws: all of them under `fit`, and under a step
  // the ones whose dot column is not before the left edge
  const oldest =
    step === 'fit' ? 0 : Math.max(0, longest - 1 - Math.floor((union.dotWidth - 1) / step));
  // the pointer is the crosshair's where it is over the chart, and the keyboard's
  // sample is where it is not; a keyboard sample past the oldest drawn is the oldest
  // a pointer over the chart where there is no sample -- the axis labels, the
  // legend, a scrolling chart's empty left -- leaves the keyboard's where it was
  const crosshair =
    (layout.pointer === undefined
      ? undefined
      : sampleUnder(layout.pointer - plotLeft, plotWidth, longest, step, across)) ??
    (layout.back === undefined || longest === 0
      ? undefined
      : Math.max(oldest, longest - 1 - layout.back));
  // the pinned sample, clamped to the oldest drawn as the keyboard's is, and
  // marked in its own cell -- except where the rule stands in that cell, which
  // already marks it
  const pin =
    layout.pinned === undefined || longest === 0
      ? undefined
      : Math.max(oldest, longest - 1 - layout.pinned);
  const pinColumn =
    pin === undefined || (crosshair !== undefined && across(crosshair) >> 1 === across(pin) >> 1)
      ? -1
      : across(pin) >> 1;
  const cross = new Dots(plotWidth, height);
  if (crosshair !== undefined) {
    for (let y = 0; y < cross.dotHeight; y++) {
      cross.set(across(crosshair), y);
    }
  }

  const labelAt = new Map(ticks.map((tick) => [tick.row, tick.text]));
  const rows: Row[] = [];
  for (let y = 0; y < height; y++) {
    const row: Segment[] = [];
    if (axis) {
      const label = labelAt.get(y) ?? '';
      const tick = label === '' ? (plain ? '|' : '│') : plain ? '+' : '┤';
      row.push({ text: `${pad(label, gutter, 'right')} ${tick}` });
    }

    // runs of one set of classes; a blank cell joins the run it is in, and the
    // blanks before the first dot join the first run, so a lone series is one
    // segment
    const runs: { classes: string | undefined; text: string }[] = [];
    for (let x = 0; x < plotWidth; x++) {
      const { classes, glyph } = cellOf(x, y);
      const run = runs.at(-1);
      if (run === undefined) {
        runs.push({ classes, text: glyph });
      } else if (classes === PIN_CLASSES || run.classes === PIN_CLASSES) {
        // the marker is one cell of its own: blanks beside it are not in its
        // role, which a theme may give a background
        runs.push({ classes, text: glyph });
      } else if (classes === undefined || classes === run.classes) {
        run.text += glyph;
      } else if (run.classes === undefined) {
        run.classes = classes;
        run.text += glyph;
      } else {
        runs.push({ classes, text: glyph });
      }
    }
    for (const part of runs) {
      row.push({ role: part.classes ?? list[0]?.classes, text: part.text });
    }
    rows.push(row);
  }

  /**
   * What one cell of the plot shows. A line beats the crosshair and the crosshair
   * beats an area, so a line is never hidden by either: a cell with a line in it
   * has every line's dots and the owner's area under them, in the colour of the
   * last series with a dot there; a cell the crosshair runs through that holds no
   * line is the crosshair's; and a cell of area alone is the last filled series'.
   */
  function cellOf(x: number, y: number): { classes: string | undefined; glyph: string } {
    const lines = maskAt(union, x, y);
    if (lines !== 0) {
      let owner = 0;
      for (let s = grids.length - 1; s >= 0; s--) {
        if (maskAt(grids[s] as Dots, x, y) !== 0) {
          owner = s;
          break;
        }
      }
      return {
        classes: list[owner]?.classes,
        glyph: plain ? '*' : braille(lines | maskAt(areas[owner], x, y)),
      };
    }
    // the top cell of the pinned column, where no line is
    if (x === pinColumn && y === 0) {
      return { classes: PIN_CLASSES, glyph: plain ? 'v' : '▼' };
    }
    const rule = maskAt(cross, x, y);
    if (rule !== 0) {
      return {
        classes: layout.focused === true ? CROSSHAIR_FOCUS_CLASSES : CROSSHAIR_CLASSES,
        glyph: plain ? '|' : braille(rule),
      };
    }
    for (let s = areas.length - 1; s >= 0; s--) {
      const shade = maskAt(areas[s], x, y);
      if (shade !== 0) {
        return {
          classes: `${(list[s] as PlotSeries).classes} sigil-chart-area`,
          glyph: plain ? ':' : braille(shade),
        };
      }
    }
    return { classes: undefined, glyph: ' ' };
  }

  if (axis) {
    // the crosshair meets the axis with a tick, so the sample it stands on is
    // marked where the x labels are read
    const at = crosshair === undefined ? -1 : Math.floor(across(crosshair) / 2);
    const rule = Array.from({ length: plotWidth }, (_, x) =>
      x === at ? (plain ? '+' : '┴') : x === pinColumn ? ' ' : plain ? '-' : '─'
    );
    const left = `${' '.repeat(gutter)} ${plain ? '+' : '└'}`;
    if (pinColumn < 0) {
      rows.push([{ text: `${left}${rule.join('')}` }]);
    } else {
      // the pin's marker is a segment of its own, to take its classes
      rows.push([
        { text: `${left}${rule.slice(0, pinColumn).join('')}` },
        { role: PIN_CLASSES, text: plain ? '^' : '▲' },
        { text: rule.slice(pinColumn + 1).join('') },
      ]);
    }

    const [start, end] = layout.xLabels ?? ['', ''];
    if (start !== '' || end !== '') {
      const firstLabel = truncate(labelLine(start), plotWidth, 'ellipsis');
      // the end label is dropped where it would run into the start one
      const last =
        stringWidth(firstLabel) + 1 + stringWidth(labelLine(end)) <= plotWidth
          ? labelLine(end)
          : '';
      rows.push([
        {
          text: `${' '.repeat(gutter + 2)}${firstLabel}${' '.repeat(plotWidth - stringWidth(firstLabel) - stringWidth(last))}${last}`,
        },
      ]);
    }
  }

  if (layout.legend) {
    rows.push(legendRow(list, axis ? gutter + 2 : 0, layout.width, plain));
  }

  return {
    crosshair:
      crosshair === undefined
        ? undefined
        : {
            column: plotLeft + Math.floor(across(crosshair) / 2),
            index: crosshair,
            rows: height,
            values: list.map((series) => {
              const value = series.values[crosshair - (longest - series.values.length)];
              return isPlottable(value) ? value : undefined;
            }),
          },
    kind: 'line',
    // not where a line has the top cell, which draws no marker for a bubble to cover
    pinned: pinColumn < 0 || maskAt(union, pinColumn, 0) !== 0 ? undefined : plotLeft + pinColumn,
    rows,
    samples: longest === 0 ? undefined : { count: longest, first: oldest },
  };
}

/**
 * The legend: a mark in each labelled series' role and its label, in the order
 * the series were given.
 *
 * What does not fit is cut: the last entry with room for a character of its label
 * and an ellipsis is cut to them, and the ones after it are dropped.
 *
 * @param list - The series.
 * @param indent - The columns before the plot, which the legend starts under.
 * @param width - The whole chart's width.
 * @param plain - Whether to draw the mark in ASCII.
 * @returns The row.
 */
function legendRow(
  list: readonly PlotSeries[],
  indent: number,
  width: number,
  plain: boolean
): Row {
  const room = Math.max(0, width - indent);
  const mark = plain ? '*' : '⣿';
  const row: Segment[] = [{ text: ' '.repeat(Math.min(indent, width)) }];
  let used = 0;
  for (const series of list) {
    if (series.label === undefined || series.label === '') {
      continue;
    }
    const gap = used > 0 ? 2 : 0;
    const left = room - used - gap - 2;
    const whole = stringWidth(series.label) <= left;
    // a label cut down to its ellipsis says nothing, so it needs a character and
    // the ellipsis or it is not written at all
    if (!whole && left < 2) {
      break;
    }
    const label = whole ? series.label : truncate(series.label, left, 'ellipsis');
    if (gap > 0) {
      row.push({ role: 'sigil-chart-legend', text: '  ' });
    }
    row.push(
      { role: `sigil-chart-legend ${series.classes}`, text: mark },
      { role: 'sigil-chart-legend', text: ` ${label}` }
    );
    used += gap + 2 + stringWidth(label);
    if (label !== series.label) {
      break;
    }
  }
  return row;
}

/**
 * The series a printed line chart was handed: one list of numbers, or several
 * series.
 *
 * @param values - What was given.
 * @returns The series.
 */
function seriesOf(
  values: readonly number[] | readonly LineChartSeries[]
): readonly LineChartSeries[] {
  const first = values[0];
  return typeof first === 'object' && first !== null
    ? (values as readonly LineChartSeries[])
    : [{ data: values as readonly number[] }];
}

/**
 * A step setting, checked.
 *
 * @param step - What was given.
 * @param fallback - What nothing means.
 * @returns The step.
 */
function stepOf(step: number | 'fit' | undefined, fallback: number | 'fit'): number | 'fit' {
  if (step === undefined) {
    return fallback;
  }
  if (step !== 'fit' && !(Number.isSafeInteger(step) && step >= 1)) {
    throw new RangeError(
      `Invalid line chart step ${String(step)}: expected a whole number of dots, at least 1, or 'fit'`
    );
  }
  return step;
}

/**
 * The layout a printed line chart is drawn at.
 *
 * @param list - The series, read.
 * @param opts - The options.
 * @returns The layout.
 */
function printedLayout(list: readonly PlotSeries[], opts: LineChartOptions): LineLayout {
  return {
    ascii: asciiOnly(opts),
    axis: opts.axis !== false,
    format: opts.format ?? formatNumber,
    height: count(opts.height, DEFAULT_HEIGHT),
    legend: opts.legend ?? list.some((s) => s.label !== undefined && s.label !== ''),
    max: opts.max,
    min: opts.min,
    step: stepOf(opts.step, 'fit'),
    width: count(opts.width, terminalWidth({ env: opts.env })),
    xLabels: opts.xLabels,
  };
}

/**
 * Builds the element tree for a line chart.
 *
 * @param values - The series: a list of numbers, or several `{ data, label, role }`.
 * @param opts - The room, the scale and the axes.
 * @returns The tree, and the room it takes.
 */
export function lineChartView(
  values: readonly number[] | readonly LineChartSeries[],
  opts: LineChartOptions = {}
): ChartView {
  const list = plotSeries(seriesOf(values), opts.role, opts.fill);
  return viewOf(lineDrawing(list, printedLayout(list, opts)));
}

/**
 * Series as lines, drawn in braille.
 *
 * Eight dots to a cell -- two across and four down -- so a plot eighty columns wide
 * is a hundred and sixty samples across, which is the whole reason to draw one
 * rather than a staircase of block characters. Several series share the plot, each
 * in its own role, and where two cross one cell the later one is on top. The axis
 * names the top and the bottom of the scale, and a value every four rows or so
 * between them on a plot tall enough to have room.
 *
 * Where the terminal cannot be trusted with braille the line is drawn with `*` at
 * the same resolution reduced to a cell.
 *
 * @param values - The series: a list of numbers, or several `{ data, label, role }`.
 *   A value that is not a finite number breaks the line.
 * @param opts - The room, the scale and the axes.
 * @returns The chart, with no trailing newline.
 */
export function lineChart(
  values: readonly number[] | readonly LineChartSeries[],
  opts: LineChartOptions = {}
): string {
  const list = plotSeries(seriesOf(values), opts.role, opts.fill);
  return print(lineDrawing(list, printedLayout(list, opts)), opts);
}

/**
 * A gauge's range, refused where it has no extent.
 *
 * @param opts - The bounds.
 * @returns The bottom and the top.
 */
function gaugeRange(opts: ScaleOptions): [number, number] {
  const low = isPlottable(opts.min) ? opts.min : 0;
  const high = isPlottable(opts.max) ? opts.max : 1;

  if (high <= low) {
    throw new RangeError(`max (${high}) must be greater than min (${low})`);
  }
  return [low, high];
}

/**
 * Builds the rows of a gauge.
 *
 * @param value - How full.
 * @param opts - The label, the width and the thresholds.
 * @param percentWidth - The columns the percentage is padded to, so a live gauge's
 *   bar does not move as the figure gains a digit.
 * @returns The drawing.
 */
function gaugeDrawing(value: number, opts: GaugeOptions, percentWidth = 0): Drawing {
  const [low, high] = gaugeRange(opts);
  const ratio = isPlottable(value) ? ratioOf(value, low, high) : 0;
  const plain = asciiOnly(opts);
  const [filled, empty] =
    opts.style === 'line' ? (plain ? ['=', '-'] : ['━', '─']) : plain ? ['#', '-'] : ['█', '░'];
  const width = count(opts.width, DEFAULT_GAUGE_BAR);

  const thresholds = opts.thresholds ?? {};
  const role =
    thresholds.error !== undefined && ratio >= thresholds.error
      ? ROLES.error
      : thresholds.warn !== undefined && ratio >= thresholds.warn
        ? ROLES.warn
        : roleOf(opts);

  const row: Segment[] = [];
  if (opts.label) {
    row.push({ text: `${labelLine(opts.label)} ` });
  }
  const figure =
    opts.detail === undefined
      ? pad(`${progressPercent(ratio, 1)}%`, percentWidth, 'right')
      : labelLine(opts.detail);
  // the bar's own arithmetic, asked of each half: `renderBar()` with one of the
  // two characters empty draws only the other, so the cell count and the rounding
  // are the progress bar's rather than a second copy. The figure is the progress
  // bar's too, rounded down like the bar, so a gauge is never drawn short of full
  // beside a figure that says 100%
  row.push(
    { role, text: renderBar(ratio, width, filled, '') },
    { role: 'sigil-muted', text: renderBar(ratio, width, '', empty) },
    { text: ` ${figure}` }
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

// -- a ring buffer of samples -------------------------------------------------

/**
 * A fixed number of the latest samples, oldest first: a ring buffer that is also a
 * signal.
 *
 * `push()` writes into the ring and moves its start, so a sample costs no
 * allocation and the oldest falls off once it is full -- where a `State` holding
 * an array needs a new array every tick to say it changed. Reading it subscribes
 * the way reading a `State` does, so a chart handed one redraws when it is pushed
 * to. `get()` is the samples as an array, built once per change however many
 * charts read it, and frozen, because it is shared.
 *
 * The capacity is the history worth keeping rather than the width it is drawn at:
 * the layout decides that, and a chart narrower than the history shows its latest
 * end. A `Sparkline` handed one asks for a column a sample, where the layout
 * leaves the choice to it.
 *
 * ```js
 * const rx = new Series(120);
 * setInterval(() => rx.push(bytesPerSecond()), 1000);
 * Sparkline({ data: rx, min: 0 });
 * ```
 */
export class Series {
  /** How many samples it keeps. */
  readonly capacity: number;
  readonly #ring: number[];
  #start = 0;
  #size = 0;
  #writes = 0;
  readonly #version = new State(0);
  #snapshot: readonly number[] | undefined;

  /**
   * @param capacity - How many samples to keep, at least one.
   * @param values - Samples to start with, oldest first.
   * @throws {RangeError} For a capacity that is not a whole number of samples.
   */
  constructor(capacity: number, values: Iterable<number> = []) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `Invalid series capacity ${String(capacity)}: expected a whole number of samples, at least 1`
      );
    }
    this.capacity = capacity;
    this.#ring = Array.from({ length: capacity }, () => Number.NaN);
    for (const value of values) {
      this.#put(value);
    }
  }

  /** How many samples it holds, which is never more than `capacity`. */
  get length(): number {
    this.#version.get();
    return this.#size;
  }

  /**
   * Adds samples at the latest end, dropping the oldest past `capacity`.
   *
   * @param values - The samples, oldest first. A value that is not a finite
   *   number is kept, and a chart draws it as a gap.
   */
  push(...values: number[]): void {
    if (values.length === 0) {
      return;
    }
    for (const value of values) {
      this.#put(value);
    }
    this.#changed();
  }

  /** Drops every sample. */
  clear(): void {
    if (this.#size === 0) {
      return;
    }
    this.#start = 0;
    this.#size = 0;
    this.#changed();
  }

  /**
   * The samples, oldest first.
   *
   * @returns A frozen array, the same one until the next change.
   */
  get(): readonly number[] {
    this.#version.get();
    if (this.#snapshot === undefined) {
      const out: number[] = [];
      for (let i = 0; i < this.#size; i++) {
        out.push(this.#ring[(this.#start + i) % this.capacity] as number);
      }
      this.#snapshot = Object.freeze(out);
    }
    return this.#snapshot;
  }

  /**
   * One sample, as `Array.prototype.at()` reads one: `at(-1)` is the latest.
   *
   * @param index - From the oldest, or from the latest where negative.
   * @returns The sample, or `undefined` past either end.
   */
  at(index: number): number | undefined {
    this.#version.get();
    const i = Math.trunc(index);
    const k = i < 0 ? this.#size + i : i;
    if (!Number.isFinite(k) || k < 0 || k >= this.#size) {
      return undefined;
    }
    return this.#ring[(this.#start + k) % this.capacity];
  }

  #put(value: number): void {
    if (this.#size < this.capacity) {
      this.#ring[(this.#start + this.#size) % this.capacity] = value;
      this.#size++;
    } else {
      this.#ring[this.#start] = value;
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  #changed(): void {
    this.#snapshot = undefined;
    this.#version.set(++this.#writes);
  }
}

// -- the live charts ----------------------------------------------------------

/** What every live chart takes. */
export interface ChartElementProps {
  /** Draw with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /** Extra classes for the chart, beside `sigil-chart` and its kind's. */
  class?: string;
  /**
   * The chart's own props: a size, a flex factor, a margin. A chart is the size
   * the layout gives it, so this is where `'flex-grow': 1` goes to make it fill
   * the space around it. `onResize` is the chart's.
   */
  props?: ElementPropsWithout<'onResize'>;
}

export interface SparklineProps extends ChartElementProps, ScaleOptions {
  /** The samples. A value that is not a finite number is a gap. */
  data: ChartSource<readonly number[]>;
  /** The rows asked for where the layout does not decide. Defaults to 1. */
  height?: number;
  /** Which role colours the data. Defaults to `accent`. */
  role?: ChartRole;
  /**
   * The columns asked for where the layout does not decide. Defaults to the
   * series' `capacity`, or to as many samples as there are.
   */
  width?: number;
}

/**
 * A line chart's crosshair: `attachTooltip()`'s options, with the words worked out
 * per sample.
 */
export interface LineChartCrosshair extends Omit<TooltipOptions, 'area' | 'hold' | 'text'> {
  /**
   * What the readout says at a sample: its index, counted along the longest
   * series, and each series' value there in the order they were given, or
   * `undefined` where one has none. An empty string shows the rule with no
   * readout. Defaults to a line per series with a value, its label and the value
   * written by `format`.
   */
  text?: (index: number, values: readonly (number | undefined)[]) => string;
}

/** What a line chart takes whether or not it has a crosshair. */
interface LineChartBase extends ChartElementProps, ScaleOptions {
  /** Whether to draw the value labels and the axes. Defaults to true. */
  axis?: boolean;
  /** One series' samples, where there is one. `series` is the way to give several. */
  data?: ChartSource<readonly number[]>;
  /**
   * Whether to shade the plot under each line, as `lineChart()`'s `fill`. A
   * series' own `fill` overrides it. Defaults to false.
   */
  fill?: boolean;
  /** How a number is written. Defaults to at most two decimals. */
  format?: (value: number) => string;
  /** The plot rows asked for where the layout does not decide. Defaults to 8. */
  height?: number;
  /** Whether to write each labelled series under the chart. Defaults to whether any has a label. */
  legend?: boolean;
  /** Which role the first series takes when it names none. Defaults to `accent`. */
  role?: ChartRole;
  /** Several series, each `{ data, label, role }`. */
  series?: readonly LineChartSeries[];
  /**
   * Dot columns between two samples, two to a cell, with the latest at the right
   * edge; or `fit` to spread every sample across the width. Defaults to `1`.
   */
  step?: number | 'fit';
  /** The columns asked for where the layout does not decide. Defaults to 40. */
  width?: number;
  /** What the first and last points are, set under the axis. */
  xLabels?: ChartSource<readonly [string, string] | undefined>;
}

/** A line chart with no crosshair, which owns no key, so `props` may carry an `onKey`. */
export interface PlainLineChartProps extends LineChartBase {
  crosshair?: undefined;
  /** Letters belong to the crosshair, so a chart with none takes none. */
  vim?: false;
}

/**
 * A line chart with a crosshair, which owns `onKey`: the type leaves it out of
 * `props`, as every component that owns a hook does, and `LineChart()` refuses one
 * where it is built for a caller the type does not reach.
 */
export interface CrosshairLineChartProps extends LineChartBase {
  /**
   * A rule down the plot at the sample under the pointer, and a tooltip beside it
   * saying each series' value there. It needs the router's `mouse.motion`, since
   * without it nothing knows where the pointer is; the readout is `attachTooltip()`
   * pointed at the rule, so it shows at once unless `delay` says otherwise, flips
   * where there is no room, and goes with the component. Defaults to none.
   *
   * A chart with one takes the focus, so it is not left to a pointer: while it
   * has the focus the rule stands at the newest sample, Left and Right step it to
   * the sample before and after, and the readout says what it says for the
   * pointer. It owns `onKey`, so `props` may not carry one, and
   * `describeLineChart()` lists the keys for a footer.
   *
   * Home and End jump to the oldest and newest sample drawn, and Enter pins the
   * sample the rule is on, so that it stands there, with its readout, while the
   * chart has not the focus and the pointer is not over it; Enter again unpins
   * it. A refocus starts at the pinned sample, and while the rule is on another
   * the pin is marked on the plot and the axis (`.sigil-chart-pin`).
   */
  crosshair: LineChartCrosshair;
  /** The chart's own props, without the three hooks it owns. */
  props?: ElementPropsWithout<'onKey' | 'onLayout' | 'onResize'>;
  /**
   * `h` and `l` to step the rule as Left and Right do, which is vim's spelling and
   * the treemap's `vim` less its `j` and `k`: a chart has no up and down. Off by
   * default, as the treemap's is: a letter the chart takes is one the app cannot
   * bind while the chart has the focus.
   */
  vim?: boolean;
}

/**
 * What `LineChart()` takes. A chart with a `crosshair` is a different type from
 * one without, because it owns a key and the other does not.
 */
export type LineChartProps = CrosshairLineChartProps | PlainLineChartProps;

export interface BarChartProps extends ChartElementProps, ScaleOptions {
  /** The width of a vertical bar. Defaults to sharing the width out between the bars. */
  barWidth?: number;
  /** The bars: `{ label, value }` in a list, or an object of numbers. */
  data: ChartSource<BarData>;
  /** `horizontal` bars grow rightwards, `vertical` upwards. Defaults to `horizontal`. */
  direction?: 'horizontal' | 'vertical';
  /** How a number is written. Defaults to at most two decimals. */
  format?: (value: number) => string;
  /** The columns between one vertical bar and the next. Defaults to 1. */
  gap?: number;
  /**
   * The rows asked for where the layout does not decide: the bars' own for a
   * vertical chart, which defaults to 8, and a row a bar for a horizontal one.
   */
  height?: number;
  /** The widest a label may be before it is cut. Defaults to its own width. */
  labelWidth?: number;
  /** Which role colours the bars. Defaults to `accent`. */
  role?: ChartRole;
  /** Whether to write each value. Defaults to true. */
  showValues?: boolean;
  /**
   * The columns asked for where the layout does not decide. Defaults to 40
   * across, and to the bars' own width upwards.
   */
  width?: number;
}

export interface GaugeProps extends ChartElementProps, ScaleOptions {
  /** A figure to write in place of the percentage, such as `512 MiB / 1 GiB`. */
  detail?: ChartSource<string | undefined>;
  /** A label before the bar. */
  label?: ChartSource<string | undefined>;
  /** Which role colours the bar below the thresholds. Defaults to `accent`. */
  role?: ChartRole;
  /** `block` is a bar like `progress()`'s; `line` is a thin one. Defaults to `block`. */
  style?: 'block' | 'line';
  /** The ratios at which the bar changes role, as `gauge()` takes them. */
  thresholds?: { error?: number; warn?: number };
  /** How full, between `min` and `max`. */
  value: ChartSource<number>;
  /**
   * The columns asked for where the layout does not decide. Defaults to a bar of
   * 20 with its label and its figure.
   */
  width?: number;
}

/** A size in cells. */
interface Size {
  readonly height: number;
  readonly width: number;
}

/**
 * A size setting, refused where it is not one.
 *
 * @param who - The component, for the message.
 * @param name - The setting.
 * @param value - What was given.
 */
function checkCells(who: string, name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isSafeInteger(value) && value >= 1)) {
    throw new RangeError(
      `Invalid ${who} ${name} ${String(value)}: expected a whole number of cells, at least 1`
    );
  }
}

/**
 * The host every live chart is: a box the layout sizes, a measure of what it asks
 * for, and the rows drawn at the size it got.
 *
 * The rows are in an absolutely placed body, so they take no space: what the box
 * asks the layout for is the `raw` beside them, which measures the chart's
 * requested size and paints nothing, with both minimums zero. That is what keeps
 * the size the layout's. A chart whose rows were in flow would ask for the size it
 * was last drawn at, so a row that squeezed it once would have it ask for the
 * squeezed size from then on -- the text field's SIG-318, in a second component.
 *
 * @param who - The component, for its messages.
 * @param kind - The chart's kind, which names its classes.
 * @param props - The chart's props.
 * @param ask - What it asks for, read in the effect so that a change in the data
 *   can change it.
 * @param drawAt - The drawing at a size, read in the effect so that it subscribes.
 * @param attach - Called with the host and the body the rows are drawn in, before
 *   the first drawing: what a chart that follows the pointer hangs its tooltip on.
 * @returns The host.
 */
function liveChart(
  who: string,
  kind: string,
  props: ChartElementProps,
  ask: () => Size,
  drawAt: (size: Size) => Drawing,
  attach?: (host: Element, body: Element) => void
): Element {
  refuseOwnedHooks(who, props.props, ['onResize']);
  if (props.class !== undefined && typeof props.class !== 'string') {
    throw new TypeError(`Expected a ${who} class to be a string`);
  }

  let asked: Size = { height: 1, width: 1 };
  const sizer = raw(
    {
      measure: (available) => ({
        height: asked.height,
        minHeight: 0,
        minWidth: 0,
        width: Math.min(asked.width, Math.max(0, Math.floor(available))),
      }),
      paint: () => {},
    },
    { class: 'sigil-chart-sizer' }
  );
  const body = box({
    class: 'sigil-chart-body',
    'flex-direction': 'column',
    left: 0,
    position: 'absolute',
    top: 0,
  });
  const host = box({
    // a positioned box, so the body is placed against it; before the caller's,
    // since an absolutely placed chart is one too
    position: 'relative',
    ...props.props,
    'flex-direction': 'column',
    'min-height': 0,
    'min-width': 0,
    overflow: 'hidden',
  });
  // added rather than written into the props, so an app's own `class` is kept
  host.addClass('sigil-chart');
  host.addClass(`sigil-chart-${kind}`);
  for (const cls of (props.class ?? '').split(/\s+/)) {
    if (cls !== '') {
      host.addClass(cls);
    }
  }
  host.append(sizer, body);

  /** The size the layout gave, once it has. */
  let size: Size | undefined;
  /** Each row drawn, and what was drawn in it, so a row that did not change is left alone. */
  const rows: { element: Element; signature: string | undefined }[] = [];

  /**
   * Draws the chart at the size it has, or at the size it asks for until it has
   * one.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  const draw = (): boolean => {
    let changed = false;
    const next = ask();
    if (next.width !== asked.width || next.height !== asked.height) {
      asked = next;
      sizer.invalidateMeasure();
      changed = true;
    }

    const at = size ?? asked;
    const drawing = at.width > 0 && at.height > 0 ? drawAt(at) : { kind, rows: [] };
    drawing.rows.forEach((row, i) => {
      const segments = drawnSegments(row);
      const signature = segments.map((s) => `${s.role ?? ''}\u0001${s.text}`).join('\u0002');
      let held = rows[i];
      if (held === undefined) {
        held = { element: box({ class: `sigil-chart-${kind}-row` }), signature: undefined };
        rows.push(held);
        body.append(held.element);
        changed = true;
      }
      if (held.signature !== signature) {
        for (const child of held.element.children.slice()) {
          held.element.removeChild(child);
        }
        for (const segment of segments) {
          held.element.append(segmentNode(kind, segment));
        }
        held.signature = signature;
        changed = true;
      }
    });
    while (rows.length > drawing.rows.length) {
      body.removeChild((rows.pop() as { element: Element }).element);
      changed = true;
    }
    return changed;
  };

  host.onResize = (element): boolean => {
    const got = element.content ?? element.box;
    if (got === undefined) {
      return false;
    }
    const next = {
      height: Math.max(0, Math.floor(got.height)),
      width: Math.max(0, Math.floor(got.width)),
    };
    if (size !== undefined && size.width === next.width && size.height === next.height) {
      return false;
    }
    size = next;
    return draw();
  };

  attach?.(host, body);
  createEffect(() => {
    draw();
  });

  return host;
}

/**
 * A sparkline as a live element: one column per sample, the latest at the right,
 * as wide and as tall as the layout made it.
 *
 * One row is the eight block heights `sparkline()` prints. Taller, each column is
 * the same eighths stacked, so a sparkline three rows tall has twenty-four heights
 * -- the block graph btop draws. A series shorter than the width leaves the left
 * blank rather than stretching, so the history fills in from the right as it
 * arrives; a longer one shows its latest end, and the scale is what is shown
 * unless `min` and `max` are given.
 *
 * @param props - The data, the scale, the role and the size asked for.
 * @returns The chart's host.
 */
export function Sparkline(props: SparklineProps): Element {
  checkCells('sparkline', 'width', props.width);
  checkCells('sparkline', 'height', props.height);
  if (props.data === undefined || props.data === null) {
    throw new TypeError('Expected a sparkline to have data');
  }
  const ascii = props.ascii ?? !unicodeSupported();

  return liveChart(
    'Sparkline',
    'sparkline',
    props,
    () => ({
      height: props.height ?? 1,
      width: Math.max(
        1,
        props.width ??
          (props.data instanceof Series ? props.data.capacity : read(props.data).length)
      ),
    }),
    (size) => ({
      kind: 'sparkline',
      rows: sparkRows(read(props.data), {
        ascii,
        columns: size.width,
        fill: true,
        max: props.max,
        min: props.min,
        role: roleOf(props),
        rows: size.height,
      }),
    })
  );
}

/**
 * A line chart as a live element: braille, two samples to a cell, at the size the
 * layout gave it.
 *
 * The latest sample is at the right edge and each one before it a dot column
 * further left, so the line scrolls as it is pushed to and the history that does
 * not fit is cut from the left; `step` spaces them further apart, and
 * `step: 'fit'` spreads a whole series across the width the way `lineChart()`
 * does. Several series share the plot, each in its own role, with a legend under
 * the axis when any has a label. The rows the axis and the legend do not take are
 * the plot's. `fill` shades under the lines, and `crosshair` follows the pointer
 * with a rule down the plot and a tooltip saying the values under it.
 *
 * @param props - The series, the scale, the axes and the size asked for.
 * @returns The chart's host.
 */
export function LineChart(props: LineChartProps): Element {
  checkCells('line chart', 'width', props.width);
  checkCells('line chart', 'height', props.height);
  const step = stepOf(props.step, 1);
  if (props.series === undefined && (props.data === undefined || props.data === null)) {
    throw new TypeError('Expected a line chart to have data or series');
  }
  if (props.series !== undefined && !Array.isArray(props.series)) {
    throw new TypeError('Expected line chart series to be an array of { data, label, role }');
  }
  const crosshair = props.crosshair;
  if (crosshair !== undefined && (typeof crosshair !== 'object' || crosshair === null)) {
    throw new TypeError('Expected a line chart crosshair to be an object of tooltip options');
  }
  if (crosshair?.text !== undefined && typeof crosshair.text !== 'function') {
    throw new TypeError('Expected line chart crosshair text to be a function');
  }
  if (crosshair !== undefined) {
    refuseOwnedHooks('LineChart', props.props, ['onKey', 'onLayout']);
  }
  if (props.vim !== undefined && typeof props.vim !== 'boolean') {
    throw new TypeError('Expected line chart vim to be a boolean');
  }
  if (props.vim === true && crosshair === undefined) {
    throw new TypeError('Expected a line chart with vim to have a crosshair, which owns the keys');
  }
  const vim = props.vim === true;
  const list: readonly LineChartSeries[] = props.series ?? [
    { data: props.data as ChartSource<readonly number[]> },
  ];
  const ascii = props.ascii ?? !unicodeSupported();
  const axis = props.axis !== false;
  const legend = props.legend ?? list.some((s) => s.label !== undefined && s.label !== '');
  const format = props.format ?? formatNumber;

  /** The cell column the pointer is over, from the body's left edge, while it is over the chart. */
  const pointer = crosshair === undefined ? undefined : new State<number | undefined>(undefined);
  /** The crosshair's cells, relative to the host's box, for the tooltip to point at. */
  const pointed = crosshair === undefined ? undefined : new State<Box | undefined>(undefined);
  /**
   * How many samples before the newest the keyboard stands on while the chart has
   * the focus, or `undefined` for the newest. Counted from the newest so that a
   * live chart keeps it where it is on the screen as samples arrive, as the
   * pointer's column is.
   */
  const back = crosshair === undefined ? undefined : new State<number | undefined>(undefined);
  /**
   * The sample the rule rests on when the keyboard is not on the chart, counted back
   * from the newest as `back` is, or `undefined` for none. Enter sets and clears it;
   * the focus starts from it and a blur returns to it.
   */
  const pinned = crosshair === undefined ? undefined : new State<number | undefined>(undefined);
  let tip: TooltipHandle | undefined;
  let host: Element | undefined;
  let body: Element | undefined;
  /** What the readout last said, so a crosshair that did not move does not set it again. */
  let said = '';
  /** The sample the crosshair was last drawn on, which a pointer's key steps from. */
  let shown: number | undefined;
  /** The samples the chart last drew, which a key steps between. */
  let samples: SamplesDrawn | undefined;
  /** What the chart last drew, which a layout that moved the screen or the chart says again. */
  let drawn: Drawing | undefined;
  /** What `text()` said for it, kept so a layout does not ask a caller's function again. */
  let spoken = '';

  /** Whether the keys go to the chart: a signal, so a drawing that read it is redone when it moves. */
  const focused = (): boolean => {
    const at = crosshair?.input.focus.current.get();
    return at !== undefined && host !== undefined && host.contains(at);
  };

  /** The default readout: each series with a value there, by its label. */
  const readout = (_index: number, values: readonly (number | undefined)[]): string =>
    values
      .flatMap((value, i) => {
        if (value === undefined) {
          return [];
        }
        const label = list[i]?.label;
        return [label === undefined || label === '' ? format(value) : `${label} ${format(value)}`];
      })
      .join('\n');

  /**
   * Says what is under the crosshair, and where it is, after a drawing: the words
   * first, so the bubble that moves is the one that says them.
   *
   * @param drawing - What was drawn.
   * @param again - A layout saying the last drawing again: the words are the ones
   *   `text()` already said for it, since a function that reads a clock would
   *   otherwise never agree with itself and ask a pass of every layout.
   * @returns Whether it wrote the words or the area, which a layout owes a pass.
   */
  const follow = (drawing: Drawing, again = false): boolean => {
    if (crosshair === undefined || pointed === undefined) {
      return false;
    }
    const at = drawing.crosshair;
    shown = at?.index;
    samples = drawing.samples;
    let words = again
      ? spoken
      : at === undefined
        ? ''
        : (crosshair.text ?? readout)(at.index, at.values);
    if (typeof words !== 'string') {
      throw new TypeError('Expected line chart crosshair text to return a string');
    }
    drawn = drawing;
    spoken = words;
    const outer = host?.box;
    const inner = body?.box ?? outer;
    // the bubble is placed beside the rule, so a pin within its reach would be
    // under it: the rule's cell is widened to take in the pin's, which puts the
    // bubble past the pin on the far side, and past the rule where it flips. Above
    // or below the rule the bubble is not over the plot's top row, so it stays put
    // (40 is the tooltip's default cap, repeated because a chart is ejectable and
    // cannot import it: past it the text wraps, and a bubble wider than it is not)
    const widest = (text: string): number =>
      Math.max(0, ...text.split('\n').map((line) => stringWidth(line)));
    const reach = Math.min(crosshair.maxWidth ?? 40, 4 + widest(words));
    const pin = drawing.pinned;
    const beside =
      crosshair.side === undefined || crosshair.side === 'right' || crosshair.side === 'left';
    let span: { from: number; width: number } | undefined =
      at === undefined ? undefined : { from: at.column, width: 1 };
    if (
      at !== undefined &&
      pin !== undefined &&
      beside &&
      words !== '' &&
      Math.abs(pin - at.column) <= reach
    ) {
      span = { from: Math.min(pin, at.column), width: Math.abs(pin - at.column) + 1 };
    }
    // and the tooltip puts the bubble on whichever side of that has room, and
    // clamps it inside the screen where neither does -- over the pin or the rule.
    // So where neither side has room for it, the words are cut to the room there
    // is: past the pin if the room beside the pin and the rule will take a bubble
    // of any use, and otherwise beside the rule alone, which is the one that keeps
    // its place and the pin is the one that gives way. A line is cut with an
    // ellipsis rather than wrapped, so the readout stays one line to a series
    if (at !== undefined && span !== undefined && outer !== undefined && inner !== undefined) {
      let root = host;
      while (root?.parent !== undefined) {
        root = root.parent;
      }
      const screen = root?.box;
      const room = (it: { from: number; width: number }): number =>
        screen === undefined
          ? Infinity
          : Math.max(
              inner.x + it.from - screen.x,
              screen.x + screen.width - (inner.x + it.from + it.width)
            );
      if (beside && words !== '' && room(span) < reach) {
        const rule = { from: at.column, width: 1 };
        // the widened span, if the room beside it fits at least a few cells of
        // words; else the rule alone, cut to whatever room it has
        span = room(span) - 4 >= MIN_READOUT ? span : rule;
        const cap = Math.max(1, room(span) - 4);
        if (widest(words) > cap) {
          words = words
            .split('\n')
            .map((line) => truncate(line, cap, 'ellipsis'))
            .join('\n');
        }
      }
    }
    let changed = false;
    if (words !== said) {
      // an empty string hides the bubble, which is the tooltip's own rule
      changed = true;
      said = words;
      tip?.setText(words);
    }
    const next =
      at === undefined || outer === undefined || inner === undefined || span === undefined
        ? undefined
        : {
            height: at.rows,
            width: span.width,
            x: span.from + inner.x - outer.x,
            y: inner.y - outer.y,
          };
    const was = untrack(() => pointed.get());
    if (
      next?.x !== was?.x ||
      next?.y !== was?.y ||
      next?.width !== was?.width ||
      next?.height !== was?.height
    ) {
      changed = true;
      pointed.set(next);
    }
    return changed;
  };

  /** The rows that are not the plot's, given the x labels. */
  const extra = (xLabels: readonly [string, string] | undefined): number =>
    (axis ? 1 : 0) +
    (axis && xLabels !== undefined && (xLabels[0] !== '' || xLabels[1] !== '') ? 1 : 0) +
    (legend ? 1 : 0);

  const chart = liveChart(
    'LineChart',
    'line',
    // focusable with a crosshair, and `focusable: false` in the caller's props
    // takes it back, as a treemap's does
    crosshair === undefined ? props : { ...props, props: { focusable: true, ...props.props } },
    () => ({
      height: (props.height ?? DEFAULT_HEIGHT) + extra(read(props.xLabels)),
      width: props.width ?? DEFAULT_WIDTH,
    }),
    (size) => {
      const xLabels = read(props.xLabels);
      const hasFocus = crosshair !== undefined && focused();
      // read always, so a pin set or cleared redraws a chart whose keyboard
      // sample already says where the rule is
      const pinnedAt = pinned?.get();
      const drawing = lineDrawing(plotSeries(list, props.role, props.fill), {
        ascii,
        axis,
        back: hasFocus ? (back?.get() ?? pinnedAt ?? 0) : pinnedAt,
        focused: hasFocus,
        format,
        height: Math.max(1, size.height - extra(xLabels)),
        legend,
        max: props.max,
        min: props.min,
        pinned: pinnedAt,
        pointer: pointer?.get(),
        step,
        width: size.width,
        xLabels,
      });
      follow(drawing);
      return drawing;
    },
    crosshair === undefined
      ? undefined
      : (outer, inner) => {
          host = outer;
          body = inner;
          const input = crosshair.input;
          // the readout's room and the widened area are read from the boxes of the
          // last layout, and a terminal resized with the chart's own size unchanged
          // runs no drawing: so each layout asks again, and `follow()` writes only what
          // moved, and says whether it did, which is a layout owed. Untracked, since
          // a layout may be run from inside something that tracks and the caller's
          // `text()` is not ours to subscribe it to
          outer.onLayout = (): boolean => {
            const was = drawn;
            return was !== undefined && untrack(() => follow(was, true));
          };
          // the bubble is the tooltip's, pointed at the rule: at once by default,
          // since a readout that lags the rule it reads is a readout of where the
          // pointer was, and on the right, where a reader's eye is already going
          tip = attachTooltip(outer, {
            ...crosshair,
            area: () => pointed?.get(),
            hold: () => pinned?.get() !== undefined,
            ascii: crosshair.ascii ?? props.ascii,
            delay: crosshair.delay ?? 0,
            side: crosshair.side ?? 'right',
            text: '',
          });
          // every report the tree did not stop, read against the router's own
          // `hover` state, as the tooltip reads it: written under `mouse.motion`
          // alone, and already false when the pointer has left. The bubble sits
          // flush against the rule, so a pointer moving on across the plot moves
          // onto it -- and is then over the bubble rather than the chart, by the
          // hit test, while still inside the chart's box. That is still the
          // chart's pointer: otherwise the rule would stop where the bubble
          // starts and a pointer could never get past it
          const off = input.onMouse((event) => {
            const at = inner.box;
            const area = outer.box;
            const over =
              outer.states.includes('hover') ||
              (tip?.element?.states.includes('hover') === true &&
                area !== undefined &&
                event.x >= area.x &&
                event.x < area.x + area.width &&
                event.y >= area.y &&
                event.y < area.y + area.height);
            const next = at !== undefined && over ? Math.floor(event.x - at.x) : undefined;
            if (next !== untrack(() => pointer?.get())) {
              pointer?.set(next);
            }
          });
          onCleanup(off);

          // Left and Right (and `h` and `l` with `vim`) step the rule one sample, and
          // Home and End take it to the oldest drawn and the newest, from where it
          // is drawn -- the pointer's or the keyboard's -- and it is the keyboard's
          // from then on, until the pointer moves again. Enter pins the sample it
          // stands on, or unpins it where it is already pinned there. Claimed
          // even at the end of the series, a list's rule for Down on its last row;
          // Shift, Ctrl and Alt are left for what is around the chart, and with
          // nothing drawn no key is the chart's
          outer.onKey = (event: KeyEvent): void => {
            const k = event.key;
            if (event.paste || k.ctrl || k.meta || k.shift || samples === undefined) {
              return;
            }
            const name = vim ? (VIM_LETTERS.get(k.name) ?? k.name) : k.name;
            const way = name === 'left' ? -1 : name === 'right' ? 1 : 0;
            if (way === 0 && name !== 'home' && name !== 'end' && name !== 'enter') {
              return;
            }
            event.stop();
            const { count, first } = samples;
            // From the sample the pointer's rule is on where the pointer has
            // moved since the last key, and otherwise from the keyboard's own,
            // since keys can arrive faster than frames and the drawing is one
            // behind them; from the pinned one, or the newest, where nothing was
            // pressed yet. Held to the samples there are, which data shrinking
            // under a large `back` would otherwise leave beyond the first.
            const held = untrack(() => back?.get() ?? pinned?.get());
            const from =
              untrack(() => pointer?.get()) !== undefined && shown !== undefined
                ? shown
                : count - 1 - (held ?? 0);
            const at = Math.min(count - 1, Math.max(first, from));
            const index =
              name === 'home'
                ? first
                : name === 'end'
                  ? count - 1
                  : Math.min(count - 1, Math.max(first, at + way));
            if (name === 'enter') {
              // a pin counted back past the oldest drawn stands on the oldest
              const pin = untrack(() => pinned?.get());
              const here = count - 1 - at;
              pinned?.set(
                pin !== undefined && Math.min(pin, count - 1 - first) === here ? undefined : here
              );
            }
            back?.set(count - 1 - index);
            pointer?.set(undefined);
          };
          // the keyboard's sample is forgotten with the focus, so the next one
          // starts at the newest again
          createEffect(() => {
            if (!focused() && untrack(() => back?.get()) !== undefined) {
              back?.set(undefined);
            }
          });
        }
  );
  if (crosshair !== undefined) {
    CHARTS.set(chart, { vim });
  }
  return chart;
}

/** What `vim: true` adds: `h` and `l`, as the arrows they stand for. */
const VIM_LETTERS = new Map<string, string>([
  ['h', 'left'],
  ['l', 'right'],
]);

/** Each line chart `LineChart()` built with a crosshair, and whether it takes `vim`: what `describeLineChart()` accepts. */
const CHARTS = new WeakMap<Element, { readonly vim: boolean }>();

/** Where a line chart's keys are described, which is the whole of what is asked of a router. */
export interface LineChartDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/**
 * Describes a line chart's keys to a router, for a key-help footer.
 *
 * Scoped to the chart, which is the element whose focus makes the keys apply:
 * Left and Right, as `move`, and `h` and `l` after them where the chart is `vim`;
 * Home and End, as `oldest` and `newest`; and Enter, as `pin`.
 *
 * @param router - What to describe the keys to.
 * @param charts - Hosts that `LineChart()` returned with a `crosshair`.
 * @returns Takes every description back off.
 */
export function describeLineChart(
  router: LineChartDescriber,
  ...charts: readonly Element[]
): () => void {
  for (const chart of charts) {
    if (!CHARTS.has(chart)) {
      throw new TypeError(`Expected an element that LineChart() returned with a crosshair`);
    }
  }
  const off: Array<() => void> = [];
  for (const scope of charts) {
    const say = (spec: string, description: string, priority: number): void => {
      off.push(router.describe(spec, { description, priority, scope }));
    };
    say('left', __`move`, 1);
    say('right', __`move`, 1);
    if (CHARTS.get(scope)?.vim === true) {
      // in the arrows' order, so the line reads each letter against its arrow
      say('h', __`move`, 1);
      say('l', __`move`, 1);
    }
    say('home', __`oldest`, 1);
    say('end', __`newest`, 1);
    say('enter', __`pin`, 2);
  }
  return () => {
    for (const fn of off) {
      fn();
    }
  };
}

/**
 * A bar chart as a live element, fitted to the size the layout gave it.
 *
 * Across, the bars take the width the labels and the values leave, a row each.
 * Upwards, they take the height the values and the labels leave, and share the
 * width out between them unless `barWidth` says otherwise.
 *
 * @param props - The bars, the direction, the scale and the size asked for.
 * @returns The chart's host.
 */
export function BarChart(props: BarChartProps): Element {
  checkCells('bar chart', 'width', props.width);
  checkCells('bar chart', 'height', props.height);
  checkCells('bar chart', 'barWidth', props.barWidth);
  if (props.data === undefined || props.data === null) {
    throw new TypeError('Expected a bar chart to have data');
  }
  const ascii = props.ascii ?? !unicodeSupported();
  const vertical = props.direction === 'vertical';
  // the values' row and the labels' under a vertical chart
  const below = (props.showValues !== false ? 1 : 0) + 1;
  const gap = gapOf(props);

  return liveChart(
    'BarChart',
    'bar',
    props,
    () => {
      const list = datums(read(props.data));
      if (!vertical) {
        return {
          height: props.height ?? Math.max(1, list.length),
          width: props.width ?? DEFAULT_WIDTH,
        };
      }
      const column = props.barWidth ?? naturalColumn(list, props);
      return {
        height: (props.height ?? DEFAULT_HEIGHT) + below,
        width: props.width ?? Math.max(1, list.length * column + gap * (list.length - 1)),
      };
    },
    (size) => {
      const list = datums(read(props.data));
      const shared = Math.floor((size.width - gap * Math.max(0, list.length - 1)) / list.length);
      return barDrawing(list, {
        ascii,
        barWidth: vertical ? (props.barWidth ?? Math.max(1, shared)) : undefined,
        direction: props.direction,
        format: props.format,
        gap: props.gap,
        height: vertical ? Math.max(1, size.height - below) : undefined,
        labelWidth: props.labelWidth,
        max: props.max,
        min: props.min,
        role: props.role,
        showValues: props.showValues,
        width: size.width,
      });
    }
  );
}

/**
 * A gauge as a live element: the bar takes the width its label and its figure
 * leave.
 *
 * The percentage is padded to four columns, so the bar does not move a cell as the
 * reading goes from 9% to 10%; a `detail` the app writes is its own width.
 *
 * @param props - The value, the label, the thresholds and the size asked for.
 * @returns The chart's host.
 */
export function Gauge(props: GaugeProps): Element {
  checkCells('gauge', 'width', props.width);
  gaugeRange(props);
  const ascii = props.ascii ?? !unicodeSupported();

  /** The columns the label and the figure take, around the bar. */
  const around = (label: string | undefined, detail: string | undefined): number =>
    (label ? stringWidth(labelLine(label)) + 1 : 0) +
    1 +
    (detail === undefined ? 4 : stringWidth(labelLine(detail)));

  return liveChart(
    'Gauge',
    'gauge',
    props,
    () => ({
      height: 1,
      width: props.width ?? around(read(props.label), read(props.detail)) + DEFAULT_GAUGE_BAR,
    }),
    (size) => {
      const label = read(props.label);
      const detail = read(props.detail);
      return gaugeDrawing(
        read(props.value),
        {
          ascii,
          detail,
          label,
          max: props.max,
          min: props.min,
          role: props.role,
          style: props.style,
          thresholds: props.thresholds,
          width: Math.max(1, size.width - around(label, detail)),
        },
        4
      );
    }
  );
}
