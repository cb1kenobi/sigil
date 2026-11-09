/**
 * A panel: a bordered region with words set into its border.
 *
 * The frame of a dashboard, a file manager or a log viewer. `title` sits in the
 * top border, `annotation` at its right end, and `footer` and `footerAnnotation`
 * do the same along the bottom:
 *
 * ```js
 * import { Panel } from '@ttylabs/sigil/components/panel';
 *
 * Panel(
 *   {
 *     title: () => `processes · ${rows.get().length} of ${total.get()}`,
 *     annotation: () => `sort: ${sort.get()}`,
 *     footer: '↑↓ select · s sort',
 *   },
 *   table
 * );
 * ```
 *
 * ```
 * ╭─ processes · 12 of 340 ──────── sort: cpu ─╮
 * │ pid   name            cpu   mem            │
 * ╰─ ↑↓ select · s sort ────────── 1–4 of 340 ─╯
 * ```
 *
 * Each label is a string or a function of signals, and a function is re-read when
 * what it reads changes. When a border is too narrow, that border's annotation
 * goes first, then its label is cut with an ellipsis, and at the extreme the
 * border is plain. The top and the bottom are each on their own.
 *
 * The border is the box's own, so its colour is a theme's to set. The content
 * sits in a box of its own that clips: `overflow: hidden` clips to the padding
 * box, which would take the labels away with it if it were on the panel.
 */

import { box, type Element, type ElementProps, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { createEffect } from '../renderer/index.js';
import {
  type BorderAlign,
  type BorderEdge,
  borderLabelProps,
  type BorderFit,
  fitBorder,
  type PlacedLabel,
} from './border-label.js';
import { labelLine, type NoteBorder, unicodeSupported } from './note.js';

/** A label: the text, or a function that says it and is re-read when what it reads changes. */
export type PanelLabel = string | (() => string);

export interface PanelProps {
  /**
   * Draw the border with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule `note()` and the modal keep.
   */
  ascii?: boolean;
  /** Set into the top border at its right end. Dropped first where the border is narrow. */
  annotation?: PanelLabel;
  /** The border's character set. Defaults to `round`, or `ascii` where `ascii` says so. */
  border?: NoteBorder;
  /** Extra classes for the panel, beside `sigil-panel`. */
  class?: string;
  /** The content, for a template, which passes it here rather than as arguments. */
  children?: Element | readonly Element[];
  /** Set into the bottom border at its left end. */
  footer?: PanelLabel;
  /** Set into the bottom border at its right end. Dropped first where the border is narrow. */
  footerAnnotation?: PanelLabel;
  /** The panel's own props: a size, a margin, a flex factor. They win over the defaults. */
  props?: ElementProps;
  /** Set into the top border. */
  title?: PanelLabel;
  /** Where the title sits in the top border. Defaults to `left`. */
  titleAlign?: BorderAlign;
}

/** The four places a label can be. */
type Slot = 'annotation' | 'footer' | 'footerAnnotation' | 'title';

const SLOTS: readonly Slot[] = ['title', 'annotation', 'footer', 'footerAnnotation'];

/**
 * Builds a panel.
 *
 * It grows to fill its slot, as a panel in a layout nearly always means to. That is
 * a rule in the framework sheet (`.sigil-panel { flex-grow: 1 }`), so a stylesheet
 * says otherwise as well as `props: { 'flex-grow': 0 }` does -- a panel used as a card
 * in a column is `.card { flex-grow: 0 }`.
 *
 * @param props - The labels, the border, and the host's own props.
 * @param children - What goes inside.
 * @returns The panel.
 */
export function Panel(props: PanelProps = {}, ...children: Element[]): Element {
  for (const slot of SLOTS) {
    const label = props[slot];
    if (label !== undefined && typeof label !== 'string' && typeof label !== 'function') {
      throw new TypeError(__`Expected a panel ${slot} to be a string or a function`);
    }
  }
  if (props.titleAlign !== undefined && !['center', 'left', 'right'].includes(props.titleAlign)) {
    throw new TypeError(__`Expected a panel titleAlign to be left, center or right`);
  }

  const align = props.titleAlign ?? 'left';

  /** What each slot says now, as `labelLine()` leaves it. */
  const said: Record<Slot, string> = {
    annotation: '',
    footer: '',
    footerAnnotation: '',
    title: '',
  };
  /** What each text element shows, so a layout that changed nothing changes nothing. */
  const shown = new Map<Element, { edge: BorderEdge; offset: number; text: string }>();

  const label = (name: string, edge: BorderEdge, role: string): Element => {
    const el = textNode('', {
      class: `sigil-panel-${name} ${role}`,
      ...borderLabelProps(edge, { offset: 0 }),
    });
    shown.set(el, { edge, offset: 0, text: '' });
    return el;
  };

  const elements: Record<Slot, Element> = {
    annotation: label('annotation', 'top', 'sigil-muted'),
    footer: label('footer', 'bottom', 'sigil-muted'),
    footerAnnotation: label('footer-annotation', 'bottom', 'sigil-muted'),
    title: label('title', 'top', 'sigil-heading'),
  };

  const body = box(
    {
      class: 'sigil-panel-body',
      'flex-direction': 'column',
      'flex-grow': 1,
      'min-height': 0,
      'min-width': 0,
      overflow: 'hidden',
    },
    ...(props.children === undefined
      ? []
      : Array.isArray(props.children)
        ? props.children
        : [props.children as Element]),
    ...children
  );

  const host = box(
    {
      'border-style': props.border ?? ((props.ascii ?? !unicodeSupported()) ? 'ascii' : 'round'),
      'flex-direction': 'column',
      'min-height': 0,
      'min-width': 0,
      'padding-left': 1,
      'padding-right': 1,
      // the labels are out of flow, and their insets resolve against this box
      position: 'relative',
      ...props.props,
    },
    elements.title,
    elements.annotation,
    elements.footer,
    elements.footerAnnotation,
    body
  );
  host.addClass('sigil-panel');
  for (const name of String(props.class ?? '')
    .split(/\s+/)
    .filter(Boolean)) {
    host.addClass(name);
  }

  /** Draws one label where the fit put it, and says whether that changed anything. */
  const draw = (el: Element, fit: PlacedLabel): boolean => {
    const was = shown.get(el);
    if (
      was === undefined ||
      (was.text === fit.text && (fit.text === '' || was.offset === fit.offset))
    ) {
      return false;
    }
    shown.set(el, { edge: was.edge, offset: fit.offset, text: fit.text });
    el.setText(fit.text);
    el.setProps(borderLabelProps(was.edge, { offset: fit.offset }));
    return true;
  };

  /**
   * Fits the labels to the width the layout gave, which is the only time it is
   * known: a panel is as wide as its slot, so what a border can hold is a question
   * for after the layout and not before it.
   */
  const place = (): boolean => {
    const width = host.box?.width ?? 0;
    if (width <= 0) {
      return false;
    }
    const top: BorderFit = fitBorder(width, said.title, said.annotation, align);
    const bottom: BorderFit = fitBorder(width, said.footer, said.footerAnnotation, 'left');
    // not `||`, which would stop at the first label that changed
    let changed = draw(elements.title, top.start);
    changed = draw(elements.annotation, top.end) || changed;
    changed = draw(elements.footer, bottom.start) || changed;
    changed = draw(elements.footerAnnotation, bottom.end) || changed;
    return changed;
  };

  for (const slot of SLOTS) {
    const label = props[slot];
    if (typeof label === 'function') {
      createEffect(() => {
        said[slot] = labelLine(String(label() ?? ''));
        place();
      });
    } else {
      said[slot] = labelLine(String(label ?? ''));
    }
  }

  // after every layout that reached the panel, because a width this panel did not
  // choose is what decides what its border can say. Answers whether it changed the
  // tree, which is what asks for the layout the new text needs; the second pass finds
  // nothing to change and answers false
  host.onLayout = place;

  return host;
}
