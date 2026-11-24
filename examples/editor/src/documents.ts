/**
 * An open file, and what is said about it: its tab's label, its language, and
 * whether it has changed since it was read or last saved.
 *
 * No elements here. The text area a document is edited in is the model's, built
 * when the document is opened; this is the part a test can read without a
 * terminal.
 */

import {
  codeLanguage,
  type TextAreaCaret,
  type TextAreaSelection,
} from '@ttylabs/sigil/components';
import { Computed, State } from '@ttylabs/sigil/signals';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';

/** One open file. */
export interface Doc {
  /** Where it is, absolute. What says two tabs are the same file. */
  readonly path: string;
  /** Its file name. */
  readonly name: string;
  /**
   * The extension without its dot, `md` or `ts`, which is what the text area
   * hands the highlighter -- or `undefined` for a file with none.
   */
  readonly lang: string | undefined;
  /** Whether it is Markdown, which is what the preview is shown for. */
  readonly markdown: boolean;
  /**
   * The line ending it is written with: the first one in the file as it was
   * read, or `\n` for a file of one line. The text area keeps `\n` and nothing
   * else, so a file that came in with `\r\n` is written back with it rather
   * than converted by being saved -- and a file with more than one kind is
   * written with the first, once it has been edited.
   */
  readonly eol: '\n' | '\r\n' | '\r';
  /** The text, with `\n` line endings: the text area's value. */
  readonly value: State<string>;
  /** The text as it is on disk, with `\n` line endings: what `value` is compared to. */
  readonly saved: State<string>;
  /** Whether `value` differs from `saved`: the tab's marker, and the close's question. */
  readonly dirty: Computed<boolean>;
  /**
   * Where the caret is: the text area's `caret`, which starts at the top of the
   * file and is what the status line reads.
   */
  readonly caret: State<TextAreaCaret>;
  /**
   * What is selected: the text area's `selection`, collapsed on the caret while
   * nothing is, and what the status line reads as `(5 selected)`.
   */
  readonly selection: State<TextAreaSelection>;
}

/**
 * A document over a file's text.
 *
 * @param path - Where the file is, absolute.
 * @param text - What it holds, as read.
 * @returns The document, not dirty.
 */
export function createDoc(path: string, text: string): Doc {
  const first = /\r\n|\r|\n/u.exec(text)?.[0];
  const eol = first === '\r\n' || first === '\r' ? first : '\n';
  const normalized = text.replace(/\r\n?/g, '\n');
  const value = new State(normalized);
  const saved = new State(normalized);
  const ext = extname(path).slice(1);
  const lang = ext === '' ? undefined : ext;
  return {
    caret: new State<TextAreaCaret>({ col: 0, line: 0 }),
    dirty: new Computed(() => value.get() !== saved.get()),
    eol,
    lang,
    markdown: codeLanguage(lang) === 'markdown',
    name: basename(path),
    path,
    saved,
    selection: new State<TextAreaSelection>({
      anchor: { col: 0, line: 0 },
      caret: { col: 0, line: 0 },
    }),
    value,
  };
}

/**
 * How many characters a selection holds, a line break counting one.
 *
 * Characters rather than the code units the places are in, which is what the
 * "Copied" message counts too -- an emoji is one however many units it takes.
 *
 * @param text - The text, with `\n` line endings: the text area's value.
 * @param selection - What is selected, its ends in either order.
 * @returns The count, or 0 while the two ends are one place.
 */
export function selectedCharacters(text: string, selection: TextAreaSelection): number {
  const { anchor, caret } = selection;
  if (anchor.line === caret.line && anchor.col === caret.col) {
    return 0;
  }
  const [from, to] =
    anchor.line < caret.line || (anchor.line === caret.line && anchor.col < caret.col)
      ? [anchor, caret]
      : [caret, anchor];
  const lines = text.split('\n');
  const held =
    from.line === to.line
      ? lines[from.line].slice(from.col, to.col)
      : [
          lines[from.line].slice(from.col),
          ...lines.slice(from.line + 1, to.line),
          lines[to.line].slice(0, to.col),
        ].join('\n');
  return [...held].length;
}

/**
 * What a document is written to disk as: its value with the line ending it was
 * read with.
 *
 * @param doc - The document.
 * @returns The text to write.
 */
export function diskText(doc: Doc): string {
  const value = doc.value.get();
  return doc.eol === '\n' ? value : value.replace(/\n/gu, doc.eol);
}

/**
 * Each document's tab label, in order: its file name, or its path under `root`
 * where two open files share a name -- two `README.md`s are told apart by where
 * they are -- with a mark after it while it has unsaved changes.
 *
 * @param docs - The open documents.
 * @param root - The workspace's directory, which paths are shown under.
 * @param mark - What says a document is dirty: `●`, or `*` in ASCII.
 * @returns One label per document.
 */
export function tabLabels(docs: readonly Doc[], root: string, mark: string): string[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    counts.set(doc.name, (counts.get(doc.name) ?? 0) + 1);
  }
  return docs.map((doc) => {
    const name = (counts.get(doc.name) ?? 0) > 1 ? shownPath(doc.path, root) : doc.name;
    return doc.dirty.get() ? `${name} ${mark}` : name;
  });
}

/**
 * A path as the editor shows it: under `root` where it is, with `/` between the
 * parts on every platform -- which is how a path reads in a tab or a title -- and
 * absolute otherwise.
 *
 * @param path - The path, absolute.
 * @param root - The workspace's directory.
 * @returns What to show.
 */
export function shownPath(path: string, root: string): string {
  const under = relative(root, path);
  const outside =
    under === '' || isAbsolute(under) || under === '..' || under.startsWith(`..${sep}`);
  return outside ? path : under.split(sep).join('/');
}
