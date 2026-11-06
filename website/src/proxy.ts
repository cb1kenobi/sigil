import { proxyAnswer } from '@/lib/markdown-copy';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * The sitemap's host guard, and the docs' Markdown copies.
 *
 * - No sitemap off the production host. `robots.txt` closes a preview to
 *   crawlers, but a sitemap is a list of addresses on the production origin
 *   that a preview has no business offering; answering for it here keeps its
 *   route static. See `app/sitemap.ts`. The corpus (`llms.txt`,
 *   `llms-full.txt`, the `.md` copies) is served on every host: see
 *   `proxyAnswer()` for why.
 * - `/md/...`, where `next.config.ts` sends a `.md` address, is refused when it
 *   is asked for by name.
 * - A docs page asked for with an `Accept` that prefers `text/markdown` is its
 *   Markdown copy (SIG-267).
 *
 * The rules are `proxyAnswer()` in `lib/markdown-copy`, where a test can hold
 * them; this only turns the answer into a response.
 */
export function proxy(request: NextRequest) {
  const answer = proxyAnswer({
    pathname: request.nextUrl.pathname,
    host: request.headers.get('host'),
    accept: request.headers.get('accept'),
  });

  if ('notFound' in answer) {
    return new NextResponse(answer.notFound, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if ('rewrite' in answer) {
    return NextResponse.rewrite(new URL(answer.rewrite, request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Literal, because Next reads the matcher at build time. Every path
  // `proxyAnswer()` has a rule for, and nothing else: a page outside them never
  // pays for the proxy.
  matcher: ['/sitemap.xml', '/md/:path*', '/docs/:path*', '/reference/:path*'],
};
