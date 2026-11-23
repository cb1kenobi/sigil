import { box } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A handler that throws, over a test terminal whose router has no `onError`.
 *
 * Without `onError` the throw escapes the router's `data` listener, and a
 * `PassThrough` does not recover from a listener that threw out of `write()`:
 * every later key was lost, Escape included, which in a test is
 * indistinguishable from the app under test being stuck (SIG-619).
 */
describe('a handler that throws over a test terminal', () => {
  it('should keep delivering keys after the throw, Escape included', async () => {
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const seen: string[] = [];
    input.bind((event) => {
      seen.push(event.key.sequence);
      if (event.key.sequence === 'x') {
        throw new Error('boom');
      }
    });

    await expect(ui.press('x')).rejects.toThrow('boom');
    await ui.press('y', KEYS.up);

    expect(seen).toEqual(['x', 'y', KEYS.up]);
    input.stop();
  });

  it('should let a test see the error from a direct stdin write too', () => {
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const seen: string[] = [];
    input.bind((event) => {
      seen.push(event.key.sequence);
      if (event.key.sequence === 'x') {
        throw new Error('boom');
      }
    });

    expect(() => ui.stdin.write('x')).toThrow('boom');
    ui.stdin.write('y');

    expect(seen).toEqual(['x', 'y']);
    input.stop();
  });

  it('should still hand the error to onError where the router has one', async () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    const input = createInput({
      onError: (error) => void errors.push(error),
      root: box({}),
      terminal: ui.terminal,
    });
    input.bind(() => {
      throw new Error('boom');
    });

    await ui.press('x', 'y');

    expect(errors).toHaveLength(2);
    input.stop();
  });
});
