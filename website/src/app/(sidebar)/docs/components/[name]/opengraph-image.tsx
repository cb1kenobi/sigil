import { describeComponent } from '@/lib/component-data';
import { componentEntry } from '@/lib/components';
import { OG_CONTENT_TYPE, OG_SIZE, sectionCard } from '@/lib/og';
export { generateStaticParams } from './page';

export const alt = 'A sigil component';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** A card per component, with its name and what it is for. */
export default async function Image({ params }: { params: Promise<{ name: string }> }) {
  const entry = componentEntry((await params).name);

  return sectionCard(entry?.name ?? 'Components', entry ? describeComponent(entry) : undefined);
}
