/**
 * The preview column: whatever `readPreview()` read, drawn in a scroll box at the
 * size the layout gave it.
 *
 * Shared by both roots, as a component each of them names -- `<PreviewPane />` in
 * JSX and `<${PreviewPane} />` in the tag -- because it is built from elements
 * and effects and a template would say nothing about it. The git client's diff
 * pane is the same shape for the same reason.
 *
 * `markdownView()` folds for a width it is told and `imageView()` is best asked for
 * a size, so the pane learns its size from the scroll box's `onResize` and builds
 * its rows again when the size or the preview changes. Text is not folded: a line
 * is cut at the pane's edge, the way a pager shows code, and a tab is spaces to the
 * next stop of four.
 */

import { entryClass, entryLabel } from './common.ts';
import { printable } from './files.ts';
import type { PreviewFor } from './preview.ts';
import {
  highlightCode,
  imageView,
  markdownView,
  ScrollBox,
  type ScrollControl,
  scrollControl,
} from '@ttylabs/sigil/components';
import { box, type Element, text } from '@ttylabs/sigil/element';
import { createEffect } from '@ttylabs/sigil/renderer';
import type { State } from '@ttylabs/sigil/signals';
import { untrack } from '@ttylabs/sigil/signals';
import { TOKEN_ROLE } from '@ttylabs/sigil/theme';
import { graphemes, stringWidth } from '@ttylabs/sigil/width';

export interface PreviewPaneProps {
  /** What to show. */
  readonly preview: State<PreviewFor>;
}

/** Where a tab goes to: the next multiple of this column. */
const TAB = 4;

/**
 * Builds the preview pane.
 *
 * @param props - The preview.
 * @returns The scroll box, which is what takes the focus to be scrolled.
 */
export function PreviewPane(props: PreviewPaneProps): Element {
  const { preview } = props;
  const body = box({ class: 'preview-body', 'flex-direction': 'column' });
  let width = 0;
  let height = 0;
  let shown = '';
  let control: ScrollControl | undefined;

  /** A row of prose the full width of the pane, cut rather than wrapped. */
  const line = (value: string, className = ''): Element =>
    text(printable(value), {
      class: className,
      'flex-shrink': 0,
      'text-overflow': 'ellipsis',
      'white-space': 'pre',
      width,
    });

  const build = (what: PreviewFor): void => {
    const rows: Element[] = [];
    const shownNow = what.preview;
    switch (shownNow.kind) {
      case 'note': {
        rows.push(line(shownNow.note, shownNow.role === 'error' ? 'sigil-error' : 'sigil-muted'));
        break;
      }
      case 'directory': {
        if (!shownNow.entries.length) {
          rows.push(line(shownNow.total ? '' : 'An empty directory', 'sigil-muted'));
        }
        for (const entry of shownNow.entries) {
          rows.push(line(entryLabel(entry), entryClass(entry)));
        }
        if (shownNow.total > shownNow.entries.length) {
          rows.push(
            line(`... and ${shownNow.total - shownNow.entries.length} more`, 'sigil-muted')
          );
        }
        break;
      }
      case 'text': {
        rows.push(...codeRows(shownNow.text, shownNow.lang, width));
        if (shownNow.cut) {
          rows.push(line('... the rest of the file is not shown', 'sigil-muted'));
        }
        break;
      }
      case 'markdown': {
        // the app's highlighter for the code blocks, which markdown leaves plain
        // unless it is handed one
        rows.push(markdownView(shownNow.text, { highlight: highlightCode, width }).element);
        if (shownNow.cut) {
          rows.push(line('... the rest of the file is not shown', 'sigil-muted'));
        }
        break;
      }
      case 'image': {
        // no larger than the picture, so a 16-pixel icon is not blown up to the
        // whole pane, and no larger than the pane, so it is seen whole without
        // scrolling; `contain` keeps its proportions inside both
        const { image } = shownNow;
        const view = imageView(image, {
          fit: 'contain',
          height: Math.max(1, Math.min(height, Math.ceil(image.height / 2))),
          width: Math.max(1, Math.min(width, image.width)),
        });
        rows.push(view.element);
        break;
      }
    }

    for (const child of body.children.slice()) {
      child.remove();
    }
    body.append(...rows);
    const viewport = control?.viewport;
    if (viewport && what.path !== shown) {
      viewport.scrollTo(0, 0);
    }
    shown = what.path;
  };

  const host = ScrollBox({
    children: () => body,
    // the size is the layout's: built again when it changes, before the frame
    // paints, and answered as a change so the frame lays the new rows out
    onResize: (given) => {
      control = given;
      const viewport = given.viewport;
      const nextWidth = viewport.content?.width ?? viewport.box?.width ?? 0;
      const nextHeight = viewport.box?.height ?? 0;
      if ((nextWidth === width && nextHeight === height) || nextWidth <= 0) {
        return false;
      }
      width = nextWidth;
      height = nextHeight;
      build(untrack(() => preview.get()));
      return true;
    },
    props: { class: 'preview-pane', 'flex-grow': 1, 'min-height': 0 },
  });
  control = scrollControl(host);

  createEffect(() => {
    const what = preview.get();
    if (width > 0) {
      build(what);
    }
  });

  return host;
}

/**
 * Highlighted text, a row a line behind a gutter of line numbers, each row cut at
 * the width and drawn as runs of cells that share a token -- one element resolves
 * one style, which is how markdown draws a code block and `diff()` a line.
 *
 * @param source - The text, with only `\n` and `\t` left of the control characters.
 * @param lang - What `highlightCode()` is told the language is: the extension.
 * @param width - The pane's width.
 * @returns The rows.
 */
export function codeRows(source: string, lang: string | undefined, width: number): Element[] {
  const tokens: (string | undefined)[] = Array.from({ length: source.length });
  for (const span of highlightCode(source, lang)) {
    for (let at = Math.max(0, span.start); at < Math.min(source.length, span.end); at++) {
      tokens[at] = span.token;
    }
  }

  const lines = source.split('\n');
  const gutter = String(lines.length).length;
  const room = Math.max(1, width - gutter - 1);
  const rows: Element[] = [];
  let offset = 0;
  lines.forEach((value, n) => {
    const runs: { text: string; token: string | undefined }[] = [];
    let at = offset;
    let column = 0;
    for (const cluster of graphemes(value)) {
      const token = tokens[at];
      at += cluster.length;
      const drawn = cluster === '\t' ? ' '.repeat(TAB - (column % TAB)) : cluster;
      const cells = stringWidth(drawn);
      if (column + cells > room) {
        break;
      }
      column += cells;
      const last = runs.at(-1);
      if (last && last.token === token) {
        last.text += drawn;
      } else {
        runs.push({ text: drawn, token });
      }
    }
    offset += value.length + 1;

    rows.push(
      box(
        { class: 'code-row', 'flex-direction': 'row', 'flex-shrink': 0 },
        text(String(n + 1).padStart(gutter), {
          class: 'gutter sigil-muted',
          'flex-shrink': 0,
          'margin-right': 1,
          width: gutter,
        }),
        ...runs.map(({ text: value, token }) => {
          const role = token === undefined ? undefined : TOKEN_ROLE.get(token);
          const classes = ['code'];
          if (token !== undefined) {
            classes.push('sigil-token', `sigil-token-${token}`);
          }
          if (role !== undefined) {
            classes.push(role);
          }
          return text(value, {
            class: classes.join(' '),
            'flex-shrink': 0,
            'white-space': 'pre',
            width: stringWidth(value),
          });
        })
      )
    );
  });
  return rows;
}
