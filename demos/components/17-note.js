/**
 * A titled, bordered block that stands out from the output around it.
 *
 *   node demos/components/17-note.js
 *   NO_COLOR=1 node demos/components/17-note.js
 */
import { note } from '@ttylabs/sigil/components';

// the room it may use: a block shrinks to its message and is wrapped at this,
// so the demo prints the same thing whatever terminal it is run in
const width = 44;

console.log('shrinks to its message, with a title set into the border:\n');
console.log(
  note('Your project is ready.\n\n  $ cd my-app\n  $ npm install\n  $ npm run dev', {
    title: 'Next steps',
    width,
  })
);

console.log('\n\nthe four states take their colour from a theme role:\n');
for (const [variant, message] of [
  ['info', 'A new version is available.'],
  ['success', 'Built 12 files in 340ms.'],
  ['warning', 'This option is deprecated.'],
  ['error', 'Could not read sigil.json.'],
]) {
  console.log(note(message, { title: variant, variant, width }));
}

console.log('\n\nthe title can sit at the left, in the middle, or at the right:\n');
for (const titleAlign of ['left', 'center', 'right']) {
  console.log(note(`titleAlign: '${titleAlign}'`, { title: 'Title', titleAlign, width }));
}

console.log('\n\nlong messages wrap, and wide characters keep the border straight:\n');
console.log(
  note(
    'A message longer than the room it is given is wrapped inside the box rather than ' +
      'running off the edge.\n\n日本語のテキストも、絵文字 🙂 も、枠からはみ出しません。',
    { title: 'Wrapping', width }
  )
);

console.log('\n\nthe border is rounded, or ASCII where the terminal cannot draw it:\n');
console.log(note('border: ascii', { border: 'ascii', title: 'ASCII', width }));
console.log(
  note('TERM=linux is read as such', { env: { TERM: 'linux' }, title: 'Detected', width })
);
