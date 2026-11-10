/**
 * A radio set: one of several options, as one control.
 *
 * Textual's `RadioSet`, and in a settings screen it is a log level, a theme, a
 * region -- a choice whose options are few enough to show all at once, which is
 * when a list of them reads better than a dropdown.
 *
 * ```js
 * import { RadioSet } from '@ttylabs/sigil/components/radio-set';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const level = new State('info');
 * const levels = RadioSet({
 *   options: ['debug', 'info', 'warn', { label: 'trace', disabled: 'needs a debug build' }],
 *   value: level,
 * });
 * ```
 *
 * The set is **one** stop in the focus ring, the way the tab row is, and the
 * arrows move inside it: Up and Down, or Left and Right, select the option before
 * or after, stepping over a disabled one, and Home and End the first and last.
 * They select straight away, as the tab row's arrows switch the tab. Space selects
 * the highlighted option, which matters only when nothing was selected yet, and a
 * left click on an option selects it. Enter is not the set's, and goes on to the
 * form around it. `AGENTS.md` has the reasons under "Form controls".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import {
  type ControlDescriber,
  controlDisabled,
  controlFlag,
  describeControls,
} from './control.js';
import { labelLine } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import {
  type Choice,
  PROMPT_SYMBOLS,
  promptChoice,
  promptSameValue,
  promptValue,
} from './prompt.js';

/**
 * One option: the fields of a `select()` choice that a radio set draws, so one
 * list of choices can be handed to either.
 */
export type RadioOption<T = unknown> = Pick<Choice<T>, 'disabled' | 'hint' | 'label' | 'value'>;

export interface RadioSetProps<T = unknown> {
  /** Whether the options are a column, one per line, or a row. Defaults to a column. */
  direction?: 'column' | 'row';
  /**
   * Whether the whole set refuses to change.
   *
   * A disabled set is out of the focus ring, ignores keys and clicks, and is drawn
   * in the muted role. A `State<boolean>` is read live. Defaults to `false`. A set
   * whose every option is disabled is disabled too, since nothing in it can be
   * chosen.
   */
  disabled?: boolean | State<boolean>;
  /** Called with the option's value after a key or a click selected it. Not called for a write the app made. */
  onChange?: (value: T) => void;
  /**
   * The options, in order. A string is an option whose label is its value. A
   * `disabled` option is drawn muted with its reason beside it, the arrows step
   * over it and a click does nothing.
   */
  options: readonly (RadioOption<T> | string)[];
  /** The host box's own props: a class, a margin. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey'>;
  /**
   * The value of the option that is selected.
   *
   * A value is where it starts. A `State` is the value itself: the keys and the
   * mouse write it, and an app that writes it selects the option holding that
   * value -- or none, for a value no option holds. Compared the way a `Map`
   * compares keys. Defaults to none selected.
   */
  value?: State<T | undefined> | State<T> | T;
}

/** Each set's host, which is its focusable element, and the way its options run. */
const SETS = new WeakMap<Element, 'column' | 'row'>();

/**
 * Builds a radio set.
 *
 * @param props - The options, which is selected, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function RadioSet<T = string>(props: RadioSetProps<T>): Element {
  refuseOwnedHooks('RadioSet', props?.props, ['onKey', 'onFocusChange']);
  if (!Array.isArray(props?.options) || props.options.length === 0) {
    throw new TypeError(__`Expected radio set options to be a non-empty array`);
  }
  for (const option of props.options) {
    if (typeof option !== 'string' && typeof option?.label !== 'string') {
      throw new TypeError(__`Expected every radio option to be a string or have a label`);
    }
  }
  if (props.direction !== undefined && props.direction !== 'column' && props.direction !== 'row') {
    throw new TypeError(__`Expected a radio set direction to be column or row`);
  }
  if (props.onChange !== undefined && typeof props.onChange !== 'function') {
    throw new TypeError(__`Expected a radio set onChange to be a function`);
  }

  const options = props.options.map((option) => promptChoice<T>(option as Choice<T> | string));
  const values = options.map((option) => promptValue(option));
  // two options holding one value would both be selected, and a key that picked
  // either would be a guess about which was meant
  if (values.some((v, i) => values.findIndex((w) => promptSameValue(v, w)) !== i)) {
    throw new TypeError(__`Expected every radio option to have a different value`);
  }
  const offered = options.map((option) => !option.disabled);
  const value = (
    props.value instanceof State ? props.value : new State<T | undefined>(props.value)
  ) as State<T | undefined>;
  const disabled = controlFlag(
    props.disabled,
    __`Expected radio set disabled to be a boolean or a State`
  );
  const direction = props.direction ?? 'column';
  const { onChange } = props;

  const rows = options.map((option, i) => {
    const pointer = textNode(PROMPT_SYMBOLS.cursor, {
      class: 'sigil-radio-pointer',
      'flex-shrink': 0,
      'margin-right': 1,
      visibility: 'hidden',
    });
    // a disabled option is muted whole, its mark with its label, so that nothing in
    // it reads as a choice on offer
    const mark = textNode(PROMPT_SYMBOLS.off, {
      class: offered[i] ? 'sigil-radio-mark' : 'sigil-radio-mark sigil-muted',
      'flex-shrink': 0,
      'margin-right': 1,
    });
    const label = textNode(labelLine(option.label), {
      class: offered[i] ? 'sigil-radio-label' : 'sigil-radio-label sigil-muted',
    });
    // the select prompt's rule: a disabled option says why where its hint would
    // be, and one disabled without a reason says so, which is what tells it apart
    // at colour level 0 where the muting is gone
    const reason =
      typeof option.disabled === 'string' && option.disabled !== ''
        ? option.disabled
        : option.disabled
          ? __`disabled`
          : option.hint;
    const hint = textNode(labelLine(reason ?? ''), {
      class: 'sigil-radio-hint sigil-muted',
      display: reason ? 'flex' : 'none',
      'flex-shrink': 0,
      'margin-left': 1,
    });
    const row = box({ class: 'sigil-radio', 'flex-direction': 'row' }, pointer, mark, label, hint);
    if (!offered[i]) {
      row.addClass('is-disabled');
      row.setState('disabled');
    }
    return { label, mark, pointer, row };
  });

  const host = box({
    ...props.props,
    'flex-direction': direction,
    ...(direction === 'row' ? { 'column-gap': 2 } : {}),
  });
  host.addClass('sigil-radio-set');
  host.append(...rows.map((r) => r.row));
  SETS.set(host, direction);
  // nothing in it can be chosen, so it is no stop for the ring either
  const inert = offered.includes(true) ? disabled : new State(true);
  controlDisabled(host, inert);

  /** Which option holds the value, or -1. */
  const selected = (): number => {
    const now = value.get();
    return values.findIndex((v) => promptSameValue(v, now));
  };

  /** The option the keys start from: the selected one, or the first on offer. */
  const highlight = (): number => {
    const at = selected();
    return at === -1 ? Math.max(0, offered.indexOf(true)) : at;
  };

  /** Whether the set has the focus, which the highlighted option shows. */
  let focused = false;

  const draw = (): void => {
    const at = selected();
    const lit = highlight();
    // the accent would beat the muted role a disabled set or option puts on the
    // mark, so a selected mark keeps it only while it could be chosen again
    const off = inert.get();
    for (const [i, { label, mark, pointer, row }] of rows.entries()) {
      const on = i === at;
      mark.setText(on ? PROMPT_SYMBOLS.on : PROMPT_SYMBOLS.off);
      mark.toggleClass('sigil-accent', on && offered[i] === true && !off);
      row.toggleClass('is-selected', on);
      row.setState('checked', on);
      // the pointer and the role on the option the keys act on, while they do
      pointer.setProps({ visibility: focused && i === lit ? 'visible' : 'hidden' });
      label.toggleClass('sigil-focus', focused && i === lit);
    }
  };

  createEffect(draw);

  host.onFocusChange = (_, now): void => {
    focused = now;
    draw();
  };

  /** Selects an option, telling the app if that moved the value. */
  const pick = (i: number): void => {
    if (i === selected()) {
      return;
    }
    const next = values[i] as T;
    value.set(next);
    onChange?.(next);
  };

  /** The nearest option on offer from `from`, going `by`, or -1 at the end. */
  const step = (from: number, by: number): number => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) {
      if (offered[i]) {
        return i;
      }
    }
    return -1;
  };

  host.onKey = (event): void => {
    const k = event.key;
    // a paste is not a keystroke, and a modifier makes it another key
    if (disabled.get() || event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }

    const lit = highlight();
    let target: number;
    switch (k.name) {
      case 'space': {
        // claimed whatever it changes, because it is aimed at the set: let
        // through, it would page the scroll box around the form
        if (offered[lit]) {
          pick(lit);
        }
        event.stop();
        return;
      }
      case 'up':
      case 'left': {
        target = step(lit, -1);
        break;
      }
      case 'down':
      case 'right': {
        target = step(lit, 1);
        break;
      }
      case 'home': {
        target = offered.indexOf(true);
        break;
      }
      case 'end': {
        target = offered.lastIndexOf(true);
        break;
      }
      default: {
        return;
      }
    }

    // an arrow, Home or End claimed only where it selects something new, so one
    // at the end of the set reaches the pane around it, as the tab row's do
    if (target === -1 || target === selected()) {
      return;
    }
    pick(target);
    event.stop();
  };

  for (const [i, { row }] of rows.entries()) {
    // the click rather than the press, so the press keeps its default action --
    // focusing the set -- and a press dragged off an option selects nothing
    row.onMouse = (event): void => {
      if (disabled.get() || !offered[i] || event.kind !== 'click' || event.button !== 'left') {
        return;
      }
      event.stop();
      pick(i);
    };
  }

  return host;
}

/**
 * Describes a radio set's keys to a router, for a key-help footer.
 *
 * The arrows along the set's own direction -- Up and Down for a column, Left and
 * Right for a row -- and Space. Home and End are not described: two more entries
 * in a footer for what the README says once. Scoped to the set.
 *
 * @param router - What to describe the keys to.
 * @param sets - Hosts that `RadioSet()` returned.
 * @returns Takes every description back off.
 */
export function describeRadioSet(
  router: ControlDescriber,
  ...sets: readonly Element[]
): () => void {
  return describeControls(
    router,
    sets,
    (host) => (SETS.has(host) ? host : undefined),
    (scope) => {
      const row = SETS.get(scope) === 'row';
      return [
        { description: __`previous`, keys: row ? 'left' : 'up' },
        { description: __`next`, keys: row ? 'right' : 'down' },
        { description: __`select`, keys: 'space', priority: 1 },
      ];
    },
    __`Expected an element that RadioSet() returned`
  );
}
