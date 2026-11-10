import { strip } from '../../src/ansi/index.js';
import * as prompt from '../../src/components/prompt.js';
import { TextArea } from '../../src/components/text-area.js';
import { box, renderToLines } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { flush } from '../../src/signals/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * Only the lines on screen are laid out and painted, which is what lets a
 * fifty-thousand-line buffer scroll the way a ten-line one does.
 *
 * Asked by counting rather than by timing: a timing test is a test of the
 * machine it runs on, while the claim is about how much work a frame does. So
 * `layoutField()` -- the one thing that turns a line into cells -- is wrapped,
 * and a frame of a 50,000-line value is held to the rows it draws. The measured
 * figures are in `AGENTS.md` under "A text area".
 */

vi.mock('../../src/components/prompt.js', async (original) => {
  const actual = await original<typeof prompt>();
  return { ...actual, layoutField: vi.fn(actual.layoutField) };
});

const HEIGHT = 10;
const WIDTH = 40;

function frame(root: ReturnType<typeof box>): string[] {
  return renderToLines(root, {
    cascade: themedCascade(),
    colorLevel: 0,
    height: HEIGHT,
    width: WIDTH,
  }).map((line) => strip(line).trimEnd());
}

describe('a text area over a long value', () => {
  const value = Array.from({ length: 50_000 }, (_, i) => `line ${i + 1}`).join('\n');
  const laid = vi.mocked(prompt.layoutField);

  it('should lay out the lines on screen and no others, however long the value', async () => {
    const area = TextArea({ lineNumbers: true, props: { 'flex-grow': 1 }, value });
    const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH }, area);
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const input = createInput({ root, terminal: term.terminal });
    input.focus.focus(area);

    laid.mockClear();
    expect(frame(root).at(-1)).toBe('50000 line 50000');
    // a row per line on screen, and the caret's line once more to find its column
    expect(laid.mock.calls.length).toBeLessThanOrEqual(HEIGHT + 1);

    await term.press(`\u001b[1;5H`);
    flush();
    laid.mockClear();
    expect(frame(root)[0]).toBe('    1 line 1');
    expect(laid.mock.calls.length).toBeLessThanOrEqual(HEIGHT + 1);

    // a page, and then a keystroke, each one frame of the rows they show
    for (const key of [KEYS.pageDown, 'x']) {
      await term.press(key);
      flush();
      laid.mockClear();
      frame(root);
      expect(laid.mock.calls.length).toBeLessThanOrEqual(HEIGHT + 2);
    }
    // and a frame nothing changed lays out nothing
    laid.mockClear();
    frame(root);
    frame(root);
    expect(laid.mock.calls).toHaveLength(0);
    input.stop();
  });
});
