import { scaffold } from '../src/scaffold/index.ts';
import { tempDir } from './temp.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * So each guide is replayed in document order, in a directory of its own:
 *
 * - a `js` or `ts` block whose first line is `// <path>` is written to that
 *   path, replacing whatever an earlier block wrote there. oxfmt sorts the
 *   imports inside a markdown code block and a comment travels with the import
 *   under it, so write a block's imports in sorted order or the path comment
 *   moves -- and the block silently stops being a file, which the skipped-line
 *   assertion below is what notices;
 * - a `console` block is a transcript, and every `$` line in it that runs a
 *   file the guide itself wrote is run, with the lines under it as the output
 *   it must print -- stdout, then stderr, since a transcript has no way to say
 *   which stream a line went to.
 *
 * A `$` line that runs anything else -- `npx`, `npm run build`, the bundle in
 * `dist/` -- is left alone. Those need a network, a package manager or a build,
 * which is the `new.test.ts` reason for doing that half by hand, and the guides
 * show their output as illustration rather than as a claim this can check.
 *
 * What is deliberately *not* done is type-checking the blocks. Most of a guide
 * is fragments, and the complete files are already proved by running them;
 * what a type-check would add is the inferred `argv` types, which
 * `packages/sigil/test/` pins far more precisely than a guide could.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const docs = resolve(root, 'packages/sigil/docs');
const require = createRequire(import.meta.url);

/** `@ttylabs/sigil`'s package directory, as this package resolves it. */
const sigil = dirname(require.resolve('@ttylabs/sigil/package.json'));

interface Guide {
  /** The markdown file, under `packages/sigil/docs/`. */
  readonly file: string;
  /**
   * The app `sigil new` would have written before the guide's first block, if
   * the guide starts from one. The name is the bin the transcripts call.
   */
  readonly scaffold?: string;
}

const GUIDES: readonly Guide[] = [
  { file: 'getting-started.md', scaffold: 'my-cli' },
  { file: 'migrating-from-cli-kit.md' },
];

interface Block {
  readonly body: string;
  readonly info: string;
}

/** Every fenced block in a markdown file, in order. */
function blocks(markdown: string): Block[] {
  const found: Block[] = [];
  for (const match of markdown.matchAll(/^```(\S*)[^\n]*\n([\s\S]*?)^```$/gm)) {
    found.push({ body: match[2]!, info: match[1]! });
  }
  return found;
}

type Step =
  | { readonly kind: 'write'; readonly body: string; readonly path: string }
  | {
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly expected: string;
      readonly kind: 'run';
      readonly typed: string;
    };

/** A path comment on a block's first line: `// src/commands/deploy.ts`. */
const PATH = /^\/\/ ([\w./-]+\.(?:[cm]?[jt]s))\n/;

/** A leading `NAME=value` on a transcript line. */
const ASSIGN = /^([A-Z_][A-Z0-9_]*)=(\S*)$/;

/**
 * A guide as the steps that replay it.
 *
 * @param guide - The guide.
 * @param markdown - Its text.
 * @returns The writes and the runs, in document order, and the `$` lines that
 *   were not runnable here.
 */
function steps(guide: Guide, markdown: string): { skipped: string[]; steps: Step[] } {
  const out: Step[] = [];
  const skipped: string[] = [];
  const written = new Set<string>();

  for (const { body, info } of blocks(markdown)) {
    if (info === 'js' || info === 'ts') {
      const path = PATH.exec(body)?.[1];
      if (path !== undefined) {
        out.push({ body: body.slice(body.indexOf('\n') + 1), kind: 'write', path });
        written.add(path);
      }
      continue;
    }
    if (info !== 'console') {
      continue;
    }

    // a `$` line and the output lines under it, up to the next `$`
    for (const chunk of body.split(/^(?=\$ )/m)) {
      if (!chunk.startsWith('$ ')) {
        continue;
      }
      const [first = '', ...rest] = chunk.replace(/\n$/, '').split('\n');
      const typed = first.slice(2);
      if (/["'`\\]/.test(typed)) {
        throw new Error(`${guide.file}: quoting is not supported in "${typed}"`);
      }

      const words = typed.split(/\s+/).filter(Boolean);
      const env: Record<string, string> = {};
      while (words.length > 0 && ASSIGN.test(words[0]!)) {
        const [, name, value] = ASSIGN.exec(words.shift()!)!;
        env[name!] = value!;
      }

      let argv: string[] | undefined;
      if (guide.scaffold !== undefined && words[0] === guide.scaffold) {
        argv = ['dev.ts', ...words.slice(1)];
      } else if (words[0] === 'node' && written.has(words[1] ?? '')) {
        argv = words.slice(1);
      }

      if (argv === undefined) {
        skipped.push(typed);
        continue;
      }
      out.push({ argv, env, expected: rest.join('\n'), kind: 'run', typed });
    }
  }
  return { skipped, steps: out };
}

/**
 * The environment a transcript is run in.
 *
 * Fixed rather than inherited for everything that changes what an app prints:
 * the width help wraps at, colour, sigil's own debug log, and every variable a
 * transcript in the guide sets -- so a `DEPLOY_RETRIES` left in somebody's shell
 * cannot change the answer to a line that does not set it.
 */
function environment(all: readonly Step[], own: Readonly<Record<string, string>>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['DEBUG', 'FORCE_COLOR', 'NO_COLOR', 'SIGIL_LOCALE']) {
    delete env[name];
  }
  for (const step of all) {
    if (step.kind === 'run') {
      for (const name of Object.keys(step.env)) {
        delete env[name];
      }
    }
  }
  return { ...env, COLUMNS: '80', ...own };
}

interface Ran {
  readonly code: number | null;
  readonly output: string;
}

/** Runs node in `cwd`, reading stdout and then stderr. */
function run(cwd: string, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [...argv], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      // `\r?` because a pipe on Windows is still whatever wrote to it
      settle({ code, output: (stdout + stderr).replace(/\r\n/g, '\n').replace(/\n+$/, '') });
    });
  });
}

for (const guide of GUIDES) {
  const markdown = readFileSync(join(docs, guide.file), 'utf-8');
  const { skipped, steps: all } = steps(guide, markdown);

  describe(`the examples in ${guide.file}`, () => {
    let dir: string;
    let applied = 0;

    beforeAll(() => {
      dir = tempDir('sigil-guides-');
      if (guide.scaffold !== undefined) {
        for (const file of scaffold({
          language: 'ts',
          layout: 'multi',
          linter: 'oxlint',
          manager: 'npm',
          name: guide.scaffold,
          version: '0.0.0',
          // what `sigil new` itself writes, which is the toolchain's own
          versions: (
            JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf-8')) as {
              devDependencies: Record<string, string>;
            }
          ).devDependencies,
        })) {
          mkdirSync(dirname(join(dir, file.path)), { recursive: true });
          writeFileSync(join(dir, file.path), file.contents);
        }
      } else {
        writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
      }
      mkdirSync(join(dir, 'node_modules', '@ttylabs'), { recursive: true });
      // a junction, which Windows makes without the privilege a symlink needs
      // and every other platform reads as an ordinary directory link
      symlinkSync(sigil, join(dir, 'node_modules', '@ttylabs', 'sigil'), 'junction');
    });

    it('should have found them', () => {
      // a format change that matched nothing would pass every case below
      expect(all.filter((step) => step.kind === 'write').length).toBeGreaterThan(2);
      expect(all.filter((step) => step.kind === 'run').length).toBeGreaterThan(5);
      // and a `$` line that silently stopped being runnable is the same hole
      // from the other side, so what is skipped is written down
      expect(skipped).toEqual(
        guide.scaffold === undefined
          ? []
          : [
              'npx @ttylabs/cli new my-cli --yes',
              'npm test',
              'npm run build',
              'node dist/my-cli.mjs --help',
              'node dist/my-cli.mjs --version',
            ]
      );
    });

    all.forEach((step, index) => {
      if (step.kind !== 'run') {
        return;
      }
      it(`should print what it shows for \`$ ${step.typed}\``, async () => {
        // every file written before this point in the guide, and no later one,
        // which also holds for a single case picked out with `-t`
        for (; applied < index; applied++) {
          const write = all[applied]!;
          if (write.kind === 'write') {
            mkdirSync(dirname(join(dir, write.path)), { recursive: true });
            writeFileSync(join(dir, write.path), write.body);
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
    const markdown = readFileSync(join(docs, guide.file), 'utf-8');

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
