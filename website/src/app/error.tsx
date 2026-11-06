'use client';

import { FailureLayout, PRIMARY_BUTTON, SECONDARY_BUTTON } from '@/components/failure-actions';
import { TerminalBlock } from '@/components/terminal-block';
import { captureException } from '@/lib/analytics';
import { errorRows } from '@/lib/failure-rows';
import { errorReportUrl } from '@/lib/report';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * The error boundary (SIG-268): what a reader sees when a page throws.
 *
 * Rendered inside the root layout, so the header and the footer survive and only
 * the page is replaced. A failure of the layout itself is `global-error.tsx`.
 *
 * ## What the reader is told
 *
 * The digest and nothing else. In production Next deliberately withholds the
 * message from the browser so as not to leak what threw; the digest is the one
 * thing that ties this screen to a line in the server log, so it is the thing
 * to show and to put in the report. A development build also prints the
 * message, since there is nothing to protect and a developer wants it.
 *
 * ## `retry`, not `reset`
 *
 * `retry()` re-fetches and re-renders the segment, which is what "try again"
 * means after a transient server failure. `reset()` only clears the error state
 * and renders the same children again with the same data, so it would redraw the
 * same failure. Next 16.3 made `retry` the stable one and says to prefer it.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const path = usePathname();

  useEffect(() => {
    // React stops the error at this boundary, so `window.onerror` never sees it
    // and PostHog's automatic capture does not either
    captureException(error, { digest: error.digest, path });
  }, [error, path]);

  return (
    <FailureLayout>
      <div className="lg:col-start-1 lg:row-start-1">
        <p className="eyebrow">Error</p>
        <h1 className="mt-3">Something went wrong</h1>
        <p className="lede-docs mt-4 max-w-prose">
          This page failed to render. It is not something you did, and trying again often works.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button className={PRIMARY_BUTTON} onClick={() => retry()} type="button">
            Try again
          </button>
          <a
            className={SECONDARY_BUTTON}
            href={errorReportUrl(path, error.digest)}
            rel="noopener noreferrer"
            target="_blank"
          >
            Report it
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
      <div className="lg:col-start-2 lg:row-start-1 lg:self-center">
        <TerminalBlock
          cwd="~"
          rows={errorRows(
            path,
            error.digest,
            process.env.NODE_ENV === 'production' ? undefined : error.message
          )}
          size="hero"
        />
      </div>
    </FailureLayout>
  );
}
