import type { KeyRow, View } from './component-data.ts';
import { componentEntry, componentsOf, type ComponentEntry, type ViewId } from './components.ts';

/**
 * The words a component's page says that are not in its capture: what each view
 * of the output is called and what its caption says, the Keys list in words,
 * and which siblings it links to.
 *
 * Here rather than in `component-page.tsx` because the page has two readers --
 * the page itself, and its Markdown copy (`docs-pages.ts`), which is what an
 * agent fetches -- and two copies of a caption is how they come to disagree.
 */

/** One view of a component's output, as the page labels it. */
export interface ViewLabel {
  readonly id: ViewId;
  /** The tab. */
  readonly label: string;
  /** The terminal it was drawn in, as the window's title bar says it. */
  readonly size: string;
  /** What the view shows, a sentence. */
  readonly caption: string;
  readonly view: View;
}

/**
 * What each view's tab is called, the size it says it is, and its caption, in
 * the order the page shows them: rendered, accessible, 40 columns.
 *
 * @param entry - The component.
 * @param views - Its captured views.
 * @returns The views it has.
 */
export function viewLabels(
  entry: ComponentEntry,
  views: Partial<Record<ViewId, View>>
): ViewLabel[] {
  const what = entry.family === 'prompts' ? 'The prompt' : 'The example';
  const after = entry.example?.caption ? `, ${entry.example.caption}` : '';

  return [
    views.rendered && {
      id: 'rendered' as const,
      label: 'Rendered',
      size: `zsh · ${views.rendered.columns}×24`,
      caption: `${what} as it draws in a terminal ${views.rendered.columns} columns wide${after}.`,
      view: views.rendered,
    },
    views.accessible && {
      id: 'accessible' as const,
      label: 'Accessible',
      size: `zsh · ${views.accessible.columns}×24 · accessible`,
      caption: `With accessible mode on (SIGIL_ACCESSIBLE=1), the same ${
        entry.family === 'prompts' ? 'prompt' : 'example'
      } asks on plain lines that a screen reader reads in order, and nothing on them is redrawn.`,
      view: views.accessible,
    },
    views.narrow && {
      id: 'narrow' as const,
      label: '40 columns',
      size: `zsh · ${views.narrow.columns}×24`,
      caption: `The same steps on a terminal ${views.narrow.columns} columns wide: what is drawn is laid out again for the width, not cut off.`,
      view: views.narrow,
    },
  ].filter((view) => view !== undefined);
}

/** How a key is printed on a keycap. */
const CAPS: Readonly<Record<string, string>> = {
  backspace: 'Backspace',
  ctrlC: 'Ctrl C',
  delete: 'Delete',
  down: '↓',
  end: 'End',
  enter: 'Enter',
  escape: 'Esc',
  home: 'Home',
  left: '←',
  pageDown: 'PgDn',
  pageUp: 'PgUp',
  right: '→',
  shiftTab: 'Shift Tab',
  space: 'Space',
  tab: 'Tab',
  up: '↑',
};

/**
 * A key as a keycap prints it: `ctrlC` is Ctrl C, and a key a footer named that
 * is not in `CAPS` is title-cased by its parts, so `ctrl-d` is Ctrl D and `a` is A.
 *
 * @param key - The key, by its name in `KEYS` or a footer's own.
 * @returns What the keycap says.
 */
export function cap(key: string): string {
  return (
    CAPS[key] ??
    key
      .split('-')
      .map((part) =>
        part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)
      )
      .join(' ')
  );
}

/** The keys that move rather than act. */
const MOVES = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageUp', 'pageDown']);

/** One line of the Keys list: the keys, and what they do in words. */
export interface KeyLine {
  readonly keys: readonly string[];
  /** A sentence, with `code` in backticks. */
  readonly does: string;
}

/**
 * The Keys list's rows, in words, with what changed split into moving and acting.
 *
 * @param entry - The component.
 * @param rows - Its captured keys.
 * @returns The lines, in order.
 */
export function keyLines(entry: ComponentEntry, rows: readonly KeyRow[]): KeyLine[] {
  const prompt = entry.family === 'prompts';
  const lines: KeyLine[] = [];

  for (const row of rows) {
    if (row.footer) {
      lines.push({ keys: row.keys, does: row.footer[0]!.toUpperCase() + row.footer.slice(1) });
    } else if (row.effect === 'change') {
      const moves = row.keys.filter((key) => MOVES.has(key));
      const acts = row.keys.filter((key) => !MOVES.has(key));
      if (moves.length > 0) {
        lines.push({ keys: moves, does: prompt ? 'Move the cursor' : 'Move, or scroll' });
      }
      if (acts.length > 0) {
        lines.push({
          keys: acts,
          does: prompt ? 'Change the answer' : 'Move the focus, or act on what has it',
        });
      }
    } else if (row.effect === 'answer') {
      lines.push({ keys: row.keys, does: prompt ? 'Answer' : 'Quit the app' });
    } else if (row.effect === 'cancel') {
      lines.push({
        keys: row.keys,
        does: prompt ? 'Cancel. The prompt rejects with a `PromptError`.' : 'Cancel',
      });
    }
  }
  return lines;
}

/**
 * What the note under the Keys list says about where the list came from.
 *
 * @param entry - The component.
 * @param rows - Its captured keys.
 * @returns The note.
 */
export function keysNote(entry: ComponentEntry, rows: readonly KeyRow[]): string {
  return rows.some((row) => row.footer !== undefined)
    ? 'The hint line under the prompt is generated from these bindings, so it always lists what they do; the words above are its own. The rest were found by pressing each key on the running example.'
    : `${entry.name} draws no hint line, so these were found by pressing each key on the running example and seeing what it did.`;
}

/**
 * The components linked under Related: the ones the entry names, or its
 * family's next three.
 *
 * @param entry - The component.
 * @returns The siblings, in order.
 */
export function relatedOf(entry: ComponentEntry): ComponentEntry[] {
  if (entry.related) {
    return entry.related.map((slug) => componentEntry(slug)!);
  }
  const siblings = componentsOf(entry.family);
  const at = siblings.findIndex((it) => it.slug === entry.slug);
  return [1, 2, 3]
    .map((step) => siblings[(at + step) % siblings.length]!)
    .filter((it) => it.slug !== entry.slug);
}

/** What the Options section says before the signature. */
export const OPTIONS_INTRO = 'Read from the declaration an editor completes:';

/** What the Options section says after the table, before the shared options' names. */
export const SHARED_OPTIONS = 'It also takes the options every mounted component does:';
