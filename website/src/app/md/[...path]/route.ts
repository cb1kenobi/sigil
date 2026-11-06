import { docsPages } from '@/lib/docs-pages';
import { markdownFor } from '@/lib/llms';
import { CORPUS_CACHE_CONTROL } from '@/lib/markdown-copy';

/**
 * Every docs page as Markdown, at its own address plus `.md` (SIG-267).
 *
 *   /docs/getting-started.md        a guide
 *   /docs/components.md             the components index
 *   /docs/components/select.md      one component
 *   /reference.md                   the root command
 *   /reference/add.md               one command
 *
 * Ported from titaniumsdk.com's `app/md/[...path]/route.ts` (TI-57).
 *
 * ## Why the addresses are not the directory names here
 *
 * A `route.ts` cannot sit at the same segment as a `page.tsx`, and
 * `/docs/[slug]` is a page. There is no arrangement of files that puts
 * `/docs/parser.md` beside `/docs/parser`, so `next.config.ts` rewrites the
 * `.md` suffix onto this handler. `beforeFiles`, because the docs routes
 * declare `dynamicParams = false` and would otherwise answer 404 before a later
 * rewrite was consulted. The page's own address reaches it too, from `proxy.ts`,
 * when the request's `Accept` header prefers `text/markdown`.
 *
 * ## Why it insists on being reached through the rewrite
 *
 * A rewrite destination is a real URL, so `/md/docs/parser` would answer as
 * well and the same file would have two addresses. titaniumsdk.com refuses it
 * here, by reading the address as asked for off `request.url`; this one is
 * prerendered, where there is no request to read, so `proxy.ts` refuses it
 * instead -- the proxy runs before any rewrite, so what it sees is what was
 * asked for. One address per document, which is what the canonical in each
 * page's head assumes.
 *
 * ## Prerendered, and production only
 *
 * Every page is built from committed files, so every `.md` is written at build
 * time, which titaniumsdk.com's are not: its host guard read `headers()` here
 * and made the route request-time. Here the guard is `proxy.ts`'s, which
 * already answers 404 for the sitemap off the production host, so a preview
 * never publishes a corpus and this can stay static -- the same call
 * `app/sitemap.ts` makes. It also means the guides, which live outside
 * `website/`, are read during the build and never at request time.
 */

export const dynamic = 'force-static';

/** A path that is not a docs page is a 404 at the router, not a render. */
export const dynamicParams = false;

export function generateStaticParams() {
  return docsPages().map((page) => ({ path: page.href.split('/').slice(1) }));
}

export async function GET(_request: Request, ctx: RouteContext<'/md/[...path]'>) {
  const { path } = await ctx.params;
  const body = markdownFor(`/${path.join('/')}`);

  if (body === undefined) {
    return new Response('Not found.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': CORPUS_CACHE_CONTROL,
      // the page's own address answers with this or with HTML, by `Accept`
      vary: 'Accept',
    },
  });
}
