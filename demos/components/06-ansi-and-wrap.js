/**
 * The pieces the components are drawn with: styling, wrapping, and width.
 *
 *   node demos/components/06-ansi-and-wrap.js
 *   NO_COLOR=1 node demos/components/06-ansi-and-wrap.js
 */
import { ansi } from '@ttylabs/sigil/ansi';
import { stringWidth } from '@ttylabs/sigil/width';
import { terminalWidth, wrap } from '@ttylabs/sigil/wrap';

console.log(ansi.bold.red('bold red'), ansi.dim('dim'), ansi.underline.cyan('underlined cyan'));
console.log(ansi.hex('#ff8800')('a hex color'), ansi.bgBlue.white(' a background '));

// an inner style that ends does not switch the outer one off
console.log(ansi.blue(`blue ${ansi.red('red')} blue again`));

console.log(`\ncolor level: ${ansi.level} (0 means none was detected)`);
console.log(`terminal width: ${terminalWidth()} columns\n`);

const text =
	'Text is wrapped at word boundaries, and a style still open at the break is closed and reopened so a background never bleeds into the margin.';

console.log(wrap(ansi.bgBlue.white(text), 40));

console.log('\nwidth is measured in columns, not characters:');
for (const sample of ['hello', '日本語', '🙂', '🇯🇵', 'á']) {
	// padded with `stringWidth()` rather than `String.padEnd()`, which counts
	// UTF-16 code units and would leave this very list ragged -- which is the
	// point being made. A table declares the width and lets the box model do it;
	// down here, where there is no box, it is a subtraction.
	const columns = String(stringWidth(sample)).padStart(2);
	const cell = sample + ' '.repeat(Math.max(0, 10 - stringWidth(sample)));
	console.log(`  ${cell}  ${columns} columns, ${sample.length} code units`);
}
