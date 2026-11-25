import { createDecrypt, decrypt } from '../../src/components/decrypt.js';
import { text } from '../../src/components/index.js';
import { createSpinner } from '../../src/components/spinner.js';
import { tasks } from '../../src/components/tasks.js';
import { createTypewriter } from '../../src/components/typewriter.js';
import { setup, tick } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

/**
 * A throwing `onError`, on the components that have no caller to raise to (SIG-683).
 *
 * SIG-674 made a frame that fails on the renderer's own timer fall back to the
 * default report, since nothing on that stack can catch what `onError` throws.
 * The ticket asked whether a component calling `mounted.frame()` from an interval
 * of its own had the same hole. None has: the spinner's, the typewriter's, the
 * decrypt effect's and the task list's intervals write a signal, and the frame
 * that signal asks for is the renderer's, so it already is that timer. The sites
 * the ticket named are calls a caller makes. What had a hole is the prompt, whose
 * `onError` runs from the tail of a promise chain, and the task list's resize
 * listener, which painted a frame from the terminal's dispatch.
 */

/** Taken before any test fakes the timers, so that a wait can be a real one. */
const realImmediate = setImmediate;

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

describe('a resize that repaints the task list, whose onError throws', () => {
  it('should write the default report rather than raise it into the terminal (SIG-683)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const heard: unknown[] = [];
    // everything goes through until the screen narrows, and then the reflow does not
    const ui = setup({ columns: 40 });
    const write = ui.stdout.write.bind(ui.stdout);
    let broken = false;
    ui.stdout.write = (chunk: string): boolean => {
      if (broken) {
        throw new Error('pipe broke');
      }
      return write(chunk);
    };
    const gate = Promise.withResolvers<void>();
    const running = tasks(
      [{ task: () => gate.promise, title: 'a title long enough to wrap when the screen narrows' }],
      { onError: throwing(heard), terminal: ui.terminal }
    );
    await vi.advanceTimersByTimeAsync(200);
    ui.stdout.columns = 12;
    broken = true;

    // `resize` is dispatched by the terminal's listener with nobody to catch it
    expect(() => ui.stdout.emit('resize')).not.toThrow();
    await vi.advanceTimersByTimeAsync(200);

    expect(written()).toContain('Error in frame: pipe broke\n');
    expect(written()).toContain('Error in frame error handler: onError broke\n');
    expect(heard.length).toBeGreaterThan(0);
    broken = false;
    gate.resolve();
    await running.catch(() => undefined);
  });
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
      breakNext = true;
      ui.stdin.send('\r');

      // the answer is the answer, whatever the last frame did
      await expect(answer).resolves.toBe('a');
      await tick(3);

      expect(rejections).toEqual([]);
      expect(heard.map(String)).toEqual(['Error: pipe broke']);
      expect(written()).toContain('Error in prompt: pipe broke\n');
      expect(written()).toContain('Error in prompt error handler: onError broke\n');
      expect(process.exitCode).toBe(1);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('a decrypt that finished over a screen that failed, whose onError throws', () => {
  /**
   * A decrypt started and run to its last frame, with the screen then breaking.
   *
   * The timers are advanced synchronously, so the run has settled and its
   * teardown is still queued on a microtask when the writes start to fail: what
   * the teardown then paints is the failure, and nothing is on the stack to
   * catch what `onError` throws for it.
   */
  function broken(heard: unknown[]) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = setup({ columns: 40 });
    const write = ui.stdout.write.bind(ui.stdout);
    let failing = false;
    ui.stdout.write = (chunk: string): boolean => {
      if (failing) {
        throw new Error('pipe broke');
      }
      return write(chunk);
    };
    const effect = createDecrypt({
      onError: throwing(heard),
      terminal: ui.terminal,
      text: 'hello world, here',
    }).start();
    while (effect.decrypting) {
      vi.advanceTimersByTime(50);
    }
    failing = true;
    return { effect };
  }

  /** Collects what reaches `unhandledRejection` while `run` goes. */
  async function rejecting(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => void seen.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await run();
      // the runtime reports an unhandled rejection after the microtasks drain
      await new Promise<void>((resolve) => realImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    return seen;
  }

  it('should write the default report rather than reject a done nobody holds (SIG-691)', async () => {
    const heard: unknown[] = [];
    const seen = await rejecting(async () => {
      broken(heard);
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(seen).toEqual([]);
    expect(written()).toContain('Error in decrypt: onError broke\n');
    expect(process.exitCode).toBe(1);
  });

  it('should raise no unhandled rejection when the report cannot be written either (SIG-691)', async () => {
    const heard: unknown[] = [];
    let rejection: unknown;
    const seen = await rejecting(async () => {
      stderr?.mockImplementation(() => {
        throw new Error('stderr gone');
      });
      const { effect } = broken(heard);
      await vi.advanceTimersByTimeAsync(100);
      await effect.done.catch((error: unknown) => void (rejection = error));
    });

    expect(seen).toEqual([]);
    // the report was dropped, and done still settled with the failure
    expect(String(rejection)).toBe('Error: onError broke');
  });

  const listeners = {
    'an await': async (done: Promise<void>) => {
      await done;
    },
    'a catch()': (done: Promise<void>) => done.catch((error: unknown) => Promise.reject(error)),
    'a finally()': (done: Promise<void>) => done.finally(() => undefined),
    'a Promise.all()': async (done: Promise<void>) => {
      await Promise.all([done, Promise.resolve()]);
    },
  };

  for (const [name, listen] of Object.entries(listeners)) {
    it(`should reject for a caller that waits with ${name}, and write nothing of its own (SIG-691)`, async () => {
      const heard: unknown[] = [];
      let rejection: unknown;
      const seen = await rejecting(async () => {
        const { effect } = broken(heard);
        const waiting = listen(effect.done).catch((error: unknown) => void (rejection = error));
        await vi.advanceTimersByTimeAsync(100);
        await waiting;
      });

      expect(String(rejection)).toBe('Error: onError broke');
      expect(seen).toEqual([]);
      expect(written()).not.toContain('Error in decrypt');
      expect(process.exitCode).toBeUndefined();
    });
  }

  it('should still reject for a caller that looks after the failure, without a report of its own (SIG-691)', async () => {
    const heard: unknown[] = [];
    let rejection: unknown;
    const seen = await rejecting(async () => {
      const { effect } = broken(heard);
      await vi.advanceTimersByTimeAsync(100);
      await effect.done.catch((error: unknown) => void (rejection = error));
    });

    expect(String(rejection)).toBe('Error: onError broke');
    expect(seen).toEqual([]);
    // written once, for the moment nobody was listening
    expect(written().match(/Error in decrypt: /g)).toHaveLength(1);
  });

  it('should write the default report for a decrypt() nobody awaits (SIG-691)', async () => {
    const heard: unknown[] = [];
    const seen = await rejecting(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const ui = setup({ columns: 40 });
      const write = ui.stdout.write.bind(ui.stdout);
      let failing = false;
      ui.stdout.write = (chunk: string): boolean => {
        if (failing) {
          throw new Error('pipe broke');
        }
        return write(chunk);
      };
      void decrypt('hello world, here', { onError: throwing(heard), terminal: ui.terminal });
      await vi.advanceTimersByTimeAsync(0);
      // the run has settled once its last timer has fired, and not before
      vi.advanceTimersByTime(60_000);
      failing = true;
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(seen).toEqual([]);
    expect(written()).toContain('Error in decrypt: onError broke\n');
  });
});
