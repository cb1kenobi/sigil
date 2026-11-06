'use client';

import { DocsPageLinks } from '@/components/docs-page-links';
import type { Heading } from '@/lib/markdown-doc';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * "On this page": one link per `h2`, the one in view marked, and the page's two
 * ways out -- Edit on GitHub and Report a problem.
 *
 * ## Which section is in view
 *
 * The last heading whose top has passed a line a little below the sticky
 * header, which is where a jump to an anchor leaves it (`scroll-margin-top` on
 * the headings is the same number). Above the first heading nothing is marked,
 * because nothing is in view yet; at the very bottom the last one is, because
 * a final section shorter than the screen can never get its top that high and
 * would otherwise never be reached.
 *
 * Read off the headings' own positions on `scroll` rather than with an
 * `IntersectionObserver`: an observer reports the headings that crossed a
 * boundary, and "the last one above the line" is a question about all of them
 * at once, which it has to be rebuilt from. Seventeen `getBoundingClientRect`
 * calls in an animation frame is not a cost.
 *
 * titaniumsdk.com's rail does not track the scroll, so there is nothing to port
 * here; its `RailScroll`, which remembers where a scrolling rail was left, is
 * what the sidebar's own layout makes unnecessary.
 *
 * ## No hydration mismatch
 *
 * The position is an external store, and the server's answer to it is "none",
 * which is also what the client renders during hydration. Only after that does
 * React read the real one, as an ordinary update, so the HTML the server sent
 * is never contradicted. State set in an effect would be the same result with
 * a render in the middle that is wrong.
 */

/** How far below the top of the viewport a heading is counted as reached. */
const LINE = 120;

/** What the server, and a first render, say: nothing is in view. */
const NONE = '';

/**
 * The id of the section in view.
 *
 * @param ids - The headings' ids, in order.
 * @returns The one in view, or none.
 */
function sectionInView(ids: readonly string[]): string {
  const root = document.documentElement;

  if (window.innerHeight + window.scrollY >= root.scrollHeight - 4) {
    return ids.at(-1) ?? NONE;
  }

  let current = NONE;

  for (const id of ids) {
    const heading = document.getElementById(id);

    if (heading && heading.getBoundingClientRect().top <= LINE) {
      current = id;
    }
  }

  return current;
}

export function DocsRail({
  editHref,
  headings,
  reportHref,
}: {
  /** The page's source file on GitHub. */
  editHref: string;
  headings: readonly Heading[];
  /** Where to open an issue. */
  reportHref: string;
}) {
  const subscribe = useCallback((notify: () => void) => {
    let frame = 0;
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        notify();
      });
    };

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
    };
  }, []);

  const active = useSyncExternalStore(
    subscribe,
    () => sectionInView(headings.map((heading) => heading.id)),
    () => NONE
  );

  return (
    <aside
      aria-label="On this page"
      className="sticky top-[65px] hidden max-h-[calc(100dvh-65px)] w-[200px] shrink-0 flex-col gap-2.5 self-start overflow-y-auto pt-14 pb-16 text-[13px] min-[1100px]:flex"
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

      <DocsPageLinks editHref={editHref} reportHref={reportHref} />
    </aside>
  );
}
