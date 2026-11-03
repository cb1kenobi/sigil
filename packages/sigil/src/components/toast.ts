/**
 * A toast: a short message in a corner of the screen that goes away by itself.
 *
 * A full-screen app wants to say "Saved" or "3 files copied" without stopping
 * anybody: no dialog to answer, no line pushed into the layout, and no change to
 * where the keys go. That is the whole of the difference from a modal, and the
 * part that needs care is the last of the three -- a toast never takes the focus,
 * never takes a key, and never lets a click on it reach through to what is under
 * it or move the focus as a press would.
 *
 * ```js
 * import { showToast } from '@ttylabs/sigil/components';
 *
 * showToast(view, { message: 'Saved draft.md', variant: 'success' });
 * showToast(view, { message: 'Lost the connection', timeout: 8000, variant: 'error' });
 * ```
 *
 * Toasts in one corner stack, the newest nearest the corner, and a corner holds
 * three unless told otherwise: a fourth pushes the oldest out. A left click on a
 * toast dismisses it. Under `--quiet` a toast is not drawn at all, because it is
 * a remark beside the answer rather than the answer -- `AGENTS.md` has that and
 * the rest under "A toast".
 */

import { strip } from '../ansi/index.js';
import {
  box,
  cellStyle,
  Element,
  type ElementProps,
  raw,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { MouseEvent } from '../input/index.js';
import { onCleanup } from '../renderer/index.js';
import type { Terminal } from '../terminal/index.js';
import { mountLevel } from './mount.js';
import { type NoteVariant, unicodeSupported } from './note.js';

/** Which corner of the screen a toast stacks in. */
export type ToastPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

/**
 * Why a toast went away.
 *
 * - `timeout` -- its time ran out.
 * - `dismiss` -- it was clicked, `dismiss()` or `dispose()` was called, or the
 *   owner it was raised under or the renderer it was shown over was disposed.
 * - `overflow` -- a newer toast in the same corner pushed it past `max`.
 * - `quiet` -- it was raised under `--quiet`, so it was never shown at all.
 */
export type ToastCloseReason = 'dismiss' | 'overflow' | 'quiet' | 'timeout';

/**
 * Where a toast is put: the renderer, or any element that is the root of the screen.
 *
 * A host with `onDispose()` -- which a renderer has -- takes its toasts with it
 * when it goes. A bare element cannot say when nothing is drawing it any more,
 * so a toast over one runs its course.
 */
export type ToastHost =
  | Element
  | { onDispose?(handler: () => void): () => void; readonly root: Element };

export interface ToastOptions {
  /**
   * Draw the border with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule `note()` and the modal keep.
   */
  ascii?: boolean;
  /**
   * How many toasts the corner holds at once, counting this one. Defaults to 3.
   *
   * The oldest go first: a toast is about something that just happened, and one
   * held back until there was room would be news by the time it was shown.
   */
  max?: number;
  /** What is said. Wraps to the toast's width; escape sequences are dropped. */
  message: string;
  /**
   * Called once, when it goes, with why.
   *
   * A callback rather than a promise, because nothing should wait on a toast:
   * its timer does not hold the process open, so a promise awaited at the top
   * level would be one the process could exit under.
   */
  onClose?: (reason: ToastCloseReason) => void;
  /** Which corner. Defaults to `bottom-right`. */
  position?: ToastPosition;
  /** The toast's own props: a margin, a class. Geometry only, never a colour. */
  props?: ElementProps;
  /**
   * Whether this toast is progress rather than the answer -- `MountOptions.quiet`.
   *
   * Left unset, `--quiet` decides, and a quiet run shows no toast. `true` hides
   * this one whatever was asked; `false` shows it under `--quiet` too, for a toast
   * an app has decided is part of what it answers.
   */
  quiet?: boolean;
  /** The terminal `--quiet` and the screen are read against. Defaults to the process's. */
  terminal?: Terminal;
  /**
   * How long it stays, in milliseconds. Defaults to 4000.
   *
   * `Infinity` keeps it until it is clicked or dismissed. Anything else has to be
   * a positive number no larger than a timer can wait for, which is 2^31 - 1.
   */
  timeout?: number;
  /** A heading above the message. */
  title?: string;
  /**
   * Which role colours it -- the border, the title and the message. Defaults to
   * `note`, which is no role at all: the terminal's own foreground.
   */
  variant?: NoteVariant;
  /** How wide it is, in cells. It never exceeds the screen. Defaults to 32. */
  width?: number;
}

export interface ToastHandle {
  /** Takes it away now. Does nothing once it has gone. */
  dismiss(): void;
  /** `dismiss()`, under the name every other handle uses for "put back what you attached". */
  dispose(): void;
  /** The toast itself. Never added anywhere when it was raised under `--quiet`. */
  readonly element: Element;
  /** Whether it is on screen. */
  readonly open: boolean;
}

/**
 * Above a modal's `900` and below the debug overlay's `1000`.
 *
 * Above the dialog because a toast raised while one is open -- "Copied" from a
 * button inside it -- is still news, and it takes no input that the dialog could
 * be owed. Below the overlay so the instrument stays readable over both.
 */
const Z_INDEX = 950;

/** How long a toast stays when nobody says. */
const TIMEOUT = 4000;

/** How many toasts a corner holds when nobody says. */
const MAX = 3;

/** How wide a toast is when nobody says. */
const WIDTH = 32;

/** The longest a timer can wait: past it, the platform fires at once. */
const MAX_DELAY = 2 ** 31 - 1;

const POSITIONS: readonly ToastPosition[] = [
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right',
];

/**
 * The role class a variant takes its colour from, and the same table as
 * `note()`'s: `warning` is `warn` so that every variant lands on a role the
 * framework sheet already declares.
 */
const ROLES: Record<Exclude<NoteVariant, 'note'>, string> = {
  error: 'sigil-error',
  info: 'sigil-info',
  success: 'sigil-success',
  warning: 'sigil-warn',
};

/** One corner's toasts: the box they sit in, and what is in it, oldest first. */
interface Stack {
  readonly box: Element;
  readonly entries: Array<{ close(reason: ToastCloseReason): void }>;
}

/** Each root's corners. A `WeakMap`, so a root that has gone takes its stacks with it. */
const STACKS = new WeakMap<Element, Map<ToastPosition, Stack>>();

/**
 * The corner's box, made the first time a toast lands there.
 *
 * `position: fixed`, so it takes no space and moves nothing, and pinned by the two
 * insets that name the corner. A column whose items keep the toast's own width,
 * so a stack is one straight edge of toasts with no gap between them for a click
 * to fall through.
 */
function stackFor(root: Element, position: ToastPosition): Stack {
  let corners = STACKS.get(root);
  if (corners === undefined) {
    corners = new Map();
    STACKS.set(root, corners);
  }
  let stack = corners.get(position);
  if (stack !== undefined && stack.box.parent !== root) {
    // the app took the corner out of the tree -- cleared the screen, say -- and
    // its toasts went with it. They are closed rather than put back, which clears
    // their timers, and the corner starts again
    while (stack.entries.length > 0) {
      stack.entries[0]?.close('dismiss');
    }
    stack = undefined;
  }
  if (stack === undefined) {
    const [vertical, horizontal] = position.split('-') as ['bottom' | 'top', 'left' | 'right'];
    stack = {
      box: box({
        'align-items': horizontal === 'left' ? 'flex-start' : 'flex-end',
        [vertical]: 0,
        class: 'sigil-toast-stack',
        'flex-direction': 'column',
        [horizontal]: 0,
        'max-width': '100%',
        position: 'fixed',
        'z-index': Z_INDEX,
      }),
      entries: [],
    };
    corners.set(position, stack);
    root.append(stack.box);
  }
  return stack;
}

/**
 * Shows a toast in a corner of the screen.
 *
 * It is resolved against `--quiet` once, here: a toast raised under it is never
 * drawn and closes at once, and one already showing when quiet is asked for runs
 * out its own time, which is the rule a mount's level keeps.
 *
 * Raised inside a component -- its body, or an effect -- it belongs to that
 * component and goes when it does, the way anything else created there does.
 * Raised from a key handler or a promise, which have no owner, it belongs to
 * nobody and runs its course -- unless the host is a renderer, which takes it
 * away when it is disposed.
 *
 * @param host - The renderer, or the root element the screen is drawn from.
 * @param opts - The message, and where and for how long.
 * @returns The handle.
 */
export function showToast(host: ToastHost, opts: ToastOptions): ToastHandle {
  const root = host instanceof Element ? host : host?.root;
  if (!(root instanceof Element)) {
    throw new TypeError(__`Expected a toast host to be an element or a renderer`);
  }
  if (typeof opts?.message !== 'string') {
    throw new TypeError(__`Expected a toast message to be a string`);
  }
  if (opts.title !== undefined && typeof opts.title !== 'string') {
    throw new TypeError(__`Expected a toast title to be a string`);
  }
  const variant = opts.variant ?? 'note';
  if (variant !== 'note' && !Object.hasOwn(ROLES, variant)) {
    throw new TypeError(__`Expected a toast variant to be note, info, success, warning or error`);
  }
  const position = opts.position ?? 'bottom-right';
  if (!POSITIONS.includes(position)) {
    throw new TypeError(__`Expected a toast position to be a corner of the screen`);
  }
  const timeout = opts.timeout ?? TIMEOUT;
  if (
    typeof timeout !== 'number' ||
    !(timeout > 0) ||
    (timeout !== Infinity && timeout > MAX_DELAY)
  ) {
    throw new TypeError(__`Expected a toast timeout to be a number of milliseconds`);
  }
  const max = opts.max ?? MAX;
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError(__`Expected toast max to be a whole number of at least 1`);
  }

  // -- the tree -------------------------------------------------------------

  const border = (opts.ascii ?? !unicodeSupported()) ? 'ascii' : 'round';
  const role = variant === 'note' ? '' : ` ${ROLES[variant]}`;
  const panel = box({
    'border-style': border,
    class: `sigil-toast sigil-toast-${variant}${role}`,
    'flex-direction': 'column',
    'flex-shrink': 0,
    'max-width': '100%',
    'padding-left': 1,
    'padding-right': 1,
    position: 'relative',
    ...opts.props,
    width: Math.max(5, Math.floor(opts.width ?? WIDTH)),
  });

  // opaque with no colour, which is the modal's answer and for the modal's
  // reason: a box with no background paints nothing in its empty cells, and a
  // background colour is dropped at colour level 0 -- so the app would show
  // through between the words for exactly the user who asked for no colour.
  // Filled with blank cells instead, which the grid counts as drawn
  panel.append(
    raw(
      {
        measure: () => ({ height: 0, width: 0 }),
        paint: (painter, area, element) => {
          painter.fill(area.x, area.y, area.width, area.height, cellStyle(element.style));
        },
      },
      { bottom: 0, class: 'sigil-toast-fill', left: 0, position: 'absolute', right: 0, top: 0 }
    )
  );
  if (opts.title !== undefined) {
    panel.append(textNode(strip(opts.title), { class: 'sigil-toast-title sigil-heading' }));
  }
  panel.append(textNode(strip(opts.message), { class: 'sigil-toast-message' }));

  let open = false;
  const handle: ToastHandle = {
    dismiss: () => close('dismiss'),
    dispose: () => close('dismiss'),
    element: panel,
    get open() {
      return open;
    },
  };

  // asked once, at the moment it is raised. Quiet is the only answer that
  // changes anything: there is no motion here for `reduce` to take away, so a
  // pipe and a terminal show the same toast
  if (mountLevel({ quiet: opts.quiet, terminal: opts.terminal }) === 'quiet') {
    opts.onClose?.('quiet');
    return handle;
  }

  // -- the stack ------------------------------------------------------------

  const stack = stackFor(root, position);
  const entry = { close };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offDispose: (() => void) | undefined;
  open = true;

  function close(reason: ToastCloseReason): void {
    if (!open) {
      return;
    }
    open = false;
    clearTimeout(timer);
    offDispose?.();

    const index = stack.entries.indexOf(entry);
    if (index !== -1) {
      stack.entries.splice(index, 1);
    }
    panel.remove();
    if (stack.entries.length === 0) {
      // the corner's box goes with its last toast, so an app with nothing to
      // say has nothing of ours in its tree
      stack.box.remove();
      STACKS.get(root)?.delete(position);
    }

    opts.onClose?.(reason);
  }

  // the newest nearest the corner: appended at the foot of a bottom stack and
  // put at the head of a top one. Which also decides what a screen too short for
  // the whole stack cuts off -- the oldest, at the far end
  if (position.startsWith('top')) {
    stack.box.insertBefore(panel, stack.box.children[0]);
  } else {
    stack.box.append(panel);
  }
  stack.entries.push(entry);

  // the oldest go, until this one fits. Closing one takes it out of the list,
  // so the head is read afresh each time round
  while (stack.entries.length > max) {
    stack.entries[0]?.close('overflow');
  }

  // -- the mouse ------------------------------------------------------------

  // every report that lands on a toast ends here. A press is the one that
  // matters: left to bubble, it reaches click-to-focus, which focuses the nearest
  // focusable ancestor -- and a toast inside a focusable panel would then move
  // the focus by being touched. A click dismisses, which is the one thing
  // somebody pointing at a toast can want of it
  panel.onMouse = (event: MouseEvent): void => {
    if (event.kind === 'click' && event.button === 'left') {
      close('dismiss');
    }
    event.stop();
  };

  // -- the clock ------------------------------------------------------------

  if (timeout !== Infinity) {
    timer = setTimeout(() => close('timeout'), timeout);
    // a toast is not a reason to stay alive: a program that has finished exits
    // with one still showing, which is the spinner's rule and the clock's redraw
    timer.unref?.();
  }

  // and owned by whatever owns the caller. Outside a component this registers
  // nothing; inside one it is the component's to take away, and a disposed
  // owner runs it at once, so a toast raised from a callback that outlived its
  // component goes as it arrives
  onCleanup(() => close('dismiss'));

  // and it goes with the renderer, which is what a toast raised from a key
  // handler has instead of an owner: its timer is cleared and its corner taken
  // out the moment nothing will draw it, rather than when the timer runs out
  // over a tree nobody is drawing. After the timer, so that a renderer that has
  // already gone -- which calls this at once -- has a timer to clear
  if (!(host instanceof Element)) {
    offDispose = host.onDispose?.(() => close('dismiss'));
  }

  return handle;
}
