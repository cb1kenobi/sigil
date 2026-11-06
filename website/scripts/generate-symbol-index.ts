import type { SymbolPayload } from '../src/components/search/symbols.ts';
import { searchRecords } from '../src/lib/search-records.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';

/**
 * The payload behind the name matcher (SIG-254), ported from titaniumsdk.com.
 *
 * Pagefind has no typo tolerance and ranks pages, so `--singel` finds nothing
 * and `--out` has no clear top result. Names are matched separately, in the
 * browser, against every name the site has -- the records `searchRecords()`
 * marks as a `symbol`, which today are the commands and their options.
 *
 * ## Shape
 *
 *   { s: [[name, url, summary?], ...] }
 *
 * The URL is stored rather than derived, where titaniumsdk.com derived it to
 * save bytes over five thousand names: here there are a few dozen, and a URL
 * built in a second place is one that can come to disagree with the page's.
 *
 * The build fails if the brotli-compressed file goes over 40 KB, which is
 * titaniumsdk.com's budget: every visitor who opens search downloads it.
 *
 *   node scripts/generate-symbol-index.ts
 */

const OUT = join(import.meta.dirname, '../public/symbols.json');
/** Past this the payload stops being something to ship to every visitor. */
const BUDGET_BROTLI = 40 * 1024;

const payload: SymbolPayload = {
  s: searchRecords()
    .filter((record) => record.symbol)
    .map((record) =>
      record.summary ? [record.title, record.url, record.summary] : [record.title, record.url]
    ),
};
const body = JSON.stringify(payload);
const compressed = brotliCompressSync(Buffer.from(body)).length;

mkdirSync(join(import.meta.dirname, '../public'), { recursive: true });
writeFileSync(OUT, body);

console.log(
  `symbols: ${payload.s.length} names, ${(body.length / 1024).toFixed(1)} KB raw, ` +
    `${(compressed / 1024).toFixed(1)} KB brotli -> public/symbols.json`
);

if (compressed > BUDGET_BROTLI) {
  console.error(
    `\nover budget: ${(compressed / 1024).toFixed(1)} KB brotli against ${BUDGET_BROTLI / 1024} KB.\n` +
      'Every visitor who opens search downloads this. Narrow what goes in, or\n' +
      'record in SIG-254 why the budget moved.'
  );
  process.exit(1);
}
