/**
 * A checkbox: a setting that is on or off, with a label beside it.
 *
 * Textual's `Checkbox`. A settings screen is mostly these, and a login form ends
 * in one that says "remember me".
 *
 * ```js
 * import { Checkbox } from '@ttylabs/sigil/components/checkbox';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const digest = new State(true);
 * const box = Checkbox({ label: 'Email me a weekly digest', checked: digest });
 * ```
 *
 * It is focusable. Space and a left click tick and untick it. Enter is not the
 * checkbox's -- it goes on to the form around it, which is where a submit lives --
 * and nor are Tab, Escape or the arrows. The box is `[x]` or `[ ]`, which says the
 * value at any colour level; the focus is the prompts' `❯` in a column the
 * checkbox keeps blank until then, and `.sigil-focus` on the label. `AGENTS.md`
 * has the reasons under "Form controls".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { createEffect } from '../renderer/index.js';
import type { State } from '../signals/index.js';
import {
  type ControlDescriber,
  controlDisabled,
  controlFlag,
  describeControls,
} from './control.js';
import { labelLine } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import { PROMPT_SYMBOLS } from './prompt.js';

export interface CheckboxProps {
  /**
   * Whether it is ticked.
   *
   * A boolean is where it starts. A `State<boolean>` is the value itself: Space
   * and a click write it, and an app that writes it ticks or unticks the box.
   * Defaults to unticked.
   */
  checked?: boolean | State<boolean>;
  /**
   * Whether it refuses to change.
   *
   * A disabled checkbox is out of the focus ring, ignores keys and clicks, and is
   * drawn in the muted role. A `State<boolean>` is read live. Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /**
   * What it says, beside the box. One line of plain text, which wraps under itself
   * where it is too long. Empty is allowed, for a checkbox labelled by something
   * around it, and then the box carries the focus role.
   */
  label: string;
  /** Called with the new value after Space or a click changed it. Not called for a write the app made. */
  onChange?: (checked: boolean) => void;
  /** The host box's own props: a class, a margin. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onMouse'>;
}

/** The box, ticked and not: square, because a radio set's round marks are "one of". */
const MARKS = { off: '[ ]', on: '[x]' } as const;

/** Each checkbox's host, which is also its focusable element. */
const CHECKBOXES = new WeakSet<Element>();

/**
 * Builds a checkbox.
 *
 * @param props - The label, whether it is ticked, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function Checkbox(props: CheckboxProps): Element {
  refuseOwnedHooks('Checkbox', props?.props, ['onKey', 'onMouse', 'onFocusChange']);
  if (typeof props?.label !== 'string') {
    throw new TypeError(__`Expected a checkbox label to be a string`);
  }
  if (props.onChange !== undefined && typeof props.onChange !== 'function') {
    throw new TypeError(__`Expected a checkbox onChange to be a function`);
  }
  const checked = controlFlag(
    props.checked,
    __`Expected checkbox checked to be a boolean or a State`
  );
  const disabled = controlFlag(
    props.disabled,
    __`Expected checkbox disabled to be a boolean or a State`
  );
  const { onChange } = props;
  const words = labelLine(props.label);

  // the prompts' pointer, in a column every checkbox keeps whether or not it has
  // the focus -- hidden content still takes its room -- so the focus arriving
  // moves nothing, and it is drawn at every colour level
  const pointer = textNode(PROMPT_SYMBOLS.cursor, {
    class: 'sigil-checkbox-pointer',
    'flex-shrink': 0,
    'margin-right': 1,
    visibility: 'hidden',
  });
  const mark = textNode(MARKS.off, {
    class: 'sigil-checkbox-mark',
    'flex-shrink': 0,
    'white-space': 'pre',
    ...(words === '' ? {} : { 'margin-right': 1 }),
  });
  const label = textNode(words, { class: 'sigil-checkbox-label' });

  const host = box({ ...props.props, 'flex-direction': 'row' });
  host.addClass('sigil-checkbox');
  host.append(pointer, mark, ...(words === '' ? [] : [label]));
  CHECKBOXES.add(host);
  controlDisabled(host, disabled);

  createEffect(() => {
    const on = checked.get() === true;
    mark.setText(on ? MARKS.on : MARKS.off);
    mark.toggleClass('sigil-accent', on);
    host.toggleClass('is-checked', on);
    host.setState('checked', on);
  });

  // the role on the label, which is the part a reader looks at -- the box says the
  // value and never the focus. With no label it goes on the box, the one part left
  host.onFocusChange = (_, focused): void => {
    pointer.setProps({ visibility: focused ? 'visible' : 'hidden' });
    (words === '' ? mark : label).toggleClass('sigil-focus', focused);
  };

  const flip = (): void => {
    const next = checked.get() !== true;
    checked.set(next);
    onChange?.(next);
  };

  host.onKey = (event): void => {
    const k = event.key;
    // a paste is not a keystroke, and a modifier makes it another key
    if (disabled.get() || event.paste || k.ctrl || k.meta || k.shift || k.name !== 'space') {
      return;
    }
    event.stop();
    flip();
  };

  host.onMouse = (event): void => {
    // the click rather than the press, so the press keeps its default action --
    // focusing the checkbox -- and a press dragged off it changes nothing
    if (disabled.get() || event.kind !== 'click' || event.button !== 'left') {
      return;
    }
    event.stop();
    flip();
  };

  return host;
}

/**
 * Describes a checkbox's key to a router, for a key-help footer.
 *
 * Scoped to the checkbox, which is the one element whose focus makes it apply.
 *
 * @param router - What to describe the keys to.
 * @param checkboxes - Hosts that `Checkbox()` returned.
 * @returns Takes every description back off.
 */
export function describeCheckbox(
  router: ControlDescriber,
  ...checkboxes: readonly Element[]
): () => void {
  return describeControls(
    router,
    checkboxes,
    (host) => (CHECKBOXES.has(host) ? host : undefined),
    () => [{ description: __`toggle`, keys: 'space', priority: 1 }],
    __`Expected an element that Checkbox() returned`
  );
}
