import { OG_CONTENT_TYPE, OG_SIZE, sectionCard } from '@/lib/og';

export const alt = 'sigil CLI reference: every command, with its arguments and options.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return sectionCard('CLI reference', 'Every sigil command, with its arguments and options.');
}
