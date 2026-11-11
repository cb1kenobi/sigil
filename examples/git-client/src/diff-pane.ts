/**
 * The diff pane: whatever is selected, drawn by `diffView()` in a scroll box,
 * with a mark down the left of the hunk the cursor is on.
 *
 * Shared by both roots, as a component each of them names -- `<DiffPane />` in
 * JSX and `<${DiffPane} />` in the tag -- because it is built the way a
 * component built **on** others is, with elements and effects, and has nothing
 * a template would say better.
 *
 * `diffView()` draws a diff for a width it is given, folding long lines by
 * columns, and has no view of its own that scrolls or that learns its width from
 * the layout. So this learns the width from the scroll box's `onResize` and
 * builds the rows again whenever the width or the content changes. That is the
 * stateful view the diff entry in `packages/sigil/src/components/AGENTS.md` leaves
 * out, written in an app; SIG-367 is the ticket for one in the library.
 */

import { type DiffContent, type DiffState, hunkRefs } from './model.ts';
import { patchText } from './parse.ts';
import {
  diffView,
  ScrollBox,
  type ScrollControl,
  scrollControl,
  unicodeSupported,
} from '@ttylabs/sigil/components';
import { box, type Element, text } from '@ttylabs/sigil/element';
import { createEffect } from '@ttylabs/sigil/renderer';
import { untrack } from '@ttylabs/sigil/signals';

export interface DiffPaneProps {
  /** What to show, and the hunk cursor. */
  readonly diff: DiffState;
}

/** One hunk's rows: where they start, where they end, and their marks. */
interface Drawn {
  readonly first: number;
  readonly last: number;
  readonly marks: readonly Element[];
}

/**
 * Builds the diff pane.
 *
 * @param props - The model's diff.
 * @returns The scroll box, which is what takes the focus.
 */
export function DiffPane(props: DiffPaneProps): Element {
  const { content, cursor } = props.diff;
  const body = box({ class: 'diff-body', 'flex-direction': 'column' });
  const glyph = unicodeSupported() ? '▌' : '>';

  let width = 0;
  let drawn: Drawn[] = [];
  let shown = '';
  let lit = -1;
  let control: ScrollControl | undefined;

  /** A row of prose the full width of the pane, cut rather than wrapped. */
  const line = (value: string, className: string): Element =>
    text(value, {
      class: className,
      'flex-shrink': 0,
      'text-overflow': 'ellipsis',
      'white-space': 'pre',
      width,
    });

  /** Builds every row for the width the layout gave. */
  const build = (what: DiffContent): void => {
    const rows: Element[] = [];
    const hunks: { first: number; last: number; marks: Element[] }[] = [];
    let open: { first: number; last: number; marks: Element[] } | undefined;
    const begin = (): void => {
      open = { first: rows.length, last: rows.length, marks: [] };
      hunks.push(open);
    };
    // every row goes in behind a one-cell mark, which is blank unless its hunk
    // has the cursor -- so a row of the diff is the pane's width less one
    const push = (row: Element, inHunk = true): void => {
      const mark = text(' ', { class: 'hunk-mark sigil-accent', 'flex-shrink': 0, width: 1 });
      if (inHunk && open) {
        open.marks.push(mark);
        open.last = rows.length;
      }
      rows.push(box({ class: 'diff-line', 'flex-direction': 'row', 'flex-shrink': 0 }, mark, row));
    };
    const room = Math.max(1, width - 1);
    /** The rows of one `diffView()`, a hunk begun at each hunk header. */
    const view = (element: Element, oneHunk: boolean): void => {
      if (oneHunk) {
        begin();
      }
      // a copy, since each row is moved out of the view into a line of the pane's
      for (const row of element.children.slice()) {
        const classes = row.classes;
        if (classes.includes('sigil-diff-file')) {
          push(row, false);
          continue;
        }
        if (!oneHunk && classes.includes('sigil-diff-hunk')) {
          begin();
        }
        push(row);
      }
    };

    if (!what.sections.length) {
      push(line(what.note, 'sigil-muted'), false);
    }
    for (const section of what.sections) {
      open = undefined;
      push(line(section.label, 'diff-section sigil-heading'), false);
      if (section.added === undefined && !section.files.length && section.path !== undefined) {
        // a whole file with nothing to draw: its lines are the hunk
        begin();
      }
      for (const value of section.lines) {
        push(line(value, ''));
      }
      if (section.added !== undefined) {
        const added = diffView(
          { new: section.added.text, newName: section.added.path, old: '', oldName: '/dev/null' },
          { width: room }
        );
        view(added.element, true);
      }
      for (const file of section.files) {
        open = undefined;
        if (!file.hunks.length && !file.cut) {
          begin();
          push(
            line(
              `${file.path}: ${file.binary ? 'binary, not shown' : 'no lines changed'}`,
              'sigil-muted'
            )
          );
          continue;
        }
        view(diffView({ patch: patchText(file) }, { width: room }).element, false);
        if (file.cut) {
          open = undefined;
          push(line('... the rest of this diff is too long to show', 'sigil-muted'), false);
        }
      }
    }

    for (const child of body.children.slice()) {
      child.remove();
    }
    body.append(...rows);
    drawn = hunks;
    // the model counts the hunks one way and this draws them another, so a
    // disagreement is a mark on the wrong rows: said loudly rather than drawn
    const counted = hunkRefs(what).length;
    if (counted !== drawn.length) {
      throw new Error(`The diff pane drew ${drawn.length} hunks where the model has ${counted}`);
    }
    lit = -1;
    const viewport = control?.viewport;
    if (viewport && what.key !== shown) {
      viewport.scrollTo(0, 0);
    }
    shown = what.key;
    light(untrack(() => cursor.get()));
  };

  /** Marks the hunk the cursor is on, and scrolls it into view. */
  const light = (at: number): void => {
    if (at === lit) {
      return;
    }
    for (const mark of drawn[lit]?.marks ?? []) {
      mark.setText(' ');
    }
    lit = at;
    const hunk = drawn[at];
    if (!hunk) {
      return;
    }
    for (const mark of hunk.marks) {
      mark.setText(glyph);
    }
    const viewport = control?.viewport;
    const height = viewport?.content?.height ?? viewport?.box?.height ?? 0;
    if (!viewport || height <= 0) {
      return;
    }
    const top = viewport.scroll?.y ?? 0;
    if (hunk.first < top) {
      viewport.scrollTo(0, hunk.first);
    } else if (hunk.last >= top + height) {
      viewport.scrollTo(0, Math.min(hunk.first, hunk.last - height + 1));
    }
  };

  const host = ScrollBox({
    children: () => body,
    // the width is the layout's: built again when it changes, before the frame
    // paints, and answered as a change so the frame lays the new rows out
    onResize: (given) => {
      control = given;
      const next = given.viewport.content?.width ?? given.viewport.box?.width ?? 0;
      if (next === width || next <= 0) {
        return false;
      }
      width = next;
      build(untrack(() => content.get()));
      return true;
    },
    props: { class: 'diff-pane', 'flex-grow': 1, 'min-height': 0 },
  });
  control = scrollControl(host);

  createEffect(() => {
    const what = content.get();
    if (width > 0) {
      build(what);
    }
  });
  createEffect(() => {
    light(cursor.get());
  });

  return host;
}
