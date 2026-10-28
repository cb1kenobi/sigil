import { skip, taskLog, tasks } from '../../src/components/tasks.js';
import { setQuiet } from '../../src/style/output.js';
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
