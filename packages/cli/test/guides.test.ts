import { blocks, environment, GUIDES, prepare, readGuide, run, steps, write } from './guides.ts';
import { tempDir } from './temp.ts';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The guides in `packages/sigil/docs/`, read as the programs they claim to be.
 *
 * A guide's examples are the part of the documentation a reader copies, so they
 * are the part that has to be true -- and nothing else in the repository runs
 * them. The parser reference describes behaviour the suite already pins; a
 * guide shows a file and then what a terminal printed for it, and the only way
 * to know that pairing still holds is to write the file and run the command.
 *
 * So each guide is replayed in document order, over the app `sigil new` would
 * have scaffolded, in a directory of its own:
 *
 * - a `js` or `ts` block whose first line is `// <path>` is written to that
 *   path, replacing whatever an earlier block wrote there. oxfmt sorts the
 *   imports inside a markdown code block and a comment travels with the import
 *   under it, so write a block's imports in sorted order or the path comment
 *   moves -- and the block silently stops being a file, which the skipped-line
 *   assertion below is what notices;
 * - a `console` block is a transcript, and every `$` line in it that calls the
 *   app's bin is run from source, with the lines under it as the output it must
 *   print -- stdout, then stderr, since a transcript has no way to say which
 *   stream a line went to.
 *
 * A `$` line that runs anything else -- `npx`, `npm run build`, the bundle in
 * `dist/` -- is left alone. Those need a network, a package manager or a build,
 * which is the `new.test.ts` reason for doing that half by hand, and the guides
 * show their output as illustration rather than as a claim this can check.
 *
 * The replay itself -- what a step is, the environment it runs in, the app it
 * runs over -- is `guides.ts`, which the website's transcript capture shares.
 *
 * What is deliberately *not* done is type-checking the blocks. Most of a guide
 * is fragments, and the complete files are already proved by running them;
 * what a type-check would add is the inferred `argv` types, which
 * `packages/sigil/test/` pins far more precisely than a guide could.
 *
 * Nor are a guide's links followed here. `packages/sigil/test/markdown-links.test.ts`
 * does that for every markdown file in the repository, the guides among them,
 * since a dead link is a property of the tree rather than of a guide and needs
 * no build to find.
 */

const require = createRequire(import.meta.url);

for (const guide of GUIDES) {
  const markdown = readGuide(guide.file);
  const { skipped, steps: all } = steps(guide, markdown);

  describe(`the examples in ${guide.file}`, () => {
    let dir: string;
    let applied = 0;

    beforeAll(() => {
      dir = tempDir('sigil-guides-');
      prepare(dir, guide);
    });

    it('should have found them', () => {
      // a format change that matched nothing would pass every case below
      expect(all.filter((step) => step.kind === 'write').length).toBeGreaterThan(2);
      expect(all.filter((step) => step.kind === 'run').length).toBeGreaterThan(5);
      // and a `$` line that silently stopped being runnable is the same hole
      // from the other side, so what is skipped is written down
      expect(skipped).toEqual([
        'npx @ttylabs/cli new my-cli --yes',
        'npm test',
        'npm run build',
        'node dist/my-cli.mjs --help',
        'node dist/my-cli.mjs --version',
      ]);
    });

    all.forEach((step, index) => {
      if (step.kind !== 'run') {
        return;
      }
      it(`should print what it shows for \`$ ${step.typed}\``, async () => {
        // every file written before this point in the guide, and no later one,
        // which also holds for a single case picked out with `-t`
        for (; applied < index; applied++) {
          const earlier = all[applied]!;
          if (earlier.kind === 'write') {
            write(dir, earlier);
          }
        }

        const ran = await run(dir, step.argv, environment(all, step.env));
        expect(ran.output).toBe(step.expected);
      });
    });
  });
}

/**
 * Every named import a guide makes from a workspace package, asked of the built
 * package -- the half of `demos.test.ts` that reads rather than runs, and the
 * only check the fragments get, since a fragment is not a program.
 */
describe('the imports in the guides', () => {
  for (const guide of GUIDES) {
    const markdown = readGuide(guide.file);

    it(`should be exported, in ${guide.file}`, async () => {
      let checked = 0;
      for (const { body } of blocks(markdown)) {
        for (const match of body.matchAll(/import\s+\{([^}]*)\}\s*from\s*'(@ttylabs\/[^']+)'/g)) {
          const module = (await import(pathToFileURL(require.resolve(match[2]!)).href)) as Record<
            string,
            unknown
          >;
          for (const part of match[1]!.split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0]!;
            if (name) {
              expect(Object.hasOwn(module, name), `${match[2]} exports ${name}`).toBe(true);
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(2);
    });
  }
});

/**
 * A guide that is written over an example rather than over a scaffold.
 *
 * `full-screen-apps.md` cannot be replayed the way `getting-started.md` is:
 * its app is JSX, which Node will not run from source, and its transcripts open
 * a full screen that waits for keys. What it can be is an excerpt of an example
 * that `examples.test.ts` already builds, mounts, drives and quits -- so every
 * `ts` or `tsx` block whose first line is `// src/<path>` has to appear in that
 * example's file of the same path, line for line. A block that drifts from the
 * code fails here; code that stops working fails there.
 *
 * Line for line rather than byte for byte, because the formatter re-indents a
 * fragment inside a code fence -- a `return (` lifted out of a function body
 * comes back at column zero -- and how far a quoted line is indented is the
 * formatter's to say rather than a difference in what the code is.
 */
const EXCERPTED: readonly { example: string; file: string }[] = [
  { example: 'hello', file: 'full-screen-apps.md' },
];

/** Text with each line's indentation taken off, which is what an excerpt is compared as. */
function unindented(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

describe('the guides that excerpt an example', () => {
  for (const { example, file } of EXCERPTED) {
    it(`should quote examples/${example} line for line, in ${file}`, () => {
      let checked = 0;
      for (const { body, info } of blocks(readGuide(file))) {
        const path = /^\/\/ (src\/[\w./-]+)\n/.exec(body)?.[1];
        if ((info !== 'ts' && info !== 'tsx') || path === undefined) {
          continue;
        }
        const source = unindented(readFileSync(join(root, 'examples', example, path), 'utf-8'));
        const excerpt = unindented(body.slice(body.indexOf('\n') + 1));
        expect(source.includes(excerpt), `${file} quotes ${path} as it no longer is`).toBe(true);
        checked++;
      }
      // a fence or a path comment that stopped matching would check nothing
      expect(checked).toBeGreaterThan(4);
    });
  }
});
