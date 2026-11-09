/**
 * A tooltip: a line of text anchored to an element, shown while the pointer is
 * over it or the keyboard is on it.
 *
 * ```js
 * import { attachTooltip } from '@ttylabs/sigil/components';
 *
 * const tip = attachTooltip(saveButton, { input, text: 'Writes the file to disk' });
 * // ...
 * tip.dispose();
 * ```
 *
 * It needs no element of the app's beyond the anchor and takes none of its
 * hooks: the anchor's `onMouse` and `onKey` stay the app's. What it reads is the
 * anchor's `hover` state, which the router writes under `mouse.motion`, and the
 * focus signal, which it writes always -- so a keyboard-only app gets the same
 * tooltip when the anchor has the focus, and an app with no mouse at all gets
 * nothing less than that. Escape dismisses it without being taken from anybody.
 *
 * The bubble is added to the anchor's root as `position: fixed`, so it takes no
 * space, escapes every ancestor's clip, and is placed against the screen once the
 * layout has said how big it came out -- flipped to the other side when it does
 * not fit, and along the edge when its start would run off the end. It follows
 * the anchor while shown -- a scroll, a reflow, an animation -- and is hidden while
 * the anchor is scrolled out of view. It is never focusable and never moves the
 * focus.
 *
 * `AGENTS.md` records the keyboard answer, the flip, the following, and why
 * `--quiet` hides it.
 */

import {
  box,
  cellStyle,
  type Element,
  type ElementProps,
  type ElementPropsWithout,
  raw,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter } from '../input/index.js';
import type { Box } from '../layout/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { resolveOutput } from '../style/index.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';

/** Which side of the anchor the bubble goes on. */
export type TooltipSide = 'bottom' | 'left' | 'right' | 'top';

export interface TooltipOptions {
  /**
   * Draw the border with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule `note()` and the modal keep.
   */
  ascii?: boolean;
  /**
   * How long the anchor has to be hovered or focused before the bubble shows, in
   * milliseconds. Defaults to 500.
   *
   * The same wait for the pointer and the keyboard: it is what keeps a pointer
   * passing over a row of buttons, or a Tab passing through them, from drawing a
   * bubble at every stop. `0` shows it at once.
   */
  delay?: number;
  /** The router hover and focus come from. */
  input: InputRouter;
  /** The widest the bubble may be, border included, in cells. Defaults to 40. */
  maxWidth?: number;
  /** The bubble's own props: a class. Geometry is the tooltip's, and is overwritten. */
  props?: ElementPropsWithout<'onLayout'>;
  /**
   * Whether `--quiet` hides it. Defaults to following the process-wide request.
   *
   * `false` is how an app says this one is not chrome, which is the top of
   * `resolveOutput()`'s chain the way `MountOptions.quiet` is.
   */
  quiet?: boolean;
  /** The side it goes on when there is room. Defaults to `bottom`. */
  side?: TooltipSide;
  /** What it says. Wraps at `maxWidth`. */
  text: string;
}

export interface TooltipHandle {
  /**
   * Takes the tooltip off the anchor: the bubble, the timer, and every
   * subscription. Called for you when the component it was attached in unmounts.
   */
  dispose(): void;
  /** The bubble while it is shown, for an app or a test that wants to find it. */
  readonly element: Element | undefined;
  /** Hides it until the pointer and the focus have both left and come back, as Escape does. */
  hide(): void;
  /** Changes what it says, re-placing the bubble if it is shown. */
  setText(value: string): void;
  /**
   * Whether the bubble is in the tree. Still `true` while the anchor is scrolled
   * out of view, where the bubble is kept hidden so that it comes back with the
   * anchor; `side` is what says it is not drawn.
   */
  readonly shown: boolean;
  /**
   * Where it was placed, which is `side` or the side it flipped to. `undefined`
   * until the layout has placed it, and while the anchor is out of view.
   */
  readonly side: TooltipSide | undefined;
}

/** Where a bubble goes, and which side that came to. */
export interface TooltipPlacement {
  side: TooltipSide;
  /** The bubble's left edge, in the same coordinates as the boxes it was given. */
  x: number;
  /** The bubble's top edge. */
  y: number;
}

/**
 * Above the modal's `900`, so a tooltip on a button inside a dialog is drawn over
 * the dialog, and below the debug overlay's `1000`, so the instrument stays
 * readable over both.
 */
const Z_INDEX = 950;

/** The wait before a bubble shows, when nobody says. */
const DELAY = 500;

/** The widest a bubble is, when nobody says. */
const MAX_WIDTH = 40;

const SIDES: readonly TooltipSide[] = ['bottom', 'left', 'right', 'top'];

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  bottom: 'top',
  left: 'right',
  right: 'left',
  top: 'bottom',
};

/**
 * Where a bubble of a given size goes beside an anchor, inside a screen.
 *
 * The main axis flips: the bubble goes on `side` where it fits, else on the
 * opposite side where that fits, and where neither does, on whichever has more
 * room -- the preferred one on a tie. The cross axis flips too: the bubble starts
 * where the anchor starts, and where that runs off the far edge it ends where the
 * anchor ends instead, which is what keeps it beside the anchor in a corner. Last,
 * it is clamped inside the screen, which only moves it when neither alignment
 * fits -- and then it may cover the anchor, because covering the anchor beats
 * being cut off.
 *
 * @param anchor - The anchor's box.
 * @param size - The bubble's size.
 * @param screen - What it has to stay inside: the box `fixed` resolves against.
 * @param side - The side it goes on when there is room.
 * @returns Where its top-left corner goes, and the side it ended up on.
 */
export function placeTooltip(
  anchor: Box,
  size: { height: number; width: number },
  screen: Box,
  side: TooltipSide
): TooltipPlacement {
  const right = screen.x + screen.width;
  const bottom = screen.y + screen.height;
  const room: Record<TooltipSide, number> = {
    bottom: bottom - (anchor.y + anchor.height),
    left: anchor.x - screen.x,
    right: right - (anchor.x + anchor.width),
    top: anchor.y - screen.y,
  };
  const vertical = side === 'bottom' || side === 'top';
  const need = vertical ? size.height : size.width;

  let placed = side;
  const opposite = OPPOSITE[side];
  if (room[side] < need && (room[opposite] >= need || room[opposite] > room[side])) {
    placed = opposite;
  }

  let x: number;
  let y: number;
  if (vertical) {
    y = placed === 'bottom' ? anchor.y + anchor.height : anchor.y - size.height;
    x = anchor.x;
    if (x + size.width > right) {
      x = anchor.x + anchor.width - size.width;
    }
  } else {
    x = placed === 'right' ? anchor.x + anchor.width : anchor.x - size.width;
    y = anchor.y;
    if (y + size.height > bottom) {
      y = anchor.y + anchor.height - size.height;
    }
  }

  // the far edge first and the near one last, so a bubble wider than the screen
  // -- which the layout's own available width already prevents -- starts at its
  // left edge rather than off it
  x = Math.max(screen.x, Math.min(x, right - size.width));
  y = Math.max(screen.y, Math.min(y, bottom - size.height));
  return { side: placed, x, y };
}

/** The outermost ancestor, which is the root the layout places `fixed` against. */
function rootOf(element: Element): Element {
  let at = element;
  while (at.parent !== undefined) {
    at = at.parent;
  }
  return at;
}

/**
 * The part of an element anybody can see: its box cut to what clips it, or
 * `undefined` where nothing of it is left.
 *
 * Cut rather than whole, so a tall anchor half scrolled out of its box has its
 * bubble beside the half that is still there rather than beside the half that is
 * not. An element with no width or no height is in view where its edge is,
 * which is the one way a zero-area box can be anywhere.
 */
function inView(element: Element): Box | undefined {
  const at = element.box;
  const clip = element.clip;
  if (at === undefined || clip === undefined) {
    return at;
  }
  const x = Math.max(at.x, clip.x);
  const y = Math.max(at.y, clip.y);
  const width = Math.min(at.x + at.width, clip.x + clip.width) - x;
  const height = Math.min(at.y + at.height, clip.y + clip.height) - y;
  if (width < Math.min(1, at.width) || height < Math.min(1, at.height)) {
    return undefined;
  }
  return { height, width, x, y };
}

/** What a bubble's place was computed from: the anchor in view, its own size, and the screen. */
interface Placed {
  at: Box | undefined;
  height: number;
  screen: Box;
  width: number;
}

function sameBox(a: Box | undefined, b: Box | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height)
  );
}

function samePlaced(a: Placed, b: Placed): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    sameBox(a.at, b.at) &&
    sameBox(a.screen, b.screen)
  );
}

/**
 * Anchors a tooltip to an element.
 *
 * Shown after `delay` while the anchor is hovered -- which needs `mouse.motion`,
 * since without it nothing knows where the pointer is -- or while the focus is on
 * the anchor or inside it, which works with no mouse at all. Hidden the moment
 * neither is true. Escape hides it until both have left and one comes back.
 *
 * @param anchor - The element it describes. Its hooks are left alone.
 * @param opts - The router, the words, and where it goes.
 * @returns The handle.
 */
export function attachTooltip(anchor: Element, opts: TooltipOptions): TooltipHandle {
  refuseOwnedHooks('attachTooltip', opts?.props, ['onLayout']);
  if (typeof anchor?.contains !== 'function' || typeof anchor.setState !== 'function') {
    throw new TypeError(__`Expected a tooltip anchor to be an element`);
  }
  const input = opts?.input;
  if (typeof input?.bind !== 'function' || typeof input.onMouse !== 'function') {
    throw new TypeError(__`Expected a tooltip input to be a router`);
  }
  if (typeof opts.text !== 'string') {
    throw new TypeError(__`Expected tooltip text to be a string`);
  }
  const side = opts.side ?? 'bottom';
  if (!SIDES.includes(side)) {
    throw new TypeError(__`Expected a tooltip side to be top, bottom, left or right`);
  }
  const delay = opts.delay ?? DELAY;
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
    throw new TypeError(__`Expected a tooltip delay in milliseconds`);
  }
  const maxWidth = opts.maxWidth ?? MAX_WIDTH;
  if (!Number.isInteger(maxWidth) || maxWidth < 4) {
    throw new TypeError(__`Expected a tooltip maxWidth of at least 4 cells`);
  }
  // asked once now for the refusal it makes of a value that is not a boolean, and
  // again at every show for the answer, since `--quiet` is read after an app has
  // built its tree
  resolveOutput({ live: false, quiet: opts.quiet });

  const border = (opts.ascii ?? !unicodeSupported()) ? 'ascii' : 'round';
  let bubble: Element | undefined;
  let placedSide: TooltipSide | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Escape was pressed, and nothing has left since. */
  let dismissed = false;

  /** What the bubble says. One element for the tooltip's life, moved into each bubble. */
  const label = textNode(opts.text, { class: 'sigil-tooltip-text' });

  /** A fresh bubble, at the screen's corner until the layout has measured it. */
  function build(): Element {
    const element = box({
      ...opts.props,
      'border-style': border,
      'flex-direction': 'column',
      left: 0,
      'max-width': maxWidth,
      'padding-left': 1,
      'padding-right': 1,
      position: 'fixed',
      top: 0,
      'z-index': Z_INDEX,
    } satisfies ElementProps);
    // added rather than written into the props, so an app's own `class` is kept
    element.addClass('sigil-tooltip');

    // the modal's opaque fill: a box paints nothing in its empty cells, and a
    // background colour is dropped at level 0, so what is under the bubble would
    // show between its words for a user who asked for no colour
    element.append(
      raw(
        {
          measure: () => ({ height: 0, width: 0 }),
          paint: (painter, area, it) => {
            painter.fill(area.x, area.y, area.width, area.height, cellStyle(it.style));
          },
        },
        {
          bottom: 0,
          class: 'sigil-tooltip-fill',
          left: 0,
          position: 'absolute',
          right: 0,
          top: 0,
        }
      ),
      label
    );

    /** What this bubble was last placed against, so a layout that moved none of it moves nothing. */
    let against: Placed | undefined;
    /** It was sent to the corner by the last layout, to be measured with the whole width. */
    let measuring = false;

    // placed here rather than when it was built, because only the layout knows
    // how big it came out and where the anchor is -- and asked after **every**
    // layout, because the anchor moves for reasons nothing tells the tooltip: a
    // `ScrollBox` around it scrolled by a key or a wheel notch, a sibling that
    // wrapped, an animation. Each of those lays the tree out, so the frame that
    // moves the anchor moves the bubble before it paints. Following the anchor
    // never changes the bubble's size: the room a `fixed` box is offered is what
    // lies to the right of its `left`, and the placement never puts it where that
    // is less than its width
    element.onLayout = (it): boolean => {
      const root = rootOf(it);
      const screen = root.box;
      const size = it.box;
      if (screen === undefined || size === undefined) {
        return false;
      }
      // an anchor a window rebuild took out of the tree is not anywhere to point
      const at = rootOf(anchor) === root ? inView(anchor) : undefined;
      const now: Placed = { at, height: size.height, screen, width: size.width };
      if (against !== undefined && samePlaced(against, now)) {
        return false;
      }
      // but its own words growing, or the screen narrowing, can: what it is
      // offered where it stands may be less than it now wants, so the size it came
      // out at is a squeezed one. Sent back to the corner it started at, where a
      // fresh bubble is measured, and placed by the layout after -- which is the
      // size a bubble built with these words for this screen would have had
      //
      // its size alone is asked, and not the screen's: a narrower screen that
      // squeezes the bubble is a size that moved, and one that does not is a
      // screen the placement below already answers
      const resized =
        against !== undefined && (against.width !== now.width || against.height !== now.height);
      if (resized && !measuring && at !== undefined) {
        measuring = true;
        it.setProps({ left: 0, top: 0 });
        return true;
      }
      measuring = false;
      against = now;

      // scrolled out of whatever clips it: hidden rather than drawn pointing at
      // nothing, and kept in the tree, so the layout that brings the anchor back
      // brings the bubble back with it
      if (at === undefined) {
        placedSide = undefined;
        it.setProp('visibility', 'hidden');
        return true;
      }
      const place = placeTooltip(at, size, screen, side);
      placedSide = place.side;
      it.setProps({ left: place.x - screen.x, top: place.y - screen.y, visibility: undefined });
      return true;
    };
    return element;
  }

  function cancel(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function remove(): void {
    cancel();
    bubble?.remove();
    bubble = undefined;
    placedSide = undefined;
  }

  function show(): void {
    const root = rootOf(anchor);
    // an anchor with nowhere to put a bubble is one nothing is drawing
    if (bubble !== undefined || root === anchor) {
      return;
    }
    // chrome beside the content rather than the content: `resolveOutput()`'s
    // answer, asked now so that a `--quiet` read after construction is seen. `live`
    // cannot make the answer `quiet`, which is the only answer asked about here --
    // a bubble has no motion for `reduce` to take away
    if (resolveOutput({ live: false, quiet: opts.quiet }) === 'quiet') {
      return;
    }
    bubble = build();
    root.append(bubble);
  }

  /** Whether the pointer is over the anchor, or over the bubble it is reading. */
  function hovered(): boolean {
    return anchor.states.includes('hover') || (bubble?.states.includes('hover') ?? false);
  }

  /** Whether the keys go to the anchor or to something inside it. */
  function focused(): boolean {
    const at = input.focus.current.get();
    return at !== undefined && anchor.contains(at);
  }

  /** Brings the bubble in line with the two reasons for it. */
  function update(): void {
    if (!hovered() && !focused()) {
      dismissed = false;
      remove();
      return;
    }
    if (dismissed || bubble !== undefined || timer !== undefined) {
      return;
    }
    if (delay === 0) {
      show();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      // asked again, because a hover can end in a report nothing passed on
      if (hovered() || focused()) {
        show();
      }
    }, delay);
    // a tooltip is not a reason for the process to stay alive
    timer.unref?.();
  }

  function dismiss(): void {
    if (bubble !== undefined || timer !== undefined) {
      dismissed = true;
    }
    remove();
  }

  // every report the tree did not stop, as the cue to read the state again. The
  // state is the answer and the event only the reminder: an element that stops
  // its own `mouseleave` would otherwise strand a bubble, and the next motion
  // anywhere puts it right
  const offMouse = input.onMouse(() => {
    update();
  });

  // Escape is the dismissal, and it is never stopped: the tooltip holds no keys,
  // so an app's own Escape -- a dialog's, a pager's -- still has it
  const offKey = input.bind((event) => {
    if (event.key.name === 'escape') {
      dismiss();
    }
  });

  // a resize builds a fresh bubble rather than leaving the old one to follow: a
  // `fixed` box is offered the room to the right of its `left`, so the old one was
  // sized against a screen that is not there now, and a fresh one is measured from
  // the corner with the whole width before anything places it
  const offResize = input.onResize(() => {
    if (bubble !== undefined) {
      remove();
      show();
    }
  });

  const offFocus = createEffect(() => {
    input.focus.current.get();
    update();
  });

  function dispose(): void {
    remove();
    offMouse();
    offKey();
    offResize();
    offFocus();
  }

  // a tooltip attached inside a component goes when the component does, timer and
  // all; one attached outside any owner is the caller's to dispose
  onCleanup(dispose);

  return {
    dispose,
    get element() {
      return bubble;
    },
    hide: dismiss,
    setText(value: string): void {
      if (typeof value !== 'string') {
        throw new TypeError(__`Expected tooltip text to be a string`);
      }
      label.setText(value);
    },
    get shown() {
      return bubble !== undefined;
    },
    get side() {
      return placedSide;
    },
  };
}
