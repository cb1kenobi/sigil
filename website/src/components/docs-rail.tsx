'use client';

import { DocsPageLinks } from '@/components/docs-page-links';
import type { Heading } from '@/lib/markdown-doc';
import { useSectionInView } from '@/lib/use-section-in-view';

/**
 * "On this page": one link per `h2`, the one in view marked, and the page's two
 * ways out -- Edit on GitHub and Report a problem.
 *
 * Which one is in view is `useSectionInView()`, which the components index's
 * family filter reads too; its comment says how, and why it cannot cause a
 * hydration mismatch.
 *
 * titaniumsdk.com's rail does not track the scroll, so there is nothing to port
 * here; its `RailScroll`, which remembers where a scrolling rail was left, is
 * what the sidebar's own layout makes unnecessary.
 */
export function DocsRail({
  editHref,
  headings,
  reportHref,
  source = false,
}: {
  /** The page's source file on GitHub. */
  editHref: string;
  headings: readonly Heading[];
  /** Where to open an issue. */
  reportHref: string;
  /** Whether `editHref` is the source of a component rather than of the page. */
  source?: boolean;
}) {
  const active = useSectionInView(headings.map((heading) => heading.id));

  return (
    // A `nav`, not an `aside`: it is the page's own table of contents, and the
    // third of the navigation landmarks a docs page has (Main, Documentation,
    // On this page).
    <nav
      aria-label="On this page"
      className="sticky top-[65px] -mx-1 hidden max-h-[calc(100dvh-65px)] w-[208px] shrink-0 flex-col gap-2.5 scroll-py-2 self-start overflow-y-auto px-1 pt-14 pb-16 text-[13px] min-[1100px]:flex"
    >
      <p className="sidebar-label pb-1">On this page</p>

      {headings.map((heading) => {
        const current = heading.id === active;

        return (
          <a
            key={heading.id}
            href={`#${heading.id}`}
            aria-current={current ? 'location' : undefined}
            className={current ? 'font-semibold text-link' : 'text-muted hover:text-white'}
          >
            {heading.text}
          </a>
        );
      })}

      <div className="my-3 h-px bg-line" />

      <DocsPageLinks editHref={editHref} reportHref={reportHref} source={source} />
    </nav>
  );
}
