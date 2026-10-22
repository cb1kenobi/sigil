import { ReferencePage } from '@/components/reference-page';
import { referenceDoc, referenceDocs } from '@/lib/reference';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/**
 * Every command that has a page, which is what makes this statically rendered.
 *
 * `index` is left out: the root command is rendered at `/reference` itself, so
 * offering it here as well would be one page at two routes.
 */
export function generateStaticParams() {
  return referenceDocs()
    .filter((doc) => doc.slug !== 'index')
    .map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({
  params,
}: PageProps<'/reference/[slug]'>): Promise<Metadata> {
  const doc = referenceDoc((await params).slug);
  return { description: doc?.description, title: doc?.title ?? 'Command reference' };
}

export default async function Command({ params }: PageProps<'/reference/[slug]'>) {
  const doc = referenceDoc((await params).slug);

  if (!doc) {
    notFound();
  }

  return <ReferencePage doc={doc} />;
}
