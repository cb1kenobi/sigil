/**
 * The template IR, and the two emitters both frontends converge on.
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
 * it may hoist, fold constants, resolve class names and pre-measure, and it may
 * not touch what anything evaluates to. So the differential test SIG-72 asks
 * for is a tight invariant rather than a hope.
 *
 * The price is `{() => count() * 2}` where Solid writes `{count() * 2}`. For
 * CLI-sized templates that is cheap, and `{count}` for the bare accessor is
 * shorter than Solid's `{count()}`.
 *
 * ## The leaves are shared, and that is SIG-72's half of the claim
 *
 * `emit()` decides the *shape* of a tree and then hands every leaf decision --
 * is this prop reactive, what does this text come to, what does a slot append
 * -- to `applyProp()`, `applyText()`, `appendValue()`, `rawElement()` and
 * `rootElement()`. The build emitter in `@ttylabs/cli` calls the same five, and
 * calls nothing else from this module. So the two emitters cannot
 * come to disagree about what a prop or a child *means*; they can only disagree
 * about which of them was decided ahead of time, and that is exactly what the
 * differential test is pointed at.
 *
 * Where the build emitter knows statically what one of those helpers would
 * decide -- a prop the template wrote as a literal is not a thunk, a `<text>`
 * with nothing interpolated into it cannot change -- it prints the decision
 * instead of the call. That is the definition of a pure optimizer, and every
 * such shortcut is one line of this file read at build time rather than at run
 * time.
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

/**
 * An expression whose source the build path knows and whose value it does not.
 *
 * The one thing the IR has to carry that a running program never produces. A
 * compiler reads a template out of a file, so every `${...}` in it is text: the
 * shape of the tree is knowable and what was interpolated is not. `Expr` is
 * that hole, and it is here rather than in `@ttylabs/cli` for the reason the IR
 * exists at all -- `parse()` is what turns a template into nodes, and a parser
 * that refused the build path's values would force the toolchain to carry a
 * second copy of it. Two parsers is the one thing this design cannot afford.
 *
 * Nothing in the runtime ever makes one, and every runtime helper refuses one
 * by name rather than letting it through: an `Expr` handed to `setProp()` is a
 * prop object the cascade rejects several layers away from the mistake.
 */
export class Expr {
	/** The expression, exactly as it was written. */
	readonly source: string;

	constructor(source: string) {
		this.source = source;
	}
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
	/**
	 * A host name, the component itself, or -- on the build path -- the
	 * expression the component was interpolated as. Never a name to look up.
	 */
	readonly type: ComponentRef | Expr | string;
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

/**
 * Refuses an expression the build path put in the IR.
 *
 * @param value - Whatever reached a runtime helper.
 * @param loc - Where it was written, if the frontend carried it.
 */
function refuseExpr(value: unknown, loc: SourceLocation | undefined): void {
	if (value instanceof Expr) {
		throw templateError(
			`\`${value.source}\` is source text rather than a value: this IR was parsed for the ` +
				'build emitter and cannot be built at runtime',
			loc
		);
	}
}

/**
 * Builds the element an IR node describes.
 *
 * @param node - The node.
 * @returns The element.
 */
export function emit(node: IRNode): Element {
	if (node.kind === 'text') {
		return text(node.value);
	}

	if (node.kind === 'slot') {
		return rootElement(node.value, node.loc);
	}

	refuseExpr(node.type, node.loc);

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
				`Unknown element <${String(node.type)}>. The host types are <box>, <text> and <raw>; ` +
					'a component is interpolated rather than named.',
				node.loc
			);
	}
}

/**
 * The element a template's root slot has to have produced.
 *
 * @param value - What was interpolated.
 * @param loc - Where it was written.
 * @returns The element.
 */
export function rootElement(value: unknown, loc?: SourceLocation): Element {
	refuseExpr(value, loc);
	if (value instanceof Element) {
		return value;
	}
	throw templateError('A template root must be an element', loc);
}

/**
 * Writes one prop, which is where the thunk rule bites for a prop.
 *
 * One effect per reactive prop rather than one for all of them: a signal change
 * should run the write it feeds and no others, which is the whole reason the
 * renderer has no re-render.
 *
 * @param element - What to write to.
 * @param name - The prop.
 * @param value - Its value: a thunk is reactive, anything else is static.
 */
export function applyProp(element: Element, name: string, value: unknown): void {
	refuseExpr(value, undefined);

	if (typeof value === 'function') {
		const read = value as () => PropValue;
		createEffect(() => {
			element.setProp(name, read());
		});
		return;
	}

	// `undefined` is a prop nobody set rather than one set to nothing, which is
	// what the JSX transform passes for an omitted attribute
	if (value !== undefined) {
		element.setProp(name, value as PropValue);
	}
}

/**
 * Writes every prop of one element, in the order they were written.
 *
 * @param element - What to write to.
 * @param props - The props the frontend read.
 */
export function applyProps(element: Element, props: readonly IRProp[]): void {
	for (const { name, value } of props) {
		applyProp(element, name, value);
	}
}

/**
 * Sets a `text` element's content from the pieces the template wrote.
 *
 * Reactive if any piece is a thunk, and static otherwise -- which is one
 * question about the whole content rather than one per piece, because a `text`
 * holds one string.
 *
 * @param element - The text element.
 * @param parts - Its content, in order.
 * @param loc - Where the element was written.
 */
export function applyText(element: Element, parts: readonly unknown[], loc?: SourceLocation): void {
	// checked here rather than inside the effect, because an effect's throw is
	// reported rather than raised -- so `<text>${() => x}${box()}</text>` handed
	// back an empty text node and a log where the static spelling of it threw
	for (const part of parts) {
		refuseExpr(part, loc);
		if (part instanceof Element) {
			throw templateError('An element cannot go inside <text>; there is no inline layout', loc);
		}
	}

	if (!parts.some((part) => typeof part === 'function')) {
		element.setText(parts.map((part) => textValue(part)).join(''));
		return;
	}

	createEffect(() => {
		element.setText(
			parts
				.map((part) =>
					typeof part === 'function' ? textValue((part as () => unknown)()) : textValue(part)
				)
				.join('')
		);
	});
}

/**
 * Builds a `raw`, which paints its own cells.
 *
 * `measure` and `paint` are construction options rather than props, so neither
 * is ever reactive: they are what the element *is*, and a `raw` that changed
 * how it measures would have to invalidate a layout nobody asked to run.
 *
 * @param measure - How wide and tall it wants to be.
 * @param paint - What it draws.
 * @param loc - Where it was written.
 * @param props - Its style props.
 * @returns The raw element.
 */
export function rawElement(
	measure: unknown,
	paint: unknown,
	loc?: SourceLocation,
	props: ElementProps = {}
): Element {
	refuseExpr(measure, loc);
	refuseExpr(paint, loc);

	if (typeof measure !== 'function' || typeof paint !== 'function') {
		throw templateError('<raw> needs a measure and a paint', loc);
	}

	return raw({ measure, paint } as RawOptions, props);
}

/**
 * Appends whatever a slot produced, which is where the thunk rule bites for a
 * child.
 *
 * @param parent - The box.
 * @param value - The interpolated value.
 */
export function appendValue(parent: Element, value: unknown): void {
	refuseExpr(value, undefined);

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
			node.setText(textValue(read()));
		});
		return;
	}

	parent.append(text(textValue(value)));
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
 * Exported because the analysis pass folds a static piece of content into the
 * string it will draw, and a second implementation of this is a second answer.
 *
 * @param value - The value.
 * @returns Its string form, with nothing for absent.
 */
export function textValue(value: unknown): string {
	if (value === null || value === undefined || typeof value === 'boolean') {
		return '';
	}
	if (value instanceof Element) {
		// `String(element)` is `[object Object]`, which is what got painted. The
		// check in `applyText()` cannot see this one: a thunk's value is not known
		// until the effect runs, and by then the element is whatever it produced
		throw new Error('An element cannot go inside <text>; there is no inline layout');
	}
	return String(value);
}

/**
 * Builds a `box` and everything under it.
 *
 * @param node - The element node.
 * @returns The box.
 */
function emitBox(node: IRElement): Element {
	const element = box();
	applyProps(element, node.props);

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
	const element = text('');
	applyProps(element, node.props);

	if (node.children.length > 0) {
		applyText(element, node.children.map(textPart), node.loc);
	}

	return element;
}

/**
 * One piece of a `text` element's content.
 *
 * An element child is refused here rather than in `applyText()` because this is
 * where the child -- and so the child's own position -- still is, and because
 * refusing it any later would mean building it first and leaving its effects on
 * the owner.
 *
 * @param child - The child node.
 * @returns Its value, for `applyText()` to read.
 */
function textPart(child: IRNode): unknown {
	if (child.kind === 'text') {
		return child.value;
	}
	if (child.kind === 'element') {
		throw templateError('An element cannot go inside <text>; there is no inline layout', child.loc);
	}
	return child.value;
}

/**
 * Builds a `raw`, which paints its own cells.
 *
 * @param node - The element node.
 * @returns The raw element.
 */
function emitRaw(node: IRElement): Element {
	// a `raw` paints its own cells, so a child has nowhere to go -- and it was
	// silently discarded, after JSX had already built it and left its effects on
	// the owner. Refused where `<text>` refuses an element, and for the reason
	// AGENTS.md gives against a property the engine ignores: parsing something
	// and doing nothing with it is worse than not accepting it. Asked before the
	// measure and the paint because the build emitter can only answer this one at
	// build time, and two emitters reporting two different faults about one
	// element is the divergence they exist to avoid
	if (node.children.length > 0) {
		throw templateError('<raw> paints its own cells, so it cannot have children', node.loc);
	}

	const measure = node.props.find((prop) => prop.name === 'measure')?.value;
	const paint = node.props.find((prop) => prop.name === 'paint')?.value;
	const element = rawElement(measure, paint, node.loc);

	applyProps(
		element,
		node.props.filter((prop) => prop.name !== 'measure' && prop.name !== 'paint')
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
		refuseExpr(value, node.loc);
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
	const children = componentChildren(node).map(reify);
	if (children.length === 1) {
		props.children = children[0];
	} else if (children.length > 1) {
		props.children = children;
	}

	return component(props);
}

/**
 * The children a component is handed, which is not every child it was written
 * with.
 *
 * Exported through `index.ts` because the build emitter has to drop exactly the
 * same ones, and a rule about which children exist is not a rule to write twice.
 *
 * @param node - The element node.
 * @returns The children that survive.
 */
export function componentChildren(node: IRElement): readonly IRNode[] {
	return node.children.filter((child) => child.kind !== 'text' || child.value.trim() !== '');
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
	refuseExpr(child.value, child.loc);
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
