import { BG, BRAND, FG, FG_STRONG, MUTED } from './brand.ts';
import { TAGLINE } from './site.ts';
import { woff2ToSfnt } from './woff2.ts';
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The social cards: the site's default one, and one per section.
 *
 * Ported from titaniumsdk.com's `src/lib/og.tsx` (TI-48): one layout, one
 * palette, one file, with each route's `opengraph-image.tsx` reduced to its
 * alt text and a call. The alternative was a PNG per section committed beside
 * each route, which is a binary nobody can diff and that goes stale the moment
 * a section is renamed.
 *
 * ## The fonts are the site's, decoded
 *
 * `src/fonts` holds woff2, and satori reads ttf, otf and woff only. Rather
 * than commit a second copy of each face in a format nothing else here uses,
 * `woff2ToSfnt()` decodes the one copy we have, once, at module scope. Nothing
 * here reaches the network (SIG-255 vendored the fonts for that reason).
 *
 * ## The wordmark is outlined
 *
 * The lockup is `public/brand/sigil-lockup-dark.svg`, read off disk and drawn
 * as an image: the wordmark in it is paths, so the card does not depend on
 * Martian Mono being loaded, and the file in the README and the card cannot
 * disagree about what the logo is. `scripts/brand-assets.ts` writes it.
 */

/** The dimensions every card is drawn at, re-exported by each image route. */
export const OG_SIZE = { width: 1200, height: 630 };

export const OG_CONTENT_TYPE = 'image/png';

const root = process.cwd();

const font = async (file: string) => {
  const sfnt = woff2ToSfnt(await readFile(join(root, 'src/fonts', file)), { default: true });
  return sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength) as ArrayBuffer;
};

const [instrument, barlow, lockup] = await Promise.all([
  font('instrument-sans-latin.woff2'),
  font('barlow-semi-condensed-latin-600.woff2'),
  readFile(join(root, 'public/brand/sigil-lockup-dark.svg')),
]);

const FONTS = [
  { name: 'Instrument Sans', data: instrument, weight: 400 as const, style: 'normal' as const },
  { name: 'Barlow Semi Condensed', data: barlow, weight: 600 as const, style: 'normal' as const },
];

/** The lockup's own viewBox, which is what an `<img>` of it is sized against. */
const LOCKUP = (() => {
  const m = /viewBox="0 (-?\d+) (\d+) (\d+)"/.exec(lockup.toString('utf8'));
  if (!m) {
    throw new Error('sigil-lockup-dark.svg has no viewBox');
  }
  return { width: Number(m[2]), height: Number(m[3]), seal: 112 };
})();

const LOCKUP_SRC = `data:image/svg+xml;base64,${lockup.toString('base64')}`;

/**
 * The lockup drawn with its seal `seal` pixels tall. A plain `<img>`, not
 * `next/image`: satori draws this, not a browser.
 */
function Lockup({ seal }: { seal: number }) {
  const scale = seal / LOCKUP.seal;
  return (
    <img
      src={LOCKUP_SRC}
      width={Math.round(LOCKUP.width * scale)}
      height={Math.round(LOCKUP.height * scale)}
      alt=""
    />
  );
}

/**
 * The ground every card shares, as one SVG: `--color-bg`, the cell grid fading
 * out towards the right, and the purple glow behind the mark. The dots are 12
 * by 24 pixels, one terminal cell, at 0.12; the glow is the brand colour at
 * 0.30, 40% by 55% of the card, gone at 72% of the way out. It is the same
 * glow as `<Glow>` draws in CSS. The site itself has no dots since SIG-322;
 * the cards keep them.
 *
 * It is an SVG drawn as an image, and not those two CSS gradients, because
 * satori draws a tiled `radial-gradient` background for some card heights and
 * not for others: 150 and 200 px tall, yes; 168, 315 and 630, nothing at all,
 * measured. A `<pattern>` is resvg's own and has no such dependence on the
 * size of the box it is in.
 */
function groundSvg(glow: Glow) {
  const { width: w, height: h } = OG_SIZE;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    '<defs>',
    `<pattern id="dots" width="12" height="24" patternUnits="userSpaceOnUse"><circle cx="6" cy="12" r="1" fill="${FG}" fill-opacity="0.12"/></pattern>`,
    '<linearGradient id="fade"><stop offset="0.15" stop-color="#fff"/><stop offset="0.95" stop-color="#fff" stop-opacity="0"/></linearGradient>',
    `<mask id="mask"><rect width="${w}" height="${h}" fill="url(#fade)"/></mask>`,
    `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${w * glow[0]} ${h * glow[1]}) scale(${w * 0.4} ${h * 0.55})"><stop offset="0" stop-color="${BRAND}" stop-opacity="0.3"/><stop offset="0.72" stop-color="${BRAND}" stop-opacity="0"/></radialGradient>`,
    '</defs>',
    `<rect width="${w}" height="${h}" fill="url(#dots)" mask="url(#mask)"/>`,
    `<rect width="${w}" height="${h}" fill="url(#glow)"/>`,
    '</svg>',
  ].join('');
}

/** Where the glow is centered, as fractions of the card. It sits behind the mark. */
type Glow = [x: number, y: number];

const ground = (glow: Glow) =>
  `data:image/svg+xml;base64,${Buffer.from(groundSvg(glow)).toString('base64')}`;

function Ground({ glow, children }: { glow: Glow; children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        background: BG,
        fontFamily: 'Instrument Sans',
      }}
    >
      <img
        src={ground(glow)}
        width={OG_SIZE.width}
        height={OG_SIZE.height}
        alt=""
        style={{ position: 'absolute', top: 0, left: 0 }}
      />
      {children}
    </div>
  );
}

/** The site's own card: the lockup, left aligned, and the tagline beneath it. */
export function defaultCard(): ImageResponse {
  return new ImageResponse(
    <Ground glow={[0.26, 0.4]}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 88px',
          gap: 48,
        }}
      >
        <Lockup seal={120} />
        <div
          style={{ display: 'flex', maxWidth: 1000, fontSize: 32, lineHeight: 1.35, color: MUTED }}
        >
          {TAGLINE}
        </div>
      </div>
    </Ground>,
    { ...OG_SIZE, fonts: FONTS }
  );
}

/**
 * A card naming one section of the site.
 *
 * `title` is the section's own name, set in the heading face. `description` is
 * the section's one-liner, taken from the metadata description the section
 * already writes, so the card and the search result say the same thing rather
 * than two things somebody has to keep in step.
 */
export function sectionCard(title: string, description?: string): ImageResponse {
  return new ImageResponse(
    <Ground glow={[0.18, 0.16]}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 88px',
          width: '100%',
        }}
      >
        <Lockup seal={56} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Barlow Semi Condensed',
              fontWeight: 600,
              fontSize: 112,
              lineHeight: 1.05,
              color: FG_STRONG,
            }}
          >
            {title}
          </div>
          {description ? (
            <div
              style={{
                display: 'flex',
                maxWidth: 1000,
                fontSize: 36,
                lineHeight: 1.35,
                color: MUTED,
              }}
            >
              {description}
            </div>
          ) : null}
        </div>
      </div>
    </Ground>,
    { ...OG_SIZE, fonts: FONTS }
  );
}
