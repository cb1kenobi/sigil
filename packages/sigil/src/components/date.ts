/**
 * A date prompt: segments you step or type into, returning a `Date`.
 *
 * The question this answers is what the interactive side of the parser's `date`
 * data type is. It used to be `text()` and a hope: a field that takes any string
 * and a `validate` that would have to re-implement the calendar. Here the value
 * is *built from segments* and then handed to the one reader the parser uses,
 * `transformValue(text, 'date')`, so the two cannot disagree about what a date
 * is -- the prompt does not carry a copy of the calendar or clock rules, it asks.
 *
 * The one piece of arithmetic that is the prompt's own is how long a month is
 * while a day is being stepped, and that is the parser's `daysInMonth()` rather
 * than a second one. See "A date prompt" in this directory's AGENTS.md.
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { daysInMonth, transformValue } from '../util/coerce.js';
import { addMonths, calendarGrid, type CalendarGridOptions, dayKey } from './calendar.js';
import { typedText } from './editing.js';
import {
  type AccessibleOptions,
  promptAnswered,
  promptAsLines,
  promptLineQuestion,
  promptHeadLine,
  promptHeadWidths,
  promptNote,
  type PromptOptions,
  promptTailFits,
  promptUnderHead,
  runLinePrompt,
  runPrompt,
  setPromptNote,
} from './prompt.js';

export interface DateOptions extends PromptOptions, AccessibleOptions {
  /**
   * Shows a month grid under the field, with the day the field holds selected.
   * `true` takes the defaults; an object also names the language, the weekday a
   * row starts on and the days to mark. Page Up and Page Down then change the
   * month.
   */
  calendar?: boolean | CalendarGridOptions;
  /** Shows the hour and minute as well. Defaults to `false`: a date. */
  time?: boolean;
  /** Shows the second too, which implies `time`. Defaults to `false`. */
  seconds?: boolean;
  /**
   * Where the field starts. Defaults to now, truncated to what is shown and
   * pulled into `min` and `max`. One given here is taken as it is, so it can
   * start outside the range -- and Enter on it is then an error rather than a
   * quiet move to the nearest bound.
   */
  initial?: Date;
  /**
   * An answer to start from: where the field starts, beating `initial` and taken
   * as it is the same way. One that is not a valid date is dropped rather than
   * refused, leaving `initial` to decide.
   */
  value?: Date;
  /** The earliest answer, inclusive at the precision shown. */
  min?: Date;
  /** The latest answer, inclusive at the precision shown. */
  max?: Date;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept.
   */
  validate?: (value: Date) => string | undefined | false | Promise<string | undefined | false>;
}

type Field = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'year';
type Parts = Record<Field, number>;

/** How many digits a segment has. */
const WIDTH: Record<Field, number> = { day: 2, hour: 2, minute: 2, month: 2, second: 2, year: 4 };

/** What is drawn in front of a segment, which is ISO order and nothing else. */
const LEAD: Record<Field, string> = {
  day: '-',
  hour: ' ',
  minute: ':',
  month: '-',
  second: ':',
  year: '',
};

/** What each segment is called in the picture of the format a line form asks for. */
const PICTURE: Record<Field, string> = {
  day: 'DD',
  hour: 'HH',
  minute: 'MM',
  month: 'MM',
  second: 'SS',
  year: 'YYYY',
};

/** The fields in the order they are compared, which is also the order they are drawn. */
const ORDER: readonly Field[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/**
 * One number that sorts the way the fields do.
 *
 * Compared as fields rather than as `Date`s: the value is a *local* date-time and
 * a `Date` for a wall-clock time a daylight saving gap skipped is a different
 * wall-clock time, so a range check through one would move with the time zone.
 * The largest is 9999 * 1e10, well inside a safe integer.
 *
 * @param parts - The fields.
 * @returns A sortable key.
 */
function keyOf(parts: Parts): number {
  return (
    parts.year * 1e10 +
    parts.month * 1e8 +
    parts.day * 1e6 +
    parts.hour * 1e4 +
    parts.minute * 1e2 +
    parts.second
  );
}

/** The two-digit pad every segment but the year uses, and the year's four. */
function pad(field: Field, value: number): string {
  return String(value).padStart(WIDTH[field], '0');
}

/**
 * Asks for a date, or a date and a time.
 *
 * The answer is built as a **local** date-time, the way the parser reads
 * `2024-06-15T12:00:00` with no offset, and the segments are always in ISO order
 * -- year, month, day, then the clock -- whatever the locale.
 *
 * @param opts - What to ask, and the range the answer has to be in.
 * @returns The date.
 */
export function date(opts: DateOptions): Promise<Date> {
  const terminal = opts.terminal ?? defaultTerminal;
  const seconds = opts.seconds === true;
  const clock = opts.time === true || seconds;
  const fields = ORDER.filter((f) => {
    if (f === 'second') {
      return seconds;
    }
    return f === 'hour' || f === 'minute' ? clock : true;
  });

  for (const [name, value] of [
    ['initial', opts.initial],
    ['min', opts.min],
    ['max', opts.max],
  ] as const) {
    if (value !== undefined && !(value instanceof Date && !Number.isNaN(value.getTime()))) {
      return Promise.reject(new TypeError(__`Expected ${name} to be a valid Date`));
    }
  }

  /**
   * A `Date` as the fields this prompt shows, truncated to them.
   *
   * The getters are the local ones, which is right here and nowhere the parser
   * reads: this prompt builds its values local, so a `Date` handed in is read
   * back the same way.
   */
  function partsOf(d: Date): Parts {
    return {
      day: d.getDate(),
      hour: clock ? d.getHours() : 0,
      minute: clock ? d.getMinutes() : 0,
      month: d.getMonth() + 1,
      second: seconds ? d.getSeconds() : 0,
      year: d.getFullYear(),
    };
  }

  const min = opts.min && partsOf(opts.min);
  const max = opts.max && partsOf(opts.max);

  if (min && max && keyOf(min) > keyOf(max)) {
    return Promise.reject(new RangeError(__`Expected min to be no later than max`));
  }

  /** Pulls fields into the range, to the bound they went past. */
  function bounded(parts: Parts): Parts {
    if (min && keyOf(parts) < keyOf(min)) {
      return { ...min };
    }
    if (max && keyOf(parts) > keyOf(max)) {
      return { ...max };
    }
    return parts;
  }

  /** What a field's number may be, given the others. */
  function limits(field: Field, parts: Parts): [number, number] {
    switch (field) {
      case 'year':
        return [0, 9999];
      case 'month':
        return [1, 12];
      case 'day':
        return [1, daysInMonth(parts.year, parts.month)];
      case 'hour':
        return [0, 23];
      default:
        return [0, 59];
    }
  }

  /** The text the parser's `date` reader is given: a local date-time, no offset. */
  function textOf(parts: Parts): string {
    const day = `${pad('year', parts.year)}-${pad('month', parts.month)}-${pad('day', parts.day)}`;
    return clock
      ? `${day}T${pad('hour', parts.hour)}:${pad('minute', parts.minute)}:${pad('second', parts.second)}`
      : day;
  }

  /** What is shown for a range bound, in the form the field is drawn in. */
  function shownText(parts: Parts): string {
    return fields.map((f) => `${LEAD[f]}${pad(f, parts[f])}`).join('');
  }

  const start = bounded(partsOf(new Date()));
  // a starting answer that is not a date is dropped rather than refused, for the
  // reason `number()` drops one: it is an answer handed back, not an option
  const given =
    opts.value instanceof Date && !Number.isNaN(opts.value.getTime()) ? opts.value : opts.initial;
  let parts: Parts = given ? partsOf(given) : start;
  let focus = 0;
  let pending = '';
  let error: string | undefined;

  /** What is wrong with an answer, or the `Date` it is: the drawn field's checks, in its order. */
  async function judged(at: Parts): Promise<Date | string> {
    if (min && keyOf(at) < keyOf(min)) {
      return __`Date must not be before ${shownText(min)}`;
    }
    if (max && keyOf(at) > keyOf(max)) {
      return __`Date must not be after ${shownText(max)}`;
    }
    let answer: Date;
    try {
      // the parser's own reader, which is what refuses a day or a clock that
      // does not exist -- there is no second copy of that here
      answer = transformValue(textOf(at), 'date') as Date;
    } catch (cause) {
      return (cause as Error).message;
    }
    const failed = await opts.validate?.(answer);
    return typeof failed === 'string' && failed ? failed : answer;
  }

  if (promptAsLines(opts)) {
    // the segments typed whole, in the order they are drawn: a date is said as
    // its digits far more readily than it is stepped to, and a line has no
    // segment to step. The picture names the format, the range is said rather
    // than found by refusal -- the drawn grid dims what is outside it, which a
    // line cannot -- and Enter alone takes where the field would have opened
    const picture = fields.map((f) => `${LEAD[f]}${PICTURE[f]}`).join('');
    const shape = new RegExp(
      `^${fields
        .map((f) => `${LEAD[f] === ' ' ? '[ T]' : LEAD[f]}(\\d{${f === 'year' ? 4 : '1,2'}})`)
        .join('')}$`
    );
    const range =
      min && max
        ? __`from ${shownText(min)} to ${shownText(max)}`
        : min
          ? __`from ${shownText(min)}`
          : max
            ? __`until ${shownText(max)}`
            : undefined;
    const hint = [picture, range, __`default: ${shownText(parts)}`].filter(Boolean).join(', ');
    const start = parts;

    return runLinePrompt<Date>(opts, {
      ask: promptLineQuestion(opts.message, `(${hint})`),
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
        const answer = await judged(at);
        return typeof answer === 'string' ? answer : { value: answer };
      },
    });
  }

  return runPrompt<Date>(opts, () => {
    const segments = new Map<Field, Element>();
    const children: Element[] = [];

    for (const f of fields) {
      if (LEAD[f]) {
        children.push(textNode(LEAD[f], { class: 'sigil-muted', 'white-space': 'nowrap' }));
      }
      const node = textNode('', { 'white-space': 'nowrap' });
      segments.set(f, node);
      children.push(node);
    }

    const field = box({ class: 'sigil-prompt-field' }, ...children);
    const grid = opts.calendar
      ? calendarGrid(opts.calendar === true ? {} : opts.calendar, 2)
      : undefined;
    // reserved at its widest, so the head gives the field the room it will need
    // -- and where that is more than the head can give, the field is on a line of
    // its own under the question rather than cut to `2024-06-`. It settles where
    // it was drawn, because it is the answer
    const widest = shownText(partsOf(new Date(0)));
    const room = Math.max(1, terminal.width);
    const beside = promptTailFits(opts.message, room, widest);
    const head = promptHeadWidths(opts.message, room, beside ? widest : '');
    const { line, mark } = promptHeadLine(opts.message, head.message, ...(beside ? [field] : []));
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      ...(beside ? [] : [promptUnderHead(field)]),
      ...(grid ? [grid.element] : []),
      box({ 'padding-left': 2 }, complaint)
    );

    /** Moves the focus to a segment, taking what was typed into the old one. */
    function move(to: number): void {
      commit();
      focus = Math.max(0, Math.min(fields.length - 1, to));
    }

    /**
     * Puts one field's number in, then repairs what depended on it.
     *
     * The day is the only dependent: a month or a year that makes it longer than
     * the month is short pulls it back to the last day, and nothing carries into
     * a neighbour. Stepping Jan 31 to February is Feb 28 or 29, and the month is
     * the only segment that changed.
     */
    function put(f: Field, value: number): void {
      const next = { ...parts };
      const [lo, hi] = limits(f, next);
      next[f] = Math.max(lo, Math.min(hi, value));
      next.day = Math.min(next.day, daysInMonth(next.year, next.month));
      parts = bounded(next);
    }

    /** Takes the digits typed into the focused segment as its value. */
    function commit(): void {
      if (pending !== '') {
        put(fields[focus], Number(pending));
        pending = '';
      }
    }

    /** Steps the focused segment, wrapping inside it. */
    function step(delta: number): void {
      commit();
      const f = fields[focus];
      const [lo, hi] = limits(f, parts);
      const span = hi - lo + 1;
      const wrapped = lo + ((((parts[f] - lo + delta) % span) + span) % span);
      put(f, wrapped);
    }

    /** Moves the month, keeping the day where the month is long enough. */
    function page(months: number): void {
      commit();
      const next = addMonths(parts, months);
      parts = bounded({ ...parts, day: next.day, month: next.month, year: next.year });
    }

    function draw(): void {
      setPromptNote(complaint, error);
      grid?.update({
        max: max && dayKey(max),
        min: min && dayKey(min),
        month: parts.month,
        selected: dayKey(parts),
        stable: true,
        year: parts.year,
      });

      fields.forEach((f, i) => {
        const node = segments.get(f)!;
        const typing = i === focus && pending !== '';
        node.setText(typing ? pending.padEnd(WIDTH[f], '_') : pad(f, parts[f]));
        node.setProps({ class: i === focus ? 'sigil-caret' : '' });
      });
    }

    draw();

    return {
      async key(k) {
        error = undefined;

        if (k.name === 'enter') {
          commit();

          const answer = await judged(parts);
          if (typeof answer !== 'string') {
            return { value: answer };
          }
          error = answer;
        } else if (k.name === 'left' || (k.name === 'tab' && k.shift)) {
          move(focus - 1);
        } else if (k.name === 'right' || k.name === 'tab') {
          move(focus + 1);
        } else if (k.name === 'up') {
          step(1);
        } else if (k.name === 'down') {
          step(-1);
        } else if (grid && (k.name === 'pageup' || k.name === 'pagedown')) {
          page(k.name === 'pageup' ? -1 : 1);
        } else if (k.name === 'backspace') {
          pending = '';
        } else {
          const typed = typedText(k);

          // digits only: a segment has no use for anything else, and a stray
          // letter is a key that did nothing rather than one that is an error
          if (typed !== undefined && /^\d$/.test(typed)) {
            pending += typed;

            if (pending.length >= WIDTH[fields[focus]]) {
              move(focus + 1);
            }
          }
        }

        draw();
      },

      settle(): void {
        promptAnswered(mark);
        for (const f of fields) {
          segments.get(f)!.setText(pad(f, parts[f]));
        }
        for (const node of children) {
          node.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        }
        setPromptNote(complaint, undefined);
        grid?.element.setProps({ display: 'none' });
      },

      view,
    };
  });
}
