/**
 * A dropdown select: a field showing one choice, which opens a menu of the others.
 *
 * ```js
 * import { Dropdown } from '@ttylabs/sigil/components/dropdown';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const level = new State('warn');
 * const field = Dropdown({
 *   input,
 *   options: ['debug', 'info', 'warn', { disabled: 'Not in this build', label: 'trace', value: 'trace' }],
 *   value: level,
 * });
 * ```
 *
 * Focusable. Enter, Space, Up, Down or Alt-Down open the list under it with the
 * current choice highlighted, and a letter picks the next choice starting with it
 * without opening anything. A press opens it too, and a press dragged onto a
 * choice and released picks it. The list is the menu: Escape closes it with the
 * value untouched, and the focus never leaves the field, so where it goes after
 * is where it was.
 *
 * The choices are the prompts' own -- a string, a `Choice` with a `label`, a
 * `value`, a `hint` and `disabled`, or a separator -- so a list written for
 * `select()` is a list for this. `AGENTS.md` records why it is here rather than
 * with the form controls.
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter, MouseEvent } from '../input/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { maxOf, stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
import {
  type MenuEntry,
  type MenuItem,
  type MenuSession,
  menuClasses,
  openMenuSession,
} from './menu.js';
import { unicodeSupported } from './note.js';
import { rootOf } from './overlay.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import type { ChoiceEntry } from './prompt.js';

export interface DropdownProps<T = unknown> {
  /** Draw the arrow and the list with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /**
   * Whether it refuses input. A disabled dropdown is out of the focus ring, opens
   * nothing and is drawn muted. A `State<boolean>` is read live. Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /** The router the keys come from, which the list needs to hold them while it is open. */
  input: InputRouter;
  /**
   * Classes put on the list it opens, beside `sigil-menu` -- the field's own class
   * is `props.class`. The list is drawn on the root rather than inside the field,
   * so a rule under the field cannot reach it. Space-separated for several.
   */
  menuClass?: string;
  /** Called with the value after a pick that changed it. Not called for a write the app made. */
  onChange?: (value: T) => void;
  /** The choices: strings, `Choice`s, and separators, as `select()` takes them. */
  options: readonly ChoiceEntry<T>[];
  /** Shown, muted, while nothing is chosen. */
  placeholder?: string;
  /** The field's own props: a class, a margin. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onMouse'>;
  /**
   * The value.
   *
   * A value is where it starts; a `State` is the value itself, written by a pick
   * and read live, so an app that writes it changes what the field shows. A value
   * no choice has shows the placeholder. Defaults to nothing chosen.
   */
  value?: State<T | undefined> | T;
  /**
   * How many columns the field takes, brackets and arrow included. Defaults to
   * what the widest choice needs, so the field does not change width as the
   * value does.
   */
  width?: number;
}

/** A choice, read the way `select()` reads one. */
interface Option<T> {
  readonly disabled: boolean;
  readonly entry: MenuEntry<T>;
  readonly label: string;
  readonly separator: boolean;
  readonly value: T | undefined;
}

/** The brackets and the arrow: the four columns that are not the label. */
const CHROME = 4;

/**
 * Builds a dropdown select.
 *
 * @param props - The router, the choices and the value.
 * @returns The field, which is the focusable element.
 */
export function Dropdown<T = unknown>(props: DropdownProps<T>): Element {
  refuseOwnedHooks('Dropdown', props?.props, ['onFocusChange', 'onKey', 'onMouse']);
  const input = props.input;
  if (typeof input?.bind !== 'function' || typeof input.onResize !== 'function') {
    throw new TypeError(__`Expected a dropdown input to be a router`);
  }
  if (!Array.isArray(props.options)) {
    throw new TypeError(__`Expected dropdown options to be an array`);
  }
  if (
    props.disabled !== undefined &&
    typeof props.disabled !== 'boolean' &&
    !(props.disabled instanceof State)
  ) {
    throw new TypeError(__`Expected dropdown disabled to be a boolean or a State`);
  }
  if (props.placeholder !== undefined && typeof props.placeholder !== 'string') {
    throw new TypeError(__`Expected a dropdown placeholder to be a string`);
  }
  if (props.width !== undefined && !(Number.isInteger(props.width) && props.width > CHROME)) {
    throw new TypeError(__`Expected a dropdown width of more than four cells`);
  }
  menuClasses(props.menuClass);

  const options: Option<T>[] = props.options.map((entry): Option<T> => {
    if (typeof entry === 'object' && entry !== null && 'separator' in entry) {
      return { disabled: true, entry, label: '', separator: true, value: undefined };
    }
    const choice = typeof entry === 'string' ? { label: entry, value: entry as T } : entry;
    // an empty label is refused here, where the app built the field, rather than by
    // the menu when a key opens it -- the check every other menu entry point makes
    if (typeof choice?.label !== 'string' || choice.label === '') {
      throw new TypeError(__`Expected a dropdown option to be a string or a choice with a label`);
    }
    const disabled = choice.disabled !== undefined && choice.disabled !== false;
    // a choice's label is words, not a menu label: an ampersand in it is one
    const item: MenuItem<T> = {
      disabled: choice.disabled,
      hint: choice.hint,
      label: choice.label.replaceAll('&', '&&'),
      value: choice.value,
    };
    return { disabled, entry: item, label: choice.label, separator: false, value: choice.value };
  });

  const value =
    props.value instanceof State ? props.value : new State<T | undefined>(props.value as T);
  const disabled =
    props.disabled instanceof State ? props.disabled : new State(props.disabled ?? false);
  const placeholder = props.placeholder ?? '';
  const glyph = (props.ascii ?? !unicodeSupported()) ? 'v' : '▾';

  /** The columns the label gets: the widest choice, or what a declared width leaves. */
  const room =
    props.width === undefined
      ? maxOf(
          options.map((option) => stringWidth(option.label)),
          Math.max(1, stringWidth(placeholder))
        )
      : props.width - CHROME;

  const left = textNode(' ', { class: 'sigil-dropdown-bracket', 'white-space': 'pre' });
  const right = textNode(' ', { class: 'sigil-dropdown-bracket', 'white-space': 'pre' });
  const label = textNode('', { class: 'sigil-dropdown-label', 'white-space': 'pre' });
  const arrow = textNode(` ${glyph}`, { class: 'sigil-dropdown-arrow', 'white-space': 'pre' });
  const face = box({ class: 'sigil-dropdown-face', 'flex-direction': 'row' }, label, arrow);

  const host = box({
    // one row and its own width wherever it is put: stretched by a row with a
    // height, it was eight rows tall and its list opened under the eighth. Before
    // the caller's props, so a form that wants it stretched can say so
    'align-self': 'flex-start',
    ...props.props,
    'flex-direction': 'row',
    'flex-shrink': 0,
    focusable: !disabled.get(),
  });
  host.addClass('sigil-dropdown');
  host.append(left, face, right);

  // the focus is the role on the face, and at colour level 0 brackets in the
  // blanks either side of it -- the rule a button keeps
  host.onFocusChange = (_, focused): void => {
    face.toggleClass('sigil-focus', focused);
    left.setText(focused ? '[' : ' ');
    right.setText(focused ? ']' : ' ');
  };

  /** Which choice the value is, or `-1`. */
  const chosen = (): number =>
    options.findIndex((option) => !option.separator && Object.is(option.value, value.get()));

  let menu: MenuSession<T> | undefined;

  /** Writes a pick, and tells the app if it moved the value. */
  function pick(to: T | undefined): void {
    if (Object.is(to, value.get())) {
      return;
    }
    value.set(to);
    props.onChange?.(to as T);
  }

  /** Opens the list under the field, with the current choice highlighted. */
  function show(): void {
    if (disabled.get() || menu?.open) {
      return;
    }
    const root = rootOf(host);
    // a field nothing is drawing has nowhere to open a list
    if (root === host) {
      return;
    }
    const at = chosen();
    const first = options.findIndex((option) => !option.disabled);
    const initial = at !== -1 && !options[at]?.disabled ? at : first;
    menu = openMenuSession<T>({
      ascii: props.ascii,
      host: root,
      input,
      menuClass: props.menuClass,
      onClose(item) {
        menu = undefined;
        if (item !== undefined) {
          pick(item.value);
        }
      },
    });
    menu.root(
      options.map((option) => option.entry),
      host,
      { initial, minWidth: host.box?.width ?? 0, side: 'bottom' }
    );
  }

  host.onKey = (event): void => {
    if (disabled.get() || event.paste) {
      return;
    }
    const k = event.key;
    const opens =
      (!k.ctrl && !k.meta && ['down', 'enter', 'space', 'up'].includes(k.name)) ||
      (k.meta && !k.ctrl && k.name === 'down');
    if (opens) {
      event.stop();
      show();
      return;
    }
    // a letter picks the next choice that starts with it, without opening anything
    if (k.ctrl || k.meta || [...k.name].length !== 1) {
      return;
    }
    const letter = k.name.toLowerCase();
    const n = options.length;
    const from = chosen();
    for (let step = 1; step <= n; step++) {
      const option = options[(((from + step) % n) + n) % n] as Option<T>;
      if (!option.disabled && option.label.toLowerCase().startsWith(letter)) {
        event.stop();
        pick(option.value);
        return;
      }
    }
  };

  // a press opens it, and does not stop: click-to-focus is how the field gets the
  // focus the list will hand back to. The press captured the pointer, so the drag
  // and the release that follow are reported here wherever they happen, and a
  // release over a choice is that choice picked
  host.onMouse = (event: MouseEvent): void => {
    if (event.kind === 'mousedown' && event.button === 'left') {
      show();
      return;
    }
    if (event.kind === 'mouseup' && menu?.open) {
      event.stop();
      menu.releaseAt(event.x, event.y);
      return;
    }
    if (event.kind === 'mousemove' && event.button !== undefined && menu?.open) {
      event.stop();
      menu.pointAt(event.x, event.y);
    }
  };

  createEffect(() => {
    const at = chosen();
    const words = at === -1 ? placeholder : (options[at] as Option<T>).label;
    const cut = stringWidth(words) > room ? truncate(words, room) : words;
    label.setText(cut + ' '.repeat(Math.max(0, room - stringWidth(cut))));
    label.toggleClass('sigil-muted', at === -1);
  });

  createEffect(() => {
    const off = disabled.get();
    host.setProp('focusable', !off);
    host.toggleClass('is-disabled', off);
    host.toggleClass('sigil-muted', off);
    if (off) {
      menu?.finish();
    }
  });

  onCleanup(() => menu?.finish());

  return host;
}
