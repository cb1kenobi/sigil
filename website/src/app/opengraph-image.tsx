import { OG_CONTENT_TYPE, OG_SIZE, defaultCard } from '@/lib/og';

export const alt = 'sigil: command-line apps in TypeScript, with nothing else to install.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return defaultCard();
}
