import { describe, outline, type Heading } from './markdown-doc.ts';
import { GUIDE_SLUGS } from './nav.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The guides, read off disk from `packages/sigil/docs/`.
 *
 * They are **not copied into `website/`**. `packages/cli/test/guides.test.ts`
 * replays every command a guide shows, and `markdown-links.test.ts` follows
 * every link in it, and both read these files: a second copy here would be one
 * that neither of them looks at. A build that reads a file outside `src/` has to
 * say so in `turbo.json`'s `inputs`, or a cache hit restores a site made from a
 * guide that has since changed.
 */

/** The repository's path to the guides, as GitHub spells it. */
export const GUIDES_REPO_DIR = 'packages/sigil/docs';

/** Where the guides are. The website's working directory is `website/`. */
export const GUIDES_DIR = join(process.cwd(), '..', GUIDES_REPO_DIR);

/** One guide. */
export interface Guide {
  /** What to say about the page in a search result. */
  readonly description: string;
  /** The sections, for the rail and the sidebar. `h2` only. */
  readonly sections: readonly Heading[];
  /** The route segment, which is the file's name without its extension. */
  readonly slug: string;
  /** The markdown, line endings normalized. It still holds the title. */
  readonly source: string;
  /** The first heading. */
  readonly title: string;
}

/**
 * One guide's description when the guide has no paragraph to give it.
 *
 * Both of today's do, so this is for the next one: a page with no lede is still
 * a page worth a search result.
 */
export const GUIDE_SUMMARY = 'A guide to building command-line apps with sigil.';

/**
 * A guide, from its file.
 *
 * @param slug - The route segment.
 * @returns The guide.
 */
export function readGuide(slug: string): Guide {
  const source = readFileSync(join(GUIDES_DIR, `${slug}.md`), 'utf-8').replaceAll('\r\n', '\n');
  const { headings, lede, title } = outline(source);

  return {
    description: lede ? describe(lede) : GUIDE_SUMMARY,
    sections: headings.filter((heading) => heading.depth === 2),
    slug,
    source,
    title: title ?? slug,
  };
}

/**
 * Every guide, in reading order.
 *
 * @returns The guides.
 */
export function guides(): Guide[] {
  return GUIDE_SLUGS.map(readGuide);
}

/**
 * One guide by its route segment.
 *
 * @param slug - The route segment.
 * @returns The guide, or nothing where there is none.
 */
export function guide(slug: string): Guide | undefined {
  return (GUIDE_SLUGS as readonly string[]).includes(slug) ? readGuide(slug) : undefined;
}

/**
 * Where a guide's file is, for anything that asks git about it.
 *
 * @param slug - The route segment.
 * @returns The absolute path.
 */
export function guideFile(slug: string): string {
  return join(GUIDES_DIR, `${slug}.md`);
}

/**
 * Where a guide's file is in the repository, for a link to it on GitHub.
 *
 * @param slug - The route segment.
 * @returns The path from the repository's root.
 */
export function guideRepoPath(slug: string): string {
  return `${GUIDES_REPO_DIR}/${slug}.md`;
}
