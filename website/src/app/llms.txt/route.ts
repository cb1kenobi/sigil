import { llmsTxt } from '@/lib/llms';
import { CORPUS_CACHE_CONTROL } from '@/lib/markdown-copy';

/**
 * The curated index, to the llmstxt.org convention (SIG-267).
 *
 * Ported from titaniumsdk.com's `app/llms.txt/route.ts` (TI-57). What it lists
 * and why is `lib/llms.ts`.
 *
 * ## Production only, and still static
 *
 * A preview must not publish a corpus: `robots.txt` asks a crawler not to index
 * it, and nothing at all asks a model fetching a URL directly. titaniumsdk.com
 * reads `headers()` here for that, which makes the route request-time; here the
 * host guard is `proxy.ts`'s, the one that already answers 404 for the sitemap
 * off the production host, so this file is written once at build time and the
 * proxy decides who gets it.
 */

export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsTxt(), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': CORPUS_CACHE_CONTROL,
    },
  });
}
