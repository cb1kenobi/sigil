import { ReferencePage } from '@/components/reference-page';
import { REFERENCE_SUMMARY, referenceDoc, referenceHref } from '@/lib/reference';
import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/** The index page is the root command's, which is `index.md`. */
const SLUG = 'index';

/**
 * Titled for the section rather than for the root command, whose own title is
 * `sigil`: a tab reading "sigil · sigil" says nothing.
 */
export function generateMetadata(): Metadata {
  return pageMetadata({
    path: referenceHref(SLUG),
    title: 'CLI reference',
    description: referenceDoc(SLUG)?.description ?? REFERENCE_SUMMARY,
  });
}

export default function Reference() {
  const doc = referenceDoc(SLUG);

  // a reference nobody generated is a 404 rather than a crash: the pages are
  // committed, so this only fires in a tree somebody emptied
  if (!doc) {
    notFound();
  }

  return <ReferencePage doc={doc} />;
}
