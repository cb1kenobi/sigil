import { confirm, select, text } from '../../src/components/index.js';
import { DISABLE_PASTE } from '../../src/terminal/sequences.js';
import { setup, tick } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

/**
 * A prompt whose terminal write fails while it detaches (SIG-692).
 *
 * Giving the input back is a write: the router's `stop()` ends bracketed paste.
 * On a terminal that has gone -- a closed pipe, a revoked tty -- that write
 * throws, and it threw out of `succeed()` ahead of the `try` that resolves the
 * promise, so the caller waited on an answer it had been given and the throw came
 * out of `.catch(report)` as a rejection nobody held.
 */

let stderr: MockInstance<typeof process.stderr.write> | undefined;
let exitCode: typeof process.exitCode;
const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => void rejections.push(reason);

beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = undefined;
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  stderr?.mockRestore();
  process.exitCode = exitCode;
});

/** What the default report has written so far. */
function written(): string {
  return (stderr?.mock.calls ?? []).map((call) => String(call[0])).join('');
}

/** A terminal whose write of the bracketed-paste reset -- the router's `stop()` -- fails. */
function detachFails() {
  const ui = setup({ columns: 40 });
  const write = ui.stdout.write.bind(ui.stdout);
  ui.stdout.write = (chunk: string): boolean => {
    if (chunk.includes(DISABLE_PASTE)) {
      throw new Error('pipe broke');
    }
    return write(chunk);
  };
  return ui;
}

/** Whether a promise has settled, asked after the microtasks have had their turn. */
async function settledWithin(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  await tick(3);
  return done;
}

describe('a prompt answered on a terminal whose write fails at detach', () => {
  it('should resolve with the answer and report the failure once (SIG-692)', async () => {
    const heard: unknown[] = [];
    const ui = detachFails();
    const answer = text({
      message: 'name?',
      onError: (error) => void heard.push(error),
      terminal: ui.terminal,
    });
    await tick();
    ui.stdin.send('a');
    await tick();
    ui.stdin.send('\r');

    expect(await settledWithin(answer)).toBe(true);
    await expect(answer).resolves.toBe('a');
    await tick(3);

    expect(rejections).toEqual([]);
    expect(heard.map(String)).toEqual(['Error: pipe broke']);
    expect(written()).toBe('');
  });

  it('should still give the screen back, which the throw used to skip (SIG-692)', async () => {
    const ui = detachFails();
    const answer = confirm({ message: 'sure?', terminal: ui.terminal });
    await tick();
    ui.stdin.send('y');
    await expect(answer).resolves.toBe(true);

    // `done()` shows the cursor again; a throw ahead of it left it hidden
    expect(ui.stdout.output).toContain('\u001b[?25h');
  });

  it('should resolve and say nothing when the caller gave no onError (SIG-692)', async () => {
    const ui = detachFails();
    const answer = text({ message: 'name?', terminal: ui.terminal });
    await tick();
    ui.stdin.send('a');
    await tick();
    ui.stdin.send('\r');

    await expect(answer).resolves.toBe('a');
    await tick(3);
    expect(rejections).toEqual([]);
  });
});

describe('a prompt given up on a terminal whose write fails at detach', () => {
  it('should reject with what ended it, not with the write (SIG-692)', async () => {
    const heard: unknown[] = [];
    const ui = detachFails();
    const answer = text({
      message: 'name?',
      onError: (error) => void heard.push(error),
      terminal: ui.terminal,
    });
    const caught = answer.catch((error: unknown) => error);
    await tick();
    ui.stdin.send('\u0003');

    const error = await caught;
    expect(String((error as Error).message)).toBe('Cancelled');
    await tick(3);

    expect(rejections).toEqual([]);
    expect(heard.map(String)).toEqual(['Error: pipe broke']);
  });

  it('should reject with the abort reason when a signal ends it (SIG-692)', async () => {
    const heard: unknown[] = [];
    const ui = detachFails();
    const controller = new AbortController();
    const answer = text({
      message: 'name?',
      onError: (error) => void heard.push(error),
      signal: controller.signal,
      terminal: ui.terminal,
    });
    const caught = answer.catch((error: unknown) => error);
    await tick();
    const reason = new Error('stop');
    controller.abort(reason);

    expect(await caught).toBe(reason);
    await tick(3);

    expect(rejections).toEqual([]);
    expect(heard.map(String)).toEqual(['Error: pipe broke']);
  });

  it('should reject when the input ends, whatever the write does (SIG-692)', async () => {
    const ui = detachFails();
    const answer = text({ message: 'name?', terminal: ui.terminal });
    const caught = answer.catch((error: unknown) => error);
    await tick();
    ui.stdin.end();

    expect(String(((await caught) as Error).message)).toBe(
      'Input ended before the prompt was answered'
    );
    await tick(3);
    expect(rejections).toEqual([]);
  });
});

describe('a prompt asked as lines, on a terminal whose write fails at detach', () => {
  it('should resolve with the answer and report the failure once (SIG-692)', async () => {
    const heard: unknown[] = [];
    const ui = detachFails();
    const answer = text({
      accessible: true,
      message: 'name?',
      onError: (error) => void heard.push(error),
      terminal: ui.terminal,
    });
    await tick();
    ui.stdin.send('a');
    await tick();
    ui.stdin.send('\r');

    expect(await settledWithin(answer)).toBe(true);
    await expect(answer).resolves.toBe('a');
    await tick(3);

    expect(rejections).toEqual([]);
    expect(heard.map(String)).toEqual(['Error: pipe broke']);
  });

  it('should reject with what cancelled it, not with the write (SIG-692)', async () => {
    const heard: unknown[] = [];
    const ui = detachFails();
    const answer = text({
      accessible: true,
      message: 'name?',
      onError: (error) => void heard.push(error),
      terminal: ui.terminal,
    });
    const caught = answer.catch((error: unknown) => error);
    await tick();
    ui.stdin.send('\u0003');

    expect(String(((await caught) as Error).message)).toBe('Cancelled');
    await tick(3);

    expect(rejections).toEqual([]);
    expect(heard.map(String)).toEqual(['Error: pipe broke']);
  });

  it('should resolve when the line that says the answer cannot be written (SIG-692)', async () => {
    const ui = setup({ columns: 40 });
    const write = ui.stdout.write.bind(ui.stdout);
    // only what select() says once it has an answer: a failure before that is a
    // prompt that was not answered, and rejects
    ui.stdout.write = (chunk: string): boolean => {
      if (chunk.includes('Chosen:')) {
        throw new Error('pipe broke');
      }
      return write(chunk);
    };
    const heard: unknown[] = [];
    const answer = select({
      accessible: true,
      choices: ['a', 'b'],
      message: 'Pick',
      onError: (error) => void heard.push(error),
      terminal: ui.terminal,
    });
    await tick();
    ui.stdin.send('2\r');

    expect(await settledWithin(answer)).toBe(true);
    await expect(answer).resolves.toBe('b');
    await tick(3);
    expect(rejections).toEqual([]);
    expect(heard.map(String)).toEqual(['Error: pipe broke']);
  });

  it('should give the input back and reject when the first question cannot be written (SIG-692)', async () => {
    const ui = setup({ columns: 40 });
    const write = ui.stdout.write.bind(ui.stdout);
    ui.stdout.write = (chunk: string): boolean => {
      if (chunk.includes('name?')) {
        throw new Error('pipe broke');
      }
      return write(chunk);
    };
    const answer = text({ accessible: true, message: 'name?', terminal: ui.terminal });

    await expect(answer).rejects.toThrow('pipe broke');
    // the router was stopped rather than left reading with a raw stdin
    expect(ui.stdin.rawMode).toBe(false);
    expect(rejections).toEqual([]);
  });
});
