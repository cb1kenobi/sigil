import type { ComponentCapture, View } from '../../src/lib/component-data.ts';
import { COMPONENTS, type ComponentEntry, type Step } from '../../src/lib/components.ts';
import { captureEnv, inParallel, runJson, screenOf } from './capture.ts';
import { componentApi } from './component-options.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the components pages draw, produced by running each component.
 *
 * Every component has an example in `src/content/components/<slug>.mjs`, which
 * is ordinary app code and is what a page shows as its source. This runs it
 * through `run-example.mjs` -- on a faked terminal, with colour forced and a
 * fake clock, one child per run -- and keeps the screen it left at 80 columns,
 * which is the card's preview on the index. Beside it is the component's API,
 * from `component-options.ts`, which is where the index reads whether a
 * component has an accessible line form (its options take `accessible`) and
 * takes an `AbortSignal` (they take `signal`).
 *
 * `capture-transcripts.ts` writes the result to `src/transcripts/components/`
 * and `test/component-captures.test.ts` runs this again and fails when they are
 * not the same, so a change to a component cannot leave its card drawing output
 * it no longer produces.
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

/** The width of the rendered view. */
export const COLUMNS = 80;

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

/** Runs an example once and keeps the screen it left. */
async function view(
  entry: ComponentEntry,
  opts: { columns: number; steps?: readonly Step[] }
): Promise<View> {
  const rows = entry.example?.rows ?? 24;
  const spec = {
    columns: opts.columns,
    file: join(EXAMPLES, `${entry.slug}.mjs`),
    rows,
    steps: opts.steps ?? [],
    ...(entry.example?.cwd ? {} : { at: AT }),
  };
  const { output } = await runJson<{ output: string }>(RUNNER, [JSON.stringify(spec)], {
    cwd: entry.example?.cwd ? join(ROOT, entry.example.cwd) : PROJECT,
    env: captureEnv(opts.columns),
  });
  return { columns: opts.columns, output: screenOf(output, opts.columns, rows) };
}

/**
 * Captures one component.
 *
 * @param entry - Its metadata.
 * @returns What its card draws, and its API.
 */
export async function captureComponent(entry: ComponentEntry): Promise<ComponentCapture> {
  const registry =
    entry.registry === undefined ? undefined : registryDescriptions()[entry.registry];
  if (entry.registry !== undefined && registry === undefined) {
    throw new Error(`${entry.slug}: there is no \`sigil add\` entry called "${entry.registry}"`);
  }

  return {
    api: componentApi(entry.exports[0]!),
    ...(registry === undefined ? {} : { registryDescription: registry }),
    views: { rendered: await view(entry, { columns: COLUMNS, steps: entry.example?.steps }) },
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
