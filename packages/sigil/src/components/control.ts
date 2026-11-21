/**
 * What the form controls share: a flag that is a value or a state, a condition
 * that is read and never written, the disabled state, and describing their keys
 * to a router.
 *
 * `Button`, `Checkbox`, `RadioSet` and `Switch` each answer these questions,
 * and the answer is the same every time -- so it is written once, here, rather
 * than four times beside each other; `TextField`, `TextArea`, `Slider` and
 * `Dropdown` read their `disabled` through `controlCondition()` as well, and
 * `controlState()` is what everything that writes a value of the app's own type
 * -- a radio set, a dropdown, a list's cursor, a table's sort -- takes it
 * through. Published, for the reason every sibling is: an ejected checkbox imports it from
 * `@ttylabs/sigil/components/control`, and a control an app writes for itself
 * can follow the same rules by calling the same functions.
 *
 * `AGENTS.md` has the reasons under "Form controls".
 */

import type { Element } from '../element/index.js';
import type { DescribeOptions } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { Computed, State } from '../signals/index.js';

/** Where a control's keys are described, which is the whole of what is asked of a router. */
export interface ControlDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/** One key a control describes: the keys, what they do, and how much it matters. */
export interface ControlKey {
  /** What the footer says the key does. */
  description: string;
  /** The key, as a router spells it: `space`, `enter`, `left`. */
  keys: string;
  /** As `BindingHelp.priority`. */
  priority?: number;
}

/**
 * A boolean to start from, or the `State<boolean>` that is the value, as a state.
 *
 * For what the control writes -- a checkbox's `checked`, a switch's `value` --
 * and the shape `Collapsible`'s `open` has; a `disabled`, which is only read, is
 * `controlCondition()`'s. A truthy
 * string is refused rather than read as `true`, because the value is compared to
 * `true` afterwards and would never be equal to it again -- the hole `toggle()`
 * refuses its `initial` over.
 *
 * @param value - What the caller passed.
 * @param message - The `TypeError` to throw for anything else.
 * @returns The state: the caller's own, or a new one holding the boolean.
 * @throws If `value` is neither a boolean, a `State` nor `undefined`.
 */
export function controlFlag(value: unknown, message: string): State<boolean> {
  if (value instanceof State) {
    return value as State<boolean>;
  }
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(message);
  }
  return new State(value ?? false);
}

/**
 * A value to start from, or the `State` that is the value -- for what a
 * component writes and can hold anything: a radio set's or a dropdown's `value`,
 * a list's `current`, a table's `sort`.
 *
 * `controlFlag()` is the boolean case, and it refuses a `Computed` by refusing
 * everything that is neither a boolean nor a `State`. A value here is the app's
 * own type, so nothing can be refused by its shape -- except a `Computed`, which
 * is a signal and never a value: wrapped in a new `State` it became the value
 * itself, selected nothing, and was never read again, so the derivation the app
 * wrote did nothing at all. It cannot be written, which is what the component
 * does with this, so it is refused rather than followed. Told apart by
 * `instanceof`, as the treemap tells its `root` apart, because the value may well
 * be the app's own object with a `get` of its own.
 *
 * @param value - What the caller passed.
 * @param message - The `TypeError` to throw for a `Computed`.
 * @returns The state: the caller's own, or a new one holding the value.
 * @throws If `value` is a `Computed`.
 */
export function controlState<T>(value: T | State<T>, message: string): State<T> {
  if (value instanceof State) {
    return value as State<T>;
  }
  if (value instanceof Computed) {
    throw new TypeError(message);
  }
  return new State(value);
}

/**
 * Refuses a function handed as a value to start from when no option holds it.
 *
 * `value={() => level.get()}` is the template's spelling of a reactive prop, and
 * on a control that writes its value it is the value itself: nothing holds it, so
 * nothing is selected, and it is never called. A function cannot be refused by its
 * shape -- an option's value may be one, an action to run -- so it is refused when
 * it is not one of the options' own, which is exactly the case where it selects
 * nothing and is therefore the mistake. A `State` holding one is the app's own
 * statement and is not looked at.
 *
 * @param value - What the caller passed as the control's `value`.
 * @param held - The value each option holds.
 * @param message - The `TypeError` to throw.
 * @throws If `value` is a function that none of `held` is.
 */
export function refuseUnheldFunction(
  value: unknown,
  held: readonly unknown[],
  message: string
): void {
  if (typeof value === 'function' && !held.some((one) => Object.is(one, value))) {
    throw new TypeError(message);
  }
}

/**
 * What a value a control writes may be, with a `Computed` taken out: `T` itself,
 * or `never` where `T` is a `Computed`.
 *
 * `controlState()` refuses one at runtime, and this is the same refusal where a
 * `tsc` can say it, so the mistake is found when the app compiles. It is written
 * `T extends Computed<any> ? never : T`, which TypeScript does not infer
 * through: `T` is still decided by the other props that name it, a list's items or
 * a radio set's options, and the value is then checked against it. `Computed` has
 * private fields, so it is told apart by what it is and an app's own object with a
 * `get()` is not mistaken for one.
 */
export type Written<T> = T extends Computed<any> ? never : T;

/**
 * A boolean read live: a `State`, a `Computed`, or anything else with a `get()`.
 *
 * What a control reads and never writes, which is why it is narrower than a
 * `State`: a `Computed` has no `set()`, and a control that only asks whether it
 * is disabled has no use for one.
 */
export interface LiveFlag {
  get(): boolean;
}

/**
 * What a control's `disabled` takes: a boolean, anything with a `get()`, or a
 * function.
 *
 * A disabled flag is nearly always derived -- "until something changed", "until
 * the form is valid" -- so a `Computed` is the usual answer, and a function is
 * the template's spelling of a reactive prop, so `disabled={() => !valid.get()}`
 * is what an author writes first. Either is read inside an effect, so the
 * control follows whatever it reads; `ChartSource` takes the same three shapes
 * for the same reason.
 */
export type ControlCondition = boolean | LiveFlag | (() => boolean);

/**
 * A condition a control reads and never writes: a boolean, anything with a
 * `get()`, or a function -- `disabled`, on every control that has one.
 *
 * `controlFlag()` is the other half: `checked` and `value` are written by the
 * control, so they have to be a `State`, while `disabled` is only ever asked.
 * What is handed back is read for its truth, every time it is asked, so the
 * effect that draws the control and the handlers that ignore a key agree about
 * what a reading means. A string is refused here as it is there; a reading is
 * not checked, since it does not exist until it is asked for.
 *
 * @param value - What the caller passed.
 * @param message - The `TypeError` to throw for anything else.
 * @returns What to ask: the caller's `get()` or function, read live, or the boolean.
 * @throws If `value` is neither a boolean, a function, something with a `get()`
 * nor `undefined`.
 */
export function controlCondition(value: unknown, message: string): LiveFlag {
  if (typeof value === 'function') {
    const read = value as () => unknown;
    return { get: () => Boolean(read()) };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  ) {
    const source = value as { get(): unknown };
    return { get: () => Boolean(source.get()) };
  }
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(message);
  }
  const fixed = value ?? false;
  return { get: () => fixed };
}

/**
 * Keeps a control's host in step with its disabled state.
 *
 * Disabled is `focusable: false`, so the ring walks past it, and the muted role,
 * `is-disabled` and the `:disabled` state, so a theme or a sheet can say more.
 * A control disabled while it has the focus keeps it: nothing here moves the
 * focus, and the router only moves it off an element that stops being drawn.
 * The keys and the clicks are the control's to ignore, by asking the state.
 *
 * @param host - The focusable element.
 * @param disabled - The condition, read live: what `controlCondition()` handed back.
 */
export function controlDisabled(host: Element, disabled: LiveFlag): void {
  createEffect(() => {
    const off = disabled.get();
    host.setProp('focusable', !off);
    host.toggleClass('is-disabled', off);
    host.toggleClass('sigil-muted', off);
    host.setState('disabled', off);
  });
}

/**
 * Describes the keys of some controls to a router, for a key-help footer.
 *
 * Each control's keys are scoped to the element whose focus makes them apply,
 * which is what `find` hands back for each host.
 *
 * @param router - What to describe the keys to.
 * @param hosts - What the component returned, one or more.
 * @param find - The focusable element of a host, or `undefined` if it is not one.
 * @param keys - The keys each one describes.
 * @param wrong - The `TypeError` for a host `find` does not know.
 * @returns Takes every description back off.
 * @throws If a host is not one of the component's.
 */
export function describeControls(
  router: ControlDescriber,
  hosts: readonly Element[],
  find: (host: Element) => Element | undefined,
  keys: (scope: Element) => readonly ControlKey[],
  wrong: string
): () => void {
  // every host checked before anything is described, so a bad one leaves the
  // router as it found it
  const scopes = hosts.map((host) => {
    const found = find(host);
    if (found === undefined) {
      throw new TypeError(wrong);
    }
    return found;
  });

  const off: Array<() => void> = [];
  for (const scope of scopes) {
    for (const key of keys(scope)) {
      off.push(
        router.describe(key.keys, {
          description: key.description,
          scope,
          ...(key.priority === undefined ? {} : { priority: key.priority }),
        })
      );
    }
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
