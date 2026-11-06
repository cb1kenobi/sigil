import { llmsTxt } from '@/lib/llms';
import { CORPUS_CACHE_CONTROL } from '@/lib/markdown-copy';

/**
 * The curated index, to the llmstxt.org convention (SIG-267).
 *
 * Ported from titaniumsdk.com's `app/llms.txt/route.ts` (TI-57). What it lists
 * and why is `lib/llms.ts`.
 *
 * ## On every host, and static
 *
 * titaniumsdk.com serves this on the production host only, reading `headers()`
 * for it, which makes the route request-time. Here it is served everywhere: it
 * indexes pages every host already serves as HTML, so a host guard hid nothing
 * and only made it untestable off production. `proxy.ts` says more. So this
 * file is written once at build time.
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
