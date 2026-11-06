import { ComponentPage } from '@/components/component-page';
import { describeComponent } from '@/lib/component-data';
import { COMPONENTS, componentEntry, componentHref } from '@/lib/components';
import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/**
 * One page per component, from the list in `src/lib/components.ts`.
 *
 * In the `(sidebar)` group, so it has the docs sidebar -- scoped to the
 * component's family, which the sidebar works out from the path -- and the
 * rail. `dynamicParams` is off so that a name that is not a component is a 404,
 * which the 404 page then suggests the nearest one for.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return COMPONENTS.map((entry) => ({ name: entry.slug }));
}

export async function generateMetadata({
  params,
}: PageProps<'/docs/components/[name]'>): Promise<Metadata> {
  const entry = componentEntry((await params).name);

  return entry
    ? pageMetadata({
        path: componentHref(entry.slug),
        title: entry.name,
        description: describeComponent(entry),
      })
    : {};
}

export default async function Component({ params }: PageProps<'/docs/components/[name]'>) {
  const entry = componentEntry((await params).name);

  if (!entry) {
    notFound();
  }

  return <ComponentPage slug={entry.slug} />;
}
