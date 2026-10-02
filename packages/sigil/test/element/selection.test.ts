import {
	arrange,
	box,
	createTree,
	type Element,
	type ElementProps,
	raw,
	resolveStyles,
	selectableAt,
	text,
} from '../../src/element/index.js';
import type { Measurement } from '../../src/layout/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Which cells of a frame may be copied.
 *
 * The one thing a selection over the grid cannot answer for itself: a `raw`
 * element's cells are block characters rather than text, and a pane somebody
 * marked uncopyable is uncopyable.
 */

/** A `raw` that claims a size and paints nothing, which is all the mask needs. */
function sparkline(width: number, height: number, props: ElementProps = {}): Element {
	const measure = (): Measurement => ({
		height,
		minHeight: height,
		minWidth: width,
		width,
	});
	return raw({ measure, paint: () => {} }, props);
}

/** Arranges a tree and asks what may be copied. */
function mask(root: Element, width: number, height: number) {
	resolveStyles(root);
	arrange(root, { height, width });
	return selectableAt(root, width, height);
}

/** The columns of a row, as a string of `.` for yes and `-` for no. */
function row(
	allows: ((x: number, y: number) => boolean) | undefined,
	y: number,
	width: number
): string {
	let out = '';
	for (let x = 0; x < width; x++) {
		out += !allows || allows(x, y) ? '.' : '-';
	}
	return out;
}

describe('selectableAt', () => {
	it('should answer with nothing where there is nothing to exclude', () => {
		// a fast path rather than a claim: a mask of all ones is one allocation and
		// a lookup per cell to say what `undefined` says for free
		const root = box({ 'flex-direction': 'column' }, text('hello'), text('world'));
		expect(mask(root, 10, 2)).toBeUndefined();
	});

	it('should exclude a raw element by default', () => {
		// a sparkline or a half-block image is a wall of block characters nobody
		// wants in their clipboard
		const root = box({ 'flex-direction': 'column' }, text('abcd'), sparkline(4, 1));
		const allows = mask(root, 4, 2);
		expect(row(allows, 0, 4)).toBe('....');
		expect(row(allows, 1, 4)).toBe('----');
	});

	it('should include a raw element that says so', () => {
		const root = box(
			{ 'flex-direction': 'column' },
			text('abcd'),
			((it: Element) => it.setProp('selectable', true))(sparkline(4, 1))
		);
		const allows = mask(root, 4, 2);
		expect(row(allows, 1, 4)).toBe('....');
	});

	it('should exclude the whole subtree of a box that says so', () => {
		// which is what makes `selectable={false}` on a pane mean the pane
		const root = box(
			{ 'flex-direction': 'column' },
			text('keep'),
			box({ selectable: false }, text('drop'))
		);
		const allows = mask(root, 4, 2);
		expect(row(allows, 0, 4)).toBe('....');
		expect(row(allows, 1, 4)).toBe('----');
	});

	it('should let a descendant opt back in', () => {
		const root = box(
			{ 'flex-direction': 'column', selectable: false },
			text('drop'),
			text('keep', { selectable: true })
		);
		const allows = mask(root, 4, 2);
		expect(row(allows, 0, 4)).toBe('----');
		expect(row(allows, 1, 4)).toBe('....');
	});

	it('should write only where text and raw draw, so a transparent box over a raw changes nothing', () => {
		// the alternative -- every element stamping its own box -- marks a
		// sparkline's cells copyable because a box that painted nothing there
		// happened to be painted later
		const over = box({ height: 1, position: 'absolute', top: 0, width: 4 });
		const root = box({ 'flex-direction': 'column' }, sparkline(4, 1), over);
		const allows = mask(root, 4, 1);
		expect(row(allows, 0, 4)).toBe('----');
	});

	it('should ask the content box, so padding is not content', () => {
		const panel = box({ padding: '0 1', selectable: false }, text('ab'));
		const root = box({}, panel);
		const allows = mask(root, 4, 1);
		// the text sits at column 1 and is two wide; the padding either side is the
		// box's own decoration and stays copyable, which is what a terminal's
		// selection would hand over anyway
		expect(row(allows, 0, 4)).toBe('.--.');
	});

	it('should not reach outside the clip its element was drawn inside', () => {
		const pane = box({ overflow: 'hidden', width: 2 }, text('abcdef', { selectable: false }));
		const root = box({}, pane);
		const allows = mask(root, 6, 1);
		expect(row(allows, 0, 6)).toBe('--....');
	});

	it('should skip a display:none subtree, which is not on screen to be copied', () => {
		const root = box(
			{ 'flex-direction': 'column' },
			text('abcd'),
			box({ display: 'none', selectable: false }, text('hidden'))
		);
		expect(mask(root, 4, 1)).toBeUndefined();
	});

	it('should skip a hidden element rather than its subtree, because visibility inherits', () => {
		// paint's own rule, which the mask has to keep or copying and drawing
		// disagree about a hidden box's visible child. A hidden `raw` is not on
		// screen, so it excludes nothing -- there is no wall of block characters
		// there to keep out of the clipboard
		const hidden = box(
			{ 'flex-direction': 'column' },
			text('abcd'),
			sparkline(4, 1, { visibility: 'hidden' })
		);
		expect(mask(hidden, 4, 2)).toBeUndefined();

		// and a descendant that says `visible` is drawn, so its cells are excluded
		// however hidden the box around it said it was
		const revealed = box(
			{ 'flex-direction': 'column' },
			text('abcd'),
			box({ visibility: 'hidden' }, sparkline(4, 1, { visibility: 'visible' }))
		);
		const allows = mask(revealed, 4, 2);
		expect(row(allows, 0, 4)).toBe('....');
		expect(row(allows, 1, 4)).toBe('----');
	});

	it('should answer false for a cell off the grid', () => {
		const root = box({ 'flex-direction': 'column' }, text('abcd'), sparkline(4, 1));
		const allows = mask(root, 4, 2);
		expect(allows?.(-1, 0)).toBe(false);
		expect(allows?.(0, 9)).toBe(false);
	});
});

describe('Element.selectable', () => {
	it('should read back what was said and nothing more', () => {
		// three-valued on purpose: what a cell may be copied from is the subtree's
		// answer, which `selectableAt()` resolves with the boxes it needs
		expect(text('a').selectable).toBeUndefined();
		expect(text('a', { selectable: false }).selectable).toBe(false);
		expect(text('a', { selectable: true }).selectable).toBe(true);
		expect(
			raw({ measure: () => ({ height: 1, width: 1 }), paint: () => {} }).selectable
		).toBeUndefined();
	});

	it('should mark paint rather than classes or layout', () => {
		// no selector matches on it and no box moves; what changes is which cells
		// the overlay covers, which the paint pass draws
		const label = text('a');
		const root = box({}, label);
		const tree = createTree(root);
		tree.take();

		label.setProp('selectable', false);
		const marks = tree.take();
		expect([...marks.paint]).toEqual([label]);
		expect(marks.classes.size).toBe(0);
		expect(marks.layout.size).toBe(0);
	});

	it('should record nothing for a value that did not change', () => {
		const label = text('a', { selectable: false });
		const tree = createTree(box({}, label));
		tree.take();
		label.setProp('selectable', false);
		expect(tree.take().paint.size).toBe(0);
	});
});
