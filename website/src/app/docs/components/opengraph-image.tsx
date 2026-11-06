import { COMPONENTS_LEDE } from '@/lib/component-data';
import { OG_CONTENT_TYPE, OG_SIZE, sectionCard } from '@/lib/og';

export const alt = 'sigil components: prompts, output and full-screen elements.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return sectionCard('Components', COMPONENTS_LEDE);
}
