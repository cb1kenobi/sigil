import { expandIncludes } from './includes.ts';
import { describe, outline, type Heading } from './markdown-doc.ts';
import { ABOUT_SLUG, GUIDE_SLUGS } from './nav.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/**
 * The About page's file, from the repository's root.
 *
 * In the top-level `docs/` and not with the guides: it is about the project
 * rather than about using the package, it sits beside `docs/history/`, which it
 * links to by relative path so the links hold on GitHub too, and
 * `packages/sigil/docs/` is the Docs section's reading order, every file of
 * which `test/guides.test.ts` holds to `GUIDE_SLUGS`. A build that reads it has
 * to say so in `turbo.json`'s `inputs`, as for the guides.
 */
export const ABOUT_REPO_PATH = 'docs/about.md';

/**
 * Where About is. Spelled out rather than joined from `ABOUT_REPO_PATH`, as
 * `GUIDES_DIR` is: a read whose path Turbopack cannot see the directory of
 * makes it trace the whole repository into the server bundle.
 */
const ABOUT_FILE = join(process.cwd(), '..', 'docs', 'about.md');

/** One guide. */
export interface Guide {
  /** What to say about the page in a search result. */
  readonly description: string;
  /** The sections, for the rail and the sidebar. `h2` only. */
  readonly sections: readonly Heading[];
  /** The file, absolute, for anything that asks git about it. */
  readonly file: string;
  /** The file, from the repository's root, for "Edit on GitHub". */
  readonly repoPath: string;
  /** The route segment, which is the file's name without its extension. */
  readonly slug: string;
  /**
   * The markdown, line endings normalized and includes expanded (`includes.ts`).
   * It still holds the title.
   */
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
  return readPage(slug, join(GUIDES_DIR, `${slug}.md`), guideRepoPath(slug));
}

/**
 * A page of markdown under `/docs/`, from its file: a guide, or About.
 *
 * @param slug - The route segment.
 * @param file - The file, absolute, and joined from a directory spelled out where the caller is.
 * @param repoPath - The same file from the repository's root.
 * @returns The page.
 */
function readPage(slug: string, file: string, repoPath: string): Guide {
  const source = expandIncludes(
    readFileSync(file, 'utf-8').replaceAll('\r\n', '\n'),
    dirname(file)
  );
  const { headings, lede, title } = outline(source);

  return {
    description: lede ? describe(lede) : GUIDE_SUMMARY,
    file,
    repoPath,
    sections: headings.filter((heading) => heading.depth === 2),
    slug,
    source,
    title: title ?? slug,
  };
}

/**
 * The About page, `/docs/about`: the sidebar's last section, and where the
 * footer's "TTY Labs" goes.
 *
 * Read by the function that reads a guide, so it is the same shape as one --
 * a title, a lede that is its description, sections for the rail -- and
 * anything that wants a docs page's markdown gets it the same way. It is not
 * in `guides()`, which is the Docs section's reading order.
 *
 * @returns The page.
 */
export function about(): Guide {
  return readPage(ABOUT_SLUG, ABOUT_FILE, ABOUT_REPO_PATH);
}

/**
 * Every page under `/docs/` that is a markdown file in the repository: the
 * guides in reading order, then About.
 *
 * @returns The pages.
 */
export function markdownPages(): Guide[] {
  return [...guides(), about()];
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
 * Where a guide's file is in the repository, for a link to it on GitHub.
 *
 * @param slug - The route segment.
 * @returns The path from the repository's root.
 */
export function guideRepoPath(slug: string): string {
  return `${GUIDES_REPO_DIR}/${slug}.md`;
}
