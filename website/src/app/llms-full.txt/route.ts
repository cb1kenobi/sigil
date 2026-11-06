import { llmsFullTxt } from '@/lib/llms';
import { CORPUS_CACHE_CONTROL } from '@/lib/markdown-copy';

/**
 * Every docs page's Markdown in one file, in the order the site lists them
 * (SIG-267).
 *
 * Ported from titaniumsdk.com's `app/llms-full.txt/route.ts` (TI-57), without
 * its size cap: `lib/llms.ts` says why. On every host and static for the
 * reason `llms.txt` is; see that route.
 */

export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsFullTxt(), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': CORPUS_CACHE_CONTROL,
    },
  });
}
