import type { ComponentCapture, KeyEffect, KeyRow, View } from '../../src/lib/component-data.ts';
import { COMPONENTS, type ComponentEntry, type Step } from '../../src/lib/components.ts';
import { captureEnv, inParallel, runJson, screenOf } from './capture.ts';
import { componentApi } from './component-options.ts';
import { strip } from '@ttylabs/sigil/ansi';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the components pages draw, produced by running each component.
 *
 * Every component has an example in `src/content/components/<slug>.mjs`, which
 * is ordinary app code and is what a page shows as its source. This runs it
 * through `run-example.mjs` -- on a faked terminal, with colour forced and a
 * fake clock, one child per run -- and keeps what it drew:
 *
 * - **Rendered**, at 80 columns, which is also the card's preview on the index;
 * - **40 columns**, the same steps on a narrower screen, which is a real
 *   narrower screen and not the first one cut off;
 * - **Accessible**, with `SIGIL_ACCESSIBLE=1`, for a component whose options
 *   take `accessible` -- which is what "has a line form" means;
 * - each **recipe**'s output, the same way, at the width it is shown beside its
 *   source;
 * - the **keys**, for a prompt or a full-screen element: what its key-help
 *   footer lists, in its own words, and then each key in `PROBE` pressed on a
 *   fresh run and what it was seen to do -- answered, cancelled, or changed the
 *   screen -- for the ones no footer names;
 * - the **API**, from `component-options.ts`, which is where the index reads
 *   whether a component has a line form and takes an `AbortSignal`;
 * - the **source** file that declares the component, for View source.
 *
 * `capture-transcripts.ts` writes the result to `src/transcripts/components/`
 * and `test/component-captures.test.ts` runs this again and fails when they are
 * not the same, so a change to a component cannot leave its page describing
 * output, keys or options it no longer has.
 */

/** The site's directory. */
const SITE = join(import.meta.dirname, '../..');

/** The repository's. */
const ROOT = join(SITE, '..');

/** The example files. */
export const EXAMPLES = join(SITE, 'src/content/components');

/** Where an example runs unless it says otherwise: a small project for the file prompts to list. */
const PROJECT = join(EXAMPLES, 'my-app');

/** Where that project says it is, on every machine: see `run-example.mjs`. */
const AT = '/home/you/my-app';

/** The child that runs one. */
const RUNNER = join(import.meta.dirname, 'run-example.mjs');

/** The width of the rendered view, the narrow one, and a recipe's, which sits beside its source. */
export const COLUMNS = { narrow: 40, recipe: 52, rendered: 80 } as const;

/** Wide enough that a footer drops nothing, for reading the keys it lists. */
const WIDE = 160;

/** The keys each interactive example is asked about, in the order the list gives them. */
const PROBE = [
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'tab',
  'shiftTab',
  'space',
  'backspace',
  'delete',
  'enter',
  'escape',
  'ctrlC',
] as const satisfies readonly Step[];

type ProbedKey = (typeof PROBE)[number];

/**
 * What `sigil add` lists for each entry, from the registry `@ttylabs/sigil`'s
 * build writes. Kept in the capture so that the site's build reads nothing
 * outside `src/`, and so that a reworded entry is a capture that has gone stale.
 */
function registryDescriptions(): Record<string, string> {
  const file = join(ROOT, 'packages/sigil/registry/registry.json');
  const { entries } = JSON.parse(readFileSync(file, 'utf-8')) as {
    entries: Record<string, { desc: string }>;
  };
  return Object.fromEntries(Object.entries(entries).map(([name, it]) => [name, it.desc]));
}

/** How one run is asked for. */
interface RunOptions {
  readonly accessible?: boolean;
  readonly columns: number;
  /** The example to run, when not the component's own: a recipe's. */
  readonly file?: string;
  /** Keys to probe, rather than a view to keep. */
  readonly probe?: readonly string[];
  readonly steps?: readonly Step[];
}

/** Where the components' sources are, from the repository's root. */
const SOURCES = 'packages/sigil/src/components';

/**
 * The module a component is written in, for its page's View source link: the
 * one that declares the export, read rather than written down beside it.
 *
 * @param name - The export.
 * @returns Its file, from the repository's root.
 */
function sourceOf(name: string): string {
  const declares = new RegExp(`^export (?:async )?(?:function|const|class) ${name}\\b`, 'm');
  const file = readdirSync(join(ROOT, SOURCES))
    .filter((it) => it.endsWith('.ts'))
    .find((it) => declares.test(readFileSync(join(ROOT, SOURCES, it), 'utf-8')));

  if (!file) {
    throw new Error(`no module in ${SOURCES} declares ${name}`);
  }
  return `${SOURCES}/${file}`;
}

/** Runs an example once, and answers what `run-example.mjs` printed. */
function run<T>(entry: ComponentEntry, opts: RunOptions): Promise<T> {
  const spec = {
    accessible: opts.accessible ?? false,
    columns: opts.columns,
    file: join(EXAMPLES, `${opts.file ?? entry.slug}.mjs`),
    rows: entry.example?.rows ?? 24,
    steps: opts.steps ?? [],
    ...(opts.probe ? { probe: opts.probe } : {}),
    ...(entry.example?.cwd ? {} : { at: AT }),
  };
  return runJson<T>(RUNNER, [JSON.stringify(spec)], {
    cwd: entry.example?.cwd ? join(ROOT, entry.example.cwd) : PROJECT,
    env: captureEnv(opts.columns),
  });
}

/** Runs an example once and keeps the screen it left. */
async function view(entry: ComponentEntry, opts: RunOptions): Promise<View> {
  const { output } = await run<{ output: string }>(entry, opts);
  return {
    columns: opts.columns,
    output: screenOf(output, opts.columns, entry.example?.rows ?? 24),
  };
}

/**
 * The words a key-help footer has for each key, read off the row it drew.
 *
 * The footer is `keyHelp()` over the prompt's own bindings, so this is those
 * bindings' descriptions, as printed. A row is taken for a footer only if it is
 * the last, it is indented under the question, it has no cursor on it, and every
 * entry in it is a key name and some words.
 *
 * @param screen - A screen wide enough that the footer dropped nothing.
 * @returns The entries, in the footer's order.
 */
export function footerEntries(screen: string): { keys: string; words: string }[] {
  const row = strip(screen).trimEnd().split('\n').at(-1) ?? '';
  if (!/^\s/.test(row) || row.includes('❯')) {
    return [];
  }
  const KEY =
    /^(?:enter|space|tab|esc|backspace|delete|home|end|pgup|pgdn|[↑↓←→]|(?:ctrl|alt|shift)-\S+|\S)$/u;
  const entries = row
    .trim()
    .split(' · ')
    .map((part) => /^(\S+) (\S.*)$/.exec(part));

  if (entries.some((it) => !it || !it[1]!.split('/').every((key) => KEY.test(key)))) {
    return [];
  }
  return entries.map((it) => ({ keys: it![1]!, words: it![2]!.replace(/\s*…$/u, '') }));
}

/** A footer's spelling of a key, as the probe names it. */
const FOOTER_NAMES: Readonly<Record<string, ProbedKey>> = {
  backspace: 'backspace',
  delete: 'delete',
  end: 'end',
  enter: 'enter',
  esc: 'escape',
  home: 'home',
  pgdn: 'pageDown',
  pgup: 'pageUp',
  space: 'space',
  tab: 'tab',
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
};

/** The Keys list: the footer's entries, then what else was found to do something. */
async function keys(entry: ComponentEntry): Promise<KeyRow[]> {
  const steps = entry.example?.steps ?? [];
  const [{ probes }, wide] = await Promise.all([
    run<{ probes: Record<ProbedKey, KeyEffect | 'none'> }>(entry, {
      columns: COLUMNS.rendered,
      probe: PROBE,
      steps,
    }),
    view(entry, { columns: WIDE, steps }),
  ]);

  const out: KeyRow[] = [];
  const told = new Set<string>();

  for (const { keys: spelled, words } of footerEntries(wide.output)) {
    const names = spelled.split('/').map((key) => FOOTER_NAMES[key] ?? key);
    for (const name of names) {
      told.add(name);
    }
    out.push({ footer: words, keys: names });
  }

  // what is left, grouped by what it did, in the order the probe asks
  for (const effect of ['change', 'answer', 'cancel'] as const) {
    const found = PROBE.filter((key) => probes[key] === effect && !told.has(key));
    if (found.length > 0) {
      out.push({ effect, keys: found });
    }
  }

  return out;
}

/**
 * Captures one component.
 *
 * @param entry - Its metadata.
 * @returns What its page draws, and its API.
 */
export async function captureComponent(entry: ComponentEntry): Promise<ComponentCapture> {
  const registry =
    entry.registry === undefined ? undefined : registryDescriptions()[entry.registry];
  if (entry.registry !== undefined && registry === undefined) {
    throw new Error(`${entry.slug}: there is no \`sigil add\` entry called "${entry.registry}"`);
  }

  const api = componentApi(entry.exports[0]!);
  const steps = entry.example?.steps;
  const lines = api.options.some((option) => option.name === 'accessible');
  // a prompt or a full-screen element takes keys; output does not
  const interactive = entry.family !== 'output' && entry.example?.probe !== false;

  const [rendered, narrow, accessible, recipes, keyRows] = await Promise.all([
    view(entry, { columns: COLUMNS.rendered, steps }),
    view(entry, { columns: COLUMNS.narrow, steps }),
    lines
      ? view(entry, {
          accessible: true,
          columns: COLUMNS.rendered,
          steps: entry.example?.accessibleSteps ?? [],
        })
      : undefined,
    Promise.all(
      (entry.recipes ?? []).map(
        async (recipe) =>
          [
            recipe.id,
            await view(entry, { columns: COLUMNS.recipe, file: recipe.file, steps: recipe.steps }),
          ] as const
      )
    ),
    interactive ? keys(entry) : undefined,
  ]);

  return {
    api,
    ...(keyRows ? { keys: keyRows } : {}),
    ...(recipes.length > 0 ? { recipes: Object.fromEntries(recipes) } : {}),
    ...(registry === undefined ? {} : { registryDescription: registry }),
    source: sourceOf(entry.exports[0]!),
    views: { ...(accessible ? { accessible } : {}), narrow, rendered },
  };
}

/**
 * Captures every component.
 *
 * @returns Each one's capture, by slug.
 */
export async function captureComponents(): Promise<Record<string, ComponentCapture>> {
  const all = await inParallel(COMPONENTS, captureComponent);
  return Object.fromEntries(COMPONENTS.map((entry, at) => [entry.slug, all[at]!]));
}
