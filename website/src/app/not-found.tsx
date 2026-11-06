import { FailureLayout } from '@/components/failure-actions';
import { NotFoundDetail } from '@/components/not-found-detail';
import { knownPaths } from '@/lib/known-paths';
import type { Metadata } from 'next';

/**
 * The 404 (SIG-268).
 *
 * Rendered inside the root layout, so the header, the footer and the skip link
 * stay: a reader who followed a dead link is one click from anywhere else, and
 * the built-in page offers none of that.
 *
 * ## What it offers
 *
 * A terminal block that says what sigil itself would say: the address that
 * missed, and the nearest page that exists. The suggestion is the CLI's "did you
 * mean" rule (see `lib/nearest-route.ts`) over the sitemap's paths, so a page
 * added to the sitemap is suggestible with nothing else edited. Below it, search
 * and the four places anything lives.
 *
 * ## Why the page is split
 *
 * This stays a server component so it can export `metadata`, and so it can read
 * the sitemap, which reads git and the file system. Which address missed is a
 * thing only the browser knows -- one 404 is prerendered for all of them -- so
 * `NotFoundDetail` is the client half, handed the candidate paths as a prop.
 *
 * Next adds `noindex` to a 404 itself, and answers it with status 404.
 */

export const metadata: Metadata = {
  title: 'Page not found',
  description: 'That address does not exist on this site.',
};

export default function NotFound() {
  return (
    <FailureLayout>
      <div className="lg:col-start-1 lg:row-start-1">
        <p className="eyebrow">404</p>
        <h1 className="mt-3">Page not found</h1>
        <p className="lede-docs mt-4 max-w-prose">
          The address you followed does not exist on this site. It may have moved, or the link may
          have a typo.
        </p>
      </div>
      <NotFoundDetail routes={knownPaths()} />
    </FailureLayout>
  );
}
