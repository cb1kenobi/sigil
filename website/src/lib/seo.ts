import { hasMarkdownCopy, markdownHref } from './markdown-copy.ts';
import { REPO_URL, SITE_NAME, SITE_URL, TAGLINE, absoluteUrl, fullTitle } from './site.ts';
import type { Metadata, MetadataRoute } from 'next';

/**
 * The metadata rules the whole site shares.
 *
 * Ported from titaniumsdk.com's `src/lib/seo.ts`. Titles and descriptions are
 * not decided here: only a page knows what it says, so each route writes its
 * own from the content in front of it. What lives here is everything that has
 * to be identical everywhere and would otherwise drift.
 */

/**
 * The Open Graph fields that are true of every page.
 *
 * Spread, never inherited. Metadata merges shallowly, so a route that sets
 * `openGraph` at all replaces its parent's whole object: without this, adding
 * one field to one route would quietly drop `siteName` from that route's card.
 */
export const OPEN_GRAPH = {
  siteName: SITE_NAME,
  locale: 'en_US',
  type: 'website',
} as const;

/**
 * The metadata one page contributes: its canonical address and its cards.
 *
 * Every field that repeats the page's identity comes from the three arguments,
 * so the tab, the search result, the Open Graph card and the Twitter card cannot
 * say different things. The images are not here: they come from the nearest
 * `opengraph-image` file convention, and `/reference/*` inherits the section's.
 *
 * A docs page also names its Markdown copy, as `<link rel="alternate"
 * type="text/markdown">` (SIG-267), so an agent that fetched the HTML is told
 * where the text is. Here rather than on each route because every page under
 * `/docs` and `/reference` has one, and because `alternates` is replaced rather
 * than merged: a route that added its own would have to repeat the canonical.
 *
 * @param page - The page.
 * @param page.path - Where it is, starting with `/`. Resolved against `metadataBase`.
 * @param page.title - Its own title, which the layout's template adds the site's name to. Omit it
 *   for the home page, whose title is the layout's default.
 * @param page.description - What it is, for a search result.
 * @returns A route's `metadata`.
 */
export function pageMetadata({
  path,
  title,
  description,
}: {
  path: string;
  title?: string;
  description: string;
}): Metadata {
  const card = fullTitle(title);

  return {
    ...(title === undefined ? {} : { title }),
    description,
    alternates: {
      canonical: path,
      ...(hasMarkdownCopy(path) ? { types: { 'text/markdown': markdownHref(path) } } : {}),
    },
    openGraph: { ...OPEN_GRAPH, title: card, description, url: path },
    twitter: { card: 'summary_large_image', title: card, description },
  };
}

/**
 * What `robots.txt` says.
 *
 * One rule for everybody, closed or open: per-agent blocks are how a robots.txt
 * starts being wrong quietly, because the rule a crawler obeys is the most
 * specific block that names it, so an `Allow` added to the `*` block later would
 * never reach an agent that had a block of its own.
 *
 * Production allows everything -- there is nothing on the site that should stay
 * out of a search result yet -- and names the sitemap. A preview disallows
 * everything and names no sitemap, since there is none.
 *
 * @param indexable - Whether the request was for the production host.
 * @returns The rules.
 */
export function robotsRules(indexable: boolean): MetadataRoute.Robots {
  return indexable
    ? { rules: { userAgent: '*', allow: '/' }, sitemap: absoluteUrl('/sitemap.xml') }
    : { rules: { userAgent: '*', disallow: '/' } };
}

/**
 * The home page as `SoftwareSourceCode`.
 *
 * The thing the site is about is a piece of source code with a repository and a
 * licence, and those are the two facts a search engine cannot get from prose.
 * `SoftwareApplication` is not used: it wants `offers` and a rating before it
 * draws anything, and neither is a claim anybody made.
 */
export function softwareSourceCode(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: SITE_NAME,
    description: TAGLINE,
    url: SITE_URL,
    codeRepository: REPO_URL,
    programmingLanguage: 'TypeScript',
    runtimePlatform: 'Node.js',
    license: 'https://spdx.org/licenses/MIT.html',
  };
}

/**
 * Structured data as the text of a `<script type="application/ld+json">`.
 *
 * `JSON.stringify` does not escape `<`, so a value holding `</script>` would end
 * the element early and let whatever follows it run as markup. `<` is the
 * same string to a JSON parser and inert to an HTML one.
 *
 * @param data - The structured data.
 * @returns The script's contents.
 */
export function jsonLd(data: object): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c');
}
