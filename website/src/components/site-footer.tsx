import { GithubLink } from '@/components/github-link';
import { SiteLockup } from '@/components/site-lockup';
import { ABOUT_HREF } from '@/lib/nav';
import Link from 'next/link';

/**
 * Deliberately small: the sticky header carries the navigation, so this is the
 * lockup, who makes it, and the repository. No licence line and no link columns.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-footer">
      <div className="layout-page flex flex-wrap items-center gap-5 py-7">
        <SiteLockup variant="footer" />
        <p className="text-small text-muted">
          Developed by{' '}
          <Link
            href={ABOUT_HREF}
            className="text-fg underline decoration-[#5a5766] underline-offset-[3px]"
          >
            TTY Labs
          </Link>
        </p>
        <div className="grow" />
        <GithubLink location="footer" className="size-11 justify-center" />
      </div>
    </footer>
  );
}
