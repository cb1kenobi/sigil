import { OG_CONTENT_TYPE, OG_SIZE, altText, defaultCard } from '@/lib/og';

export const alt = altText('src/app/opengraph-image.alt.txt');
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return defaultCard();
}
