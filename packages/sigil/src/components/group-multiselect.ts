/**
 * A multiselect whose choices sit under named groups.
 *
 * ```js
 * const features = await groupMultiselect({
 *   message: 'Features',
 *   choices: {
 *     Frontend: ['React', 'Vue', { label: 'Svelte', selected: true }],
 *     Backend: ['Express', 'Fastify'],
 *   },
 * });
 * ```
 *
 * A group is a row of its own: Space on it ticks every choice under it, or clears
 * them if they are all ticked already, and its box says which of the three it is
 * -- none, some, or all. The answer is a flat list of the values of the choices,
 * in the order they are listed; a group is a way of picking, not something that
 * is picked.
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
  promptNote,
  type PromptOptions,
  PromptError,
  promptValue,
  runPrompt,
  setPromptNote,
} from './prompt.js';

/** The box of a group with some of its choices ticked and some not. */
const PARTIAL = '◐';

export interface GroupMultiselectOptions<T> extends PromptOptions {
  /**
   * What to offer, as group name to the choices under it. Groups are listed in
   * the order the object holds them. A choice is what `multiselect()` takes:
   * `disabled` and `selected` mean the same, and a `description` is shown while it
   * is highlighted. A separator is not allowed -- the groups are the headings.
   */
  choices: Readonly<Record<string, readonly (Choice<T> | string)[]>>;
  /**
   * Whether the cursor wraps from one end of the list to the other. Defaults to
   * `true`; `false` stops it at the first and last row on offer.
   */
  loop?: boolean;
  /** Refuse more than this many choices. Unlimited if omitted. Groups are not counted. */
  max?: number;
  /** Refuse fewer than this many. Defaults to 0, or 1 when `required`. */
  min?: number;
  /** Refuse an empty selection. Defaults to `false`. Same as `min: 1`. */
  required?: boolean;
  /**
   * Whether a group's heading can be ticked. Defaults to `true`. `false` makes a
   * heading a heading: the cursor steps over it and only the choices under it can
   * be ticked.
   */
  selectableGroups?: boolean;
}

/** One line of the list: a group, or a choice under one. */
type Row<T> =
  | {
      kind: 'group';
      label: string;
      /** The rows of its choices that are on offer. */
      members: number[];
      offered: boolean;
    }
  | { choice: Choice<T>; kind: 'option'; offered: boolean };

/** Everything the painter changes about one row. */
interface RowView {
  hint: Element;
  label: Element;
  mark: Element;
  pointer: Element;
  row: Element;
}

/**
 * Asks for any number of a list that has groups.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen values, in the order they are listed.
 */
export function groupMultiselect<T = string>(opts: GroupMultiselectOptions<T>): Promise<T[]> {
  const groups: [string, readonly (Choice<T> | string)[]][] =
    typeof opts.choices === 'object' && opts.choices !== null && !Array.isArray(opts.choices)
      ? Object.entries(opts.choices)
      : [];
  const selectableGroups = opts.selectableGroups ?? true;
  const rows: Row<T>[] = [];

  for (const [label, entries] of groups) {
    if (!Array.isArray(entries)) {
      return Promise.reject(new PromptError(`"${opts.message}" has a group that is not a list`));
    }

    const at = rows.length;
    rows.push({ kind: 'group', label, members: [], offered: false });

    for (const entry of entries) {
      // a type that forbids one does not stop a caller who has no types
      if (typeof entry === 'object' && entry !== null && 'separator' in (entry as object)) {
        return Promise.reject(new PromptError(`"${opts.message}" has a separator inside a group`));
      }
      const choice = promptChoice<T>(entry);
      rows.push({ choice, kind: 'option', offered: !choice.disabled });
    }

    const group = rows[at] as Extract<Row<T>, { kind: 'group' }>;
    group.members = rows.flatMap((row, i) =>
      i > at && row.kind === 'option' && row.offered ? [i] : []
    );
    // a heading over nothing that can be ticked is nothing to tick; and when
    // groups are headings only it is never on offer, whatever is under it
    group.offered = selectableGroups && group.members.length > 0;
  }

  const offeredRows = rows.flatMap((row, i) => (row.offered ? [i] : []));
  const options = rows.flatMap((row, i) => (row.kind === 'option' && row.offered ? [i] : []));

  // a list with nothing in it and a list with nothing on offer are the same
  // question to the person at the keyboard
  if (offeredRows.length === 0) {
    return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
  }

  const min = opts.min ?? (opts.required ? 1 : 0);
  const max = opts.max ?? Number.POSITIVE_INFINITY;

  if (!Number.isInteger(min) || min < 0 || (max !== Infinity && !Number.isInteger(max))) {
    return Promise.reject(
      new PromptError(`"${opts.message}" has a min or max that is not a whole number`)
    );
  }
  if (min > max) {
    return Promise.reject(new PromptError(`"${opts.message}" has a min greater than its max`));
  }

  const loop = opts.loop ?? true;
  const terminal = opts.terminal ?? defaultTerminal;
  // a disabled choice is never ticked, whatever `selected` says
  const ticked = new Set<number>(
    options.filter((i) => (rows[i] as Extract<Row<T>, { kind: 'option' }>).choice.selected)
  );
  let active = offeredRows[0];
  let error: string | undefined;
  let start = 0;

  function choiceAt(i: number): Choice<T> {
    return (rows[i] as Extract<Row<T>, { kind: 'option' }>).choice;
  }

  function chosen(): T[] {
    return [...ticked].sort((a, b) => a - b).map((i) => promptValue(choiceAt(i)));
  }

  /** How much of a group is ticked. Derived, so a choice and its group cannot disagree. */
  function stateOf(i: number): 'none' | 'some' | 'all' {
    const { members } = rows[i] as Extract<Row<T>, { kind: 'group' }>;
    const n = members.filter((m) => ticked.has(m)).length;
    return n === 0 ? 'none' : n === members.length ? 'all' : 'some';
  }

  function complaint(): string | undefined {
    if (ticked.size < min) {
      return min === 1 ? __`Choose at least one` : __`Choose at least ${min}`;
    }
    if (ticked.size > max) {
      return __`Choose at most ${max}`;
    }
    return undefined;
  }

  /** The nearest row on offer one way from `from`, or `from` if there is none. */
  function seek(from: number, direction: 1 | -1): number {
    for (let step = 1; step <= rows.length; step++) {
      let at = from + direction * step;
      if (loop) {
        at = ((at % rows.length) + rows.length) % rows.length;
      } else if (at < 0 || at >= rows.length) {
        break;
      }
      if (rows[at].offered) {
        return at;
      }
    }
    return from;
  }

  return runPrompt<T[]>(opts, () => {
    const hintText = __`(space to select, enter to confirm)`;
    const hint = textNode(hintText, { class: 'sigil-prompt-hint sigil-muted' });
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width), hintText);
    const { line, mark } = promptHeadLine(opts.message, head.message, hint);

    const views = rows.map((row): RowView => {
      // the cursor on every row, hidden where it is not the active one, for the
      // reason `select()` records: hidden content still takes its space. A choice
      // is pushed in under its group by a wider margin on the same element
      const pointer = textNode(PROMPT_SYMBOLS.cursor, {
        'margin-right': row.kind === 'option' ? 3 : 1,
        visibility: 'hidden',
      });
      const mark = textNode(PROMPT_SYMBOLS.off, { class: 'sigil-choice-mark', 'margin-right': 1 });

      if (row.kind === 'group' && !selectableGroups) {
        // a heading only: it starts in the cursor's column and has no box
        pointer.setProps({ display: 'none' });
        mark.setProps({ display: 'none' });
      }

      const reason =
        row.kind === 'option'
          ? typeof row.choice.disabled === 'string' && row.choice.disabled
            ? row.choice.disabled
            : row.choice.disabled
              ? __`disabled`
              : row.choice.hint
          : undefined;
      const label = textNode(row.kind === 'group' ? row.label : row.choice.label, {
        class:
          row.kind === 'group'
            ? selectableGroups
              ? row.offered
                ? 'sigil-choice-group sigil-heading'
                : 'sigil-choice-group sigil-muted'
              : 'sigil-choice-separator sigil-muted'
            : row.offered
              ? ''
              : 'sigil-muted',
      });
      const hint = textNode(reason ?? '', {
        class: 'sigil-choice-hint sigil-muted',
        display: reason ? 'flex' : 'none',
        'margin-left': 1,
      });

      return {
        hint,
        label,
        mark,
        pointer,
        row: box({ class: 'sigil-choice' }, pointer, mark, label, hint),
      };
    });

    const list = box({ 'flex-direction': 'column' }, ...views.map((view) => view.row));
    const describing = rows.some((row) => row.kind === 'option' && row.choice.description);
    const description = textNode('', {
      class: 'sigil-choice-description sigil-muted',
      display: 'none',
      'margin-left': 2,
    });
    const problem = promptNote('sigil-prompt-error sigil-error');
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      list,
      description,
      box({ 'padding-left': 2 }, problem)
    );

    // the question's rows, the description's, and the line an error would take:
    // reserved either way, so that showing one does not push the last row off
    const room = (): number =>
      Math.max(1, Math.max(1, terminal.height) - head.lines - 1 - (describing ? 1 : 0));

    function draw(): void {
      const visible = Math.max(1, Math.min(room(), rows.length));
      start = listWindow(rows.length, active, room(), start);
      setPromptNote(problem, error);

      for (const [i, row] of rows.entries()) {
        const v = views[i];
        const here = i === active;
        v.row.setProps({
          class: here ? 'sigil-choice is-active sigil-accent' : 'sigil-choice',
          display: i >= start && i < start + visible ? 'flex' : 'none',
        });

        if (row.kind === 'group' && !selectableGroups) {
          continue;
        }

        v.pointer.setProps({
          class: here ? 'sigil-choice-pointer' : '',
          visibility: here ? 'visible' : 'hidden',
        });

        const state = row.kind === 'group' ? stateOf(i) : ticked.has(i) ? 'all' : 'none';
        v.mark.setText(
          state === 'all' ? PROMPT_SYMBOLS.on : state === 'some' ? PARTIAL : PROMPT_SYMBOLS.off
        );
        v.mark.setProps({
          class:
            state === 'all'
              ? 'sigil-choice-mark is-on sigil-success'
              : state === 'some'
                ? 'sigil-choice-mark is-partial sigil-accent'
                : row.offered
                  ? 'sigil-choice-mark'
                  : 'sigil-choice-mark sigil-muted',
        });
      }

      const text = rows[active].kind === 'option' ? choiceAt(active).description : undefined;
      description.setText(text ?? '');
      description.setProps({ display: text ? 'flex' : 'none' });
    }

    draw();

    return {
      key(k) {
        error = undefined;

        if (k.name === 'enter') {
          error = complaint();
          if (error) {
            draw();
            return;
          }
          return { value: chosen() };
        }

        if (k.name === 'space') {
          const row = rows[active];
          if (row.kind === 'group') {
            // all, or none if every choice under it that can be ticked already is
            const clear = stateOf(active) === 'all';
            for (const m of row.members) {
              if (clear) {
                ticked.delete(m);
              } else {
                ticked.add(m);
              }
            }
          } else if (ticked.has(active)) {
            ticked.delete(active);
          } else {
            ticked.add(active);
          }
        } else if (k.name === 'up') {
          active = seek(active, -1);
        } else if (k.name === 'down') {
          active = seek(active, 1);
        } else if (k.name === 'home') {
          active = offeredRows[0];
        } else if (k.name === 'end') {
          active = offeredRows.at(-1) as number;
        } else if (k.name === 'a' && !k.meta) {
          // every choice, or none if they all are already; a group is the sum of
          // its choices and has nothing of its own to tick
          if (options.every((i) => ticked.has(i))) {
            for (const i of options) {
              ticked.delete(i);
            }
          } else {
            for (const i of options) {
              ticked.add(i);
            }
          }
        } else if (k.name === 'i' && !k.ctrl && !k.meta) {
          for (const i of options) {
            if (ticked.has(i)) {
              ticked.delete(i);
            } else {
              ticked.add(i);
            }
          }
        }

        draw();
      },

      settle(values: T[]): void {
        promptAnswered(mark);
        hint.setText(
          values.length
            ? [...ticked]
                .sort((a, b) => a - b)
                .map((i) => choiceAt(i).short ?? choiceAt(i).label)
                .join(', ')
            : __`none`
        );
        hint.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        list.setProps({ display: 'none' });
        description.setProps({ display: 'none' });
        setPromptNote(problem, undefined);
      },

      view,
    };
  });
}
