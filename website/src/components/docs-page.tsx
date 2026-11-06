import { DocsMarkdown } from '@/components/docs-markdown';
import { DocsPageLinks } from '@/components/docs-page-links';
import { DocsRail } from '@/components/docs-rail';
import type { Heading } from '@/lib/markdown-doc';
import type { PagerLink } from '@/lib/nav';
import { REPO_NEW_ISSUE_URL, repoFileUrl } from '@/lib/site';
import Link from 'next/link';
import type { ComponentProps } from 'react';

/** One step of the path to a page. The last has no `href` and is the page. */
export interface Crumb {
  label: string;
  href?: string;
}

/**
 * A card at the foot of a page: the page before or after it, in its section.
 *
 * `surface` on a `line-panel` border, 12px radius, the direction in 13px `muted`
 * above the title in 16px at weight 600. The arrow is decoration: the word
 * above it already says which way it goes.
 */
function PagerCard({
  className = '',
  direction,
  link,
}: {
  className?: string;
  direction: 'Previous' | 'Next';
  link: PagerLink;
}) {
  const next = direction === 'Next';

  return (
    <Link
      href={link.href}
      rel={next ? 'next' : 'prev'}
      className={`flex flex-col gap-1 rounded-panel border border-line-panel bg-surface px-[18px] py-4 transition-colors hover:border-line-strong ${
        next ? 'items-end text-right' : ''
      } ${className}`}
    >
      <span className="text-[13px] text-muted">{direction}</span>
      <span className="text-base font-semibold text-fg">
        {next ? null : (
          <span aria-hidden="true" className="mr-1.5">
            ←
          </span>
        )}
        {link.title}
        {next ? (
          <span aria-hidden="true" className="ml-1.5">
            →
          </span>
        ) : null}
      </span>
    </Link>
  );
}

/**
 * The content of a docs page and the rail beside it: the breadcrumb, the title,
 * the markdown, the Previous and Next cards, and "On this page".
 *
 * The sidebar is not here. It is the layout's, so that it is one element that
 * survives from page to page; what a page renders is the two columns that
 * change, as adjacent siblings, which the layout's flex row lays out beside it.
 *
 * @param props.title - The page's `h1`. Not read from the markdown: a reference
 *   page's title is its front matter's, and a guide's is the same text.
 * @param props.mono - Set the title in the mono face, for a command.
 * @param props.source - The markdown. Its own `h1` is not drawn twice.
 * @param props.link - Where a relative link in the markdown goes on this site.
 * @param props.plugins - What `DocsMarkdown` adds for this kind of page.
 * @param props.repoPath - The page's source file, from the repository's root.
 */
export function DocsPage({
  crumbs,
  headings,
  link,
  mono = false,
  pager,
  plugins,
  repoPath,
  source,
  title,
}: {
  crumbs: readonly Crumb[];
  headings: readonly Heading[];
  link: (href: string | undefined) => string | undefined;
  mono?: boolean;
  pager: { previous?: PagerLink; next?: PagerLink };
  plugins?: ComponentProps<typeof DocsMarkdown>['plugins'];
  repoPath: string;
  source: string;
  title: string;
}) {
  const editHref = repoFileUrl(repoPath);

  return (
    <>
      <div className="min-w-0 max-w-[760px] flex-1 pt-8 pb-24 md:pt-12">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-muted">
            {crumbs.map((crumb, index) => (
              <li key={crumb.label} className="flex items-center gap-x-1.5">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                {crumb.href ? (
                  <Link href={crumb.href} className="hover:text-white">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <h1
          className={`mt-5 text-fg-strong ${mono ? 'font-mono text-[30px] sm:text-[40px]' : 'text-[38px] sm:text-page'}`}
        >
          {title}
        </h1>

        <DocsMarkdown link={link} plugins={plugins} source={source} />

        {pager.previous || pager.next ? (
          <nav
            aria-label="Previous and next pages"
            className="mt-10 grid gap-4 border-t border-line pt-7 sm:grid-cols-2"
          >
            {pager.previous ? <PagerCard direction="Previous" link={pager.previous} /> : null}
            {pager.next ? (
              <PagerCard
                className={pager.previous ? '' : 'sm:col-start-2'}
                direction="Next"
                link={pager.next}
              />
            ) : null}
          </nav>
        ) : null}

        {/* the rail's own two links, for the widths with no rail */}
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-[13px] min-[1100px]:hidden">
          <DocsPageLinks editHref={editHref} reportHref={REPO_NEW_ISSUE_URL} />
        </div>
      </div>

      <DocsRail editHref={editHref} headings={headings} reportHref={REPO_NEW_ISSUE_URL} />
    </>
  );
}
