import { OG_CONTENT_TYPE, OG_SIZE, altText, sectionCard } from '@/lib/og';

export const alt = altText('src/app/reference/opengraph-image.alt.txt');
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return sectionCard('CLI reference', 'Every sigil command, with its arguments and options.');
}
