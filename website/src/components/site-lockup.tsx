import { Seal } from '@/components/seal';
import Link from 'next/link';

/**
 * The seal and the wordmark, linking home. The header's is 22px and 17px, the
 * footer's 20px and 16px: the same mark a size down.
 *
 * The seal is decoration beside the word, so it is hidden from assistive
 * technology and the link's name is `sigil`.
 */
export function SiteLockup({ variant }: { variant: 'header' | 'footer' }) {
  const header = variant === 'header';

  return (
    <Link
      href="/"
      className={`relative flex items-center gap-2.5 text-fg ${
        // the header's row is 64px, so the target grows into it
        header ? 'after:absolute after:inset-x-0 after:-inset-y-[9px]' : ''
      }`}
    >
      <Seal size={header ? 22 : 20} className="text-brand" />
      <span className={`wordmark ${header ? 'text-[17px]' : 'text-base'}`}>sigil</span>
    </Link>
  );
}
