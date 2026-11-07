import { Glow } from '@/components/glow';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The buttons and links under an error or a 404, styled once so the two pages
 * cannot drift. `PRIMARY` is the one thing to press; `SECONDARY` is a link-sized
 * alternative.
 */
export const PRIMARY_BUTTON =
  'inline-flex h-10 items-center justify-center rounded-control bg-brand px-4 text-small font-medium text-brand-fg transition-colors hover:brightness-110';

export const SECONDARY_BUTTON =
  'inline-flex h-10 items-center justify-center rounded-control border border-line-input px-4 text-small font-medium text-fg transition-colors hover:border-line-strong';

/** One place to go: a label and a line saying what is there. */
export function PlaceCard({
  external = false,
  hint,
  href,
  label,
}: {
  external?: boolean;
  hint: ReactNode;
  href: string;
  label: string;
}) {
  const className =
    'block rounded-panel border border-line-panel bg-surface p-4 transition-colors hover:border-line-strong';
  const body = (
    <>
      <span className="block font-medium text-link">
        {label}
        {external ? <span aria-hidden="true"> ↗</span> : null}
        {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
      </span>
      <span className="mt-1 block text-small text-muted">{hint}</span>
    </>
  );

  return external ? (
    <a className={className} href={href} rel="noopener noreferrer" target="_blank">
      {body}
    </a>
  ) : (
    <Link className={className} href={href}>
      {body}
    </Link>
  );
}

/**
 * What the 404 and the error page share: the glow of a docs page
 * behind a two-column grid, text on the left and the terminal on the right,
 * stacked on a phone.
 *
 * `grid-cols-1` is `minmax(0, 1fr)`, which is what lets a terminal row wider
 * than the screen scroll inside its block instead of widening the column and
 * pushing the page past the viewport. The page puts each child in its column.
 */
export function FailureLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex-1 overflow-hidden">
      <Glow variant="top" />
      <div className="layout-page relative grid grid-cols-1 content-start gap-x-12 gap-y-8 py-16 sm:py-24 lg:grid-cols-2">
        {children}
      </div>
    </div>
  );
}
