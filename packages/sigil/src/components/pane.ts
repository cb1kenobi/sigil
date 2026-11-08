/**
 * A pane: a region whose size is a number of cells, with an edge that moves it.
 *
 * Put any number of them in any flex box. Each owns the one edge it can be resized
 * from, and there is no container to put them in:
 *
 * ```js
 * import { Pane, Panel } from '@ttylabs/sigil/components';
 * import { box } from '@ttylabs/sigil/element';
 *
 * box(
 *   { class: 'row' },
 *   Pane({ size: sidebarWidth, min: 16, collapsible: true }, Panel({ title: 'files' }, tree)),
 *   box({ class: 'main', 'flex-grow': 1 }, editor),
 *   Pane({ size: 30, min: 20, edge: 'start' }, Panel({ title: 'log' }, log))
 * );
 * ```
 *
 * `size` is cells along the parent's main axis -- a width in a row, a height in a
 * column -- and is a number or a `State<number>`. A state is how an app keeps the
 * size between runs: a drag writes to it. The edge is one cell laid over the pane's
 * own last column (`edge: 'end'`, the default) or first (`'start'`), and takes no
 * space. Over a `Panel` it sits on the panel's border. A drag moves cells between
 * the pane and the neighbour on that side: another pane gives or takes them, and a
 * plain flex box absorbs the difference.
 *
 * Click the edge to focus it, then the arrows move it a cell and Shift with an arrow
 * five. It is not in the Tab order. Double-clicking it, or Enter or Space on it,
 * collapses a `collapsible` pane to nothing and opens it again; the edge stays so
 * that it can be dragged back open. {@link paneControl} hands an app the same moves
 * to bind its own keys to.
 */

import {
  box,
  cellStyle,
  type Element,
  type ElementProps,
  raw,
  type RawPaint,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { KeyEvent, MouseEvent } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { unicodeSupported } from './note.js';

/** Which end of the pane the edge is on. */
export type PaneEdge = 'end' | 'start';

export interface PaneProps {
  /**
   * Draw the edge with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule the rest of the components keep.
   */
  ascii?: boolean;
  /** The content, for a template, which passes it here rather than as arguments. */
  children?: Element | readonly Element[];
  /** Extra classes for the pane, beside `sigil-pane`. */
  class?: string;
  /**
   * Whether the pane is collapsed to nothing.
   *
   * A boolean is where it starts. A `State<boolean>` is the state itself, so an
   * app can keep it, and one that writes it collapses and opens the pane. Only
   * meaningful for a `collapsible` pane.
   */
  collapsed?: boolean | State<boolean>;
  /**
   * Whether the pane may be collapsed to zero cells: by a drag below half of
   * `min`, by double-clicking the edge, or by `collapse()`.
   */
  collapsible?: boolean;
  /** Which end of the pane the edge is on. Defaults to `end`. */
  edge?: PaneEdge;
  /** The most cells the pane may take. Defaults to no limit. */
  max?: number;
  /** The fewest cells the pane may take, short of collapsed. Defaults to 1. */
  min?: number;
  /** The pane's own props. They win over the defaults. */
  props?: ElementProps;
  /**
   * How many cells the pane takes along the parent's main axis.
   *
   * It is clamped to `min` and `max` wherever it is read, so a state an app wrote
   * out of range draws in range. It is not clamped in the state: the state is the
   * app's, and a terminal that is wide again should find the pane as it was left.
   */
  size: number | State<number>;
}

/** What an app holds a pane by: the numbers behind it, and the moves a drag makes. */
export interface PaneControl {
  /**
   * Collapses the pane to zero cells, and hands them to its neighbour.
   *
   * Nothing for a pane that is not `collapsible`. Its `size` is kept, so
   * {@link PaneControl.expand} opens it as it was.
   */
  collapse(): void;
  /** Whether the pane is collapsed. */
  readonly collapsed: State<boolean>;
  /** The edge element: what is focused, and what a drag is on. */
  readonly edge: Element;
  /** Opens a collapsed pane to the size it had. */
  expand(): void;
  /**
   * Moves the edge so the pane takes `size` cells, in the way a drag would.
   *
   * The same clamping as a drag: the pane's `min` and `max`, and the limits of its
   * neighbour. A collapsible pane asked for fewer than half its `min` collapses.
   *
   * @param size - The cells to ask for.
   * @returns The cells it took, which is `0` for a collapsed pane.
   */
  resize(size: number): number;
  /** The size the pane returns to when it is not collapsed. */
  readonly size: State<number>;
  /** Collapses an open pane and opens a collapsed one. */
  toggle(): void;
}

/** What a neighbour is asked, and what a pane keeps to answer it. */
interface Model {
  collapsed(): boolean;
  readonly control: PaneControl;
  effective(): number;
  readonly max: number;
  readonly min: number;
}

/** Each pane's model, keyed by the host `Pane()` returned. */
const models = new WeakMap<Element, Model>();

/**
 * The control of a pane.
 *
 * Reached by the host rather than returned beside it, which is how `scrollControl()`
 * and `tabsActive()` hand out what a component holds: a template interpolates the
 * element and has nowhere to put a second return value.
 *
 * @param host - What `Pane()` returned.
 * @returns The control, or `undefined` for an element no pane built.
 */
export function paneControl(host: Element): PaneControl | undefined {
  return models.get(host)?.control;
}

/**
 * Two clicks on the edge this close together are one double-click, in milliseconds.
 *
 * The input router reports a click and has no count, so a double-click is two of
 * them that this decides.
 */
const DOUBLE_CLICK_MS = 400;

/** The cells an arrow moves the edge, and Shift with it. */
const STEP = 1;
const BIG_STEP = 5;

/** What the edge draws: lit, and at rest where a collapsed pane leaves it showing. */
const GLYPHS = {
  ascii: { column: { hot: '-', rest: '-' }, row: { hot: '|', rest: '|' } },
  unicode: { column: { hot: '━', rest: '─' }, row: { hot: '┃', rest: '│' } },
} as const;

/** A raw element's measure when it takes no room of its own. */
function noSize(): { height: number; width: number } {
  return { height: 0, width: 0 };
}

/** Whether a number is a whole count of cells, which is what a size is. */
function cells(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Which way the parent lays its children out. */
function axisOf(host: Element): 'column' | 'row' {
  const direction = host.parent?.style.flexDirection;
  return direction === 'column' || direction === 'column-reverse' ? 'column' : 'row';
}

/** The main-axis extent of a placed element, or nothing if it has not been placed. */
function extentOf(element: Element, axis: 'column' | 'row'): number {
  return axis === 'row' ? (element.box?.width ?? 0) : (element.box?.height ?? 0);
}

/** Whether a sibling takes part in the flow the pane's edge is a boundary of. */
function inFlow(element: Element): boolean {
  const { display, position } = element.style;
  return display !== 'none' && position !== 'absolute' && position !== 'fixed';
}

/**
 * The edge's place on the pane, which is the one cell at its end or start.
 *
 * A collapsed pane has no cell of its own to put it in, and the cell its own side
 * names would be off the screen for a pane at the screen's edge -- an `end` edge
 * on a pane at the left is column -1. So it takes the other inset and lands on the
 * neighbour's cell beside the boundary, which is where it stays reachable.
 */
function edgeProps(axis: 'column' | 'row', side: PaneEdge, shut: boolean): ElementProps {
  const at = shut ? (side === 'end' ? 'start' : 'end') : side;

  return axis === 'row'
    ? {
        bottom: 0,
        height: undefined,
        left: at === 'start' ? 0 : undefined,
        right: at === 'end' ? 0 : undefined,
        top: 0,
        width: 1,
      }
    : {
        bottom: at === 'end' ? 0 : undefined,
        height: 1,
        left: 0,
        right: 0,
        top: at === 'start' ? 0 : undefined,
        width: undefined,
      };
}

/** Where a drag started: what the pane and its neighbour were, and how far each may go. */
interface Anchor {
  /** The most cells the pane may gain, which is what its neighbour has to give. */
  grow: number;
  /** The neighbour, if it is a pane that is open. */
  neighbour: Model | undefined;
  neighbourStart: number;
  /** The most cells the pane may lose, which is what its neighbour can take. */
  shrink: number;
  start: number;
}

/**
 * Builds a pane.
 *
 * @param props - The size, its limits, the edge, and the host's own props.
 * @param children - What goes inside.
 * @returns The host. Its {@link PaneControl} is `paneControl(host)`.
 */
export function Pane(props: PaneProps, ...children: Element[]): Element {
  if (!cells(props?.size) && !(props?.size instanceof State)) {
    throw new TypeError(__`Expected pane size to be a number of cells or a State`);
  }
  for (const name of ['max', 'min'] as const) {
    if (props[name] !== undefined && !cells(props[name])) {
      throw new TypeError(__`Expected pane ${name} to be a number of cells`);
    }
  }
  if (props.edge !== undefined && props.edge !== 'end' && props.edge !== 'start') {
    throw new TypeError(__`Expected pane edge to be end or start`);
  }
  if (
    props.collapsed !== undefined &&
    typeof props.collapsed !== 'boolean' &&
    !(props.collapsed instanceof State)
  ) {
    throw new TypeError(__`Expected pane collapsed to be a boolean or a State`);
  }

  const min = Math.floor(props.min ?? 1);
  const max = props.max === undefined ? Number.POSITIVE_INFINITY : Math.floor(props.max);
  if (max < min) {
    throw new RangeError(__`Expected pane max to be at least min`);
  }
  const side: PaneEdge = props.edge ?? 'end';
  const collapsible = props.collapsible ?? false;

  const size = props.size instanceof State ? props.size : new State(props.size);
  const collapsed =
    props.collapsed instanceof State ? props.collapsed : new State(props.collapsed ?? false);

  const clampSize = (value: number): number =>
    Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
  /** The cells the pane is asked to take: nothing if collapsed, else its size in range. */
  const effective = (): number => (collapsible && collapsed.get() ? 0 : clampSize(size.get()));

  // -- the edge ---------------------------------------------------------------
  const glyphs = (props.ascii ?? !unicodeSupported()) ? GLYPHS.ascii : GLYPHS.unicode;
  let axis: 'column' | 'row' = 'row';
  let hover = false;
  let focused = false;
  /** The press the pointer is held on. */
  let drag: { anchor: Anchor; from: number; moved: boolean } | undefined;
  /** Whether the click a drag ends in is not one, because the edge was moved. */
  let dragged = false;
  let lastClick = Number.NEGATIVE_INFINITY;

  const isCollapsed = (): boolean => collapsible && collapsed.get();
  const lit = (): boolean => hover || focused || drag !== undefined;

  const paint: RawPaint = (painter, area, element) => {
    const on = lit();
    // at rest the border or the content underneath is what shows, unless the pane
    // is collapsed and there is nothing underneath to say it is here
    if (!on && !isCollapsed()) {
      return;
    }
    const style = cellStyle(element.style);
    const glyph = glyphs[axis][on ? 'hot' : 'rest'];
    const run = axis === 'row' ? area.height : area.width;
    for (let i = 0; i < run; i++) {
      painter.text(
        axis === 'row' ? area.x : area.x + i,
        axis === 'row' ? area.y + i : area.y,
        glyph,
        style
      );
    }
  };

  const edge = raw(
    { measure: noSize, paint },
    {
      class: 'sigil-pane-edge',
      position: 'absolute',
      // focusable by a click and by `focus()`, and out of the ring a Tab walks: the
      // edge is a pointer's handle with a keyboard fallback, not a stop in the form
      tabindex: -1,
      ...edgeProps(axis, side, isCollapsed()),
    }
  );

  /** Puts the edge's look right for what it is doing. */
  const sync = (): void => {
    edge.toggleClass('sigil-accent', lit());
    edge.toggleClass('sigil-muted', !lit() && isCollapsed());
    edge.toggleClass('is-collapsed', isCollapsed());
    edge.invalidatePaint();
  };

  // -- the pane ---------------------------------------------------------------
  const body = box(
    {
      class: 'sigil-pane-body',
      'flex-direction': 'column',
      'flex-grow': 1,
      'min-height': 0,
      'min-width': 0,
      overflow: 'hidden',
    },
    ...(props.children === undefined
      ? []
      : Array.isArray(props.children)
        ? props.children
        : [props.children as Element]),
    ...children
  );

  const host = box(
    {
      // the size, on whichever axis the parent runs along: a basis is the main
      // size, so the pane never has to know which that is to be the right size
      'flex-basis': effective(),
      'flex-direction': 'column',
      'flex-grow': 0,
      'flex-shrink': 0,
      // its size is the one it was given, however much its content would like
      'min-height': 0,
      'min-width': 0,
      position: 'relative',
      ...props.props,
    },
    body,
    edge
  );
  host.addClass('sigil-pane');
  for (const name of String(props.class ?? '')
    .split(/\s+/)
    .filter(Boolean)) {
    host.addClass(name);
  }

  /** What the layout last said the parent has room for, so a pane never asks for more. */
  let room: number | undefined;
  let basis = effective();
  const applyBasis = (): boolean => {
    const next = Math.min(effective(), room ?? Number.POSITIVE_INFINITY);
    if (next === basis) {
      return false;
    }
    basis = next;
    host.setProp('flex-basis', next);
    return true;
  };

  createEffect(() => {
    // read here so the effect depends on all three
    const shut = isCollapsed();
    size.get();
    applyBasis();
    body.setProp('display', shut ? 'none' : undefined);
    // a collapsed pane's edge is over its neighbour's cell, and the neighbour
    // after it in the tree would be painted over it
    host.setProp('z-index', shut ? 1 : undefined);
    edge.setProps(edgeProps(axis, side, shut));
    sync();
  });

  host.onLayout = (): boolean => {
    let changed = false;
    const next = axisOf(host);
    if (next !== axis) {
      axis = next;
      edge.setProps(edgeProps(axis, side, isCollapsed()));
      edge.invalidatePaint();
      changed = true;
    }
    const parent = host.parent?.content;
    const available =
      parent === undefined ? undefined : axis === 'row' ? parent.width : parent.height;
    if (available !== room) {
      room = available;
      changed = applyBasis() || changed;
    }
    return changed;
  };

  // -- moving the edge --------------------------------------------------------
  /** Looks up what is on the other side of the edge, and what each may give. */
  const begin = (): Anchor => {
    // what the layout will give, worked out from the state rather than read off
    // a box the last frame placed: a key pressed twice between two frames moves
    // from where the first one left it
    const here = Math.min(effective(), room ?? Number.POSITIVE_INFINITY);
    const siblings = host.parent?.children.filter((it) => it === host || inFlow(it)) ?? [host];
    const beside = siblings[siblings.indexOf(host) + (side === 'end' ? 1 : -1)];
    const model = beside === undefined ? undefined : models.get(beside);

    if (beside === undefined) {
      return {
        grow: Number.POSITIVE_INFINITY,
        neighbour: undefined,
        neighbourStart: 0,
        shrink: Number.POSITIVE_INFINITY,
        start: here,
      };
    }
    if (model === undefined) {
      // a plain box takes up the difference through its own flex-grow, and can give
      // up all it has
      return {
        grow: extentOf(beside, axis),
        neighbour: undefined,
        neighbourStart: 0,
        shrink: Number.POSITIVE_INFINITY,
        start: here,
      };
    }
    if (model.collapsed()) {
      // nothing to give, and what it is given is not its to keep: it stays shut
      return {
        grow: 0,
        neighbour: undefined,
        neighbourStart: 0,
        shrink: Number.POSITIVE_INFINITY,
        start: here,
      };
    }
    const there = model.effective();
    return {
      grow: Math.max(0, there - model.min),
      neighbour: model,
      neighbourStart: there,
      shrink: Math.max(0, model.max - there),
      start: here,
    };
  };

  /** Takes the pane to `want` cells as far as everything involved allows. */
  const moveTo = (anchor: Anchor, want: number): number => {
    const low = Math.max(min, anchor.start - anchor.shrink);
    const high = Math.min(max, anchor.start + anchor.grow);
    let target = low > high ? anchor.start : Math.min(high, Math.max(low, Math.round(want)));

    // below half of its minimum a collapsible pane is not a small pane but a
    // closed one, as a sash in an editor snaps. Only where its neighbour can take
    // all of it
    const closing = collapsible && want < min / 2 && anchor.start <= anchor.shrink;
    if (closing) {
      target = 0;
    }

    if (closing || (anchor.start === 0 && target === 0)) {
      if (collapsible) {
        collapsed.set(true);
      }
    } else {
      if (collapsible) {
        collapsed.set(false);
      }
      size.set(target);
    }
    anchor.neighbour?.control.size.set(anchor.neighbourStart - (target - anchor.start));
    return target;
  };

  const control: PaneControl = Object.freeze({
    collapse(): void {
      if (collapsible && !collapsed.get()) {
        moveTo(begin(), 0);
      }
    },
    collapsed,
    edge,
    expand(): void {
      if (collapsible && collapsed.get()) {
        moveTo(begin(), clampSize(size.get()));
      }
    },
    resize(value: number): number {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new TypeError(__`Expected a pane size to be a number of cells`);
      }
      return moveTo(begin(), value);
    },
    size,
    toggle(): void {
      if (collapsed.get()) {
        control.expand();
      } else {
        control.collapse();
      }
    },
  });
  models.set(host, {
    collapsed: isCollapsed,
    control,
    effective,
    max,
    min,
  });

  // -- the mouse and the keys -------------------------------------------------
  const along = (event: MouseEvent): number => (axis === 'row' ? event.x : event.y);

  edge.onMouse = (event: MouseEvent): void => {
    switch (event.kind) {
      case 'mouseenter': {
        hover = true;
        sync();
        return;
      }
      case 'mouseleave': {
        hover = false;
        sync();
        return;
      }
      case 'mousedown': {
        if (event.button === 'left') {
          // the focus is not stopped: a press focuses the edge, which is what puts
          // the arrow keys on it
          drag = { anchor: begin(), from: along(event), moved: false };
          dragged = false;
          sync();
        }
        return;
      }
      case 'mousemove': {
        if (drag === undefined) {
          return;
        }
        // moving the pointer towards the pane's far side shrinks it, whichever side
        // the edge is on
        const delta = (along(event) - drag.from) * (side === 'end' ? 1 : -1);
        if (delta !== 0) {
          drag.moved = true;
        }
        moveTo(drag.anchor, drag.anchor.start + delta);
        return;
      }
      case 'mouseup': {
        if (drag !== undefined && event.button === 'left') {
          // a click that ends a drag is not a click on anything: the edge moved
          // under the pointer and came back to it
          dragged = drag.moved;
          drag = undefined;
          sync();
        }
        return;
      }
      case 'click': {
        if (event.button !== 'left') {
          return;
        }
        if (dragged) {
          dragged = false;
          return;
        }
        const now = Date.now();
        if (now - lastClick <= DOUBLE_CLICK_MS) {
          lastClick = Number.NEGATIVE_INFINITY;
          control.toggle();
        } else {
          lastClick = now;
        }
        return;
      }
      default: {
        return;
      }
    }
  };

  edge.onFocusChange = (_, on): void => {
    focused = on;
    sync();
  };

  edge.onKey = (event: KeyEvent): void => {
    const { ctrl, meta, name, shift } = event.key;
    if (ctrl || meta) {
      return;
    }
    if ((name === 'enter' || name === 'space') && collapsible) {
      control.toggle();
      event.stop();
      return;
    }

    // an arrow along the pane's axis moves the edge that way; the other two are
    // for whatever is around it
    const step = (shift ? BIG_STEP : STEP) * (side === 'end' ? 1 : -1);
    const by =
      axis === 'row'
        ? name === 'left'
          ? -step
          : name === 'right'
            ? step
            : 0
        : name === 'up'
          ? -step
          : name === 'down'
            ? step
            : 0;
    if (by === 0) {
      return;
    }

    event.stop();
    if (isCollapsed() && by > 0) {
      control.expand();
      return;
    }
    const anchor = begin();
    moveTo(anchor, anchor.start + by);
  };

  return host;
}
