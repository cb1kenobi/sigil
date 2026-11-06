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
 *
 * Two things more are said on the fence line, so that a guide asks for them
 * itself rather than the site special-casing a page:
 *
 * - ```` ```sh install=cli location=getting-started ```` is the **install box**
 *   (`InstallCommand`), with its vlt, pnpm and npm tabs. The body has to be the
 *   command the box shows before a reader picks a manager, so the guide on
 *   GitHub and the page with no script say the same thing, and a box that has
 *   drifted from its guide fails the build rather than shipping two commands;
 * - ```` ```md event=agent_instructions_copied ```` sends that event, instead
 *   of `command_copied`, when the block is copied.
 */

import type { AnalyticsEvent } from './analytics.ts';
import { COMMANDS, DEFAULT_PACKAGE_MANAGER, type InstallPackage } from './install-command.ts';

/** The events a fence's Copy button may send in place of `command_copied`. */
export const COPY_EVENTS = [
  'agent_instructions_copied',
] as const satisfies readonly AnalyticsEvent[];

export type CopyEventName = (typeof COPY_EVENTS)[number];

/** A fence, read. */
export type Fence =
  | {
      readonly code: string;
      /** What copying it sends, when it is not `command_copied`. */
      readonly event?: CopyEventName;
      readonly kind: 'code';
      readonly lang?: string;
      /** What the title bar names: a file, usually. */
      readonly title?: string;
    }
  | {
      /** The working directory the title bar shows; `''` for none. */
      readonly cwd?: string;
      readonly kind: 'console' | 'shell';
      readonly text: string;
    }
  | {
      readonly kind: 'install';
      /** Where it is on the page, for the analytics events. */
      readonly location: string;
      readonly package: InstallPackage;
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
 * ```` ```sh cwd="" ```` is a terminal with no directory in its title bar, for
 * a block that ran nowhere in particular: a command reference's usage line.
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

  if (name !== undefined && SHELL.has(name) && pairs.install !== undefined) {
    return installFence(pairs, body);
  }

  if (name !== undefined && (CONSOLE.has(name) || SHELL.has(name))) {
    return {
      ...(pairs.cwd !== undefined ? { cwd: pairs.cwd } : {}),
      kind: CONSOLE.has(name) ? 'console' : 'shell',
      text: body,
    };
  }

  const path = PATH.exec(body);
  const title = pairs.title ?? path?.[1];

  const event = pairs.event;
  if (event !== undefined && !(COPY_EVENTS as readonly string[]).includes(event)) {
    throw new Error(`event=${event} is not one a copy can send: ${COPY_EVENTS.join(', ')}`);
  }

  return {
    code: path && pairs.title === undefined ? body.slice(path[0].length) : body,
    ...(event ? { event: event as CopyEventName } : {}),
    kind: 'code',
    ...(lang ? { lang } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * An `install=` fence, checked against the box it becomes.
 *
 * @param pairs - The fence's meta.
 * @param body - The command the guide shows.
 * @returns The fence.
 * @throws When the package is not one the box installs, the location is
 *   missing, or the body is not the box's own command.
 */
function installFence(pairs: Record<string, string>, body: string): Fence {
  const pkg = pairs.install!;

  if (!Object.hasOwn(COMMANDS, pkg)) {
    throw new Error(`install=${pkg} is not one of: ${Object.keys(COMMANDS).join(', ')}`);
  }
  if (!pairs.location) {
    throw new Error(`install=${pkg} needs a location= for its analytics events`);
  }

  const expected = COMMANDS[pkg as InstallPackage][DEFAULT_PACKAGE_MANAGER];
  if (body.trim() !== expected) {
    throw new Error(`An install=${pkg} fence has to show "${expected}", not "${body.trim()}"`);
  }

  return { kind: 'install', location: pairs.location, package: pkg as InstallPackage };
}
