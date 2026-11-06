'use client';

import { GithubLink } from '@/components/github-link';
import { MobileNav } from '@/components/mobile-nav';
import { SearchTrigger } from '@/components/search-trigger';
import { SiteLockup } from '@/components/site-lockup';
import { NAV_ITEMS, activeSection, isDocsPath } from '@/lib/nav';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The header every page shares: sticky, a translucent `bg` over a blur, 64px.
 *
 * A client component for the one thing it has to know, the pathname: which
 * section is current, and whether the page is a docs page, whose layout is
 * 1440px wide and which the header lines up with. A phone gets the lockup and a
 * menu button; the nav, search and GitHub link move into the menu below `md`.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const active = activeSection(pathname);
  const width = isDocsPath(pathname) ? 'layout-docs' : 'layout-page';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/86 backdrop-blur-md">
      <div className={`${width} flex items-center gap-7 py-3`}>
        <SiteLockup variant="header" />

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-6">
            {NAV_ITEMS.map((item) => {
              const current = item.section === active;

              return (
                <li key={item.section}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    className={`text-[15px] font-medium transition-colors ${
                      current ? 'text-link' : 'text-fg-body hover:text-white'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="hidden grow md:block" />
        <div className="hidden items-center gap-3 md:flex">
          <SearchTrigger />
          <GithubLink location="header" />
        </div>

        <MobileNav active={active} />
      </div>
    </header>
  );
}
