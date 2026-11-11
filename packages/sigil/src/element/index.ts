/**
 * The element tree: the thing selectors match against, layout measures, paint
 * walks, and input will dispatch through.
 *
 * Not a DOM. A purpose-built tree carrying only what the layers above actually
 * ask of it, which is why an element satisfies `StyleTarget` and `LayoutNode`
 * rather than the other way round -- those two interfaces were written to be
 * satisfiable by a literal in a test, and this is the other implementation of
 * them.
 *
 * ```js
 * import { box, text, createTree } from '@ttylabs/sigil/element';
 *
 * const root = box({ class: 'panel' }, text('hello'));
 * const tree = createTree(root);
 *
 * root.append(text('world'));
 * tree.marks.children.has(root); // true -- and nothing else was marked
 * ```
 *
 * ## Three host types
 *
 * `box` lays its children out, `text` measures a string, and `raw` paints cells
 * itself. Everything else is a component that resolves to these, which is what
 * keeps the layout engine small and matches what a terminal can actually draw.
 *
 * `raw` is the deliberate trapdoor the ticket asked for: a sparkline, an image,
 * anything the layout engine cannot express. It measures like a text and paints
 * like nothing else. Designed in rather than discovered later, because the
 * alternative is somebody reaching for the canvas behind the tree's back and the
 * tree then being wrong about what is on screen.
 *
 * ## What is deliberately not here
 *
 * **No fragment.** A component produces exactly one node. A transparent node
 * would have to be transparent to layout, to `:nth-child()`, and to paint order,
 * which is three different definitions of "not there" and the sort of thing
 * found to be wrong in the third one months later. If the renderer cannot live
 * without it, it can add it knowing what it costs.
 *
 * **No reconciliation.** `key` is read and kept, and matching on it is the
 * renderer's. It is here now because a keyed list diff needs stable identity
 * across renders and retrofitting keys is worse than carrying an unused prop.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import type { Painter } from '../canvas/index.js';
import type { KeyHandler, MouseHandler, PasteHandler } from '../input/index.js';
import type { Box, LayoutNode, Measurement } from '../layout/index.js';
import type { PropValues, Style, StyleState } from '../style/index.js';
import { declare } from '../style/index.js';
import { maxOf, stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';
import { announceFocus, checkFocusWrite } from './focus.js';

/** The host types. Everything above resolves to these three. */
export type ElementType = 'box' | 'raw' | 'text';

/** What a `raw` element does with the cells it was given. */
export type RawPaint = (painter: RawPainter, box: Box, element: Element) => void;

/**
 * What an element does when its scroll offset moved.
 *
 * One function rather than a list, for the reason `onKey` is one. Handed the
 * element it was called about, so that one handler can answer for several
 * viewports without a closure per viewport.
 */
export type ScrollHandler = (viewport: Element) => void;

/**
 * What an element does when it gains or loses the focus.
 *
 * One function rather than a list, for the reason `onKey` is one, and handed the
 * element for the reason `ScrollHandler` is. `focused` says which way it went,
 * so one handler answers for both rather than a pair that must be kept in step.
 */
export type FocusChangeHandler = (element: Element, focused: boolean) => void;

/**
 * What an element does when the layout gave it a size it had not been told about.
 *
 * One function rather than a list, for the reason `onKey` is one, and handed the
 * element for the reason `ScrollHandler` is.
 *
 * It **returns whether it changed the tree**, which is the rule `hideCursor()`
 * and `setRawMode()` already keep: a caller that owes a second pass has one
 * question to ask, and the handler is the only thing that can answer it. `false`
 * is what a handler that found nothing to do says, and it is what keeps a frame
 * over a tree nobody resized at exactly one layout.
 */
export type ResizeHandler = (element: Element) => boolean;

/**
 * What an element does after a layout that reached it.
 *
 * `ResizeHandler`'s shape and its rule: it returns whether it changed the tree,
 * and `false` is what keeps a frame at one layout.
 */
export type LayoutHandler = (element: Element) => boolean;

/**
 * What a `raw` element is handed to paint with.
 *
 * A type-only import of the canvas's `Painter`: precise about what arrives,
 * without the tree taking a runtime dependency on the cell grid it is supposed
 * to be testable without.
 */
export type RawPainter = Painter;

export interface RawOptions {
  /**
   * Whether the cells this paints are text, which decides what `selectable`
   * defaults to.
   *
   * A `raw` is not selectable unless something says so, because the two in this
   * library are a sparkline and a half-block image: a wall of block characters
   * nobody wants in their clipboard, which is the whole reason the prop exists.
   * A `raw` that paints *characters somebody is reading* is the other kind, and
   * it wants exactly what a `text` gets -- so this says which it is, once, where
   * the element is built.
   *
   * It changes the **default** rather than the answer, which is what keeps the
   * loss it closes closed: a `selectable={false}` on a pane reaches such a raw
   * again, the way it reaches the texts inside it, and an explicit `selectable`
   * on the element still beats both. Written here rather than as a third prop
   * value because it is a property of what the painter draws rather than of what
   * a caller or a sheet wants -- a raw that forgot to say it in its props would
   * be silently uncopyable, and a raw cannot forget what it is.
   */
  drawsText?: boolean;
  /** What this element's content would take, measured like a text's. */
  measure: (availableWidth: number) => Measurement;
  /** Paints it, given the box the layout gave it. */
  paint: RawPaint;
}

/**
 * Everything an element records for the layers above, in one place so that a
 * frame can drain it and know what to do.
 *
 * These are the four questions the style invalidator asks, plus the two the
 * layout and paint passes ask, and nothing else: the tree records *what
 * changed*, and what that implies is `Restyler`'s. Keeping the two apart is what
 * lets either be tested without the other.
 */
export interface Marks {
  /** Elements whose class, id or state changed: a re-match of the subtree and its siblings. */
  classes: Set<Element>;
  /** Elements whose children changed, which `:nth-child()` and `+` can see. */
  children: Set<Element>;
  /** Elements whose intrinsic size changed: a text edited, a `raw` re-measured. */
  layout: Set<Element>;
  /** Elements whose cells changed with no other consequence. */
  paint: Set<Element>;
  /** Elements whose style props were written, which skips selector matching. */
  props: Set<Element>;
  /**
   * Elements taken out of a parent, so that a restyler can forget them.
   *
   * The fifth question, and the one that is asked about an element that is no
   * longer here: everything else names something still in the tree. `Restyler`
   * keys its caches by element identity, so without this an unmounted subtree
   * stays reachable for the life of it -- which in a long-running TUI that
   * shows and hides a panel is a leak with nothing to point at. An element that
   * was moved rather than removed is in here too, because a move is a removal
   * and an insertion; the reader is expected to check whether it ended the frame
   * attached, which is what tells the two apart.
   */
  removed: Set<Element>;
}

function emptyMarks(): Marks {
  return {
    children: new Set(),
    classes: new Set(),
    layout: new Set(),
    paint: new Set(),
    props: new Set(),
    removed: new Set(),
  };
}

export interface Tree {
  /** What has changed since the last `take()`. */
  readonly marks: Readonly<Marks>;
  readonly root: Element;
  /**
   * Drains the marks, which is what a frame does before it settles them.
   *
   * Drained rather than read and cleared by the caller, so that a mutation made
   * *while* a frame is settling lands in the next set rather than in the one
   * being walked.
   *
   * @returns What had changed.
   */
  take(): Marks;
}

/**
 * The seven hooks an element carries, which are props as well as properties.
 *
 * Written out, and it is the one list the handler props hang off: every name is
 * a field of `Element`, so the *types* below are read off the class and cannot
 * disagree with it, and a hook the class gains is one line here and one in
 * `ReservedProps`. Pinned from three sides: `test/element/handlers.test.ts` reads
 * the class's own `on*` fields and fails for a hook this list lacks,
 * `test/template/jsx-types.tsx` fails for a hook `HostProps` has no prop for, and
 * `test/template/props.test.ts` asserts that every name `ReservedProps` carries is
 * one `setProp()` routes to `#apply()`.
 */
export const HANDLER_PROPS: readonly [
  'onKey',
  'onMouse',
  'onPaste',
  'onFocusChange',
  'onScroll',
  'onResize',
  'onLayout',
] = Object.freeze([
  'onKey',
  'onMouse',
  'onPaste',
  'onFocusChange',
  'onScroll',
  'onResize',
  'onLayout',
] as const);

/** The name of one of the seven hooks. */
export type HandlerProp = (typeof HANDLER_PROPS)[number];

/** The hooks as an element is built with them, each typed by the field it sets. */
export type HandlerProps = { [K in HandlerProp]?: Element[K] };

/** What any one of the seven may be set to: a function, or nothing to clear it. */
export type HandlerValue = Element[HandlerProp];

const HANDLERS: ReadonlySet<string> = new Set(HANDLER_PROPS);

/**
 * Whether a prop name is one of the seven hooks.
 *
 * Exported because a template has to ask the same question before it decides a
 * function is a thunk: the list is `HANDLER_PROPS` and nowhere else.
 *
 * @param name - The prop.
 * @returns True for `onKey` and the other six.
 */
export function isHandlerProp(name: string): name is HandlerProp {
  return HANDLERS.has(name);
}

/**
 * The prop names that are not style properties.
 *
 * Reserved rather than carried in a bag of their own, because every one of them
 * is a question the layers above ask of every element: what selectors match it,
 * what the renderer reconciles it by, and whether input can land on it. A prop
 * this list does not name is a style property and is handed to the cascade,
 * which refuses one it does not know -- so a typo is an error rather than a
 * value nothing reads. The seven hooks are on it for the same reason from the
 * other side: the input router and the frame read them off every element, and
 * `box({ onKey })` and a template's `onKey=${fn}` are one path through here.
 */
const RESERVED = new Set([
  'class',
  'focusable',
  'id',
  'key',
  'selectable',
  'tabindex',
  ...HANDLER_PROPS,
]);

export type PropValue = boolean | number | string | undefined;

/**
 * Element props without some of the hooks, for a component that owns them.
 *
 * `Omit<ElementProps, 'onKey'>` would not do it: the index signature already
 * admits a hook, so omitting the key leaves `{ onKey: fn }` legal. This pins the
 * named hooks to `undefined` instead, which an optional prop passed along still
 * satisfies and a handler does not. `components/owned-hooks.ts` is the run-time
 * half, for a caller the type does not reach.
 */
export type ElementPropsWithout<K extends HandlerProp> = ElementProps & { [P in K]?: undefined };

/** What an element is built with: style props, plus the reserved names. */
export interface ElementProps extends HandlerProps {
  [name: string]: HandlerValue | PropValue | readonly string[];
  class?: string | readonly string[];
  /**
   * Whether the element can hold the focus, and a Tab stops here. A `tabindex`
   * implies it; a negative one keeps it focusable and takes it out of the ring.
   */
  focusable?: boolean;
  /**
   * Where a `text` links to, as an OSC 8 hyperlink over the cells it draws.
   *
   * Content rather than style, which is why it is a reserved name and not a
   * property: a URL is not something a theme restyles. Read by a `text` alone and
   * not inherited -- the cells a link covers are the cells its words draw, so a
   * box has none of its own to give one. Whether the destination draws a link at
   * all is the caller's question, `supportsHyperlinks()` answers it, and a string
   * rendered at colour level 0 leaves the sequence out with the colour. A URL
   * holding a control character is refused here, where it was given, rather than
   * at paint, where the canvas would refuse it a frame later and far away.
   */
  href?: string;
  id?: string;
  key?: number | string;
  /**
   * Whether this element's content may be selected and copied.
   *
   * Inherited down the subtree, which is what makes `selectable={false}` on a
   * pane mean the pane. `text` defaults to true and `raw` to false, so a
   * sparkline or an image does not copy as a wall of block characters -- and an
   * explicit value wins for the element and everything under it, which is how a
   * `raw` that really does draw characters opts back in.
   */
  selectable?: boolean;
  /**
   * Where in the ring, for an element that should not be in document order.
   *
   * Below zero the element is focusable -- a press lands on it, and `focus()` can
   * -- and not in the ring a Tab walks, which then carries on from where it sits.
   */
  tabindex?: number;
}

/**
 * A node in the element tree.
 *
 * Satisfies `StyleTarget` -- so the cascade and the invalidator can read it --
 * and `LayoutNode`, so the layout engine can measure and place it. Those are two
 * interfaces written for literals in tests, and this is the other thing that
 * implements them.
 */
/**
 * A text wrapped at one width: the lines, each line's display width, and the
 * measurement they add up to.
 *
 * One object because the three are one answer. Paint and layout both ask what a
 * text comes to at a width, and when each worked it out for itself they each
 * tokenized the string into grapheme clusters to do it.
 */
export interface WrappedText {
  /** The lines, already wrapped at the width this was asked for. */
  readonly lines: readonly string[];
  /** What the lines come to, which is what the layout engine reads. */
  readonly measurement: Measurement;
  /** Each line's display width, measured where the line was made. */
  readonly widths: readonly number[];
}

/**
 * The cache key a `pre` or `nowrap` text is held under, which no real width can
 * be.
 *
 * Such a text is one line per newline whatever width it is offered, so a key per
 * width would be many entries holding one answer -- and layout and paint asking
 * about different widths would each miss the other's.
 */
const UNWRAPPED = -1;

/** The narrowest a wrapping text can be squeezed to: its longest word. */
function longestWord(content: string): number {
  let longest = 0;
  for (const word of content.split(/\s+/)) {
    if (word !== '') {
      longest = Math.max(longest, stringWidth(word));
    }
  }
  return longest;
}

export class Element implements LayoutNode {
  readonly type: ElementType;

  /**
   * The resolved style, which the cascade writes and layout and paint read.
   *
   * Starts at the initial style rather than `undefined`, so that a tree can be
   * laid out before anything has resolved one -- a test, or a frame whose
   * stylesheet has not arrived. `LayoutNode` requires it, which is the same
   * question asked by the layer below.
   */
  style: Style;

  /**
   * The colour depth `style` was resolved at, which a `raw` painting colours of
   * its own has to degrade them to.
   *
   * Degradation happens at resolve time, so every colour a stylesheet or a prop
   * names is already one the destination can emit by the time paint reads it --
   * and a `raw` is the one thing that paints colours nobody declared. An image is
   * thousands of them, worked out from the box layout gave it, so they cannot be
   * degraded before paint; what paint needs is the depth the rest of the tree was
   * degraded to, and the result the cascade resolved carries exactly that. It is
   * written beside `style` by the same walk, so the two cannot describe
   * different frames, and asking anything else -- `ansi.level`, a component's own
   * option -- is a second answer that disagrees with the frame on the terminals a
   * refined level exists for.
   *
   * Truecolor until something resolves a style, which is what `renderToString()`
   * assumes when nobody names a level, and what an unresolved tree's initial style
   * already means: nothing degraded.
   */
  colorLevel: ColorLevel = 3;

  /** Where the arrange pass put this element, if it has run. */
  box: Box | undefined;

  /**
   * What this element's content would take at a given width.
   *
   * Present on `text` and `raw` and absent on `box`, which is exactly what
   * `measureUncached()` reads to decide whether a node measures its own content
   * or lays its children out.
   */
  measure: ((availableWidth: number) => Measurement) | undefined;

  /** The area inside padding and border, which is where children were placed. */
  content: Box | undefined;

  /**
   * The rectangle this element's own drawing lands inside, if anything clips it.
   *
   * Every ancestor's `overflow` intersected, which is what an element may reach
   * rather than what it clips *for* -- a box that clips does not clip its own
   * border, because the border is the edge and a box that erased the frame it
   * was drawing would be drawing nothing. `undefined` where no ancestor clips,
   * which is the common case and is why this costs no allocation.
   *
   * Written by `arrange()` rather than worked out during paint, because the hit
   * test needs the same rectangle: a box clipped by an ancestor is not hittable
   * where it is clipped, and two walks computing one intersection is two answers
   * to one question.
   */
  clip: Box | undefined;

  /**
   * Every cell this element's subtree could paint in, as one rectangle.
   *
   * The union of this element's own box and every descendant's, written
   * by `arrange()` on the way back up -- and bounded at a box that *clips*,
   * because nothing inside one is drawn outside its border box however far its
   * content reaches. So this is sound in both directions: it never excludes a
   * cell something will paint, and a nested scroll region does not report its
   * ten thousand rows to the box around it.
   *
   * Two readers, which is why it is a field rather than a walk either of them
   * takes. Paint culls a subtree whose extent does not meet its clip, and the hit
   * test skips one that does not contain the point -- the same question asked of
   * the same rectangle, so the two cannot come to disagree about what is off
   * screen. `scrollRange()` is the third, and it reads the children's extents to
   * learn how tall the content came out.
   *
   * `undefined` until something arranges the tree, which is why both culls are
   * written to pass a tree nothing has laid out rather than to refuse one.
   */
  extent: Box | undefined;

  /**
   * What this box's content reaches **before** it is scrolled, if it clips.
   *
   * CSS calls it the scrollable overflow region, and it is how far a scroll
   * offset may go: the content box unioned with every child's extent,
   * shifted back by the offset the placement used. `undefined` on a box that
   * does not clip, because a box that cannot scroll has no such region.
   *
   * Shifted **back** on purpose, which is the whole reason it is a field and not
   * a walk `scrollRange()` takes. The children's boxes have already moved by the
   * offset, so a reader that added it on afterwards would be right only until
   * something wrote a new offset -- and the next `scrollTo()` is exactly what a
   * handler does before any frame has arranged the tree again. Two wheel notches
   * in one read would then each see a range the first one had already grown, and
   * the second would scroll past the end of a list it had not finished reading.
   */
  scrollable: Box | undefined;

  /**
   * How far this element's content is scrolled, which the layout engine reads.
   *
   * Only honoured on a box that clips, since scrolling what is not clipped moves
   * content out from under nothing. A scrollbar is a component drawing a column
   * of box-drawing characters rather than anything here: the layout knows how
   * far it has been scrolled and how tall its content is, and what to draw about
   * that is a decision with a dozen answers.
   */
  scroll: { x: number; y: number } | undefined;

  #children: Element[] = [];
  #parent: Element | undefined;
  #tree: TreeImpl | undefined;
  #classes: string[] = [];
  #id: string | undefined;
  #key: number | string | undefined;
  #states = new Set<StyleState>();
  #props: PropValues = {};
  #text = '';
  #raw: RawOptions | undefined;
  #focusable = false;
  #href = '';
  #tabIndex: number | undefined;
  #selectable: boolean | undefined;
  #scrolling = false;

  /**
   * The last measurement, and what it was taken against.
   *
   * Keyed by width, and thrown away when the text or the *resolved style
   * object* changes. Identity rather than a property list on purpose: the
   * cascade hands back a new `Style` when anything about it changed and the
   * same one when nothing did, so comparing the reference answers "does this
   * measurement still hold" exactly, with no list of layout-affecting
   * properties to keep in agreement with `LAYOUT_PROPERTIES`.
   */
  #measured = new Map<number, WrappedText>();
  #measuredFor: { style: Style; text: string } | undefined;

  constructor(type: ElementType, props: ElementProps = {}) {
    this.type = type;
    // one shared object rather than a fresh one per element: `declare()` builds
    // fifty-odd properties, the cascade replaces this with its own answer on the
    // first settle, and a tree of eight hundred elements was paying for two
    // styles each before anything had looked at it. Frozen, because a style is
    // the cascade's to write and an element that mutated a shared one would be
    // rewriting what every unsettled element in the process looks like -- which
    // is the reason the property table and its initial values are frozen too
    this.style = INITIAL_STYLE;
    this.#apply(props);
  }

  /** In document order, which is what `:nth-child()` and the combinators read. */
  get children(): readonly Element[] {
    return this.#children;
  }

  get classes(): readonly string[] {
    return this.#classes;
  }

  get id(): string | undefined {
    return this.#id;
  }

  /** The reconciliation key, if one was given. Read by the renderer, not here. */
  get key(): number | string | undefined {
    return this.#key;
  }

  /**
   * Whether the element can hold the focus.
   *
   * A `tabindex` implies it, because giving something a place in the ring and
   * then leaving it out of the ring is not a thing anybody means. The exception is
   * a negative one, which is the web's: focusable by a press or by `focus()`, and
   * not in the ring a Tab walks. This is the answer to "can it be focused", and
   * `focus.ring()` is the answer to "does a Tab stop here".
   */
  get focusable(): boolean {
    return this.#focusable || this.#tabIndex !== undefined;
  }

  /** Where a `text` links to, or `''` for nowhere. */
  get href(): string {
    return this.#href;
  }

  /** Where in the ring this element sits, if it asked not to be in tree order. */
  get tabIndex(): number | undefined {
    return this.#tabIndex;
  }

  /**
   * What this element said about being selectable, or `undefined` for nothing.
   *
   * Deliberately three-valued rather than resolved here. What a cell may be
   * copied from is the *subtree's* answer -- an explicit value inherits down and
   * `raw` defaults the other way from `text` -- and resolving it on the element
   * would mean every element carrying a guess at what its ancestors said.
   * `selectableAt()` does the walk, once per frame, with the boxes it needs.
   */
  get selectable(): boolean | undefined {
    return this.#selectable;
  }

  get parent(): Element | undefined {
    return this.#parent;
  }

  /** The style props, which override the sheet per property. */
  get props(): PropValues {
    return this.#props;
  }

  get states(): readonly StyleState[] {
    return [...this.#states];
  }

  get text(): string {
    return this.#text;
  }

  /** The tree this element belongs to, if it has been attached to one. */
  get tree(): Tree | undefined {
    return this.#tree;
  }

  // -- mutation ----------------------------------------------------------

  /**
   * Adds children to the end.
   *
   * @param children - The elements to add.
   * @returns This element, so that building a tree reads as one expression.
   */
  append(...children: Element[]): this {
    for (const child of children) {
      this.insertBefore(child, undefined);
    }
    return this;
  }

  /**
   * Adds a child before another, or at the end.
   *
   * @param child - The element to add.
   * @param before - The sibling to add it in front of, or `undefined` for the end.
   * @returns This element.
   */
  insertBefore(child: Element, before: Element | undefined): this {
    if (child === this || child.contains(this)) {
      throw new Error('An element cannot contain itself');
    }
    if (this.type !== 'box') {
      throw new Error(`A ${this.type} element cannot have children`);
    }

    // moved rather than duplicated: a child already somewhere else is taken
    // from there first, which is what makes `insertBefore` a move
    child.#parent?.removeChild(child);

    const at = before === undefined ? this.#children.length : this.#children.indexOf(before);
    if (at === -1) {
      throw new Error('The element to insert before is not a child of this element');
    }

    this.#children.splice(at, 0, child);
    child.#parent = this;
    child.#adopt(this.#tree);
    this.#mark('children');
    return this;
  }

  /** Whether this element is `other` or an ancestor of it. */
  contains(other: Element): boolean {
    for (let at: Element | undefined = other; at; at = at.#parent) {
      if (at === this) {
        return true;
      }
    }
    return false;
  }

  /** Takes this element out of its parent. */
  remove(): void {
    this.#parent?.removeChild(this);
  }

  /**
   * Takes a child out.
   *
   * @param child - The child to remove.
   * @returns This element.
   */
  removeChild(child: Element): this {
    const at = this.#children.indexOf(child);
    if (at === -1) {
      return this;
    }

    // recorded before the child is detached, because afterwards it has no tree
    // to record against -- and it is recorded against *this* tree rather than
    // the child's own mark, for the same reason
    this.#tree?.mark('removed', child);
    this.#children.splice(at, 1);
    child.#parent = undefined;
    child.#adopt(undefined);
    this.#mark('children');
    return this;
  }

  /**
   * Writes a prop.
   *
   * `class`, `id` and `key` are reserved and route to the things they name;
   * everything else is a style property and takes the fast path through the
   * cascade, because a prop cannot change what any element *matches*.
   *
   * @param name - The prop.
   * @param value - The value, or `undefined` to drop it.
   * @returns This element.
   */
  setProp(name: string, value: HandlerValue | PropValue | readonly string[]): this {
    if (RESERVED.has(name)) {
      this.#apply({ [name]: value } as ElementProps);
      return this;
    }

    if (value === undefined) {
      if (name in this.#props) {
        delete this.#props[name];
        this.#mark('props');
      }
      return this;
    }

    if (this.#props[name] !== value) {
      this.#props[name] = value as PropValue;
      this.#mark('props');
    }
    return this;
  }

  /**
   * Writes several props at once.
   *
   * @param props - The props.
   * @returns This element.
   */
  setProps(props: ElementProps): this {
    this.#apply(props);
    return this;
  }

  /**
   * Replaces the text of a `text` element.
   *
   * @param value - The new text.
   * @returns This element.
   */
  setText(value: string): this {
    if (this.type !== 'text') {
      throw new Error(`A ${this.type} element has no text`);
    }
    if (value === this.#text) {
      return this;
    }

    this.#text = value;
    // a text's size is its content, so this is a layout change rather than a
    // paint one -- everything after it on the line moves
    this.#mark('layout');
    return this;
  }

  /**
   * Turns a state on or off, which selectors match with `:focus` and friends.
   *
   * @param state - The state.
   * @param on - Whether to set it. Defaults to `true`.
   * @returns This element.
   */
  setState(state: StyleState, on = true): this {
    if (on === this.#states.has(state)) {
      return this;
    }
    if (state === 'focus') {
      // the router's alone while a move is committing or being announced
      checkFocusWrite(this);
    }

    if (on) {
      this.#states.add(state);
    } else {
      this.#states.delete(state);
    }
    if (state !== 'focus') {
      this.#mark('classes');
      return this;
    }
    // told now, or once the router's move has committed both ends of it --
    // `focus.ts` has why a handler is never told in between. Told even when the
    // mark throws, because the mark runs the tree's callback and the state is
    // committed whether or not that does; and both errors kept when both throw,
    // which a `finally` would not do -- a throw from one replaces the other's
    const errors: unknown[] = [];
    try {
      this.#mark('classes');
    } catch (error) {
      errors.push(error);
    }
    try {
      announceFocus(this);
    } catch (error) {
      if (errors.length === 0) {
        throw error;
      }
      errors.push(...(error instanceof AggregateError ? error.errors : [error]));
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Errors in onFocusChange');
    }
    return this;
  }

  /**
   * Adds a class.
   *
   * @param name - The class.
   * @returns This element.
   */
  addClass(name: string): this {
    if (!this.#classes.includes(name)) {
      this.#classes.push(name);
      this.#mark('classes');
    }
    return this;
  }

  /**
   * Removes a class.
   *
   * @param name - The class.
   * @returns This element.
   */
  removeClass(name: string): this {
    const at = this.#classes.indexOf(name);
    if (at !== -1) {
      this.#classes.splice(at, 1);
      this.#mark('classes');
    }
    return this;
  }

  /**
   * Adds or removes a class.
   *
   * @param name - The class.
   * @param on - Whether it should be there. Defaults to the opposite of now.
   * @returns This element.
   */
  toggleClass(name: string, on?: boolean): this {
    const want = on ?? !this.#classes.includes(name);
    return want ? this.addClass(name) : this.removeClass(name);
  }

  /** Says the painted content changed with no consequence for its size. */
  invalidatePaint(): void {
    this.#mark('paint');
  }

  /**
   * Scrolls this element's content.
   *
   * Marks layout rather than paint: the boxes move, and a box is what everything
   * above matches to an element -- paint, and the hit testing input will want.
   * A scroll that only repainted would leave every descendant claiming a
   * position it is no longer drawn at.
   *
   * This is the **only** writer of `scroll` in the library, which is what makes
   * `onScroll` one hook rather than one per caller: `scrollBy()`,
   * `scrollIntoView()` and an app writing an offset by hand all arrive here. The
   * handler runs after the offset is written and after the mark, so what it reads
   * is the offset that will be laid out and what it mutates records marks of its
   * own on top of this one.
   *
   * A `scrollTo()` reached from **inside** this element's own handler writes and
   * marks without dispatching again. That bounds the recursion by construction
   * rather than by a depth count, and the thing it refuses -- a handler that
   * scrolls the box it was called about -- is a loop being described rather than
   * a case anybody has. The guard is per element, so a handler that scrolls a
   * *different* viewport still reaches that one's handler, which is what a
   * nested list needs.
   *
   * @param x - Cells scrolled right.
   * @param y - Cells scrolled down.
   * @returns This element.
   */
  scrollTo(x: number, y: number): this {
    const next = { x: Math.max(0, Math.trunc(x)), y: Math.max(0, Math.trunc(y)) };
    if (this.scroll?.x === next.x && this.scroll?.y === next.y) {
      return this;
    }
    this.scroll = next;
    this.#mark('layout');

    if (this.onScroll && !this.#scrolling) {
      this.#scrolling = true;
      try {
        this.onScroll(this);
      } finally {
        // put back whatever the handler did to the latch, or one that threw
        // would leave this viewport deaf for the life of the process
        this.#scrolling = false;
      }
    }
    return this;
  }

  /** Says a `raw` element's content changed, so its measurement is stale. */
  invalidateMeasure(): void {
    this.#measured.clear();
    this.#mark('layout');
  }

  // -- what the layers above read ------------------------------------------

  /**
   * What this element does with a key that reaches it.
   *
   * A plain property rather than a list of listeners: one element has one
   * handler, for the reason every hook in the parser has one function -- a list
   * reads as though order mattered between entries nobody wrote, and a component
   * that wants two things to happen writes one handler that does both.
   *
   * Set by whatever built the element; read by the input router, which walks
   * from the focused element upwards until something stops the event.
   */
  onKey: KeyHandler | undefined;

  /**
   * What this element does with a mouse event that reaches it.
   *
   * One function rather than a list, for the reason `onKey` is one. Read by the
   * input router, which hit-tests the report's position and walks from the
   * element it landed on upwards until something stops the event.
   */
  onMouse: MouseHandler | undefined;

  /**
   * What this element does with a bracketed paste that reaches it.
   *
   * One function rather than a list, for the reason `onKey` is one. Read by the
   * input router, which offers a paste to the focused element and then to each
   * ancestor until something stops it -- **before** the router's own `onPaste`
   * handlers, so that a focused text field has the paste rather than an app-wide
   * handler registered before the field existed. What nothing stops is typed in
   * as keys, as it always was.
   */
  onPaste: PasteHandler | undefined;

  /**
   * What this element does when it gains or loses the focus.
   *
   * One function rather than a list, for the reason `onKey` is one, and called by
   * `setState()` whenever the `focus` state flips -- which is the moment `:focus`
   * starts or stops matching, so a control that draws its focus from here and a
   * selector that matches it are keyed on one state. A Tab, a click and an app
   * calling `focus()` all arrive through the router's one `focus()`, which is
   * what sets the state, so all three reach this.
   *
   * It exists so that a control can show its focus with no router in hand. Every
   * element component is built before anything knows which router will own it,
   * and a `:focus` selector can only restyle: it cannot put a class on the one
   * part that shows the focus without also matching the same part of every
   * control nested inside, and it cannot write the content that is all colour
   * level 0 has left. `AGENTS.md` in `src/components` has the reasons under
   * "Focus on a control".
   *
   * It runs **synchronously**, once the change has been committed in full: a
   * move through the router writes both ends and `current` before either handler
   * runs, so a handler reads a router that agrees with `:focus`. A handler that
   * moves the focus again, with the router's `focus()`, is not re-entered -- its
   * move commits at once and the handlers it concerns are told after this one
   * returns -- and each element is told the state it has when its turn comes,
   * never one a later move has already taken back. While a move is committing or
   * being announced only the router may write the `focus` state, so
   * `setState('focus')` from a handler, or from an `onScroll` the move woke,
   * throws. A throw does not stop the other handlers being told: the move stands,
   * and what was thrown is raised, one error as itself and more as an
   * `AggregateError`, from the outermost focus change in the process once every
   * handler has been told -- the queue is one per process, so a `focus()` on one
   * router made from another's handler returns before its own handlers run, and
   * their errors come out of the outer call. What a throwing handler had not yet
   * drawn stays undrawn, since it is not asked again until the state flips again.
   *
   * So for focus the router moves, the state, `:focus` and `current` always
   * agree, and a control's own drawing agrees with them for as long as its
   * handler returns. A direct `setState('focus')` outside a move is still taken
   * and still tells this at once, but the router knows nothing of it: `:focus`
   * matches and `current` does not name the element.
   */
  onFocusChange: FocusChangeHandler | undefined;

  /**
   * What this element does when its scroll offset moved.
   *
   * One function rather than a list, for the reason `onKey` is one, and called
   * by `scrollTo()` -- the only writer of `scroll` there is, so one hook answers
   * for the keys, the wheel, a dragged thumb and `scrollIntoView()` alike.
   *
   * It exists because a **windowed** list has to learn that the offset moved: it
   * builds the rows the viewport can see and two spacers for the rest, so a new
   * offset is a new window. Doing it from the handlers a component owns would
   * leave `scrollIntoView()` out, and the focus ring calls that one
   * unconditionally -- a row revealed by it would scroll under a window built for
   * where the list used to be.
   *
   * It runs **synchronously**, before the frame that will lay the new offset out,
   * which is what keeps the two in step: the tree the frame arranges is the tree
   * the handler left. A throw propagates to whatever scrolled, as `onKey`'s does
   * -- a scroll handler is the component's own code and a throw in one is a bug
   * in that component rather than something for the element to swallow.
   */
  onScroll: ScrollHandler | undefined;

  /**
   * What this element does when the layout gave it a size it had not been told about.
   *
   * The twin of `onScroll`, and the pairing is the whole of why it is one hook:
   * `scrollTo()` is the only writer of `scroll` and `arrange()` is the only writer
   * of `box` and `content`, so each of the two numbers a windowed list is computed
   * from has exactly one place that can say it moved.
   *
   * It exists because the offset is not the only input to a window. The rows a
   * viewport can see are a question about the viewport's **height** as well, and
   * that height is not knowable until something has laid the tree out -- so a
   * terminal resize, which writes no offset, used to leave a windowed list holding
   * the window it had: measured, a list laid out at ten rows and then at forty held
   * ten where forty-one were needed, and thirty rows of the viewport stayed blank
   * until the next scroll.
   *
   * Unlike `onScroll` it is **not** dispatched by the writer. `arrange()` collects
   * every element carrying this hook that has not been **told** the size the layout
   * just gave it -- which is deliberately not "whose size moved": a handler that
   * threw was told nothing, so the next layout asks it again even though the box is
   * already at its new size. Whoever called `arrange()` dispatches, because a
   * handler that builds elements leaves them with no resolved style and `arrange()`
   * sits below the cascade and must stay there. So
   * what calls this is a *frame*: the renderer's `settle()` and
   * `renderToString()`, each of which can restyle what the handler built and lay
   * out again. A bare `arrange()` dispatches nothing, which is why the components'
   * own tests still describe the window a single layout produces.
   *
   * A throw propagates to whatever was laying out, as `onScroll`'s does.
   */
  onResize: ResizeHandler | undefined;

  /**
   * What this element does after **every** layout that reached it.
   *
   * `onResize` asks whether this element's own size moved, which is the one
   * question its own geometry can answer. This is for an element whose place
   * depends on **another** element's box: a tooltip beside its anchor, which
   * moves when anything scrolls, wraps or animates the anchor -- and none of
   * those has a writer the tooltip could hear, nor a hook on the anchor it may
   * take, since the anchor's hooks are the app's. So nothing is compared here;
   * the handler compares what it depends on and says whether it changed the tree.
   *
   * Dispatched where `onResize` is -- by a frame, after the layout and before the
   * paint, so a handler that moves something is laid out again in the same frame
   * and nothing is ever drawn in the place it is leaving. After `onResize` when
   * an element carries both, because a size is the thing a place is computed
   * from. A handler that answers `true` is called again after the layout it
   * asked for, so it must answer `false` once what it read stops moving, or the
   * frame spends every pass `settleResized()` allows. A bare `arrange()`
   * dispatches nothing, as for `onResize`.
   *
   * A throw propagates to whatever was laying out, as `onResize`'s does.
   */
  onLayout: LayoutHandler | undefined;

  /** A `raw` element's painter, for the paint walk. */
  get rawPaint(): RawPaint | undefined {
    return this.#raw?.paint;
  }

  /**
   * Whether a `raw` element's cells are text, which `selectableAt()` reads.
   *
   * `false` for every other type, so the mask walk asks one question rather than
   * asking whether it is looking at a `raw` first.
   */
  get drawsText(): boolean {
    return this.#raw?.drawsText ?? false;
  }

  /**
   * The text as it is drawn: `text-transform` applied.
   *
   * Here rather than in the paint walk because the measurement has to agree
   * with it -- `uppercase` is what makes a line wider, which is why
   * `LAYOUT_PROPERTIES` carries `textTransform` at all.
   */
  get displayText(): string {
    return sanitize(this.#transformed);
  }

  /** The text with `text-transform` applied, before the control characters go. */
  get #transformed(): string {
    switch (this.style.textTransform) {
      case 'uppercase': {
        return this.#text.toUpperCase();
      }
      case 'lowercase': {
        return this.#text.toLowerCase();
      }
      case 'capitalize': {
        return this.#text.replace(/(^|\s)(\S)/g, (_, lead: string, first: string) => {
          return lead + first.toUpperCase();
        });
      }
      default: {
        return this.#text;
      }
    }
  }

  // -- internals -----------------------------------------------------------

  #apply(props: ElementProps): void {
    for (const [name, value] of Object.entries(props)) {
      if (name === 'class') {
        const next =
          value === undefined
            ? []
            : Array.isArray(value)
              ? [...(value as readonly string[])]
              : String(value).split(/\s+/).filter(Boolean);
        if (next.join(' ') !== this.#classes.join(' ')) {
          this.#classes = next;
          this.#mark('classes');
        }
      } else if (name === 'id') {
        if (value !== this.#id) {
          this.#id = value === undefined ? undefined : String(value);
          this.#mark('classes');
        }
      } else if (name === 'key') {
        this.#key = value as number | string | undefined;
      } else if (name === 'focusable') {
        const next = value === undefined ? false : value !== false && value !== 'false';
        if (next !== this.#focusable) {
          this.#focusable = next;
          // the ring is rebuilt from the tree rather than kept, so nothing has
          // to be told -- but a selector can match on the state this enables,
          // and that is a class-level change
          this.#mark('classes');
        }
      } else if (name === 'selectable') {
        const next = value === undefined ? undefined : value !== false && value !== 'false';
        if (next !== this.#selectable) {
          this.#selectable = next;
          // paint rather than classes: no selector matches on it and no box
          // moves, and what does change is which cells the selection overlay
          // covers -- which is drawn by the paint pass, from the live selection
          this.#mark('paint');
        }
      } else if (name === 'href') {
        const next = value === undefined ? '' : String(value);
        // an OSC sequence runs until its terminator, so one hidden in the URL
        // ends it early and the rest reaches the terminal as commands -- and a
        // link built out of somebody's input is the ordinary case
        if (/\p{Cc}/u.test(next)) {
          throw new TypeError('Invalid href: control characters would end the link early');
        }
        if (next !== this.#href) {
          this.#href = next;
          // paint rather than classes: no selector matches on it and no box
          // moves, and what changes is the style of the cells the text draws
          this.#mark('paint');
        }
      } else if (HANDLERS.has(name)) {
        // assigned, not merged: a hook is one function, and `undefined` clears
        // it. Nothing is marked, since no layer reads a hook off a mark -- the
        // router and the frame read the field when an event or a layout arrives
        if (value !== undefined && typeof value !== 'function') {
          throw new TypeError(`Invalid ${name}: expected a function, got ${typeof value}`);
        }
        (this as unknown as Record<string, unknown>)[name] = value;
      } else if (name === 'tabindex') {
        const next = value === undefined ? undefined : Number(value);
        if (next !== this.#tabIndex) {
          this.#tabIndex = Number.isFinite(next) ? next : undefined;
          this.#mark('classes');
        }
      } else {
        this.setProp(name, value as PropValue);
      }
    }
  }

  /** Records a change against the tree, if this element is in one. */
  #mark(kind: keyof Marks): void {
    this.#tree?.mark(kind, this);
  }

  /** Carries tree membership down a subtree as it is attached or detached. */
  #adopt(tree: TreeImpl | undefined): void {
    if (this.#tree === tree) {
      return;
    }
    this.#tree = tree;
    for (const child of this.#children) {
      child.#adopt(tree);
    }
  }

  /**
   * Wraps a text at a width, honouring the resolved style, and caches it.
   *
   * Both the measurement and the lines, because paint asks the same question
   * layout already asked and used to re-wrap the string to answer it: half of
   * the grapheme segmentation a help screen did was one of the two passes
   * tokenizing what the other had just tokenized. The measurement kept the
   * height the text came to and threw away the lines it came to, which is the
   * one thing paint needs.
   *
   * Each line's width is kept for the same reason. Paint asks whether a line
   * overflows its box and then how much slack is left, and both are answers
   * this already worked out while taking the widest.
   */
  #wrap(availableWidth: number): WrappedText {
    const current = this.#measuredFor;
    if (!current || current.style !== this.style || current.text !== this.#text) {
      this.#measured.clear();
      this.#measuredFor = { style: this.style, text: this.#text };
    }

    // only `normal` wraps. `pre` and `nowrap` both keep every space and break
    // only at a newline, which is CSS's `pre` -- and asking `=== 'nowrap'` here
    // is what made `pre` a second spelling of `normal`, wrapped at the box and
    // with its trailing spaces dropped (SIG-207). Either is the same answer at
    // every width, so it is cached under one key rather than once per width it
    // is asked about. Without that, layout and paint asking about different
    // widths each missed the other's entry, and a table, whose cells are all
    // `nowrap`, paid for the wrap twice over
    const unwrapped = this.style.whiteSpace !== 'normal';
    const key = unwrapped ? UNWRAPPED : Math.max(0, availableWidth);

    const hit = this.#measured.get(key);
    if (hit) {
      return hit;
    }

    // read after the cache, not before: `displayText` transforms and scans the
    // string every time it is asked, and a hit is the common case
    const content = this.displayText;

    // the same branch paint used to take for itself, taken once
    const lines =
      unwrapped || availableWidth <= 0
        ? content.split('\n')
        : wrap(content, { width: availableWidth }).split('\n');
    const widths = lines.map((line) => stringWidth(line));
    const widest = maxOf(widths, 0);

    const result: WrappedText = {
      lines,
      measurement: {
        height: lines.length,
        // as short as it can be at the width it was given: wrapping it
        // narrower makes it taller, not shorter
        minHeight: lines.length,
        // the widest *line* rather than the whole string: `stringWidth()` reads
        // a newline as nothing, so a two-line label reported the two lines
        // added together as the narrowest it could be -- and a row placed it
        // twice as wide as it draws, with everything after it pushed along.
        // The longest word is what a wrapping text can be squeezed to, and it
        // is worked out only there: a `pre` or `nowrap` text cannot be squeezed
        // at all, so scanning its words was work whose answer was thrown away
        minWidth: unwrapped ? widest : longestWord(content),
        width: widest,
      },
      widths,
    };

    this.#measured.set(key, result);
    return result;
  }

  /**
   * What this text draws at a width, wrapped and cached.
   *
   * Public because paint lives in another module and asks the same question
   * the layout engine does -- and asking it here is what makes the answer one
   * answer. A non-text element has no lines and says so rather than throwing,
   * since the walk already knows which branch it is in.
   *
   * @param availableWidth - The content width the text is being drawn into.
   * @returns The lines, their widths, and the measurement they come to.
   */
  wrapped(availableWidth: number): WrappedText {
    return this.type === 'text'
      ? this.#wrap(availableWidth)
      : { lines: [], measurement: { height: 0, width: 0 }, widths: [] };
  }

  /**
   * Puts a subtree into a tree.
   *
   * A static rather than a free function because it reaches a private field,
   * which is the whole point of one: nothing outside this module can put an
   * element into a tree it did not come from.
   *
   * @param element - The subtree root.
   * @param tree - The tree, or `undefined` to detach.
   */
  static attach(element: Element, tree: TreeImpl | undefined): void {
    element.#adopt(tree);
  }

  /** Attaches the measure a `raw` element was built with. */
  static raw(options: RawOptions, props: ElementProps = {}): Element {
    const element = new Element('raw', props);
    element.#raw = options;
    element.measure = (width) => options.measure(width);
    return element;
  }

  /** Builds a text element, whose measure is its own. */
  static text(value: string, props: ElementProps = {}): Element {
    const element = new Element('text', props);
    element.#text = value;
    element.measure = (width) => element.#wrap(width).measurement;
    return element;
  }
}

class TreeImpl implements Tree {
  marks: Marks = emptyMarks();
  readonly #onMark: (() => void) | undefined;
  readonly root: Element;

  constructor(root: Element, onMark?: () => void) {
    this.#onMark = onMark;
    this.root = root;
    Element.attach(root, this);
  }

  mark(kind: keyof Marks, element: Element): void {
    this.marks[kind].add(element);
    this.#onMark?.();
  }

  take(): Marks {
    const taken = this.marks;
    this.marks = emptyMarks();
    return taken;
  }
}

/**
 * Builds a box, which lays its children out.
 *
 * @param props - Style props, plus `class`, `id` and `key`.
 * @param children - Its children.
 * @returns The element.
 */
export function box(props: ElementProps = {}, ...children: Element[]): Element {
  return new Element('box', props).append(...children);
}

/**
 * Builds a text, which measures a string.
 *
 * @param value - The text.
 * @param props - Style props, plus `class`, `id` and `key`.
 * @returns The element.
 */
export function text(value: string, props: ElementProps = {}): Element {
  return Element.text(value, props);
}

/**
 * Builds a `raw` element, which paints its own cells.
 *
 * The trapdoor: a sparkline, an image, anything the layout engine cannot
 * express. It takes part in layout like a text -- it is measured and it is
 * placed -- and what goes inside the box it got is its own business.
 *
 * @param options - How it measures and how it paints.
 * @param props - Style props, plus `class`, `id` and `key`.
 * @returns The element.
 */
export function raw(options: RawOptions, props: ElementProps = {}): Element {
  return Element.raw(options, props);
}

/**
 * What an element's style is until the cascade has resolved one.
 *
 * Shared and frozen: the initial style is the same fifty-odd values for every
 * element, `LayoutNode` needs one so that a tree can be laid out before anything
 * has resolved a style, and building one per element is the second style every
 * element used to pay for.
 */
const INITIAL_STYLE: Style = Object.freeze(declare());

/**
 * Every control character but a newline, which is the one a line is split on.
 *
 * Written as escapes rather than as literal bytes, for the reason AGENTS.md
 * records twice: a raw control character in source is invisible in an editor and
 * in a diff, and the one file that held a literal NUL had no reviewable diff at
 * all.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * What a `text` element will draw for a string.
 *
 * Exported because anything sizing a column has to measure what will be *drawn*
 * rather than what it was handed: the table works its column widths out with
 * `stringWidth()`, and a tab measures nothing and draws a space, so the two
 * disagreed by a column per tab.
 *
 * @param text - The string.
 * @returns The string as it will be drawn.
 */
export function toDisplayText(text: string): string {
  return sanitize(text);
}

/**
 * What a `text` element will draw for a string, on one line.
 *
 * `toDisplayText()` with each line break turned into a space. Both halves are
 * about widths adding up: `toDisplayText()` is what will be drawn, so it is what
 * has to be measured -- a tab measures nothing and draws a space -- and a line
 * break is a space for the readers that lay a string out in a row of its own: a table cell, where a newline would
 * push every row after it down by one and leave the column beside it looking at
 * the wrong row, and a prefix the toolchain's report writes in front of a
 * message, where a prefix that wrapped would leave the message indented against
 * a line it does not belong to. Both had written it out.
 *
 * @param text - The string.
 * @returns The string as it will be drawn, on one line.
 */
export function toDisplayLine(text: string): string {
  return sanitize(text).replaceAll('\n', ' ');
}

/**
 * What a text draws, with the characters a cell grid refuses taken out.
 *
 * The grid refuses a control character rather than dropping it, deliberately: a
 * row is painted one call at a time, and a newline that took no cell painted a
 * whole paragraph onto one line. That rule is the grid's and it is right; what it
 * needs above it is somebody to decide what a control character *means*, and this
 * is that somebody. A tab becomes a space, because the grid models no tab stops
 * and a tab that measured one width and painted another would take a column off
 * every cell to its right. Everything else goes, because there is nothing for it
 * to draw -- and because a table cell carrying one used to throw a `RangeError`
 * out of `table()`, where `padCell()` had been ordinary string work.
 *
 * Applied in `displayText`, which is what both the measure and the paint read, so
 * the two cannot come to disagree about what the string is. That is the same
 * reason `text-transform` is applied there.
 *
 * @param text - What the element was given.
 * @returns What it draws.
 */
function sanitize(text: string): string {
  // `lastIndex` is reset before the test because the pattern is global and
  // `test()` on a global pattern carries its position between calls, so the
  // second string asked about would be searched from wherever the first
  // stopped. `replaceAll()` resets it itself
  CONTROL.lastIndex = 0;
  if (!CONTROL.test(text)) {
    return text;
  }
  return text.replaceAll(CONTROL, (char) => (char === '\t' ? ' ' : ''));
}

/** A run of text inside a paragraph, and the class its words carry. */
export interface TextRun {
  /** What to put on each of this run's words. */
  class?: string;
  /** The text. */
  text: string;
}

/**
 * A paragraph: styled runs that wrap as one block of prose.
 *
 * There is no inline layout here -- a `text` wears one style, and three texts in
 * a row are three flex items, so a wrapped first item leaves the other two beside
 * its *box* rather than after its last line. What there is instead is flexbox,
 * and a wrapping row of one-word items is word wrapping: the gap between two
 * items on a line is the space between two words, a line breaks where the next
 * word does not fit, and each word may be styled on its own. That is the whole
 * of what a paragraph needs and it costs no new layout mode.
 *
 * A word too long for the line it is alone on is broken rather than left to run
 * off the edge, which is what `wrap()` does with one -- and a paragraph that
 * disagreed with the wrapper about that would be a help screen wider than the
 * terminal it was asked to fit.
 *
 * @param runs - The runs, in order. A bare string is an unstyled one.
 * @param props - What the paragraph itself carries.
 * @returns The paragraph.
 */
export function paragraph(runs: readonly (TextRun | string)[], props: ElementProps = {}): Element {
  // a newline in a run is a break the author wrote, and it survives: the words
  // around it are wrapped and the break between them is not one the wrapper is
  // free to move. Built as a column of wrapping rows only when there is one,
  // since the common case is a single line and an extra box per paragraph for
  // nothing is a flex item the layout has to place
  const lines: TextRun[][] = [[]];
  for (const run of runs) {
    const { class: classes, text: content } = typeof run === 'string' ? { text: run } : run;
    const pieces = content.split('\n');
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) {
        lines.push([]);
      }
      lines.at(-1)!.push({ class: classes, text: piece });
    }
  }

  if (lines.length === 1) {
    return wrappingRow(lines[0], props);
  }

  return box(
    { 'flex-direction': 'column', ...props },
    ...lines.map((line) => wrappingRow(line, {}))
  );
}

/**
 * One line's worth of a paragraph: the words, wrapped.
 *
 * @param runs - The runs on this line.
 * @param props - What the row itself carries.
 * @returns The row.
 */
function wrappingRow(runs: readonly TextRun[], props: ElementProps): Element {
  const words: Element[] = [];

  for (const run of runs) {
    for (const word of run.text.split(/\s+/)) {
      if (word !== '') {
        // `min-width: 0` rather than the automatic minimum, which for a text is
        // its longest word and for a one-word text is the whole of it. A word
        // too long for the line it is alone on would otherwise keep its width
        // and run off the edge, where `wrap()` breaks one -- and a paragraph
        // that disagreed with the wrapper about that is a help screen whose
        // alias list is four columns wider than the terminal
        words.push(Element.text(word, { class: run.class, 'min-width': 0 }));
      }
    }
  }

  return box({ 'column-gap': 1, 'flex-direction': 'row', 'flex-wrap': 'wrap', ...props }, ...words);
}

/**
 * Puts a tree around a root, so that mutations are recorded.
 *
 * An element not in a tree records nothing, which is deliberate: a subtree being
 * built up before it is attached has nothing on screen to invalidate, and
 * marking every `append()` of a page being constructed would hand the first
 * frame a set naming every element in it.
 *
 * @param root - The root element.
 * @returns The tree.
 */
export function createTree(root: Element, onMark?: () => void): Tree {
  return new TreeImpl(root, onMark);
}

export { ancestry, contains, hitTest, paintOrder } from './hit.js';
export {
  clipsContent,
  overlaps,
  scrollBy,
  scrollIntoView,
  type ScrollIntoViewOptions,
  scrollRange,
} from './scroll.js';
export {
  arrange,
  arrangedExtent,
  cellStyle,
  paint,
  resolveStyles,
  settleResized,
  settleStyles,
} from './paint.js';
export { type Selectable, selectableAt } from './selection.js';
export { renderToLines, renderToString, type RenderStringOptions } from './string.js';
