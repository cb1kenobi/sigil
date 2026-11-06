'use client';

import { openSearch } from '@/lib/open-search';
import { searchShortcutStore } from '@/lib/search-shortcut';
import { useSyncExternalStore } from 'react';

export interface SearchTriggerProps {
  /** Width and anything else about where it sits. The box itself is 40px tall. */
  className?: string;
  /** Called before the search opens: the phone menu closes itself with it. */
  onActivate?: () => void;
  /** What the button says. The 404 page asks for the longer "Search the docs". */
  label?: string;
}

/**
 * The search box in the header: a magnifier, its label ("Search") and the key that opens it.
 *
 * A button, not an input. Search is a dialog (SIG-254), so this takes no text
 * of its own and a field here would only be one more place to type that did
 * not do anything.
 *
 * The badge says `⌘K` or `Ctrl K` by platform. See `searchShortcutStore` for
 * why that cannot mismatch on hydration.
 */
export function SearchTrigger({
  className = 'w-60',
  onActivate,
  label = 'Search',
}: SearchTriggerProps) {
  const shortcut = useSyncExternalStore(
    searchShortcutStore.subscribe,
    searchShortcutStore.getSnapshot,
    searchShortcutStore.getServerSnapshot
  );

  return (
    <button
      type="button"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={() => {
        onActivate?.();
        openSearch();
      }}
      className={`flex h-10 min-w-0 shrink items-center gap-2 rounded-control border border-line-input bg-surface pr-2.5 pl-3 text-small text-muted transition-colors hover:border-line-strong hover:text-fg ${className}`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="shrink-0"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <span className="grow text-left">{label}</span>
      {/* Hidden from the accessible name, which is the label: the shortcut is
          what `aria-keyshortcuts` is for, and "Command K" read after the name
          is noise on a phone, where there is no key. */}
      <kbd
        aria-hidden="true"
        className="rounded-kbd border border-line-input px-1.5 py-px font-mono text-xs text-muted"
      >
        {shortcut}
      </kbd>
    </button>
  );
}
