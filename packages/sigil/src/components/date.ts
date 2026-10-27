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
import { daysInMonth, transformValue } from '../util/transform.js';
import { typedText } from './editing.js';
import {
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  promptNote,
  type PromptOptions,
  runPrompt,
  setPromptNote,
} from './prompt.js';

export interface DateOptions extends PromptOptions {
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
  let parts: Parts = opts.initial ? partsOf(opts.initial) : start;
  let focus = 0;
  let pending = '';
  let error: string | undefined;

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
    // reserved at its widest, so the head gives the field the room it will need
    const head = promptHeadWidths(
      opts.message,
      Math.max(1, terminal.width),
      shownText(partsOf(new Date(0)))
    );
    const { line, mark } = promptHeadLine(opts.message, head.message, field);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
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

    function draw(): void {
      setPromptNote(complaint, error);

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

          if (min && keyOf(parts) < keyOf(min)) {
            error = __`Date must not be before ${shownText(min)}`;
          } else if (max && keyOf(parts) > keyOf(max)) {
            error = __`Date must not be after ${shownText(max)}`;
          } else {
            let answer: Date | undefined;

            try {
              // the parser's own reader: it is what refuses a day or a clock
              // that does not exist, so there is no second copy of that here
              answer = transformValue(textOf(parts), 'date') as Date;
            } catch (cause) {
              error = (cause as Error).message;
            }

            if (answer) {
              const failed = await opts.validate?.(answer);
              if (typeof failed === 'string' && failed) {
                error = failed;
              } else {
                return { value: answer };
              }
            }
          }
        } else if (k.name === 'left' || (k.name === 'tab' && k.shift)) {
          move(focus - 1);
        } else if (k.name === 'right' || k.name === 'tab') {
          move(focus + 1);
        } else if (k.name === 'up') {
          step(1);
        } else if (k.name === 'down') {
          step(-1);
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
      },

      view,
    };
  });
}
