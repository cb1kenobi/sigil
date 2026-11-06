import { assertAnalyticsConfigured } from './src/lib/analytics-env.ts';
import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/**
 * `<path>.md` beside `<path>`, for the machine-readable corpus (SIG-267).
 *
 * Ported from titaniumsdk.com (TI-57). A `route.ts` may not share a segment
 * with a `page.tsx`, and `/docs/[slug]` is a page, so nothing can be filed at
 * `/docs/parser.md`. These map the suffix onto `app/md/[...path]`, and
 * `src/proxy.ts` refuses anything that arrived at the destination directly, so
 * each document keeps one address.
 *
 * `beforeFiles` rather than `afterFiles`: the docs routes declare
 * `dynamicParams = false`, and an `afterFiles` rewrite is consulted after
 * static files but before dynamic routes, which is fine in principle. The
 * earlier hook is used because it does not depend on that ordering staying
 * true.
 *
 * Two rules rather than one pattern with an optional tail: `/reference.md` has
 * no separator to make optional, and a regex that tried to cover both would be
 * the kind of thing nobody can safely edit later.
 */
const markdownSuffix = [
  { source: '/:root(docs|reference).md', destination: '/md/:root' },
  { source: '/:root(docs|reference)/:path*.md', destination: '/md/:root/:path*' },
];

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,

  /**
   * `/docs` is not a page, it is the docs: the first guide is where it goes.
   * Temporary rather than permanent, because what is first is a decision that
   * moves (the components and About pages are on their way) and a browser
   * keeps a 308 for good.
   */
  async redirects() {
    return [{ source: '/docs', destination: '/docs/getting-started', permanent: false }];
  },

  async rewrites() {
    return { beforeFiles: markdownSuffix, afterFiles: [], fallback: [] };
  },
};

/**
 * The function form is what lets the analytics check run for a build and for
 * nothing else: `next dev` and `next start` evaluate this file too, and a
 * contributor with no PostHog project must be able to run both. See
 * `src/lib/analytics-env.ts` for why the check is here and what a production
 * deploy is.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    assertAnalyticsConfigured();
  }

  return nextConfig;
}
