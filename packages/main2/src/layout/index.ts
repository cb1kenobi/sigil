/**
 * The layout engine: a flexbox subset over whole cells.
 *
 * Ours rather than borrowed. ink uses Yoga, which is a native/WASM dependency,
 * and zero dependencies rules that out -- so this file's existence is the price
 * of the constraint rather than a preference.
 *
 * Two passes. `measureNode()` asks what a subtree would take if it could have
 * whatever it wanted, bottom-up; `layout()` hands out what there actually is,
 * top-down. Text measures through whatever `measure` a node carries, which is
 * where `stringWidth()` and `wrap()` get involved without this module knowing
 * about either.
 *
 * ```js
 * import { layout } from 'main2/layout';
 * import { declare } from 'main2/style';
 *
 * const tree = {
 *   style: declare({ 'flex-direction': 'row', gap: '1' }),
 *   children: [
 *     { style: declare({ width: '10' }) },
 *     { style: declare({ 'flex-grow': '1' }) },
 *   ],
 * };
 *
 * const result = layout(tree, { width: 40, height: 3 });
 * result.children[1].box; // { x: 11, y: 0, width: 29, height: 3 }
 * ```
 *
 * Everything is an integer. That sounds simpler than the browser's model and is
 * in fact the hard part: distributing seven leftover columns across three
 * children means somebody gets three and somebody gets two, and the rule for who
 * has to be stable, because a layout that reshuffles its rounding between frames
 * shimmers. Every division goes through `distribute()`.
 */

export { layout, type LayoutOptions, measureNode } from './flex.js';
export {
	type Box,
	borderWidth,
	clamp,
	distribute,
	type LayoutNode,
	type LayoutResult,
	type Measurement,
	resolve,
} from './node.js';
