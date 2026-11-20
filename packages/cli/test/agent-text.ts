import { root } from './guides.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Reading text written for a coding agent: `packages/sigil/docs/agents.md`, and
 * the skills `@ttylabs/sigil` and `@ttylabs/cli` ship.
 *
 * Their reader cannot check them. A person who meets a wrong export in a guide
 * finds out when the import fails; an agent told to import a name that is gone
 * writes the import anyway, in somebody else's project, and the error lands on
 * them. So what they name has to exist, and `agents.test.ts` and
 * `skills.test.ts` ask the same questions of each through these -- one
 * definition of "names an export", rather than two that come to disagree about
 * which spans they read.
 *
 * What they do not check is that a sentence is still *true*. That is behaviour,
 * and the suites of both packages pin it far more closely than a check of prose
 * could; what rots silently in text like this is a name.
 */

const require = createRequire(import.meta.url);

/** Every code span in a piece of markdown. */
export function codeSpans(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
}

/**
 * The published packages: their directories and manifests, by name.
 *
 * Read off `packages/` rather than listed, as `what every package publishes` in
 * `cli.test.ts` reads it, so a new package is known here without anybody
 * remembering to add it.
 */
export function workspacePackages(): Map<string, { dir: string; files: readonly string[] }> {
  const packages = join(root, 'packages');
  return new Map(
    readdirSync(packages, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(packages, entry.name, 'package.json'))
      )
      .flatMap((entry) => {
        const dir = join(packages, entry.name);
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
          files?: string[];
          name: string;
          private?: boolean;
        };
        return manifest.private === true
          ? []
          : [[manifest.name, { dir, files: manifest.files ?? [] }] as const];
      })
  );
}

/** Whether a specifier is one this package can import. */
export function resolves(specifier: string): boolean {
  try {
    require.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** A module's exports, asked of the built package. */
export async function exportsOf(specifier: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(require.resolve(specifier)).href)) as Record<string, unknown>;
}

/** Every `@ttylabs/...` specifier the spans name, once each. */
export function specifiersIn(spans: readonly string[]): string[] {
  return [...new Set(spans.filter((span) => span.startsWith('@ttylabs/')))];
}

/**
 * Every "`name` from `module`" the markdown says, as `[name, module]`.
 *
 * The prose around it is free: a claim wraps across lines, closes a bold run
 * just before its "from", names a call with its arguments, and names several
 * at once ("`ansi` and `strip()` from"), each of which is tied to the module.
 */
export function exportClaims(markdown: string): [string, string][] {
  const name = String.raw`\`\w+(?:\([^\`]*\))?\``;
  const claim = new RegExp(
    String.raw`((?:${name}(?:,\s*|\s+and\s+|,\s+and\s+))*${name})\**\s+from\s+\`(@ttylabs\/[\w/-]+)\``,
    'g'
  );
  return [...markdown.matchAll(claim)].flatMap(([, names, specifier]) =>
    [...names!.matchAll(/`(\w+)/g)].map(([, each]) => [each!, specifier!] as [string, string])
  );
}

/** Every span that is a bare call, `name()`, as its name. */
export function callsIn(spans: readonly string[]): string[] {
  return spans.flatMap((span) => /^(\w+)\(\)$/.exec(span)?.[1] ?? []);
}

/**
 * Names written with parentheses that are a declaration's own property rather
 * than anything a module exports. Each one is here on purpose.
 */
export const PROPERTIES: ReadonlySet<string> = new Set([
  // a command's handler
  'run',
]);

/** Every `sigil <command>` the spans name, as the command. */
export function commandsIn(spans: readonly string[]): string[] {
  return spans.flatMap((span) => /^sigil (\w+)/.exec(span)?.[1] ?? []);
}

/**
 * Whether the toolchain has a command: one of its own, or one every sigil app
 * has -- `completion` and `help` are the framework's, so they are no file in
 * `src/commands/`.
 */
export function isToolchainCommand(command: string): boolean {
  return (
    command === 'completion' ||
    command === 'help' ||
    existsSync(join(root, 'packages/cli/src/commands', `${command}.ts`))
  );
}

/**
 * Every span that names a file inside an installed package, as
 * `node_modules/<package>/<path>`.
 */
export function installedPathsIn(spans: readonly string[]): { name: string; path: string }[] {
  return spans.flatMap((span) => {
    const match = /^node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\/([\w./-]+)$/.exec(span);
    return match ? [{ name: match[1]!, path: match[2]! }] : [];
  });
}

/**
 * Whether a package's tarball holds a file: it is on disk, and its manifest's
 * `files` takes it -- or it is one npm packs whatever `files` says.
 *
 * Read from the manifest rather than asked of `pnpm pack`, which costs a process
 * per package; `should ship the files an agent is pointed at` in `cli.test.ts`
 * asks the real pack list for the files that matter most.
 *
 * @param dir - The package's directory.
 * @param files - Its manifest's `files`.
 * @param path - The file, relative to the package, with forward slashes.
 */
export function ships(dir: string, files: readonly string[], path: string): boolean {
  if (!existsSync(join(dir, path)) || !statSync(join(dir, path)).isFile()) {
    return false;
  }
  if (/^(?:package\.json|readme(?:\.[^/]*)?|license(?:\.[^/]*)?)$/i.test(path)) {
    return true;
  }
  return files.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/** Markdown with its fenced code blocks taken out, which hold no headings and no links. */
function prose(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
}

/**
 * Every fragment a link can name in a markdown file, the way GitHub makes them:
 * each heading's text lowercased, with everything but letters, digits, spaces,
 * hyphens and underscores removed and spaces made hyphens -- `-1`, `-2` on a
 * repeat -- plus every `<a id="...">`.
 */
export function anchorsOf(markdown: string): Set<string> {
  const text = prose(markdown);
  const anchors = new Set<string>();
  const seen = new Map<string, number>();

  for (const [, heading] of text.matchAll(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)) {
    // what GitHub slugs is the rendered text: a code span's content is kept
    // whole, while around it a tag, a link's target and the markers of
    // emphasis are not text at all
    const plain = heading!
      .split(/(`[^`]*`)/)
      .map((part, i) =>
        i % 2 === 1
          ? part.slice(1, -1)
          : part
              .replace(/<[^>]*>/g, '')
              .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
              .replace(/\*+/g, '')
              .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
      )
      .join('');
    const slug = plain
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  for (const [, id] of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) {
    anchors.add(id!);
  }
  return anchors;
}

/** Every inline link's target in a markdown file, outside its code. */
export function linksIn(markdown: string): string[] {
  const text = prose(markdown).replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!);
}
