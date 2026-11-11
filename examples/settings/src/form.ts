/**
 * A form's state: the values being edited, the values last saved, and what is
 * wrong with them.
 *
 * A text field does not own its error line (SIG-215: where the error goes, when
 * it is checked and what blocks a submit are the form's to say), and neither does
 * any other control. So this is the form's half, with no elements in it: each
 * field is a `State` a control writes, a `Computed` that says what is wrong with
 * it, and whether it has been touched -- and the form adds up whether anything
 * changed and whether everything is valid. The settings screen and the login
 * dialog are both written over it, which is the evidence that it is one shape
 * and not two. `examples/AGENTS.md` has the reasons, under "A settings screen".
 */

import type { Element } from '@ttylabs/sigil/element';
import { createEffect } from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';

/**
 * What is wrong with one field's value, or `undefined` when nothing is.
 *
 * It is handed every value, so a check can be about more than its own field: the
 * phone number is required only while SMS is ticked. It is read inside a
 * `Computed`, so a check that reads another field is re-run when that one changes.
 */
export type Check<V, K extends keyof V> = (value: V[K], values: V) => string | undefined;

/** One field of a form. */
export interface Field<T> {
  /** Whether the value differs from what was saved. */
  readonly changed: Computed<boolean>;
  /** What is wrong with the value now, whether or not anybody has been told. */
  readonly error: Computed<string | undefined>;
  /** What the line under the field says: the error once the field is touched, and nothing before. */
  readonly message: Computed<string>;
  /** Whether the field has been left once, or the form submitted. */
  readonly touched: State<boolean>;
  /** The value, which the control holds and writes. */
  readonly value: State<T>;
}

/** A form over the values `V`, an object of primitives. */
export interface Form<V extends object> {
  /** Saves: what is being edited becomes what is saved, and nothing is touched any more. */
  commit(): V;
  /** Whether any field differs from what was saved. */
  readonly dirty: Computed<boolean>;
  /** The fields that have something wrong with them, in the order they were declared. */
  readonly errors: Computed<readonly (keyof V)[]>;
  /** One per value. */
  readonly fields: { readonly [K in keyof V]: Field<V[K]> };
  /** Cancels: every field goes back to what was saved, and nothing is touched any more. */
  revert(): void;
  /** What was last saved. */
  readonly saved: State<V>;
  /**
   * Marks a field touched, so its error shows. With no key, every field: what a
   * submit does, so a form that refused one says why.
   */
  touch(key?: keyof V): void;
  /** Whether no field has anything wrong with it. */
  readonly valid: Computed<boolean>;
  /** The values being edited. Tracked, when read inside a `Computed` or an effect. */
  values(): V;
}

/**
 * Builds a form.
 *
 * @param initial - What is saved to begin with, which is also what is edited.
 * @param checks - What can be wrong with each value. A value with no check is never wrong.
 * @returns The form.
 */
export function createForm<V extends object>(
  initial: V,
  checks: { readonly [K in keyof V]?: Check<V, K> } = {}
): Form<V> {
  const keys = Object.keys(initial) as (keyof V)[];
  const saved = new State<V>({ ...initial });

  // every field's state first, so a check can read any of them
  const values = Object.fromEntries(keys.map((key) => [key, new State(initial[key])])) as {
    [K in keyof V]: State<V[K]>;
  };
  const read = (): V =>
    Object.fromEntries(keys.map((key) => [key, values[key].get()])) as unknown as V;

  const fields = Object.fromEntries(
    keys.map((key) => {
      const check = checks[key];
      const error = new Computed(() => check?.(values[key].get(), read()));
      const changed = new Computed(() => !Object.is(values[key].get(), saved.get()[key]));
      const touched = new State(false);
      const message = new Computed(() => (touched.get() ? (error.get() ?? '') : ''));
      return [key, { changed, error, message, touched, value: values[key] }];
    })
  ) as unknown as { [K in keyof V]: Field<V[K]> };

  const dirty = new Computed(() => keys.some((key) => fields[key].changed.get()));
  const errors = new Computed(() => keys.filter((key) => fields[key].error.get() !== undefined));
  const valid = new Computed(() => errors.get().length === 0);

  const untouch = (): void => {
    for (const key of keys) {
      fields[key].touched.set(false);
    }
  };

  return {
    commit(): V {
      const now = untrack(read);
      saved.set(now);
      untouch();
      return now;
    },
    dirty,
    errors,
    fields,
    revert(): void {
      const was = untrack(() => saved.get());
      for (const key of keys) {
        values[key].set(was[key]);
      }
      untouch();
    },
    saved,
    touch(key?: keyof V): void {
      for (const each of key === undefined ? keys : [key]) {
        fields[each].touched.set(true);
      }
    },
    valid,
    values: read,
  };
}

/**
 * A `State` that follows a `Computed`, for a control's `disabled`.
 *
 * Every control's `disabled` takes a boolean or a `State<boolean>` and not a
 * `Computed` (SIG-334), and a disabled flag is nearly always derived -- "until
 * something changed", "until the form is valid". So it is mirrored through an
 * effect, which is what `demos/components/57-form-controls.js` does by hand. Call
 * it in a component body, where the effect has an owner to be disposed with.
 *
 * @param compute - What the state should hold.
 * @returns The state, kept in step.
 */
export function follow(compute: () => boolean): State<boolean> {
  const state = new State(untrack(compute));
  createEffect(() => {
    state.set(compute());
  });
  return state;
}

/**
 * Touches a field when the focus leaves it, so its error shows from then on.
 *
 * Leaving rather than typing, because an error that appears at the first key --
 * "not an email address" after `a` -- is about a value nobody has finished
 * writing. Once shown it follows every key, so fixing it takes it away at once.
 * Watched on the router's focus rather than on the field's own `onFocusChange`,
 * which `TextField` owns and refuses in its `props`. Call it in a component body.
 *
 * @param current - The router's focus: `input.focus.current`.
 * @param form - The form the fields are in.
 * @param fields - Each field's control, and the key it edits.
 */
export function touchOnLeave<V extends object>(
  current: { get(): Element | undefined },
  form: Form<V>,
  fields: ReadonlyMap<Element, keyof V>
): void {
  let last: Element | undefined;
  createEffect(() => {
    const now = current.get();
    const left = last === undefined || last === now ? undefined : fields.get(last);
    last = now;
    if (left !== undefined) {
      untrack(() => form.touch(left));
    }
  });
}
