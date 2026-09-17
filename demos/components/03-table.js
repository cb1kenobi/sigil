/**
 * A table that lines up, whatever is in it.
 *
 *   node demos/components/03-table.js
 */
import { table } from '@ttylabs/sigil/components';

const rows = [
	{ file: 'dist/index.mjs', size: '12.4 kB', note: 'entry' },
	{ file: 'dist/ansi.mjs', size: '4.9 kB', note: '' },
	{ file: 'dist/components.mjs', size: '11.2 kB', note: 'lazy' },
];

console.log('columns inferred from the first row:\n');
console.log(table(rows));

console.log('\n\ndeclared columns, right aligned sizes, truncated names:\n');
console.log(
	table(rows, {
		indent: 2,
		columns: [
			{ header: 'File', key: 'file', maxWidth: 16 },
			{ header: 'Size', key: 'size', align: 'right' },
			{ header: 'Note', key: 'note' },
		],
	})
);

console.log('\n\nrows as arrays, and no header:\n');
console.log(
	table(
		[
			['✔', 'parser', '1292 tests'],
			['✔', 'components', '118 tests'],
			['✖', 'canvas', 'not started'],
		],
		{ indent: 2 }
	)
);

// widths are measured in display columns, not characters, so these line up too
console.log('\n\nwide characters and emoji:\n');
console.log(
	table(
		[
			{ name: 'index.js', lang: 'English' },
			{ name: '日本語.js', lang: '日本語' },
			{ name: '🙂emoji.js', lang: 'Emoji' },
		],
		{
			indent: 2,
			columns: [
				{ header: 'Name', key: 'name' },
				{ header: 'Language', key: 'lang' },
			],
		}
	)
);
