import { ReferencePage } from '@/components/reference-page';
import { REFERENCE_SUMMARY, referenceDoc, referenceDocs, referenceHref } from '@/lib/reference';
import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/** An address that is not a command is a 404, not a page rendered from the segment. */
export const dynamicParams = false;

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
  const { slug } = await params;
  const doc = referenceDoc(slug);

  return pageMetadata({
    path: referenceHref(slug),
    title: doc?.title ?? 'Command reference',
    description: doc?.description ?? REFERENCE_SUMMARY,
  });
}

export default async function Command({ params }: PageProps<'/reference/[slug]'>) {
  const doc = referenceDoc((await params).slug);

  if (!doc) {
    notFound();
  }

  return <ReferencePage doc={doc} />;
}
