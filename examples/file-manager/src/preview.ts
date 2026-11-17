/**
 * What the preview column shows for an entry, read off the disk and nothing
 * drawn yet: a directory's listing, text, Markdown, a picture, or a line saying
 * why there is none.
 *
 * Kept apart from the pane that draws it so the reading -- how much of a file is
 * read, what counts as binary, which picture this can decode -- is a function a
 * test can call over a temporary directory without an app.
 */

import {
  type Entry,
  type Files,
  formatSize,
  printable,
  sortEntries,
  visibleEntries,
} from './files.ts';
import { decodePng, type RgbaImage } from '@ttylabs/sigil/png';
import { extname } from 'node:path';

/** What the preview column shows. */
export type Preview =
  | { readonly kind: 'directory'; readonly entries: readonly Entry[]; readonly total: number }
  | { readonly kind: 'image'; readonly image: RgbaImage }
  | { readonly kind: 'markdown'; readonly cut: boolean; readonly text: string }
  | { readonly kind: 'note'; readonly note: string; readonly role?: 'error' }
  | {
      readonly kind: 'text';
      readonly cut: boolean;
      /** What the extension says, for `highlightCode()`: it knows which it reads. */
      readonly lang: string | undefined;
      readonly text: string;
    };

/** A preview with what it is of, which is how a late answer is told from a current one. */
export interface PreviewFor {
  /** A line about it for the column's title: a size, a picture's pixels, a count. */
  readonly about: string;
  /** The path it is of, or `''` for nothing selected. */
  readonly path: string;
  readonly preview: Preview;
}

/** How much of a text file is read: a preview is the top of a file, not all of it. */
export const MAX_TEXT_BYTES: number = 64 * 1024;

/** And how many of its lines are drawn, since a minified file is one long line. */
export const MAX_TEXT_LINES: number = 1000;

/** A PNG larger than this is not decoded for a preview. */
export const MAX_IMAGE_BYTES: number = 8 * 1024 * 1024;

/** How many names of a directory the preview lists. */
export const MAX_LISTED: number = 500;

/** How far into a file a NUL makes it binary, which is git's test and `grep`'s. */
const SNIFF = 8000;

const MARKDOWN = new Set(['.markdown', '.md', '.mdown', '.mkd']);

/**
 * Reads what to preview of an entry.
 *
 * A directory is listed with the same hidden rule as the column beside it. A
 * regular file is read from the start, at most {@link MAX_TEXT_BYTES}: a NUL in
 * what was read makes it binary, `.md` is Markdown, and anything else is text
 * handed to the highlighter with its extension. A `.png` is decoded whole, under
 * {@link MAX_IMAGE_BYTES}. Nothing else is opened at all -- a FIFO would block the
 * read for as long as nobody writes to it, and a device is not a document.
 *
 * Never throws: a file that cannot be read is a note saying why.
 *
 * @param files - The file system.
 * @param entry - What is selected.
 * @param opts - Whether hidden names are listed.
 * @returns The preview.
 */
export async function readPreview(
  files: Files,
  entry: Entry,
  opts: { hidden: boolean }
): Promise<PreviewFor> {
  const path = entry.path;
  try {
    if (entry.kind === 'directory') {
      const all = sortEntries(await files.list(path));
      const entries = visibleEntries(all, { filter: '', hidden: opts.hidden });
      const hidden = all.length - entries.length;
      return {
        about: `${count(entries.length, 'item')}${hidden ? `, ${hidden} hidden` : ''}`,
        path,
        preview: {
          entries: entries.slice(0, MAX_LISTED),
          kind: 'directory',
          total: entries.length,
        },
      };
    }
    if (entry.kind !== 'file') {
      return {
        about: entry.link ? 'a link' : '',
        path,
        preview: {
          kind: 'note',
          note: entry.link
            ? 'A link to nothing that is there: nothing to preview'
            : 'Not a regular file: nothing to preview',
        },
      };
    }
    const size = formatSize(entry.size);
    if (entry.size === 0) {
      return { about: 'empty', path, preview: { kind: 'note', note: 'An empty file' } };
    }
    const ext = extname(entry.name).toLowerCase();
    if (ext === '.png') {
      if (entry.size > MAX_IMAGE_BYTES) {
        return {
          about: size,
          path,
          preview: { kind: 'note', note: `A picture too large to preview (${size})` },
        };
      }
      const bytes = await files.read(path, entry.size);
      try {
        const image = decodePng(bytes);
        return {
          about: `${image.width}x${image.height} PNG, ${size}`,
          path,
          preview: { image, kind: 'image' },
        };
      } catch (err) {
        return {
          about: size,
          path,
          preview: {
            kind: 'note',
            note: `Not a PNG this can read: ${(err as Error).message}`,
            role: 'error',
          },
        };
      }
    }
    const bytes = await files.read(path, MAX_TEXT_BYTES);
    if (bytes.subarray(0, SNIFF).includes(0)) {
      return { about: size, path, preview: { kind: 'note', note: `A binary file, ${size}` } };
    }
    const { cut, text } = topOf(bytes, entry.size > bytes.length);
    if (MARKDOWN.has(ext)) {
      return { about: size, path, preview: { cut, kind: 'markdown', text } };
    }
    return {
      about: size,
      path,
      preview: { cut, kind: 'text', lang: ext.slice(1) || undefined, text },
    };
  } catch (err) {
    return { about: '', path, preview: { kind: 'note', note: cannotRead(err), role: 'error' } };
  }
}

/**
 * The text of the bytes read, made safe to draw and cut at {@link MAX_TEXT_LINES}.
 *
 * A read that stopped part way through the file may have stopped inside a
 * character and is cut back to the last whole line; a `\r` before a newline goes,
 * since it is how a line ends rather than what it says; a tab and a newline are
 * kept for the pane, and every other control character is drawn as `�`.
 */
function topOf(bytes: Uint8Array, partial: boolean): { cut: boolean; text: string } {
  // `stream` holds back a character the read stopped inside, rather than
  // decoding its first bytes as a `�` the file does not have; and a CRLF is a
  // newline before anything is cut at one, so no cut leaves its `\r` behind
  let text = new TextDecoder('utf-8').decode(bytes, { stream: partial }).replace(/\r\n/g, '\n');
  let cut = partial;
  if (partial) {
    const end = text.lastIndexOf('\n');
    text = end === -1 ? text : text.slice(0, end);
  }
  let at = -1;
  for (let n = 0; n < MAX_TEXT_LINES; n++) {
    at = text.indexOf('\n', at + 1);
    if (at === -1) {
      break;
    }
  }
  if (at !== -1 && at < text.length - 1) {
    text = text.slice(0, at);
    cut = true;
  }
  return { cut, text: printable(text.replace(/\n$/, ''), '\n\t') };
}

/** `1 item`, `3 items`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Why a read failed, in words rather than an errno. */
export function cannotRead(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Cannot read it: permission denied';
    case 'ENOENT':
      return 'It is not there any more';
    case 'ENOTDIR':
      return 'It is not a directory any more';
    default:
      return `Cannot read it: ${(err as Error).message}`;
  }
}
