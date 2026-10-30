/**
 * A horizontal divider, with an optional label set into it.
 *
 *   node demos/components/49-rule.js
 *   NO_COLOR=1 node demos/components/49-rule.js
 */
import { rule } from '@ttylabs/sigil/components';

// the room it may use: a rule spans this, so the demo prints the same thing
// whatever terminal it is run in
const width = 44;

console.log('a plain line, dimmed because a divider recedes:\n');
console.log(rule({ width }));

console.log('\nwith a label, which the line keeps clear of the ends:\n');
for (const align of ['left', 'center', 'right']) {
  console.log(rule({ align, label: align, width }));
}

console.log('\nthe four line styles:\n');
for (const line of ['single', 'double', 'bold', 'ascii']) {
  console.log(rule({ label: line, line, width }));
}

console.log('\na role colours the whole rule, label included:\n');
for (const role of ['accent', 'success', 'warn', 'error']) {
  console.log(rule({ label: role, role, width }));
}

console.log('\nwide characters are measured in columns, and a long label is cut:\n');
console.log(rule({ label: '日本語 🙂', width }));
console.log(rule({ label: 'A label that is far longer than the line it sits in', width }));

console.log('\nASCII where the terminal cannot draw it, read out of the env it was handed:\n');
console.log(rule({ env: { TERM: 'linux' }, label: 'TERM=linux', width }));
