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
  type AccessibleOptions,
  type Choice,
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptAnswerSlot,
  promptAsLines,
  promptChoice,
  promptFooter,
  promptHeadLine,
  promptHeadWidths,
  promptKeys,
  promptLineList,
  promptLineNumbers,
  promptLineQuestion,
  type PromptOptions,
  PromptError,
  promptListRows,
  promptSameValue,
  promptValue,
  runLinePrompt,
  runPrompt,
} from './prompt.js';

export interface SortOptions<T> extends PromptOptions, AccessibleOptions {
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
  /**
   * An answer to start from: the order the list opens in. The rows it names come
   * first, in its order, and the rest after them in theirs; a pinned row keeps
   * its place either way, and a value no movable row holds is dropped.
   */
  value?: readonly T[];
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
 * The list put in the order of a starting answer.
 *
 * Only the movable rows move, into the movable places, so a pinned row keeps its
 * place exactly as it does under a carry. Those the answer names come first, in
 * its order; the rest follow in theirs -- which is what a list that has gained a
 * row since it was last answered should look like, the new row last. A value no
 * movable row holds is dropped.
 *
 * @param start - The choices, in the order they were given.
 * @param slots - The movable places.
 * @param value - The answer to start from.
 * @returns The choices in the order to start in.
 */
function arranged<T>(start: Choice<T>[], slots: number[], value: readonly T[]): Choice<T>[] {
  const rank = (choice: Choice<T>): number => {
    const at = value.findIndex((v) => promptSameValue(v, promptValue(choice)));
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  // a stable sort, so the rows the answer does not name keep their order
  const movable = slots
    .map((slot) => start[slot] as Choice<T>)
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra === rb ? 0 : ra < rb ? -1 : 1;
    });
  const order = [...start];
  slots.forEach((slot, i) => {
    order[slot] = movable[i] as Choice<T>;
  });
  return order;
}

/**
 * The list as lines: numbered in the order it is in, and a reply that is the
 * order wanted, as those numbers -- `3 1 2`.
 *
 * A carry is a gesture over a list that is redrawn under it, so as a line the
 * order is said rather than walked to: the numbers, first to last, read by
 * `multiselect()`'s reader, so a range is a run of rows in order and `3-1` is
 * one reversed. Those left out follow in the order they are in, which makes `4`
 * mean "put the fourth first" -- the move a carry is most often for -- and Enter
 * alone keeps the order as it is. A number given twice is refused rather than
 * read as either place. A pinned row is listed where it is and has no number,
 * so it keeps its place, as it does under a carry.
 *
 * @param opts - What to ask.
 * @param order - The list, in the order it starts in.
 * @param slots - The places a row can move between.
 * @returns The values, in the order asked for.
 */
function lineSort<T>(opts: SortOptions<T>, order: Choice<T>[], slots: number[]): Promise<T[]> {
  const { choices, lines } = promptLineList(order);
  const count = choices.length;
  const kept = choices.map((_, at) => at + 1).join(' ');

  return runLinePrompt<T[]>(opts, {
    ask: promptLineQuestion(
      __`Type the numbers in the order you want them`,
      __`(default: ${kept})`
    ),
    before: [opts.message, ...lines],
    echo: true,
    keep: true,
    read(reply) {
      const named = promptLineNumbers(reply.trim(), count);
      if (typeof named === 'string') {
        return named;
      }
      const twice = named.find((n, at) => named.indexOf(n) !== at);
      if (twice !== undefined) {
        return __`${twice} is given more than once`;
      }
      const first = named.map((n) => choices[n - 1] as Choice<T>);
      const moved = [...first, ...choices.filter((choice) => !first.includes(choice))];
      const result = order.map((choice, at) => {
        const slot = slots.indexOf(at);
        return slot < 0 ? choice : (moved[slot] as Choice<T>);
      });
      return {
        said: __`Order: ${result.map((choice) => choice.short ?? choice.label).join(', ')}`,
        value: result.map((choice) => promptValue(choice)),
      };
    },
  });
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
  let order = Array.isArray(opts.value)
    ? arranged(start, slots, opts.value as readonly T[])
    : start;
  // an index into `slots`, so that the highlight cannot rest on a pinned place
  let at = (() => {
    const wanted = Math.min(Math.max(0, opts.initial ?? 0), start.length - 1);
    const found = slots.findIndex((slot) => slot >= wanted);
    return found < 0 ? slots.length - 1 : found;
  })();
  let carrying = false;
  let top = 0;

  if (promptAsLines(opts)) {
    return lineSort(opts, order, slots);
  }

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
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const answer = promptAnswerSlot(head.rest);
    const { line, mark } = promptHeadLine(opts.message, head.message, answer.beside);
    const list = box({ class: 'sigil-sort-list', 'flex-direction': 'column' });

    /** Moves the highlight, or the row being carried, to a place. */
    function goTo(to: number): void {
      if (carrying) {
        carry(to);
      } else {
        at = to;
      }
    }

    /** Up or Down. A quick one moves the row without a grab. */
    function arrow(by: -1 | 1, quick: boolean): void {
      if (carrying || quick) {
        carry(at + by);
      } else {
        step(by);
      }
    }

    /** A page, in rows: the window less one, so a row stays in view. */
    const page = (): number => Math.max(1, room() - 1);

    // what the footer says follows the grab: Space reads `grab` until a row is
    // up and `drop` while one is, and the arrows are listed only while carrying,
    // because that is when they do something nobody would guess. Help is a
    // function for exactly that, read again on `refresh()`
    const keys = promptKeys<{ value: T[] } | void>();
    const moving = () => (carrying ? { description: __`move`, priority: 1 } : undefined);
    keys.on('up', () => arrow(-1, false), moving);
    keys.on('down', () => arrow(1, false), moving);
    // alt or shift is a move without a grab, for a hand that already knows the
    // keys; a terminal that eats one of them still has the grab
    for (const mod of ['shift', 'alt']) {
      keys.on(`${mod}+up`, () => arrow(-1, true));
      keys.on(`${mod}+down`, () => arrow(1, true));
    }
    keys.on(
      'space',
      () => {
        carrying = !carrying;
      },
      () => ({ description: carrying ? __`drop` : __`grab`, priority: 2 })
    );
    keys.on('enter', () => ({ value: order.map((choice) => promptValue(choice)) }), {
      description: __`confirm`,
      priority: 0,
    });
    keys.on('home', () => goTo(0));
    keys.on('end', () => goTo(slots.length - 1));
    keys.on('pageup', () => goTo(Math.max(0, at - page())));
    keys.on('pagedown', () => goTo(Math.min(slots.length - 1, at + page())));

    const footer = promptFooter(keys, terminal.width, opts.back);
    const view = box(
      { class: 'sigil-prompt sigil-sort', 'flex-direction': 'column' },
      line,
      answer.under,
      list,
      footer
    );

    // the footer's row is kept back with the question's
    const room = (): number => {
      return promptListRows(opts.rows, terminal.height, head.lines + 1);
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
      keys.refresh();
    }

    draw();

    return {
      key(k) {
        const done = keys.match(k)?.(k);
        if (done) {
          return done;
        }
        draw();
      },

      settle(): void {
        promptAnswered(mark);
        answer.show(order.map((choice) => choice.short ?? choice.label).join(', '));
        list.setProps({ display: 'none' });
        footer.setProps({ display: 'none' });
      },

      view,
    };
  });
}
