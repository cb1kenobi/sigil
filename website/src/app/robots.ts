import { robotsRules } from '@/lib/seo';
import { isIndexableHost } from '@/lib/site';
import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';

/**
 * Reading `headers()` makes this a request-time route instead of a value baked
 * in at build, which is what lets one deployment serve different rules per host.
 * The rules themselves are in `lib/seo`.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsRules(isIndexableHost((await headers()).get('host')));
}
