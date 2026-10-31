/**
 * A badge: a few characters on a coloured ground, for a table cell or a line.
 *
 *   node demos/components/30-badge.js
 *   NO_COLOR=1 node demos/components/30-badge.js
 */
import { badge, badgeView, table } from '@ttylabs/sigil/components';

console.log('the five variants, each from a theme role:\n');
for (const variant of ['neutral', 'success', 'warning', 'error', 'info']) {
  console.log(`  ${badge(variant, { variant })}`);
}

console.log('\n\nin a line of text:\n');
console.log(`  ${badge('PASS', { variant: 'success' })} 148 tests in 2.1s`);
console.log(`  ${badge('FAIL', { variant: 'error' })} packages/cli/test/build.test.ts`);
console.log(`  ${badge('beta')} sigil build --watch`);

console.log('\n\nin a table cell, as a view so that the colour survives:\n');
const rows = [
  ['@ttylabs/sigil', badgeView('PASS', { variant: 'success' }), '2.1s'],
  ['@ttylabs/cli', badgeView('FAIL', { variant: 'error' }), '4.8s'],
  ['@ttylabs/config-xml', badgeView('SKIP', { variant: 'warning' }), '-'],
  ['@ttylabs/config-yaml', badgeView('beta'), '0.9s'],
];
console.log(
  table(rows, {
    columns: [{ header: 'package' }, { header: 'status' }, { align: 'right', header: 'time' }],
  })
);

console.log('\n\na theme restyles the role, and every badge that draws with it follows:\n');
console.log(
  `  ${badge('PASS', { theme: '.sigil-success { color: magenta }', variant: 'success' })}`
);

console.log('\n\nwith no colour the padding becomes brackets, so a label is still set apart:\n');
console.log(`  ${badge('PASS', { colorLevel: 0, variant: 'success' })} 148 tests in 2.1s`);
console.log(`  ${badge('FAIL', { colorLevel: 0, variant: 'error' })} build.test.ts`);
