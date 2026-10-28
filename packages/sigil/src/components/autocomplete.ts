/**
 * An autocomplete prompt: type to narrow a list, then pick from it.
 *
 * The shape is the command palette's -- a filter field over a ranked list -- with
 * the difference that the list is the caller's and the answer is a value rather
 * than a command. Two things can supply it, and one entry point takes either:
 * a static `choices` list, ranked against what is typed with `rankBy()`, or an
 * async `source(term, signal)` that is asked instead, for a list that lives
 * somewhere a keystroke away from this process.
 *
 * ```js
 * const region = await autocomplete({
 *   message: 'Region',
 *   choices: ['us-east-1', 'us-west-2', 'eu-central-1'],
 * });
 *
 * const pkg = await autocomplete({
 *   message: 'Package',
 *   source: async (term, signal) => {
 *     const res = await fetch(`https://registry.example/search?q=${term}`, { signal });
 *     return (await res.json()).names;
 *   },
 * });
 * ```
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { onCleanup } from '../renderer/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { boundary, deleteAfter, deleteBefore, insertAt, pastedLine, typedText } from './editing.js';
import { highlightRuns, rankBy } from './fuzzy.js';
import {
  type Choice,
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptChoice,
  promptHeadLine,
  promptHeadWidths,
  promptNote,
  type PromptOptions,
  PromptError,
  promptRowCap,
  promptValue,
  promptWindow,
  runPrompt,
  setPromptNote,
} from './prompt.js';

/**
 * Asks for the choices a term leads to.
 *
 * `signal` is aborted when the term changes, or when the prompt ends, so a lookup
 * that can be cancelled -- `fetch()` takes the signal directly -- stops costing
 * anything the moment its answer could not be used. A call that is aborted has
 * its result thrown away whether or not it honoured the signal, so a source that
 * ignores it is merely wasteful, never wrong.
 *
 * It is called with `''` before anything is typed, so the prompt opens with
 * whatever the source offers for no term at all.
 */
export type AutocompleteSource<T> = (
  term: string,
  signal: AbortSignal
) => Promise<readonly (Choice<T> | string)[]> | readonly (Choice<T> | string)[];

export interface AutocompleteOptions<T> extends PromptOptions {
  /**
   * What to offer, filtered by what is typed. Give this or `source`, not both.
   * A choice marked `disabled` is left out, and a list of nothing else is refused
   * the way an empty one is.
   */
  choices?: readonly (Choice<T> | string)[];
  /** The text the field starts with. Defaults to nothing. */
  initial?: string;
  /** Shown dimmed when nothing has been typed. */
  placeholder?: string;
  /**
   * How many rows the list may take. Defaults to what the terminal has left under
   * the question.
   */
  rows?: number;
  /**
   * Looks the choices up instead of filtering a list. The result is shown as it
   * is: the source is the filter, so nothing is re-ranked here.
   *
   * There is no debounce. Calling a server per keystroke is the caller's trade
   * to make, and the signal is what makes the cheap answer -- wait a moment, then
   * look -- possible to write; see the README for the recipe. A choice it returns
   * marked `disabled` is left out of what is shown.
   */
  source?: AutocompleteSource<T>;
  /**
   * Checks the chosen value. Return a string to refuse it with that message,
   * or anything falsy to accept.
   */
  validate?: (value: T) => string | undefined | false | Promise<string | undefined | false>;
}

/** One row of what is on offer, and which of its code points the term matched. */
interface Offer<T> {
  readonly choice: Choice<T>;
  readonly matched: readonly number[];
}

/**
 * Whether a choice may be answered with.
 *
 * `select()` steps over a disabled choice, and this prompt has no cursor to step
 * with -- a disabled one would be ranked, highlighted, filled in by Tab and taken
 * by Enter -- so it is left out of what is offered, which is the one answer that
 * needs no second rule about which of those four is allowed to touch it. Read the
 * way `select()` reads it: only a truthy `disabled` counts, so `''` is on offer.
 */
function isOffered<T>(choice: Choice<T>): boolean {
  return !choice.disabled;
}

/**
 * The row for one offer.
 *
 * Built per draw for the rows that are on screen, rather than kept per choice as
 * the palette does: a source hands back a different list every time, so there is
 * no stable set of rows to keep, and a window of ten is cheap to rebuild.
 *
 * @param offer - What to show.
 * @param current - Whether it is the highlighted row.
 * @returns The row.
 */
function offerRow<T>({ choice, matched }: Offer<T>, current: boolean): Element {
  // the pointer is on every row and `visibility` takes it off the others, for the
  // reason the choice list records: hidden content still takes its space, and a
  // text of one space would measure nothing at all
  const pointer = textNode(PROMPT_SYMBOLS.cursor, {
    class: current ? 'sigil-choice-pointer' : '',
    'margin-right': 1,
    visibility: current ? 'visible' : 'hidden',
    'white-space': 'nowrap',
  });
  const label = box(
    { class: 'sigil-autocomplete-label', 'flex-shrink': 0 },
    ...highlightRuns(choice.label, matched).map((run) =>
      textNode(run.text, {
        class: run.on ? 'sigil-autocomplete-match sigil-heading' : '',
        'white-space': 'nowrap',
      })
    )
  );
  const hint = textNode(choice.hint ?? '', {
    class: 'sigil-choice-hint sigil-muted',
    display: choice.hint ? 'flex' : 'none',
    'margin-left': 1,
    'white-space': 'nowrap',
  });

  return box(
    { class: current ? 'sigil-choice is-active sigil-accent' : 'sigil-choice' },
    pointer,
    label,
    hint
  );
}

/**
 * Asks for one of a list, narrowed as the answer is typed.
 *
 * Up and Down move through what is left, wrapping, and Enter answers with the
 * highlighted choice's value -- its label, if it has none. Tab copies the
 * highlighted label into the field, which is how a long name is finished without
 * typing the rest of it. A term that leaves nothing shows a message and Enter
 * does nothing until something is on offer, rather than answering with a row that
 * is not there.
 *
 * A source that rejects shows its message under the field and the prompt carries
 * on: the next keystroke asks again, which is the recovery from a lookup that
 * failed for a reason that may not last.
 *
 * @param opts - What to ask, and where the choices come from.
 * @returns The chosen value.
 */
export function autocomplete<T = string>(opts: AutocompleteOptions<T>): Promise<T> {
  const { source } = opts;

  if (source !== undefined && opts.choices !== undefined) {
    return Promise.reject(
      new PromptError(`"${opts.message}" was given both choices and a source; give one`)
    );
  }
  if (source === undefined && opts.choices === undefined) {
    return Promise.reject(
      new PromptError(`"${opts.message}" needs either choices or a source to offer`)
    );
  }

  const fixed = opts.choices?.map((choice) => promptChoice<T>(choice)).filter(isOffered);
  if (fixed?.length === 0) {
    return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
  }

  const terminal = opts.terminal ?? defaultTerminal;
  let value = opts.initial ?? '';
  let cursor = value.length;
  let active = 0;
  let start = 0;

  return runPrompt<T>(opts, () => {
    const before = textNode('', { 'white-space': 'nowrap' });
    const caret = textNode('', { class: 'sigil-caret', 'white-space': 'nowrap' });
    const after = textNode('', { 'white-space': 'nowrap' });
    const field = box({ class: 'sigil-prompt-field' }, before, caret, after);
    const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const { line, mark } = promptHeadLine(opts.message, head.message, field, answer);
    const list = box({ class: 'sigil-autocomplete-list', 'flex-direction': 'column' });
    // one line under the list for whatever there is to say about it: a refusal,
    // a lookup in flight, or that nothing matched. They are never true together
    // -- a failure empties the list, and the other two are about its state --
    // so one element with the most pressing of them is the whole of it
    const foot = promptNote('');
    const view = box(
      { class: 'sigil-prompt sigil-autocomplete', 'flex-direction': 'column' },
      line,
      box({ 'padding-left': 2 }, list),
      box({ 'padding-left': 2 }, foot)
    );

    /** What is on offer for the current term. */
    let offers: Offer<T>[] = [];
    /** Whether a lookup for the current term is still out. */
    let pending = false;
    /** Why the last lookup failed, until the next one is asked for. */
    let failure: string | undefined;
    /** What `validate` refused, until the next key. */
    let complaint: string | undefined;
    /** Aborts the lookup in flight. */
    let controller: AbortController | undefined;
    /** What was chosen, for `settle()` to show. */
    let chosen: Choice<T> | undefined;
    /** Set once the prompt is over, so a late answer draws on nothing. */
    let closed = false;

    onCleanup(() => {
      closed = true;
      controller?.abort();
    });

    /**
     * The rows the list has, once the question and the foot have taken theirs.
     *
     * `promptRowCap()` is the palette's rule, for the palette's reason: a `rows`
     * that is `NaN` must not blank the list.
     */
    const room = (): number => {
      const avail = Math.max(1, Math.max(1, terminal.height) - head.lines - 1);
      return Math.max(1, Math.min(promptRowCap(opts.rows, avail), avail));
    };

    function draw(): void {
      active = Math.min(Math.max(0, active), Math.max(0, offers.length - 1));
      start = listWindow(offers.length, active, room(), start);
      const visible = Math.max(1, Math.min(room(), offers.length));

      while (list.children.length > 0) {
        list.removeChild(list.children[0] as Element);
      }
      for (const [rank, offer] of offers.entries()) {
        if (rank >= start && rank < start + visible) {
          list.append(offerRow(offer, rank === active));
        }
      }

      const problem = complaint ?? failure;
      if (problem) {
        foot.setProps({ class: 'sigil-prompt-error sigil-error' });
        setPromptNote(foot, problem);
      } else if (pending) {
        foot.setProps({ class: 'sigil-autocomplete-status sigil-muted' });
        setPromptNote(foot, __`Searching...`);
      } else if (offers.length === 0) {
        foot.setProps({ class: 'sigil-autocomplete-status sigil-muted' });
        setPromptNote(foot, __`No matches`);
      } else {
        setPromptNote(foot, undefined);
      }

      if (value === '' && opts.placeholder) {
        const end = boundary(opts.placeholder, 0, 1);
        before.setText('');
        // under the reverse video either way, so not dimmed with the rest: that
        // is how a caret comes to read as part of the hint
        caret.setText(opts.placeholder.slice(0, end) || ' ');
        after.setText(opts.placeholder.slice(end));
        after.setProps({ class: 'sigil-prompt-placeholder sigil-muted' });
        return;
      }

      const pane = promptWindow(value, cursor, head.rest);
      before.setText(pane.before);
      caret.setText(pane.under || ' ');
      after.setText(pane.after);
      after.setProps({ class: '' });
    }

    /**
     * Works out what is on offer for the term, asking the source if there is one.
     *
     * A static list is ranked on the spot. A source is asked, and what it answers
     * lands later -- unless the term has moved on by then, which is what the signal
     * says: the previous lookup is aborted *before* the next is started, and a
     * result is only taken if its own signal is still live. Checking the signal
     * rather than comparing terms is the difference between "this lookup was
     * superseded" and "this lookup happens to be for the same text", and it is the
     * former that must never write.
     */
    function refresh(): void {
      failure = undefined;

      if (fixed) {
        offers = rankBy(value, fixed, (choice) => choice.label).map(({ item, match }) => ({
          choice: item,
          matched: match.matched,
        }));
        return;
      }

      controller?.abort();
      const own = new AbortController();
      controller = own;
      pending = true;

      let asked: Promise<readonly (Choice<T> | string)[]>;
      try {
        asked = Promise.resolve(source?.(value, own.signal) ?? []);
      } catch (error) {
        asked = Promise.reject(error);
      }

      asked.then(
        (found) => {
          if (own.signal.aborted || closed) {
            return;
          }
          pending = false;
          offers = found
            .map((choice) => promptChoice<T>(choice))
            .filter(isOffered)
            .map((choice) => ({ choice, matched: [] }));
          active = 0;
          draw();
        },
        (error: unknown) => {
          if (own.signal.aborted || closed) {
            return;
          }
          pending = false;
          // nothing to pick from: the list on screen answered a different term,
          // and leaving it up beside a refusal reads as though it were current
          offers = [];
          failure = error instanceof Error ? error.message : String(error);
          draw();
        }
      );
    }

    /** A new term is a new list, with the highlight back at the top. */
    function changed(): void {
      active = 0;
      refresh();
    }

    refresh();
    draw();

    return {
      async key(k) {
        complaint = undefined;

        if (k.name === 'enter') {
          // a lookup still out means the list on screen is for an earlier term,
          // and answering with a row of it would be answering a question that
          // is no longer the one asked
          const picked = pending ? undefined : offers[active]?.choice;
          if (picked) {
            const failed = await opts.validate?.(promptValue(picked));
            if (typeof failed === 'string' && failed) {
              complaint = failed;
              draw();
              return;
            }
            chosen = picked;
            return { value: promptValue(picked) };
          }
        } else if (k.name === 'tab') {
          const picked = offers[active]?.choice;
          if (picked && picked.label !== value) {
            value = picked.label;
            cursor = value.length;
            changed();
            // keep the choice just completed under the highlight: ranking its own
            // label usually puts it first, but an equal score is not guaranteed
            // to, and moving the highlight off what was just chosen would make
            // Tab and Enter disagree
            if (fixed) {
              const at = offers.findIndex((offer) => offer.choice === picked);
              active = Math.max(0, at);
            }
          }
        } else if (k.name === 'up') {
          // wrapping, for `select()`'s reason: a list you cannot get to the end
          // of by going up is one you have to know the length of
          active = offers.length === 0 ? 0 : (active - 1 + offers.length) % offers.length;
        } else if (k.name === 'down') {
          active = offers.length === 0 ? 0 : (active + 1) % offers.length;
        } else if (k.name === 'pageup') {
          active = Math.max(0, active - Math.max(1, room() - 1));
        } else if (k.name === 'pagedown') {
          active = Math.min(Math.max(0, offers.length - 1), active + Math.max(1, room() - 1));
        } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          cursor = 0;
        } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          cursor = value.length;
        } else if (k.name === 'left') {
          cursor = boundary(value, cursor, -1);
        } else if (k.name === 'right') {
          cursor = boundary(value, cursor, 1);
        } else if (k.name === 'backspace') {
          const prior = value;
          ({ cursor, value } = deleteBefore(value, cursor));
          if (value !== prior) {
            changed();
          }
        } else if (k.name === 'delete') {
          const prior = value;
          ({ cursor, value } = deleteAfter(value, cursor));
          if (value !== prior) {
            changed();
          }
        } else if (k.ctrl && k.name === 'u') {
          if (cursor > 0) {
            value = value.slice(cursor);
            cursor = 0;
            changed();
          }
        } else {
          // asked before inserting rather than inserting whatever it answered:
          // a key this field has no use for must not ask the source again
          const typed = typedText(k);
          if (typed !== undefined) {
            ({ cursor, value } = insertAt(value, cursor, typed));
            changed();
          }
        }

        draw();
      },

      paste(block: string): void {
        const typed = pastedLine(block);
        if (typed !== '') {
          ({ cursor, value } = insertAt(value, cursor, typed));
          changed();
        }
        draw();
      },

      settle(): void {
        promptAnswered(mark);
        before.setText('');
        caret.setText('');
        caret.setProps({ class: '' });
        after.setText('');
        answer.setText(chosen?.label ?? '');
        answer.setProps({ display: 'flex' });
        // the list goes: what is left is the question and its answer, which is
        // the one line worth keeping in a log
        list.setProps({ display: 'none' });
        setPromptNote(foot, undefined);
      },

      view,
    };
  });
}
