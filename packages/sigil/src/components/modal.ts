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
  cellStyle,
  Element,
  type ElementProps,
  type ElementPropsWithout,
  raw,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter, KeyEvent, MouseEvent, PasteEvent } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { decodeKeys, isAbort, type Key } from './keys.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';

/** One button along the bottom of the dialog. */
export interface ModalAction<T = unknown> {
  /** What the button says. */
  label: string;
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
  | { onDispose?(handler: () => void): () => void; readonly root: Element };

export interface ModalOptions<T = undefined> {
  /**
   * The buttons. Defaults to one that says OK.
   *
   * An empty list is allowed, and then the dialog takes the focus itself, so it
   * still holds the keys and Escape still dismisses it.
   */
  actions?: readonly ModalAction<T>[];
  /**
   * Draw the border with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule `note()` and the collapsible keep.
   */
  ascii?: boolean;
  /**
   * What is said: a string, which wraps, or an element for anything else.
   *
   * An element is adopted, so it can be in one place only -- and what is in it
   * that is focusable joins the trap.
   */
  body?: Element | string;
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
   * Which button holds the focus when it opens, by position. Defaults to the first.
   *
   * The way a destructive confirm starts on "No".
   */
  initial?: number;
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

/** Each router's open modals, bottom first. The last one owns the input. */
const STACKS = new WeakMap<InputRouter, Entry[]>();

/** What the stack needs to know about one open modal. */
interface Entry {
  panel: Element;
}

/** The button text: bracketed while it has the focus, so it reads without colour too. */
function buttonText(label: string, focused: boolean): string {
  return focused ? `[ ${label} ]` : `  ${label}  `;
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
  if (opts.body !== undefined && typeof opts.body !== 'string' && !(opts.body instanceof Element)) {
    throw new TypeError(__`Expected a modal body to be a string or an element`);
  }

  const actions: readonly ModalAction<T>[] = opts.actions ?? [{ label: __`OK` }];
  if (!Array.isArray(actions)) {
    throw new TypeError(__`Expected modal actions to be an array`);
  }
  for (const action of actions) {
    if (typeof action?.label !== 'string' || action.label === '') {
      throw new TypeError(__`Expected a modal action to have a label`);
    }
  }
  const initial = opts.initial ?? 0;
  if (
    !Number.isInteger(initial) ||
    initial < 0 ||
    (actions.length > 0 && initial >= actions.length)
  ) {
    throw new TypeError(__`Expected modal initial to be the position of an action`);
  }
  const dismissible = opts.dismissible !== false;

  // -- the tree -------------------------------------------------------------

  const buttons = actions.map((action) =>
    textNode(buttonText(action.label, false), {
      class: 'sigil-modal-action',
      focusable: true,
      'flex-shrink': 0,
      'white-space': 'nowrap',
    })
  );

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
  panel.append(
    raw(
      {
        measure: () => ({ height: 0, width: 0 }),
        paint: (painter, area, element) => {
          painter.fill(area.x, area.y, area.width, area.height, cellStyle(element.style));
        },
      },
      {
        bottom: 0,
        class: 'sigil-modal-fill',
        left: 0,
        position: 'absolute',
        right: 0,
        top: 0,
      }
    )
  );

  if (opts.title !== undefined) {
    panel.append(textNode(opts.title, { class: 'sigil-modal-title sigil-heading' }));
  }
  if (opts.body !== undefined) {
    const body =
      typeof opts.body === 'string'
        ? textNode(opts.body, { class: 'sigil-modal-body' })
        : box({ class: 'sigil-modal-body', 'flex-direction': 'column' }, opts.body);
    panel.append(body);
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

  const entry: Entry = { panel };
  let stack = STACKS.get(input);
  if (stack === undefined) {
    stack = [];
    STACKS.set(input, stack);
  }
  const mine = stack;
  mine.push(entry);
  const isTop = (): boolean => mine.at(-1) === entry;

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

    const index = mine.indexOf(entry);
    if (index !== -1) {
      mine.splice(index, 1);
    }
    offDispose?.();
    offKey();
    offFocus();
    backdrop.remove();

    if (held) {
      // inside whatever modal is now on top, and not the whole ring: the one
      // below is still a trap, and a fallback that stepped out of it would be
      // the escape the trap exists to prevent
      const next = mine.at(-1);
      const pool = next === undefined ? input.focus.ring() : inside(next.panel);
      if (previous === undefined) {
        input.focus.focus(undefined);
      } else if (pool.includes(previous)) {
        input.focus.focus(previous);
      } else {
        input.focus.focus(pool[0]);
      }
    }

    settle(value);
  }

  // -- the buttons ----------------------------------------------------------

  for (const [index, button] of buttons.entries()) {
    const action = actions[index] as ModalAction<T>;
    button.onKey = (event): void => {
      const k = event.key;
      if (event.paste || k.ctrl || k.meta || k.shift) {
        return;
      }
      if (k.name === 'enter' || k.name === 'space') {
        event.stop();
        close(action.value);
      }
    };
    button.onMouse = (event): void => {
      if (event.kind !== 'click' || event.button !== 'left') {
        return;
      }
      event.stop();
      close(action.value);
    };
  }

  // the focused button is the bracketed one, and the accent. Read off the focus
  // signal rather than set by whoever moved it, because a Tab, a click and an
  // app calling `focus()` are three ways to one change
  const offFocus = createEffect(() => {
    const at = input.focus.current.get();
    for (const [index, button] of buttons.entries()) {
      const on = button === at;
      button.setText(buttonText((actions[index] as ModalAction<T>).label, on));
      button.toggleClass('sigil-accent', on);
    }
  });

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

  /** The initial focus: the chosen button, else the first thing focusable, else the panel. */
  function claimFocus(): void {
    const first = buttons[initial] ?? inside(panel)[0];
    if (first !== undefined) {
      input.focus.focus(first);
      return;
    }
    panel.setProp('focusable', true);
    input.focus.focus(panel);
  }

  /**
   * Hands a key to the focused element and its ancestors up to the panel.
   *
   * The router's own walk would carry on to the root, and the sequence trie sits
   * before it -- both are what is below. So the walk is done here, over an event
   * that says what the router's would have, and the real one is stopped.
   */
  function deliver(key: Key, paste: boolean, target: Element): void {
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
    if (at !== undefined) {
      deliver(event.key, event.paste, at);
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
