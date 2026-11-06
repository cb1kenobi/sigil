import { guide } from '@/lib/guides';
import { OG_CONTENT_TYPE, OG_SIZE, sectionCard } from '@/lib/og';
export { generateStaticParams } from './page';

export const alt = 'sigil documentation';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** A card per guide, drawn from its own title and first sentences. */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const it = guide((await params).slug);

  return sectionCard(it?.title ?? 'Docs', it?.description);
}
