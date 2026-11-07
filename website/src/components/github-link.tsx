'use client';

import { captureBeforeLeaving } from '@/lib/analytics';
import { REPO_URL } from '@/lib/site';
import type { ReactNode } from 'react';

/** The GitHub mark, as titaniumsdk.com draws it in its own header. */
export function GithubMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export interface GithubLinkProps {
  /** Where the link is, sent with the `github_link_clicked` event. */
  location: 'header' | 'footer' | 'about';
  /** Sizing, for the places that are not the 40px square: the footer's 44px, a menu row. */
  className?: string;
  /** A visible label, for the phone menu's row. The icon-only link has none. */
  children?: ReactNode;
  /**
   * What a screen reader calls the link. A visible label that does not say
   * "GitHub" has to be in it, so a reader who says what they see can follow it:
   * the About page's button passes its own text.
   */
  name?: string;
}

/**
 * The link to the repository: a square holding the mark, with no border, 40px in the
 * header and 44px in the footer.
 *
 * It opens a new tab, so the page is not going anywhere, but the event is sent
 * as a beacon anyway: a middle click and a modified click leave in other ways,
 * and `captureBeforeLeaving` is the transport `analytics.ts` names for this
 * event.
 */
export function GithubLink({
  location,
  className = 'size-10 justify-center',
  children,
  name = 'sigil on GitHub',
}: GithubLinkProps) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={name}
      title="GitHub"
      onClick={() => captureBeforeLeaving('github_link_clicked', { location })}
      className={`flex shrink-0 items-center gap-3 rounded-control text-fg-body transition-colors hover:text-white ${className}`}
    >
      <GithubMark />
      {children}
    </a>
  );
}
