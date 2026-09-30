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

/**
 * How far `position: relative` moves a box from where the flow put it.
 *
 * The offset is applied where the box is placed and nowhere else, which is what
 * CSS's relative positioning is: the space stays reserved at the un-offset
 * position, siblings are laid out as though nothing moved, and the box's own
 * children move with it because they are placed inside it. That is also why a
 * relative box may overlap a sibling or leave its parent's content box -- it is
 * the point of the property rather than a failure of the engine, which is why
 * `checkInvariants()` excuses it.
 *
 * `static` reads no inset at all. Over-constrained is resolved the way CSS
 * resolves it in a left-to-right, top-to-bottom flow: `top` beats `bottom` and
 * `left` beats `right`, rather than being averaged into a compromise neither
 * declaration asked for.
 *
 * Percentages resolve per axis -- `top` against the containing block's height --
 * which is CSS and is *not* what the margins do. Margins resolve against the
 * width on both axes there and here; that is CSS's own oddity and copying it
 * over to the insets would be inventing a second one.
 *
 * @param style - The node's style.
 * @param width - The containing block's content width.
 * @param height - The containing block's content height, if it has one.
 * @returns The cells to move by, positive being right and down.
 */
function relativeOffset(
	style: Style,
	width: number | undefined,
	height: number | undefined
): { x: number; y: number } {
	if (style.position !== 'relative') {
		return { x: 0, y: 0 };
	}

	const left = resolve(style.left, width);
	const right = resolve(style.right, width);
	const top = resolve(style.top, height);
	const bottom = resolve(style.bottom, height);

	return {
		x: left ?? (right === undefined ? 0 : -right),
		y: top ?? (bottom === undefined ? 0 : -bottom),
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
	/**
	 * What the child measured at the room it was given, before anything flexed.
	 *
	 * Kept on the item so that a parent sizing itself around these children can
	 * read it rather than measuring each one again -- which is what
	 * `measureUncached()` used to do, at a width that differed from this one by the
	 * child's own margins. Stale after `remeasureLine()`, which is why nothing
	 * reads it past the flex resolution.
	 */
	measured: Measurement;
	/**
	 * The shortest this item can be on the cross axis at the width it will be placed
	 * at, clamped to its own limits.
	 *
	 * `crossSize` and this are the same question asked twice -- how tall, and how
	 * short -- so they are taken together and re-taken together. A parent sizing
	 * itself needs the second as much as the first: it reports it as its own
	 * `minHeight`, and a grandparent clamps its basis *up* to that, so a minimum
	 * read at the pre-flex width squeezed a row below the height its own placement
	 * produces.
	 */
	minCrossSize: number;
	node: LayoutNode;
	style: Style;
}

/**
 * The containing block a child is sized against.
 *
 * Four numbers rather than a `Box`, because `makeItem()` is now reached from two
 * places that know different amounts about it. The placement knows all of it: the
 * content box is settled, so a percentage on a child resolves against it and the
 * width handed in is the width the child will be placed at. The measure knows
 * less -- it may be sizing a node whose own width is still a guess -- and a `Box`
 * cannot say so, because `height` there is a number and the measure has none.
 *
 * `width` and `containing` are the same number for the placement and part company
 * in the measure, for the reason `MeasureAt` already carries at length: the room
 * to lay content out in and the base a percentage is *of* are two questions.
 */
interface Block {
	/**
	 * What a percentage on the child resolves against, or `undefined` when the
	 * containing block is not settled -- which makes every percentage on the child
	 * `auto`, as in CSS.
	 */
	containing: number | undefined;
	/** Whether `width` is the width this block will actually have. */
	definite: boolean;
	/** The content height, or `undefined` when there is not one yet. */
	height: number | undefined;
	/** The content width, which is the room a child has across. */
	width: number;
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
 *
 * Keyed by the containing width *and* by whether that width is the container's
 * cross axis, because the second changes what the measure does with the first.
 */
type MeasureCache = WeakMap<LayoutNode, Map<string, Measurement>>;

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
	const horizontal = axis.column ? inset.cross : inset.main;
	const vertical = axis.column ? inset.main : inset.cross;

	// the root's own declared size is honoured, the way every other node's is.
	// Nothing read it before, because a child's size is resolved by its parent
	// before `layoutNode()` is reached -- and the root has no parent to do that,
	// so `layout(panel, { width: 80 })` gave the panel eighty columns however wide
	// it said it was
	const declaredWidth = outerSize(style, resolve(style.width, opts.width), horizontal);
	const declaredHeight = outerSize(style, resolve(style.height, opts.height), vertical);

	// and its limits for the same reason, and in the same place: sizing a node is
	// its parent's job and `layoutNode()` does none of it, so the root's limits are
	// applied here or nowhere. They resolve against `opts`, which is the root's
	// containing block -- what a percentage is *of* is never the size the node
	// ended up with
	const width = clamp(
		declaredWidth ?? opts.width,
		outerSize(style, resolve(style.minWidth, opts.width), horizontal),
		outerSize(style, resolve(style.maxWidth, opts.width), horizontal)
	);
	// measured at the width the root actually has, against the containing block it
	// actually has. Those are the two arguments `measure()` now takes and they are
	// both needed here: a root `width: 50%` under a `max-width` of eight, in forty
	// columns, means half of forty asked for and eight received -- so the `50%`
	// resolves against forty while the text wraps at eight. One argument doing both
	// jobs could only be wrong about one of them, and every candidate for it was:
	// the clamped width wrapped the text at four, and the unclamped one wrapped it
	// at twenty and reported a height for a box eight columns wide
	const height = clamp(
		declaredHeight ??
			opts.height ??
			measure(
				root,
				{ available: width, containing: opts.width, crossWidth: false, definite: true },
				cache
			).height,
		outerSize(style, resolve(style.minHeight, opts.height), vertical),
		outerSize(style, resolve(style.maxHeight, opts.height), vertical)
	);

	// the root's own relative offset is applied here for the same reason its
	// declared size and its limits are: every other node's is applied by the
	// parent that places it, and the root has no parent. It resolves against
	// `opts` for the same reason those do -- the root's containing block is the
	// space it was handed, never the size it ended up at
	const offset = relativeOffset(style, opts.width, opts.height);

	// the root is the containing block for both until something positioned
	// intervenes: `fixed` means the canvas, and the canvas is what the root is
	const frame: Box = { height, width, x: offset.x, y: offset.y };
	return layoutNode(root, width, height, offset.x, offset.y, cache, {
		absolute: frame,
		fixed: frame,
	});
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
	return measure(
		node,
		{
			available: availableWidth,
			containing: availableWidth,
			crossWidth: false,
			definite: true,
		},
		new WeakMap()
	);
}

/**
 * What a measure is being asked for: a width to lay content out in, a block to
 * resolve percentages against, and whether either of those is settled.
 *
 * One argument used to do the first two jobs, which is the defect this type
 * exists to close. They are the same number for an ordinary child and they part
 * the moment a limit binds: a node whose `max-width` narrowed it wraps at the
 * narrowed width, while its `width: 50%` still means half of the block that
 * contains it. The root is where it showed -- `width: 50%` under a `max-width`
 * of eight, in forty columns, resolved the `50%` against the eight and wrapped
 * its text at four.
 */
interface MeasureAt {
	/**
	 * The room to lay the content out in, before this node's own declaration and
	 * limits narrow it. Those are applied inside, because that is where they are
	 * resolved -- clamping at the call site as well resolves a percentage limit
	 * against the width that limit has already produced.
	 */
	available: number;
	/**
	 * The containing block's width, which every percentage on this node resolves
	 * against, or `undefined` when the containing block is not settled yet.
	 *
	 * `undefined` is not a missing number, it is the answer: a percentage of an
	 * indefinite size is `auto`, which is CSS and is what keeps one node from
	 * being measured twice to two different answers. An ancestor that is still
	 * sizing itself measures its subtree at a width it may not keep -- so a
	 * `max-width: 50%` honoured against that width wrapped a text at ten for the
	 * ancestor's measure and at five for its placement, and the ancestor was
	 * drawn three rows around a child six rows tall. The old spelling of this
	 * rule was "only a limit in cells is honoured while measuring", which is the
	 * same answer reached by noticing that a cell limit is the one that cannot
	 * move.
	 */
	containing: number | undefined;
	/** Whether the width is the container's cross axis, which does not flex. */
	crossWidth: boolean;
	/**
	 * Whether `available` is the width this node will actually be placed at.
	 *
	 * True from `layout()`, from `makeItem()` for a column's child, and from the
	 * re-measure a row takes once flexing has settled its items. False while an
	 * ancestor is sizing itself, and false for a row's child, whose main size is
	 * not known until `resolveFlexible()` has run. It is what decides whether this
	 * node's content box is a definite containing block for its own children.
	 */
	definite: boolean;
}

/**
 * The cached measure.
 *
 * @param node - The node to measure.
 * @param at - The widths to measure against, and what is settled about them.
 * @param cache - What this pass has measured already.
 * @returns The intrinsic size.
 */
function measure(node: LayoutNode, at: MeasureAt, cache: MeasureCache): Measurement {
	let byWidth = cache.get(node);
	if (!byWidth) {
		byWidth = new Map();
		cache.set(node, byWidth);
	}

	// every input is in the key, because every one of them changes the answer.
	// Keying on the available width alone handed a node measured against one
	// containing block the answer it gave for another
	const key = `${at.available}|${at.containing}|${at.crossWidth ? 'c' : 'm'}|${at.definite ? 'd' : 'i'}`;
	const hit = byWidth.get(key);
	if (hit) {
		return hit;
	}

	const result = measureUncached(node, at, cache);
	byWidth.set(key, result);
	return result;
}

function measureUncached(node: LayoutNode, at: MeasureAt, cache: MeasureCache): Measurement {
	const { available, containing, crossWidth, definite } = at;
	const { style } = node;

	if (style.display === 'none') {
		return { height: 0, minHeight: 0, minWidth: 0, width: 0 };
	}

	const axis = axisOf(style);
	const inset = insets(style, axis);
	const horizontal = axis.column ? inset.cross : inset.main;
	const vertical = axis.column ? inset.main : inset.cross;

	// every percentage on this node resolves against the containing block, and
	// the width the content is then laid out at is that declaration, else the
	// room, with this node's own limits over either. Two numbers rather than one,
	// which is the whole of this function's signature change: the base a
	// percentage is *of* and the width the box ends up with are different
	// questions, and a node whose limit binds is the node where answering them
	// with one number has to be wrong about one of them.
	//
	// The limits are resolved and applied here rather than by a caller, because
	// this is where the base they resolve against is: clamping at the call site as
	// well resolved a `max-width: 50%` against the width it had just produced, so
	// the text wrapped at five and was placed at ten.
	//
	// What is clamped is the width the content is laid out at, and never the
	// width this reports as its basis. Those are also two questions: on the main
	// axis the basis has to stay the content's own size, or the flex algorithm is
	// handed a number already raised to the item's minimum and pays for it twice
	// -- two `flex: 1` columns whose content minimums differ then come out
	// unequal. Laying the content out at a width the node will not have is the
	// thing this ticket exists to stop; reporting a basis it will not flex from
	// is a different mistake, and the fix for one must not be the other
	const declaredWidth = outerSize(style, resolve(style.width, containing), horizontal);
	const widthMin = outerSize(style, resolve(style.minWidth, containing), horizontal);
	const widthMax = outerSize(style, resolve(style.maxWidth, containing), horizontal);
	const used = clamp(declaredWidth ?? available, widthMin, widthMax);
	const inner = Math.max(0, used - horizontal);

	// whether this node's content box is a definite containing block for its own
	// children: it is if the width handed in is the one it will be placed at, and
	// it is if the node declared a width of its own, since a declaration does not
	// depend on what the caller was still guessing at
	const settled = definite || declaredWidth !== undefined;
	const childContaining = settled ? inner : undefined;

	if (node.measure) {
		// laid out at the width it will have, and asked separately what it would
		// ask for at the room it was offered. The height belongs to the first and
		// the basis to the second: a `max-width: 6` text in a wide row is six wide
		// and wraps at six, and reporting the five its content happens to wrap to
		// hands the flex algorithm a basis nobody declared. On the cross axis there
		// is no second question, because that axis does not flex and the width is
		// already settled
		const offered = Math.max(0, available - horizontal);
		const placed = node.measure(inner);
		const measured = crossWidth || offered === inner ? placed : node.measure(offered);
		// a declaration is reported the way the branches below report it, rather
		// than the content's own size: what an ancestor sizing itself around this
		// node needs to know is the width and height it will be *placed* at, and
		// `makeItem()` places it at its declaration. A `width: 10` text whose
		// content wraps to five reported five, so an auto-width column measured
		// itself five wide and drew the child outside it
		const declaredHeight = outerSize(style, resolve(style.height, undefined), vertical);
		const contentHeight = placed.height + vertical;
		const contentMinHeight = (placed.minHeight ?? placed.height) + vertical;
		const contentMinWidth = (measured.minWidth ?? measured.width) + horizontal;
		return {
			height: declaredHeight ?? contentHeight,
			minHeight:
				declaredHeight === undefined
					? contentMinHeight
					: Math.min(contentMinHeight, declaredHeight),
			minWidth:
				declaredWidth === undefined ? contentMinWidth : Math.min(contentMinWidth, declaredWidth),
			width: declaredWidth ?? measured.width + horizontal,
		};
	}

	// an out-of-flow child is not measured into its parent: it is placed against a
	// containing block rather than among these, so what it would take here is a
	// number about a layout that never happens. CSS says the same, and a dropdown
	// that made its panel wider would be a dropdown nobody could position
	const children = (node.children ?? []).filter(
		(c) => c.style.display !== 'none' && !isOutOfFlow(c.style)
	);
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
	const crossGap = axis.column ? style.columnGap : style.rowGap;
	let mainTotal = 0;
	let crossMax = 0;
	let minMainTotal = 0;
	let minCrossMax = 0;
	/**
	 * Whether this container's children break into more than one line.
	 *
	 * A row only, because the main axis of a wrapping column is its height and
	 * this function is never told one -- so there is no room to pack against, and
	 * a column is left measuring as it always did.
	 */
	const wrapping = style.flexWrap !== 'nowrap' && !axis.column && children.length > 1;

	// this node's content box, with what is settled about it said out loud: it is the
	// room every child has and, when this node's own width is settled, the base their
	// percentages resolve against
	const block: Block = {
		containing: childContaining,
		definite: settled,
		height: undefined,
		width: inner,
	};

	// one `makeItem()` per child, and one measure with it. This loop used to take a
	// measure of its own at `inner` while `makeItem()` takes one at `inner - margins`,
	// which is the room the child actually has -- so a margined child was measured
	// twice, to two answers, and the parent sized itself by the one the placement never
	// asks for. Neither is the *placed* width of a row's child, which nothing knows
	// until `resolveFlexible()` has run; what matters is that the measure and the
	// placement now ask the same question, and the cross pass below is where the placed
	// width gets asked
	const items = children.map((child, index) => makeItem(child, axis, block, index, cache));

	for (const item of items) {
		const child = item.node;
		const childMargin = item.margin;
		const extraH = childMargin.left + childMargin.right;
		const extraV = childMargin.top + childMargin.bottom;

		// a child's *declared* minimum counts towards what its parent needs, not
		// only its content's. Without this a container with no declared size
		// computed itself smaller than its own child's `min-width` would force at
		// placement time, and the child ended up outside its parent's box
		const childInset = insets(child.style, axis);
		const widthInset = axis.column ? childInset.cross : childInset.main;
		const declaredMinW =
			outerSize(child.style, resolve(child.style.minWidth, childContaining), widthInset) ?? 0;
		const declaredMinH =
			outerSize(
				child.style,
				resolve(child.style.minHeight, undefined),
				axis.column ? childInset.main : childInset.cross
			) ?? 0;

		// taken at the room the child has, and told whether the width is this
		// container's cross axis so that a child's own `max-width` decides what its
		// content wraps at. Measured at the container's width regardless, the
		// intrinsic height was the height of a wrap that never happens, and a column
		// sized from it came out shorter than the child it was measuring
		const { measured } = item;

		const mainSize = axis.column ? measured.height + extraV : measured.width + extraH;
		const minMain = axis.column
			? Math.max(measured.minHeight ?? measured.height, declaredMinH) + extraV
			: Math.max(measured.minWidth ?? 0, declaredMinW) + extraH;
		const crossSize = axis.column ? measured.width + extraH : measured.height + extraV;
		const minCross = axis.column
			? Math.max(measured.minWidth ?? 0, declaredMinW) + extraH
			: Math.max(measured.minHeight ?? measured.height, declaredMinH) + extraV;

		// the main pair is a column's. A row replaces both below, out of the same
		// items the placement will flex, for the reason the cross pair is replaced:
		// this reads each child at the room it was *offered* rather than at what it
		// asked for, and on the main axis that misses a `flex-basis` entirely. They
		// are still computed here because one loop for both axes is cheaper than a
		// branch inside it
		mainTotal += Math.max(mainSize, minMain);
		minMainTotal += minMain;
		crossMax = Math.max(crossMax, crossSize, minCross);
		minCrossMax = Math.max(minCrossMax, minCross);
	}

	const gaps = gapMain * Math.max(0, children.length - 1);
	mainTotal += gaps;
	minMainTotal += gaps;

	// a row's height is a question about the widths its children end up with, and
	// flexing is what decides those -- so this runs the placement's own three
	// functions rather than guessing at their answer. `wrapIntoLines()` breaks the
	// items into the lines the placement will break them into, `resolveFlexible()`
	// hands out the room, and `remeasureLine()` asks each item how tall it is at
	// the width it was given.
	//
	// Before this the cross size was the height each child reported at the *whole*
	// content box, which is a width only one child can have: a description beside a
	// label measured two lines in the room it was offered, was placed in the column
	// flexing gave it where it needs three, and the block after the row was drawn
	// over the third. The placement was never wrong -- `remeasureLine()` has always
	// settled each item at its used width -- so what was lost was the row a
	// neighbour was promised, and the three consumers that knew about it paid for it
	// by declaring the column's width by hand. What the fix buys is that nobody has to:
	// an ordinary row lays out correctly now. All three of those declarations were then
	// examined and all three stay, each for a reason that turned out to have nothing to
	// do with this defect and each written down where it is.
	//
	// One round, not a fixed point. The items are flexed against `inner`, which is
	// this measure's own width, so the answer is exact wherever `inner` is settled
	// -- which is every row that is a child of a column, since a column's cross axis
	// does not flex. Where it is not, flexing a guess produces a height for a width
	// this node may not get, which is the overflow `MeasureAt.containing` already
	// documents as the better of the two answers available and the one CSS gives.
	// Iterating would not close that: the width does not converge, it is simply not
	// known yet.
	//
	// A row only, for the reason `wrapping` gives: a column's main axis is its
	// height and this function is never told one, so there is nothing to flex
	// against.
	if (!axis.column) {
		// sorted stably, so children that share an `order` keep the sequence they
		// were written in -- which is what the placement walk does, and `order` is
		// what decides who shares a line
		const ordered = [...items].sort((a, b) => a.style.order - b.style.order);
		const lines = wrapping ? wrapIntoLines(ordered, inner, gapMain, axis) : [ordered];

		/** What one line asks for along the main axis, gaps included. */
		const lineTotal = (line: Item[], size: (item: Item, axis: Axis) => number): number =>
			line.reduce((sum, item) => sum + size(item, axis), 0) +
			gapMain * Math.max(0, line.length - 1);

		// both of these are read before anything flexes, because `resolveFlexible()` is
		// about to hand out room these items have not been given: what is wanted here
		// is what they *ask* for.
		mainTotal = wrapping
			? // the longest line, taken from the same `hypotheticalMain()` that decided
				// which line each item landed on -- so the box cannot be measured for a
				// packing it was not packed by
				Math.max(0, ...lines.map((line) => lineTotal(line, hypotheticalMain)))
			: // and a nowrap row is one line, so what it asks for is that line's total,
				// which is SIG-126. It used to keep the loop's own sum instead, each
				// child's measured *content* width, and a `flex-basis` is exactly what
				// that misses, since `measureUncached()` already reports a declared
				// `width`. So a `flex-basis: 40` box measured zero and was then shrunk to
				// the zero its row had been given, which is content simply not on screen;
				// with `flex-shrink: 0` it could give nothing up and was drawn forty
				// columns outside a parent zero wide.
				//
				// Through `maxContentMain()` and deliberately not `hypotheticalMain()`,
				// which is the distinction this took a round to see: the hypothetical size
				// is the basis flexing starts *from*, which is right for deciding who
				// shares a line and wrong for how wide a row wants to be. A
				// `flex-basis: 0; flex-grow: 1` description has a hypothetical size of
				// zero, so summing these reported a row's own min-content width -- a
				// label-and-description row came out eleven columns instead of
				// twenty-two, and the description was then placed in five and wrapped to
				// seven rows inside a box drawn for three
				lineTotal(ordered, maxContentMain);
		minMainTotal = wrapping
			? // the smallest a wrapping container can be on its main axis is its widest
				// single item rather than the sum of them, because everything else can be
				// pushed onto a line of its own
				Math.max(0, ...items.map((item) => hypotheticalMain(item, axis)))
			: // and a nowrap row's is the sum of how short each item can be made, because
				// they all stay on the one line. Through `minimumMain()` rather than the
				// loop's `Math.max(automatic, declared)`, which is the second half of
				// SIG-126 and the same rule the line above already keeps: the minimum is
				// the placement's `declared ?? automatic`, so a `min-width: 0` on a long
				// word is a declaration the automatic minimum does not get a say in. It
				// reported the word's own width, and a parent narrower than that placed
				// the row at the width its child had said it need not keep
				lineTotal(ordered, minimumMain);

		let cross = crossGap * Math.max(0, lines.length - 1);
		let crossMin = crossGap * Math.max(0, lines.length - 1);
		for (const line of lines) {
			resolveFlexible(line, inner, gapMain, axis);
			remeasureLine(line, axis, childContaining, settled, cache);
			// exactly what `layoutChildren()` puts in `lineCrossSizes`, which is what
			// the next line starts after
			cross += Math.max(0, ...line.map((item) => outerCross(item, axis)));
			// and the same sum over how short each line can be made, which is this
			// container's own minimum. Per line rather than over every item, because a
			// line cannot be shorter than its own shortest-possible tallest item and the
			// lines stack: three one-row items on three lines cannot be one row
			crossMin += Math.max(0, ...line.map((item) => outerMinCross(item, axis)));
		}

		// replaced rather than taken as a floor, which is the whole of the fix: the loop
		// above answered a different question -- every child at the room it was offered,
		// before anything flexed -- and a `Math.max` of the two keeps whichever is
		// larger, so a `max-height` that the placement honours would go on being
		// measured around as though it did not. What the loop found for a row is
		// therefore discarded; it is still computed because the loop is a column's as
		// well, and one loop for both axes is cheaper than a branch inside it.
		crossMax = cross;

		// and the minimum is replaced from the same pass, for the same reason the size
		// is: the loop's is a per-*child* maximum read at the pre-flex width, and both
		// halves of that are wrong. Read at the pre-flex width it can come out
		// *smaller* than the height beside it -- two nineteen-column texts in twenty
		// columns are one line each before flexing and two rows each after, so the row
		// reported `height: 2` and `minHeight: 1`, and a column parent clamps a child's
		// basis *up* to that minimum and squeezed the row to one row around two rows of
		// text. And read as a per-child maximum it is too small for a container whose
		// lines stack. Asking each item how short it can be *at the width it was
		// given*, and summing that per line, answers both at once: it is `crossSize`'s
		// own question with `minHeight` in place of `height`.
		//
		// Two narrower spellings were tried and each was wrong in one direction. A
		// `Math.max` of this and the loop's kept a `max-height: 1` over a six-row text
		// reporting `minHeight: 6` beside `height: 1`, so a column placed it six rows
		// tall by the very number this pass had just corrected. A `Math.min` of them
		// kept the nineteen-column case above. The special case they were reached
		// through -- clamp on one line, replace on several -- is gone with them.
		minCrossMax = crossMin;
	}

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
 * The two boxes an out-of-flow child can be placed against.
 *
 * `absolute` is the padding box of the nearest positioned ancestor, which is
 * CSS's containing-block rule and worth keeping because everybody already knows
 * it -- a dropdown anchors to the panel it was written inside rather than to
 * whatever happened to be laying it out. `fixed` is the root's box, which here
 * is the canvas: a status line pinned to the bottom of a full-screen app is what
 * it is for, and a canvas is the only thing a terminal app has that answers to
 * "the screen".
 */
interface Frames {
	absolute: Box;
	fixed: Box;
}

/** Whether a node is taken out of its parent's flow. */
function isOutOfFlow(style: Style): boolean {
	return style.position === 'absolute' || style.position === 'fixed';
}

/** Whether a node is a containing block for an `absolute` descendant. */
function isPositioned(style: Style): boolean {
	return style.position !== 'static';
}

/** Whether a node clips what its children draw, and so may be scrolled. */
export function clips(style: Style): boolean {
	return style.overflow !== 'visible';
}

/**
 * Places one out-of-flow child against its containing block.
 *
 * The size comes from the declaration, else from both insets -- `left` and
 * `right` together say how wide the box is, which is the idiom `inset-0` is for
 * -- else from what it measures, which is CSS's shrink-to-fit. Where neither
 * inset is given the box stays where the flow would have started it, which is
 * CSS's static position read as far as it is worth reading: the real rule
 * describes where the box *would* have been placed among siblings that have
 * already been laid out without it, and the useful half of that is the content
 * origin it would have started from.
 *
 * @param node - The out-of-flow child.
 * @param frames - The boxes it may be placed against.
 * @param origin - Where the parent's flow would have started it.
 * @param cache - Measurements taken so far this pass.
 * @returns The laid-out subtree.
 */
function layoutOutOfFlow(
	node: LayoutNode,
	frames: Frames,
	origin: Box,
	cache: MeasureCache
): LayoutResult {
	const { style } = node;
	const block = style.position === 'fixed' ? frames.fixed : frames.absolute;
	const axis = axisOf(style);
	const inset = insets(style, axis);
	const horizontal = axis.column ? inset.cross : inset.main;
	const vertical = axis.column ? inset.main : inset.cross;

	const left = resolve(style.left, block.width);
	const right = resolve(style.right, block.width);
	const top = resolve(style.top, block.height);
	const bottom = resolve(style.bottom, block.height);

	const declaredWidth = outerSize(style, resolve(style.width, block.width), horizontal);
	const declaredHeight = outerSize(style, resolve(style.height, block.height), vertical);

	const measured = measure(
		node,
		{
			available: Math.max(0, block.width - (left ?? 0) - (right ?? 0)),
			containing: block.width,
			crossWidth: true,
			definite: true,
		},
		cache
	);

	const stretchedWidth =
		left !== undefined && right !== undefined ? block.width - left - right : undefined;
	const stretchedHeight =
		top !== undefined && bottom !== undefined ? block.height - top - bottom : undefined;

	const width = clamp(
		declaredWidth ?? stretchedWidth ?? measured.width,
		outerSize(style, resolve(style.minWidth, block.width), horizontal),
		outerSize(style, resolve(style.maxWidth, block.width), horizontal)
	);
	const height = clamp(
		declaredHeight ?? stretchedHeight ?? measured.height,
		outerSize(style, resolve(style.minHeight, block.height), vertical),
		outerSize(style, resolve(style.maxHeight, block.height), vertical)
	);

	// `left` wins over `right` where both are given and a width was declared too,
	// which is the over-constrained rule the relative offsets already follow
	const x =
		left === undefined
			? right === undefined
				? origin.x
				: block.x + block.width - right - width
			: block.x + left;
	const y =
		top === undefined
			? bottom === undefined
				? origin.y
				: block.y + block.height - bottom - height
			: block.y + top;

	return layoutNode(node, width, height, x, y, cache, {
		absolute: isPositioned(style) ? block : frames.absolute,
		fixed: frames.fixed,
	});
}

/**
 * Lays a node out at the position and size its parent decided.
 *
 * It decides neither. A node's size is settled by whoever placed it -- by
 * `makeItem()` and `resolveFlexible()` for a child, by `layout()` for the root --
 * and clamping it again here read the same declarations a second time with less
 * to go on: a percentage resolved against the size just handed out rather than
 * against the containing block, so `max-width: 50%` on a growing item in a
 * ten-wide row clamped it to five and then read the five as the base and clamped
 * it to three; and an `auto` minimum resolved to nothing at all, because the
 * content-based minimum lives in the measurement that only `makeItem()` has. Both
 * ways the box came back smaller than the hole its siblings' positions had
 * already reserved for it.
 *
 * @param node - The node.
 * @param width - The border-box width its parent gave it.
 * @param height - The border-box height its parent gave it.
 * @param x - Where the border box starts.
 * @param y - Where the border box starts.
 * @param cache - Measurements taken so far this pass.
 * @param frames - What an out-of-flow descendant is placed against.
 * @returns The laid-out subtree.
 */
function layoutNode(
	node: LayoutNode,
	width: number,
	height: number,
	x: number,
	y: number,
	cache: MeasureCache,
	frames: Frames
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

	const innerWidth = Math.max(0, width - horizontal);
	const innerHeight = Math.max(0, height - vertical);

	const box: Box = { height, width, x, y };
	const content: Box = {
		height: innerHeight,
		width: innerWidth,
		x: x + inset.border + style.paddingLeft,
		y: y + inset.border + style.paddingTop,
	};

	const all = node.children ?? [];
	if (all.length === 0) {
		return { box, children: [], content, node };
	}

	// an out-of-flow child is placed against a containing block rather than among
	// its siblings, so the flow never sees it: it takes no space, it moves nothing,
	// and the line it would have been on is the line it would have been on without
	// it. That is CSS, and it is the useful answer -- an overlay that reflowed the
	// panel underneath it would be an overlay nobody could use
	const inFlow = all.filter((child) => child.style.display !== 'none' && !isOutOfFlow(child.style));

	// this node's padding box is what its own positioned descendants resolve
	// against, and only if it is positioned itself. Settled before the children
	// are laid out rather than after, because laying them out is what reaches
	// their own positioned descendants
	const inner: Frames = {
		absolute: isPositioned(style)
			? {
					height: Math.max(0, height - inset.border * 2),
					width: Math.max(0, width - inset.border * 2),
					x: x + inset.border,
					y: y + inset.border,
				}
			: frames.absolute,
		fixed: frames.fixed,
	};

	const placed = inFlow.length > 0 ? layoutChildren(node, inFlow, content, axis, cache, inner) : [];

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
		if (isOutOfFlow(child.style)) {
			return layoutOutOfFlow(child, inner, content, cache);
		}
		return placed[taken++];
	});

	// scrolling moves what this box contains, which is every descendant of it and
	// nothing else -- the box itself stays where its own parent put it. Applied
	// after placement rather than by shifting the content box before it, because
	// the content box is what a percentage resolves against and what the flow
	// divides: scrolling must move the result, not the arithmetic
	const scroll = clips(style) ? node.scroll : undefined;
	if (scroll && (scroll.x !== 0 || scroll.y !== 0)) {
		for (const child of children) {
			shift(child, -scroll.x, -scroll.y);
		}
	}

	return { box, children, content, node };
}

/**
 * Moves a laid-out subtree, which is what scrolling one is.
 *
 * @param result - The subtree.
 * @param dx - Cells to move right.
 * @param dy - Cells to move down.
 */
function shift(result: LayoutResult, dx: number, dy: number): void {
	result.box.x += dx;
	result.box.y += dy;
	result.content.x += dx;
	result.content.y += dy;
	for (const child of result.children) {
		shift(child, dx, dy);
	}
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
	cache: MeasureCache,
	frames: Frames
): LayoutResult[] {
	const { style } = parent;
	const mainSpace = axis.column ? content.height : content.width;
	const crossSpace = axis.column ? content.width : content.height;
	const gap = axis.column ? style.rowGap : style.columnGap;

	// `order` changes where a child is *placed*, not where it lives. The results
	// go back into tree order at the end so `result.children[i]` still answers for
	// `node.children[i]`; only the placement walk is sorted, and stably, so equal
	// orders keep their source sequence
	// the placement's containing block is settled in every respect: the content box
	// is the one these children will be placed in, so a percentage on one of them
	// resolves against it and the widths handed out are the widths they get
	const block: Block = {
		containing: content.width,
		definite: true,
		height: content.height,
		width: content.width,
	};
	const items = children.map((child, index) => makeItem(child, axis, block, index, cache));
	const ordered = [...items].sort((a, b) => a.style.order - b.style.order);
	const lines =
		style.flexWrap === 'nowrap' ? [ordered] : wrapIntoLines(ordered, mainSpace, gap, axis);

	const placed: { index: number; result: LayoutResult }[] = [];
	const lineCrossSizes: number[] = [];

	for (const line of lines) {
		resolveFlexible(line, mainSpace, gap, axis);
		remeasureLine(line, axis, content.width, true, cache);
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
			frames,
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
/**
 * Re-measures a row's items at the main size flexing settled on.
 *
 * A text's height depends on its width and the first measure was taken at the
 * whole content box, before there was any question of flexing -- so an item that
 * ended up narrower than that is taller than it was measured, and a line's cross
 * size is the largest item on it.
 *
 * Which is why this runs here rather than where the item is placed, where it
 * used to: the line's cross size is what the next line starts after, so a height
 * that grows after that size is fixed puts the next line on top of this one. Two
 * texts in a wrapping row is all it takes -- the first wrapped to two rows at the
 * width it got, the line stayed one row tall, and the second was placed over the
 * first one's second row.
 *
 * A row only, for the reason `placeLine()` gives at length: a column's cross size
 * is its width, which never flexes, so `makeItem()` has already measured it at
 * the width its own limits settle on.
 *
 * Reached from `layoutChildren()`, where the container's content box is real, and
 * from `measureUncached()`, where it may still be a guess -- which is the whole of
 * what `definite` is for. The alternative was a second copy of this loop inside
 * the measure, and two readings of "how tall is this item at the width it got" is
 * how the measure came to disagree with the placement in the first place.
 *
 * @param line - The items on one line, already flexed.
 * @param axis - Which way the container runs.
 * @param containing - The container's content width, which is what a percentage
 * on one of these items resolves against, or `undefined` when the container's own
 * width is not settled. Not the item's own used width, which is the other
 * argument and a different question.
 * @param definite - Whether the main size an item ended up with is the width it
 * will really be placed at. True from the placement; the measure's own
 * settledness when it is the caller, since a share of a guess is a guess.
 * @param cache - The measurements taken so far, so this costs a lookup.
 */
function remeasureLine(
	line: Item[],
	axis: Axis,
	containing: number | undefined,
	definite: boolean,
	cache: MeasureCache
): void {
	if (axis.column) {
		return;
	}

	for (const item of line) {
		// a box whose children wrap has the same dependency a text does: its height
		// is a question about its width, and the width is not known until flexing
		// has settled. A paragraph -- a wrapping row of words -- came out one line
		// tall for that reason, measured at the `flex-basis: 0` it starts from
		// rather than at the remainder it was given. A childless box has a height
		// that cannot move, which is why it is the one case skipped
		const dependsOnWidth = item.node.measure !== undefined || (item.node.children?.length ?? 0) > 0;
		if (dependsOnWidth && !crossIsDeclared(item, axis)) {
			const measured = measure(
				item.node,
				{
					available: item.mainSize,
					containing,
					crossWidth: false,
					// the main size flexing settled on is the width this item is
					// placed at, which is the one thing this pass exists to say
					definite,
				},
				cache
			);
			item.crossSize = clamp(measured.height, item.minCross, item.maxCross);
			// and how *short* it can be at that same width, because a parent reports
			// that as its own minimum and reading it at the pre-flex width made the
			// minimum smaller than the height beside it
			item.minCrossSize = clamp(
				measured.minHeight ?? measured.height,
				item.minCross,
				item.maxCross
			);
		}
	}
}

function outerCross(item: Item, axis: Axis): number {
	const { margin } = item;
	return item.crossSize + (axis.column ? margin.left + margin.right : margin.top + margin.bottom);
}

/** The smallest cross-axis size an item can take, margins included. */
function outerMinCross(item: Item, axis: Axis): number {
	const { margin } = item;
	return (
		item.minCrossSize + (axis.column ? margin.left + margin.right : margin.top + margin.bottom)
	);
}

/**
 * Resolves a child's sizes before any flexing.
 *
 * Reached from `layoutChildren()`, which is placing these children, and from
 * `measureUncached()`, which is sizing a row around them. One function for both,
 * because an item built two ways is two answers to "what does this child ask
 * for" -- and the row whose measure disagreed with its own placement is the
 * defect that brought the second caller here.
 *
 * @param node - The child.
 * @param axis - Which way the container runs.
 * @param block - The containing block, and what is settled about it.
 * @param index - Where the child sits in the tree.
 * @param cache - Measurements taken so far this pass.
 * @returns The item, unplaced and unflexed.
 */
function makeItem(
	node: LayoutNode,
	axis: Axis,
	block: Block,
	index: number,
	cache: MeasureCache
): Item {
	const style = node.style;
	// against the width, whichever axis this is: that is what CSS does, and
	// resolving against the main axis made the same declaration mean one thing at
	// measure time and another at placement
	const margin = margins(style, block.containing);

	// `insets()` already answers for this axis, so these are its answers. Swapping
	// them again gave a row container the *vertical* inset as its main one, and a
	// `content-box` child with `padding-left` came out three rows tall
	const inset = insets(style, axis);
	const mainInset = inset.main;
	const crossInset = inset.cross;

	const minCross = axis.column
		? outerSize(style, resolve(style.minWidth, block.containing), crossInset)
		: outerSize(style, resolve(style.minHeight, block.height), crossInset);
	const maxCross = axis.column
		? outerSize(style, resolve(style.maxWidth, block.containing), crossInset)
		: outerSize(style, resolve(style.maxHeight, block.height), crossInset);

	// measured at the room there is, and told whether the width is this
	// container's cross axis. `measure()` applies the child's own width limits
	// itself, because it is the one that resolves them and the base they resolve
	// against is the width handed in -- clamping here as well would resolve a
	// percentage limit against a width that limit had already narrowed.
	//
	// The flag is what makes the answer the column's: a column's width is the
	// cross axis, which does not flex, so the limits settle it now. A row's is the
	// main axis, whose used width is not known until `resolveFlexible()` has run
	// and whose basis has to stay the *unclamped* content size for the flex
	// algorithm to do the clamping -- so a row measures wide here and is
	// re-measured by `remeasureLine()` at the width flexing gave it. Measured at the
	// container's width regardless, a `max-width: 6` text in a twenty-wide column
	// was two rows tall and placed six wide, where it needs six
	const room = Math.max(0, block.width - margin.left - margin.right);
	// the room is what is left after this child's own margins; the containing
	// block is the whole content box, which is what every other percentage in this
	// function resolves against. They used to be one argument, so a `width: 50%`
	// on a child with a margin meant one thing here and another four lines down
	const measured = measure(
		node,
		{
			available: room,
			containing: block.containing,
			crossWidth: axis.column,
			// a column's child is placed at the width handed in; a row's child gets a
			// share of it that `resolveFlexible()` has not decided yet. And neither is
			// placed at a width anything can rely on while the block itself is a guess,
			// which is the half only the measure's caller knows
			definite: axis.column && block.definite,
		},
		cache
	);

	const declaredMain = outerSize(
		style,
		axis.column ? resolve(style.height, block.height) : resolve(style.width, block.containing),
		mainInset
	);
	const basisLength = style.flexBasis;
	const basisResolved =
		basisLength.type === 'auto' || basisLength.type === 'none'
			? declaredMain
			: outerSize(
					style,
					resolve(basisLength, axis.column ? block.height : block.containing),
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
			? outerSize(style, resolve(style.minHeight, block.height), mainInset)
			: outerSize(style, resolve(style.minWidth, block.containing), mainInset)) ?? automaticMin;

	const maxMain = axis.column
		? outerSize(style, resolve(style.maxHeight, block.height), mainInset)
		: outerSize(style, resolve(style.maxWidth, block.containing), mainInset);

	const declaredCross = outerSize(
		style,
		axis.column ? resolve(style.width, block.containing) : resolve(style.height, block.height),
		crossInset
	);
	const contentCross = axis.column ? measured.width : measured.height;

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
		measured,
		// the content's own minimum rather than `declaredCross ?? ...`, because
		// `measureUncached()` has already taken the declaration into account: a box
		// with `height: 5` around two rows of content reports `minHeight: 2`, which is
		// exactly how short it can be made
		minCrossSize: clamp(
			axis.column ? (measured.minWidth ?? measured.width) : (measured.minHeight ?? measured.height),
			minCross,
			maxCross
		),
		maxCross,
		maxMain,
		minCross,
		minMain,
		node,
		style,
	};
}

/**
 * An item's margins along the main axis.
 *
 * Written once because the three functions below all give them back *outside*
 * their clamp -- the basis and the limits are border-box sizes -- and three
 * copies of one conditional is three chances to take the cross axis's pair.
 *
 * @param item - The item.
 * @param axis - Which way the main axis runs.
 * @returns The cells its margins take on that axis.
 */
function mainMargins(item: Item, axis: Axis): number {
	return axis.column ? item.margin.top + item.margin.bottom : item.margin.left + item.margin.right;
}

/**
 * The main size an item would take if nothing flexed: its basis clamped to its
 * own limits, plus its margins.
 *
 * CSS's hypothetical main size, and the one number five readers need to agree
 * about. `wrapIntoLines()` decides which line an item lands on by it; the measure
 * sizes a wrapping row by the longest line it packs into, and by the widest single
 * item for its minimum; and it is what both functions below fall back to, since an
 * item that can neither grow nor shrink ends up here whatever room there is. Read
 * five ways it is five chances to disagree, and there used to be a second copy of
 * the arithmetic inside the measure where `packLines()` was handed the sizes it had
 * just taken.
 *
 * Margins are included because they take room on the line: a five-wide item with a
 * two-wide margin takes seven, and deciding on five put two of them on a ten-wide
 * line.
 *
 * @param item - The item.
 * @param axis - Which way the main axis runs.
 * @returns The cells it asks for along the main axis, margins included.
 */
function hypotheticalMain(item: Item, axis: Axis): number {
	return clamp(item.basis, item.minMain, item.maxMain) + mainMargins(item, axis);
}

/**
 * The most main-axis room an item would use, given all of it.
 *
 * CSS's max-content contribution, as far as it is worth reading here, and the
 * distinction it turns on is between the basis an item flexes *from* and the size
 * it would end up at. An item that cannot grow ends at its hypothetical size
 * whatever room there is, so that is its contribution. One that can grow will take
 * its content's max-content size if it is offered, so that is the floor under its
 * basis -- without which a `flex-basis: 0; flex-grow: 1` description contributes
 * nothing and the row it is in reports its own min-content width.
 *
 * Only a nowrap row sums it. A wrapping row is measured by the longest line it
 * packs into and has to be measured by the number that packed it, which is
 * `hypotheticalMain()`.
 *
 * @param item - The item.
 * @param axis - Which way the main axis runs.
 * @returns The cells it would use, margins included.
 */
function maxContentMain(item: Item, axis: Axis): number {
	if (item.style.flexGrow <= 0) {
		return hypotheticalMain(item, axis);
	}

	const content = axis.column ? item.measured.height : item.measured.width;
	return clamp(Math.max(content, item.basis), item.minMain, item.maxMain) + mainMargins(item, axis);
}

/**
 * The smallest main size an item can be placed at.
 *
 * `resolveFlexible()`'s floor said as a function, and it has the same two halves
 * that has: an item that cannot shrink is frozen at its hypothetical size, so it
 * takes what it asked for however little room there is, and everything else is
 * shrunk towards its own clamped minimum and no further. Written as a `clamp()`
 * from zero rather than as `item.minMain ?? 0` because that is what the placement
 * ends with, `min` beating `max` included.
 *
 * Only a nowrap row sums it, and it is what keeps SIG-126 from being half fixed:
 * a minimum that took every item's clamped floor would report zero for a
 * `flex-shrink: 0` child, which squeezes the row back to nothing and draws that
 * child outside it -- the defect the width fix is for, arriving through the
 * minimum instead.
 *
 * @param item - The item.
 * @param axis - Which way the main axis runs.
 * @returns The fewest cells it can be placed in, margins included.
 */
function minimumMain(item: Item, axis: Axis): number {
	return item.style.flexShrink <= 0
		? hypotheticalMain(item, axis)
		: clamp(0, item.minMain, item.maxMain) + mainMargins(item, axis);
}

/** Breaks items into lines that fit, for `flex-wrap`. */
function wrapIntoLines(items: Item[], mainSpace: number, gap: number, axis: Axis): Item[][] {
	const lines: Item[][] = [];
	let current: Item[] = [];
	let used = 0;

	for (const item of items) {
		const size = hypotheticalMain(item, axis);
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
	/** What an out-of-flow descendant of these children is placed against. */
	frames: Frames;
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
	const { axis, cache, content, crossOffset, crossSize, frames, gap, mainSpace, results, style } =
		opts;

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

		// a row item measuring text has already been re-measured at the main size
		// flexing settled on, by `remeasureLine()` -- which runs there rather than
		// here because the line's cross size is taken from `item.crossSize` and the
		// next line starts after it. Read back rather than measured again, so the
		// height a line was sized for and the height its item is placed at cannot
		// come to disagree
		let itemCross = item.crossSize;
		if (align === 'stretch' && !crossIsDeclared(item, axis)) {
			// content that measures cannot be crushed below the height it wrapped
			// to, because the rows past the bottom of the box are simply lost. A
			// box can be, and its children overflow it instead. A column's cross
			// size is its width, which `makeItem()` settled and stretching is
			// entitled to widen, so this is the row's rule only
			itemCross =
				!axis.column && item.node.measure ? Math.max(roomCross, item.crossSize) : roomCross;
		}
		itemCross = clamp(itemCross, item.minCross, item.maxCross);

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

		// `position: relative` moves the box after the flow has decided where it
		// goes, so it is added to the placement and to nothing else -- the cursor
		// below advances from `mainStart`, which is where the box would have been
		const offset = relativeOffset(item.style, content.width, content.height);

		results.push({
			index: item.index,
			result: layoutNode(
				item.node,
				childWidth,
				childHeight,
				childX + offset.x,
				childY + offset.y,
				cache,
				frames
			),
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
