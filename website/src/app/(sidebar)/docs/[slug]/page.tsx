import { DocsPage } from '@/components/docs-page';
import { guideLinks } from '@/lib/docs-sidebar';
import { guideLink } from '@/lib/guide-links';
import { guide, guideRepoPath, guides } from '@/lib/guides';
import { guideHref, pagerAround } from '@/lib/nav';
import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/**
 * Every guide in `packages/sigil/docs/`, one page each.
 *
 * `dynamicParams` is off so that an address that is not a guide is a 404 and
 * not a page rendered on demand from whatever the segment was. It also keeps
 * `/docs/components` and `/docs/about`, which other pages own, from being
 * answered by this route if they are ever removed.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return guides().map((it) => ({ slug: it.slug }));
}

export async function generateMetadata({ params }: PageProps<'/docs/[slug]'>): Promise<Metadata> {
  const it = guide((await params).slug);

  return it
    ? pageMetadata({ path: guideHref(it.slug), title: it.title, description: it.description })
    : {};
}

export default async function Guide({ params }: PageProps<'/docs/[slug]'>) {
  const it = guide((await params).slug);

  if (!it) {
    notFound();
  }

  const href = guideHref(it.slug);

  return (
    <DocsPage
      crumbs={[{ label: 'Docs', href: guideHref('getting-started') }, { label: it.title }]}
      headings={it.sections.filter((section) => section.id !== '')}
      link={guideLink}
      pager={pagerAround(guideLinks(), href)}
      repoPath={guideRepoPath(it.slug)}
      source={it.source}
      title={it.title}
    />
  );
}
