import { COMPONENTS, COMPONENTS_HREF, componentHref } from './components.ts';
import { markdownPages } from './guides.ts';
import { lastModified } from './last-modified.ts';
import { guideHref } from './nav.ts';
import { referenceDocs, referenceFile, referenceHref } from './reference.ts';
import { absoluteUrl } from './site.ts';
import type { MetadataRoute } from 'next';

/**
 * Every page the site wants crawled.
 *
 * Ported from titaniumsdk.com's `lib/sitemap.ts`. A sitemap is wrong in ways
 * that never throw -- a duplicate, a relative URL, a page that is not there --
 * so the rules are here, where `test/sitemap.test.ts` can hold them, rather than
 * in the `sitemap.ts` route, which is only the file convention.
 *
 * ## Sections
 *
 * Each part of the site is a function returning its own entries, and
 * `SECTIONS` lists them. A new part of the site is one more function that reads
 * the same source as its `generateStaticParams` (so the sitemap cannot name a URL
 * that is a 404) and one more line in the list. Nothing else changes.
 *
 * ## Dates
 *
 * `lastModified` is the commit date of the page's own file, which is the only
 * date that cannot drift from the content. A page with no file of its own has no
 * date, which is honest: claiming today would be a lie a crawler learns to
 * ignore. See `lastModified()` for where git has no answer.
 */

type Entry = MetadataRoute.Sitemap[number];

/** The home page. It has no content file of its own, so no date. */
function home(): Entry[] {
  return [{ url: absoluteUrl('/') }];
}

/**
 * The command reference: the index and one page per command.
 *
 * `referenceDocs()` is the set the route builds its pages from, and
 * `referenceHref()` the function the nav links through, so an entry here is a
 * page that exists at the address the site links to.
 */
function reference(): Entry[] {
  return referenceDocs().map((doc) => {
    const modified = lastModified(referenceFile(doc.slug));

    return {
      url: absoluteUrl(referenceHref(doc.slug)),
      ...(modified ? { lastModified: modified } : {}),
    };
  });
}

/**
 * The guides and About: one page each, dated by its own markdown file.
 *
 * A guide's file is `packages/sigil/docs/<slug>.md` and About's is
 * `docs/about.md`, both outside `website/`, so the date is of the page itself
 * and moves when the page does -- which is also why `turbo.json` lists them as
 * inputs. `guides()` is what `generateStaticParams` builds the guides' routes
 * from, and About is a route of its own.
 */
function docs(): Entry[] {
  return markdownPages().map((page) => {
    const modified = lastModified(page.file);

    return {
      url: absoluteUrl(guideHref(page.slug)),
      ...(modified ? { lastModified: modified } : {}),
    };
  });
}

/**
 * The components index and one page per component.
 *
 * The index is dated by `src/lib/components.ts`, which decides what it lists,
 * and a component's page by its capture, which is written whenever what the page
 * shows of it -- its output, options or keys -- changes. `COMPONENTS` is the list
 * the route's `generateStaticParams` reads, so no entry here is a 404.
 */
function components(): Entry[] {
  const dated = (url: string, file: string): Entry => {
    const modified = lastModified(file);
    return { url: absoluteUrl(url), ...(modified ? { lastModified: modified } : {}) };
  };

  return [
    dated(COMPONENTS_HREF, 'src/lib/components.ts'),
    ...COMPONENTS.map((entry) =>
      dated(componentHref(entry.slug), `src/transcripts/components/${entry.slug}.json`)
    ),
  ];
}

/** Every section, in the order its entries are listed. */
const SECTIONS: readonly (() => Entry[])[] = [home, docs, components, reference];

/** @returns The entries, absolute and without duplicates. */
export function sitemapEntries(): Entry[] {
  const seen = new Set<string>();

  return SECTIONS.flatMap((section) => section()).filter(({ url }) => {
    if (seen.has(url)) {
      return false;
    }
    seen.add(url);
    return true;
  });
}
