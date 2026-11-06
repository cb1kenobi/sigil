import { App, stylesheet } from '../src/root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { expect, it } from 'vitest';

// frames are drawn on a clock, about 30 a second, rather than once per key.
// SIG-309 is a helper that waits for the next one; until then, a timer
const frame = () => new Promise((resolve) => setTimeout(resolve, 50));

it('should count what Enter presses and quit on q', async () => {
  const term = createTestTerminal({ columns: 60, rows: 16 });
  const done = runApp(App, { detect: false, sheets: [stylesheet], terminal: term.terminal }).exited;
  await frame();

  await term.press(KEYS.enter, KEYS.down, KEYS.enter);
  await frame();
  // the screen row by row; the last is the bottom border
  expect(term.viewport.at(-2)).toMatch(/^│ 2 presses +│$/);

  await term.press('q');
  expect(await done).toBe(0);
  expect(term.screen.alternate).toBe(false);
});
