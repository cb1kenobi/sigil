import { SITE_URL } from './site.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A guide that shows another file as a block: the agent instructions in
 * Getting started, which are `packages/sigil/docs/agents.md`.
 *
 * The file is one source for three readers -- this page, the test in
 * `packages/cli/test/agents.test.ts` that checks every export and path it names,
 * and `llms.txt` -- so the guide does not hold a copy of it. It holds a
 * directive, and between the directive and its end what a reader of the raw
 * markdown on GitHub sees instead, which GitHub shows and the comments around it
 * it does not:
 *
 * ```md
 * <!-- include agents.md title="AGENTS.md · sigil v{{version}}" event=agent_instructions_copied -->
 *
 * The block is [`agents.md`](agents.md), beside this guide.
 *
 * <!-- /include -->
 * ```
 *
 * On the site all of that is the file as a fence, `md` after its extension,
 * with what follows the file name as the fence's meta -- so the title and the
 * Copy button's event are said by the guide, and read by `fence.ts` exactly as
 * they would be on a fence written by hand.
 *
 * Done to the text rather than as a remark plugin, because what the guide *is*
 * once its includes are in is a markdown file of its own: the outline is read
 * from it, and the Markdown version of the page is the same text.
 */

/** The package whose version the docs describe, from the website's working directory. */
const SIGIL_MANIFEST = join(process.cwd(), '..', 'packages', 'sigil', 'package.json');

/**
 * `@ttylabs/sigil`'s version, read from its `package.json` when the site is
 * built. Never typed anywhere, so a release cannot leave a page behind.
 *
 * @returns The version.
 */
export function sigilVersion(): string {
  return (JSON.parse(readFileSync(SIGIL_MANIFEST, 'utf-8')) as { version: string }).version;
}

/**
 * What a `{{name}}` in an included file or a directive stands for.
 *
 * The site's address is a placeholder too, because the instructions are pasted
 * into somebody else's project and have to name it in full, and `SITE_URL` is
 * the one place the domain is spelled.
 */
function placeholders(): Record<string, string> {
  return { site: SITE_URL, version: sigilVersion() };
}

/**
 * Fills every `{{name}}` in a piece of text.
 *
 * @param text - The text.
 * @returns It, filled.
 * @throws When it names a placeholder there is no value for, which would
 *   otherwise be printed as is on a page and pasted as is into a project.
 */
export function fill(text: string): string {
  const values = placeholders();

  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`${whole} is no placeholder; the ones there are: ${Object.keys(values)}`);
    }
    return values[name]!;
  });
}

/** An include: the directive, what it names, and everything up to its end. */
const INCLUDE =
  /^<!--[ \t]*include[ \t]+(\S+)(.*?)[ \t]*-->\n[\s\S]*?^<!--[ \t]*\/include[ \t]*-->$/gm;

/** The opening half alone, for a directive whose end is missing. */
const OPEN = /^<!--[ \t]*include[ \t]+(\S+)/gm;

/**
 * The files a guide includes, in order.
 *
 * @param markdown - The guide.
 * @returns The file names, as the directives spell them.
 */
export function includesOf(markdown: string): string[] {
  return [...markdown.matchAll(OPEN)].map((match) => match[1]!);
}

/**
 * A guide with every include replaced by the file it names, as a fence.
 *
 * @param markdown - The guide, LF line endings.
 * @param dir - Where the included files are: the guide's own directory.
 * @returns The guide as the site renders it.
 * @throws When a directive has no end, or names a file that is not there.
 */
export function expandIncludes(markdown: string, dir: string): string {
  const expanded = markdown.replace(INCLUDE, (_, name: string, meta: string) => {
    const body = fill(readFileSync(join(dir, name), 'utf-8').replaceAll('\r\n', '\n')).replace(
      /\n+$/,
      ''
    );
    // a fence longer than any run of backticks inside it, so none of them closes it
    const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const lang = /\.(\w+)$/.exec(name)?.[1] ?? '';

    return `${fence}${lang}${fill(meta).trimEnd()}\n${body}\n${fence}`;
  });

  const left = includesOf(expanded);
  if (left.length > 0) {
    throw new Error(`An include of ${left[0]} has no <!-- /include --> to end it`);
  }
  return expanded;
}
