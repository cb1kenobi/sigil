import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The agent instructions a new app starts with: its `AGENTS.md`.
 *
 * They are `packages/sigil/docs/agents.md`, the block Getting started tells a
 * reader to paste into their own `AGENTS.md` -- so an app `sigil new` made and an
 * app somebody pasted the block into are told the same thing, from one file.
 * That file ships in `@ttylabs/sigil`, which this package depends on, so it is
 * read from the runtime this toolchain resolves rather than copied into it.
 * `should ship the files an agent is pointed at` in `cli.test.ts` is what keeps
 * it in the tarball.
 */

/**
 * The site the docs are published on.
 *
 * `website/src/lib/site.ts` is where the domain is spelled for the site itself;
 * this is the toolchain's copy, because a published package cannot import a
 * private app. `should name the site the website is published on` in
 * `agents.test.ts` holds the two together.
 */
export const SITE_URL = 'https://ttylabs.dev';

const require = createRequire(import.meta.url);

/**
 * The instructions, as `docs/agents.md` holds them, with nothing filled in.
 *
 * @returns The block.
 */
export function agentInstructionsSource(): string {
  const sigil = dirname(require.resolve('@ttylabs/sigil/package.json'));
  return readFileSync(join(sigil, 'docs', 'agents.md'), 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * The instructions for one app, with `{{version}}` and `{{site}}` filled in --
 * the same two placeholders `website/src/lib/includes.ts` fills for the page.
 *
 * @param version - The version of `@ttylabs/sigil` the app asks for.
 * @returns The block.
 * @throws When the block names a placeholder there is no value for, which would
 *   otherwise be written into the app as is.
 */
export function agentInstructions(version: string): string {
  const values: Record<string, string> = { site: SITE_URL, version };

  return agentInstructionsSource().replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`${whole} is no placeholder; the ones there are: ${Object.keys(values)}`);
    }
    return values[name]!;
  });
}
