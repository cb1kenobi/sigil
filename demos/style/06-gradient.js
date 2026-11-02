/**
 * A colour ramp across a string, and around a box, at every depth a terminal has.
 *
 *   node demos/style/06-gradient.js
 *   node demos/style/06-gradient.js | cat     <- the same run, with no terminal
 *   NO_COLOR=1 node demos/style/06-gradient.js
 *
 * The first block asks for nothing and gets the depth the terminal has: a pipe
 * and `NO_COLOR` both arrive at level 0, where a gradient is the text and no
 * sequence at all. The second names each level itself, so the run shows the whole
 * ladder on any terminal -- and, piped, shows it as the escape sequences it
 * would write, which is the only way to see that level 1 is one colour.
 *
 * The ramp is the transitions' own mix (Oklab) and the cascade's own
 * degradation, so there is no colour model in here: this file only chooses stops.
 */
import { gradient, gradientBox } from '@ttylabs/sigil/style';

const stops = ['#ff5f6d', '#ffc371', '#47e1c8'];

// an escape is written out so that a pipe, which cannot show colour, can show
// what was written
const ESC = String.fromCharCode(0x1b);
const visible = (text) => text.replaceAll(ESC, '\\e');

console.log('-- the detected depth');
console.log(gradient('Sigil builds command line apps', stops));
console.log(gradientBox('Deployed to production\nin 4.2 seconds', stops, { border: 'round' }));

for (const level of [3, 2, 1, 0]) {
  console.log(`\n-- level ${level}`);
  const line = gradient('Gradient 日本語 👨‍👩‍👧 ramp', stops, { level });
  console.log(line);
  console.log(visible(gradient('abc', stops, { level })));
}

console.log('\n-- a border on its own, three sets');
for (const border of ['single', 'double', 'bold']) {
  console.log(gradientBox(border, ['#00c6ff', '#0072ff'], { border, level: 3 }));
}
