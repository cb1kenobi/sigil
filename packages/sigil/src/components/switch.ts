/**
 * A switch: a setting with two named states, as an element a form can hold.
 *
 * Textual's `Switch`, drawn the way the `toggle()` prompt draws its two states:
 * both names, the inactive one on the left, and `◉` on the current one. A switch
 * is a checkbox whose two states have names worth reading -- `light` and `dark`,
 * `off` and `on` -- which is why it is a control of its own.
 *
 * ```js
 * import { Switch } from '@ttylabs/sigil/components/switch';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const notify = new State(false);
 * const row = Switch({ label: 'Notifications', value: notify });
 * // ❯ Notifications  ◯ off  ◉ on
 * ```
 *
 * It is focusable. Left picks the inactive state and Right the active one, Space
 * flips it, and a left click on a state picks that state -- anywhere else on it,
 * flips it. Tab is not the switch's, though `toggle()` flips on it: in a form Tab
 * belongs to the focus ring. Enter is not the switch's either, and goes on to the
 * form around it. `AGENTS.md` has the reasons under "Form controls".
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

export interface SwitchProps {
  /** What the `true` state is called. Defaults to `on`, the `toggle()` prompt's word. */
  active?: string;
  /**
   * Whether it refuses to change.
   *
   * A disabled switch is out of the focus ring, ignores keys and clicks, and is
   * drawn in the muted role. A `State<boolean>` is read live. Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /** What the `false` state is called. Defaults to `off`. */
  inactive?: string;
  /**
   * What it says, before the two states. One line of plain text. Without one the
   * current state's name carries the focus role.
   */
  label?: string;
  /** Called with the new value after a key or a click changed it. Not called for a write the app made. */
  onChange?: (value: boolean) => void;
  /** The host box's own props: a class, a margin. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onMouse'>;
  /**
   * Which state it is in: `true` for the active one.
   *
   * A boolean is where it starts. A `State<boolean>` is the value itself: the keys
   * and the mouse write it, and an app that writes it moves the switch. Defaults
   * to `false`, the left-hand state, which is `toggle()`'s default too.
   */
  value?: boolean | State<boolean>;
}

/** Each switch's host, which is also its focusable element, and the names of its two states. */
const SWITCHES = new WeakMap<Element, readonly [inactive: string, active: string]>();

/**
 * A state's name, made one line and checked.
 *
 * Blank is refused, because a state with no name has a marker and nothing to say
 * which state it is -- the `toggle()` prompt's rule.
 */
function stateName(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || labelLine(value) === '') {
    throw new TypeError(__`Expected a switch state name to be a non-empty string`);
  }
  return labelLine(value);
}

/**
 * Builds a switch.
 *
 * @param props - The value, the names of the two states, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function Switch(props: SwitchProps = {}): Element {
  refuseOwnedHooks('Switch', props.props, ['onKey', 'onMouse', 'onFocusChange']);
  if (props.label !== undefined && typeof props.label !== 'string') {
    throw new TypeError(__`Expected a switch label to be a string`);
  }
  if (props.onChange !== undefined && typeof props.onChange !== 'function') {
    throw new TypeError(__`Expected a switch onChange to be a function`);
  }
  const active = stateName(props.active, __`on`);
  const inactive = stateName(props.inactive, __`off`);
  // two states with one name are a choice nobody can read
  if (active === inactive) {
    throw new TypeError(__`Expected a switch's two states to have different names`);
  }
  const value = controlFlag(props.value, __`Expected switch value to be a boolean or a State`);
  const disabled = controlFlag(
    props.disabled,
    __`Expected switch disabled to be a boolean or a State`
  );
  const { onChange } = props;
  const words = props.label === undefined ? '' : labelLine(props.label);

  const pointer = textNode(PROMPT_SYMBOLS.cursor, {
    class: 'sigil-switch-pointer',
    'flex-shrink': 0,
    'margin-right': 1,
    visibility: 'hidden',
  });
  const label = textNode(words, {
    class: 'sigil-switch-label',
    'flex-shrink': 0,
    'margin-right': 2,
    'white-space': 'nowrap',
  });
  const states = [
    { name: inactive, node: textNode('', { 'margin-right': 2 }), state: false },
    { name: active, node: textNode(''), state: true },
  ];
  for (const { node } of states) {
    node.setProps({ class: 'sigil-switch-state', 'flex-shrink': 0, 'white-space': 'nowrap' });
  }

  const host = box({ ...props.props, 'flex-direction': 'row' });
  host.addClass('sigil-switch');
  host.append(pointer, ...(words === '' ? [] : [label]), ...states.map((s) => s.node));
  SWITCHES.set(host, [inactive, active]);
  controlDisabled(host, disabled);

  /** Whether the switch has the focus, which the label or the current state shows. */
  let focused = false;

  /** The marker says which state is current at colour level 0; the roles agree with it. */
  const draw = (): void => {
    const now = value.get() === true;
    // a disabled switch is muted whole, so the current state gives up its accent,
    // which would otherwise beat the role it inherits from the host
    const off = disabled.get();
    for (const { name, node, state } of states) {
      const here = state === now;
      node.setText(`${here ? PROMPT_SYMBOLS.on : PROMPT_SYMBOLS.off} ${name}`);
      node.toggleClass('is-active', here);
      node.toggleClass('sigil-accent', here && !off);
      node.toggleClass('sigil-muted', !here);
      // with no label, the current state is the part that shows the focus, and
      // it moves when the state does
      node.toggleClass('sigil-focus', words === '' && here && focused);
    }
    host.toggleClass('is-on', now);
    host.setState('checked', now);
  };

  createEffect(draw);

  host.onFocusChange = (_, now): void => {
    focused = now;
    pointer.setProps({ visibility: now ? 'visible' : 'hidden' });
    if (words === '') {
      draw();
    } else {
      label.toggleClass('sigil-focus', now);
    }
  };

  /** Puts the switch in a state, telling the app if that moved it. */
  const set = (next: boolean): void => {
    if ((value.get() === true) === next) {
      return;
    }
    value.set(next);
    onChange?.(next);
  };

  host.onKey = (event): void => {
    const k = event.key;
    // a paste is not a keystroke, and a modifier makes it another key
    if (disabled.get() || event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }
    const now = value.get() === true;
    switch (k.name) {
      case 'space': {
        set(!now);
        break;
      }
      // an arrow says where to go rather than flipping, so Right twice stays on;
      // and one that would change nothing reaches the pane around the switch, as
      // the collapsible's and the tab row's do
      case 'left': {
        if (!now) {
          return;
        }
        set(false);
        break;
      }
      case 'right': {
        if (now) {
          return;
        }
        set(true);
        break;
      }
      default: {
        return;
      }
    }
    event.stop();
  };

  for (const { node, state } of states) {
    // a click on a name picks that state, which is what a reader pointing at
    // `off` means; it is the click rather than the press, so the press still
    // focuses the switch
    node.onMouse = (event): void => {
      if (disabled.get() || event.kind !== 'click' || event.button !== 'left') {
        return;
      }
      event.stop();
      set(state);
    };
  }

  host.onMouse = (event): void => {
    // anywhere else on it -- the label, the pointer's column -- flips it
    if (disabled.get() || event.kind !== 'click' || event.button !== 'left') {
      return;
    }
    event.stop();
    set(value.get() !== true);
  };

  return host;
}

/**
 * Describes a switch's keys to a router, for a key-help footer.
 *
 * Left and Right are described by the names of the states they pick, so a footer
 * reads `← off · → on` -- or `← light · → dark`. Scoped to the switch.
 *
 * @param router - What to describe the keys to.
 * @param switches - Hosts that `Switch()` returned.
 * @returns Takes every description back off.
 */
export function describeSwitch(
  router: ControlDescriber,
  ...switches: readonly Element[]
): () => void {
  return describeControls(
    router,
    switches,
    (host) => (SWITCHES.has(host) ? host : undefined),
    (scope) => {
      const [off, on] = SWITCHES.get(scope) ?? [__`off`, __`on`];
      return [
        { description: __`toggle`, keys: 'space', priority: 1 },
        { description: off, keys: 'left' },
        { description: on, keys: 'right' },
      ];
    },
    __`Expected an element that Switch() returned`
  );
}
