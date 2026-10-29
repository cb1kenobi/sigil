/**
 * A prompt that is answered by pressing a choice's key, with no cursor to move.
 *
 * `select()` is the prompt for a list you have to read. This one is for a short
 * list the person already knows -- overwrite, skip, all, diff -- where arrowing
 * to the row and pressing Enter is slower than the one letter that was going to
 * be pressed anyway. Three prompts from other libraries are the same idea with a
 * different amount of ceremony, and one entry point covers them with two options
 * rather than three functions:
 *
 * - Clack's `selectKey`: every choice has a `key`, and pressing it answers.
 * - Inquirer's `rawlist`: `numbered` gives the choices that have no key of their
 *   own the numbers 1 to 9.
 * - Inquirer's `expand`: `expand` shows one line, `(y/n/a/d/h)`, and the list
 *   itself only after `h` is pressed.
 *
 * ```js
 * const action = await selectKey({
 *   message: 'File exists',
 *   choices: [
 *     { key: 'o', label: 'Overwrite', value: 'overwrite' },
 *     { key: 's', label: 'Skip', value: 'skip' },
 *     { key: 'd', label: 'Show the diff', value: 'diff' },
 *   ],
 *   expand: true,
 *   initial: 's',
 * });
 * ```
 *
 * The keys are checked where the prompt is asked and not when one is pressed: a
 * list in which two choices share a key has a choice nobody can reach, and
 * finding that out at the keyboard is finding it out too late.
 */

import { box, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { isControlChar, isSpaceCluster, typedText } from './editing.js';
import {
  type Choice,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  PromptError,
  promptValue,
  runPrompt,
  type Separator,
} from './prompt.js';

/** A choice offered by `selectKey()`. */
export interface KeyChoice<T = unknown> extends Omit<Choice<T>, 'description' | 'selected'> {
  /**
   * The one character that answers with this choice. Case does not matter: `y`
   * and `Y` are one key, so two choices may not use both. Required unless the
   * prompt is `numbered`, which numbers the choices that have none.
   */
  key?: string;
}

/** What `selectKey()`'s list is made of: a choice, a heading, or a label to number. */
export type KeyChoiceEntry<T = unknown> = KeyChoice<T> | Separator | string;

export interface SelectKeyOptions<T> extends PromptOptions {
  /**
   * What to offer. A string is a choice with that label, which has no key and so
   * needs `numbered`. A heading is drawn when the list is, and is not in the
   * `expand` line.
   */
  choices: readonly KeyChoiceEntry<T>[];
  /**
   * Show `(y/n/a/d/h)` instead of the list, and the list only once `h` or `?` is
   * pressed. Both are kept for that, so a choice may not use either.
   */
  expand?: boolean;
  /**
   * The key Enter answers with, which is marked in the list and capitalised in
   * the `expand` line. Without one Enter does nothing, as there is nothing
   * highlighted for it to take.
   */
  initial?: string;
  /**
   * Give each choice that has no `key` its place in the list as one, from `1`.
   * A choice past the ninth has no single digit to be and needs a key of its own.
   */
  numbered?: boolean;
}

/** The keys `expand` keeps for itself. */
const HELP_KEYS: readonly string[] = ['h', '?'];

/** One line of the list: a choice with the key that answers it, or a heading. */
type Line<T> =
  | { choice: KeyChoice<T>; key: string; kind: 'choice'; offered: boolean; typed: string }
  | { kind: 'separator'; label: string };

/**
 * A key as it is compared, which is lower case and not the locale's.
 *
 * `toLowerCase()` rather than the locale variant for `camelCase()`'s reason: in
 * Turkish `I` lowercases to a dotless `ı`, so a key of `I` would stop matching
 * the `i` that is pressed on that machine and nowhere else.
 */
function fold(key: string): string {
  return key.toLowerCase();
}

/** Names an option that cannot be used, the way `number()` does. */
function refuse(message: string, what: string): Promise<never> {
  return Promise.reject(new PromptError(`"${message}" cannot be asked: ${what}`));
}

/**
 * The list with every choice's key settled, or what is wrong with it.
 *
 * @param opts - The prompt's options.
 * @returns The lines, or the sentence that says why they cannot be a prompt.
 */
function lines<T>(opts: SelectKeyOptions<T>): Line<T>[] | string {
  const owners = new Map<string, string>();
  let position = 0;
  const out: Line<T>[] = [];

  for (const entry of opts.choices) {
    if (typeof entry === 'object' && 'separator' in entry) {
      out.push({ kind: 'separator', label: entry.separator });
      continue;
    }

    const choice: KeyChoice<T> =
      typeof entry === 'string' ? { label: entry, value: entry as T } : entry;
    position++;

    let typed = choice.key;
    if (typed === undefined) {
      if (!opts.numbered) {
        return `"${choice.label}" has no \`key\`, and \`numbered\` is not set`;
      }
      if (position > 9) {
        return `"${choice.label}" is choice ${position}, past the ninth, and needs a \`key\` of its own`;
      }
      typed = String(position);
    }

    // one code point, because that is what a keypress is: the decoder reads a
    // flag or an accented letter in two pieces as two keys, so a key written that
    // way is one that could never be pressed. And not whitespace or a control
    // character, which are the keys Enter, Tab and Space already are
    if ([...typed].length !== 1 || isSpaceCluster(typed) || isControlChar(typed)) {
      return `the \`key\` of "${choice.label}" is ${JSON.stringify(typed)}, which is not one character`;
    }

    const key = fold(typed);
    const owner = owners.get(key);
    if (opts.expand && HELP_KEYS.includes(key)) {
      return `"${choice.label}" uses the key ${JSON.stringify(typed)}, which \`expand\` keeps for help`;
    }
    if (owner !== undefined) {
      return (
        `"${owner}" and "${choice.label}" both use the key ${JSON.stringify(typed)}` +
        ` (case does not tell keys apart)`
      );
    }
    owners.set(key, choice.label);

    out.push({ choice, key, kind: 'choice', offered: !choice.disabled, typed });
  }

  return out;
}

/**
 * Asks for one of a short list by pressing its key.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen value.
 */
export function selectKey<T = string>(opts: SelectKeyOptions<T>): Promise<T> {
  const all = lines(opts);

  if (typeof all === 'string') {
    return refuse(opts.message, all);
  }

  const offered = all.filter(
    (line): line is Extract<Line<T>, { kind: 'choice' }> => line.kind === 'choice' && line.offered
  );

  // nothing on offer is the same question to the person at the keyboard whether
  // the list was empty or every choice was disabled, which is why it is one
  // message and the same one `select()` gives
  if (offered.length === 0) {
    return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
  }

  const byKey = new Map(offered.map((line) => [line.key, line]));
  const fallback = opts.initial === undefined ? undefined : byKey.get(fold(opts.initial));

  if (opts.initial !== undefined && fallback === undefined) {
    return refuse(
      opts.message,
      `\`initial\` ${JSON.stringify(opts.initial)} is not the key of a choice on offer`
    );
  }

  const expand = opts.expand ?? false;
  const terminal = opts.terminal ?? defaultTerminal;
  // `(Y/n/a/d/h)`: only the keys that work, so the line cannot name one that
  // does nothing, and the one Enter takes is the capital
  const summary = `(${[...offered.map((line) => (line === fallback ? line.typed.toUpperCase() : line.typed)), HELP_KEYS[0]].join('/')})`;
  let shown = !expand;
  let picked: KeyChoice<T> | undefined;

  return runPrompt<T>(opts, () => {
    const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
    const hint = textNode(summary, {
      class: 'sigil-prompt-hint sigil-muted',
      display: expand ? 'flex' : 'none',
    });
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width), expand ? summary : '');
    const { line, mark } = promptHeadLine(opts.message, head.message, hint, answer);

    const rows = all.map((entry) => {
      if (entry.kind === 'separator') {
        return box(
          { class: 'sigil-choice sigil-choice-heading' },
          textNode(entry.label, { class: 'sigil-choice-separator sigil-muted' })
        );
      }

      const here = entry === fallback;
      const reason =
        typeof entry.choice.disabled === 'string' && entry.choice.disabled
          ? entry.choice.disabled
          : entry.choice.disabled
            ? __`disabled`
            : entry.choice.hint;

      return box(
        { class: here ? 'sigil-choice is-active sigil-accent' : 'sigil-choice' },
        // the pointer is there for the choice Enter takes, and its column is on
        // every row either way, for the reason the choice list records: hidden
        // content still takes its space. It is kept with no `initial` as well so
        // that the labels sit where `select()`'s do
        textNode(PROMPT_SYMBOLS.cursor, {
          class: here ? 'sigil-choice-pointer' : '',
          'margin-right': 1,
          visibility: here ? 'visible' : 'hidden',
        }),
        textNode(`${entry.typed})`, {
          class: `sigil-choice-key ${entry.offered ? 'sigil-accent' : 'sigil-muted'}`,
          'margin-right': 1,
        }),
        textNode(entry.choice.label, entry.offered ? {} : { class: 'sigil-muted' }),
        textNode(reason ?? '', {
          class: 'sigil-choice-hint sigil-muted',
          display: reason ? 'flex' : 'none',
          'margin-left': 1,
        })
      );
    });

    const list = box({ 'flex-direction': 'column', display: shown ? 'flex' : 'none' }, ...rows);
    const view = box({ class: 'sigil-prompt', 'flex-direction': 'column' }, line, list);

    return {
      key(k) {
        if (k.name === 'enter') {
          if (fallback !== undefined) {
            picked = fallback.choice;
            return { value: promptValue(fallback.choice) as T };
          }
          return;
        }

        // a modifier makes it a different key, which `typedText()` already says
        const pressed = typedText(k);
        if (pressed === undefined) {
          return;
        }

        const key = fold(pressed);
        const hit = byKey.get(key);
        if (hit !== undefined) {
          picked = hit.choice;
          return { value: promptValue(hit.choice) as T };
        }

        // a disabled choice is not in `byKey`, so its key falls through to here and
        // does nothing: the row says why. `h` and `?` are never a choice's while
        // `expand` is set, which is what lets them mean help
        if (expand && !shown && HELP_KEYS.includes(key)) {
          shown = true;
          hint.setProps({ display: 'none' });
          list.setProps({ display: 'flex' });
        }
      },

      settle(): void {
        promptAnswered(mark);
        answer.setText(picked?.short ?? picked?.label ?? '');
        answer.setProps({ display: 'flex' });
        // what is left is the question and its answer, as for `select()`
        hint.setProps({ display: 'none' });
        list.setProps({ display: 'none' });
      },

      view,
    };
  });
}
