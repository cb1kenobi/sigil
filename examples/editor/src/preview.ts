/**
 * The Markdown preview: the source drawn by `markdownView()` in a scroll box,
 * built again as it is typed.
 *
 * `markdownView()` lays a document out for a width it is told and has no view of
 * its own that learns its width from the layout -- the shape `diffView()` has,
 * and the git client's diff pane answers it the same way. So this learns the
 * width from the scroll box's `onResize` and builds the document again whenever
 * the width or the source changes.
 */

import {
  highlightCode,
  markdownView,
  ScrollBox,
  type ScrollControl,
  scrollControl,
} from '@ttylabs/sigil/components';
import { box, type Element, text } from '@ttylabs/sigil/element';
import { createEffect, onCleanup } from '@ttylabs/sigil/renderer';
import { type Computed, untrack } from '@ttylabs/sigil/signals';

export interface PreviewProps {
  /** The Markdown to draw, or `undefined` when there is nothing to preview. */
  readonly source: Computed<string | undefined>;
  /** Which document it is, so that switching to another scrolls back to the top. */
  readonly subject: Computed<string | undefined>;
}

/**
 * The longest source drawn again on the keystroke that changed it, in UTF-16
 * code units. Past it the preview waits for {@link PAUSE} ms of no typing first.
 *
 * What a preview costs is its element count, and it is paid twice. Building one
 * is `markdownView()` and then a layout of everything it made, and a frame lays
 * the whole tree out again whenever a text in it changed -- which a keystroke in
 * the text area beside it always does -- so a large preview slows every key even
 * when it is not being rebuilt. Measured on arm64 macOS as of this change, a key
 * in the editor with the preview showing: a 2 kB README, 6.5 ms drawn live; this
 * repository's 51 kB `examples/AGENTS.md`, about 9,000 elements, 145 ms drawn
 * live and 46 ms waiting for the pause. 16 kB is about where drawing it live
 * stops being the larger half.
 */
export const LIVE_LIMIT: number = 16 * 1024;

/** How long a long document's preview waits for the typing to stop. */
export const PAUSE: number = 200;

/**
 * The longest source previewed at all. The components' own decisions file, 919
 * kB and 170,000 elements, costs about a second a key with the preview up, every
 * key, because of the layout above -- and seven seconds to build. Past this the
 * preview says so rather than making the editor unusable.
 */
export const MAX_PREVIEW: number = 256 * 1024;

/**
 * Builds the preview.
 *
 * @param props - The source, and which document it is.
 * @returns The scroll box, which takes the focus to scroll with the keys.
 */
export function Preview(props: PreviewProps): Element {
  const body = box({ class: 'preview-body', 'flex-direction': 'column' });

  let width = 0;
  let control: ScrollControl | undefined;
  /** The document the preview last drew, so that only a new one scrolls to the top. */
  let shown: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Draws the source at the width the layout gave. */
  const build = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const source = untrack(() => props.source.get());
    const subject = untrack(() => props.subject.get());
    for (const child of body.children.slice()) {
      child.remove();
    }
    if (source !== undefined && source.length > MAX_PREVIEW) {
      body.append(
        text(
          `Too long to preview: ${Math.round(source.length / 1024)} kB, past ${MAX_PREVIEW / 1024} kB.`,
          { class: 'sigil-muted' }
        )
      );
    } else if (source !== undefined && width > 0) {
      // a code block in a README is highlighted by the lexer the source is
      body.append(markdownView(source, { highlight: highlightCode, width }).element);
    }
    if (subject !== shown) {
      control?.viewport.scrollTo(0, 0);
      shown = subject;
    }
  };

  const host = ScrollBox({
    children: () => body,
    // the width is the layout's: built again when it changes, before the frame
    // paints, and answered as a change so the frame lays the new tree out
    onResize: (given) => {
      control = given;
      const next = given.viewport.content?.width ?? given.viewport.box?.width ?? 0;
      if (next === width || next <= 0) {
        return false;
      }
      width = next;
      build();
      return true;
    },
    props: { class: 'preview', 'flex-grow': 1, 'min-height': 0 },
  });
  control = scrollControl(host);

  createEffect(() => {
    const source = props.source.get();
    const subject = props.subject.get();
    if (width <= 0) {
      return;
    }
    // a new document, or a short one, is drawn now; a long one being typed in
    // is drawn once the typing stops, so a key is not a rebuild as well
    if (source === undefined || subject !== shown || source.length <= LIVE_LIMIT) {
      build();
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(build, PAUSE);
  });
  onCleanup(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });

  return host;
}
