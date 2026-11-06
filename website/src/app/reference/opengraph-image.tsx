import { OG_CONTENT_TYPE, OG_SIZE, sectionCard } from '@/lib/og';
import { REFERENCE_SUMMARY } from '@/lib/reference';

export const alt = 'sigil CLI reference: every command, with its arguments and options.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return sectionCard('CLI reference', REFERENCE_SUMMARY);
}
