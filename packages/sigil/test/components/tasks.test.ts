import { skip, taskLog, tasks } from '../../src/components/tasks.js';
import { setQuiet } from '../../src/style/output.js';
import { runsOf } from '../runs-of.js';
import { screenSetup, setup, tick } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  setQuiet(undefined);
});

/** The lines a test feeds a window: `line 1`, `line 2`, and so on. */
function lines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`);
}

describe('taskLog()', () => {
  it('should show the title and only the most recent lines', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, limit: 3, terminal: ui.terminal, title: 'Build' });

    for (const line of lines(5)) {
      log.message(line);
    }

    expect(ui.log).to.deep.equal(['Build', '  line 3', '  line 4', '  line 5']);
  });

  it('should default to a window of six lines', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    for (const line of lines(9)) {
      log.message(line);
    }

    expect(ui.log).to.have.length(7);
    expect(ui.log.at(-1)).to.equal('  line 9');
    expect(ui.log[1]).to.equal('  line 4');
  });

  it('should leave one settled line and none of the output on success', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, limit: 3, terminal: ui.terminal, title: 'Build' });

    for (const line of lines(5)) {
      log.message(line);
    }
    log.success('Built');

    expect(ui.log).to.deep.equal(['✔ Built']);
    expect(log.settled).to.equal(true);
  });

  it('should keep the title when success is given no text', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    log.message('x');
    log.success();

    expect(ui.log).to.deep.equal(['✔ Build']);
  });

  it('should mark the title failed and keep all of the output on error', () => {
    const ui = screenSetup({ rows: 16 });
    const log = taskLog({ ansi: ui.ansi, limit: 3, terminal: ui.terminal, title: 'Build' });

    for (const line of lines(7)) {
      log.message(line);
    }
    log.error('Build failed');

    expect(ui.log).to.deep.equal(['✖ Build failed', ...lines(7).map((line) => `  ${line}`)]);
  });

  it('should say that it dropped earlier output when more than it retains arrived', () => {
    const ui = screenSetup({ rows: 16 });
    const log = taskLog({
      ansi: ui.ansi,
      limit: 2,
      retain: 3,
      terminal: ui.terminal,
      title: 'Build',
    });

    for (const line of lines(5)) {
      log.message(line);
    }
    log.error();

    expect(ui.log).to.deep.equal([
      '✖ Build',
      '  … earlier output omitted',
      '  line 3',
      '  line 4',
      '  line 5',
    ]);
  });

  it('should split a message holding several lines into several', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, limit: 4, terminal: ui.terminal, title: 'Build' });

    log.message('one\ntwo\r\nthree');

    expect(ui.log).to.deep.equal(['Build', '  one', '  two', '  three']);
  });

  it('should keep only what a carriage return left last, and no escape sequences', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    log.message('10%\r50%\r\u001B[31mdone\u001B[0m');

    expect(ui.log).to.deep.equal(['Build', '  done']);
  });

  it('should read a CRLF as a line break and not as a redraw', async () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      yield 'compiling a.ts\r\nb';
      // the break lands between the two halves of the CRLF
      yield '.ts\r';
      yield '\nlast\r';
    }
    await log.stream(chunks());

    expect(ui.log).to.deep.equal(['Build', '  compiling a.ts', '  b.ts', '  last']);
  });

  it('should keep the last state of a redraw that ends in a CRLF', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    log.message('10%\r50%\r100%\r\ndone');

    expect(ui.log).to.deep.equal(['Build', '  100%', '  done']);
  });

  it('should leave the output of a CRLF stream on screen when it fails', async () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    await log.stream(
      (async function* () {
        yield 'error TS2322\r\n  not assignable\r\n';
      })()
    );
    log.error('Build failed');

    expect(ui.log).to.deep.equal(['✖ Build failed', '  error TS2322', '    not assignable']);
  });

  it('should keep a blank line as a row of the window', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, limit: 3, terminal: ui.terminal, title: 'Build' });

    log.message('one');
    log.message('');
    log.message('three');

    expect(ui.log).to.have.length(4);
    expect(ui.log[1]).to.equal('  one');
    expect(ui.log[3]).to.equal('  three');
  });

  it('should cut a line that is wider than the screen rather than wrap it', () => {
    const ui = screenSetup({ columns: 20, rows: 12 });
    const log = taskLog({ ansi: ui.ansi, limit: 3, terminal: ui.terminal, title: 'Build' });

    log.message('x'.repeat(60));
    log.message('after');

    expect(ui.log).to.have.length(3);
    expect(ui.log.every((line) => line.length <= 20)).to.equal(true);
    expect(ui.log.at(-1)).to.equal('  after');
  });

  it('should ignore messages after it has settled', () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    log.success();
    log.message('late');
    log.error('too late');

    expect(ui.log).to.deep.equal(['✔ Build']);
  });

  it('should join a line split across chunks when fed from a stream', async () => {
    const ui = screenSetup({ rows: 12 });
    const log = taskLog({ ansi: ui.ansi, terminal: ui.terminal, title: 'Build' });

    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      yield 'hel';
      yield 'lo\nwor';
      yield new TextEncoder().encode('ld\nlast');
    }
    await log.stream(chunks());

    expect(ui.log).to.deep.equal(['Build', '  hello', '  world', '  last']);
  });

  describe('when there is no terminal', () => {
    it('should write the title, each line as it arrives, and a settled line', () => {
      const { stdout, terminal } = setup({ isTTY: false });
      const log = taskLog({ terminal, title: 'Build' });

      log.message('one');
      log.message('two');
      log.success('Built');

      expect(stdout.output).to.equal('Build\none\ntwo\n✔ Built\n');
    });

    it('should write nothing once it has settled', () => {
      const { stdout, terminal } = setup({ isTTY: false });
      const log = taskLog({ terminal, title: 'Build' });

      log.success();
      log.message('late');

      expect(stdout.output).to.equal('Build\n✔ Build\n');
    });

    it('should mark a failure without repeating the output', () => {
      const { stdout, terminal } = setup({ isTTY: false });
      const log = taskLog({ terminal, title: 'Build' });

      log.message('boom');
      log.error('Build failed');

      expect(stdout.output).to.equal('Build\nboom\n✖ Build failed\n');
    });
  });

  describe('when it was asked to be quiet', () => {
    it.each([
      ['a pipe', false],
      ['a terminal', true],
    ])('should write nothing at all to %s', (_name, isTTY) => {
      const { stdout, terminal } = setup({ isTTY });
      const log = taskLog({ quiet: true, terminal, title: 'Build' });

      log.message('one');
      log.error('Build failed');

      expect(stdout.output).to.equal('');
    });

    it('should honour the process-wide request', () => {
      setQuiet(true);
      const { stdout, terminal } = setup({ isTTY: true });
      const log = taskLog({ terminal, title: 'Build' });

      log.message('one');
      log.success();

      expect(stdout.output).to.equal('');
    });
  });
});

describe('tasks()', () => {
  it('should run the tasks in order and leave a done line for each', async () => {
    const ui = screenSetup();
    const order: string[] = [];

    await tasks(
      [
        { task: () => void order.push('a'), title: 'First' },
        { task: () => void order.push('b'), title: 'Second' },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(order).to.deep.equal(['a', 'b']);
    expect(ui.log).to.deep.equal(['✔ First', '✔ Second']);
  });

  it('should not start a task before the one before it has finished', async () => {
    const ui = screenSetup();
    const seen: string[] = [];
    let release = (): void => {};

    const running = tasks(
      [
        {
          task: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          title: 'Slow',
        },
        { task: () => void seen.push(ui.frame), title: 'Next' },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );
    await tick();

    expect(ui.frame).to.contain('Slow');
    expect(seen).to.deep.equal([]);

    release();
    await running;
    expect(seen).to.have.length(1);
  });

  it('should settle on the string a task returns in place of its title', async () => {
    const ui = screenSetup();

    await tasks([{ task: async () => 'Installed 12 packages', title: 'Install' }], {
      ansi: ui.ansi,
      terminal: ui.terminal,
    });

    expect(ui.log).to.deep.equal(['✔ Installed 12 packages']);
  });

  it('should leave no line for a disabled task and not run it', async () => {
    const ui = screenSetup();
    let ran = false;

    const results = await tasks(
      [
        {
          enabled: false,
          task: () => {
            ran = true;
          },
          title: 'Hidden',
        },
        { task: () => {}, title: 'Shown' },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(ran).to.equal(false);
    expect(ui.log).to.deep.equal(['✔ Shown']);
    expect(results.map((result) => result.title)).to.deep.equal(['Shown']);
  });

  it('should end a skipped task as an informational line carrying the reason', async () => {
    const ui = screenSetup();

    const results = await tasks(
      [
        { task: () => skip('already installed'), title: 'Install' },
        { task: () => skip(), title: 'Link' },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(ui.log).to.deep.equal(['ℹ Install (skipped: already installed)', 'ℹ Link (skipped)']);
    expect(results.map((result) => result.outcome)).to.deep.equal(['skip', 'skip']);
    expect(results[0]?.reason).to.equal('already installed');
  });

  it('should fail the line, run nothing after it, and rethrow', async () => {
    const ui = screenSetup();
    const boom = new Error('no network');
    let after = false;

    await expect(
      tasks(
        [
          {
            task: () => {
              throw boom;
            },
            title: 'Fetch',
          },
          {
            task: () => {
              after = true;
            },
            title: 'Never',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      )
    ).rejects.toBe(boom);

    expect(after).to.equal(false);
    expect(ui.log).to.deep.equal(['✖ Fetch']);
  });

  it('should fail the line for a task that rejects', async () => {
    const ui = screenSetup();

    await expect(
      tasks([{ task: () => Promise.reject(new Error('x')), title: 'Fetch' }], {
        ansi: ui.ansi,
        terminal: ui.terminal,
      })
    ).rejects.toThrow('x');

    expect(ui.log).to.deep.equal(['✖ Fetch']);
  });

  it('should let a task change what its line says while it runs', async () => {
    const ui = screenSetup();
    const frames: string[] = [];

    await tasks(
      [
        {
          async task({ message }) {
            message('Fetching 1 of 2');
            await tick();
            frames.push(ui.frame);
          },
          title: 'Fetch',
        },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(frames[0]).to.contain('Fetching 1 of 2');
  });

  describe('with a window of output', () => {
    it('should collapse the window to the task line when the task succeeds', async () => {
      const ui = screenSetup({ rows: 12 });

      await tasks(
        [
          {
            task({ log }) {
              const window = log({ limit: 2 });
              for (const line of lines(4)) {
                window.message(line);
              }
            },
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      );

      expect(ui.log).to.deep.equal(['✔ Build']);
    });

    it('should leave the failed line and all of the output when the task throws', async () => {
      const ui = screenSetup({ rows: 12 });

      await expect(
        tasks(
          [
            {
              task({ log }) {
                const window = log({ limit: 2 });
                for (const line of lines(4)) {
                  window.message(line);
                }
                throw new Error('exit 1');
              },
              title: 'Build',
            },
          ],
          { ansi: ui.ansi, terminal: ui.terminal }
        )
      ).rejects.toThrow('exit 1');

      expect(ui.log).to.deep.equal(['✖ Build', ...lines(4).map((line) => `  ${line}`)]);
    });

    it('should leave no frozen spinner line behind the window', async () => {
      const ui = screenSetup({ rows: 12 });
      let during: string[] = [];

      await tasks(
        [
          {
            task({ log }) {
              log({ limit: 2 }).message('working');
              during = ui.log;
            },
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      );

      expect(during).to.deep.equal(['Build', '  working']);
    });

    // the spinner's timer is what would keep painting its frame over the
    // window if it were only evicted and never stopped
    it('should stop the task spinner when a window takes its place', async () => {
      vi.useFakeTimers();
      try {
        const ui = screenSetup({ rows: 12 });
        let release = (): void => {};

        const running = tasks(
          [
            {
              async task({ log }) {
                log({ limit: 2 }).message('working');
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              },
              title: 'Build',
            },
          ],
          { ansi: ui.ansi, terminal: ui.terminal }
        );
        await vi.advanceTimersByTimeAsync(500);

        expect(ui.log).to.deep.equal(['Build', '  working']);
        expect(vi.getTimerCount()).to.equal(0);

        release();
        await running;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not settle a window the task already settled itself', async () => {
      const ui = screenSetup({ rows: 12 });

      await tasks(
        [
          {
            task({ log }) {
              log().success('Built in 2s');
            },
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      );

      expect(ui.log).to.deep.equal(['✔ Built in 2s']);
    });

    it('should end a skipped task that opened a window as informational, not done', async () => {
      const ui = screenSetup({ rows: 12 });

      const results = await tasks(
        [
          {
            task({ log }) {
              log().message('checking the cache');
              return skip('cached');
            },
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      );

      expect(ui.log).to.deep.equal(['ℹ Build (skipped: cached)']);
      expect(results[0]?.outcome).to.equal('skip');
    });

    it('should not settle a skipped task whose window the task already settled', async () => {
      const ui = screenSetup({ rows: 12 });

      await tasks(
        [
          {
            task({ log }) {
              log().success('Built in 2s');
              return skip('cached');
            },
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      );

      expect(ui.log).to.deep.equal(['✔ Built in 2s']);
    });

    it('should print the title once and the output as it comes in a pipe', async () => {
      const { stdout, terminal } = setup({ isTTY: false });

      await tasks(
        [
          {
            task({ log }) {
              log().message('compiling');
            },
            title: 'Build',
          },
        ],
        { terminal }
      );

      expect(stdout.output).to.equal('Build\ncompiling\n✔ Build\n');
    });

    it('should end a skipped task that opened a log as informational in a pipe', async () => {
      const { stdout, terminal } = setup({ isTTY: false });

      await tasks(
        [
          {
            task({ log }) {
              log().message('checking the cache');
              return skip('cached');
            },
            title: 'Build',
          },
        ],
        { terminal }
      );

      expect(stdout.output).to.equal('Build\nchecking the cache\nℹ Build (skipped: cached)\n');
    });
  });

  describe('when there is no terminal', () => {
    it('should write a line when each task starts and one when it settles', async () => {
      const { stdout, terminal } = setup({ isTTY: false });

      await tasks(
        [
          { task: () => 'Installed', title: 'Install' },
          { task: () => skip('cached'), title: 'Link' },
        ],
        { terminal }
      );

      expect(stdout.output).to.equal('Install\n✔ Installed\nLink\nℹ Link (skipped: cached)\n');
    });
  });

  describe('when it was asked to be quiet', () => {
    it('should write nothing, and still run the tasks and rethrow', async () => {
      const { stdout, terminal } = setup({ isTTY: false });
      let ran = 0;

      await tasks([{ task: () => void ran++, title: 'One' }], { quiet: true, terminal });
      await expect(
        tasks(
          [
            {
              task: () => {
                throw new Error('x');
              },
              title: 'Two',
            },
          ],
          { quiet: true, terminal }
        )
      ).rejects.toThrow('x');

      expect(ran).to.equal(1);
      expect(stdout.output).to.equal('');
    });
  });
});

/** A promise and the two handles that settle it, for a task a test finishes by hand. */
function deferred<T = void>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('tasks() side by side', () => {
  it('should run no more than concurrency tasks at once', async () => {
    const ui = screenSetup();
    let running = 0;
    let most = 0;

    await tasks(
      Array.from({ length: 6 }, (_, i) => ({
        async task() {
          running++;
          most = Math.max(most, running);
          await tick(1 + (i % 3));
          running--;
        },
        title: `Task ${i + 1}`,
      })),
      { ansi: ui.ansi, concurrency: 3, terminal: ui.terminal }
    );

    expect(most).to.equal(3);
  });

  it('should run every task at once with a concurrency of Infinity', async () => {
    const ui = screenSetup();
    const gate = deferred();
    let started = 0;

    const running = tasks(
      Array.from({ length: 5 }, (_, i) => ({
        async task() {
          started++;
          await gate.promise;
        },
        title: `Task ${i + 1}`,
      })),
      { ansi: ui.ansi, concurrency: Infinity, terminal: ui.terminal }
    );
    await tick();

    expect(started).to.equal(5);
    gate.resolve();
    await running;
  });

  it('should draw a row for each running task in one frame', async () => {
    const ui = screenSetup();
    const gate = deferred();

    const running = tasks(
      [
        { task: () => gate.promise, title: 'Fetch react' },
        { task: () => gate.promise, title: 'Fetch vite' },
      ],
      { ansi: ui.ansi, concurrency: 2, frames: ['*'], terminal: ui.terminal }
    );
    await tick();

    expect(ui.log).to.deep.equal(['* Fetch react', '* Fetch vite']);
    gate.resolve();
    await running;
  });

  it('should write a task above the frame as it finishes, in the order they finished', async () => {
    const ui = screenSetup();
    const first = deferred();
    const second = deferred();

    const running = tasks(
      [
        { task: () => first.promise, title: 'First' },
        { task: () => second.promise, title: 'Second' },
      ],
      { ansi: ui.ansi, concurrency: 2, frames: ['*'], terminal: ui.terminal }
    );
    await tick();

    second.resolve();
    await tick();
    expect(ui.log).to.deep.equal(['✔ Second', '* First']);

    first.resolve();
    const results = await running;
    expect(ui.log).to.deep.equal(['✔ Second', '✔ First']);
    // the results are the list's order whatever the screen's is
    expect(results.map((result) => result.title)).to.deep.equal(['First', 'Second']);
  });

  it('should drive every running row from one timer', async () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      const ui = screenSetup();
      const gate = deferred();

      const running = tasks(
        Array.from({ length: 4 }, (_, i) => ({ task: () => gate.promise, title: `Task ${i}` })),
        { ansi: ui.ansi, concurrency: 4, frames: ['a', 'b'], terminal: ui.terminal }
      );
      // one tick of the frames, and the repaint the renderer paces after it
      await vi.advanceTimersByTimeAsync(120);

      expect(intervals).toHaveBeenCalledTimes(1);
      expect(ui.log).to.deep.equal(['b Task 0', 'b Task 1', 'b Task 2', 'b Task 3']);

      gate.resolve();
      await running;
      expect(vi.getTimerCount()).to.equal(0);
    } finally {
      intervals.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should draw the rows still and start no timer under a motion preference', async () => {
    vi.useFakeTimers();
    try {
      const ui = screenSetup();
      const gate = deferred();

      const running = tasks(
        [
          { task: () => gate.promise, title: 'One' },
          { task: () => gate.promise, title: 'Two' },
        ],
        { ansi: ui.ansi, concurrency: 2, reducedMotion: 'reduce', terminal: ui.terminal }
      );
      await vi.advanceTimersByTimeAsync(200);

      expect(vi.getTimerCount()).to.equal(0);
      expect(ui.log).to.deep.equal(['One', 'Two']);
      gate.resolve();
      await running;
      expect(ui.log).to.deep.equal(['✔ One', '✔ Two']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should cut the running rows that do not fit the screen, and say how many', async () => {
    const ui = screenSetup({ rows: 5 });
    const gate = deferred();

    const running = tasks(
      Array.from({ length: 10 }, (_, i) => ({ task: () => gate.promise, title: `Task ${i + 1}` })),
      { ansi: ui.ansi, concurrency: 10, frames: ['*'], terminal: ui.terminal }
    );
    await tick();

    expect(ui.log).to.deep.equal(['* Task 1', '* Task 2', '* Task 3', '… 7 more running']);
    gate.resolve();
    await running;
    expect(ui.log).to.have.length(10);
  });

  it.each([0, -1, 1.5, Number.NaN])('should refuse a concurrency of %s', async (concurrency) => {
    const ui = screenSetup();
    let ran = false;

    await expect(
      tasks([{ task: () => void (ran = true), title: 'One' }], {
        ansi: ui.ansi,
        concurrency,
        terminal: ui.terminal,
      })
    ).rejects.toThrow(TypeError);

    expect(ran).to.equal(false);
    expect(ui.output).to.equal('');
  });

  describe('when a task fails', () => {
    it('should start nothing new, cancel what is running, and rethrow the first error', async () => {
      const ui = screenSetup();
      const boom = new Error('no network');
      let third = false;
      let aborted = false;

      await expect(
        tasks(
          [
            {
              async task() {
                await tick();
                throw boom;
              },
              title: 'Fetch react',
            },
            {
              task: ({ signal }) =>
                new Promise<void>((_resolve, reject) => {
                  signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(signal.reason);
                  });
                }),
              title: 'Fetch vite',
            },
            { task: () => void (third = true), title: 'Fetch esbuild' },
          ],
          { ansi: ui.ansi, concurrency: 2, terminal: ui.terminal }
        )
      ).rejects.toBe(boom);

      expect(aborted).to.equal(true);
      expect(third).to.equal(false);
      expect(ui.log).to.deep.equal(['✖ Fetch react', 'ℹ Fetch vite (cancelled)']);
    });

    it('should wait for a running task that ignores the signal, and keep how it ended', async () => {
      const ui = screenSetup();
      const slow = deferred();
      let settled = false;

      const running = tasks(
        [
          {
            task: () => Promise.reject(new Error('x')),
            title: 'Fails',
          },
          {
            async task() {
              await slow.promise;
              return 'Finished anyway';
            },
            title: 'Slow',
          },
        ],
        { ansi: ui.ansi, concurrency: 2, terminal: ui.terminal }
      ).catch((error: unknown) => {
        settled = true;
        throw error;
      });
      await tick();

      expect(settled).to.equal(false);
      slow.resolve();
      await expect(running).rejects.toThrow('x');
      expect(ui.log).to.deep.equal(['✖ Fails', '✔ Finished anyway']);
    });

    it('should run every task with failFast off and reject with each failure in list order', async () => {
      const ui = screenSetup();
      const late = new Error('late');
      const early = new Error('early');
      let ran = 0;

      const error: unknown = await tasks(
        [
          {
            async task() {
              await tick(2);
              throw late;
            },
            title: 'One',
          },
          { task: () => void ran++, title: 'Two' },
          {
            task: () => {
              throw early;
            },
            title: 'Three',
          },
          { task: () => void ran++, title: 'Four' },
        ],
        { ansi: ui.ansi, concurrency: 2, failFast: false, terminal: ui.terminal }
      ).catch((caught: unknown) => caught);

      expect(error).to.be.instanceOf(AggregateError);
      expect((error as AggregateError).errors).to.deep.equal([late, early]);
      expect((error as AggregateError).message).to.equal('2 tasks failed');
      expect(ran).to.equal(2);
      expect([...ui.log].sort()).to.deep.equal(['✔ Four', '✔ Two', '✖ One', '✖ Three']);
    });

    it('should carry the one failure message when failFast is off and one task failed', async () => {
      const ui = screenSetup();

      const error: unknown = await tasks(
        [
          { task: () => Promise.reject(new Error('disk full')), title: 'One' },
          { task: () => {}, title: 'Two' },
        ],
        { ansi: ui.ansi, failFast: false, terminal: ui.terminal }
      ).catch((caught: unknown) => caught);

      expect(error).to.be.instanceOf(AggregateError);
      expect((error as AggregateError).message).to.equal('disk full');
      expect(ui.log).to.deep.equal(['✖ One', '✔ Two']);
    });

    it('should write all of a failed window under its line and collapse the other', async () => {
      const ui = screenSetup({ rows: 16 });
      const gate = deferred();

      await expect(
        tasks(
          [
            {
              async task({ log }) {
                const window = log({ limit: 2 });
                for (const line of lines(4)) {
                  window.message(line);
                }
                await gate.promise;
                throw new Error('exit 1');
              },
              title: 'Build',
            },
            {
              async task({ log }) {
                log({ limit: 2 }).message('linting');
                await tick();
                gate.resolve();
              },
              title: 'Lint',
            },
          ],
          { ansi: ui.ansi, concurrency: 2, terminal: ui.terminal }
        )
      ).rejects.toThrow('exit 1');

      expect(ui.log).to.deep.equal(['✔ Lint', '✖ Build', ...lines(4).map((line) => `  ${line}`)]);
    });
  });

  describe('when there is no terminal', () => {
    it('should label a line of output with its task where tasks run side by side', async () => {
      const { stdout, terminal } = setup({ isTTY: false });
      const a = deferred();
      const b = deferred();

      const running = tasks(
        [
          {
            async task({ log }) {
              log().message('resolving');
              b.resolve();
              await a.promise;
              log().message('done');
            },
            title: 'Fetch react',
          },
          {
            async task({ log }) {
              await b.promise;
              log().message('resolving');
              a.resolve();
            },
            title: 'Fetch vite',
          },
        ],
        { concurrency: 2, terminal }
      );
      await running;

      expect(stdout.output).to.equal(
        [
          'Fetch react',
          'Fetch react: resolving',
          'Fetch vite',
          'Fetch vite: resolving',
          'Fetch react: done',
          '✔ Fetch vite',
          '✔ Fetch react',
          '',
        ].join('\n')
      );
    });

    it('should leave a line of output alone where only one task runs at a time', async () => {
      const { stdout, terminal } = setup({ isTTY: false });

      await tasks(
        [
          { task: ({ log }) => log().message('one'), title: 'First' },
          { task: ({ log }) => log().message('two'), title: 'Second' },
        ],
        { concurrency: 4, terminal: terminal }
      ).then(() =>
        tasks([{ task: ({ log }) => log().message('three'), title: 'Third' }], {
          concurrency: 4,
          terminal,
        })
      );

      expect(stdout.output).to.contain('First: one\n');
      expect(stdout.output).to.contain('Third\nthree\n✔ Third\n');
    });
  });
});

describe('tasks() with subtasks', () => {
  it('should draw subtasks one level in, under their parent', async () => {
    const ui = screenSetup();
    const gate = deferred();

    const running = tasks(
      [
        {
          task: ({ tasks: sub }) =>
            sub(
              [
                { task: () => gate.promise, title: 'react' },
                { task: () => gate.promise, title: 'vite' },
              ],
              { concurrency: 2 }
            ),
          title: 'Install',
        },
      ],
      { ansi: ui.ansi, frames: ['*'], terminal: ui.terminal }
    );
    await tick();

    expect(ui.log).to.deep.equal(['* Install', '  * react', '  * vite']);
    gate.resolve();
    await running;
  });

  it('should keep a settled subtask under its parent until the parent settles', async () => {
    const ui = screenSetup();
    const gate = deferred();

    const running = tasks(
      [
        {
          task: ({ tasks: sub }) =>
            sub([
              { task: () => 'react 19', title: 'react' },
              { task: () => gate.promise, title: 'vite' },
            ]),
          title: 'Install',
        },
      ],
      { ansi: ui.ansi, frames: ['*'], terminal: ui.terminal }
    );
    await tick();

    expect(ui.log).to.deep.equal(['* Install', '  ✔ react 19', '  * vite']);
    gate.resolve();
    await running;
  });

  it('should collapse a parent that succeeds to its one line', async () => {
    const ui = screenSetup();

    const results = await tasks(
      [
        {
          async task({ tasks: sub }) {
            const done = await sub([
              { task: () => {}, title: 'react' },
              { task: () => skip('cached'), title: 'vite' },
            ]);
            return `Installed ${done.length} packages`;
          },
          title: 'Install',
        },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(ui.log).to.deep.equal(['✔ Installed 2 packages']);
    expect(results[0]?.outcome).to.equal('success');
  });

  it('should fail the parent with a failed subtask and keep every subtask on screen', async () => {
    const ui = screenSetup();
    const boom = new Error('404');

    await expect(
      tasks(
        [
          {
            task: ({ tasks: sub }) =>
              sub([
                { task: () => {}, title: 'react' },
                {
                  task: () => {
                    throw boom;
                  },
                  title: 'left-pad',
                },
                { task: () => {}, title: 'never' },
              ]),
            title: 'Install',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      )
    ).rejects.toBe(boom);

    expect(ui.log).to.deep.equal(['✖ Install', '  ✔ react', '  ✖ left-pad']);
  });

  it('should let a parent that catches its subtasks failure decide its own outcome', async () => {
    const ui = screenSetup();

    await tasks(
      [
        {
          async task({ tasks: sub }) {
            try {
              await sub([{ task: () => Promise.reject(new Error('x')), title: 'optional' }]);
            } catch {
              return 'Installed without the optional one';
            }
          },
          title: 'Install',
        },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(ui.log).to.deep.equal(['✔ Installed without the optional one']);
  });

  it('should nest as deep as the tasks do', async () => {
    const ui = screenSetup({ rows: 12 });

    await expect(
      tasks(
        [
          {
            task: ({ tasks: one }) =>
              one([
                {
                  task: ({ tasks: two }) =>
                    two([{ task: () => Promise.reject(new Error('deep')), title: 'Leaf' }]),
                  title: 'Branch',
                },
              ]),
            title: 'Root',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      )
    ).rejects.toThrow('deep');

    expect(ui.log).to.deep.equal(['✖ Root', '  ✖ Branch', '    ✖ Leaf']);
  });

  it('should cancel a running parent subtasks when a sibling of the parent fails', async () => {
    const ui = screenSetup();
    let aborted = false;

    await expect(
      tasks(
        [
          {
            task: ({ tasks: sub }) =>
              sub([
                {
                  task: ({ signal }) =>
                    new Promise<void>((_resolve, reject) => {
                      signal.addEventListener('abort', () => {
                        aborted = true;
                        reject(signal.reason);
                      });
                    }),
                  title: 'download',
                },
              ]),
            title: 'Install',
          },
          {
            async task() {
              await tick();
              throw new Error('lockfile is stale');
            },
            title: 'Verify',
          },
        ],
        { ansi: ui.ansi, concurrency: 2, terminal: ui.terminal }
      )
    ).rejects.toThrow('lockfile is stale');

    expect(aborted).to.equal(true);
    expect(ui.log).to.deep.equal(['✖ Verify', 'ℹ Install (cancelled)']);
  });

  // the results are filled by index, so a cancelled subtask before one that
  // succeeded left a gap that did not shorten them, and read as every one run
  it('should cancel the parent when a subtask is cancelled and the one listed after it succeeded', async () => {
    const ui = screenSetup();
    let continued = false;

    await expect(
      tasks(
        [
          {
            async task({ tasks: sub }) {
              await sub(
                [
                  {
                    task: ({ signal }) =>
                      new Promise<void>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason));
                      }),
                    title: 'download',
                  },
                  { task: () => undefined, title: 'link' },
                ],
                { concurrency: 2 }
              );
              continued = true;
            },
            title: 'Install',
          },
          {
            async task() {
              await tick();
              throw new Error('lockfile is stale');
            },
            title: 'Verify',
          },
        ],
        { ansi: ui.ansi, concurrency: 2, terminal: ui.terminal }
      )
    ).rejects.toThrow('lockfile is stale');

    expect(continued).to.equal(false);
    expect(ui.log).to.deep.equal(['✖ Verify', 'ℹ Install (cancelled)']);
  });

  it('should indent subtasks in a pipe and write the parent last', async () => {
    const { stdout, terminal } = setup({ isTTY: false });

    await tasks(
      [
        {
          task: ({ tasks: sub }) =>
            sub([{ task: ({ log }) => log().message('ok'), title: 'react' }]),
          title: 'Install',
        },
      ],
      { terminal }
    );

    expect(stdout.output).to.equal('Install\n  react\n  ok\n  ✔ react\n✔ Install\n');
  });

  it('should name the parent of a subtask in a pipe where lines interleave, and not indent it', async () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const gate = deferred();

    await tasks(
      [
        {
          task: ({ tasks: sub }) =>
            sub([
              {
                async task({ log }) {
                  await gate.promise;
                  log().message('200 OK');
                },
                title: 'react',
              },
            ]),
          title: 'Install',
        },
        { task: () => gate.resolve(), title: 'Lint' },
      ],
      { concurrency: 2, terminal }
    );

    expect(stdout.output).to.equal(
      [
        'Install',
        'Install: react',
        'Lint',
        'Install: react: 200 OK',
        '✔ Lint',
        '✔ Install: react',
        '✔ Install',
        '',
      ].join('\n')
    );
  });
});

describe('tasks() with retries', () => {
  it('should run a failing task again, saying which retry it is on', async () => {
    const ui = screenSetup();
    const seen: string[] = [];
    let attempts = 0;

    const results = await tasks(
      [
        {
          async task() {
            attempts++;
            seen.push(ui.frame);
            if (attempts < 3) {
              throw new Error('flaky');
            }
            return 'Fetched';
          },
          retry: 2,
          title: 'Fetch',
        },
      ],
      { ansi: ui.ansi, frames: ['*'], terminal: ui.terminal }
    );

    expect(attempts).to.equal(3);
    expect(seen).to.deep.equal(['* Fetch', '* Fetch (retry 1 of 2)', '* Fetch (retry 2 of 2)']);
    expect(ui.log).to.deep.equal(['✔ Fetched']);
    expect(results[0]?.outcome).to.equal('success');
  });

  it('should fail with the last error once the retries are spent', async () => {
    const ui = screenSetup();
    let attempts = 0;

    await expect(
      tasks(
        [
          {
            task: () => {
              attempts++;
              throw new Error(`attempt ${attempts}`);
            },
            retry: 1,
            title: 'Fetch',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      )
    ).rejects.toThrow('attempt 2');

    expect(ui.log).to.deep.equal(['✖ Fetch']);
  });

  it('should wait the delay between attempts', async () => {
    vi.useFakeTimers();
    try {
      const ui = screenSetup();
      let attempts = 0;

      const running = tasks(
        [
          {
            task: () => {
              attempts++;
              if (attempts === 1) {
                throw new Error('flaky');
              }
            },
            retry: { delay: 1000, tries: 1 },
            title: 'Fetch',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).to.equal(1);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(attempts).to.equal(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should keep only the last attempt output when a retried task fails', async () => {
    const ui = screenSetup({ rows: 12 });
    let attempts = 0;

    await expect(
      tasks(
        [
          {
            task({ log }) {
              attempts++;
              log().message(`output of attempt ${attempts}`);
              throw new Error('exit 1');
            },
            retry: 1,
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      )
    ).rejects.toThrow('exit 1');

    expect(ui.log).to.deep.equal(['✖ Build', '  output of attempt 2']);
  });

  it('should not show a failed attempt output under a later attempt that printed none', async () => {
    const ui = screenSetup({ rows: 12 });
    let attempts = 0;

    await expect(
      tasks(
        [
          {
            task({ log }) {
              if (++attempts === 1) {
                log().message('output of attempt 1');
              }
              throw new Error('exit 1');
            },
            retry: 1,
            title: 'Build',
          },
        ],
        { ansi: ui.ansi, terminal: ui.terminal }
      )
    ).rejects.toThrow('exit 1');

    expect(ui.log).to.deep.equal(['✖ Build']);
  });

  it('should not retry a task that skipped', async () => {
    const ui = screenSetup();
    let attempts = 0;

    await tasks(
      [
        {
          task: () => {
            attempts++;
            return skip('cached');
          },
          retry: 3,
          title: 'Build',
        },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(attempts).to.equal(1);
  });

  it('should write a line for each retry in a pipe', async () => {
    const { stdout, terminal } = setup({ isTTY: false });
    let attempts = 0;

    await tasks(
      [
        {
          task: () => {
            if (++attempts === 1) {
              throw new Error('flaky');
            }
          },
          retry: 1,
          title: 'Fetch',
        },
      ],
      { terminal }
    );

    expect(stdout.output).to.equal('Fetch\nFetch (retry 1 of 1)\n✔ Fetch\n');
  });

  it.each([-1, 1.5, Number.NaN])('should refuse a retry of %s', async (retry) => {
    await expect(
      tasks([{ retry, task: () => {}, title: 'One' }], { terminal: setup().terminal })
    ).rejects.toThrow(TypeError);
  });
});

describe('tasks() when asked to be quiet', () => {
  it('should draw nothing for tasks side by side or nested, and still rethrow', async () => {
    const { stdout, terminal } = setup({ isTTY: true });
    let ran = 0;

    await expect(
      tasks(
        [
          {
            task: ({ tasks: sub }) =>
              sub([{ task: ({ log }) => void log().message(String(++ran)), title: 'a' }]),
            title: 'One',
          },
          {
            task: () => {
              ran++;
              throw new Error('x');
            },
            title: 'Two',
          },
        ],
        { concurrency: 2, quiet: true, terminal }
      )
    ).rejects.toThrow('x');

    expect(ran).to.equal(2);
    expect(stdout.output).to.equal('');
  });
});

describe('a task line set from an effect', () => {
  it('should not re-run the effect when the line is changed from outside', async () => {
    const ui = screenSetup({ rows: 12 });
    let runs = 0;

    await tasks(
      [
        {
          task: (ctx) => {
            runs = runsOf(
              () => ctx.message('one'),
              () => ctx.message('two')
            );
          },
          title: 'Build',
        },
      ],
      { ansi: ui.ansi, terminal: ui.terminal }
    );

    expect(runs).toBe(2);
  });
});
