import { searchRecords } from '../src/lib/search-records.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as pagefind from 'pagefind';

/**
 * Builds the Pagefind index behind site search (SIG-254), ported from
 * titaniumsdk.com.
 *
 * ## One record per command, option and section, not per page
 *
 * Pagefind normally crawls rendered HTML and ranks pages. This calls its Node
 * API instead and adds one custom record per thing a reader looks for, which
 * took titaniumsdk.com's query set from 3/7 to 6/7 and makes each fragment a
 * line rather than a page. The records are `searchRecords()`, which reads the
 * same markdown the pages render from.
 *
 * ## Why this runs before `next build`
 *
 * `public/` is collected during the build, so an index written afterwards is
 * never served. The records come from the markdown rather than the rendered
 * HTML, which is what lets this run first -- and the pages render from the same
 * source, so the index cannot describe something the site does not have.
 *
 * The output is generated and gitignored, so it cannot go stale. It is in
 * `website/turbo.json`'s `outputs`, so a cache hit restores it with `.next/`,
 * and excluded from that task's `inputs`, so writing it does not move the hash
 * of the build that wrote it.
 *
 *   node scripts/generate-search-index.ts
 */

const OUT = join(import.meta.dirname, '../public/_pagefind');

const records = searchRecords();

rmSync(OUT, { recursive: true, force: true });

const { index, errors: createErrors } = await pagefind.createIndex({ forceLanguage: 'en' });
if (createErrors?.length) throw new Error(createErrors.join('\n'));
if (!index) throw new Error('pagefind returned no index');

for (const record of records) {
  const { errors } = await index.addCustomRecord({
    url: record.url,
    content: record.body,
    language: 'en',
    // Only what the result list needs to render. Pagefind indexes meta values
    // as well as content, so `summary` is not here: it would be indexed twice
    // and dilute name matches. It goes to the name matcher's payload instead.
    meta: { title: record.title, kind: record.kind, ...(record.page ? { page: record.page } : {}) },
    filters: { kind: [record.kind] },
  });
  if (errors.length) throw new Error(errors.join('\n'));
}

const { errors: writeErrors } = await index.writeFiles({ outputPath: OUT });
if (writeErrors?.length) throw new Error(writeErrors.join('\n'));
await pagefind.close();

const byKind = records.reduce<Record<string, number>>((acc, r) => {
  acc[r.kind] = (acc[r.kind] ?? 0) + 1;
  return acc;
}, {});

console.log(`search: indexed ${records.length} records ${JSON.stringify(byKind)}`);
console.log(`  wrote ${OUT}`);
