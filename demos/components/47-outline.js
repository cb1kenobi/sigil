/**
 * Lists: bulleted, numbered and nested, and one that changes while it is on screen.
 *
 *   node demos/components/47-outline.js
 *   node demos/components/47-outline.js | cat    <- the finished list is written once
 *
 * An item is a string, or `{ text, items }` with the items nested under it. The
 * marker is chosen by depth, and an item that wraps hangs under its own text.
 */
import { createOutline, outline } from '@ttylabs/sigil/components';

// a fixed width and terminal, so the demo prints the same thing anywhere
const here = { env: {}, platform: 'linux', width: 44 };

const steps = [
  'Install the package',
  { text: 'Configure it', items: ['Pick a theme', 'Pick a shell for completions'] },
  'Ship it, and then tell everybody you know about the thing you shipped',
];

console.log('bulleted by default, and dashed one level down:\n');
console.log(outline(steps, here));

console.log('\n\na numbered outline with letters under it, wrapped at 44 columns:\n');
console.log(outline(steps, { ...here, enumerator: ['arabic', 'alpha'] }));

console.log('\n\nroman numerals line up on the full stop:\n');
console.log(
  outline(
    Array.from({ length: 9 }, (_, i) => `step ${i + 1}`),
    { ...here, enumerator: 'roman' }
  )
);

console.log('\n\nan enumerator is a function when none of the names fit:\n');
console.log(
  outline(steps.slice(0, 2), {
    ...here,
    enumerator: ({ count, index }) => `[${index + 1}/${count}]`,
  })
);

console.log('\n\na live outline redraws as the items change:\n');
const todo = ['compile', 'test', 'publish'];
const live = createOutline(
  todo.map((step) => `[ ] ${step}`),
  { env: {}, platform: 'linux' }
);
for (let done = 1; done <= todo.length; done++) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  live.update(todo.map((step, i) => `[${i < done ? 'x' : ' '}] ${step}`));
}
live.done();
