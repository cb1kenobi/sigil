import { box } from '../../src/element/index.js';
import { createInput, ESCAPE_TIMEOUT } from '../../src/input/index.js';
import { createTestTerminal, KEYS, pressEscape, settleKeys } from '../../src/testing/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * A runner so loaded that the router's own timer for a lone Escape fires a long
 * time after it was due: every timer of `ESCAPE_TIMEOUT` is armed for `late`
 * instead, which is the lateness the fixed `ESCAPE_TIMEOUT + 30` sleep lost to.
 *
 * @param late - The delay it fires after, in milliseconds.
 */
function lateEscapes(late: number): void {
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number) =>
    real(fn, delay === ESCAPE_TIMEOUT ? late : delay)) as unknown as typeof setTimeout);
}

describe('waiting for the router to decide a key', () => {
  it('should return only once a lone Escape that fires late has been applied', async () => {
    lateEscapes(ESCAPE_TIMEOUT * 6);
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const seen: string[] = [];
    input.bind((event) => void seen.push(event.key.name));

    await pressEscape(ui);

    expect(seen).toEqual(['escape']);
    input.stop();
  });

  it('should be what a sleep past the timeout is not, on a router that fires late', async () => {
    lateEscapes(ESCAPE_TIMEOUT * 6);
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const seen: string[] = [];
    input.bind((event) => void seen.push(event.key.name));

    await ui.press(KEYS.escape);
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));

    expect(seen).toEqual([]);
    await settleKeys(ui);
    expect(seen).toEqual(['escape']);
    input.stop();
  });

  it('should return at once where nothing is held', async () => {
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const seen: string[] = [];
    input.bind((event) => void seen.push(event.key.name));

    await ui.press('a');
    await settleKeys(ui);

    expect(seen).toEqual(['a']);
    input.stop();
  });

  it('should treat a deadline that is not a positive number as the default, not as a failure', async () => {
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    await ui.press('a');

    await settleKeys(ui, 0);
    await settleKeys(ui, Number.NaN);
    await settleKeys(ui, -5);
    input.stop();
  });

  it('should return at once where no router reads the terminal', async () => {
    const ui = createTestTerminal();
    await ui.press(KEYS.escape);
    await settleKeys(ui);
  });

  it('should stop asking a router that has been stopped', async () => {
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    await ui.press(KEYS.escape);
    input.stop();

    await settleKeys(ui);
  });

  it('should say so rather than wait for ever where the clock is faked', async () => {
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });
    await ui.press(KEYS.escape);

    await expect(settleKeys(ui, 40)).rejects.toThrow(/still holding a key after 40 ms/u);
    vi.useRealTimers();
    input.stop();
  });
});
