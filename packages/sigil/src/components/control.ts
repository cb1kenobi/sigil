/**
 * What the form controls share: a flag that is a value or a state, the disabled
 * state, and describing their keys to a router.
 *
 * `Button`, `Checkbox`, `RadioSet` and `Switch` each answer these three
 * questions, and the answer is the same every time -- so it is written once,
 * here, rather than four times beside each other. Published, for the reason
 * every sibling is: an ejected checkbox imports it from
 * `@ttylabs/sigil/components/control`, and a control an app writes for itself
 * can follow the same rules by calling the same functions.
 *
 * `AGENTS.md` has the reasons under "Form controls".
 */

import type { Element } from '../element/index.js';
import type { DescribeOptions } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';

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
 * The shape `Collapsible`'s `open` and `TextField`'s `disabled` have. A truthy
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
 * Keeps a control's host in step with its disabled state.
 *
 * Disabled is `focusable: false`, so the ring walks past it, and the muted role,
 * `is-disabled` and the `:disabled` state, so a theme or a sheet can say more.
 * A control disabled while it has the focus keeps it: nothing here moves the
 * focus, and the router only moves it off an element that stops being drawn.
 * The keys and the clicks are the control's to ignore, by asking the state.
 *
 * @param host - The focusable element.
 * @param disabled - The state, read live.
 */
export function controlDisabled(host: Element, disabled: State<boolean>): void {
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
