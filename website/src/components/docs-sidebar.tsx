'use client';

import { componentSidebar, isCurrentLink, type SidebarSection } from '@/lib/nav';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * The docs sidebar, from `sidebarSections()` in `lib/nav.ts`.
 *
 * ## One copy of the nav
 *
 * From 768px it is a column, `232px` wide, that sticks under the header and
 * scrolls on its own. Below that it is a "Menu" disclosure at the top of the
 * content, closed. The two are **one element**: the list is rendered once, and
 * what differs is whether it is `hidden` below `md`. Two lists -- a drawer for
 * a phone and a column for a desktop -- would be two sets of ids and twice the
 * markup on every page, and nothing here needs a second copy.
 *
 * ## No hydration mismatch
 *
 * The one thing the server cannot know is whether the reader has opened the
 * menu, and it is closed on the server and closed on the client's first render:
 * what is open is derived from state that starts as "not opened", and nothing reads the width in
 * JavaScript. The width is CSS (`md:block`). The current page is the pathname,
 * which both sides have.
 *
 * It lives in a layout, so it is not remounted by a navigation: the column
 * keeps its scroll position from one guide to the next, which a sidebar a page
 * renders cannot (titaniumsdk.com's `RailScroll` exists to put that back).
 *
 * ## A component's page
 *
 * Shows "← All components" and the component's family instead of everything,
 * which `componentSidebar()` works out from the path. Both lists come from the
 * layout and the choice is made here, because the layout is not told which page
 * it is under and the path is what both sides of hydration have.
 */

const LINK = 'block rounded-segment px-3 py-[7px] transition-colors';

/** Whether `child` is inside `box`'s visible area. */
function visibleIn(box: HTMLElement, child: HTMLElement): boolean {
  const frame = box.getBoundingClientRect();
  const row = child.getBoundingClientRect();
  return row.top >= frame.top && row.bottom <= frame.bottom;
}

export function DocsSidebar({
  families,
  sections: everything,
}: {
  /** Each component family's pages, for the sidebar a component's page has instead. */
  families: SidebarSection[];
  sections: SidebarSection[];
}) {
  const pathname = usePathname();
  const sections = componentSidebar(families, pathname) ?? everything;
  // The path the menu was opened on, and open only while the reader is still on
  // it: following a link leaves the layout mounted, so a plain flag would keep
  // the list they just used over the page they asked for. Derived rather than
  // reset in an effect, so there is no render in which it is open on the wrong page
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const column = useRef<HTMLDivElement>(null);

  // A current page that is below the fold of the column is brought into it, so
  // that a reader who arrives on `sigil package` is not looking at a sidebar
  // with nothing marked. The column's own scroll only: `scrollIntoView` would
  // scroll the page as well.
  useEffect(() => {
    const box = column.current;
    const current = box?.querySelector<HTMLElement>('[aria-current="page"]');

    if (box && current && box.scrollHeight > box.clientHeight && !visibleIn(box, current)) {
      box.scrollTop +=
        current.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        box.clientHeight / 2;
    }
  }, [pathname]);

  return (
    <div
      ref={column}
      className="w-full shrink-0 md:sticky md:top-[65px] md:max-h-[calc(100dvh-65px)] md:w-[232px] pt-6 md:overflow-y-auto md:pt-10 md:pb-16"
    >
      <button
        type="button"
        aria-controls="docs-nav"
        aria-expanded={open}
        onClick={() => setOpenOn(open ? null : pathname)}
        className="flex w-full items-center gap-2 rounded-control border border-line-input bg-surface px-3 py-2.5 text-small font-medium text-fg-body hover:text-white md:hidden"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          className="size-5"
          aria-hidden="true"
        >
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
        Menu
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`ml-auto size-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>

      <nav
        id="docs-nav"
        aria-label="Documentation"
        // closing on any link: a hash link on the page already open does not
        // change the pathname, so the effect above would not see it
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) {
            setOpenOn(null);
          }
        }}
        className={`${open ? 'mt-3 flex' : 'hidden'} flex-col gap-7 text-small md:mt-0 md:flex`}
      >
        {sections.map((section) => (
          <div key={section.id} className="flex flex-col gap-0.5">
            {section.label ? <p className="sidebar-label px-3 pb-1.5">{section.label}</p> : null}
            <ul className="flex flex-col gap-0.5">
              {section.links.map((link) => {
                const current = isCurrentLink(link, pathname);

                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={current ? 'page' : undefined}
                      className={`${LINK} ${link.mono ? 'font-mono text-[13px]' : ''} ${
                        current
                          ? 'bg-surface-2 font-semibold text-fg-strong'
                          : 'text-muted hover:text-white'
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
