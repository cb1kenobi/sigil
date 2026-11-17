/**
 * An open file, and what is said about it: its tab's label, its language, and
 * whether it has changed since it was read or last saved.
 *
 * No elements here. The text area a document is edited in is the model's, built
 * when the document is opened; this is the part a test can read without a
 * terminal.
 */

import { codeLanguage } from '@ttylabs/sigil/components';
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
   * The line ending it was read with. The text area keeps `\n` and nothing else,
   * so a file that came in with `\r\n` is written back with it rather than
   * converted by being saved.
   */
  readonly eol: '\n' | '\r\n';
  /** The text, with `\n` line endings: the text area's value. */
  readonly value: State<string>;
  /** The text as it is on disk, with `\n` line endings: what `value` is compared to. */
  readonly saved: State<string>;
  /** Whether `value` differs from `saved`: the tab's marker, and the close's question. */
  readonly dirty: Computed<boolean>;
}

/**
 * A document over a file's text.
 *
 * @param path - Where the file is, absolute.
 * @param text - What it holds, as read.
 * @returns The document, not dirty.
 */
export function createDoc(path: string, text: string): Doc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n?/g, '\n');
  const value = new State(normalized);
  const saved = new State(normalized);
  const ext = extname(path).slice(1);
  const lang = ext === '' ? undefined : ext;
  return {
    dirty: new Computed(() => value.get() !== saved.get()),
    eol,
    lang,
    markdown: codeLanguage(lang) === 'markdown',
    name: basename(path),
    path,
    saved,
    value,
  };
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
  return doc.eol === '\n' ? value : value.replace(/\n/g, '\r\n');
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
