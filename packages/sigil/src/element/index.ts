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

import type { Painter } from '../canvas/index.js';
import type { KeyHandler } from '../input/index.js';
import type { Box, LayoutNode, Measurement } from '../layout/index.js';
import type { PropValues, Style, StyleState } from '../style/index.js';
import { declare } from '../style/index.js';
import { stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';

/** The host types. Everything above resolves to these three. */
export type ElementType = 'box' | 'raw' | 'text';

/** What a `raw` element does with the cells it was given. */
export type RawPaint = (painter: RawPainter, box: Box, element: Element) => void;

/**
 * What a `raw` element is handed to paint with.
 *
 * A type-only import of the canvas's `Painter`: precise about what arrives,
 * without the tree taking a runtime dependency on the cell grid it is supposed
 * to be testable without.
 */
export type RawPainter = Painter;

export interface RawOptions {
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
 * The prop names that are not style properties.
 *
 * Reserved rather than carried in a bag of their own, because every one of them
 * is a question the layers above ask of every element: what selectors match it,
 * what the renderer reconciles it by, and whether input can land on it. A prop
 * this list does not name is a style property and is handed to the cascade,
 * which refuses one it does not know -- so a typo is an error rather than a
 * value nothing reads.
 */
const RESERVED = new Set(['class', 'focusable', 'id', 'key', 'tabindex']);

export type PropValue = boolean | number | string | undefined;

/** What an element is built with: style props, plus the reserved names. */
export interface ElementProps {
	[name: string]: PropValue | readonly string[];
	class?: string | readonly string[];
	/** Whether the focus ring stops here. A `tabindex` implies it. */
	focusable?: boolean;
	id?: string;
	key?: number | string;
	/** Where in the ring, for an element that should not be in document order. */
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
	#tabIndex: number | undefined;

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
	#measured = new Map<number, Measurement>();
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
	 * Whether the focus ring stops here.
	 *
	 * A `tabindex` implies it, because giving something a place in the ring and
	 * then leaving it out of the ring is not a thing anybody means.
	 */
	get focusable(): boolean {
		return this.#focusable || this.#tabIndex !== undefined;
	}

	/** Where in the ring this element sits, if it asked not to be in tree order. */
	get tabIndex(): number | undefined {
		return this.#tabIndex;
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
	setProp(name: string, value: PropValue | readonly string[]): this {
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

		if (on) {
			this.#states.add(state);
		} else {
			this.#states.delete(state);
		}
		this.#mark('classes');
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

	/** A `raw` element's painter, for the paint walk. */
	get rawPaint(): RawPaint | undefined {
		return this.#raw?.paint;
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

	/** Measures a text, honouring the resolved style, with the result cached. */
	#measureText(availableWidth: number): Measurement {
		const current = this.#measuredFor;
		if (!current || current.style !== this.style || current.text !== this.#text) {
			this.#measured.clear();
			this.#measuredFor = { style: this.style, text: this.#text };
		}

		const hit = this.#measured.get(availableWidth);
		if (hit) {
			return hit;
		}

		// read after the cache, not before: `displayText` transforms and scans the
		// string every time it is asked, and a hit is the common case
		const content = this.displayText;

		const longest = Math.max(
			0,
			...content
				.split(/\s+/)
				.filter(Boolean)
				.map((word) => stringWidth(word))
		);

		let result: Measurement;
		if (this.style.whiteSpace === 'nowrap' || availableWidth <= 0) {
			const lines = content.split('\n');
			const widest = Math.max(0, ...lines.map((line) => stringWidth(line)));
			result = {
				height: lines.length,
				minHeight: lines.length,
				// the widest *line* rather than the whole string: `stringWidth()` reads
				// a newline as nothing, so a two-line label reported the two lines
				// added together as the narrowest it could be -- and a row placed it
				// twice as wide as it draws, with everything after it pushed along
				minWidth: this.style.whiteSpace === 'nowrap' ? widest : longest,
				width: widest,
			};
		} else {
			const lines = wrap(content, { width: availableWidth }).split('\n');
			result = {
				height: lines.length,
				// as short as it can be at the width it was given: wrapping it
				// narrower makes it taller, not shorter
				minHeight: lines.length,
				minWidth: longest,
				width: Math.max(0, ...lines.map((line) => stringWidth(line))),
			};
		}

		this.#measured.set(availableWidth, result);
		return result;
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
		element.measure = (width) => element.#measureText(width);
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

export { arrange, arrangedExtent, cellStyle, paint, resolveStyles, settleStyles } from './paint.js';
export { renderToLines, renderToString, type RenderStringOptions } from './string.js';
