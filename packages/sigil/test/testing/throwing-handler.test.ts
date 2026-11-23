import { box } from '../../src/element/index.js';
import {
  createInput,
  ESCAPE_TIMEOUT,
  PASTE_TIMEOUT,
  SEQUENCE_TIMEOUT,
} from '../../src/input/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('should deliver a lone Escape after a throw, which is the key that read as a stuck app', async () => {
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
    await ui.press(KEYS.escape);
    // a lone Escape is held for the timeout in case an Alt chord follows
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 50));

    expect(seen).toEqual(['x', KEYS.escape]);
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

/**
 * A throw from one of the router's own timers, which no `write()` is there to
 * hand back (SIG-631).
 *
 * The hold on a lone Escape, a sequence's deadline and a paste that never ended
 * each dispatch from a timer, so a handler that throws there was an uncaught
 * exception and `press()` had already resolved. `onTimerError()` is the hook a
 * test hears it through.
 */
describe('a handler that throws from a router timer over a test terminal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should hand a throw from the lone-Escape hold to onTimerError', async () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const seen: string[] = [];
    input.bind((event) => {
      seen.push(event.key.sequence);
      if (event.key.sequence === KEYS.escape) {
        throw new Error('boom');
      }
    });

    ui.stdin.write(KEYS.escape);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(ESCAPE_TIMEOUT);

    expect(errors).toEqual([new Error('boom')]);
    // and the session carries on
    ui.stdin.write('y');
    expect(seen).toEqual([KEYS.escape, 'y']);
    input.stop();
  });

  it('should hand a throw from a key sequence deadline to onTimerError', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    // `g` is a binding and a prefix of `g g`, so it waits to see which was meant
    input.bind('g', () => {
      throw new Error('boom');
    });
    input.bind('g g', () => {});

    ui.stdin.write('g');
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT);

    expect(errors).toEqual([new Error('boom')]);
    input.stop();
  });

  it('should hand a throw from a paste that never ended to onTimerError', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    input.onPaste(() => {
      throw new Error('boom');
    });

    ui.stdin.write(`${KEYS.escape}[200~half`);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(PASTE_TIMEOUT);

    expect(errors).toEqual([new Error('boom')]);
    input.stop();
  });

  it('should hand a throw from a paste whose start marker ended the read to onTimerError', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    input.onPaste(() => {
      throw new Error('boom');
    });

    // the timer is armed where the marker is read, which is not where content is
    ui.stdin.write(`${KEYS.escape}[200~`);
    vi.advanceTimersByTime(PASTE_TIMEOUT);

    expect(errors).toEqual([new Error('boom')]);
    input.stop();
  });

  it('should hand a throw from the Escape hold a query leaves behind to onTimerError', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    input.bind(() => {
      throw new Error('boom');
    });

    // a control string held for a query that is outstanding is on no timer; it
    // goes on the key timeout when the query settles
    void input.query({ timeout: 100, until: () => false, write: '?' });
    ui.stdin.write(`${KEYS.escape}]52;c;`);
    vi.advanceTimersByTime(100);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(ESCAPE_TIMEOUT);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toEqual(new Error('boom'));
    input.stop();
  });

  it('should let a handler that throws replace the error and starve the later ones', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const later: unknown[] = [];
    ui.onTimerError(() => {
      throw new Error('hook');
    });
    ui.onTimerError((error) => void later.push(error));
    input.bind(() => {
      throw new Error('boom');
    });

    ui.stdin.write(KEYS.escape);

    expect(() => vi.advanceTimersByTime(ESCAPE_TIMEOUT)).toThrow('hook');
    expect(later).toEqual([]);
    input.stop();
  });

  it('should leave the throw uncaught where no test is listening, as it is in an app', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    input.bind(() => {
      throw new Error('boom');
    });

    ui.stdin.write(KEYS.escape);

    expect(() => vi.advanceTimersByTime(ESCAPE_TIMEOUT)).toThrow('boom');
    input.stop();
  });

  it('should stop hearing once the handler is taken off', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const input = createInput({ root: box({}), terminal: ui.terminal });
    const errors: unknown[] = [];
    const off = ui.onTimerError((error) => void errors.push(error));
    input.bind(() => {
      throw new Error('boom');
    });
    off();

    ui.stdin.write(KEYS.escape);

    expect(() => vi.advanceTimersByTime(ESCAPE_TIMEOUT)).toThrow('boom');
    expect(errors).toEqual([]);
    input.stop();
  });

  it('should give a router that has an onError the throw, and the hook nothing', () => {
    vi.useFakeTimers();
    const ui = createTestTerminal();
    const routed: unknown[] = [];
    const heard: unknown[] = [];
    const input = createInput({
      onError: (error) => void routed.push(error),
      root: box({}),
      terminal: ui.terminal,
    });
    ui.onTimerError((error) => void heard.push(error));
    input.bind(() => {
      throw new Error('boom');
    });

    ui.stdin.write(KEYS.escape);
    vi.advanceTimersByTime(ESCAPE_TIMEOUT);

    expect(routed).toEqual([new Error('boom')]);
    expect(heard).toEqual([]);
    input.stop();
  });

  it('should refuse a handler that is not a function', () => {
    const ui = createTestTerminal();

    expect(() => ui.onTimerError(undefined as never)).toThrow('onTimerError() takes a function');
  });
});
