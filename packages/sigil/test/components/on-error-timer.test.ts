import { createDecrypt } from '../../src/components/decrypt.js';
import { text } from '../../src/components/index.js';
import { createSpinner } from '../../src/components/spinner.js';
import { createTypewriter } from '../../src/components/typewriter.js';
import { setup, tick } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

/**
 * A throwing `onError`, on the components that have no caller to raise to (SIG-683).
 *
 * SIG-674 made a frame that fails on the renderer's own timer fall back to the
 * default report, since nothing on that stack can catch what `onError` throws.
 * The ticket asked whether a component calling `mounted.frame()` from an interval
 * of its own had the same hole. It has none to find among the spinner, the
 * typewriter, the decrypt effect or the task list: their intervals write a signal
 * and the frame that signal asks for is the renderer's, so it already is that
 * timer. The sites the ticket named are calls a caller makes. What had a hole is
 * the prompt, whose `onError` runs from the tail of a promise chain.
 */

let stderr: MockInstance<typeof process.stderr.write> | undefined;
let exitCode: typeof process.exitCode;

beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = undefined;
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr?.mockRestore();
  process.exitCode = exitCode;
  vi.useRealTimers();
});

/** What the default report has written so far. */
function written(): string {
  return (stderr?.mock.calls ?? []).map((call) => String(call[0])).join('');
}

/** An `onError` that logs what it was handed and then throws something of its own. */
function throwing(heard: unknown[]) {
  return (error: unknown): never => {
    heard.push(error);
    throw new Error('onError broke');
  };
}

interface Started {
  onError: (error: unknown) => void;
  terminal: ReturnType<typeof setup>['terminal'];
}

/** A terminal whose writes fail once `allowed` of them have gone through. */
function failingAfter(allowed: number) {
  const ui = setup({ columns: 40 });
  const write = ui.stdout.write.bind(ui.stdout);
  let count = 0;
  ui.stdout.write = (chunk: string): boolean => {
    if (++count > allowed) {
      throw new Error('pipe broke');
    }
    return write(chunk);
  };
  return ui;
}

describe('a frame that fails on a component timer, whose onError throws', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  const components = {
    decrypt: (opts: Started) => createDecrypt({ ...opts, text: 'hello world, here' }).start(),
    spinner: (opts: Started) => createSpinner({ ...opts, text: 'working' }).start(),
    typewriter: (opts: Started) => createTypewriter({ ...opts, text: 'hello world, here' }).start(),
  };

  for (const [name, start] of Object.entries(components)) {
    it(`should write the default report rather than raise it from a ${name}'s timer (SIG-683)`, () => {
      const heard: unknown[] = [];
      const ui = failingAfter(2);
      start({ onError: throwing(heard), terminal: ui.terminal });

      // the interval ticks, the frame it asks for is the renderer's timer's, and
      // that frame fails over a pipe that broke: an uncaught exception on a real one
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      expect(written()).toContain('Error in frame: pipe broke\n');
      expect(written()).toContain('Error in frame error handler: onError broke\n');
      expect(process.exitCode).toBe(1);
      // and onError still heard what failed
      expect(heard.map(String)).toContain('Error: pipe broke');
    });
  }
});

describe('a prompt that was answered, whose onError throws', () => {
  it('should write the default report rather than reject a promise nobody holds (SIG-683)', async () => {
    const heard: unknown[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const ui = setup({ columns: 40 });
      const write = ui.stdout.write.bind(ui.stdout);
      let breakNext = false;
      ui.stdout.write = (chunk: string): boolean => {
        // the answer's frame, and not the sequences around it
        // eslint-disable-next-line no-control-regex
        if (breakNext && /[a-z]/.test(chunk.replace(/\u001b\[[\d;?]*[A-Za-z]/g, ''))) {
          breakNext = false;
          throw new Error('pipe broke');
        }
        return write(chunk);
      };

      const answer = text({
        message: 'name?',
        onError: throwing(heard),
        terminal: ui.terminal,
      });
      await tick();
      ui.stdin.send('a');
      await tick();
      // the typed key's own frame is painted on the renderer's timer, so it is let
      // go by before the one that fails is the answer's
      await new Promise((resolve) => setTimeout(resolve, 100));
      breakNext = true;
      ui.stdin.send('\r');

      // the answer is the answer, whatever the last frame did
      await expect(answer).resolves.toBe('a');
      await tick(3);

      expect(rejections).toEqual([]);
      expect(heard.map(String)).toContain('Error: pipe broke');
      expect(written()).toContain('Error in prompt: pipe broke\n');
      expect(written()).toContain('Error in prompt error handler: onError broke\n');
      expect(process.exitCode).toBe(1);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
