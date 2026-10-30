/**
 * A calendar: one month as a grid of days, printed or picked from.
 *
 * Three faces over one grid. `calendar()` returns the month as a string, the way
 * `table()` and `note()` do. `pickDate()` is a prompt that asks for a day by
 * moving through the month. And `calendarGrid()` is the grid itself, built once
 * and updated in place, which is what the date prompt shows beneath its field.
 * See "A calendar" in this directory's AGENTS.md.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { __, locale as i18nLocale } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { daysInMonth } from '../util/transform.js';
import { truncate } from '../wrap/index.js';
import {
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  runPrompt,
} from './prompt.js';

/** The fields a month grid takes from the caller, whichever face it is drawn with. */
export interface CalendarGridOptions {
  /**
   * Days to mark, as `Date`s. Only the day is read, in local time. A marked day
   * carries a `*` after its number, so it survives a terminal with no
   * colour, and the `sigil-calendar-highlight` role besides.
   */
  highlight?: readonly Date[];
  /**
   * The language month and weekday names are written in, as a BCP 47 tag.
   * Defaults to the locale the app's catalog resolved, else the system's.
   */
  locale?: string;
  /**
   * The weekday a row starts on: 0 is Sunday, 1 is Monday, up to 6. Defaults to
   * what the locale says, and to Sunday where the runtime cannot say.
   */
  weekStart?: number;
}

export interface CalendarOptions extends CalendarGridOptions, StyledOptions {
  /** Any day in the month to show. Defaults to today. */
  date?: Date;
  /** How far the whole block is indented. Defaults to 0. */
  indent?: number;
  /** The selected day, drawn in reverse and set in `[]`. Defaults to none. */
  selected?: Date;
}

export interface PickDateOptions extends CalendarGridOptions, PromptOptions {
  /**
   * The day the cursor starts on. Defaults to today. One outside `min` and `max`
   * is moved to the nearest bound.
   */
  initial?: Date;
  /** The latest day that can be picked, inclusive. */
  max?: Date;
  /** The earliest day that can be picked, inclusive. */
  min?: Date;
}

/** A calendar day. The month is 1-12, as in the parser's `date` type. */
export interface Day {
  day: number;
  month: number;
  year: number;
}

/** A column is an opening mark, two digits and a closing mark. */
const CELL = 4;
const COLUMNS = 7;
/** The most rows a month can take: 31 days starting on the last column. */
const ROWS = 6;
/** What a grid is wide, which is also the width of its title. */
const WIDTH = CELL * COLUMNS;

/**
 * A day as one number that sorts the way days do.
 *
 * @param d - The day.
 * @returns The key.
 */
export function dayKey(d: Day): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

/**
 * A local `Date`, with the year taken whole.
 *
 * `new Date(y, m, d)` reads a year under 100 as 19xx, and the parser's `date`
 * type accepts `0000`-`9999`. Setting the year afterwards is the spelling that
 * does not, and an overflowing month or day carries as it does for the
 * constructor.
 *
 * @param year - The full year.
 * @param month - The month, 1-12; out of range carries into the year.
 * @param day - The day; out of range carries into the month.
 * @returns Midnight local time.
 */
export function localDate(year: number, month: number, day: number): Date {
  const d = new Date(2000, 0, 1);
  d.setFullYear(year, month - 1, day);
  return d;
}

/**
 * A `Date` as the day it falls on, by the local getters.
 *
 * @param d - The date.
 * @returns The day.
 */
export function dayOf(d: Date): Day {
  return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
}

/**
 * A day some days away.
 *
 * @param d - The day.
 * @param days - How many days to move, negative for earlier.
 * @returns The day, which may be in another month.
 */
export function addDays(d: Day, days: number): Day {
  return dayOf(localDate(d.year, d.month, d.day + days));
}

/**
 * A day some months away, in the same position in the month.
 *
 * The day is pulled back to the last day of a shorter month rather than carried
 * into the next, so the 31st of January a month on is the 28th or 29th of
 * February and not a day in March. The year stays inside 0-9999, the range the
 * parser reads.
 *
 * @param d - The day.
 * @param months - How many months to move, negative for earlier.
 * @returns The day.
 */
export function addMonths(d: Day, months: number): Day {
  const index = Math.max(0, Math.min(9999 * 12 + 11, d.year * 12 + d.month - 1 + months));
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { day: Math.min(d.day, daysInMonth(year, month)), month, year };
}

/** Which weekday a day falls on, 0 being Sunday. */
function weekdayOf(year: number, month: number, day: number): number {
  return localDate(year, month, day).getDay();
}

/** The first weekday a locale's weeks start on, or Sunday where it cannot be read. */
function localeWeekStart(tag: string | undefined): number {
  try {
    const info = new Intl.Locale(
      tag ?? new Intl.DateTimeFormat().resolvedOptions().locale
    ) as unknown as {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    // Intl numbers Monday 1 to Sunday 7
    return first === undefined ? 0 : first % 7;
  } catch {
    return 0;
  }
}

/** What the grid needs from its caller before it is drawn. */
interface GridConfig {
  highlight: ReadonlySet<number>;
  /** Writes a month and year as a title. */
  title: (year: number, month: number) => string;
  /** Two-column weekday names, starting on the first column's day. */
  weekdays: string[];
  weekStart: number;
}

/**
 * Reads and checks the options every face of the calendar shares.
 *
 * @param opts - The caller's options.
 * @returns What the grid is built from.
 * @throws If a date is not a valid `Date`, `weekStart` is not 0-6, or the locale
 *   is not a language tag.
 */
function readConfig(opts: CalendarGridOptions): GridConfig {
  const highlight = new Set<number>();
  for (const value of opts.highlight ?? []) {
    checkDate('highlight', value);
    highlight.add(dayKey(dayOf(value)));
  }

  if (
    opts.weekStart !== undefined &&
    !(Number.isInteger(opts.weekStart) && opts.weekStart >= 0 && opts.weekStart <= 6)
  ) {
    throw new RangeError(__`Expected weekStart to be an integer from 0 to 6`);
  }

  const tag = opts.locale ?? i18nLocale();
  let titles: Intl.DateTimeFormat;
  let names: Intl.DateTimeFormat;

  try {
    // the Gregorian calendar and Western digits whatever the locale prefers: the
    // numbers in the cells are Gregorian days written with `String()`, and a
    // title in the Buddhist year over them would be a different month's worth
    // of nonsense
    titles = new Intl.DateTimeFormat(tag, {
      calendar: 'gregory',
      month: 'long',
      numberingSystem: 'latn',
      year: 'numeric',
    });
    names = new Intl.DateTimeFormat(tag, {
      calendar: 'gregory',
      numberingSystem: 'latn',
      weekday: 'short',
    });
  } catch {
    throw new TypeError(__`Expected locale to be a valid language tag`);
  }

  const weekStart = opts.weekStart ?? localeWeekStart(tag);

  return {
    highlight,
    title: (year, month) => titles.format(localDate(year, month, 1)),
    // 2023-01-01 was a Sunday; a short name may be three letters or end in a
    // dot, and a column holds two
    weekdays: Array.from({ length: COLUMNS }, (_, i) =>
      truncate(
        names
          .format(localDate(2023, 1, 1 + ((weekStart + i) % COLUMNS)))
          .replace(/\.$/, '')
          .trim(),
        CELL - 2,
        'clip'
      )
    ),
    weekStart,
  };
}

/** Throws unless a value is a `Date` that is a time. */
function checkDate(name: string, value: unknown): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(__`Expected ${name} to be a valid Date`);
  }
}

/** What a grid is told to show. */
export interface GridView {
  /** The latest day that may be chosen, as a `dayKey()`. Later days are dimmed. */
  max?: number;
  /** The earliest day that may be chosen, as a `dayKey()`. Earlier days are dimmed. */
  min?: number;
  /** The month, 1-12. */
  month: number;
  /** The selected day, as a `dayKey()`. */
  selected?: number;
  /**
   * Whether to keep all six rows, empty or not. A grid being navigated has to,
   * or the lines under it move as the month changes.
   */
  stable?: boolean;
  year: number;
}

/** A grid built once, which is told what to show as often as that changes. */
export interface CalendarGrid {
  element: Element;
  /** The columns it takes, not counting an indent. */
  width: number;
  update(view: GridView): void;
}

/**
 * Builds the grid of a month.
 *
 * Fixed in shape -- a title, a row of weekdays and six rows of seven cells --
 * and changed by writing into the nodes it already has, so a prompt that moves
 * through a month is setting text rather than building a tree per key. A row the
 * month does not use is hidden or left empty, as `stable` says.
 *
 * @param opts - Names, week start and highlighted days.
 * @param indent - Columns to push the whole block right by.
 * @returns The element, and how to change what it shows.
 * @throws As `readConfig()`.
 */
export function calendarGrid(opts: CalendarGridOptions, indent = 0): CalendarGrid {
  const config = readConfig(opts);
  const title = textNode('', {
    class: 'sigil-calendar-title sigil-heading',
    'text-align': 'center',
    width: WIDTH,
  });
  const rows: Element[] = [];
  const cells: Element[][] = [];

  for (let r = 0; r < ROWS; r++) {
    const row: Element[] = [];
    for (let c = 0; c < COLUMNS; c++) {
      row.push(textNode('', { 'flex-shrink': 0, 'white-space': 'pre', width: CELL }));
    }
    cells.push(row);
    rows.push(box({ class: 'sigil-calendar-week', 'flex-direction': 'row' }, ...row));
  }

  const element = box(
    {
      class: 'sigil-calendar',
      'flex-direction': 'column',
      'flex-shrink': 0,
      'padding-left': Math.max(0, Math.floor(indent)),
    },
    title,
    box(
      { class: 'sigil-calendar-weekdays sigil-muted', 'flex-direction': 'row' },
      ...config.weekdays.map((name) =>
        textNode(` ${name}`, { 'flex-shrink': 0, 'white-space': 'pre', width: CELL })
      )
    ),
    ...rows
  );

  return {
    element,
    update(view): void {
      title.setText(config.title(view.year, view.month));

      const offset = (weekdayOf(view.year, view.month, 1) - config.weekStart + COLUMNS) % COLUMNS;
      const days = daysInMonth(view.year, view.month);
      const used = Math.ceil((offset + days) / COLUMNS);

      for (let r = 0; r < ROWS; r++) {
        rows[r].setProps({ display: r < used || view.stable ? 'flex' : 'none' });

        for (let c = 0; c < COLUMNS; c++) {
          const n = r * COLUMNS + c - offset + 1;
          const node = cells[r][c];

          if (n < 1 || n > days) {
            node.setText(' '.repeat(CELL));
            node.setProps({ class: '' });
            continue;
          }

          const key = dayKey({ day: n, month: view.month, year: view.year });
          const marked = config.highlight.has(key);
          const chosen = key === view.selected;
          const blocked =
            (view.min !== undefined && key < view.min) ||
            (view.max !== undefined && key > view.max);
          const classes = ['sigil-calendar-day'];

          if (marked) {
            classes.push('sigil-calendar-highlight', 'sigil-accent');
          }
          if (chosen) {
            classes.push('sigil-calendar-selected', 'sigil-caret');
          }
          if (blocked) {
            classes.push('sigil-calendar-disabled', 'sigil-muted');
          }

          // the marks around the digits are what say so with no colour at all; a
          // selected day that is also marked shows the selection, the one that moves
          node.setText(
            `${chosen ? '[' : ' '}${String(n).padStart(2)}${chosen ? ']' : marked ? '*' : ' '}`
          );
          node.setProps({ class: classes.join(' ') });
        }
      }
    },
    width: WIDTH + Math.max(0, Math.floor(indent)),
  };
}

/**
 * Builds the element tree for a month.
 *
 * @param opts - The month, the selected day, the highlighted ones.
 * @returns The tree, and the width it was built for.
 */
export function calendarView(opts: CalendarOptions = {}): { element: Element; width: number } {
  const shown = opts.date ?? new Date();
  checkDate('date', shown);
  if (opts.selected !== undefined) {
    checkDate('selected', opts.selected);
  }

  const grid = calendarGrid(opts, opts.indent);
  const at = dayOf(shown);
  grid.update({
    month: at.month,
    selected: opts.selected === undefined ? undefined : dayKey(dayOf(opts.selected)),
    year: at.year,
  });

  return { element: grid.element, width: grid.width };
}

/**
 * Draws one month so it can be printed.
 *
 * A facade over `calendarView()`, the way `note()` is over `noteView()`: it
 * returns a string and the caller does the writing, which is also why it
 * ignores `--quiet`.
 *
 * @param opts - The month, the selected day, the highlighted ones.
 * @returns The month, with no trailing newline.
 */
export function calendar(opts: CalendarOptions = {}): string {
  const { element, width } = calendarView(opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  });
}

/** `2024-06-05`, which is how the field and the answer are written. */
function isoOf(d: Day): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/**
 * Asks for a day by moving through a month.
 *
 * The arrow keys move a day or a week, Page Up and Page Down a month, Home and End to the first and last day of the month, and
 * Enter takes the day under the cursor. The answer is that day at local midnight.
 *
 * @param opts - What to ask, the range, and the days to mark.
 * @returns The day.
 */
export function pickDate(opts: PickDateOptions): Promise<Date> {
  const terminal = opts.terminal ?? defaultTerminal;

  try {
    for (const [name, value] of [
      ['initial', opts.initial],
      ['min', opts.min],
      ['max', opts.max],
    ] as const) {
      if (value !== undefined) {
        checkDate(name, value);
      }
    }
    // `calendarGrid()` reads this again; it is read here so a bad option rejects
    // before a terminal is touched
    readConfig(opts);
  } catch (error) {
    return Promise.reject(error);
  }

  const minDay = opts.min && dayOf(opts.min);
  const maxDay = opts.max && dayOf(opts.max);
  const min = minDay && dayKey(minDay);
  const max = maxDay && dayKey(maxDay);

  if (min !== undefined && max !== undefined && min > max) {
    return Promise.reject(new RangeError(__`Expected min to be no later than max`));
  }

  /** Pulls a day into the range, to the bound it went past. */
  function bounded(d: Day): Day {
    if (minDay && min !== undefined && dayKey(d) < min) {
      return minDay;
    }
    if (maxDay && max !== undefined && dayKey(d) > max) {
      return maxDay;
    }
    return d;
  }

  let cursor = bounded(dayOf(opts.initial ?? new Date()));

  return runPrompt<Date>(opts, () => {
    const grid = calendarGrid(opts, 2);
    const iso = textNode('', { 'white-space': 'nowrap' });
    const field = box({ class: 'sigil-prompt-field' }, iso);
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width), '0000-00-00');
    const { line, mark } = promptHeadLine(opts.message, head.message, field);
    const view = box({ class: 'sigil-prompt', 'flex-direction': 'column' }, line, grid.element);

    function draw(): void {
      iso.setText(isoOf(cursor));
      grid.update({
        max,
        min,
        month: cursor.month,
        selected: dayKey(cursor),
        stable: true,
        year: cursor.year,
      });
    }

    draw();

    return {
      key(k) {
        if (k.name === 'enter') {
          return { value: localDate(cursor.year, cursor.month, cursor.day) };
        }

        if (k.name === 'left') {
          cursor = bounded(addDays(cursor, -1));
        } else if (k.name === 'right') {
          cursor = bounded(addDays(cursor, 1));
        } else if (k.name === 'up') {
          cursor = bounded(addDays(cursor, -7));
        } else if (k.name === 'down') {
          cursor = bounded(addDays(cursor, 7));
        } else if (k.name === 'pageup') {
          cursor = bounded(addMonths(cursor, -1));
        } else if (k.name === 'pagedown') {
          cursor = bounded(addMonths(cursor, 1));
        } else if (k.name === 'home') {
          cursor = bounded({ ...cursor, day: 1 });
        } else if (k.name === 'end') {
          cursor = bounded({ ...cursor, day: daysInMonth(cursor.year, cursor.month) });
        }

        draw();
      },

      settle(): void {
        promptAnswered(mark);
        iso.setText(isoOf(cursor));
        iso.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        grid.element.setProps({ display: 'none' });
      },

      view,
    };
  });
}
