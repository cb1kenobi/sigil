/**
 * The automatic JSX runtime: `@ttylabs/sigil/jsx-runtime`.
 *
 * Set `"jsx": "react-jsx"` and `"jsxImportSource":
 * "@ttylabs/sigil"` and any TypeScript-aware toolchain -- tsc, oxc, esbuild,
 * vite, tsdown -- compiles a `.tsx` against this. There is no sigil-specific
 * compiler in that path and deliberately so: `sigil build` becomes an optimizer
 * an app may skip rather than a transform it depends on.
 *
 * The cost this pays for is written down in `ir.ts`: a thunk is the reactive
 * thing, in every frontend, so `{count}` is reactive and `{count()}` is a
 * snapshot. Solid gets `{count() * 2}` by compiling it into a getter, and pays
 * for it by having JSX mean different things compiled and uncompiled.
 *
 * ## Why JSX is worth having beside the tag
 *
 * Node's type stripping does not handle JSX and will not -- stripping is
 * erasure and JSX is a transform -- so a `.tsx` command module cannot run
 * under the rule AGENTS.md already records, that a command module may be
 * TypeScript and nothing compiles it. That is what the `x` tag in `tag.ts` is
 * for. What JSX buys in exchange is the thing a tagged template cannot: type
 * checking of props, completion, go-to-definition and rename, in every editor,
 * with no extension installed.
 */

import type { Element as SigilElement } from '../element/index.js';
import type { Measurement } from '../layout/index.js';
import { type ComponentRef, emit, type IRNode, type IRProp, type SourceLocation } from './ir.js';
import type { HostProps as StyleHostProps, Reactive } from './props.js';

export type { Reactive };

/** What may appear as a child. A function child is reactive text. */
export type Children =
	| Children[]
	| SigilElement
	| boolean
	| null
	| number
	| string
	| undefined
	| (() => unknown);

/**
 * What a host element accepts: its children, and every style property.
 *
 * There is no index signature, which is the point -- `<box padddding="1" />` is
 * a type error rather than a declaration the cascade refuses at runtime. What
 * the names are is `props.ts`'s, derived from the property table rather than
 * listed, so this stays true as properties are added.
 */
export type HostProps = StyleHostProps & {
	children?: Children;
};

/**
 * Builds one element from what the JSX transform passed.
 *
 * @param type - A host name, or the component itself.
 * @param props - Its props, with `children` among them.
 * @param key - The `key` prop, which the transform lifts out.
 * @returns The element.
 */
export function jsx(
	type: ComponentRef | string,
	props: Record<string, unknown>,
	key?: number | string
): SigilElement {
	return build(type, props, key, false);
}

/**
 * Builds the element, knowing whether `children` is a list or a single child.
 *
 * @param type - A host name, or the component itself.
 * @param props - Its props, with `children` among them.
 * @param key - The `key` prop, which the transform lifts out.
 * @param many - True when the transform passed a list of children.
 * @param loc - Where it was written, which only the dev transform passes.
 * @returns The element.
 */
export function build(
	type: ComponentRef | string,
	props: Record<string, unknown>,
	key: number | string | undefined,
	many: boolean,
	loc?: SourceLocation
): SigilElement {
	const { children, ...rest } = props;
	const irProps: IRProp[] = Object.entries(rest).map(([name, value]) => ({ name, value }));

	if (key !== undefined) {
		irProps.push({ name: 'key', value: key });
	}

	const list = many && Array.isArray(children) ? children : [children];
	const kids = children === undefined ? [] : list.flatMap((child) => toChildren(child, loc));

	return emit({ children: kids, kind: 'element', loc, props: irProps, type });
}

/** What the transform calls, whichever of the three names it picks. */
export type JsxFactory = (
	type: ComponentRef | string,
	props: Record<string, unknown>,
	key?: number | string
) => SigilElement;

/**
 * The transform calls this where the element has more than one child.
 *
 * Which is the whole difference between the two, and it is load bearing:
 * `props.children` is a *list of children* here and a *single child* in
 * `jsx()`. Treating both as a list flattened `<Kind>{[a]}</Kind>` into one
 * child and handed the component `a`, where the `ui` tag handed it `[a]` -- the
 * same template, two trees, through the one invariant this design rests on. An
 * array that reaches `jsx()` is one child that happens to be an array, and it
 * stays one.
 */
export const jsxs: JsxFactory = (type, props, key) => build(type, props, key, true);

/** The transform calls this in development builds; the extra arguments are ignored. */
export const jsxDEV: JsxFactory = jsx;

/**
 * There is no fragment, and that is a recorded decision rather than a gap.
 *
 * A component produces exactly one node. A transparent node would have to be
 * transparent to layout, to `:nth-child()` and to paint order, which is three
 * different definitions of "not there". Use a `<box>` and give it the layout
 * the group would have had.
 *
 * @throws Always.
 */
export function Fragment(): never {
	throw new Error(
		'sigil has no fragment: a component produces exactly one node. ' +
			'Wrap the group in <box> and give it the layout it would have had.'
	);
}

/**
 * Normalizes the transform's `children` into IR nodes.
 *
 * @param child - One child, which may itself be an array the author wrote.
 * @param loc - The parent's position, which is the nearest one a child has.
 * @returns The children as IR.
 */
function toChildren(child: unknown, loc: SourceLocation | undefined): IRNode[] {
	if (child === undefined) {
		return [];
	}

	// an array is *one* child here: `jsxs` has already spread the list it was
	// given, so anything still an array is a value the author wrote, and
	// `appendValue()` flattens it the same way the tag's `${[a, b]}` is flattened
	if (typeof child === 'string') {
		return [{ kind: 'text', loc, value: child }];
	}

	return [{ kind: 'slot', loc, value: child }];
}

/**
 * What TypeScript looks up to check a `.tsx` against.
 *
 * Type-only, so it erases to nothing.
 */
export declare namespace JSX {
	/** What an expression in JSX position produces. */
	type Element = SigilElement;

	/** The prop `children` arrives under. */
	interface ElementChildrenAttribute {
		children: Record<string, never>;
	}

	/** The host types, and nothing else -- a typo is an error rather than a guess. */
	interface IntrinsicElements {
		box: HostProps;
		raw: HostProps & {
			measure: (availableWidth: number) => Measurement;
			paint: (...args: never[]) => void;
		};
		text: HostProps;
	}
}
