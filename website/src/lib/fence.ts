/**
 * What a fenced block in a docs page is: a file, a transcript, or a script.
 *
 * The site is mostly code and terminal output, and a reader should tell at a
 * glance which they are looking at. So the fence's language decides the
 * component and nothing else is asked:
 *
 * - ```` ```console ```` is a **transcript** -- `$` lines and what they printed
 *   -- and becomes a `TerminalBlock`, coloured from a capture where there is one;
 * - ```` ```sh ```` is a **script**, every line of it something to type, and
 *   becomes a `TerminalBlock` with a prompt on each command;
 * - anything else is a **file**, and becomes a `CodeBlock`: highlighted when the
 *   language is one `highlight.ts` knows, plain when it is not or there is none.
 */

/** A fence, read. */
export type Fence =
  | {
      readonly code: string;
      readonly kind: 'code';
      readonly lang?: string;
      /** What the title bar names: a file, usually. */
      readonly title?: string;
    }
  | {
      /** The working directory the title bar shows. */
      readonly cwd?: string;
      readonly kind: 'console' | 'shell';
      readonly text: string;
    };

/** The languages that are a transcript. */
const CONSOLE = new Set(['console', 'shell-session']);

/** The languages that are a script of commands. */
const SHELL = new Set(['bash', 'sh', 'shell', 'shellscript', 'zsh']);

/**
 * A path comment on a file's first line: `// src/commands/deploy.ts`.
 *
 * The guides write one at the top of every complete file, because
 * `packages/cli/test/guides.test.ts` reads it to know where to write the block.
 * On the site it is the file's name, so it goes in the title bar and comes out
 * of the body: a title bar reading `src/index.ts` over a first line reading
 * `// src/index.ts` says it twice.
 */
const PATH = /^\/\/ ([\w./-]+\.[\w]+)\n/u;

/**
 * The `key=value` pairs after a fence's language.
 *
 * ```` ```ts title="cli.ts" ```` names a file the body does not, and
 * ```` ```console cwd=~/my-cli ```` the directory a transcript ran in.
 *
 * @param meta - What follows the language on the fence line.
 * @returns The pairs.
 */
export function readMeta(meta: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};

  for (const match of (meta ?? '').matchAll(/([\w-]+)=(?:"([^"]*)"|(\S+))/gu)) {
    out[match[1]!] = match[2] ?? match[3]!;
  }

  return out;
}

/**
 * A fenced block, as the component that draws it.
 *
 * @param lang - The language, as written: `ts`, `console`, or nothing.
 * @param meta - What follows it on the fence line.
 * @param body - The block's text, without the newline markdown leaves after it.
 * @returns The fence.
 */
export function readFence(lang: string | undefined, meta: string | undefined, body: string): Fence {
  const pairs = readMeta(meta);
  const name = lang?.toLowerCase();

  if (name !== undefined && (CONSOLE.has(name) || SHELL.has(name))) {
    return {
      ...(pairs.cwd ? { cwd: pairs.cwd } : {}),
      kind: CONSOLE.has(name) ? 'console' : 'shell',
      text: body,
    };
  }

  const path = PATH.exec(body);
  const title = pairs.title ?? path?.[1];

  return {
    code: path && pairs.title === undefined ? body.slice(path[0].length) : body,
    kind: 'code',
    ...(lang ? { lang } : {}),
    ...(title ? { title } : {}),
  };
}
