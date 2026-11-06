import { COMPONENTS_HREF } from './components.ts';
import { guideFile, guides } from './guides.ts';
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
 * The guides: one page each, dated by its own markdown file.
 *
 * The file is `packages/sigil/docs/<slug>.md`, outside `website/`, so the date
 * is of the guide itself and moves when the guide does -- which is also why
 * `turbo.json` lists it as an input. `guides()` is what `generateStaticParams`
 * builds the routes from.
 */
function docs(): Entry[] {
  return guides().map((guide) => {
    const modified = lastModified(guideFile(guide.slug));

    return {
      url: absoluteUrl(guideHref(guide.slug)),
      ...(modified ? { lastModified: modified } : {}),
    };
  });
}

/**
 * The components index, dated by the list it is drawn from.
 *
 * `src/lib/components.ts` is what decides what the page lists, so its commit is
 * when the page last changed in substance.
 */
function components(): Entry[] {
  const modified = lastModified('src/lib/components.ts');

  return [{ url: absoluteUrl(COMPONENTS_HREF), ...(modified ? { lastModified: modified } : {}) }];
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
