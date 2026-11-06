import { about } from '@/lib/guides';
import { OG_CONTENT_TYPE, OG_SIZE, sectionCard } from '@/lib/og';

export const alt = 'The story of sigil';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** The About page's card, from its own title and first sentences. */
export default function Image() {
  const it = about();

  return sectionCard(it.title, it.description);
}
