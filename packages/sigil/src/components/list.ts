/**
 * A list prompt: one line, split on a separator, returned as `string[]`.
 *
 * It is what a set of tags or hostnames wants, and a poor fit for `multiselect()`,
 * which needs every option known in advance. The field is the line `text()` draws
 * and the answer is that line read as a list, so there is nothing to learn: type
 * `api, web ,, db`, press Enter, and get `['api', 'web', 'db']`.
 *
 * ```js
 * const tags = await list({ message: 'Tags', initial: ['cli', 'node'] });
 * const hosts = await list({ message: 'Hosts', separator: /[\s,]+/ });
 * ```
 *
 * Each entry is trimmed and an entry with nothing left is dropped -- see
 * `splitList()`, which is the whole of the reading and is exported so that a
 * caller can apply the same rule to a value that did not come from a prompt.
 */

import { box, text as textNode } from '../element/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { boundary, deleteAfter, deleteBefore, insertAt, pastedLine, typedText } from './editing.js';
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

export interface ListOptions extends PromptOptions {
  /**
   * Returned when the line holds no entries. Shown dimmed in the empty field,
   * joined the way `initial` is, unless `placeholder` says otherwise.
   */
  default?: readonly string[];
  /**
   * What the field starts with, editable. A string is the line as it is; an array
   * is joined with the separator, and is refused if splitting that line would not
   * give the array back (an entry holding the separator, say, or one with
   * whitespace around it). Unlike `default`, it is not a fallback.
   */
  initial?: string | readonly string[];
  /** Shown dimmed when nothing has been typed, in place of `default`. */
  placeholder?: string;
  /**
   * What ends one entry and starts the next. A string is matched literally; a
   * `RegExp` is matched wherever it matches, so `/[\s,]+/` takes commas and
   * spaces alike. Defaults to `','`. An empty string is refused: it would split
   * between every character.
   */
  separator?: string | RegExp;
  /**
   * Checks the answer, after the line has been read. Return a string to reject it
   * with that message, or anything falsy to accept. This is where a minimum or a
   * maximum number of entries is enforced.
   */
  validate?: (value: string[]) => string | undefined | false | Promise<string | undefined | false>;
}

/**
 * Reads a line as a list.
 *
 * Every entry is trimmed, and an entry with nothing left in it is dropped, so a
 * trailing comma, a doubled one and a space around either are all the same line:
 * `'a, b,, c,'` is `['a', 'b', 'c']`. An empty line is an empty list rather than
 * `['']`. There is no quoting and no escape -- an entry cannot contain its own
 * separator -- and no de-duplication, because repeating an entry is an answer
 * somebody may have meant and the prompt cannot tell.
 *
 * A `RegExp` separator is read with its flags, except that `g` and `y` are
 * ignored: the whole line is always scanned, from the start. A match with nothing
 * in it is not a separator -- `/\s*\/` would otherwise split between every
 * character -- and a capture group is not an entry, which is what a plain
 * `String.prototype.split()` would make it.
 *
 * @param text - The line.
 * @param separator - What ends an entry. Defaults to `','`.
 * @returns The entries, in order.
 */
export function splitList(text: string, separator: string | RegExp = ','): string[] {
  let parts: string[];

  if (typeof separator === 'string') {
    parts = separator === '' ? [text] : text.split(separator);
  } else {
    const pattern = new RegExp(separator.source, `${separator.flags.replace(/[gy]/g, '')}g`);
    parts = [];
    let from = 0;
    for (const match of text.matchAll(pattern)) {
      if (match[0] === '') {
        continue;
      }
      parts.push(text.slice(from, match.index));
      from = match.index + match[0].length;
    }
    parts.push(text.slice(from));
  }

  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Writes a list as the line that reads back as it.
 *
 * A separator with something in it is followed by a space, because `a, b` is what
 * a person writes and `a,b` is what they would have to un-write; a whitespace
 * separator is used as it is, and a `RegExp` has no text to join with so a comma
 * and a space stand in -- `splitList()` is how a caller finds out the pattern does
 * not take them.
 *
 * @param items - The entries.
 * @param separator - What ends an entry. Defaults to `','`.
 * @returns The line.
 */
export function joinList(items: readonly string[], separator: string | RegExp = ','): string {
  const glue =
    typeof separator === 'string' ? (separator.trim() === '' ? separator : `${separator} `) : ', ';
  return items.join(glue);
}

/** Names an option that cannot be used, the way `number()` names a bad `step`. */
function refuse(message: string, what: string): Promise<never> {
  return Promise.reject(new PromptError(`"${message}" cannot be asked: ${what}`));
}

/**
 * Asks for a list.
 *
 * @param opts - What to ask, and what separates the entries.
 * @returns The entries, trimmed, with the empty ones left out.
 */
export function list(opts: ListOptions): Promise<string[]> {
  const terminal = opts.terminal ?? defaultTerminal;
  const separator = opts.separator ?? ',';

  if (separator === '') {
    return refuse(opts.message, '`separator` is an empty string, which splits between characters');
  }

  let value = '';
  if (typeof opts.initial === 'string') {
    value = opts.initial;
  } else if (opts.initial !== undefined) {
    // an array that does not survive its own line is an `initial` the first Enter
    // would change, and the person would see a different list from the one given
    value = joinList(opts.initial, separator);
    const back = splitList(value, separator);
    if (back.length !== opts.initial.length || back.some((item, i) => item !== opts.initial?.[i])) {
      return refuse(
        opts.message,
        '`initial` does not survive being joined and split on `separator`'
      );
    }
  }

  let cursor = value.length;
  let error: string | undefined;

  return runPrompt<string[]>(opts, () => {
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
    const placeholder =
      opts.placeholder ?? (opts.default === undefined ? '' : joinList(opts.default, separator));

    function draw(): void {
      setPromptNote(complaint, error);

      if (value === '') {
        // the caret is on screen from the first frame, for `text()`'s reason
        const end = boundary(placeholder, 0, 1);
        before.setText('');
        caret.setText(placeholder.slice(0, end) || ' ');
        after.setText(placeholder.slice(end));
        after.setProps({ class: 'sigil-prompt-placeholder sigil-muted' });
        return;
      }

      const pane = promptWindow(value, cursor, head.rest);
      before.setText(pane.before);
      caret.setText(pane.under || ' ');
      after.setText(pane.after);
      after.setProps({ class: '' });
    }

    draw();

    return {
      async key(k) {
        error = undefined;

        if (k.name === 'enter') {
          const items = splitList(value, separator);
          // a line with no entries in it is an empty answer, whatever it holds: `, ,`
          // is as much nothing as the empty string, and the default is for nothing
          const answer = items.length === 0 && opts.default ? [...opts.default] : items;
          const failed = await opts.validate?.(answer);
          if (typeof failed === 'string' && failed) {
            error = failed;
            draw();
            return;
          }
          return { value: answer };
        }

        if (k.name === 'backspace') {
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
          ({ cursor, value } = insertAt(value, cursor, typedText(k) ?? ''));
        }

        draw();
      },

      paste(block: string): void {
        ({ cursor, value } = insertAt(value, cursor, pastedLine(block)));
        draw();
      },

      settle(answer: string[]): void {
        promptAnswered(mark);
        before.setText('');
        caret.setText('');
        caret.setProps({ class: '' });
        after.setText(answer.join(', '));
        after.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        setPromptNote(complaint, undefined);
      },

      view,
    };
  });
}
