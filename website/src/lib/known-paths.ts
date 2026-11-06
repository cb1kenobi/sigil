import { SITE_URL } from './site.ts';
import { sitemapEntries } from './sitemap.ts';

/**
 * Every page the site has, as the paths the 404 page suggests from.
 *
 * **The sitemap's own list, not a second one.** `sitemapEntries()` is built from
 * the same sources as each section's `generateStaticParams`, so a page that
 * exists is a page this can suggest, and the docs and the component pages arrive
 * here the day they join the sitemap with nothing edited. A list kept beside it
 * would be one more place to forget a route.
 *
 * Server only: the sitemap reads git and the file system. The 404 computes this
 * where it is rendered and hands the strings to the client, which is the only
 * side that knows what was asked for.
 *
 * @returns The paths, each starting with `/`, in the sitemap's order.
 */
export function knownPaths(): string[] {
  return sitemapEntries().map(({ url }) => new URL(url, SITE_URL).pathname);
}
