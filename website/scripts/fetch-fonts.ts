import { terminalText } from '../src/fonts/terminal-glyphs.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vendors the site's woff2 files and their licences into `src/fonts/`.
 *
 * `next/font/google` downloads these during the build, which means a build
 * cannot run without reaching fonts.googleapis.com. The build should touch
 * nothing but the local filesystem, so the files are fetched once, here, and
 * committed.
 *
 * Run this again only to change weights or pick up an upstream revision:
 *
 *   node scripts/fetch-fonts.ts [--check]
 *
 * All four families are SIL Open Font License 1.1. The licence for each sits
 * beside its fonts as `OFL-<family>.txt`, fetched from the same repository
 * Google Fonts serves them from, because the licence requires that the text
 * travel with the files.
 */

const OUT = join(import.meta.dirname, '../src/fonts');

/** Same UA Next sends, and for the same reason: it decides woff2 over ttf. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';

/** Only the latin subset, which is all the site's copy is written in. */
const SUBSET = 'latin';

const css = (family: string, wght: string) =>
  `https://fonts.googleapis.com/css2?family=${family}:wght@${wght}&display=swap`;

/**
 * JetBrains Mono is served as one static file per weight, so each weight is its
 * own entry. Barlow Semi Condensed is the headings, which are only ever 600.
 * Instrument Sans is a variable font, and one file covers 400 to 700. Martian
 * Mono is used for the wordmark alone, at one weight. A weight is here only if
 * a page draws it, since `layout.tsx` preloads every one.
 */
const FAMILIES = [
  {
    file: 'barlow-semi-condensed-latin-600.woff2',
    url: css('Barlow+Semi+Condensed', '600'),
  },
  { file: 'instrument-sans-latin.woff2', url: css('Instrument+Sans', '400..700') },
  ...[400, 500, 700].map((w) => ({
    file: `jetbrains-mono-latin-${w}.woff2`,
    url: css('JetBrains+Mono', String(w)),
  })),
  { file: 'martian-mono-latin-500.woff2', url: css('Martian+Mono', '500') },
  /**
   * The box drawing, block elements and shapes a terminal block draws, which no
   * named subset carries. `text=` makes Google Fonts build a file of exactly
   * those characters, as one `@font-face` with no subset comment. One weight: a
   * bold rule or block is drawn by the browser's synthesis, which is what a
   * terminal does too. See `src/fonts/terminal-glyphs.ts`.
   */
  {
    file: 'jetbrains-mono-terminal-400.woff2',
    url: `${css('JetBrains+Mono', '400')}&text=${encodeURIComponent(terminalText())}`,
    subset: null,
  },
];

const LICENCES = [
  { file: 'OFL-barlow-semi-condensed.txt', dir: 'barlowsemicondensed' },
  { file: 'OFL-instrument-sans.txt', dir: 'instrumentsans' },
  { file: 'OFL-jetbrains-mono.txt', dir: 'jetbrainsmono' },
  { file: 'OFL-martian-mono.txt', dir: 'martianmono' },
].map(({ file, dir }) => ({
  file,
  url: `https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`,
}));

/**
 * Pulls the woff2 URL for `SUBSET` out of a Google Fonts stylesheet.
 *
 * The response is a run of @font-face blocks, each preceded by a comment
 * naming its subset. Matching on that comment is what separates latin from
 * the cyrillic and greek slices we do not ship.
 */
function subsetUrl(stylesheet: string, subset: string | null): string {
  // a `text=` stylesheet is a single block with no comment at all
  if (subset === null) {
    const url = stylesheet.match(/src:\s*url\(([^)]+)\)/)?.[1];
    if (url) return url;
    throw new Error('no @font-face in stylesheet');
  }
  const blocks = stylesheet.split('/*').slice(1);
  for (const block of blocks) {
    const name = block.slice(0, block.indexOf('*/')).trim();
    if (name !== subset) continue;
    const url = block.match(/src:\s*url\(([^)]+)\)/)?.[1];
    if (url) return url;
  }
  throw new Error(`no ${subset} @font-face in stylesheet`);
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

const checkOnly = process.argv.includes('--check');
const stale: string[] = [];
mkdirSync(OUT, { recursive: true });

/** Writes `bytes` to `file` unless it already holds them, and reports which. */
function vendor(file: string, bytes: Buffer): void {
  const path = join(OUT, file);
  let current: Buffer | undefined;
  try {
    current = readFileSync(path);
  } catch {
    /* not vendored yet */
  }

  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  if (current?.equals(bytes)) {
    console.log(`  ok    ${file}  ${bytes.length} bytes  sha256:${digest}`);
    return;
  }

  stale.push(file);
  if (!checkOnly) writeFileSync(path, bytes);
  console.log(
    `  ${checkOnly ? 'stale' : 'wrote'} ${file}  ${bytes.length} bytes  sha256:${digest}`
  );
}

for (const family of FAMILIES) {
  const { file, url } = family;
  const stylesheet = await get(url, { headers: { 'User-Agent': UA } }).then((r) => r.text());
  const res = await get(
    subsetUrl(stylesheet, family.subset === undefined ? SUBSET : family.subset)
  );
  vendor(file, Buffer.from(await res.arrayBuffer()));
}

for (const { file, url } of LICENCES) {
  const res = await get(url);
  vendor(file, Buffer.from(await res.arrayBuffer()));
}

if (checkOnly && stale.length) {
  console.error(`\n${stale.length} font file(s) differ from upstream - rerun without --check.`);
  process.exit(1);
}
