/**
 * A masked text prompt: a line that follows a template.
 *
 * The template draws the shape of the answer and the field only accepts what
 * fits it. The fixed characters are drawn and skipped over, and only the slots
 * take input:
 *
 * ```js
 * const phone = await maskedText({ message: 'Phone', template: '(###) ###-####' });
 * const key = await maskedText({
 *   message: 'Licence key',
 *   template: 'KKKK-KKKK-KKKK',
 *   slots: { K: { match: /[a-z0-9]/i, transform: (ch) => ch.toUpperCase() } },
 * });
 * ```
 *
 * `#` is a digit, `A` a letter, `N` a letter or a digit, `H` a hex digit and `*`
 * any character that is not whitespace. Anything else in the template is a fixed
 * character, and a backslash makes the next character one whatever it is.
 *
 * The answer is the formatted string, `(555) 123-4567` -- what was drawn, which is
 * what a caller who asked for a phone number wants to store or print. The raw
 * characters, `5551234567`, are one `applyMask(template, answer).raw` away.
 */

import { box, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { graphemes } from '../width/index.js';
import { boundary, pastedLine, typedText } from './editing.js';
import {
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  PromptError,
  type PromptOptions,
  promptNote,
  promptWindow,
  runPrompt,
  setPromptNote,
} from './prompt.js';

/**
 * What one slot accepts.
 *
 * A pattern is tested against one typed character, as a whole: `/[a-f]/` accepts
 * `a` and not `ab`, so it needs no anchors. The object form adds `transform`,
 * which rewrites a character that matched before it is kept -- an upper-casing
 * slot for a licence key -- and may return `''` to refuse it after all.
 */
export type MaskSlot =
  | RegExp
  | {
      /** Tested against one character, which must match in full. */
      match: RegExp;
      /** What is kept for a character that matched. Defaults to the character. */
      transform?: (char: string) => string;
    };

/**
 * The slot characters a template understands without being told.
 *
 * ASCII on purpose: these are for codes, numbers and keys, where a letter from
 * another script is as much a typo as a digit would be. A caller who wants more
 * names a slot of their own in `slots`, which wins over these.
 */
export const MASK_SLOTS: Readonly<Record<string, RegExp>> = {
  '#': /[0-9]/,
  '*': /\S/u,
  A: /[A-Za-z]/,
  H: /[0-9A-Fa-f]/,
  N: /[A-Za-z0-9]/,
};

export interface MaskedTextOptions extends PromptOptions {
  /**
   * Answered when nothing has been typed. A string is read the way a paste is, so
   * `'5551234567'` and `'(555) 123-4567'` are the same default; it has to fill
   * every slot, and the answer is the formatted text either way. Shown dimmed in
   * the empty field in place of the blank template, unless `placeholder` says
   * otherwise.
   */
  default?: string;
  /**
   * What the field starts with, editable. Read the way a paste is, and refused if
   * any of it does not fit the template. It may leave slots empty; unlike
   * `default` it is not a fallback.
   */
  initial?: string;
  /** Shown dimmed while nothing has been typed, in place of the blank template. */
  placeholder?: string;
  /**
   * Slots of your own, by the character that stands for them in `template`, each
   * a single character. They are added to `MASK_SLOTS`, and replace one of those
   * where they share a character.
   */
  slots?: Readonly<Record<string, MaskSlot>>;
  /** The shape of the answer. A slot character takes input and any other is drawn as it is. */
  template: string;
  /**
   * Checks the answer, once every slot is filled. Receives the formatted text.
   * Return a string to reject it with that message, or anything falsy to accept.
   */
  validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
}

/** One slot, with what it accepts compiled. */
interface Slot {
  /** What is kept for a character that fits, or `''` for one that is refused. */
  keep: (char: string) => string;
  /** Whether a character fits. */
  fits: (char: string) => boolean;
}

/** A template, read. */
interface Mask {
  /**
   * The fixed characters before each slot, and after the last: `runs[i]` is what
   * stands in front of slot `i`, so there is one more run than there are slots.
   */
  runs: string[][];
  slots: Slot[];
}

/** What reading text into a template leaves behind. */
export interface Applied {
  /** Whether every slot is filled. */
  complete: boolean;
  /** How many characters of the input fit nowhere, and were left out. */
  dropped: number;
  /** Just the characters that were kept, without the fixed ones: `5551234567`. */
  raw: string;
  /**
   * The template as far as it has been filled: its fixed characters and the kept
   * ones, up to the last slot with something in it -- or to the end of the template
   * once every slot is full. Empty when nothing fit.
   */
  value: string;
}

/**
 * Reads a template.
 *
 * @param template - What the answer looks like.
 * @param extra - Slots of the caller's own.
 * @returns The template as runs of fixed characters between slots.
 */
function parseMask(template: string, extra: Readonly<Record<string, MaskSlot>> = {}): Mask {
  const table = new Map<string, Slot>();

  for (const [char, slot] of [...Object.entries(MASK_SLOTS), ...Object.entries(extra)]) {
    if ([...graphemes(char)].length !== 1 || char === '\\') {
      throw new RangeError(
        `A slot is named by a single character other than a backslash, not "${char}"`
      );
    }
    const match = slot instanceof RegExp ? slot : slot.match;
    const transform = slot instanceof RegExp ? undefined : slot.transform;
    // anchored, so that a pattern for one character is not satisfied by part of one,
    // and without the flags that make a pattern remember where it last matched
    const whole = new RegExp(`^(?:${match.source})$`, match.flags.replaceAll(/[gy]/g, ''));
    table.set(char, { fits: (ch) => whole.test(ch), keep: transform ?? ((ch) => ch) });
  }

  const runs: string[][] = [[]];
  const slots: Slot[] = [];
  const chars = [...graphemes(template)];

  for (let i = 0; i < chars.length; i++) {
    let char = chars[i] as string;

    if (char === '\\') {
      if (i === chars.length - 1) {
        throw new RangeError('A template cannot end in a backslash, which escapes what follows it');
      }
      char = chars[++i] as string;
    } else {
      const slot = table.get(char);
      if (slot) {
        slots.push(slot);
        runs.push([]);
        continue;
      }
    }

    (runs.at(-1) as string[]).push(char);
  }

  if (slots.length === 0) {
    throw new RangeError('A template needs at least one slot, or there is nothing to type');
  }

  return { runs, slots };
}

/**
 * Puts text into the slots from `start`, one character at a time.
 *
 * A character goes into the slot it is at if it fits and is otherwise left out,
 * and the next one is offered to the next slot. When `skipFixed` is set -- for
 * text that may carry the template's own formatting, which a paste does and a key
 * press does not -- a character that is the next one of the fixed characters in
 * front of the slot is passed over without filling anything, so `(555) 123-4567`
 * and `5551234567` land alike, and so does `+1 555` in `+1 ###`, where the `1`
 * would otherwise be taken for a digit.
 *
 * @param mask - The template.
 * @param cells - What each slot holds. Changed in place.
 * @param start - The slot to begin at.
 * @param input - The text.
 * @param skipFixed - Whether the template's fixed characters are passed over.
 * @returns The slot after the last one filled, and how many characters fit nowhere.
 */
function fill(
  mask: Mask,
  cells: (string | undefined)[],
  start: number,
  input: string,
  skipFixed: boolean
): { dropped: number; next: number } {
  let at = start;
  /** How far through the fixed run in front of slot `at` the text has got. */
  let seen = 0;
  let dropped = 0;

  for (const char of graphemes(input)) {
    const run = mask.runs[at] as string[];

    if (skipFixed && char === run[seen]) {
      seen++;
      continue;
    }

    const slot = mask.slots[at];
    const kept = slot?.fits(char) ? slot.keep(char) : '';
    if (slot && kept !== '') {
      cells[at++] = kept;
      seen = 0;
    } else {
      dropped++;
    }
  }

  return { dropped, next: at };
}

/**
 * The template as filled in, with `blank` standing in for a slot with nothing in it.
 *
 * @param mask - The template.
 * @param cells - What each slot holds.
 * @param blank - What an empty slot is drawn as.
 * @returns The text, and where each slot starts in it as an offset.
 */
function draw(
  mask: Mask,
  cells: readonly (string | undefined)[],
  blank: string
): { starts: number[]; text: string } {
  const starts: number[] = [];
  let text = '';

  for (let i = 0; i < mask.slots.length; i++) {
    text += (mask.runs[i] as string[]).join('');
    starts.push(text.length);
    text += cells[i] ?? blank;
  }

  return { starts, text: text + (mask.runs.at(-1) as string[]).join('') };
}

/**
 * Reads text into a template, which is what pasting into the field does.
 *
 * Read from the first slot, left to right: a character goes into the slot it is at
 * if it fits, and is dropped if not; the template's own fixed characters are
 * passed over where they come, so formatted text and raw characters give the same
 * answer. What does not fit is counted in `dropped` rather than refused, because
 * `abc 123` going into a digit template is an answer somebody can use.
 *
 * ```js
 * applyMask('(###) ###-####', '555.123.4567');
 * // { complete: true, dropped: 2, raw: '5551234567', value: '(555) 123-4567' }
 * ```
 *
 * @param template - What the answer looks like.
 * @param input - The text to read, raw or already formatted.
 * @param slots - Slots of your own, as for `maskedText()`.
 * @returns What fit, and whether it is all of the template.
 */
export function applyMask(
  template: string,
  input: string,
  slots?: Readonly<Record<string, MaskSlot>>
): Applied {
  const mask = parseMask(template, slots);
  const cells: (string | undefined)[] = Array.from({ length: mask.slots.length });
  const { dropped, next } = fill(mask, cells, 0, input, true);
  const complete = next === mask.slots.length;

  let value = '';
  for (let i = 0; i < next; i++) {
    value += (mask.runs[i] as string[]).join('') + cells[i];
  }
  if (complete) {
    value += (mask.runs.at(-1) as string[]).join('');
  }

  return { complete, dropped, raw: cells.join(''), value };
}

/** Names an option that cannot be used, the way `number()` names a bad `step`. */
function refuse(message: string, what: string): Promise<never> {
  return Promise.reject(new PromptError(`"${message}" cannot be asked: ${what}`));
}

/**
 * Asks for text that follows a template.
 *
 * Typing fills the slot the caret is on and moves to the next one, over whatever
 * fixed characters lie between, so `(555) 12` is typed as `55512`. A character the
 * slot does not accept is ignored. Backspace empties the slot before the caret and
 * moves onto it, crossing a fixed character in one press, and Delete empties the
 * one under it; Left and Right step over fixed characters too. Enter answers once
 * every slot is full and says so otherwise.
 *
 * @param opts - What to ask, and the template the answer follows.
 * @returns The answer as drawn, fixed characters included.
 */
export function maskedText(opts: MaskedTextOptions): Promise<string> {
  const terminal = opts.terminal ?? defaultTerminal;

  let mask: Mask;
  try {
    mask = parseMask(opts.template, opts.slots);
  } catch (err) {
    return refuse(opts.message, `\`template\` is not usable: ${(err as Error).message}`);
  }

  const count = mask.slots.length;
  const cells: (string | undefined)[] = Array.from({ length: count });

  let fallback: string | undefined;
  if (opts.default !== undefined) {
    const given = applyMask(opts.template, opts.default, opts.slots);
    if (!given.complete || given.dropped > 0) {
      return refuse(opts.message, '`default` does not fill the template exactly');
    }
    fallback = given.value;
  }

  let cursor = 0;
  if (opts.initial !== undefined) {
    const { dropped, next } = fill(mask, cells, 0, opts.initial, true);
    if (dropped > 0) {
      return refuse(opts.message, '`initial` has characters that do not fit the template');
    }
    cursor = next;
  }

  let error: string | undefined;

  return runPrompt<string>(opts, () => {
    const before = textNode('', { 'white-space': 'nowrap' });
    const caret = textNode('', { class: 'sigil-caret', 'white-space': 'nowrap' });
    const after = textNode('', { 'white-space': 'nowrap' });
    const field = box({ class: 'sigil-prompt-field' }, before, caret, after);
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const { line, mark } = promptHeadLine(opts.message, head.message, field);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      box({ 'padding-left': 2 }, complaint)
    );
    const placeholder = opts.placeholder ?? fallback;

    const empty = (): boolean => cells.every((cell) => cell === undefined);

    function paint(): void {
      setPromptNote(complaint, error);

      if (placeholder !== undefined && empty()) {
        // the caret is on screen from the first frame, for `text()`'s reason
        const end = boundary(placeholder, 0, 1);
        before.setText('');
        caret.setText(placeholder.slice(0, end) || ' ');
        after.setText(placeholder.slice(end));
        after.setProps({ class: 'sigil-prompt-placeholder sigil-muted' });
        return;
      }

      const { starts, text } = draw(mask, cells, '_');
      const pane = promptWindow(text, starts[cursor] ?? text.length, head.rest);
      // the blank template is a prompt of its own kind of empty: dimmed, like a
      // placeholder, until something has been typed into it
      const dim = empty() ? 'sigil-prompt-placeholder sigil-muted' : '';
      before.setText(pane.before);
      before.setProps({ class: dim });
      caret.setText(pane.under || ' ');
      after.setText(pane.after);
      after.setProps({ class: dim });
    }

    paint();

    return {
      async key(k) {
        error = undefined;

        if (k.name === 'enter') {
          let answer: string;

          if (empty() && fallback !== undefined) {
            answer = fallback;
          } else if (cells.some((cell) => cell === undefined)) {
            error = __`Fill in every blank`;
            paint();
            return;
          } else {
            answer = draw(mask, cells, '').text;
          }

          const failed = await opts.validate?.(answer);
          if (typeof failed === 'string' && failed) {
            error = failed;
            paint();
            return;
          }
          return { value: answer };
        }

        // while a placeholder stands in for the field the caret is drawn on its
        // first character, so that is where a keystroke has to land
        const showing = placeholder !== undefined && empty();

        if (k.name === 'backspace') {
          if (!showing && cursor > 0) {
            cells[--cursor] = undefined;
          }
        } else if (k.name === 'delete') {
          if (!showing && cursor < count) {
            cells[cursor] = undefined;
          }
        } else if (k.name === 'left') {
          cursor = showing ? 0 : Math.max(0, cursor - 1);
        } else if (k.name === 'right') {
          cursor = showing ? 0 : Math.min(count, cursor + 1);
        } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          cursor = 0;
        } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          // after the last thing typed, which is where typing carries on from
          cursor = cells.findLastIndex((cell) => cell !== undefined) + 1;
        } else if (k.ctrl && k.name === 'u') {
          cells.fill(undefined, 0, cursor);
          cursor = 0;
        } else {
          cursor = fill(mask, cells, cursor, typedText(k) ?? '', false).next;
        }

        if (placeholder !== undefined && empty()) {
          cursor = 0;
        }
        paint();
      },

      paste(block: string): void {
        cursor = fill(mask, cells, cursor, pastedLine(block), true).next;
        paint();
      },

      settle(answer: string): void {
        promptAnswered(mark);
        before.setText('');
        caret.setText('');
        caret.setProps({ class: '' });
        after.setText(answer);
        after.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        setPromptNote(complaint, undefined);
      },

      view,
    };
  });
}
