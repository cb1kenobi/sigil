/**
 * A button: a label that does something when it is pressed.
 *
 * Textual's `Button`, and the first of the form controls. A settings screen ends
 * in Save and Cancel, and a dialog's answers are buttons -- `openModal()` draws
 * its own with this.
 *
 * ```js
 * import { Button } from '@ttylabs/sigil/components/button';
 *
 * const save = Button({ label: 'Save', onPress: () => store.save() });
 * ```
 *
 * It is focusable. Enter, Space and a left click press it. Tab, Escape and every
 * other key go on to whatever holds it. While it has the focus its label is
 * bracketed, `[ Save ]` against `  Save  ` -- in the padding a button has anyway,
 * so the focus moves nothing and reads with no colour at all -- and the label
 * carries `.sigil-focus`. `AGENTS.md` has the reasons under "Form controls".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { State } from '../signals/index.js';
import {
  type ControlDescriber,
  controlDisabled,
  controlFlag,
  describeControls,
} from './control.js';
import { labelLine } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';

export interface ButtonProps {
  /**
   * Whether the button refuses to be pressed.
   *
   * A disabled button is out of the focus ring, ignores keys and clicks, and is
   * drawn in the muted role. A `State<boolean>` is read live, so an app can switch
   * it. Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /** What the button says. One line: escape sequences and line breaks are taken out. */
  label: string;
  /** Called when it is pressed: Enter or Space while it has the focus, or a left click. */
  onPress?: () => void;
  /** The host box's own props: a class, a margin. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onMouse'>;
}

/** Each button's host, which is also its focusable element. */
const BUTTONS = new WeakSet<Element>();

/**
 * Builds a button.
 *
 * @param props - The label, what pressing it does, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function Button(props: ButtonProps): Element {
  refuseOwnedHooks('Button', props?.props, ['onKey', 'onMouse', 'onFocusChange']);
  if (typeof props?.label !== 'string' || labelLine(props.label) === '') {
    // a button with no words cannot be read, and at colour level 0 a focused one
    // would be a pair of brackets around nothing
    throw new TypeError(__`Expected a button label to be a non-empty string`);
  }
  if (props.onPress !== undefined && typeof props.onPress !== 'function') {
    throw new TypeError(__`Expected a button onPress to be a function`);
  }
  const disabled = controlFlag(
    props.disabled,
    __`Expected button disabled to be a boolean or a State`
  );
  const { onPress } = props;

  // the brackets are the padding: a button is its label with a space either side
  // of it, and the focus puts a bracket in each -- so it reads without colour,
  // and nothing beside it moves when the focus does. `pre`, because a text of
  // nothing but spaces collapses to nothing at `white-space: normal`
  const open = textNode('  ', { class: 'sigil-button-bracket', 'white-space': 'pre' });
  const label = textNode(labelLine(props.label), {
    class: 'sigil-button-label',
    'white-space': 'nowrap',
  });
  const close = textNode('  ', { class: 'sigil-button-bracket', 'white-space': 'pre' });

  const host = box({ ...props.props, 'flex-direction': 'row', 'flex-shrink': 0 });
  // added rather than written into the props, so an app's own `class` is kept,
  // which is the rule `ScrollBox` keeps
  host.addClass('sigil-button');
  host.append(open, label, close);
  BUTTONS.add(host);
  controlDisabled(host, disabled);

  // the focus role on the label alone, which is what a reader looks at; the
  // brackets are the same focus drawn as content, at every colour level
  host.onFocusChange = (_, focused): void => {
    open.setText(focused ? '[ ' : '  ');
    close.setText(focused ? ' ]' : '  ');
    label.toggleClass('sigil-focus', focused);
  };

  host.onKey = (event): void => {
    const k = event.key;
    // a paste is not a keystroke: a pasted line ending in a newline is not a press
    // of whatever happened to be focused. A modifier makes it another key
    if (disabled.get() || event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }
    if (k.name !== 'enter' && k.name !== 'space') {
      return;
    }
    event.stop();
    onPress?.();
  };

  host.onMouse = (event): void => {
    // the click rather than the press, so the press keeps its default action --
    // focusing the button -- and a press dragged off it presses nothing
    if (disabled.get() || event.kind !== 'click' || event.button !== 'left') {
      return;
    }
    event.stop();
    onPress?.();
  };

  return host;
}

/**
 * Describes a button's keys to a router, for a key-help footer.
 *
 * Scoped to the button, which is the one element whose focus makes the keys
 * apply. A helper rather than an option because a router is built from the tree
 * the button is in, so it does not exist yet while the button is being built.
 *
 * @param router - What to describe the keys to.
 * @param buttons - Hosts that `Button()` returned.
 * @returns Takes every description back off.
 */
export function describeButton(
  router: ControlDescriber,
  ...buttons: readonly Element[]
): () => void {
  return describeControls(
    router,
    buttons,
    (host) => (BUTTONS.has(host) ? host : undefined),
    () => [
      { description: __`press`, keys: 'enter', priority: 1 },
      { description: __`press`, keys: 'space' },
    ],
    __`Expected an element that Button() returned`
  );
}
