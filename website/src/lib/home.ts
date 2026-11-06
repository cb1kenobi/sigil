import { sgrRows } from './sgr.ts';
import { repoFileUrl } from './site.ts';
import { commandRow, tighten, type Row } from './terminal-rows.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the home page says and draws, apart from how it is laid out.
 *
 * Kept out of `app/page.tsx` for two reasons. The words that describe behaviour
 * are claims, and a claim wants a test next to it: `test/home.test.ts` holds
 * the alias sentence to the captured help and completion, so a change to the
 * framework that makes the page untrue fails there. And the samples are read
 * from files -- `src/content/home/` and `src/transcripts/home/` -- which is
 * where a reader looking for the code behind a block expects to find it, and
 * not a string inside JSX.
 */

/** The hero's lede, which is also the page's description. */
export const HOME_LEDE =
  'A command parser, interactive prompts and a styled component layer that draw through one renderer. Help, shell completion and a markdown reference come from the same command definitions.';

/** Where `src/` is, read from the working directory as `reference.ts` does. */
const SRC = join(process.cwd(), 'src');

/** The `todo` app the parser section shows, which is also what its output was captured from. */
export const TODO_FILE = 'todo.mjs';

/**
 * The source of the `todo` app.
 *
 * Read off disk, not written out here: `scripts/lib/home-capture.ts` runs this
 * very file to produce the help screen, the completion and the failing prompt
 * beside it, so the listing and its output cannot describe different programs.
 *
 * @returns The file's text.
 */
export function todoSource(): string {
  return readFileSync(join(SRC, 'content', 'home', TODO_FILE), 'utf-8').trimEnd();
}

/** One captured screen. */
interface Screen {
  readonly columns: number;
  readonly runs: readonly { readonly command?: string; readonly output: string }[];
}

/** Every screen the page draws, by name. */
export const HOME_SCREENS = [
  'accessible',
  'agent',
  'cli',
  'completion',
  'diff',
  'hero',
  'log',
  'markdown',
  'parser',
  'rendered',
  'select',
  'table',
  'tasks',
] as const;

export type HomeScreenId = (typeof HOME_SCREENS)[number];

/**
 * The captured screens, from `scripts/capture-transcripts.ts`.
 *
 * @returns The screens by name.
 */
export function homeScreens(): Record<string, Screen> {
  const file = join(SRC, 'transcripts', 'home', 'screens.json');
  return (JSON.parse(readFileSync(file, 'utf-8')) as { screens: Record<string, Screen> }).screens;
}

/**
 * A screen as rows to draw.
 *
 * A run that has a command is drawn as a shell would echo it, and what it
 * printed under it; a screen with none is a prompt, drawn as it stood.
 *
 * @param id - Which screen.
 * @returns The rows and the width it was drawn at.
 */
export function homeRows(id: HomeScreenId): { columns: number; rows: Row[] } {
  const screen = homeScreens()[id];
  if (!screen) {
    throw new Error(`no captured screen "${id}": run \`node scripts/capture-transcripts.ts\``);
  }

  return {
    columns: screen.columns,
    rows: tighten(
      screen.runs.flatMap((run) => [
        ...(run.command === undefined ? [] : [commandRow(run.command)]),
        ...sgrRows(run.output),
      ])
    ),
  };
}

/** One card in the Components section. */
export interface ComponentCard {
  readonly description: string;
  /** What the name is drawn as: the function, called as it is. */
  readonly name: string;
  readonly screen: HomeScreenId;
  /** The component page's address under `/docs/components/`. */
  readonly slug: string;
}

/**
 * The six cards. Every name is an export of `@ttylabs/sigil/components` and
 * every preview is that component's real output; `table() · badge()` is one
 * card because the table is what the badge is drawn in.
 */
export const COMPONENT_CARDS: readonly ComponentCard[] = [
  {
    description: 'One choice from a list, answered with the arrow keys and Enter.',
    name: 'select()',
    screen: 'select',
    slug: 'select',
  },
  {
    description:
      'Columns that line up whatever is in them, and badges for a cell that is a status.',
    name: 'table() · badge()',
    screen: 'table',
    slug: 'table',
  },
  {
    description: 'Status lines with a level and key=value fields, written to stderr.',
    name: 'log',
    screen: 'log',
    slug: 'log',
  },
  {
    description: 'A list of work with a spinner on the running step and a window onto its output.',
    name: 'tasks()',
    screen: 'tasks',
    slug: 'tasks',
  },
  {
    description: 'A README or a changelog entry as styled text, with no extra dependency.',
    name: 'markdown()',
    screen: 'markdown',
    slug: 'markdown',
  },
  {
    description: 'A unified or side-by-side diff, with the words that changed in bold.',
    name: 'diff()',
    screen: 'diff',
    slug: 'diff',
  },
];

/** The address of a component's page. */
export function componentHref(slug: string): string {
  return `/docs/components/${slug}`;
}

/**
 * The first Agents card, as the ticket wrote it.
 *
 * It claims that every docs page is also served as Markdown (SIG-267) and that
 * Getting started has instructions to paste into an `AGENTS.md` under
 * `#agents` (SIG-262). Both are being finished alongside this page, so the
 * copy says them outright and the link goes to the anchor SIG-262 specifies.
 */
export const WRITING_CARD = {
  body: "Every docs page is also served as Markdown at the same address, so an agent reads the docs without the navigation. Getting started has a block of instructions to paste into your project's AGENTS.md, and every example is checked against the release it documents.",
  href: '/docs/getting-started#agents',
  link: 'Set up your agent',
} as const;

/** The accessible-mode write-up: the README section, since there is no docs page for it yet. */
export const ACCESSIBLE_MODE_HREF = `${repoFileUrl('packages/sigil/README.md')}#accessible-mode-prompts-as-plain-lines`;
