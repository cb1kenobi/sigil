import type { Style } from '../style/index.js';
import {
	type Box,
	borderWidth,
	clamp,
	distribute,
	type LayoutNode,
	type LayoutResult,
	type Measurement,
	resolve,
} from './node.js';

/**
 * A flexbox subset over whole cells.
 *
 * Ours rather than borrowed: ink uses Yoga, which is a native/WASM dependency,
 * and zero dependencies rules that out. That is the price of the constraint and
 * this file is most of it.
 *
 * The integer part is the hard part, not the easy part. Distributing seven
 * leftover columns across three children means somebody gets three and somebody
 * gets two, and the rule for who has to be stable -- a layout that reshuffles
 * its rounding between frames shimmers -- which is why every division goes
 * through `distribute()` rather than being rounded where it is written.
 */

/** Which way round the axes are for a given direction. */
interface Axis {
	/** Whether the main axis runs down the screen rather than across it. */
	column: boolean;
	/** Whether the cross axis runs backwards, which is what `wrap-reverse` means. */
	crossReverse: boolean;
	/** Whether items are placed from the far end back. */
	reverse: boolean;
}

function axisOf(style: Style): Axis {
	return {
		column: style.flexDirection === 'column' || style.flexDirection === 'column-reverse',
		crossReverse: style.flexWrap === 'wrap-reverse',
		reverse: style.flexDirection === 'row-reverse' || style.flexDirection === 'column-reverse',
	};
}

/** The space padding and border take on the main and cross axes. */
function insets(style: Style, axis: Axis) {
	const border = borderWidth(style);
	const horizontal = style.paddingLeft + style.paddingRight + border * 2;
	const vertical = style.paddingTop + style.paddingBottom + border * 2;
	return {
		border,
		cross: axis.column ? horizontal : vertical,
		main: axis.column ? vertical : horizontal,
	};
}

/**
 * The border-box size a declared length asks for.
 *
 * `box-sizing: border-box` -- the default here, because in a terminal
 * `width: 20` meaning twenty columns on screen is what everybody means -- takes
 * the declaration as the outer size. `content-box`, which is CSS's default,
 * takes it as the space inside, so the padding and border are added on.
 *
 * @param style - The node's style.
 * @param declared - The resolved declaration, if there is one.
 * @param inset - The padding and border on that axis, both edges.
 * @returns The border-box size, or `undefined` when nothing was declared.
 */
function outerSize(style: Style, declared: number | undefined, inset: number): number | undefined {
	if (declared === undefined) {
		return undefined;
	}
	return style.boxSizing === 'content-box' ? declared + inset : declared;
}

/** A margin resolved to cells. `auto` is zero for sizing and absorbs space later. */
function margins(style: Style, available: number | undefined) {
	const value = (length: typeof style.marginTop) => resolve(length, available) ?? 0;
	return {
		auto: {
			bottom: style.marginBottom.type === 'auto',
			left: style.marginLeft.type === 'auto',
			right: style.marginRight.type === 'auto',
			top: style.marginTop.type === 'auto',
		},
		bottom: value(style.marginBottom),
		left: value(style.marginLeft),
		right: value(style.marginRight),
		top: value(style.marginTop),
	};
}

/** An item during layout: everything resolved, nothing placed yet. */
interface Item {
	basis: number;
	crossSize: number;
	frozen: boolean;
	/** Where this child sits in the tree, which is not where it is placed. */
	index: number;
	mainSize: number;
	margin: ReturnType<typeof margins>;
	maxCross: number | undefined;
	maxMain: number | undefined;
	minCross: number | undefined;
	minMain: number | undefined;
	node: LayoutNode;
	style: Style;
}

export interface LayoutOptions {
	/** The height available. `undefined` lets the tree be as tall as it needs. */
	height?: number;
	/** The width available. */
	width: number;
}

/**
 * Measurements already taken during one `layout()` call.
 *
 * Without it a node's whole subtree is re-measured once per ancestor level:
 * `makeItem()` measures every child from scratch and `layoutChildren()` runs
 * once per container, so the work is the node count times the depth rather than
 * the node count. Measured at eight levels deep that was a 5.3x multiplier, and
 * measuring is the most expensive thing in the stack.
 *
 * Per call rather than persistent: a node's content can change between frames,
 * and a cache that outlives the pass needs invalidating, which is the renderer's
 * job and not this module's.
 */
type MeasureCache = WeakMap<LayoutNode, Map<number, Measurement>>;

/**
 * Lays out a tree.
 *
 * @param root - The node to lay out.
 * @param opts - The space available.
 * @returns The laid-out tree.
 */
export function layout(root: LayoutNode, opts: LayoutOptions): LayoutResult {
	const cache: MeasureCache = new WeakMap();
	const { style } = root;
	const axis = axisOf(style);
	const inset = insets(style, axis);

	// the root's own declared size is honoured, the way every other node's is.
	// Nothing read it before, because a child's size is resolved by its parent
	// before `layoutNode()` is reached -- and the root has no parent to do that,
	// so `layout(panel, { width: 80 })` gave the panel eighty columns however wide
	// it said it was
	const declaredWidth = outerSize(
		style,
		resolve(style.width, opts.width),
		axis.column ? inset.cross : inset.main
	);
	const declaredHeight = outerSize(
		style,
		resolve(style.height, opts.height),
		axis.column ? inset.main : inset.cross
	);

	return layoutNode(root, declaredWidth ?? opts.width, declaredHeight ?? opts.height, 0, 0, cache);
}

/**
 * Measures a node's content without placing anything: what it would ask for if
 * it could have whatever it wanted.
 *
 * @param node - The node to measure.
 * @param availableWidth - The width to measure against, for wrapping.
 * @returns The intrinsic size.
 */
export function measureNode(node: LayoutNode, availableWidth: number): Measurement {
	return measure(node, availableWidth, new WeakMap());
}

/**
 * The cached measure.
 *
 * @param node - The node to measure.
 * @param availableWidth - The width to measure against.
 * @param cache - What this pass has measured already.
 * @returns The intrinsic size.
 */
function measure(node: LayoutNode, availableWidth: number, cache: MeasureCache): Measurement {
	let byWidth = cache.get(node);
	if (!byWidth) {
		byWidth = new Map();
		cache.set(node, byWidth);
	}

	const hit = byWidth.get(availableWidth);
	if (hit) {
		return hit;
	}

	const result = measureUncached(node, availableWidth, cache);
	byWidth.set(availableWidth, result);
	return result;
}

function measureUncached(
	node: LayoutNode,
	availableWidth: number,
	cache: MeasureCache
): Measurement {
	const { style } = node;

	if (style.display === 'none') {
		return { height: 0, minHeight: 0, minWidth: 0, width: 0 };
	}

	const axis = axisOf(style);
	const inset = insets(style, axis);
	const horizontal = axis.column ? inset.cross : inset.main;
	const vertical = axis.column ? inset.main : inset.cross;

	const declaredWidth = outerSize(style, resolve(style.width, availableWidth), horizontal);
	const inner = Math.max(0, (declaredWidth ?? availableWidth) - horizontal);

	if (node.measure) {
		const measured = node.measure(inner);
		return {
			height: measured.height + vertical,
			minHeight: (measured.minHeight ?? measured.height) + vertical,
			minWidth: (measured.minWidth ?? measured.width) + horizontal,
			width: measured.width + horizontal,
		};
	}

	const children = (node.children ?? []).filter((c) => c.style.display !== 'none');
	if (children.length === 0) {
		// `declaredWidth` is already the border box, so adding the insets again
		// counted them twice -- a bordered `width: 17` measured nineteen wide and
		// escaped a seventeen-column parent. The height goes through `outerSize()`
		// for the same reason rather than being read raw
		const declaredHeight = outerSize(style, resolve(style.height, undefined), vertical);
		// the automatic minimum is content-based, and a box with no children has no
		// content -- so it is the insets and nothing more
		return {
			height: declaredHeight ?? vertical,
			minHeight: vertical,
			minWidth: horizontal,
			width: declaredWidth ?? horizontal,
		};
	}

	const gapMain = axis.column ? style.rowGap : style.columnGap;
	let mainTotal = 0;
	let crossMax = 0;
	let minMainTotal = 0;
	let minCrossMax = 0;

	for (const child of children) {
		const childMargin = margins(child.style, inner);
		const measured = measure(child, inner, cache);
		const extraH = childMargin.left + childMargin.right;
		const extraV = childMargin.top + childMargin.bottom;

		// a child's *declared* minimum counts towards what its parent needs, not
		// only its content's. Without this a container with no declared size
		// computed itself smaller than its own child's `min-width` would force at
		// placement time, and the child ended up outside its parent's box
		const childInset = insets(child.style, axis);
		const declaredMinW =
			outerSize(
				child.style,
				resolve(child.style.minWidth, inner),
				axis.column ? childInset.cross : childInset.main
			) ?? 0;
		const declaredMinH =
			outerSize(
				child.style,
				resolve(child.style.minHeight, undefined),
				axis.column ? childInset.main : childInset.cross
			) ?? 0;

		const mainSize = axis.column ? measured.height + extraV : measured.width + extraH;
		const minMain = axis.column
			? Math.max(measured.minHeight ?? measured.height, declaredMinH) + extraV
			: Math.max(measured.minWidth ?? 0, declaredMinW) + extraH;
		const crossSize = axis.column ? measured.width + extraH : measured.height + extraV;
		const minCross = axis.column
			? Math.max(measured.minWidth ?? 0, declaredMinW) + extraH
			: Math.max(measured.minHeight ?? measured.height, declaredMinH) + extraV;

		mainTotal += Math.max(mainSize, minMain);
		minMainTotal += minMain;
		crossMax = Math.max(crossMax, crossSize, minCross);
		minCrossMax = Math.max(minCrossMax, minCross);
	}

	const gaps = gapMain * Math.max(0, children.length - 1);
	mainTotal += gaps;
	minMainTotal += gaps;

	const width = axis.column ? crossMax + inset.cross : mainTotal + inset.main;
	const height = axis.column ? mainTotal + inset.main : crossMax + inset.cross;
	const minWidth = axis.column ? minCrossMax + inset.cross : minMainTotal + inset.main;
	const minHeight = axis.column ? minMainTotal + inset.main : minCrossMax + inset.cross;

	const declaredHeight = outerSize(style, resolve(style.height, undefined), vertical);

	// CSS's automatic minimum is `min(content-based, specified)`. Reporting the
	// declared size flat meant a box with any children could not shrink at all --
	// two `width: 8` panels in ten columns stayed eight wide and the second one
	// left the container. The empty case was fixed last time; this is the same bug
	// in the branch that has children, which is every real panel
	return {
		height: declaredHeight ?? height,
		minHeight: declaredHeight === undefined ? minHeight : Math.min(minHeight, declaredHeight),
		minWidth: declaredWidth === undefined ? minWidth : Math.min(minWidth, declaredWidth),
		width: declaredWidth ?? width,
	};
}

/**
 * Lays a node out at a known position and size.
 *
 * @param node - The node.
 * @param availableWidth - The width its parent gave it.
 * @param availableHeight - The height its parent gave it, if it knows one.
 * @param x - Where the border box starts.
 * @param y - Where the border box starts.
 * @param cache - Measurements taken so far this pass.
 * @returns The laid-out subtree.
 */
function layoutNode(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number | undefined,
	x: number,
	y: number,
	cache: MeasureCache
): LayoutResult {
	const { style } = node;

	if (style.display === 'none') {
		const empty: Box = { height: 0, width: 0, x, y };
		return { box: empty, children: [], content: { ...empty }, node };
	}

	const axis = axisOf(style);
	const inset = insets(style, axis);
	const horizontal = axis.column ? inset.cross : inset.main;
	const vertical = axis.column ? inset.main : inset.cross;

	const width = clamp(
		availableWidth,
		outerSize(style, resolve(style.minWidth, availableWidth), horizontal),
		outerSize(style, resolve(style.maxWidth, availableWidth), horizontal)
	);

	const innerWidth = Math.max(0, width - horizontal);

	const minH = outerSize(style, resolve(style.minHeight, availableHeight), vertical);
	const maxH = outerSize(style, resolve(style.maxHeight, availableHeight), vertical);
	const height = clamp(availableHeight ?? measure(node, availableWidth, cache).height, minH, maxH);

	const innerHeight = Math.max(0, height - vertical);

	const box: Box = { height, width, x, y };
	const content: Box = {
		height: innerHeight,
		width: innerWidth,
		x: x + inset.border + style.paddingLeft,
		y: y + inset.border + style.paddingTop,
	};

	const all = node.children ?? [];
	const visible = all.filter((child) => child.style.display !== 'none');
	if (all.length === 0) {
		return { box, children: [], content, node };
	}

	const placed = layoutChildren(node, visible, content, axis, cache);

	// a hidden child still gets a result, so `result.children[i]` answers for
	// `node.children[i]` without a caveat -- which is what everything above this
	// needs to match a box back to its element, and what AGENTS.md promises.
	// Walked in step rather than keyed by node: the same node can appear twice in
	// one `children` list, and identity collapses the two
	let taken = 0;
	const children = all.map((child) => {
		if (child.style.display === 'none') {
			const nothing: Box = { height: 0, width: 0, x: content.x, y: content.y };
			return { box: nothing, children: [], content: { ...nothing }, node: child };
		}
		return placed[taken++];
	});

	return { box, children, content, node };
}

/**
 * Places a node's children inside its content box.
 *
 * @param parent - The containing node.
 * @param children - Its visible children.
 * @param content - The area to place them in.
 * @param axis - Which way the main axis runs.
 * @param cache - Measurements taken so far this pass.
 * @returns The laid-out children, in tree order.
 */
function layoutChildren(
	parent: LayoutNode,
	children: LayoutNode[],
	content: Box,
	axis: Axis,
	cache: MeasureCache
): LayoutResult[] {
	const { style } = parent;
	const mainSpace = axis.column ? content.height : content.width;
	const crossSpace = axis.column ? content.width : content.height;
	const gap = axis.column ? style.rowGap : style.columnGap;

	// `order` changes where a child is *placed*, not where it lives. The results
	// go back into tree order at the end so `result.children[i]` still answers for
	// `node.children[i]`; only the placement walk is sorted, and stably, so equal
	// orders keep their source sequence
	const items = children.map((child, index) => makeItem(child, axis, content, index, cache));
	const ordered = [...items].sort((a, b) => a.style.order - b.style.order);
	const lines =
		style.flexWrap === 'nowrap' ? [ordered] : wrapIntoLines(ordered, mainSpace, gap, axis);

	const placed: { index: number; result: LayoutResult }[] = [];
	const lineCrossSizes: number[] = [];

	for (const line of lines) {
		resolveFlexible(line, mainSpace, gap, axis);
		lineCrossSizes.push(Math.max(0, ...line.map((item) => outerCross(item, axis))));
	}

	const crossGap = axis.column ? style.columnGap : style.rowGap;
	const crossGaps = crossGap * Math.max(0, lines.length - 1);

	if (style.flexWrap === 'wrap-reverse') {
		lines.reverse();
		lineCrossSizes.reverse();
	}

	// a single line takes the whole cross space; several share it out according
	// to `align-content`
	if (lines.length === 1) {
		lineCrossSizes[0] = crossSpace;
	}

	const free = Math.max(0, crossSpace - lineCrossSizes.reduce((a, b) => a + b, 0) - crossGaps);

	// `stretch` grows the lines themselves; everything else spaces them, through
	// the same function `justify-content` uses. Dividing by hand here was the
	// remainder bug the main axis had already been fixed for -- `space-around`
	// gave a trailing gap three times the others, in a file whose own rule is that
	// every division goes through `distribute()`
	if (lines.length > 1 && style.alignContent === 'stretch') {
		const shares = distribute(
			free,
			lineCrossSizes.map(() => 1)
		);
		for (const [index, share] of shares.entries()) {
			lineCrossSizes[index] += share;
		}
	}

	const lineGaps =
		lines.length > 1 && style.alignContent !== 'stretch'
			? mainGaps(lines.length, free, crossGap, alignToJustify(style.alignContent, axis))
			: Array.from({ length: lines.length + 1 }, (_, i) =>
					i === 0 || i === lines.length ? 0 : crossGap
				);

	let crossCursor = lineGaps[0];

	for (const [index, line] of lines.entries()) {
		const lineCross = lineCrossSizes[index];
		placeLine(line, {
			axis,
			cache,
			content,
			crossOffset: crossCursor,
			crossSize: lineCross,
			gap,
			mainSpace,
			results: placed,
			style,
		});
		crossCursor += lineCross + lineGaps[index + 1];
	}

	// tree order, not placement order -- by index rather than by node, because the
	// same node can legitimately appear twice in one `children` list and keying on
	// identity collapsed the two into one result
	const byIndex = new Map(placed.map((entry) => [entry.index, entry.result]));
	return items.map((item) => byIndex.get(item.index)).filter((r): r is LayoutResult => !!r);
}

/** The main-axis size an item occupies including its margins. */
function outerMain(item: Item, axis: Axis): number {
	const { margin } = item;
	return item.mainSize + (axis.column ? margin.top + margin.bottom : margin.left + margin.right);
}

/** The cross-axis size an item occupies including its margins. */
function outerCross(item: Item, axis: Axis): number {
	const { margin } = item;
	return item.crossSize + (axis.column ? margin.left + margin.right : margin.top + margin.bottom);
}

/** Resolves a child's sizes before any flexing. */
function makeItem(
	node: LayoutNode,
	axis: Axis,
	content: Box,
	index: number,
	cache: MeasureCache
): Item {
	const style = node.style;
	// against the width, whichever axis this is: that is what CSS does, and
	// resolving against the main axis made the same declaration mean one thing at
	// measure time and another at placement
	const margin = margins(style, content.width);
	const measured = measure(node, Math.max(0, content.width - margin.left - margin.right), cache);

	// `insets()` already answers for this axis, so these are its answers. Swapping
	// them again gave a row container the *vertical* inset as its main one, and a
	// `content-box` child with `padding-left` came out three rows tall
	const inset = insets(style, axis);
	const mainInset = inset.main;
	const crossInset = inset.cross;

	const declaredMain = outerSize(
		style,
		axis.column ? resolve(style.height, content.height) : resolve(style.width, content.width),
		mainInset
	);
	const basisLength = style.flexBasis;
	const basisResolved =
		basisLength.type === 'auto' || basisLength.type === 'none'
			? declaredMain
			: outerSize(
					style,
					resolve(basisLength, axis.column ? content.height : content.width),
					mainInset
				);

	const contentMain = axis.column ? measured.height : measured.width;
	const basis = basisResolved ?? contentMain;

	// CSS's automatic minimum size, on whichever axis is the main one. Without the
	// column half, a column of text with no room was crushed to a single row while
	// the same text in a row was correctly held at its longest word
	const automaticMin = axis.column ? measured.minHeight : measured.minWidth;
	const minMain =
		(axis.column
			? outerSize(style, resolve(style.minHeight, content.height), mainInset)
			: outerSize(style, resolve(style.minWidth, content.width), mainInset)) ?? automaticMin;

	const maxMain = axis.column
		? outerSize(style, resolve(style.maxHeight, content.height), mainInset)
		: outerSize(style, resolve(style.maxWidth, content.width), mainInset);

	const declaredCross = outerSize(
		style,
		axis.column ? resolve(style.width, content.width) : resolve(style.height, content.height),
		crossInset
	);
	const contentCross = axis.column ? measured.width : measured.height;

	const minCross = axis.column
		? outerSize(style, resolve(style.minWidth, content.width), crossInset)
		: outerSize(style, resolve(style.minHeight, content.height), crossInset);
	const maxCross = axis.column
		? outerSize(style, resolve(style.maxWidth, content.width), crossInset)
		: outerSize(style, resolve(style.maxHeight, content.height), crossInset);

	return {
		basis,
		// the *hypothetical* cross size, clamped. A line's size is the largest of
		// these, and reading the unclamped value made a line too short for an item
		// with a `min-height` -- so the next line started on top of it
		crossSize: clamp(declaredCross ?? contentCross, minCross, maxCross),
		frozen: false,
		index,
		mainSize: basis,
		margin,
		maxCross,
		maxMain,
		minCross,
		minMain,
		node,
		style,
	};
}

/** Breaks items into lines that fit, for `flex-wrap`. */
function wrapIntoLines(items: Item[], mainSpace: number, gap: number, axis: Axis): Item[][] {
	const lines: Item[][] = [];
	let current: Item[] = [];
	let used = 0;

	for (const item of items) {
		// margins included: a five-wide item with a two-wide margin takes seven, and
		// deciding on five put two of them on a ten-wide line
		const size =
			clamp(item.basis, item.minMain, item.maxMain) +
			(axis.column ? item.margin.top + item.margin.bottom : item.margin.left + item.margin.right);
		const withGap = current.length === 0 ? size : size + gap;

		if (current.length > 0 && used + withGap > mainSpace) {
			lines.push(current);
			current = [item];
			used = size;
			continue;
		}

		current.push(item);
		used += withGap;
	}

	if (current.length > 0) {
		lines.push(current);
	}

	return lines.length > 0 ? lines : [[]];
}

/**
 * The flexible-length resolution: hand out or take back the difference between
 * what the items asked for and what there is.
 *
 * CSS freezes an item when clamping stops it moving and repeats; so does this.
 * The difference is that every hand-out goes through `distribute()`, so the
 * parts are whole cells and always add up to the space there was.
 *
 * @param line - The items on one line.
 * @param mainSpace - The space they share.
 * @param gap - The gap between them.
 * @param axis - Which way the main axis runs.
 */
function resolveFlexible(line: Item[], mainSpace: number, gap: number, axis: Axis): void {
	if (line.length === 0) {
		return;
	}

	// CSS resolves this in two halves and both matter. An item that cannot flex --
	// no factor in the direction there is room to move, or a basis already past the
	// limit that way -- is *frozen at its hypothetical size*, which is how a
	// `min-width` is accounted for before the space is handed out. Everything else
	// flexes from its **basis**, not from its clamped size: growing from the
	// clamped one pays the minimum twice, so two `flex: 1` columns whose content
	// minimums differ came out unequal.
	const total = line.reduce((sum, item) => sum + item.basis, 0);
	const gaps = gap * (line.length - 1);
	const marginTotal = line.reduce(
		(sum, item) =>
			sum +
			(axis.column ? item.margin.top + item.margin.bottom : item.margin.left + item.margin.right),
		0
	);
	const growing = mainSpace - (total + gaps + marginTotal) > 0;

	for (const item of line) {
		const hypothetical = clamp(item.basis, item.minMain, item.maxMain);
		const factor = growing ? item.style.flexGrow : item.style.flexShrink;
		// CSS §9.7.1: freeze an item whose basis was clamped *away* from the
		// direction there is room to move -- a max pulling it down while growing, a
		// min pushing it up while shrinking. Written the other way round it froze
		// everything with a minimum at that minimum, so two `flex: 1` columns never
		// grew at all
		const stuck = growing ? item.basis > hypothetical : item.basis < hypothetical;

		item.frozen = factor <= 0 || stuck;
		item.mainSize = item.frozen ? hypothetical : item.basis;
	}

	for (let pass = 0; pass < line.length + 1; pass++) {
		const used = line.reduce((sum, item) => sum + item.mainSize, 0) + gaps + marginTotal;
		const free = mainSpace - used;

		const movable = line.filter(
			(item) => !item.frozen && (free > 0 ? item.style.flexGrow > 0 : item.style.flexShrink > 0)
		);

		if (free === 0 || movable.length === 0) {
			break;
		}

		// shrinking is weighted by the base size, as in CSS: a big item gives up
		// more than a small one at the same shrink factor, and an item whose basis
		// is zero has nothing to give
		const weights = movable.map((item) =>
			free > 0 ? item.style.flexGrow : item.style.flexShrink * item.basis
		);

		if (weights.every((weight) => weight <= 0)) {
			break;
		}

		const shares = distribute(Math.abs(free), weights);

		let clampedAny = false;
		for (const [index, item] of movable.entries()) {
			const wanted = item.mainSize + (free > 0 ? shares[index] : -shares[index]);
			const settled = clamp(wanted, item.minMain, item.maxMain);
			if (settled !== wanted) {
				clampedAny = true;
				item.frozen = true;
			}
			item.mainSize = settled;
		}

		if (!clampedAny) {
			break;
		}
	}

	for (const item of line) {
		item.mainSize = clamp(item.mainSize, item.minMain, item.maxMain);
	}
}

interface PlaceOptions {
	axis: Axis;
	cache: MeasureCache;
	content: Box;
	crossOffset: number;
	crossSize: number;
	gap: number;
	mainSpace: number;
	results: { index: number; result: LayoutResult }[];
	style: Style;
}

/**
 * The space before each item, and after the last one.
 *
 * One array rather than a leading offset and a constant between-size, because a
 * constant cannot hold a remainder: `space-evenly` over seven cells and four
 * slots gave three gaps of one and a trailing gap of four, and `space-between`
 * left the last item a cell short of the edge it is defined to touch. Every slot
 * goes through `distribute()`, which is the rule the rest of this file follows.
 *
 * @param count - How many items are on the line.
 * @param free - The space left over.
 * @param gap - The gap between items, which is not free space.
 * @param justify - What the container asked for.
 * @returns `count + 1` gaps: before each item, then after the last.
 */
function mainGaps(
	count: number,
	free: number,
	gap: number,
	justify: Style['justifyContent']
): number[] {
	const ones = (n: number) => Array.from({ length: n }, () => 1);
	const gaps = Array.from({ length: count + 1 }, (_, i) => (i === 0 || i === count ? 0 : gap));

	switch (justify) {
		case 'flex-end':
			gaps[0] = free;
			break;
		case 'center': {
			const halves = distribute(free, [1, 1]);
			gaps[0] = halves[0];
			gaps[count] = halves[1];
			break;
		}
		case 'space-between': {
			if (count > 1) {
				const shares = distribute(free, ones(count - 1));
				for (let i = 1; i < count; i++) {
					gaps[i] += shares[i - 1];
				}
			} else {
				gaps[count] = free;
			}
			break;
		}
		case 'space-around': {
			// half a share before each item and half after, so the outer gaps come
			// out half the inner ones -- which is what "around" means
			const halves = distribute(free, ones(count * 2));
			gaps[0] = halves[0];
			for (let i = 1; i < count; i++) {
				gaps[i] += halves[i * 2 - 1] + halves[i * 2];
			}
			gaps[count] = halves[count * 2 - 1];
			break;
		}
		case 'space-evenly': {
			const shares = distribute(free, ones(count + 1));
			for (let i = 0; i <= count; i++) {
				gaps[i] += shares[i];
			}
			break;
		}
		default:
			gaps[count] = free;
			break;
	}

	return gaps;
}

/** Places one line of items and recurses into each. */
function placeLine(line: Item[], opts: PlaceOptions): void {
	const { axis, cache, content, crossOffset, crossSize, gap, mainSpace, results, style } = opts;

	if (line.length === 0) {
		return;
	}

	const used = line.reduce((sum, item) => sum + outerMain(item, axis), 0) + gap * (line.length - 1);
	const free = Math.max(0, mainSpace - used);

	const order = axis.reverse ? [...line].reverse() : line;

	// reversing the items moves main-start to the other edge, so the justification
	// has to move with it: `flex-start` on a `row-reverse` means the right, and
	// packing the reversed list from the left put it on the left
	const justify = axis.reverse ? flipJustify(style.justifyContent) : style.justifyContent;

	// every auto margin on the line shares the free space, wherever it sits. The
	// trailing half used to count towards the denominator and then contribute
	// nothing, so two adjacent items each pushing away from the other pushed once
	const autoSlots: { end: boolean; item: Item }[] = [];
	for (const item of order) {
		if (axis.column ? item.margin.auto.top : item.margin.auto.left) {
			autoSlots.push({ end: false, item });
		}
		if (axis.column ? item.margin.auto.bottom : item.margin.auto.right) {
			autoSlots.push({ end: true, item });
		}
	}

	const autoShares = distribute(
		free,
		autoSlots.map(() => 1)
	);
	const autoBefore = new Map<Item, number>();
	const autoAfter = new Map<Item, number>();
	for (const [index, slot] of autoSlots.entries()) {
		const target = slot.end ? autoAfter : autoBefore;
		target.set(slot.item, (target.get(slot.item) ?? 0) + autoShares[index]);
	}

	// auto margins take precedence over `justify-content`, as in CSS: once they
	// have eaten the free space there is none left to justify with
	const gaps =
		autoSlots.length > 0
			? Array.from({ length: order.length + 1 }, (_, i) =>
					i === 0 || i === order.length ? 0 : gap
				)
			: mainGaps(order.length, free, gap, justify);

	let cursor = gaps[0];

	for (const [position, item] of order.entries()) {
		const marginMainStart = axis.column ? item.margin.top : item.margin.left;
		const marginMainEnd = axis.column ? item.margin.bottom : item.margin.right;

		const mainStart = cursor + marginMainStart + (autoBefore.get(item) ?? 0);

		const declared = item.style.alignSelf === 'auto' ? style.alignItems : item.style.alignSelf;
		// `wrap-reverse` runs the cross axis backwards, so an item asked to sit at
		// the start of its line sits at what is now the bottom of it
		const align =
			axis.crossReverse && (declared === 'flex-start' || declared === 'flex-end')
				? declared === 'flex-start'
					? 'flex-end'
					: 'flex-start'
				: declared;
		const marginCrossStart = axis.column ? item.margin.left : item.margin.top;
		const marginCrossEnd = axis.column ? item.margin.right : item.margin.bottom;
		const roomCross = Math.max(0, crossSize - marginCrossStart - marginCrossEnd);

		let itemCross = item.crossSize;
		if (align === 'stretch' && !crossIsDeclared(item, axis)) {
			itemCross = roomCross;
		}
		itemCross = clamp(itemCross, item.minCross, item.maxCross);

		// re-measured at the size it actually got, *before* the cross offset is
		// computed from it: a text's height depends on its width, and the first
		// measure happened at the whole content box before any flexing. Two texts
		// sharing twenty columns each measured twenty wide and one row tall, then
		// got ten each and stayed one row
		if (!axis.column && item.node.measure && !crossIsDeclared(item, axis)) {
			const remeasured = measure(item.node, item.mainSize, cache);
			itemCross = clamp(
				align === 'stretch' ? Math.max(roomCross, remeasured.height) : remeasured.height,
				item.minCross,
				item.maxCross
			);
		}

		let crossStart = crossOffset + marginCrossStart;
		if (align === 'flex-end') {
			crossStart += roomCross - itemCross;
		} else if (align === 'center') {
			crossStart += Math.floor((roomCross - itemCross) / 2);
		}

		const childX = axis.column ? content.x + crossStart : content.x + mainStart;
		const childY = axis.column ? content.y + mainStart : content.y + crossStart;
		const childWidth = axis.column ? itemCross : item.mainSize;
		const childHeight = axis.column ? item.mainSize : itemCross;

		results.push({
			index: item.index,
			result: layoutNode(item.node, childWidth, childHeight, childX, childY, cache),
		});

		cursor = mainStart + item.mainSize + marginMainEnd + (autoAfter.get(item) ?? 0);
		cursor += gaps[position + 1];
	}
}

/**
 * The same justification against the other edge.
 *
 * @param justify - What the container asked for.
 * @returns Its mirror.
 */
function flipJustify(justify: Style['justifyContent']): Style['justifyContent'] {
	if (justify === 'flex-start') {
		return 'flex-end';
	}
	if (justify === 'flex-end') {
		return 'flex-start';
	}
	return justify;
}

/**
 * `align-content` read as a `justify-content`, so the two share one divider.
 *
 * `wrap-reverse` runs the cross axis the other way, so the ends swap -- packing
 * at the "start" of a reversed axis is packing at the bottom of the screen.
 *
 * @param align - What the container asked for.
 * @param axis - Which way the main axis runs.
 * @returns The equivalent justification.
 */
function alignToJustify(align: Style['alignContent'], axis: Axis): Style['justifyContent'] {
	const flipped = axis.crossReverse;
	if (align === 'flex-start') {
		return flipped ? 'flex-end' : 'flex-start';
	}
	if (align === 'flex-end') {
		return flipped ? 'flex-start' : 'flex-end';
	}
	if (align === 'stretch') {
		return 'flex-start';
	}
	return align;
}

/** Whether an item's cross size was asked for rather than derived. */
function crossIsDeclared(item: Item, axis: Axis): boolean {
	const length = axis.column ? item.style.width : item.style.height;
	return length.type !== 'auto' && length.type !== 'none';
}
