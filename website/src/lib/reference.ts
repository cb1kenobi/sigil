/**
 * The generated command reference, read off disk.
 *
 * `sigil reference --out src/reference` writes the pages and
 * `packages/cli/package.json`'s `reference` script is what runs it. They are
 * committed rather than generated during `next build`, which is the call
 * `src/i18n/keys.ts` and `src/style/utilities.ts` already make: a generated file
 * in the tree is one a reviewer can read in the diff, and a drift test is what
 * keeps it honest -- where a build-time generation would make the website's
 * build depend on importing the toolchain's own app.
 *
 * This is what "a docs site can consume it" has to mean to be worth anything:
 * the front matter is parsed, the nav is built from it, and the body is
 * rendered. If the shape were wrong -- no front matter, unstable headings, a
 * title only a human could find -- none of that would be possible.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where the generated pages are. */
const DIR = join(process.cwd(), 'src', 'reference');

/** One generated page. */
export interface ReferenceDoc {
  /** The markdown under the front matter. */
  readonly body: string;
  /** What the command is for, when it says. */
  readonly description?: string;
  /** The argv path, which is what the nav is ordered by. */
  readonly path: readonly string[];
  /** The route segment, which is the file name without its extension. */
  readonly slug: string;
  /** The full invocation, as the page's own heading spells it. */
  readonly title: string;
}

/**
 * The front matter's keys, read as JSON.
 *
 * The generator writes a YAML front matter whose **values are JSON**, which is
 * the one shape that is both: JSON is a subset of YAML, so a site that wants a
 * YAML parser gets one, and a site that would rather not take a dependency to
 * read three keys can use `JSON.parse`. What that buys is the thing a
 * hand-rolled `key: value` reader gets wrong -- a description holding a colon, a
 * quote or a `#` is escaped by construction rather than by a rule somebody has
 * to remember.
 *
 * A key whose value will not parse is skipped rather than thrown over: a page
 * with a malformed front matter still has a body worth rendering, and the nav
 * falls back to the slug.
 *
 * @param text - What is between the fences.
 * @returns The keys.
 */
function parseMatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const line of text.split('\n')) {
    const at = line.indexOf(':');

    if (at < 1) {
      continue;
    }

    try {
      out[line.slice(0, at).trim()] = JSON.parse(line.slice(at + 1).trim());
    } catch {
      // a value this cannot read leaves the key unset, which the reader below
      // already has a fallback for
    }
  }

  return out;
}

/**
 * One page, split into its front matter and its body.
 *
 * The line endings are normalized first. `.gitattributes` says `text=auto` and
 * lists no `*.md`, so git checks these out with CRLF on Windows -- and a fence
 * matched with `\n` on either side would then match nothing, which is the
 * failure that cost four tests on three Windows jobs and nowhere else.
 *
 * @param slug - The route segment.
 * @param raw - The file.
 * @returns The page.
 */
function read(slug: string, raw: string): ReferenceDoc {
  const text = raw.replaceAll('\r\n', '\n');
  const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const matter = end === -1 ? {} : parseMatter(text.slice(4, end));

  return {
    body: end === -1 ? text : text.slice(end + 5).trimStart(),
    description: typeof matter.description === 'string' ? matter.description : undefined,
    path: Array.isArray(matter.path) ? (matter.path as string[]) : [],
    slug,
    title: typeof matter.title === 'string' ? matter.title : slug,
  };
}

/**
 * Two argv paths, a segment at a time and by UTF-16 code unit.
 *
 * Not `localeCompare`, which reads the locale of whatever machine is rendering:
 * these routes are **statically prerendered**, so a nav ordered by a setting is
 * one whose built HTML differs between a German CI runner and an English one. It
 * is the same reason the snapshot sorts this way, and segment-wise for the same
 * reason again -- a command named `a b` joins to what `['a', 'b']` joins to.
 *
 * @param a - One path.
 * @param b - The other.
 * @returns The ordering.
 */
function byPath(a: readonly string[], b: readonly string[]): number {
  for (let at = 0; at < Math.min(a.length, b.length); at++) {
    const x = a[at] as string;
    const y = b[at] as string;

    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  return a.length - b.length;
}

/**
 * Every generated page, ordered by the path it documents.
 *
 * By `path` rather than by file name, so that the nav reads as the command tree
 * does -- which is what the front matter carrying the path as an array is for.
 *
 * A destination that is not there at all is **no pages** rather than a throw,
 * which is what makes the index route's own `notFound()` reachable: it says a
 * reference nobody generated is a 404 rather than a crash, and with a bare
 * `readdirSync` an emptied tree was exactly the crash that comment denies.
 * `ENOENT` alone, which is the rule the toolchain's own reader keeps -- reading
 * every error as absence is how a directory that exists and cannot be read comes
 * back as a site with no reference in it.
 *
 * @returns The pages.
 */
export function referenceDocs(): ReferenceDoc[] {
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
    .filter((name) => name.endsWith('.md'))
    .map((name) => read(name.slice(0, -3), readFileSync(join(DIR, name), 'utf-8')))
    .sort((a, b) => byPath(a.path, b.path));
}

/**
 * One page by its slug.
 *
 * @param slug - The route segment.
 * @returns The page, or nothing where there is no such command.
 */
export function referenceDoc(slug: string): ReferenceDoc | undefined {
  return referenceDocs().find((doc) => doc.slug === slug);
}
