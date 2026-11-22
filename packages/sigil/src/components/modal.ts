/**
 * A modal: a dialog drawn over the current screen, with a focus trap.
 *
 * Every full-screen app eventually wants a confirm over what it is showing. The
 * canvas can already composite a box above the app and the layout can already
 * take one out of flow, so this is the part that was missing: **who gets the keys
 * and the mouse while it is open**, and where the focus goes when it is not.
 *
 * ```js
 * import { confirmModal, openModal } from '@ttylabs/sigil/components/modal';
 *
 * const answer = await confirmModal(view, {
 *   input,
 *   message: 'The branch has unpushed commits.',
 *   title: 'Delete it anyway?',
 * });
 * ```
 *
 * While it is open, Tab and Shift-Tab cycle through the modal's own focusable
 * elements and nothing else, Escape dismisses it, a click that lands outside the
 * panel reaches nothing under it, and a key or a paste reaches the modal's focused
 * element and no further. When it closes the focus goes back to the element that had it
 * when it opened. A second modal opened over the first takes over, and the first
 * has the input again when the second closes.
 *
 * `AGENTS.md` records what "alone" costs and where the router cannot give it. The
 * panel is opaque with no colour at all, by filling itself with blanks.
 */

import {
  box,
  Element,
  type ElementProps,
  type ElementPropsWithout,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter, KeyEvent, MouseEvent, PasteEvent } from '../input/index.js';
import { createBranch, createRoot, type Owner, runWithOwner } from '../renderer/index.js';
import { untrack } from '../signals/index.js';
import { Button } from './button.js';
import { type ControlCondition, controlCondition } from './control.js';
import { decodeKeys, isAbort, type Key } from './keys.js';
import { labelLine, unicodeSupported } from './note.js';
import { holdInput, opaqueFill, rootOf } from './overlay.js';
import { refuseOwnedHooks } from './owned-hooks.js';

/** One button along the bottom of the dialog. */
export interface ModalAction<T = unknown> {
  /**
   * Whether the button refuses to be pressed, which is what a form's submit is
   * until the form is valid. Takes what a control's `disabled` takes: a boolean, a
   * `State`, a `Computed` or a function, read live. Defaults to `false`.
   *
   * It is read inside an effect that belongs to the dialog, so it follows what it
   * reads for as long as the dialog is open and not a moment longer.
   */
  disabled?: ControlCondition;
  /**
   * Whether Enter presses this button when whatever has the focus leaves Enter
   * alone -- a field with no `onSubmit`, a checkbox, the panel -- the web's default
   * button. Not while it is disabled. At most one action may be the default, and
   * a button or a text area that takes Enter for itself keeps it.
   */
  default?: boolean;
  /** What the button says. */
  label: string;
  /**
   * What pressing the button does, in place of settling the dialog. The dialog
   * stays open until the handler calls `close()` on the handle, which is what a
   * submit that has to be checked first wants. An action has a `value` or an
   * `onPress`, and not both: a value settles the dialog, and so would a handler
   * that did.
   */
  onPress?: () => void;
  /** What the modal's `result` settles with when the button is pressed. */
  value?: T;
}

/**
 * Where a modal is put: the renderer, or any element that is the router's root.
 *
 * A host with `onDispose()` -- which a renderer has -- closes the modal when it
 * goes, with no answer. A bare element cannot say when it is no longer drawn.
 */
export type ModalHost =
  | Element
  | {
      onDispose?(handler: () => void): () => void;
      /**
       * What a `body` function is built under when nothing is running: a renderer's
       * root owner, which every renderer has. A bare element has none.
       */
      readonly owner?: Owner;
      readonly root: Element;
    };

export interface ModalOptions<T = undefined> {
  /**
   * The buttons. Defaults to one that says OK.
   *
   * An empty list is allowed, and then the dialog takes the focus itself, so it
   * still holds the keys and Escape still dismisses it.
   *
   * A button can be `disabled`, can be the `default` that Enter presses from a
   * field, and can run an `onPress` of its own in place of settling the dialog --
   * which is what a form's submit is. They are built under the dialog's owner, as a
   * `body` function is.
   */
  actions?: readonly ModalAction<T>[];
  /**
   * Draw the border with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule `note()` and the collapsible keep.
   */
  ascii?: boolean;
  /**
   * What is said: a string, which wraps, an element for anything else, or a
   * function that builds one.
   *
   * An element is adopted, so it can be in one place only -- and what is in it
   * that is focusable joins the trap.
   *
   * **A function is the form to reach for when the body has anything reactive in
   * it** -- a field over a `State`, a `disabled` that reads one, a text that
   * follows a signal. It is called once, as the modal opens, under an owner of its
   * own that is disposed when the modal closes, the way `Show` owns what it
   * mounts. An element the caller built first was built wherever the caller was,
   * and a dialog is nearly always opened from a key handler or an `onPress`, which
   * run with no owner: every effect in such a body was then never disposed, and one
   * that read the app's state went on running -- and keeping the dialog's elements
   * alive -- long after the dialog had gone.
   *
   * The owner is a branch of the renderer's root owner, wherever `openModal()` was
   * called from -- a body, a handler or a promise -- so the dialog does not go when
   * the component that opened it does. That owner is the root's, so a context a
   * component provided lower down is not one the function can read; one provided at
   * the root is. A bare element as `host` has no owner, and the body is then built
   * under a root of its own. What the function returns has to be
   * an element, and a function that throws leaves nothing open.
   */
  body?: Element | string | (() => Element);
  /**
   * Whether a click on the screen outside the panel dismisses it. Defaults to
   * `false`: a click that lands on nothing is more often a slip than a request.
   */
  closeOnClickOutside?: boolean;
  /**
   * Whether Escape dismisses it. Defaults to `true`.
   *
   * `false` makes the buttons the only way out, which is what a dialog that must
   * be answered wants -- and the app can still `close()` it.
   */
  dismissible?: boolean;
  /**
   * What holds the focus when it opens. Defaults to the first button.
   *
   * A number is the position of a button, the way a destructive confirm starts on
   * "No". `'body'` is the first thing in the body that takes the focus, which is
   * how a form opens on its first field while its buttons stay `actions`. An
   * element is that element, which has to be in the body -- so it is the form for a
   * body that is an element, since a `body` function builds its fields after the
   * caller has anything to name. Whatever is chosen but cannot take the focus --
   * a disabled button, a body with nothing focusable in it -- leaves it on the
   * first thing in the dialog that can.
   */
  initial?: number | 'body' | Element;
  /** The router the keys come from, which is also where the focus lives. */
  input: InputRouter;
  /** The panel's own props: a margin, a class. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onPaste'>;
  /** The heading. */
  title?: string;
  /** How wide the panel is, in cells. It never exceeds the screen. Defaults to 50. */
  width?: number;
}

export interface ModalHandle<T = undefined> {
  /**
   * Closes it, settling `result`, and puts the focus back.
   *
   * Does nothing the second time, so a button and an Escape that arrive together
   * settle it once.
   *
   * @param value - What `result` settles with. Nothing, for a dismissal.
   */
  close(value?: T): void;
  /** Closes it with no answer. The name every other handle uses for "put back what you attached". */
  dispose(): void;
  /** The element that was added to the root, for an app that wants to find it. */
  readonly element: Element;
  /** Whether it is still open. */
  readonly open: boolean;
  /**
   * The value of the button pressed, or `undefined` for a dismissal, a `dispose()`
   * or the renderer it was opened over being disposed.
   */
  readonly result: Promise<T | undefined>;
}

/**
 * Below the debug overlay's own `1000`, so the instrument stays readable over a
 * dialog whichever was appended last.
 */
const Z_INDEX = 900;

/** The room a panel gets when nobody says. */
const WIDTH = 50;

/** What a function built under the dialog's owner, and what disposes that owner. */
interface Owned<V> {
  /** Disposes the owner, and with it every effect and cleanup it made. */
  dispose(): void;
  readonly value: V;
}

/**
 * Runs what builds the dialog's parts under an owner that is the modal's to dispose.
 *
 * That is the body function and every button: a button's `disabled` is read in an
 * effect, and one that follows the app's state would otherwise outlive the dialog
 * exactly as a body's does.
 *
 * The parent is the host's own owner, which a renderer always has: the dialog is
 * the screen's and not the component's that happened to open it, so it is not
 * disposed when that component goes while the dialog is still up -- which would
 * leave it trapping the keys over a body whose effects had stopped. A bare element
 * has no owner, and then the parts get a root of their own: its effects run through
 * the default factory, which is all a host with no renderer behind it could mean.
 *
 * Untracked, because the function is the dialog's and not the caller's: one that
 * read a signal while an effect was opening the modal would otherwise make that
 * effect a sink of it. `runWithOwner()` puts the effect parentage aside and not the
 * consumer, which is why `createRoot()` untracks as well.
 *
 * @param host - What `openModal()` was given.
 * @param build - What makes the parts.
 * @returns What `build` made and what disposes its owner.
 * @throws What `build` threw; the owner is disposed first, so a call that failed
 *   here leaves nothing running.
 */
function buildOwned<V>(host: ModalHost, build: () => V): Owned<V> {
  const parent = host instanceof Element ? undefined : host.owner;
  let dispose: () => void;
  let value: V;
  const make = (): V => untrack(build);
  if (parent === undefined) {
    // `createRoot()` is what a fixture owns a handful of effects with, and its
    // disposer raises what a cleanup threw. The parts are built through it so that
    // a throw from `build` is the one thing left to give back by hand
    let off: (() => void) | undefined;
    try {
      value = createRoot((done) => {
        off = done;
        return make();
      });
    } catch (error) {
      off?.();
      throw error;
    }
    dispose = off as () => void;
  } else {
    const branch = runWithOwner(parent, createBranch);
    try {
      value = runWithOwner(branch.owner, make);
    } catch (error) {
      branch.dispose();
      throw error;
    }
    dispose = branch.dispose;
  }
  return { dispose, value };
}

/** A `body` function's answer, which has to be an element. */
function bodyElement(build: () => Element): Element {
  const made = build();
  if (!(made instanceof Element)) {
    throw new TypeError(__`Expected a modal body function to return an element`);
  }
  return made;
}

/**
 * Disposes the dialog's owner, holding on to what that threw.
 *
 * @param owned - What the dialog's parts were built under.
 * @returns The error, boxed so that a thrown `undefined` is still one; `undefined`
 *   when nothing was thrown.
 */
function disposeBody(owned: Owned<unknown> | undefined): { readonly error: unknown } | undefined {
  try {
    owned?.dispose();
  } catch (error) {
    return { error };
  }
  return undefined;
}

/**
 * Opens a modal over the screen.
 *
 * The dialog is appended to the root and is `position: fixed`, so it takes no
 * space and moves nothing -- the debug overlay's own arrangement -- and a
 * transparent box the size of the screen under it is what the mouse lands on
 * instead of whatever is below.
 *
 * @param host - The renderer, or the element the router was built over.
 * @param opts - The router, the words and the buttons.
 * @returns The handle.
 */
export function openModal<T = undefined>(host: ModalHost, opts: ModalOptions<T>): ModalHandle<T> {
  refuseOwnedHooks('openModal', opts?.props, ['onPaste']);
  const root = host instanceof Element ? host : host?.root;
  if (!(root instanceof Element)) {
    throw new TypeError(__`Expected a modal host to be an element or a renderer`);
  }
  const input = opts?.input;
  if (typeof input?.bind !== 'function' || typeof input.focus?.ring !== 'function') {
    throw new TypeError(__`Expected a modal input to be a router`);
  }
  if (opts.title !== undefined && typeof opts.title !== 'string') {
    throw new TypeError(__`Expected a modal title to be a string`);
  }
  if (
    opts.body !== undefined &&
    typeof opts.body !== 'string' &&
    typeof opts.body !== 'function' &&
    !(opts.body instanceof Element)
  ) {
    throw new TypeError(__`Expected a modal body to be a string, an element or a function`);
  }

  const actions: readonly ModalAction<T>[] = opts.actions ?? [{ label: __`OK` }];
  if (!Array.isArray(actions)) {
    throw new TypeError(__`Expected modal actions to be an array`);
  }
  let defaults = 0;
  for (const action of actions) {
    // blank is no label either: a button refuses one, and the message here says
    // which part of a modal was wrong
    if (typeof action?.label !== 'string' || labelLine(action.label) === '') {
      throw new TypeError(__`Expected a modal action to have a label`);
    }
    if (action.onPress !== undefined && typeof action.onPress !== 'function') {
      throw new TypeError(__`Expected a modal action onPress to be a function`);
    }
    // a value settles the dialog and so would a handler that settled it: one
    // answer for a button to give, not two
    if (action.onPress !== undefined && action.value !== undefined) {
      throw new TypeError(__`Expected a modal action to have a value or an onPress, not both`);
    }
    if (action.default !== undefined && typeof action.default !== 'boolean') {
      throw new TypeError(__`Expected a modal action default to be a boolean`);
    }
    // two would be one chosen by registration order, which is nobody's decision
    if (action.default === true && ++defaults > 1) {
      throw new TypeError(__`Expected a modal to have one default action at most`);
    }
  }
  const initial = opts.initial ?? 0;
  if (initial instanceof Element || initial === 'body') {
    // an element has to be in the body, which is known once the body is built
  } else if (
    typeof initial !== 'number' ||
    !Number.isInteger(initial) ||
    initial < 0 ||
    (actions.length > 0 && initial >= actions.length)
  ) {
    throw new TypeError(
      __`Expected modal initial to be the position of an action, 'body' or an element in the body`
    );
  }
  const dismissible = opts.dismissible !== false;
  // read live, here as well as by the button: Enter presses the default only while
  // it is enabled, and the button's own refusal is not what a key that never
  // reached the button asks. The message is the modal's, which is what names the part
  const conditions = actions.map((action) =>
    controlCondition(
      action.disabled,
      __`Expected modal action disabled to be a boolean, a State, a Computed or a function`
    )
  );

  // -- the tree -------------------------------------------------------------

  /** What an action does when it is pressed, by a click, a key or the default. */
  const press = (action: ModalAction<T>): void => {
    if (action.onPress === undefined) {
      close(action.value);
    } else {
      action.onPress();
    }
  };

  // built under the dialog's owner, with the body function: a `Button` each
  // (SIG-199) -- Enter, Space and a left click press it, and its focus is its own,
  // the brackets and the focus role on the label, drawn from the element's
  // `onFocusChange` rather than from the router's focus signal -- and a button's
  // `disabled` is read in an effect, which has to go when the dialog does. Built
  // here rather than with the validation above, after the checks that can refuse
  // the call have run: a body function has made effects by the time it returns, so
  // a call refused for a bad option should not have run it
  const owned = buildOwned(host, () => ({
    body: typeof opts.body === 'function' ? bodyElement(opts.body) : undefined,
    buttons: actions.map((action, at) =>
      Button({
        disabled: conditions[at],
        label: action.label,
        onPress: () => press(action),
        props: { class: 'sigil-modal-action' },
      })
    ),
  }));
  const { buttons } = owned.value;

  const border = (opts.ascii ?? !unicodeSupported()) ? 'ascii' : 'round';
  const panel = box({
    'border-style': border,
    class: 'sigil-modal',
    'flex-direction': 'column',
    'flex-shrink': 0,
    'max-width': '100%',
    'padding-left': 1,
    'padding-right': 1,
    position: 'relative',
    ...opts.props,
    width: Math.max(4, Math.floor(opts.width ?? WIDTH)),
  });

  // what makes the panel opaque. A box with no background paints nothing in its
  // empty cells, and a background colour is no answer: it is dropped at colour
  // level 0, and a dialog that lets the app show through between its words for a
  // user who asked for no colour is not one. So the panel is filled with blank
  // cells, which the grid counts as drawn -- in the terminal's own colours, so the
  // sheet declares nothing for it, and a theme that wants a colour behind the
  // dialog gives `.sigil-modal-fill` a background. First, so that everything else
  // is painted over it
  panel.append(opaqueFill('sigil-modal-fill'));

  if (opts.title !== undefined) {
    panel.append(textNode(opts.title, { class: 'sigil-modal-title sigil-heading' }));
  }
  let bodyBox: Element | undefined;
  if (opts.body !== undefined) {
    bodyBox =
      typeof opts.body === 'string'
        ? textNode(opts.body, { class: 'sigil-modal-body' })
        : box(
            { class: 'sigil-modal-body', 'flex-direction': 'column' },
            owned.value.body ?? (opts.body as Element)
          );
    panel.append(bodyBox);
  }
  if (initial instanceof Element && !(bodyBox?.contains(initial) ?? false)) {
    // nothing is attached to the router yet, so what is left to give back is the
    // owner the buttons and the body were built under
    disposeBody(owned);
    throw new TypeError(__`Expected modal initial to be an element in the body`);
  }
  if (buttons.length > 0) {
    panel.append(
      box(
        {
          class: 'sigil-modal-actions',
          'column-gap': 1,
          'flex-direction': 'row',
          'justify-content': 'flex-end',
          'margin-top': 1,
        },
        ...buttons
      )
    );
  }

  // the transparent box under the panel. It is the whole of how the mouse is kept
  // from what is below: the hit test is topmost-first and a box with no
  // background is hittable, so every report lands here or inside the panel
  const backdrop = box(
    {
      'align-items': 'center',
      bottom: 0,
      class: 'sigil-modal-backdrop',
      'flex-direction': 'column',
      'justify-content': 'center',
      left: 0,
      position: 'fixed',
      right: 0,
      top: 0,
      'z-index': Z_INDEX,
    } satisfies ElementProps,
    panel
  );

  // -- the stack ------------------------------------------------------------

  // shared with the menus through `overlay.ts`, so a dropdown opened inside the
  // dialog is a layer over it and the dialog's binding stands aside for it
  const layer = holdInput(input, { element: panel, trap: true });
  const isTop = layer.isTop;

  // -- the settling ---------------------------------------------------------

  let settle!: (value: T | undefined) => void;
  const result = new Promise<T | undefined>((resolve) => {
    settle = resolve;
  });
  let open = true;
  let offDispose: (() => void) | undefined;

  /** What had the focus before this opened, which is where it goes back to. */
  const previous = input.focus.current.get();

  /** The focusable elements inside one panel, in the order Tab visits them. */
  const inside = (scope: Element): Element[] =>
    input.focus.ring().filter((element) => scope.contains(element));

  function close(value?: T): void {
    if (!open) {
      return;
    }
    open = false;

    const at = input.focus.current.get();
    // asked before the panel leaves, because afterwards nothing is inside it. A
    // focus that is somewhere else already -- a lower modal closed under an upper
    // one -- is not ours to take back
    const held = at !== undefined && panel.contains(at);

    layer.release();
    offDispose?.();
    offKey();
    // the body's owner goes with the dialog, and before the panel leaves the tree
    // and the focus moves: a cleanup in the body has the elements it set up still to
    // take itself out of, and an effect over the focus does not hear the dialog's own
    // hand-back. What a cleanup threw goes to the renderer's `onError`, as any
    // unmount's does; on a bare element there is no sink, and it is raised once the
    // dialog has settled, since a throw from here would leave `result` pending and
    // the focus where it was
    const failure = disposeBody(owned);
    // the tree the dialog was in, taken before it leaves it: an element that took
    // the focus without being in the ring -- a pane's edge, which a click focused --
    // is not in `pool`, and "is it still mounted" has to be asked of the tree
    const base = backdrop.parent === undefined ? undefined : rootOf(backdrop.parent);
    backdrop.remove();

    if (held) {
      // inside whatever modal is now on top, and not the whole ring: the one
      // below is still a trap, and a fallback that stepped out of it would be
      // the escape the trap exists to prevent
      const next = layer.nearestTrap();
      const pool = next === undefined ? input.focus.ring() : inside(next.element);
      if (previous === undefined) {
        input.focus.focus(undefined);
      } else if (
        pool.includes(previous) ||
        // out of the ring and still there: a focusable the dialog took the focus
        // from goes back to it, rather than to whatever the ring starts with. Held to
        // the modal underneath, if there is one, for the reason `pool` is
        (previous.focusable &&
          base !== undefined &&
          rootOf(previous) === base &&
          (next === undefined || next.element.contains(previous)))
      ) {
        input.focus.focus(previous);
      } else {
        input.focus.focus(pool[0]);
      }
    }

    settle(value);
    if (failure !== undefined) {
      throw failure.error;
    }
  }

  // -- the mouse ------------------------------------------------------------

  backdrop.onMouse = (event: MouseEvent): void => {
    const onBackdrop = event.target === backdrop;
    if (onBackdrop && opts.closeOnClickOutside === true && event.kind === 'click') {
      if (event.button === 'left' && isTop()) {
        close();
      }
    }
    // a press inside the panel is left to bubble, because stopping it would
    // suppress click-to-focus -- the default action a button is focused by.
    // Everything else ends here, so the root and the router's own handlers see
    // none of it
    if (!onBackdrop && event.kind === 'mousedown') {
      return;
    }
    event.stop();
  };

  // -- the keys -------------------------------------------------------------

  /** Moves the focus along the modal's own ring, wrapping. */
  function cycle(by: number): void {
    const ring = inside(panel);
    if (ring.length === 0) {
      return;
    }
    const at = input.focus.current.get();
    const from = at === undefined ? -1 : ring.indexOf(at);
    const to =
      from === -1 ? (by > 0 ? 0 : ring.length - 1) : (from + by + ring.length) % ring.length;
    input.focus.focus(ring[to]);
  }

  /**
   * The initial focus: what `initial` names, else the first thing focusable, else
   * the panel. What it names but cannot be focused -- a disabled button, a body
   * with nothing in it that takes the focus -- is not a reason to leave the focus
   * outside the dialog.
   */
  function claimFocus(): void {
    const chosen =
      initial instanceof Element
        ? initial
        : initial === 'body'
          ? bodyBox === undefined
            ? undefined
            : inside(bodyBox)[0]
          : buttons[initial];
    const first = chosen?.focusable === true ? chosen : inside(panel)[0];
    if (first !== undefined) {
      input.focus.focus(first);
      return;
    }
    panel.setProp('focusable', true);
    input.focus.focus(panel);
  }

  /**
   * Presses the default action, if Enter is a key that does and it is enabled.
   *
   * What reaches here is a key the focused element and everything up to the panel
   * left alone, so a button, a text area and a field with an `onSubmit` -- each of
   * which takes Enter for itself -- are never overruled. A modifier makes it
   * another key, as it does for a button, and a paste is not a keystroke.
   */
  function pressDefault(key: Key, paste: boolean): void {
    if (paste || key.name !== 'enter' || key.ctrl || key.meta || key.shift) {
      return;
    }
    const at = actions.findIndex((action) => action.default === true);
    if (at !== -1 && !conditions[at].get()) {
      press(actions[at]);
    }
  }

  /**
   * Hands a key to the focused element and its ancestors up to the panel.
   *
   * The router's own walk would carry on to the root, and the sequence trie sits
   * before it -- both are what is below. So the walk is done here, over an event
   * that says what the router's would have, and the real one is stopped.
   *
   * @returns Whether anything on the way took the key.
   */
  function deliver(key: Key, paste: boolean, target: Element): boolean {
    let stopped = false;
    let current: Element | undefined = target;
    const mirror: KeyEvent = {
      get current() {
        return current;
      },
      key,
      paste,
      stop(): void {
        stopped = true;
      },
      get stopped() {
        return stopped;
      },
      target,
    };

    while (current !== undefined && !stopped) {
      current.onKey?.(mirror);
      if (current === panel) {
        break;
      }
      current = current.parent;
    }
    return stopped;
  }

  const offKey = input.bind((event: KeyEvent) => {
    // a lower modal's binding runs first and stands aside: the top one is the
    // only one with anything to say
    if (!open || !isTop()) {
      return;
    }
    const k = event.key;
    // never the abort. A binding sees every key first so that the app can always
    // be quit, and a dialog that swallowed Ctrl-C would be the failure that order
    // exists to prevent
    if (isAbort(k)) {
      return;
    }

    if (!event.paste && !k.ctrl && !k.meta) {
      if (k.name === 'tab') {
        event.stop();
        cycle(k.shift ? -1 : 1);
        return;
      }
      if (k.name === 'escape' && dismissible) {
        event.stop();
        close();
        return;
      }
    }

    let at = input.focus.current.get();
    if (at === undefined || !panel.contains(at)) {
      // the focus got out -- an app moved it, or it was never in. Put it back
      // where it starts rather than deliver a key to something under the dialog
      claimFocus();
      at = input.focus.current.get();
    }
    if (at !== undefined && !deliver(event.key, event.paste, at) && open) {
      pressDefault(event.key, event.paste);
    }
    event.stop();
  });

  // a paste walks up from the focused element before the router's own handlers
  // see it, so one that reaches the panel is one nothing inside claimed -- and
  // past the panel are the root and the app's `onPaste()` handlers, which are
  // what is below. So it ends here, and is typed in here: what the router does
  // with a paste nobody took whole, over the same walk a key gets, so that an
  // element inside that reads keys still has it and nothing outside does
  panel.onPaste = (event: PasteEvent): void => {
    event.stop();
    for (const key of decodeKeys(event.text)) {
      const at = input.focus.current.get();
      // a pasted key that closed the dialog or moved the focus out leaves the
      // rest of the paste with nowhere inside to go, and outside is not an option
      if (!open || !isTop() || at === undefined || !panel.contains(at)) {
        return;
      }
      deliver(key, true, at);
    }
  };

  root.append(backdrop);
  claimFocus();

  // what the footer lists while this is up: the keys it answers itself, in place of
  // the app's, which its binding takes before they are reached. Asked once, as it
  // opens, when the tree can say what is focusable inside it. Tab is listed only
  // where there is somewhere to go. Enter presses the focused button, so it is
  // listed only where it can only mean that: a field in the body takes Enter for
  // itself -- a newline, a submit -- or leaves it to the default action, and a
  // footer saying "select" over either would be the lie this listing exists to
  // remove
  const focusable = inside(panel);
  if (focusable.length > 1) {
    layer.describe('tab', { description: __`next`, priority: 1 });
    layer.describe('shift+tab', { description: __`previous`, priority: 0 });
  }
  if (buttons.length > 0 && focusable.every((element) => buttons.includes(element))) {
    layer.describe('enter', { description: __`select`, priority: 2 });
  }
  if (dismissible) {
    layer.describe('escape', { description: __`close`, priority: 3 });
  }

  // closed with no answer when the renderer goes. The binding above stops every
  // key it is given, so a dialog left open on a router the app goes on owning
  // would swallow its keys for good -- and `result` would never settle. Last,
  // because a renderer that has already gone calls this at once
  if (!(host instanceof Element)) {
    offDispose = host.onDispose?.(() => close());
  }

  return {
    close,
    dispose(): void {
      close();
    },
    element: backdrop,
    get open() {
      return open;
    },
    result,
  };
}

export interface ConfirmModalOptions extends Omit<
  ModalOptions<boolean>,
  'actions' | 'body' | 'initial'
> {
  /** Which answer holds the focus when it opens. Defaults to `yes`. */
  initial?: 'no' | 'yes';
  /** What is asked, below the title. */
  message?: string;
  /** The label of the negative button. Defaults to No. */
  no?: string;
  /** The label of the affirmative button. Defaults to Yes. */
  yes?: string;
}

/**
 * Asks a yes-or-no question over the screen.
 *
 * A dismissal is a no: Escape and a click outside answer `false`, because
 * leaving a question unanswered has never meant "go ahead".
 *
 * @param host - The renderer, or the element the router was built over.
 * @param opts - The router, the question and the labels.
 * @returns Settles with the answer.
 */
export async function confirmModal(host: ModalHost, opts: ConfirmModalOptions): Promise<boolean> {
  const { message, no, yes, initial, ...rest } = opts;
  const handle = openModal<boolean>(host, {
    ...rest,
    actions: [
      { label: yes ?? __`Yes`, value: true },
      { label: no ?? __`No`, value: false },
    ],
    body: message,
    initial: initial === 'no' ? 1 : 0,
  });
  return (await handle.result) === true;
}
