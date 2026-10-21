import { ReferencePage } from '@/components/reference-page';
import { referenceDoc } from '@/lib/reference';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/** The index page is the root command's, which is `index.md`. */
const SLUG = 'index';

export function generateMetadata(): Metadata {
  const doc = referenceDoc(SLUG);
  return { description: doc?.description, title: doc?.title ?? 'Command reference' };
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
