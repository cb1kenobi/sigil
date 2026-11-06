'use client';

import { GithubLink } from '@/components/github-link';
import { SearchTrigger } from '@/components/search-trigger';
import { NAV_ITEMS, type Section } from '@/lib/nav';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/** The width at which the header's own nav and search take over (`md`). */
const DESKTOP_QUERY = '(min-width: 768px)';

/**
 * The header's nav, search and GitHub link, for a phone.
 *
 * Native <dialog> rather than a hand-rolled drawer: showModal() traps focus,
 * handles Esc, and makes the rest of the page inert without extra code.
 *
 * One list of places to go, every row the same size: the destinations are the
 * header's four, and a menu that set some a size down would read as secondary
 * links to pages that are anything but.
 */
const ROW =
  'block rounded-control px-3 py-2.5 text-base font-medium hover:bg-surface-2 hover:text-white';

export function MobileNav({ active }: { active: Section | undefined }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  function close() {
    ref.current?.close();
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    const onClose = () => setOpen(false);
    dialog.addEventListener('close', onClose);

    // A modal left open across a resize to desktop would trap focus behind a
    // menu button that is no longer there.
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        dialog.close();
      }
    };
    desktop.addEventListener('change', onChange);

    return () => {
      dialog.removeEventListener('close', onClose);
      desktop.removeEventListener('change', onChange);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => {
          ref.current?.showModal();
          setOpen(true);
        }}
        className="ml-auto grid size-10 place-items-center rounded-control border border-line-input text-fg-body hover:text-white md:hidden"
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
      </button>

      <dialog
        ref={ref}
        aria-label="Main menu"
        // Clicking the backdrop resolves to the dialog element itself.
        onClick={(e) => {
          if (e.target === ref.current) {
            close();
          }
        }}
        className="m-0 ml-auto h-dvh max-h-dvh w-[min(20rem,85vw)] max-w-none border-l border-line bg-surface p-0 text-fg backdrop:bg-black/50 open:flex open:flex-col"
      >
        <div className="flex items-center justify-end border-b border-line px-5 py-3">
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="grid size-10 place-items-center rounded-control text-fg-body hover:text-white"
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
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const current = item.section === active;

              return (
                <li key={item.section}>
                  {/* Through Link, so a tap does not reload the application. */}
                  <Link
                    href={item.href}
                    onClick={close}
                    aria-current={current ? 'page' : undefined}
                    className={`${ROW} ${current ? 'text-link' : 'text-fg-body'}`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
          <SearchTrigger className="w-full" onActivate={close} />
          <GithubLink location="header" className="h-10 px-3">
            <span className="text-small">GitHub</span>
          </GithubLink>
        </div>
      </dialog>
    </>
  );
}
