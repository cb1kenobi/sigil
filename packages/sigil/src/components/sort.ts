/**
 * A sort prompt: put a list in order.
 *
 * The answer is a permutation rather than a choice -- a priority list, a build
 * order, the order middleware runs in -- so the prompt starts from the order the
 * caller gave and the person moves things until it is the order they mean.
 *
 * ```js
 * const order = await sort({
 *   message: 'Run the steps in this order',
 *   choices: ['lint', 'build', 'test', 'deploy'],
 * });
 * // ['lint', 'test', 'build', 'deploy']
 * ```
 *
 * Space picks the highlighted row up, Up and Down then carry it, and Space puts
 * it down. Enter answers.
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import {
  type Choice,
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptChoice,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  PromptError,
  promptRowCap,
  promptValue,
  runPrompt,
} from './prompt.js';

export interface SortOptions<T> extends PromptOptions {
  /**
   * What to put in order, in the order it starts in. A choice marked `disabled`
   * is pinned: it keeps its place in the list, cannot be picked up, and the rows
   * around it move past it.
   */
  choices: readonly (Choice<T> | string)[];
  /**
   * Which row starts highlighted, by index into `choices`. Defaults to 0. A
   * disabled choice is passed over for the next one that can be moved.
   */
  initial?: number;
  /**
   * Whether the highlight wraps from one end of the list to the other. Defaults
   * to `true`. A row being carried never wraps, whatever this says.
   */
  loop?: boolean;
  /**
   * How many rows the list may take. Defaults to what the terminal has left under
   * the question.
   */
  rows?: number;
}

/**
 * Moves one entry of a list to another place in it, shifting the ones between.
 *
 * @param list - The list. It is not changed.
 * @param from - The index to take from.
 * @param to - The index to put it at.
 * @returns The new list.
 */
function moved<V>(list: readonly V[], from: number, to: number): V[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as V);
  return next;
}

/**
 * The row for one place in the list.
 *
 * Built per draw for the rows on screen, as `autocomplete()` does: the order is
 * what changes, so there is no row that stays attached to a choice, and a window
 * of ten is cheap to rebuild.
 *
 * @param choice - What is in this place.
 * @param place - Its place, counted from 1.
 * @param digits - How wide the largest place is, so the labels line up.
 * @param state - Whether it is the highlighted row, whether it is being carried,
 *   and whether it is pinned.
 * @returns The row.
 */
function sortRow<T>(
  choice: Choice<T>,
  place: number,
  digits: number,
  state: { carried: boolean; current: boolean; pinned: boolean }
): Element {
  const { carried, current, pinned } = state;
  // the pointer is on every row and `visibility` takes it off the others, for the
  // reason the choice list records: hidden content still takes its space
  const pointer = textNode(PROMPT_SYMBOLS.cursor, {
    class: current ? 'sigil-choice-pointer' : '',
    'margin-right': 1,
    visibility: current ? 'visible' : 'hidden',
    'white-space': 'nowrap',
  });
  const number = textNode(`${String(place).padStart(digits)}.`, {
    class: 'sigil-sort-place sigil-muted',
    'margin-right': 1,
    'white-space': 'nowrap',
  });
  const label = textNode(choice.label, {
    class: pinned ? 'sigil-sort-label sigil-muted' : 'sigil-sort-label',
    'flex-shrink': 0,
    'white-space': 'nowrap',
  });
  const reason =
    typeof choice.disabled === 'string' && choice.disabled
      ? choice.disabled
      : choice.disabled
        ? __`disabled`
        : choice.hint;
  const hint = textNode(reason ?? '', {
    class: 'sigil-choice-hint sigil-muted',
    display: reason ? 'flex' : 'none',
    'margin-left': 1,
    'white-space': 'nowrap',
  });

  const classes = ['sigil-choice'];
  if (current) {
    classes.push('is-active', 'sigil-accent');
  }
  if (carried) {
    classes.push('is-carried', 'sigil-sort-carried', 'sigil-heading');
  }
  return box({ class: classes.join(' ') }, pointer, number, label, hint);
}

/**
 * Asks for a list put in order.
 *
 * Up and Down move the highlight; **Space picks the highlighted row up**, and
 * while it is held Up and Down move the row itself, with the highlight going
 * along. Space puts it down again. Home and End send it to the top or bottom, and
 * Page Up and Page Down carry it a screen at a time. Enter answers either way: a
 * row still in hand stays where it was carried to. Alt or Shift with Up or Down
 * moves a row one place without picking it up.
 *
 * @param opts - What to ask, and what to put in order.
 * @returns The values, in the order the person left them.
 */
export function sort<T = string>(opts: SortOptions<T>): Promise<T[]> {
  const start = opts.choices.map((choice) => promptChoice<T>(choice));
  // the places a row can be carried between: every one that is not pinned
  const slots = start.flatMap((choice, i) => (choice.disabled ? [] : [i]));

  if (slots.length === 0) {
    return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
  }

  const terminal = opts.terminal ?? defaultTerminal;
  const loop = opts.loop ?? true;
  let order = start;
  // an index into `slots`, so that the highlight cannot rest on a pinned place
  let at = (() => {
    const wanted = Math.min(Math.max(0, opts.initial ?? 0), start.length - 1);
    const found = slots.findIndex((slot) => slot >= wanted);
    return found < 0 ? slots.length - 1 : found;
  })();
  let carrying = false;
  let top = 0;

  /** The place in the list the highlight is on. */
  const here = (): number => slots[at] as number;

  /**
   * Carries the row in hand to another movable place.
   *
   * The pinned rows are not moved: the choices in the movable places are lifted
   * out, reordered among themselves and put back, so a pinned row keeps its place
   * whatever goes past it.
   *
   * @param to - The index into `slots` to carry it to, clamped to the list.
   */
  function carry(to: number): void {
    const target = Math.min(Math.max(0, to), slots.length - 1);
    if (target === at) {
      return;
    }
    const lifted = moved(
      slots.map((slot) => order[slot] as Choice<T>),
      at,
      target
    );
    order = order.map((choice, i) => {
      const slot = slots.indexOf(i);
      return slot < 0 ? choice : (lifted[slot] as Choice<T>);
    });
    at = target;
  }

  /** Moves the highlight, wrapping if it is allowed to. */
  function step(by: -1 | 1): void {
    const next = at + by;
    if (next < 0 || next >= slots.length) {
      at = loop ? (next + slots.length) % slots.length : at;
    } else {
      at = next;
    }
  }

  return runPrompt<T[]>(opts, () => {
    const grabHint = __`(space to grab, enter to confirm)`;
    const dropHint = __`(up/down to move, space to drop)`;
    const hint = textNode(grabHint, { class: 'sigil-prompt-hint sigil-muted' });
    // sized for the longer of the two, so that swapping one for the other never
    // makes the head taller than the window believed
    const head = promptHeadWidths(
      opts.message,
      Math.max(1, terminal.width),
      grabHint.length > dropHint.length ? grabHint : dropHint
    );
    const { line, mark } = promptHeadLine(opts.message, head.message, hint);
    const list = box({ class: 'sigil-sort-list', 'flex-direction': 'column' });
    const view = box({ class: 'sigil-prompt sigil-sort', 'flex-direction': 'column' }, line, list);

    const room = (): number => {
      const avail = Math.max(1, Math.max(1, terminal.height) - head.lines);
      return Math.max(1, Math.min(promptRowCap(opts.rows, avail), avail));
    };

    function draw(): void {
      top = listWindow(order.length, here(), room(), top);
      const visible = Math.max(1, Math.min(room(), order.length));
      const digits = String(order.length).length;

      while (list.children.length > 0) {
        list.removeChild(list.children[0] as Element);
      }
      for (const [place, choice] of order.entries()) {
        if (place >= top && place < top + visible) {
          list.append(
            sortRow(choice, place + 1, digits, {
              carried: carrying && place === here(),
              current: place === here(),
              pinned: Boolean(choice.disabled),
            })
          );
        }
      }
      hint.setText(carrying ? dropHint : grabHint);
    }

    draw();

    return {
      key(k) {
        if (k.name === 'enter') {
          return { value: order.map((choice) => promptValue(choice)) };
        }

        const page = Math.max(1, room() - 1);
        // alt or shift is a move without a grab, for a hand that already knows the
        // keys; a terminal that eats one of them still has the grab
        const quick = k.name === 'up' || k.name === 'down' ? k.shift || k.meta : false;

        if (k.name === 'space') {
          carrying = !carrying;
        } else if (k.name === 'up' || k.name === 'down') {
          const by = k.name === 'up' ? -1 : 1;
          if (carrying || quick) {
            carry(at + by);
          } else {
            step(by);
          }
        } else if (k.name === 'home') {
          if (carrying) {
            carry(0);
          } else {
            at = 0;
          }
        } else if (k.name === 'end') {
          if (carrying) {
            carry(slots.length - 1);
          } else {
            at = slots.length - 1;
          }
        } else if (k.name === 'pageup' || k.name === 'pagedown') {
          const to = Math.min(
            Math.max(0, at + (k.name === 'pageup' ? -page : page)),
            slots.length - 1
          );
          if (carrying) {
            carry(to);
          } else {
            at = to;
          }
        }

        draw();
      },

      settle(): void {
        promptAnswered(mark);
        hint.setText(order.map((choice) => choice.short ?? choice.label).join(', '));
        hint.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        list.setProps({ display: 'none' });
      },

      view,
    };
  });
}
