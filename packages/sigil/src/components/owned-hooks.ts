/**
 * Refusing a hook a component sets itself (SIG-305).
 *
 * `ElementProps` takes the seven hooks so that `box({ onKey })` and a template's
 * `onKey=${fn}` are one path. A component that spreads its caller's `props` into
 * its host and then assigns a hook of its own replaces the caller's, with no
 * error -- the silent no-op the hooks-as-props change set out to remove, moved
 * one level up. So a component refuses, where it validates, exactly the hooks it
 * assigns on the element those props go to, and its `props` type leaves them out
 * (`ElementPropsWithout<>`).
 *
 * Refused rather than composed, which `ScrollBox` does for `onScroll` and
 * `onResize`: those two are options of the component with a defined order
 * ("the window first, the caller's after"), and a hook in `props` has no such
 * contract to join. Where an app wants a key before the component's, the
 * element around the component is where it goes.
 */

import type { HandlerProp } from '../element/index.js';
import { __ } from '../i18n/index.js';

/**
 * Throws if a component's `props` carry a hook the component owns.
 *
 * `undefined` is no handler and is let through, which is what an optional prop
 * a caller passed along looks like.
 *
 * @param who - The component, as the message names it.
 * @param props - What the caller gave as `props`.
 * @param owned - The hooks the component assigns on the element those go to.
 * @throws If one of the owned hooks is set to anything but `undefined`.
 */
export function refuseOwnedHooks(
  who: string,
  props: object | undefined,
  owned: readonly HandlerProp[]
): void {
  if (props === undefined || props === null) {
    return;
  }
  for (const hook of owned) {
    if ((props as Record<string, unknown>)[hook] !== undefined) {
      throw new TypeError(
        __`${who} sets ${hook} itself, so a ${hook} in its props would be replaced: put the handler on an element around it`
      );
    }
  }
}
