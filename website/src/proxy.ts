import { isIndexableHost } from '@/lib/site';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * No sitemap off the production host.
 *
 * `robots.txt` closes a preview to crawlers, but a sitemap is a list of
 * addresses on the production origin that a preview has no business offering,
 * and answering for it here keeps `app/sitemap.ts` static. See there.
 */
export function proxy(request: NextRequest) {
  if (!isIndexableHost(request.headers.get('host'))) {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/sitemap.xml'],
};
