import { scaffold } from '../src/scaffold/index.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Replaying a guide in `packages/sigil/docs/` as the program it claims to be.
 *
 * Two readers, which is why this is a module rather than the body of
 * `guides.test.ts`: that test replays every guide and compares what each `$`
 * line printed with what the page shows, and `website/scripts/capture-transcripts.ts`
 * replays the same steps with colour forced, to give the website the real SGR
 * output to draw. Two copies of "what a step is" would come to disagree about
 * which lines are runnable, and the website's drift test would then be checking
 * a transcript the guide test never ran. So both import these.
 *
 * Nothing here imports vitest, for the same reason: the capture script is run
 * by hand with `node`, outside any test runner.
 */

/** The repository root. */
export const root: string = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Where the guides are. */
export const docs: string = resolve(root, 'packages/sigil/docs');

const require = createRequire(import.meta.url);

/** `@ttylabs/sigil`'s package directory, as this package resolves it. */
const sigil = dirname(require.resolve('@ttylabs/sigil/package.json'));

export interface Guide {
  /** The markdown file, under `packages/sigil/docs/`. */
  readonly file: string;
  /**
   * The app `sigil new` would have written before the guide's first block. The
   * name is the bin the transcripts call.
   */
  readonly scaffold: string;
}

export const GUIDES: readonly Guide[] = [{ file: 'getting-started.md', scaffold: 'my-cli' }];

export interface Block {
  readonly body: string;
  readonly info: string;
  /** The line of the markdown file the opening fence is on, counting from 1. */
  readonly line: number;
}

/** Every fenced block in a markdown file, in order. */
export function blocks(markdown: string): Block[] {
  const found: Block[] = [];
  for (const match of markdown.matchAll(/^```(\S*)[^\n]*\n([\s\S]*?)^```$/gm)) {
    const line = markdown.slice(0, match.index).split('\n').length;
    found.push({ body: match[2]!, info: match[1]!, line });
  }
  return found;
}

export type Step =
  | { readonly kind: 'write'; readonly body: string; readonly path: string }
  | {
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly expected: string;
      readonly kind: 'run';
      readonly typed: string;
    };

/**
 * A path comment, as one line: `// src/commands/deploy.ts`. It names a file only
 * on a block's first line, and `misplaced()` looks for it on the others.
 */
const PATH = /^\/\/ ([\w./-]+\.(?:[cm]?[jt]s))$/;

/** Whether a fence's language is one whose blocks can be files. */
function isFile(info: string): boolean {
  return info === 'js' || info === 'ts';
}

/**
 * The `// <path>` comments in a guide that are not on their block's first line.
 *
 * `steps()` writes a block only when its first line is the comment, so one that
 * has moved down is a file nothing runs -- and nothing says so, because the
 * block is then just another fragment. oxfmt sorts the imports in a markdown
 * code block and a comment travels with the import under it, which is how a
 * heading ends up on line 2.
 *
 * @param guide - The guide.
 * @param markdown - Its text.
 * @returns One description per misplaced comment, naming the markdown line it is on.
 */
export function misplaced(guide: Guide, markdown: string): string[] {
  const found: string[] = [];
  for (const { body, info, line } of blocks(markdown)) {
    if (!isFile(info)) {
      continue;
    }
    body.split('\n').forEach((text, row) => {
      if (row > 0 && PATH.test(text)) {
        found.push(
          `${guide.file}:${line + row + 1}: "${text}" is on line ${row + 1} of its block, not line 1`
        );
      }
    });
  }
  return found;
}

/** A leading `NAME=value` on a transcript line. */
const ASSIGN = /^([A-Z_][A-Z0-9_]*)=(\S*)$/;

/**
 * A guide as the steps that replay it.
 *
 * - a `js` or `ts` block whose first line is `// <path>` is written to that
 *   path, replacing whatever an earlier block wrote there;
 * - a `console` block is a transcript, and every `$` line in it that calls the
 *   app's bin is a run, with the lines under it as the output it must print.
 *
 * @param guide - The guide.
 * @param markdown - Its text.
 * @returns The writes and the runs, in document order, and the `$` lines that
 *   were not runnable here.
 */
export function steps(guide: Guide, markdown: string): { skipped: string[]; steps: Step[] } {
  const out: Step[] = [];
  const skipped: string[] = [];

  for (const { body, info } of blocks(markdown)) {
    if (isFile(info)) {
      const path = PATH.exec(body.split('\n', 1)[0]!)?.[1];
      if (path !== undefined) {
        out.push({ body: body.slice(body.indexOf('\n') + 1), kind: 'write', path });
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

      if (words[0] !== guide.scaffold) {
        skipped.push(typed);
        continue;
      }
      out.push({
        argv: ['dev.ts', ...words.slice(1)],
        env,
        expected: rest.join('\n'),
        kind: 'run',
        typed,
      });
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
 * cannot change the answer to a line that does not set it. A caller that wants
 * colour adds `FORCE_COLOR` after this, which is what the capture script does.
 */
export function environment(
  all: readonly Step[],
  own: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
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

export interface Ran {
  readonly code: number | null;
  readonly output: string;
}

/** Runs node in `cwd`, reading stdout and then stderr. */
export function run(cwd: string, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Ran> {
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

/**
 * A guide as LF, whatever the checkout gave it. `.gitattributes` leaves `.md` to
 * `text=auto`, so Windows checks the guides out CRLF -- and every expected line
 * then ends in a `\r` the program's own output never had.
 */
export function readGuide(file: string): string {
  return readFileSync(join(docs, file), 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * Writes the app `sigil new` would have scaffolded for a guide into `dir`, with
 * `@ttylabs/sigil` linked in as this package resolves it.
 *
 * @param dir - An empty directory.
 * @param guide - The guide.
 */
export function prepare(dir: string, guide: Guide): void {
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
  mkdirSync(join(dir, 'node_modules', '@ttylabs'), { recursive: true });
  // a junction, which Windows makes without the privilege a symlink needs
  // and every other platform reads as an ordinary directory link
  symlinkSync(sigil, join(dir, 'node_modules', '@ttylabs', 'sigil'), 'junction');
}

/**
 * Writes one `write` step into the app.
 *
 * @param dir - The app.
 * @param step - The step.
 */
export function write(dir: string, step: Step & { kind: 'write' }): void {
  mkdirSync(dirname(join(dir, step.path)), { recursive: true });
  writeFileSync(join(dir, step.path), step.body);
}
