'use client';

import { PlaceCard } from '@/components/failure-actions';
import { SearchTrigger } from '@/components/search-trigger';
import { TerminalBlock } from '@/components/terminal-block';
import { capture } from '@/lib/analytics';
import { notFoundRows } from '@/lib/failure-rows';
import { NAV_ITEMS, type Section } from '@/lib/nav';
import { nearestRoute } from '@/lib/nearest-route';
import { brokenLinkUrl } from '@/lib/report';
import { useHydrated } from '@/lib/use-hydrated';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/** Where a section of the nav leads, so the 404 cannot link somewhere the header does not. */
function sectionHref(section: Section): string {
  return NAV_ITEMS.find((item) => item.section === section)!.href;
}

/**
 * The part of the 404 that depends on the address that missed: the terminal, its
 * suggestion, the broken-link report and the analytics event.
 *
 * A client component because `not-found.tsx` is handed no params and no URL;
 * `usePathname()` is the only way to read what was asked for. The page stays a
 * server component so it can export `metadata`.
 *
 * ## What the server renders
 *
 * One 404 is prerendered for every address, so the server cannot know which one
 * missed. It renders the terminal with a placeholder (`<address>`) and no
 * suggestion; the real address, the suggestion and the report link arrive in the
 * render straight after hydration. `useHydrated()` is what keeps the first client
 * render identical to the server's HTML -- reading the path during it would not
 * be. Without JavaScript the page is the placeholder, the search button does
 * nothing and the four links work.
 *
 * ## Why the routes are a prop
 *
 * They come from the sitemap, which reads git and the file system and so cannot
 * be imported into code that ships to the browser. The server computes the
 * strings; this does the comparing, because it is the only side that knows what
 * to compare them with.
 *
 * The children of a grid, not a box of their own: the page places them.
 */
export function NotFoundDetail({ routes }: { routes: readonly string[] }) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const path = hydrated ? pathname : null;
  const suggestion = path === null ? undefined : nearestRoute(path, routes);
  const referrer = hydrated ? document.referrer || null : null;

  useEffect(() => {
    if (path !== null) {
      capture('page_not_found', { path, suggestion: suggestion ?? null, referrer });
    }
  }, [path, suggestion, referrer]);

  return (
    <>
      <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
        <TerminalBlock cwd="~" rows={notFoundRows(path, suggestion)} size="hero" />
      </div>

      <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-2">
        <SearchTrigger className="w-full max-w-sm" label="Search the docs" />
        <ul className="grid gap-3 sm:grid-cols-2">
          <li>
            <PlaceCard
              hint="Guides, from getting started on"
              href={sectionHref('docs')}
              label="Docs"
            />
          </li>
          <li>
            <PlaceCard
              hint="Every component, with its output"
              href={sectionHref('components')}
              label="Components"
            />
          </li>
          <li>
            <PlaceCard
              hint="Every command the toolchain has"
              href={sectionHref('cli')}
              label="CLI reference"
            />
          </li>
          <li>
            <PlaceCard
              external
              hint="Tell us where the link was"
              href={brokenLinkUrl(path, referrer)}
              label="Report a broken link"
            />
          </li>
        </ul>
      </div>
    </>
  );
}
