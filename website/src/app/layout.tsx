import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/*
 * Served from `src/fonts` rather than `next/font/google`. The Google loader
 * downloads the woff2 files during the build, so a build could not run without
 * reaching fonts.googleapis.com. `scripts/fetch-fonts.ts` vendors them, with
 * their licences; `--check` re-verifies them against upstream.
 *
 * Each `variable` is the name `globals.css` reads in its `@theme inline` block
 * to make `--font-heading`, `--font-sans`, `--font-mono` and `--font-wordmark`.
 * The names differ from those on purpose: a theme variable that read a variable
 * of its own name would be a cycle.
 */

/** Headings h1 to h3. */
const barlow = localFont({
  src: [
    { path: '../fonts/barlow-semi-condensed-latin-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-semi-condensed-latin-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-semi-condensed-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-barlow',
  display: 'swap',
});

/** Body and UI. One variable file covers 400 to 700. */
const instrument = localFont({
  src: '../fonts/instrument-sans-latin.woff2',
  variable: '--font-instrument',
  display: 'swap',
  weight: '400 700',
});

/** Code, terminals and labels. Not variable, so each weight is a file. */
const jetbrains = localFont({
  src: [
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-jetbrains',
  display: 'swap',
});

/**
 * The box drawing, block elements and shapes a terminal block draws, which the
 * latin subset above does not carry -- see `src/fonts/terminal-glyphs.ts`.
 *
 * Its own family rather than a fourth file of `jetbrains`, because that is the
 * only way to give it a `unicode-range`, and the range is what stops it drawing
 * an ordinary space or letter: the file holds both. It goes first in
 * `--font-mono` so that a box-drawing character never reaches `jetbrains`'s own
 * fallback, which is Arial scaled to 131% and is what broke the banner rows. No
 * fallback of its own for the same reason: what is not in the range is not this
 * family's to draw.
 *
 * Preloaded like the others, which costs every page 4 KB. Left to the range
 * alone it would be fetched only once a page drew one of these, which is after
 * the first paint -- so a banner would be drawn in Arial and then redrawn, the
 * exact misalignment this file exists to prevent, on the page it matters most.
 *
 * The range is written out because a font option has to be a literal;
 * `test/fonts.test.ts` holds it to `unicodeRange()`.
 */
const jetbrainsTerminal = localFont({
  src: '../fonts/jetbrains-mono-terminal-400.woff2',
  variable: '--font-jetbrains-terminal',
  display: 'swap',
  weight: '400',
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value: 'U+2190-21FF, U+2500-257F, U+2580-259F, U+25A0-25FF, U+26A0, U+276F',
    },
  ],
});

/** The wordmark only. */
const martian = localFont({
  src: '../fonts/martian-mono-latin-500.woff2',
  variable: '--font-martian',
  display: 'swap',
  weight: '500',
});

export const metadata: Metadata = {
  title: 'sigil',
  description: 'A framework for building CLI apps in Node.js.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${instrument.variable} ${jetbrains.variable} ${jetbrainsTerminal.variable} ${martian.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* First in the tab order. Hidden until focused, then drawn over the header. */}
        <a
          href="#main"
          className="sr-only rounded-control bg-surface-2 px-4 py-2 text-small font-medium text-fg focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex flex-1 flex-col">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
