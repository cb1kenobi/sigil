/**
 * The template IR, and the one emitter both frontends converge on.
 *
 * Two syntaxes, one IR, one emitter: `jsx()` and the `ui` tag both build these
 * nodes and both hand them to `emit()`, so there is exactly one implementation
 * of what a template *means*. That is SIG-69's central claim, and the reason it
 * is worth the indirection -- build-time and runtime must never parse
 * separately, because a template that behaves differently after `sigil build`
 * than it did in development is close to undebuggable.
 *
 * ## A thunk is the reactive thing
 *
 * The rule, in every frontend: **a function-valued prop or child is reactive; a
 * value is static.** `count` is reactive, `count()` is a static snapshot, and
 * `() => count() * 2` is reactive.
 *
 * That is not a new rule -- it is the one `renderer/control.ts` already follows,
 * where `ShowProps.when` is `() => T` and `ForProps.each` is `() => readonly
 * T[]`. JSX adopting it is consistency rather than another thing to learn.
 *
 * What it buys is that a build step can never change semantics. Solid reaches
 * fine-grained JSX by compiling `{count() * 2}` into a getter, which means the
 * same source means different things compiled and uncompiled -- exactly the
 * divergence SIG-72 exists to prevent. Here the compiler is a *pure optimizer*:
 * it may hoist static subtrees, fold constants, resolve class names and
 * pre-measure static text, and it may not touch what anything evaluates to. So
 * the differential test SIG-72 asks for is a tight invariant rather than a hope.
 *
 * The price is `{() => count() * 2}` where Solid writes `{count() * 2}`. For
 * CLI-sized templates that is cheap, and `{count}` for the bare accessor is
 * shorter than Solid's `{count()}`.
 */

import {
	box,
	Element,
	type ElementProps,
	type PropValue,
	raw,
	type RawOptions,
	text,
} from '../element/index.js';
import { createEffect } from '../renderer/index.js';

/**
 * Where in the source a node was written.
 *
 * Carried so that an error about a template points at the template rather than
 * at the line inside `emit()` that noticed. What `file` holds differs by
 * frontend and the difference is worth knowing: the `ui` tag has no file to
 * name -- a tagged template is an expression inside a module somebody is
 * already looking at -- while JSX has one, and only in a development build.
 * The production transform passes no position at all, which is why `loc` is
 * optional rather than required: a node that cannot say where it came from is
 * the ordinary case on the compiled path.
 */
export interface SourceLocation {
	/** 1-based, and counted in UTF-16 code units the way an editor reports it. */
	readonly column: number;
	/** The module the template was written in, where the frontend knows it. */
	readonly file?: string;
	/** 1-based. */
	readonly line: number;
}

/** A component: a function of props that produces one element. */
export type ComponentRef = (props: Record<string, unknown>) => Element;

/** One prop, before anything has decided whether it is static or reactive. */
export interface IRProp {
	readonly name: string;
	readonly value: unknown;
}

/** A host element or a component, with its props and children. */
export interface IRElement {
	readonly children: readonly IRNode[];
	readonly kind: 'element';
	/** Where it was written, where the frontend could say. */
	readonly loc?: SourceLocation;
	readonly props: readonly IRProp[];
	/** A host name, or the component itself -- never a name to look up. */
	readonly type: ComponentRef | string;
}

/** Literal text the template carried. */
export interface IRText {
	readonly kind: 'text';
	/** Where it was written, where the frontend could say. */
	readonly loc?: SourceLocation;
	readonly value: string;
}

/** A value a frontend interpolated: static unless it is a function. */
export interface IRSlot {
	readonly kind: 'slot';
	/** Where it was written, where the frontend could say. */
	readonly loc?: SourceLocation;
	readonly value: unknown;
}

export type IRNode = IRElement | IRSlot | IRText;

/** The three host types. Everything else is a component. */
const HOSTS = new Set(['box', 'raw', 'text']);

/**
 * Whether a name is one of the three host types.
 *
 * @param name - The tag name.
 * @returns True for `box`, `raw` and `text`.
 */
export function isHost(name: string): boolean {
	return HOSTS.has(name);
}

/**
 * Builds the element an IR node describes.
 *
 * @param node - The node.
 * @returns The element.
 */
/**
 * An error about a template, pointed at the template.
 *
 * @param message - What is wrong.
 * @param loc - Where it was written, if the frontend carried it.
 * @returns The error to throw.
 */
export function templateError(message: string, loc: SourceLocation | undefined): Error {
	if (!loc) {
		return new Error(message);
	}
	const where = loc.file ? `${loc.file}:${loc.line}:${loc.column}` : `line ${loc.line}`;
	return new Error(`${message} (at ${where})`);
}

export function emit(node: IRNode): Element {
	if (node.kind === 'text') {
		return text(node.value);
	}

	if (node.kind === 'slot') {
		if (node.value instanceof Element) {
			return node.value;
		}
		throw templateError('A template root must be an element', node.loc);
	}

	if (typeof node.type === 'function') {
		return emitComponent(node, node.type);
	}

	switch (node.type) {
		case 'box':
			return emitBox(node);
		case 'raw':
			return emitRaw(node);
		case 'text':
			return emitText(node);
		default:
			throw templateError(
				`Unknown element <${node.type}>. The host types are <box>, <text> and <raw>; ` +
					'a component is interpolated rather than named.',
				node.loc
			);
	}
}

/**
 * Splits props into the ones a constructor takes and the ones an effect wires.
 *
 * @param props - Every prop the frontend read.
 * @returns The static props, and the reactive ones still to wire.
 */
function partition(props: readonly IRProp[]): [ElementProps, IRProp[]] {
	const statics: ElementProps = {};
	const reactive: IRProp[] = [];

	for (const prop of props) {
		if (typeof prop.value === 'function') {
			reactive.push(prop);
		} else if (prop.value !== undefined) {
			statics[prop.name] = prop.value as PropValue;
		}
	}

	return [statics, reactive];
}

/**
 * Wires one effect per reactive prop.
 *
 * One effect each rather than one for all of them: a signal change should run
 * the write it feeds and no others, which is the whole reason the renderer has
 * no re-render.
 *
 * @param element - What to write to.
 * @param reactive - The props whose values are thunks.
 */
function wire(element: Element, reactive: readonly IRProp[]): void {
	for (const { name, value } of reactive) {
		const read = value as () => PropValue;
		createEffect(() => {
			element.setProp(name, read());
		});
	}
}

/**
 * Builds a `box` and everything under it.
 *
 * @param node - The element node.
 * @returns The box.
 */
function emitBox(node: IRElement): Element {
	const [statics, reactive] = partition(node.props);
	const element = box(statics);
	wire(element, reactive);

	for (const child of node.children) {
		appendChild(element, child);
	}

	return element;
}

/**
 * Builds a `text`, whose children are its content rather than its nodes.
 *
 * @param node - The element node.
 * @returns The text.
 */
function emitText(node: IRElement): Element {
	const [statics, reactive] = partition(node.props);
	const content = textContent(node.children);
	const element = text(typeof content === 'function' ? '' : content, statics);
	wire(element, reactive);

	if (typeof content === 'function') {
		createEffect(() => {
			element.setText(content());
		});
	}

	return element;
}

/**
 * Builds a `raw`, which paints its own cells.
 *
 * @param node - The element node.
 * @returns The raw element.
 */
function emitRaw(node: IRElement): Element {
	const [statics, reactive] = partition(node.props);
	const measure = statics.measure ?? node.props.find((p) => p.name === 'measure')?.value;
	const paint = statics.paint ?? node.props.find((p) => p.name === 'paint')?.value;

	if (typeof measure !== 'function' || typeof paint !== 'function') {
		throw templateError('<raw> needs a measure and a paint', node.loc);
	}

	// a `raw` paints its own cells, so a child has nowhere to go -- and it was
	// silently discarded, after JSX had already built it and left its effects on
	// the owner. Refused where `<text>` refuses an element, and for the reason
	// AGENTS.md gives against a property the engine ignores: parsing something
	// and doing nothing with it is worse than not accepting it
	if (node.children.length > 0) {
		throw templateError('<raw> paints its own cells, so it cannot have children', node.loc);
	}

	delete statics.measure;
	delete statics.paint;

	const element = raw({ measure, paint } as RawOptions, statics);
	wire(
		element,
		reactive.filter((p) => p.name !== 'measure' && p.name !== 'paint')
	);
	return element;
}

/**
 * Calls a component with its props.
 *
 * A component's props are handed over *raw* -- a thunk stays a thunk, and a
 * function child stays a function. That is what makes `<Show>{(v) => ...}` work
 * without `Show` knowing a template was involved: only a host element
 * interprets a function as reactivity, because only a host element has a prop
 * to write it to.
 *
 * @param node - The element node.
 * @param component - What to call.
 * @returns Whatever the component built.
 */
function emitComponent(node: IRElement, component: ComponentRef): Element {
	const props: Record<string, unknown> = {};
	for (const { name, value } of node.props) {
		props[name] = value;
	}

	// whitespace-only text between a component's tags is dropped, which a host
	// element's is not. A host's whitespace is content -- the space in
	// `<text>Enter your email: </text>` is the author's -- while a component's
	// children are data it interprets, and a stray space is never part of that.
	// Without this, one space before an expression made `props.children` the
	// array `[' ', fn]`, so `<${Show}> ${(v) => ...}</>` failed with
	// `props.children is not a function` while the same template written across
	// two lines worked, because the newline run was already gone
	const kept = node.children.filter((c) => c.kind !== 'text' || c.value.trim() !== '');
	const children = kept.map(reify);
	if (children.length === 1) {
		props.children = children[0];
	} else if (children.length > 1) {
		props.children = children;
	}

	return component(props);
}

/**
 * What one child looks like to a component.
 *
 * @param child - The child node.
 * @returns An element, a string, or whatever was interpolated.
 */
function reify(child: IRNode): unknown {
	if (child.kind === 'text') {
		return child.value;
	}
	if (child.kind === 'element') {
		return emit(child);
	}
	return child.value;
}

/**
 * Appends one child to a box.
 *
 * @param parent - The box.
 * @param child - The child node.
 */
function appendChild(parent: Element, child: IRNode): void {
	if (child.kind === 'text') {
		parent.append(text(child.value));
		return;
	}
	if (child.kind === 'element') {
		parent.append(emit(child));
		return;
	}
	appendValue(parent, child.value);
}

/**
 * Appends whatever a slot produced, which is where the thunk rule bites.
 *
 * @param parent - The box.
 * @param value - The interpolated value.
 */
function appendValue(parent: Element, value: unknown): void {
	if (value === null || value === undefined || typeof value === 'boolean') {
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			appendValue(parent, item);
		}
		return;
	}

	if (value instanceof Element) {
		parent.append(value);
		return;
	}

	if (typeof value === 'function') {
		const node = text('');
		parent.append(node);
		const read = value as () => unknown;
		createEffect(() => {
			node.setText(stringify(read()));
		});
		return;
	}

	parent.append(text(stringify(value)));
}

/**
 * A `text` element's content: one string, or a thunk producing one.
 *
 * @param children - The children the frontend read.
 * @returns The content, reactive only if some part of it is.
 */
function textContent(children: readonly IRNode[]): string | (() => string) {
	// checked here rather than left to `piece()`, because `piece()` runs inside
	// the effect once any sibling is reactive -- and an effect's throw is
	// reported rather than raised, so `<text>${() => x}<box/></text>` handed back
	// an empty text node and a log where the static spelling of it threw
	for (const child of children) {
		// a slot holding one counts as well as a node that is one: JSX evaluates a
		// child before the call, so `<text><box/></text>` arrives already built and
		// wrapped as a slot. Asked here rather than left to `stringify()` because
		// this is where the node -- and so the position -- still is
		if (child.kind === 'element' || (child.kind === 'slot' && child.value instanceof Element)) {
			throw templateError(
				'An element cannot go inside <text>; there is no inline layout',
				child.loc
			);
		}
	}

	const dynamic = children.some((c) => c.kind === 'slot' && typeof c.value === 'function');

	if (!dynamic) {
		return children.map(piece).join('');
	}

	return () =>
		children
			.map((c) =>
				c.kind === 'slot' && typeof c.value === 'function'
					? stringify((c.value as () => unknown)())
					: piece(c)
			)
			.join('');
}

/**
 * One static piece of a text's content.
 *
 * @param child - The child node.
 * @returns Its contribution to the string.
 */
function piece(child: IRNode): string {
	if (child.kind === 'text') {
		return child.value;
	}
	if (child.kind === 'slot') {
		return stringify(child.value);
	}
	throw new Error('An element cannot go inside <text>; there is no inline layout');
}

/**
 * What a value reads as on screen.
 *
 * A boolean is absent rather than the word it spells, which is what `{cond &&
 * 'ready'}` needs and what JSX has always done. `appendValue()` already skipped
 * one and this did not, so the same expression was empty as a box's child and
 * the word `false` inside a `<text>` -- one rule, said twice, disagreeing.
 * `0` is still `"0"`: a number is a value somebody meant to show.
 *
 * @param value - The value.
 * @returns Its string form, with nothing for absent.
 */
function stringify(value: unknown): string {
	if (value === null || value === undefined || typeof value === 'boolean') {
		return '';
	}
	if (value instanceof Element) {
		// `String(element)` is `[object Object]`, which is what got painted. The
		// `kind === 'element'` check in `textContent()` cannot see this one: JSX
		// evaluates a child before the call, so a nested host arrives already
		// built and wrapped as a *slot* -- and so does the tag's `${box()}`
		throw new Error('An element cannot go inside <text>; there is no inline layout');
	}
	return String(value);
}
