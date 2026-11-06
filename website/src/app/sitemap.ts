import { sitemapEntries } from '@/lib/sitemap';
import type { MetadataRoute } from 'next';

/**
 * `sitemap.xml`.
 *
 * The rules and the reasoning are in `lib/sitemap`, which is where they can be
 * tested. This stays a static file, built where git history is available, and
 * `proxy.ts` is what answers 404 for it on a host that is not the production
 * one: a request-time check here would move the git lookups to a runtime that
 * has no repository to ask.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
