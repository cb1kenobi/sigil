/**
 * Restyling the built-ins, which is the whole of what a theme is.
 *
 *   pnpm build
 *   node demos/style/02-themes.js
 *   node demos/style/02-themes.js | cat     <- the same run with no colour
 *
 * Every built-in -- the spinner, the progress bar, the table, the prompts, the
 * help screen -- draws itself with classes and carries no colour of its own. The
 * framework ships a sheet giving those classes their colours at origin
 * `framework`, which is where a browser's user-agent stylesheet sits. A theme is
 * the origin above it and an app's own rules are the origin above that.
 *
 * So restyling one is an ordinary rule with an ordinary selector: no
 * `!important`, no specificity contest, and nothing that has to know a component
 * was involved.
 */
import { table } from '@ttylabs/sigil/components';
import { FRAMEWORK_CSS } from '@ttylabs/sigil/theme';

const rows = [
	{ file: 'dist/index.mjs', size: '12.4 kB', note: 'entry' },
	{ file: 'dist/ansi.mjs', size: '4.9 kB', note: '' },
];

console.log('the defaults, which are the framework origin:\n');
console.log(table(rows, { indent: 2 }));

console.log('\n\na theme over them -- one rule, and the heading is magenta:\n');
console.log(
	table(rows, {
		indent: 2,
		theme: '.sigil-table-head { color: magenta; font-weight: normal; text-decoration: underline }',
	})
);

// the app's own sheet is a later origin still, so it beats the theme without
// either of them having to say anything about the other
console.log('\n\nand the app over the theme:\n');
console.log(
	table(rows, {
		indent: 2,
		sheets: ['.sigil-table-head { color: green }'],
		theme: '.sigil-table-head { color: magenta }',
	})
);

// the classes a theme is written against, which is the whole vocabulary
console.log('\n\nwhat a theme may restyle:\n');
for (const line of FRAMEWORK_CSS.trim().split('\n')) {
	console.log(`  ${line}`);
}
