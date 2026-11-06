import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which section of a page is in view, for the docs rail's "On this page" and the
 * components index's family filter.
 *
 * ## Which section is in view
 *
 * The last one whose top has passed a line a little below the sticky header,
 * which is where a jump to an anchor leaves it (`scroll-margin-top` on the
 * headings is the same number). Above the first nothing is, because nothing is
 * in view yet; at the very bottom the last one is, because a final section
 * shorter than the screen can never get its top that high and would otherwise
 * never be reached.
 *
 * Read off the elements' own positions on `scroll` rather than with an
 * `IntersectionObserver`: an observer reports the elements that crossed a
 * boundary, and "the last one above the line" is a question about all of them
 * at once, which it has to be rebuilt from. Seventeen `getBoundingClientRect`
 * calls in an animation frame is not a cost.
 *
 * ## No hydration mismatch
 *
 * The position is an external store, and the server's answer to it is "none",
 * which is also what the client renders during hydration. Only after that does
 * React read the real one, as an ordinary update, so the HTML the server sent is
 * never contradicted. State set in an effect would be the same result with a
 * render in the middle that is wrong.
 */

/** How far below the top of the viewport a section is counted as reached. */
const LINE = 120;

/** What the server, and a first render, say: nothing is in view. */
export const NONE = '';

/**
 * The id of the section in view.
 *
 * @param ids - The sections' ids, in order.
 * @returns The one in view, or none.
 */
function sectionInView(ids: readonly string[]): string {
  const root = document.documentElement;

  if (window.innerHeight + window.scrollY >= root.scrollHeight - 4) {
    return ids.at(-1) ?? NONE;
  }

  let current = NONE;

  for (const id of ids) {
    const element = document.getElementById(id);

    if (element && element.getBoundingClientRect().top <= LINE) {
      current = id;
    }
  }

  return current;
}

/** Calls `notify` at most once a frame while the page scrolls, resizes or jumps. */
function subscribe(notify: () => void): () => void {
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
}

/**
 * The id of the section in view, or {@link NONE}.
 *
 * @param ids - The sections' ids, in the order they are on the page.
 * @returns The one in view.
 */
export function useSectionInView(ids: readonly string[]): string {
  const key = ids.join('\n');
  const snapshot = useCallback(() => sectionInView(key.split('\n')), [key]);

  return useSyncExternalStore(subscribe, snapshot, () => NONE);
}
