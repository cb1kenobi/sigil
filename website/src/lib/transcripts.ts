import type { Lookup } from './terminal-rows.ts';
import { strip } from '@ttylabs/sigil/ansi';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The captured transcripts in `src/transcripts/`, which is where a terminal
 * block's real colour comes from.
 *
 * `scripts/capture-transcripts.ts` writes them by replaying each guide with
 * colour forced, and they are committed for the reason `src/reference/` is.
 * Read off disk from the working directory, as `reference.ts` reads its pages:
 * every page that draws one is prerendered, so this runs during the build.
 */

/** Where the captures are. */
const DIR = join(process.cwd(), 'src', 'transcripts');

/** One capture file. */
export interface Capture {
  /** The guide it was captured from, from the repository root. */
  readonly guide: string;
  /** What each command printed, escape sequences and all. */
  readonly runs: readonly { readonly command: string; readonly output: string }[];
}

/**
 * Every capture file.
 *
 * A directory that is not there is **no captures**, which leaves every block to
 * its glyph rules rather than failing a build over colour.
 *
 * @returns The captures.
 */
export function captures(): Capture[] {
  let names: string[];

  try {
    names = readdirSync(DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as Capture);
}

/**
 * Looks a run up by what it was and what it printed.
 *
 * A capture is used only when its text, with the escapes taken out, is
 * **exactly** the text the block shows. That is what keeps a block honest when
 * a guide and its capture have come apart: the colour is the program's or there
 * is none, and never the program's colour laid over words it did not print. The
 * same command can appear more than once with different output -- `my-cli
 * --help` before and after a command is added -- and the text is what tells the
 * two apart.
 *
 * @param from - The captures to look in.
 * @returns The lookup.
 */
export function lookup(from: readonly Capture[] = captures()): Lookup {
  const byCommand = new Map<string, string[]>();

  for (const capture of from) {
    for (const { command, output } of capture.runs) {
      byCommand.set(command, [...(byCommand.get(command) ?? []), output]);
    }
  }

  return (command, output) => byCommand.get(command)?.find((sgr) => strip(sgr) === output);
}
