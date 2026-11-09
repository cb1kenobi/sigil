import { App, stylesheet } from '../src/root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { createTestTerminal, frame, KEYS } from '@ttylabs/sigil/testing';
import { expect, it } from 'vitest';

it('should count what Enter presses and quit on q', async () => {
  const term = createTestTerminal({ columns: 60, rows: 16 });
  const app = runApp(App, { detect: false, sheets: [stylesheet], terminal: term.terminal });

  await term.press(KEYS.enter, KEYS.down, KEYS.enter);
  // frames are drawn on a clock, about 30 a second, rather than once per key:
  // frame() paints the next one now instead of waiting for it
  await frame(app);
  // the screen row by row; the last is the bottom border
  expect(term.viewport.at(-2)).toMatch(/^│ 2 presses +│$/);

  await term.press('q');
  expect(await app.exited).toBe(0);
  expect(term.screen.alternate).toBe(false);
});
