/**
 * A calendar: one month as a grid of days, printed or picked from.
 *
 * Three faces over one grid. `calendar()` returns the month as a string, the way
 * `table()` and `note()` do. `pickDate()` is a prompt that asks for a day by
 * moving through the month. And `calendarGrid()` is the grid itself, built once
 * and updated in place, which is what the date prompt shows beneath its field.
 * See "A calendar" in this directory's AGENTS.md.
 */

import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { __, locale as i18nLocale } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { transformValue } from '../util/coerce.js';
import { daysInMonth } from '../util/transform.js';
import { truncate } from '../wrap/index.js';
import { colorLevelOf } from './color-level.js';
import {
  type AccessibleOptions,
  promptAnswered,
  promptAsLines,
  promptLineQuestion,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  promptTailFits,
  promptUnderHead,
  runLinePrompt,
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

export interface PickDateOptions extends CalendarGridOptions, PromptOptions, AccessibleOptions {
  /**
   * The day the cursor starts on. Defaults to today. One outside `min` and `max`
   * is moved to the nearest bound.
   */
  initial?: Date;
  /** The latest day that can be picked, inclusive. */
  max?: Date;
  /** The earliest day that can be picked, inclusive. */
  min?: Date;
  /**
   * An answer to start from: the day the cursor starts on, beating `initial` and
   * pulled into `min` and `max` the same way. One that is not a valid date is
   * dropped rather than refused.
   */
  value?: Date;
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
 * The years a day may be moved through: the four digits the parser's `date`
 * type reads and `isoOf()` writes. Stated once, for a move by days and by
 * months alike.
 */
const FIRST_YEAR = 0;
const LAST_YEAR = 9999;

/**
 * A day some days away.
 *
 * The year stays inside 0-9999, as it does for `addMonths()`: a move past
 * either end stops on the first or the last day of the range rather than
 * reaching a year the field cannot write and the parser cannot read.
 *
 * @param d - The day.
 * @param days - How many days to move, negative for earlier.
 * @returns The day, which may be in another month.
 */
export function addDays(d: Day, days: number): Day {
  const next = dayOf(localDate(d.year, d.month, d.day + days));
  if (next.year < FIRST_YEAR) {
    return { day: 1, month: 1, year: FIRST_YEAR };
  }
  if (next.year > LAST_YEAR) {
    return { day: 31, month: 12, year: LAST_YEAR };
  }
  return next;
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
  const index = Math.max(
    FIRST_YEAR * 12,
    Math.min(LAST_YEAR * 12 + 11, d.year * 12 + d.month - 1 + months)
  );
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
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  });
}

/**
 * A field of a date prompt. `date()` shows the first three, five or all six,
 * and `pickDate()`'s line form asks for the first three.
 */
export type DateField = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'year';

/**
 * A local date-time as the fields a date prompt shows. A `Day` is one, with no
 * clock; a clock field not given is 0.
 */
export interface DateParts extends Day {
  hour?: number;
  minute?: number;
  second?: number;
}

/** What an answer is held to besides being a date: the range, and the caller's check. */
export interface DateCheck {
  /** The latest answer, inclusive, at the precision shown. */
  max?: DateParts;
  /** The earliest answer, inclusive, at the precision shown. */
  min?: DateParts;
  /** The caller's own check: a string refuses with that message, anything falsy accepts. */
  validate?: (value: Date) => string | undefined | false | Promise<string | undefined | false>;
}

/** How a date prompt writes, reads and judges the fields it shows. */
export interface DateFormat {
  /** The fields shown, in ISO order: the order they are drawn, typed and compared. */
  readonly fields: readonly DateField[];
  /** What is drawn in front of each field, which is ISO's separators and nothing else. */
  readonly lead: Readonly<Record<DateField, string>>;
  /** How many digits each field is written with. */
  readonly width: Readonly<Record<DateField, number>>;
  /**
   * Asks for the fields as one line, for a screen reader: `2024-06-15`, or
   * `2024-06-15 13:45` with the clock. Enter alone answers `start`, judged as
   * a typed reply is.
   */
  ask(opts: PromptOptions, start: DateParts, check?: DateCheck): Promise<Date>;
  /**
   * The answer the fields make, or why they make none: the parser's `date`
   * reader, then `min`, then `max`, then `validate`.
   */
  judge(at: DateParts, check?: DateCheck): Promise<Date | string>;
  /** One number that sorts the way the fields do. */
  key(at: DateParts): number;
  /** A field's number, written with its digits. */
  pad(field: DateField, value: number): string;
  /** A `Date` as the fields shown, by the local getters, the rest 0. */
  partsOf(d: Date): Record<DateField, number>;
  /** The fields shown, as they are drawn: `2024-06-15`, `2024-06-15 13:45`. */
  shown(at: DateParts): string;
}

/** The six fields in ISO order, which is the order they are compared in. */
const DATE_FIELDS: readonly DateField[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/** What is written in front of a field. */
const LEAD: Record<DateField, string> = {
  day: '-',
  hour: ' ',
  minute: ':',
  month: '-',
  second: ':',
  year: '',
};

/** How many digits a field has. */
const DIGITS: Record<DateField, number> = {
  day: 2,
  hour: 2,
  minute: 2,
  month: 2,
  second: 2,
  year: 4,
};

/** What each field is called in the picture of the format a line asks for. */
const PICTURE: Record<DateField, string> = {
  day: 'DD',
  hour: 'HH',
  minute: 'MM',
  month: 'MM',
  second: 'SS',
  year: 'YYYY',
};

/**
 * A field's number, with its digits.
 *
 * The sign goes in front of the digits rather than among them: a year before 0
 * can only arrive as an `initial`, `min` or `max` that was given, and padding
 * `-1` wrote `00-1`, which is no year at all -- so a refusal quoted text the
 * fields never were. `-0001` is refused all the same, in words that say why.
 */
function padField(field: DateField, value: number): string {
  const digits = String(Math.abs(value)).padStart(DIGITS[field], '0');
  return value < 0 ? `-${digits}` : digits;
}

/**
 * Writes fields one after another, each behind its separator: the one ISO
 * formatter, which the field, the answer, the range and the parser's text are
 * all written with.
 *
 * @param at - The fields.
 * @param fields - Which of them, in order.
 * @param clock - What separates the day from the hour: a space to be read, a
 *   `T` for the parser.
 * @returns The text.
 */
function written(at: DateParts, fields: readonly DateField[], clock = LEAD.hour): string {
  return fields.map((f) => `${f === 'hour' ? clock : LEAD[f]}${padField(f, at[f] ?? 0)}`).join('');
}

/** `2024-06-05`, which is how `pickDate()`'s field and every date are written. */
function isoOf(d: Day): string {
  return written(d, DATE_FIELDS.slice(0, 3));
}

/**
 * How a date prompt writes, reads and judges its fields.
 *
 * This is what `date()` and `pickDate()` share, so that their line forms are one
 * reader: the same picture, the same range and default in the question, the
 * same refusal of a reply of the wrong shape, and the same checks in the same
 * order with the same messages. What a date is stays the parser's `date`
 * reader's to say. See "A calendar" in this directory's AGENTS.md.
 *
 * @param opts - `time` for the hour and minute, `seconds` for the second too,
 *   which implies `time`.
 * @returns The format.
 */
export function dateFormat(opts: { seconds?: boolean; time?: boolean } = {}): DateFormat {
  const seconds = opts.seconds === true;
  const clock = opts.time === true || seconds;
  const fields = DATE_FIELDS.filter((f) =>
    f === 'second' ? seconds : f === 'hour' || f === 'minute' ? clock : true
  );

  function key(at: DateParts): number {
    // compared as fields rather than as `Date`s: a wall-clock time a daylight
    // saving gap skipped is another wall-clock time as a `Date`, so a range
    // check through one would move with the time zone. 9999 * 1e10 at most
    return dayKey(at) * 1e6 + (at.hour ?? 0) * 1e4 + (at.minute ?? 0) * 1e2 + (at.second ?? 0);
  }

  function shown(at: DateParts): string {
    return written(at, fields);
  }

  async function judge(at: DateParts, check: DateCheck = {}): Promise<Date | string> {
    let answer: Date;
    try {
      // the parser's own reader, from local text with no offset, which is what
      // refuses a day or a clock that does not exist -- and is asked first, so
      // a reply that is not a date is told so rather than compared with a range
      answer = transformValue(written(at, clock ? DATE_FIELDS : fields, 'T'), 'date') as Date;
    } catch (cause) {
      return (cause as Error).message;
    }
    if (check.min && key(at) < key(check.min)) {
      return __`Date must not be before ${shown(check.min)}`;
    }
    if (check.max && key(at) > key(check.max)) {
      return __`Date must not be after ${shown(check.max)}`;
    }
    const failed = await check.validate?.(answer);
    return typeof failed === 'string' && failed ? failed : answer;
  }

  return {
    ask(prompt, start, check = {}) {
      // the fields typed whole, in the order they are drawn: a date is said as
      // its digits far more readily than it is stepped to, and a line has no
      // segment to step. The picture names the format, the range is said rather
      // than found by refusal -- the drawn grid dims what is outside it, which a
      // line cannot -- and Enter alone takes where the prompt would have opened
      const picture = fields.map((f) => `${LEAD[f]}${PICTURE[f]}`).join('');
      const shape = new RegExp(
        `^${fields
          .map((f) => `${LEAD[f] === ' ' ? '[ T]' : LEAD[f]}(\\d{${f === 'year' ? 4 : '1,2'}})`)
          .join('')}$`
      );
      const { max, min } = check;
      const range =
        min && max
          ? __`from ${shown(min)} to ${shown(max)}`
          : min
            ? __`from ${shown(min)}`
            : max
              ? __`until ${shown(max)}`
              : undefined;
      const hint = [picture, range, __`default: ${shown(start)}`].filter(Boolean).join(', ');

      return runLinePrompt<Date>(prompt, {
        ask: promptLineQuestion(prompt.message, `(${hint})`),
        echo: true,
        keep: true,
        async read(reply) {
          const said = reply.trim();
          let at = start;
          if (said !== '') {
            const match = shape.exec(said);
            if (!match) {
              return __`Enter a date as ${picture}`;
            }
            at = { ...start };
            fields.forEach((f, i) => {
              at[f] = Number(match[i + 1]);
            });
          }
          const answer = await judge(at, check);
          return typeof answer === 'string' ? answer : { value: answer };
        },
      });
    },
    fields,
    judge,
    key,
    lead: LEAD,
    pad: padField,
    partsOf(d) {
      // the local getters, which are right here and nowhere the parser reads:
      // a date prompt builds its answer local, so a `Date` handed in is read
      // back the same way
      return {
        day: d.getDate(),
        hour: clock ? d.getHours() : 0,
        minute: clock ? d.getMinutes() : 0,
        month: d.getMonth() + 1,
        second: seconds ? d.getSeconds() : 0,
        year: d.getFullYear(),
      };
    },
    shown,
    width: DIGITS,
  };
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

  const given =
    opts.value instanceof Date && !Number.isNaN(opts.value.getTime()) ? opts.value : opts.initial;
  let cursor = bounded(dayOf(given ?? new Date()));

  if (promptAsLines(opts)) {
    // `date()`'s line form, date only: a grid is a picture of a month to move
    // through, and a line has neither the picture nor anywhere to move. The
    // answer is the parser's, which for a day is local midnight, as drawn.
    // `highlight` marks a picture and is not said, since a line of every
    // marked day would be a second question
    return dateFormat().ask(opts, cursor, { max: maxDay, min: minDay });
  }

  return runPrompt<Date>(opts, () => {
    const grid = calendarGrid(opts, 2);
    const iso = textNode('', { 'white-space': 'nowrap' });
    const field = box({ class: 'sigil-prompt-field' }, iso);
    // the field is the answer and is never cut: under the question where it would
    // be cut beside it, as `date()`'s is, and it settles where it was drawn
    const room = Math.max(1, terminal.width);
    const beside = promptTailFits(opts.message, room, '0000-00-00');
    const head = promptHeadWidths(opts.message, room, beside ? '0000-00-00' : '');
    const { line, mark } = promptHeadLine(opts.message, head.message, ...(beside ? [field] : []));
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      ...(beside ? [] : [promptUnderHead(field)]),
      grid.element
    );

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
