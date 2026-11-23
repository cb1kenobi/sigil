/**
 * A tooltip: a line of text anchored to an element, shown while the pointer is
 * over it or the keyboard is on it.
 *
 * ```js
 * import { attachTooltip } from '@ttylabs/sigil/components/tooltip';
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
 * focus. `area` points it at a rectangle inside the anchor rather than at the
 * whole of it, and moves it when that does: a tile of a treemap under the pointer.
 *
 * `AGENTS.md` records the keyboard answer, the flip, the following, and why
 * `--quiet` hides it.
 */

import {
  box,
  type Element,
  type ElementProps,
  type ElementPropsWithout,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter } from '../input/index.js';
import type { Box } from '../layout/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { untrack } from '../signals/index.js';
import { resolveOutput } from '../style/index.js';
import { unicodeSupported } from './note.js';
import { opaqueFill, rootOf } from './overlay.js';
import { refuseOwnedHooks } from './owned-hooks.js';

/** Which side of the anchor the bubble goes on. */
export type TooltipSide = 'bottom' | 'left' | 'right' | 'top';

export interface TooltipOptions {
  /**
   * The part of the anchor the bubble points at, when that is not the whole of
   * it: a rectangle in cells, relative to the anchor's top-left corner, or
   * `undefined` where there is nothing in the anchor to point at, which hides the
   * bubble while keeping it. Defaults to the whole anchor.
   *
   * Asked after every layout, as the anchor's own box is, and in an effect -- so a
   * signal it reads moves a shown bubble the moment it is set, with nothing laid
   * out. That is how a treemap points at the tile under the pointer, which moves
   * with no layout at all. While the pointer is on the bubble, an `undefined`
   * keeps it where it was: moving onto the bubble leaves the part it pointed at,
   * and the bubble is hoverable.
   */
  area?: () => Box | undefined;
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
  /**
   * A third reason to show the bubble, beside the pointer and the focus: shown
   * while it returns `true`, with neither. Asked in the effect that reads the
   * focus, so a signal it reads shows or hides the bubble the moment it is set.
   * `delay` still applies. While it returns `true`, Escape and `hide()` do nothing:
   * the app asked for the bubble to stay. That is how a line chart's pinned sample
   * keeps its readout once the focus has gone. Defaults to none.
   */
  hold?: () => boolean;
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
  /**
   * What it says. Wraps at `maxWidth`. An empty string says nothing, and a bubble
   * with nothing to say is hidden rather than drawn as an empty box, until
   * `setText()` gives it words again.
   */
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

/**
 * A box cut to another, or `undefined` where nothing of it is left. A box with
 * no width or no height is kept where its edge is inside the other, which is the
 * one way a zero-area box can be anywhere.
 */
function cut(at: Box, by: Box): Box | undefined {
  const x = Math.max(at.x, by.x);
  const y = Math.max(at.y, by.y);
  const width = Math.min(at.x + at.width, by.x + by.width) - x;
  const height = Math.min(at.y + at.height, by.y + by.height) - y;
  if (width < Math.min(1, at.width) || height < Math.min(1, at.height)) {
    return undefined;
  }
  return { height, width, x, y };
}

/**
 * The part of an element anybody can see, or of a rectangle inside it: its box
 * cut to what clips it, or `undefined` where nothing of it is left.
 *
 * Cut rather than whole, so a tall anchor half scrolled out of its box has its
 * bubble beside the half that is still there rather than beside the half that is
 * not. A part is relative to the element's box and is cut to that box first, so
 * a rectangle reaching past the anchor points at no more than the anchor.
 */
function inView(element: Element, part?: Box): Box | undefined {
  const whole = element.box;
  if (whole === undefined) {
    return undefined;
  }
  const at =
    part === undefined
      ? whole
      : cut(
          { height: part.height, width: part.width, x: whole.x + part.x, y: whole.y + part.y },
          whole
        );
  const clip = element.clip;
  return at === undefined || clip === undefined ? at : cut(at, clip);
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
  const area = opts.area;
  if (area !== undefined && typeof area !== 'function') {
    throw new TypeError(__`Expected a tooltip area to be a function`);
  }
  const hold = opts.hold;
  if (hold !== undefined && typeof hold !== 'function') {
    throw new TypeError(__`Expected a tooltip hold to be a function`);
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
  /** Places the shown bubble again, for an `area` that moved with nothing laid out. */
  let follow: (() => void) | undefined;
  /** Escape was pressed, and nothing has left since. */
  let dismissed = false;
  /** Whether the app held the bubble at the last `update()`, so a hold starting is seen. */
  let wasHolding = false;

  /** What the bubble says. One element for the tooltip's life, moved into each bubble. */
  const label = textNode(opts.text, { class: 'sigil-tooltip-text' });
  /** Whether it has anything to say, which an empty bubble does not. */
  let saying = opts.text !== '';

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
    element.append(opaqueFill('sigil-tooltip-fill'), label);

    /** What this bubble was last placed against, so a layout that moved none of it moves nothing. */
    let against: Placed | undefined;
    /** It was sent to the corner by the last layout, to be measured with the whole width. */
    let measuring = false;
    /** The `area` it last pointed at, kept while the pointer is on the bubble. */
    let pointed: Box | undefined;

    /** Where in the anchor it points, or `undefined` for nowhere. */
    const target = (it: Element): Box | undefined => {
      if (area === undefined) {
        return inView(anchor);
      }
      // untracked, since a layout may be run from inside something that tracks:
      // what the effect below follows is its own read
      let part = untrack(area);
      // moving onto the bubble leaves the part it pointed at, and keeping it
      // there is what lets the pointer reach it, as the whole anchor's does
      if (part === undefined && it.states.includes('hover')) {
        part = pointed;
      }
      // a copy, so an app that reuses one box and moves it cannot move what is kept
      pointed = part === undefined ? undefined : { ...part };
      return part === undefined ? undefined : inView(anchor, part);
    };

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
      // and one with nothing to say is hidden the way one pointing at nothing is:
      // an empty box beside the anchor says only that something is missing
      const at = rootOf(anchor) === root && saying ? target(it) : undefined;
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
    // asked between layouts too, by what follows `area`: the boxes are the last
    // layout's, which nothing has moved since. A corner pass is never waiting
    // here, because the layout it asks for is the same frame's next pass
    follow = () => {
      element.onLayout?.(element);
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
    follow = undefined;
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

  /** Whether the app asked for it to stay, with no pointer and no focus. */
  function held(): boolean {
    return hold?.() === true;
  }

  /** Brings the bubble in line with the three reasons for it. */
  function update(): void {
    // read first and always, so that the effect running this tracks it even when the
    // pointer or the focus is the reason it is running
    const holding = held();
    // a hold that starts is the app asking for the bubble now, so an Escape pressed
    // before it is not still in force: a pin made after an Escape would otherwise
    // keep `dismissed` set for as long as it stood, its readout never shown
    if (holding && !wasHolding) {
      dismissed = false;
    }
    wasHolding = holding;
    if (!hovered() && !focused() && !holding) {
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
      if (hovered() || focused() || held()) {
        show();
      }
    }, delay);
    // a tooltip is not a reason for the process to stay alive
    timer.unref?.();
  }

  function dismiss(): void {
    // a bubble the app holds is not Escape's: `dismissed` only clears when the
    // pointer, the focus and the hold have all gone, and a hold that outlasts
    // the others would leave Escape's effect permanent
    if (held()) {
      return;
    }
    if (bubble !== undefined || timer !== undefined) {
      dismissed = true;
    }
    remove();
  }

  // a part of the anchor that moved with nothing laid out -- the tile under the
  // pointer, on a map that stood still -- moves the bubble in the frame it is
  // set for, rather than at whatever lays the tree out next. First, since its
  // first run calls the app: a throw there leaves nothing subscribed behind it
  const offArea =
    area === undefined
      ? undefined
      : createEffect(() => {
          area();
          untrack(() => follow?.());
        });

  // every report the tree did not stop, as the cue to read the state again. The
  // state is the answer and the event only the reminder: an element that stops
  // its own `mouseleave` would otherwise strand a bubble, and the next motion
  // anywhere puts it right
  const offMouse = input.onMouse(() => {
    update();
    // and as the cue to ask `area` again: the pointer leaving the bubble ends what
    // kept an `area` of nothing pointing where it was, and nothing lays that out
    if (area !== undefined) {
      follow?.();
    }
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
    offArea?.();
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
      saying = value !== '';
    },
    get shown() {
      return bubble !== undefined;
    },
    get side() {
      return placedSide;
    },
  };
}
