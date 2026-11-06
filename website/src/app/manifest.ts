import { BG } from '../lib/brand.ts';
import { SITE_NAME, TAGLINE } from '../lib/site.ts';
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: TAGLINE,
    lang: 'en',
    start_url: '/',
    display: 'standalone',
    // the page's own ground, so the splash screen and status bar do not flash
    // a different colour on the way in
    background_color: BG,
    theme_color: BG,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      // the same artwork again as maskable: the seal is half the icon's width,
      // inside the 80% safe zone a maskable icon has to keep its content in
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
