/**
 * The layout engine: a flexbox subset over whole cells.
 *
 * Ours rather than borrowed. ink uses Yoga, which is a native/WASM dependency,
 * and zero dependencies rules that out -- so this file's existence is the price
 * of the constraint rather than a preference.
 *
 * Two passes. `measureSubtree()` asks what a subtree would take if it could have
 * whatever it wanted, bottom-up; `layoutTree()` hands out what there actually is,
 * top-down. Text measures through whatever `measure` a node carries, which is
 * where `stringWidth()` and `wrap()` get involved without this module knowing
 * about either.
 *
 * ```js
 * import { layoutTree } from '@ttylabs/sigil/layout';
 * import { declare } from '@ttylabs/sigil/style';
 *
 * const tree = {
 *   style: declare({ 'flex-direction': 'row', gap: '1' }),
 *   children: [
 *     { style: declare({ width: '10' }) },
 *     { style: declare({ 'flex-grow': '1' }) },
 *   ],
 * };
 *
 * const result = layoutTree(tree, { width: 40, height: 3 });
 * result.children[1].box; // { x: 11, y: 0, width: 29, height: 3 }
 * ```
 *
 * Everything is an integer. That sounds simpler than the browser's model and is
 * in fact the hard part: distributing seven leftover columns across three
 * children means somebody gets three and somebody gets two, and the rule for who
 * has to be stable, because a layout that reshuffles its rounding between frames
 * shimmers. Every division goes through `distributeCells()`.
 */

export { layoutTree, type LayoutOptions, measureSubtree } from './flex.js';
export {
  type Box,
  borderCells,
  clampSize,
  distributeCells,
  type LayoutNode,
  type LayoutResult,
  type Measurement,
  resolveLength,
} from './node.js';
