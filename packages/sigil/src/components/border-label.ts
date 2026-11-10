/**
 * A label set into a border: what `note()` titles itself with and what a `Panel`
 * titles, annotates and foots itself with.
 *
 * The paint pass draws a border as a whole and has no notion of a label, so a
 * label is an out-of-flow `text` one row over the edge -- `top: -1` or
 * `bottom: -1` against a `position: relative` box, whose containing block is the
 * padding box and so lands on the border row. It takes no space from what is
 * inside, and it covers the rule cells it sits on rather than being drawn into
 * them, which is why a label carries a space either side: padding paints
 * nothing, so a cell with no content would let the border character show through
 * and run into the words. The spaces are ordinary ones: a `nowrap` text keeps the
 * whitespace at both ends of its line, where a wrapping one drops it at the end.
 *
 * This file is the arithmetic and the element; what a label *says* is the
 * caller's, and arrives already cleaned by `labelLine()`.
 */

import { type Element, type ElementProps, text as textNode } from '../element/index.js';
import { stringWidth } from '../width/index.js';
import { ELLIPSIS, truncate } from '../wrap/index.js';

/** Which border row a label sits in. */
export type BorderEdge = 'bottom' | 'top';

/** Where along a border a label sits. */
export type BorderAlign = 'center' | 'left' | 'right';

/**
 * The fewest cells of border a label can have: a space, one column of text and a
 * space. Under it a border is plain.
 */
export const BORDER_RUN_MIN = 3;

/**
 * The cells of a border that labels may use: the width less a corner and a rule
 * cell at each end.
 *
 * @param width - The border box's width.
 * @returns The run, never negative.
 */
export function borderRun(width: number): number {
  return Math.max(0, Math.floor(width) - 4);
}

/**
 * A label as it is drawn: a space, the text cut to what fits, and a closing space.
 *
 * The text is cut with an ellipsis rather than clipped, so a reader can tell it
 * was.
 *
 * @param label - The label, already one line of plain text.
 * @param run - The cells it may take, spaces included.
 * @returns The label to draw, or `''` for a blank one or one with no room.
 */
export function borderLabelText(label: string, run: number): string {
  if (label === '' || run < BORDER_RUN_MIN) {
    return '';
  }

  const cut = truncate(label, run - 2, 'ellipsis');

  // a label cut down to the mark that says it was cut says nothing at all, and a
  // border that is plain is more honest than one with an ellipsis in it
  return cut === ELLIPSIS && label !== ELLIPSIS ? '' : ` ${cut} `;
}

/** Where a label sits: one of the three alignments, or a cell offset along the border. */
export interface BorderPlace {
  align?: BorderAlign;
  /** Cells from the first label cell (the third of the border), when `align` is not used. */
  offset?: number;
}

/**
 * The props that put a text on a border row.
 *
 * Both are the same declarations in the one place they are written. The three
 * alignments are insets -- `left`, `right`, or both with `text-align: center` --
 * and an `offset` is a `left` of one cell more, since the first label cell is the
 * one after the rule cell.
 *
 * @param edge - The row.
 * @param place - The alignment, or the offset.
 * @returns The props, with the ones this placement does not use set to `undefined`
 *   so that applying them to an element already placed elsewhere clears them.
 */
export function borderLabelProps(edge: BorderEdge, place: BorderPlace): ElementProps {
  const align = place.align ?? 'left';
  const offset = place.offset;

  return {
    [edge === 'top' ? 'top' : 'bottom']: -1,
    [edge === 'top' ? 'bottom' : 'top']: undefined,
    left:
      offset === undefined
        ? align === 'right'
          ? undefined
          : align === 'left'
            ? 1
            : 0
        : offset + 1,
    position: 'absolute',
    right:
      offset === undefined ? (align === 'left' ? undefined : align === 'right' ? 1 : 0) : undefined,
    'text-align': offset === undefined && align === 'center' ? 'center' : undefined,
    'white-space': 'nowrap',
  };
}

/**
 * A label on a border, as an element.
 *
 * @param label - What to draw, already formatted by {@link borderLabelText}.
 * @param edge - The row.
 * @param place - Where along it.
 * @param className - The element's classes.
 * @returns The out-of-flow text.
 */
export function borderLabel(
  label: string,
  edge: BorderEdge,
  place: BorderPlace,
  className: string
): Element {
  return textNode(label, { class: className, ...borderLabelProps(edge, place) });
}

/** One label of a border, ready to draw. */
export interface PlacedLabel {
  /** The cells from the first label cell, which {@link borderLabelProps} takes as `offset`. */
  offset: number;
  /** What to draw, or `''` for none. */
  text: string;
}

/** Both labels of one border row. */
export interface BorderFit {
  /** The label at the right end. */
  end: PlacedLabel;
  /** The main label, which `align` places. */
  start: PlacedLabel;
}

const NONE: PlacedLabel = Object.freeze({ offset: 0, text: '' });

/**
 * Lays one border row's labels out for a width.
 *
 * Each border is on its own: the top row's labels never affect the bottom row's.
 * Where there is not room, the right-hand label -- the annotation -- is dropped
 * first, then the main label is cut with an ellipsis, and at the extreme the
 * border is plain. The annotation sits at the right end. A right-aligned main
 * label packs against it rather than under it, and a centered one stays centered
 * and costs the annotation its place if the two would touch. One rule cell at
 * least separates them.
 *
 * An annotation with no main label is the only label there is and is cut rather
 * than dropped.
 *
 * @param width - The border box's width.
 * @param start - The main label, as `labelLine()` leaves it.
 * @param end - The annotation, likewise.
 * @param align - Where the main label sits.
 * @returns What to draw, and where.
 */
export function fitBorder(
  width: number,
  start: string,
  end: string,
  align: BorderAlign
): BorderFit {
  const run = borderRun(width);
  if (run < BORDER_RUN_MIN || (start === '' && end === '')) {
    return { end: NONE, start: NONE };
  }

  if (start === '') {
    const text = borderLabelText(end, run);
    return { end: { offset: run - stringWidth(text), text }, start: NONE };
  }

  const main = borderLabelText(start, run);
  const mainWidth = stringWidth(main);
  const note = end === '' ? '' : borderLabelText(end, run);
  const noteWidth = stringWidth(note);

  // together only if both are whole and a rule cell is left between them, and a
  // centered main label must also clear the annotation from where it centers
  const centered = Math.floor((run - mainWidth) / 2);
  const together =
    note !== '' &&
    mainWidth + 1 + noteWidth <= run &&
    (align !== 'center' || centered + mainWidth + 1 <= run - noteWidth);

  if (!together) {
    const offset = align === 'left' ? 0 : align === 'right' ? run - mainWidth : centered;
    return { end: NONE, start: { offset: Math.max(0, offset), text: main } };
  }

  const endOffset = run - noteWidth;
  const offset = align === 'left' ? 0 : align === 'right' ? endOffset - 1 - mainWidth : centered;

  return {
    end: { offset: endOffset, text: note },
    start: { offset: Math.max(0, offset), text: main },
  };
}
