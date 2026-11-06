import {
  environment,
  GUIDES,
  prepare,
  readGuide,
  run,
  steps,
  write,
} from '../../packages/cli/test/guides.ts';
import { captureHome } from './lib/home-capture.ts';
import { strip } from '@ttylabs/sigil/ansi';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * Captures what the guides' commands really print, colour and all, for the
 * website's terminal blocks.
 *
 * A guide's ```` ```console ```` block is plain text, because a markdown file
 * cannot hold an escape sequence and a reader of the raw file should not have to
 * read one. What the program printed was coloured, though, and drawing it with
 * colour the site invented would be a page claiming output nobody produced. So
 * this replays each guide exactly as `packages/cli/test/guides.test.ts` does --
 * the same steps, over the same scaffold, from `packages/cli/test/guides.ts` --
 * with `FORCE_COLOR=1`, and writes what came back to `src/transcripts/`.
 *
 * `FORCE_COLOR=1` is the basic sixteen colours, which is what the site has
 * tokens for; a palette or truecolor capture would carry colours the design has
 * no name for.
 *
 * Committed rather than run by `next build`, which is the call `src/reference/`
 * makes: the website's build should not need to scaffold and run an app, and a
 * transcript in the tree is one a reviewer reads in the diff. The output is JSON,
 * whose `\u001b` escapes keep every raw control character out of the committed
 * file. `test/transcripts.test.ts` fails when a guide and its capture have come
 * apart, and says to run this again:
 *
 *   node scripts/capture-transcripts.ts
 *
 * The home page's terminals are captured the same way, from `lib/home-capture.ts`
 * -- prompts and components driven for real, the `todo` app the page shows the
 * source of, shell completion, and `sigil --help` -- into
 * `src/transcripts/home/screens.json`. A subdirectory, because `captures()` reads
 * every `.json` beside the guides' and those have a `guide` and a list of runs.
 *
 * It needs `@ttylabs/sigil` built, as the guide test does, and `@ttylabs/cli`
 * for the help screen.
 */

const OUT = join(import.meta.dirname, '../src/transcripts');

mkdirSync(OUT, { recursive: true });

for (const guide of GUIDES) {
  const all = steps(guide, readGuide(guide.file)).steps;
  const dir = mkdtempSync(join(tmpdir(), 'sigil-transcripts-'));
  const runs: { command: string; output: string }[] = [];

  try {
    prepare(dir, guide);

    for (const step of all) {
      if (step.kind === 'write') {
        write(dir, step);
        continue;
      }

      const ran = await run(dir, step.argv, {
        ...environment(all, step.env),
        FORCE_COLOR: '1',
      });

      // the guide test asserts this without colour; asserting it again here
      // means a capture is never written over a guide that is already wrong
      if (strip(ran.output) !== step.expected) {
        throw new Error(
          `${guide.file}: \`$ ${step.typed}\` no longer prints what the guide shows. ` +
            'Fix the guide first: `pnpm test packages/cli/test/guides.test.ts`.'
        );
      }

      runs.push({ command: step.typed, output: ran.output });
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }

  const file = join(OUT, guide.file.replace(/\.md$/, '.json'));
  const capture = {
    guide: `packages/sigil/docs/${guide.file}`,
    columns: 80,
    runs,
  };
  writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`  wrote ${relative(process.cwd(), file)}  ${runs.length} runs`);
}

mkdirSync(join(OUT, 'home'), { recursive: true });
const homeFile = join(OUT, 'home', 'screens.json');
const home = await captureHome();
writeFileSync(homeFile, `${JSON.stringify(home, null, 2)}\n`);
console.log(
  `  wrote ${relative(process.cwd(), homeFile)}  ${Object.keys(home.screens).length} screens`
);
