/**
 * A number prompt: a text field that only accepts what a number is made of,
 * and arrows that change the value.
 *
 * `text()` with a `validate` that parses is a number prompt that finds out it was
 * given a letter after the fact. This refuses the letter as it is typed, steps
 * with Up and Down, holds the answer to a range, and -- the part that matters
 * most -- **asks the parser what a number is** rather than having an opinion of
 * its own: the text goes through `transformValue()` as `int` or `number`, so a
 * prompt can never accept what `--port 9007199254740993` would be refused for.
 *
 * ```js
 * const port = await number({ message: 'Port', min: 1, max: 65535, default: 8080 });
 * const ratio = await number({ message: 'Ratio', float: true, step: 0.1, min: 0, max: 1 });
 * ```
 *
 * The field is the one `multiline()` draws -- `layoutField()` and `fieldLayers()`
 * -- rather than a second copy of `text()`'s three-piece caret, so the caret, the
 * grapheme handling and the cursor movement are the shared ones and there is no
 * editing logic in this file beyond deciding which characters may be typed.
 */

import { box, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { transformValue } from '../util/coerce.js';
import { graphemes } from '../width/index.js';
import { boundary, deleteAfter, deleteBefore, insertAt, pastedLine, typedText } from './editing.js';
import {
  fieldLayers,
  layoutField,
  listWindow,
  PromptError,
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  promptNote,
  runPrompt,
  setPromptNote,
} from './prompt.js';

export interface NumberOptions extends PromptOptions {
  /** Returned when the answer is empty. Shown dimmed in the empty field. */
  default?: number;
  /**
   * Accept fractions. Defaults to `false`, so the answer is an `int` by the
   * parser's own rules and no decimal point can be typed.
   */
  float?: boolean;
  /** What the field starts with, editable. Unlike `default`, it is not a fallback. */
  initial?: number;
  /** The largest answer. Up stops here, and Enter above it is an error. */
  max?: number;
  /**
   * The smallest answer. Down stops here, and Enter below it is an error. A
   * `min` of zero or more is also what stops a `-` being typed.
   */
  min?: number;
  /** Shown dimmed when nothing has been typed, in place of `default`. */
  placeholder?: string;
  /** How far Up and Down move. Defaults to `1`. */
  step?: number;
  /**
   * Checks the answer, after the range has. Return a string to reject it with
   * that message, or anything falsy to accept.
   */
  validate?: (value: number) => string | undefined | false | Promise<string | undefined | false>;
}

/** How many digits follow the point when a number is written out. */
function decimals(n: number): number {
  const m = /^-?\d*(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
  return m ? Math.max(0, (m[1]?.length ?? 0) - Number(m[2] ?? 0)) : 0;
}

/**
 * A number as the field shows it, which is never in exponent form.
 *
 * `String(1e-7)` is `1e-7`, and an `e` is the one character the field refuses to
 * let anybody type -- so a value the prompt wrote itself would be text the prompt
 * would not have accepted. Past 1e21 there is no plain spelling at all, and `undefined`
 * says so.
 */
function format(n: number): string | undefined {
  const plain = String(n).includes('e') ? n.toFixed(Math.min(100, decimals(n))) : String(n);
  return plain.includes('e') ? undefined : plain;
}

/** Names an option that cannot be used, the way `multiline()` names a bad `submit`. */
function refuse(message: string, what: string): Promise<never> {
  return Promise.reject(new PromptError(`"${message}" cannot be asked: ${what}`));
}

/**
 * Asks for a number.
 *
 * @param opts - What to ask, and the range the answer must be in.
 * @returns The number.
 */
export function number(opts: NumberOptions): Promise<number> {
  const terminal = opts.terminal ?? defaultTerminal;
  const float = opts.float ?? false;
  const step = opts.step ?? 1;
  const { max, min } = opts;
  const type = float ? 'number' : 'int';

  // a number that is not one cannot be compared, stepped or shown, so each of
  // these is refused where the prompt is asked rather than answered wrongly later.
  // An `int` prompt holds whole numbers throughout: a `min` of 0.5 has no integer
  // the field could start from, and a `step` of 0.5 would walk off the grid it
  // accepts typed input on
  for (const [name, value] of Object.entries({
    default: opts.default,
    initial: opts.initial,
    max,
    min,
    step,
  })) {
    if (value === undefined) {
      continue;
    }
    if (!Number.isFinite(value)) {
      return refuse(opts.message, `\`${name}\` is not a finite number`);
    }
    if (!float && !Number.isSafeInteger(value)) {
      return refuse(opts.message, `\`${name}\` is not an integer, and \`float\` is not set`);
    }
  }
  if (step <= 0) {
    return refuse(opts.message, '`step` must be greater than zero');
  }
  if (min !== undefined && max !== undefined && min > max) {
    return refuse(opts.message, '`min` is greater than `max`');
  }

  const signed = min === undefined || min < 0;
  let value = opts.initial === undefined ? '' : (format(opts.initial) ?? '');
  let cursor = value.length;
  let error: string | undefined;
  /** The first row on screen, for the answer too long for the room. */
  let top = 0;

  /**
   * What of a typed or pasted string may be in the field.
   *
   * Applied a character at a time against the value as it stands, so a paste is
   * held to exactly the rule a keystroke is: `1.2.3` pasted in a float field is
   * `1.23`, and `5-3` is `53`. There is no `e` and no `x`, which are the two ways
   * `Number()` reads something that is not what was meant, and no `+`, which is
   * not a thing anybody needs to write.
   *
   * Nothing is taken at offset 0 while the field starts with a `-`: that is the
   * one slot ahead of the minus, and a digit or a point there would write `3-5`.
   *
   * @param input - What arrived.
   */
  function accept(input: string): void {
    for (const cluster of graphemes(input)) {
      if (cursor === 0 && value.startsWith('-')) {
        continue;
      }

      const digit = cluster >= '0' && cluster <= '9' && cluster.length === 1;
      const sign = cluster === '-' && signed && cursor === 0 && !value.startsWith('-');
      const point = cluster === '.' && float && !value.includes('.');

      if (digit || sign || point) {
        ({ cursor, value } = insertAt(value, cursor, cluster));
      }
    }
  }

  /**
   * The number the field holds, by the parser's own reading.
   *
   * Thrown rather than returned so that the message is the parser's: `-` alone
   * is `Invalid integer: -` here for the reason it is on the command line.
   */
  function parsed(text: string): number {
    // `-0` is a number nobody asked for and `Object.is` would tell it from `0`
    return (transformValue(text, type) as number) + 0;
  }

  /**
   * Moves the value by one step, or puts it at the place stepping starts from.
   *
   * An empty field has no value to move, so the first press *lands* on `default`,
   * then `min`, then zero -- clamped into the range, so a `min` of 10 starts at 10
   * and not at 0 or 11 -- and the presses after it step. The result is rounded to
   * the finer of the step's and the value's own decimal places, because
   * `0.1 + 0.2` is `0.30000000000000004` and a field that wrote that has lost the
   * only thing a stepper is for; the value's own places are kept as well so that
   * stepping `0.125` by `0.1` does not quietly delete the `5`.
   *
   * @param direction - Which way.
   */
  function nudge(direction: -1 | 1): void {
    let next: number;

    if (value === '' || value === '-') {
      next = opts.default ?? min ?? 0;
    } else {
      let from: number;
      try {
        from = parsed(value);
      } catch {
        // a half-written number is a field that cannot be stepped, which is
        // different from one that is wrong: the error belongs to Enter
        return;
      }
      const places = Math.max(decimals(step), decimals(from));
      next = Number((from + direction * step).toFixed(Math.min(places, 100)));
    }

    if (max !== undefined) {
      next = Math.min(next, max);
    }
    if (min !== undefined) {
      next = Math.max(next, min);
    }

    // past 2^53-1 an `int` is not the integer that was computed, and a float with
    // no plain spelling cannot be put in a field that refuses an `e`
    const text = format(next);
    if (text === undefined || (!float && !Number.isSafeInteger(next))) {
      return;
    }
    value = text;
    cursor = value.length;
  }

  return runPrompt<number>(opts, () => {
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
    const placeholder =
      opts.placeholder ?? (opts.default === undefined ? undefined : format(opts.default));

    /** The columns the field has, once the head has taken its share. */
    const room = head.rest;
    let layout = layoutField(value, cursor, room);
    let visible = 1;

    const { caret: caretLayer, field } = fieldLayers(() => ({ layout, top, visible }));
    // `position: relative` with no insets moves nothing and is what gives the
    // caret layer a containing block to resolve its own against
    const entry = box({ class: 'sigil-prompt-number', position: 'relative' }, field, caretLayer);
    const { line, mark } = promptHeadLine(opts.message, head.message, entry, answer);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      box({ 'padding-left': 2 }, complaint)
    );

    function draw(): void {
      setPromptNote(complaint, error);

      // the placeholder is the field with its class switched, as `multiline()` does
      // it: one element cannot resolve two styles, and only one of the two is ever
      // drawn
      const shown = value === '' && placeholder ? placeholder : undefined;
      layout = layoutField(shown ?? value, shown === undefined ? cursor : 0, room);
      // a single row, and the one the caret is on when the answer is longer than
      // the room -- an `int` can be sixteen digits and a terminal can be ten wide
      top = listWindow(layout.rows.length, layout.caret.row, 1, top);

      field.setProps({
        class:
          shown === undefined
            ? 'sigil-prompt-field'
            : 'sigil-prompt-field sigil-prompt-placeholder sigil-muted',
      });
      field.invalidateMeasure();
      caretLayer.invalidatePaint();
    }

    draw();

    return {
      async key(k) {
        error = undefined;

        if (k.name === 'enter') {
          let result: number;
          if (value === '') {
            if (opts.default === undefined) {
              error = __`Enter a number`;
              draw();
              return;
            }
            result = opts.default;
          } else {
            try {
              result = parsed(value);
            } catch (thrown) {
              error = (thrown as Error).message;
              draw();
              return;
            }
          }

          // refused rather than clamped: an answer the person typed and did not
          // get is a different answer, and the only way they find out is the line
          // that says which bound it broke
          if (min !== undefined && result < min) {
            error = __`Must be at least ${min}`;
          } else if (max !== undefined && result > max) {
            error = __`Must be at most ${max}`;
          } else {
            const failed = await opts.validate?.(result);
            if (typeof failed === 'string' && failed) {
              error = failed;
            }
          }

          if (error !== undefined) {
            draw();
            return;
          }
          return { value: result };
        }

        if (k.name === 'up' || k.name === 'down') {
          nudge(k.name === 'up' ? 1 : -1);
        } else if (k.name === 'backspace') {
          ({ cursor, value } = deleteBefore(value, cursor));
        } else if (k.name === 'delete') {
          ({ cursor, value } = deleteAfter(value, cursor));
        } else if (k.name === 'left') {
          cursor = boundary(value, cursor, -1);
        } else if (k.name === 'right') {
          cursor = boundary(value, cursor, 1);
        } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          cursor = 0;
        } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          cursor = value.length;
        } else if (k.ctrl && k.name === 'u') {
          value = value.slice(cursor);
          cursor = 0;
        } else {
          accept(typedText(k) ?? '');
        }

        draw();
      },

      paste(block: string): void {
        accept(pastedLine(block));
        draw();
      },

      settle(done: number): void {
        promptAnswered(mark);
        answer.setText(format(done) ?? String(done));
        answer.setProps({ display: 'flex' });
        entry.setProps({ display: 'none' });
        setPromptNote(complaint, undefined);
      },

      view,
    };
  });
}
