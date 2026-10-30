/**
 * A paginator: page state, and an indicator for where you are.
 *
 *   node demos/components/50-paginator.js
 *   NO_COLOR=1 node demos/components/50-paginator.js
 *
 * For content that is in pages rather than one long scroll -- a result set, a
 * wizard, a help browser. `createPaginator()` is the arithmetic: which items are on
 * the page, whether there is a next, and the page kept in range when the total
 * changes. `pageIndicator()` is the string, and it works on a pipe.
 */
import { createPaginator, pageIndicator } from '@ttylabs/sigil/components';

// fixed, so the demo prints the same thing in any terminal
const ascii = false;

const files = Array.from({ length: 23 }, (_, i) => `result-${String(i + 1).padStart(2, '0')}.log`);
const pager = createPaginator({ perPage: 5, total: files.length });

// every page of a result set, the way a pager would show them one at a time
do {
  console.log(pager.slice(files).join('  '));
  console.log(`  ${pager.indicator({ ascii, style: 'both' })}`);
} while (pager.next());

// the three styles at the same place
console.log('');
for (const style of ['dots', 'numeric', 'both']) {
  console.log(`${style.padEnd(8)}${pageIndicator(2, 5, { ascii, style })}`);
}

// more pages than a row of dots is good for is a number
console.log(`${'forty'.padEnd(8)}${pageIndicator(11, 40, { ascii })}`);

// the number can be worded as the app likes
console.log(
  `${'worded'.padEnd(8)}${pageIndicator(1, 5, {
    ascii,
    format: (page, pages) => `Page ${page} of ${pages}`,
    style: 'numeric',
  })}`
);

// results that shrink take the page with them, and growing again does not
// spring it back
pager.last();
console.log('');
console.log(`on page ${pager.page + 1} of ${pager.pages}`);
pager.total = 8;
console.log(`after the total fell to 8: page ${pager.page + 1} of ${pager.pages}`);
pager.total = 23;
console.log(`after it grew back to 23: page ${pager.page + 1} of ${pager.pages}`);
