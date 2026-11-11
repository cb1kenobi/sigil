/**
 * The two pieces every form here is laid out with: a labelled row, and the line
 * under a field that says what is wrong with it.
 *
 * The label is the form's rather than the control's, which is why no control
 * has one of its own beside it (a checkbox's label is the box's name, not the
 * row's): a form lines its labels up in a column whose width only it knows.
 */

import type { Field } from './form.ts';
import type { Element } from '@ttylabs/sigil/element';

/**
 * A setting: its label in the form's label column, and its control beside it.
 *
 * @param props - The label, and the control or controls.
 * @returns The row.
 */
export function Row(props: { children?: Element | Element[]; label: string }): Element {
  return (
    <box class="setting">
      <text class="label">{props.label}</text>
      <box class="control">{props.children}</box>
    </box>
  );
}

/**
 * The line under a field: empty until the field is touched, and then what is
 * wrong with it, following every key.
 *
 * Always one row high, empty or not, so an error appearing moves nothing below it
 * -- the row the prompts reserve for theirs, kept by the form rather than the field.
 *
 * @param props - The field.
 * @returns The line.
 */
export function Problem<T>(props: { field: Field<T> }): Element {
  return <text class="problem sigil-error">{() => props.field.message.get()}</text>;
}
