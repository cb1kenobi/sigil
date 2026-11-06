import { COMPONENTS, FAMILIES, type ComponentEntry } from './components.ts';
import { sgrRows } from './sgr.ts';
import { tighten, type Row } from './terminal-rows.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the components pages read off disk: each component's capture, and its
 * example's source.
 *
 * Both are under `src/` and both are committed. The captures are written by
 * `scripts/capture-transcripts.ts` from running the examples and reading the
 * built declarations, and the examples are the files that were run, so the
 * source on a page and the output beside it are one program. The shapes are
 * defined here, where they are read, and the capture script writes to them.
 */

/** One option, as its declaration and its JSDoc say. */
export interface OptionDoc {
  /** The first paragraph of its comment, with backticks for code. */
  readonly description: string;
  /** What its comment says it defaults to. */
  readonly default?: string;
  readonly name: string;
  readonly optional: boolean;
  /** The type, as declared. */
  readonly type: string;
}

/** A component's API, from `dist/components.d.mts`. */
export interface ComponentApi {
  /** The interface its options are, when it takes one. */
  readonly interface?: string;
  readonly options: readonly OptionDoc[];
  /** The mount options every component takes, by name, which the table does not repeat. */
  readonly shared: readonly string[];
  /** The function's declaration, as an editor shows it. */
  readonly signature: string;
}

/** One drawn screen. */
export interface View {
  readonly columns: number;
  /** The screen, one line per row, with its escape sequences. */
  readonly output: string;
}

/** What one component's capture holds. */
export interface ComponentCapture {
  readonly api: ComponentApi;
  /** What `sigil add` says of the entry the component is copied in with. */
  readonly registryDescription?: string;
  readonly views: { readonly rendered: View };
}

/** Where `src/` is, read from the working directory as `reference.ts` does. */
const SRC = join(process.cwd(), 'src');

/** The examples, from the repository's root, for a View source link. */
export const EXAMPLES_REPO_DIR = 'website/src/content/components';

/**
 * A component's capture.
 *
 * @param slug - Which component.
 * @returns What was captured.
 */
export function componentCapture(slug: string): ComponentCapture {
  const file = join(SRC, 'transcripts', 'components', `${slug}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ComponentCapture;
  } catch {
    throw new Error(`no capture for "${slug}": run \`node scripts/capture-transcripts.ts\``);
  }
}

/**
 * A component's example, exactly as it was run.
 *
 * @param slug - Which component.
 * @returns The file's text.
 */
export function exampleSource(slug: string): string {
  return readFileSync(join(SRC, 'content', 'components', `${slug}.mjs`), 'utf-8').trimEnd();
}

/**
 * What a component is, in one sentence: its own, or the one `sigil add` lists
 * for the file it is the whole of.
 *
 * @param entry - The component.
 * @returns The sentence, ending in a full stop.
 */
export function describeComponent(entry: ComponentEntry): string {
  const text = entry.description ?? componentCapture(entry.slug).registryDescription ?? '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Whether a component asks in plain lines with accessible mode on: its options take `accessible`. */
export function hasLineForm(slug: string): boolean {
  return componentCapture(slug).api.options.some((option) => option.name === 'accessible');
}

/** Whether a component gives up when a signal aborts: its options take `signal`. */
export function takesSignal(slug: string): boolean {
  return componentCapture(slug).api.options.some(
    (option) => option.name === 'signal' && option.type === 'AbortSignal'
  );
}

/**
 * A screen as rows to draw.
 *
 * @param view - The screen.
 * @param opts.trimTop - Drop the blank rows above the first one drawn on, for a
 *   preview of something drawn at the bottom of a full screen.
 * @returns The rows.
 */
export function viewRows(view: View, { trimTop = false } = {}): Row[] {
  const rows = tighten(sgrRows(view.output));
  if (!trimTop) {
    return rows;
  }
  const first = rows.findIndex((row) => row.spans.some((span) => span.text.trim() !== ''));
  return first === -1 ? rows : rows.slice(first);
}

/** The rows a component's card previews: the top of its 80-column screen. */
export function previewRows(slug: string): Row[] {
  return viewRows(componentCapture(slug).views.rendered, { trimTop: true });
}

/** A small count as a word, the way a sentence would say it. */
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * The index's lede, which is also its description: how many components there
 * are, counted rather than typed, and the two things every card's badges mean.
 *
 * The claim about signals is held to the captures by `test/components.test.ts`.
 */
export const COMPONENTS_LEDE = `${COMPONENTS.length} components in ${
  WORDS[FAMILIES.length] ?? FAMILIES.length
} families. Every prompt takes an AbortSignal, and those marked Accessible have a plain line form for screen readers.`;
