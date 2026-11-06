'use client';

import { NONE, useSectionInView } from '@/lib/use-section-in-view';

export interface FamilySegment {
  readonly count: number;
  readonly href: string;
  readonly id: string;
  readonly title: string;
}

/**
 * The components index's family filter: one segmented control whose segments
 * are links to the families' sections.
 *
 * One bordered box rather than a row of pills, with the separators drawn by a
 * one-pixel gap over the border colour, so that when it wraps on a phone every
 * row is still separated and no segment starts a line with a stray rule.
 *
 * The family in view is the active segment, marked `aria-current="location"`,
 * which is what it is: the place on this page the reader has reached. Above the
 * first section that is the first family, since that is what is next.
 */
export function FamilyFilter({ segments }: { segments: readonly FamilySegment[] }) {
  const inView = useSectionInView(segments.map((segment) => segment.id));
  const active = inView === NONE ? segments[0]?.id : inView;

  return (
    <nav aria-label="Families" className="mt-1 self-start">
      <ul className="flex max-w-full flex-wrap gap-px overflow-hidden rounded-segment border border-line-tag bg-line-tag">
        {segments.map((segment) => {
          const current = segment.id === active;

          return (
            <li key={segment.id} className="flex grow">
              <a
                href={segment.href}
                aria-current={current ? 'location' : undefined}
                className={`flex h-11 grow items-center justify-center gap-2.5 px-[18px] text-small font-semibold focus-visible:-outline-offset-2 focus-visible:shadow-[inset_0_0_0_4px_var(--color-bg)] ${
                  current ? 'bg-brand text-brand-fg' : 'bg-chip text-fg hover:text-white'
                }`}
              >
                {segment.title}
                <span className={`font-mono text-xs ${current ? '' : 'text-muted'}`}>
                  {segment.count}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
