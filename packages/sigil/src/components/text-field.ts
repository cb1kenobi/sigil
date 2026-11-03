/**
 * A text field: one line of editable text, as an element a tree can hold.
 *
 * The `text()` prompt's editor without the prompt around it. A prompt mounts a
 * live region of its own and resolves a promise, so it cannot sit inside another
 * tree -- and a rename dialog, a login form or a settings screen is exactly that.
 * This is the field on its own: focusable, edited with the keys the prompt
 * answers, scrolled sideways when what was typed is wider than the room for it.
 *
 * ```js
 * import { openModal, TextField } from '@ttylabs/sigil/components';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const name = new State('draft.md');
 * const dialog = openModal(view, {
 *   actions: [{ label: 'Rename', value: true }, { label: 'Cancel' }],
 *   body: TextField({ value: name, onSubmit: () => dialog.close(true) }),
 *   input,
 *   title: 'Rename',
 * });
 * ```
 *
 * Left and Right move by a character and with Ctrl or Alt by a word, Home and End
 * (Ctrl-A, Ctrl-E) go to the ends, Backspace and Delete take a character or with
 * Ctrl or Alt a word, Ctrl-W and Alt-D take a word, Ctrl-U and Ctrl-K take
 * everything before or after the caret. A bracketed paste goes in with its line
 * breaks flattened. Tab and Escape are never the field's, and Enter is the field's
 * only when it was given `onSubmit` -- so inside a modal Tab still cycles and
 * Escape still dismisses. `AGENTS.md` has the reasons under "A text field".
 */

import { box, type Element, type ElementProps, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { stringWidth } from '../width/index.js';
import {
  boundary,
  deleteAfter,
  deleteBefore,
  deleteRange,
  type Edit,
  insertAt,
  pastedLine,
  typedText,
  wordAfter,
  wordBefore,
} from './editing.js';
import { promptWindow } from './prompt.js';

export interface TextFieldProps {
  /**
   * Whether the field refuses input.
   *
   * A disabled field is out of the focus ring, takes no key and no paste, and is
   * drawn in the muted role. A `State<boolean>` is read live, so an app can switch
   * it. Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /**
   * What is drawn in place of each column of the value, for a password.
   *
   * A column count rather than a substitution, which is the `password()` prompt's
   * rule: a two-column character is two of these.
   */
  mask?: string;
  /** Called with the value after every edit that changed it. Not called for a write the app made. */
  onChange?: (value: string) => void;
  /**
   * Called with the value when Enter is pressed.
   *
   * Given, Enter is the field's and stops there. Absent, Enter is not claimed and
   * goes on to whatever is around the field -- a form, or a dialog's own key.
   */
  onSubmit?: (value: string) => void;
  /** Shown, muted, while the value is empty. */
  placeholder?: string;
  /** The host box's own props: a class, a margin, a `flex-grow`. Geometry only, never a colour. */
  props?: ElementProps;
  /**
   * The value.
   *
   * A string is where it starts. A `State<string>` is the value itself: the keys
   * write it, and an app that writes it changes what the field shows, with the
   * caret moved to the end. Defaults to empty.
   */
  value?: string | State<string>;
  /**
   * How many columns the field takes. Defaults to what the layout gives it --
   * the whole width in a column, and its own content in a row, where an empty
   * field is one column wide. A field in a row wants this or a `flex-grow`.
   */
  width?: number;
}

/** A control character, which the keys cannot type but an app can write. */
const CONTROL = /\p{Cc}/gu;

/**
 * Builds a single-line text field.
 *
 * @param props - The value, the callbacks, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function TextField(props: TextFieldProps = {}): Element {
  if (
    props.value !== undefined &&
    typeof props.value !== 'string' &&
    !(props.value instanceof State)
  ) {
    throw new TypeError(__`Expected a text field value to be a string or a State`);
  }
  if (
    props.disabled !== undefined &&
    typeof props.disabled !== 'boolean' &&
    !(props.disabled instanceof State)
  ) {
    throw new TypeError(__`Expected text field disabled to be a boolean or a State`);
  }
  if (props.mask !== undefined && (typeof props.mask !== 'string' || props.mask === '')) {
    throw new TypeError(__`Expected a text field mask to be a non-empty string`);
  }
  if (props.placeholder !== undefined && typeof props.placeholder !== 'string') {
    throw new TypeError(__`Expected a text field placeholder to be a string`);
  }
  if (props.width !== undefined && !(Number.isInteger(props.width) && props.width > 0)) {
    throw new TypeError(__`Expected a text field width to be a positive whole number`);
  }

  const value = props.value instanceof State ? props.value : new State(props.value ?? '');
  const disabled =
    props.disabled instanceof State ? props.disabled : new State(props.disabled ?? false);
  const { mask, onChange, onSubmit, placeholder = '' } = props;

  const before = textNode('', { class: 'sigil-text-field-before', 'white-space': 'nowrap' });
  const caret = textNode('', { class: 'sigil-text-field-caret', 'white-space': 'nowrap' });
  const after = textNode('', { class: 'sigil-text-field-after', 'white-space': 'nowrap' });

  const host = box({
    ...props.props,
    // after the caller's: the three pieces are placed against these, and a
    // `min-width` of its content would stop the field shrinking to the room it is
    // given, which is the room the window is cut to. `focusable` is `disabled`'s
    'flex-direction': 'row',
    focusable: !disabled.get(),
    'min-width': 0,
    ...(props.width === undefined ? {} : { 'flex-shrink': 0, width: props.width }),
  });
  // added rather than written into the props, so an app's own `class` is kept,
  // which is the rule `ScrollBox` keeps
  host.addClass('sigil-text-field');
  host.append(before, caret, after);

  /** Where the caret is, as an offset into the value. */
  let cursor = value.get().length;
  /** The value as of the last draw, so a write the field did not make is told apart. */
  let seen = value.get();
  /**
   * The columns the layout gave the field, once it has. Until then the declared
   * width, or no limit -- a frame dispatches `onResize` after its layout and
   * before it paints, so the first frame drawn is already cut to the room.
   */
  let room = props.width ?? Number.POSITIVE_INFINITY;
  /** What was drawn last, to say whether a draw changed the tree. */
  let drawn = '';

  /** A piece of the value as it is drawn: masked, and with no control character. */
  const shown = (part: string): string =>
    mask === undefined ? part.replaceAll(CONTROL, '') : mask.repeat(stringWidth(part));

  /**
   * Draws the value, the caret and the placeholder.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  function draw(): boolean {
    const now = value.get();
    if (now !== seen) {
      // a write the field did not make: a new value with nothing to say where in
      // it the caret belongs, so the end, which is where a typist would be
      seen = now;
      cursor = now.length;
    }

    let parts: [string, string, string];
    const hinted = now === '' && placeholder !== '';
    if (hinted) {
      // the caret sits on the first character of the hint, so a focused empty
      // field shows where the next character goes from the first frame -- the
      // prompt's rule
      const end = boundary(placeholder, 0, 1);
      parts = ['', placeholder.slice(0, end), placeholder.slice(end)];
    } else {
      const pane = promptWindow(now, cursor, room);
      // past the last character there is nothing to mark, so the caret is a
      // column of its own rather than a mark on one
      parts = [shown(pane.before), shown(pane.under) || ' ', shown(pane.after)];
    }

    before.setText(parts[0]);
    caret.setText(parts[1]);
    after.setText(parts[2]);
    // muted on the caret's cell too: unfocused, a hint whose first letter alone
    // is at full strength reads as something typed
    caret.toggleClass('sigil-text-field-placeholder', hinted);
    caret.toggleClass('sigil-muted', hinted);
    after.toggleClass('sigil-text-field-placeholder', hinted);
    after.toggleClass('sigil-muted', hinted);

    const signature = `${hinted}|${parts.join('\u0000')}`;
    const changed = signature !== drawn;
    drawn = signature;
    return changed;
  }

  /** Puts an edit in, telling the app if the value moved. */
  function apply(edit: Edit): void {
    cursor = edit.cursor;
    if (edit.value !== value.get()) {
      seen = edit.value;
      value.set(edit.value);
      onChange?.(edit.value);
    }
    draw();
  }

  host.onKey = (event): void => {
    if (disabled.get()) {
      return;
    }
    const k = event.key;
    const now = value.get();
    const word = k.ctrl || k.meta;

    if (k.name === 'enter') {
      // a pasted line break is content, never a submission; and without
      // `onSubmit` Enter is not the field's, so it goes on to the form or the
      // dialog around it
      if (event.paste) {
        apply(insertAt(now, cursor, ' '));
      } else if (onSubmit === undefined) {
        return;
      } else {
        onSubmit(now);
      }
    } else if (k.name === 'backspace') {
      apply(word ? deleteRange(now, wordBefore(now, cursor), cursor) : deleteBefore(now, cursor));
    } else if (k.name === 'delete') {
      apply(word ? deleteRange(now, cursor, wordAfter(now, cursor)) : deleteAfter(now, cursor));
    } else if (k.ctrl && k.name === 'w') {
      apply(deleteRange(now, wordBefore(now, cursor), cursor));
    } else if (k.meta && k.name === 'd') {
      apply(deleteRange(now, cursor, wordAfter(now, cursor)));
    } else if (k.name === 'left' || (k.meta && k.name === 'b')) {
      const to = word ? wordBefore(now, cursor) : boundary(now, cursor, -1);
      apply({ cursor: to, value: now });
    } else if (k.name === 'right' || (k.meta && k.name === 'f')) {
      const to = word ? wordAfter(now, cursor) : boundary(now, cursor, 1);
      apply({ cursor: to, value: now });
    } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
      apply({ cursor: 0, value: now });
    } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
      apply({ cursor: now.length, value: now });
    } else if (k.ctrl && k.name === 'u') {
      apply(deleteRange(now, 0, cursor));
    } else if (k.ctrl && k.name === 'k') {
      apply(deleteRange(now, cursor, now.length));
    } else {
      const typed = typedText(k);
      // not the field's, and this is the one place that says so for every one of
      // them: Tab and Escape in any spelling, which belong to the focus ring and to
      // whatever holds the field -- a modal's trap and its dismissal -- and the
      // abort, and Up, Down and any chord nobody bound here. None of them is an
      // editing key and none of them types anything, so each goes on to the form,
      // the dialog or the app around the field
      if (typed === undefined) {
        return;
      }
      apply(insertAt(now, cursor, typed));
    }

    event.stop();
  };

  host.onPaste = (event): void => {
    if (disabled.get()) {
      return;
    }
    // one line, so the breaks a pasted block carries are flattened rather than
    // obeyed: obeying one is what submits half an address
    apply(insertAt(value.get(), cursor, pastedLine(event.text)));
    event.stop();
  };

  host.onResize = (element): boolean => {
    const size = element.content ?? element.box;
    room = size?.width ?? props.width ?? Number.POSITIVE_INFINITY;
    // the same room draws the same window, which `draw()` answers as no change
    return draw();
  };

  createEffect(() => {
    // read here, so a write the app makes redraws the field
    value.get();
    draw();
  });

  createEffect(() => {
    const off = disabled.get();
    host.setProp('focusable', !off);
    host.toggleClass('is-disabled', off);
    host.toggleClass('sigil-muted', off);
  });

  return host;
}
