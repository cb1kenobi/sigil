import {
  cancel,
  group,
  type GroupStep,
  intro,
  isBack,
  isCancel,
  outro,
} from '../../src/components/group.js';
import {
  confirm,
  ESCAPE_TIMEOUT,
  PromptBack,
  PromptError,
  select,
  text,
} from '../../src/components/prompt.js';
import { setQuiet } from '../../src/style/index.js';
import { createTerminal, type InputStream, type OutputStream } from '../../src/terminal/index.js';
import { createInput, createStream, screenSetup, tick } from './helpers.js';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const ENTER = '\r';
const CTRL_C = '\u0003';
const ESC = '\u001b';

/** A prompt that was cancelled, as `runPrompt()` rejects it. */
function cancelled(): Promise<never> {
  return Promise.reject(new PromptError('Cancelled', true));
}

/**
 * A step that answers from a script, one entry per time it is asked: a value to
 * answer with, or `BACK` to go back. It records what it was handed each time.
 */
const BACK = Symbol('back');
function scripted<V>(script: (V | typeof BACK)[], seen: unknown[][] = []) {
  let asked = 0;
  const step = async (answers: object, handed: GroupStep<V>): Promise<V> => {
    seen.push([{ ...answers }, { ...handed }]);
    const next = script[asked++];
    if (next === BACK) {
      throw new PromptBack();
    }
    if (next === undefined) {
      throw new Error('asked more often than scripted');
    }
    return next;
  };
  return { seen, step };
}

describe('isBack()', () => {
  it('should be true for a PromptBack and nothing else', () => {
    expect(isBack(new PromptBack())).toBe(true);
    expect(isBack(new PromptError('Cancelled', true))).toBe(false);
    expect(isBack(new Error('Went back'))).toBe(false);
    expect(isBack(undefined)).toBe(false);
  });

  it('should not be a cancel', () => {
    // a person going back has not left, and a catch for leaving must not fire
    expect(isCancel(new PromptBack())).toBe(false);
  });
});

describe('isCancel()', () => {
  it('should be true for a person pressing Ctrl-C', () => {
    expect(isCancel(new PromptError('Cancelled', true))).toBe(true);
  });

  it('should be false for a prompt reached where nobody can answer it', () => {
    // the program is wired wrong, which is not somebody leaving
    expect(isCancel(new PromptError('not a terminal'))).toBe(false);
  });

  it('should be false for anything that is not a PromptError', () => {
    expect(isCancel(new Error('Cancelled'))).toBe(false);
    expect(isCancel({ aborted: true })).toBe(false);
    expect(isCancel('Cancelled')).toBe(false);
    expect(isCancel(undefined)).toBe(false);
  });
});

describe('group()', () => {
  it('should run the steps in key order and answer by key', async () => {
    const order: string[] = [];
    const answers = await group({
      a: async () => (order.push('a'), 1),
      b: async () => (order.push('b'), 'two'),
      c: async () => (order.push('c'), true),
    });

    expect(order).to.deep.equal(['a', 'b', 'c']);
    expect(answers).to.deep.equal({ a: 1, b: 'two', c: true });
  });

  it('should hand a step the answers of the steps before it', async () => {
    const seen: unknown[] = [];
    await group({
      name: async () => 'ada',
      greeting: async ({ name }) => {
        seen.push(name);
        return `hello ${name}`;
      },
      last: async (answers) => {
        seen.push({ ...answers });
        return 0;
      },
    });

    expect(seen).to.deep.equal(['ada', { name: 'ada', greeting: 'hello ada' }]);
  });

  it('should not show a step the answers of the steps after it', async () => {
    let first: unknown;
    await group({
      one: async (answers) => ((first = { ...answers }), 1),
      two: async () => 2,
    });

    expect(first).to.deep.equal({});
  });

  it('should not let a step change an answer a later step reads', async () => {
    let later: unknown;
    await group({
      a: async () => 1,
      b: async (answers) => {
        (answers as { a: number }).a = 99;
        return 2;
      },
      c: async (answers) => ((later = answers.a), 3),
    });

    expect(later).toBe(1);
  });

  it('should keep a key called __proto__ as an answer', async () => {
    const answers = await group({
      ['__proto__']: async () => 'x',
    } as unknown as { __proto__: () => Promise<string> });

    expect(Object.keys(answers)).to.deep.equal(['__proto__']);
    expect(Object.getPrototypeOf(answers)).to.equal(Object.prototype);
  });

  it('should take a step that is not async', async () => {
    expect(await group({ a: () => 1, b: ({ a }) => (a ?? 0) + 1 })).to.deep.equal({ a: 1, b: 2 });
  });

  it('should refuse a step that is not a function', async () => {
    await expect(group({ a: 1 } as never)).rejects.toThrow('step "a" must be a function');
  });

  it('should answer an empty group with an empty object', async () => {
    expect(await group({})).to.deep.equal({});
  });

  describe('cancelling', () => {
    it('should call onCancel with what was answered so far, and rethrow the error', async () => {
      const onCancel = vi.fn();
      const error = new PromptError('Cancelled', true);
      const later = vi.fn();

      const result = group(
        {
          a: async () => 'one',
          b: () => Promise.reject(error),
          c: later,
        },
        { onCancel }
      );

      await expect(result).rejects.toBe(error);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onCancel).toHaveBeenCalledWith({ a: 'one' }, error);
      expect(later).not.toHaveBeenCalled();
    });

    it('should rethrow the PromptError when there is no onCancel', async () => {
      const result = group({ a: cancelled });
      await expect(result).rejects.toSatisfy(isCancel);
    });

    it('should let onCancel replace the error by throwing', async () => {
      const result = group(
        { a: cancelled },
        {
          onCancel: () => {
            throw new Error('bye');
          },
        }
      );

      await expect(result).rejects.toThrow('bye');
    });

    it('should let onCancel replace the error by returning one', async () => {
      const result = group({ a: cancelled }, { onCancel: () => new RangeError('replaced') });
      await expect(result).rejects.toThrow(RangeError);
    });

    it('should wait for an onCancel that is async', async () => {
      const order: string[] = [];
      const result = group(
        { a: cancelled },
        {
          onCancel: async () => {
            await tick();
            order.push('onCancel');
          },
        }
      );

      await result.catch(() => order.push('rejected'));
      expect(order).to.deep.equal(['onCancel', 'rejected']);
    });

    it('should not swallow the cancel when onCancel returns something that is not an error', async () => {
      const result = group({ a: cancelled }, { onCancel: () => 'ignored' as never });
      await expect(result).rejects.toSatisfy(isCancel);
    });

    it('should leave a bug in a step alone and not call onCancel', async () => {
      const onCancel = vi.fn();
      const bug = new TypeError('oops');

      await expect(group({ a: () => Promise.reject(bug) }, { onCancel })).rejects.toBe(bug);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('should not call onCancel for a prompt with nobody to answer it', async () => {
      const onCancel = vi.fn();
      const error = new PromptError('not a terminal');

      await expect(group({ a: () => Promise.reject(error) }, { onCancel })).rejects.toBe(error);
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe('going back', () => {
    it('should hand back only to steps after the first', async () => {
      const a = scripted(['one']);
      const b = scripted(['two']);
      await group({ a: a.step, b: b.step });

      expect(a.seen).to.deep.equal([[{}, {}]]);
      expect(b.seen).to.deep.equal([[{ a: 'one' }, { back: true }]]);
    });

    it('should ask the step before again with its earlier answer as the value', async () => {
      const a = scripted(['one', 'uno']);
      const b = scripted([BACK, 'two']);

      expect(await group({ a: a.step, b: b.step })).to.deep.equal({ a: 'uno', b: 'two' });
      expect(a.seen).to.deep.equal([
        [{}, {}],
        [{}, { value: 'one' }],
      ]);
    });

    it('should ask every step after the one gone back to again, and skip none', async () => {
      // the dependent-answer rule: going back from c to a, then forward again,
      // asks b again even though b was answered -- b may read a, which changed
      const a = scripted(['npm', 'pnpm']);
      const b = scripted(['ci', BACK, 'install']);
      const c = scripted([BACK, 'yes']);

      const answers = await group({ a: a.step, b: b.step, c: c.step });

      expect(answers).to.deep.equal({ a: 'pnpm', b: 'install', c: 'yes' });
      expect(b.seen).to.deep.equal([
        [{ a: 'npm' }, { back: true }],
        [{ a: 'npm' }, { back: true, value: 'ci' }],
        [{ a: 'pnpm' }, { back: true, value: 'ci' }],
      ]);
    });

    it('should not show a re-asked step an answer from after it', async () => {
      // d goes back to c, c goes back to b: what c answered is c's to be shown
      // again, not b's to read as an answer -- it was given under a b that is
      // being changed
      const a = scripted(['one']);
      const b = scripted(['two', 'deux']);
      const c = scripted(['three', BACK, 'trois']);
      const d = scripted([BACK, 'four']);

      expect(await group({ a: a.step, b: b.step, c: c.step, d: d.step })).to.deep.equal({
        a: 'one',
        b: 'deux',
        c: 'trois',
        d: 'four',
      });
      expect(b.seen.at(-1)).to.deep.equal([{ a: 'one' }, { back: true, value: 'two' }]);
      expect(c.seen.at(-1)).to.deep.equal([
        { a: 'one', b: 'deux' },
        { back: true, value: 'three' },
      ]);
      // never answered, so there is nothing to show it when it is asked again
      expect(d.seen.at(-1)).to.deep.equal([{ a: 'one', b: 'deux', c: 'trois' }, { back: true }]);
    });

    it('should leave out a value the step never gave, so a spread keeps its own', async () => {
      const a = scripted(['one']);
      let handed: unknown;
      await group({
        a: a.step,
        b: (_answers, step) => {
          handed = { value: 'suggested', ...step };
          return 'b';
        },
      });

      expect(handed).to.deep.equal({ back: true, value: 'suggested' });
    });

    it('should hand a frozen step, so a step cannot change what the next one is handed', async () => {
      let frozen = false;
      await group({ a: (_answers, step) => ((frozen = Object.isFrozen(step)), 1) });
      expect(frozen).toBe(true);
    });

    it('should rethrow a PromptBack from the first step, where there is nothing to go back to', async () => {
      const onCancel = vi.fn();
      const error = new PromptBack();

      await expect(group({ a: () => Promise.reject(error) }, { onCancel })).rejects.toBe(error);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('should call onCancel with the answers that stand after a back', async () => {
      const onCancel = vi.fn();
      const a = scripted(['one', 'uno']);
      let asked = 0;

      const result = group(
        {
          a: a.step,
          b: () =>
            Promise.reject(asked++ === 0 ? new PromptBack() : new PromptError('Cancelled', true)),
        },
        { onCancel }
      );

      await expect(result).rejects.toSatisfy(isCancel);
      expect(onCancel).toHaveBeenCalledWith({ a: 'uno' }, expect.any(PromptError));
    });
  });

  describe('with real prompts', () => {
    it('should carry an answer into the next prompt and finish', async () => {
      const ui = screenSetup({ columns: 60 });
      const opts = { ansi: ui.ansi, terminal: ui.terminal };

      const result = group({
        name: () => text({ ...opts, message: 'Name?' }),
        sure: ({ name }) => confirm({ ...opts, message: `Sure, ${name}?` }),
      });

      await tick();
      for (const key of ['a', 'd', 'a', ENTER]) {
        ui.stdin.send(key);
        await tick();
      }
      expect(ui.log.join('\n')).to.contain('Sure, ada?');

      ui.stdin.send('y');
      await tick();
      expect(await result).to.deep.equal({ name: 'ada', sure: true });
    });

    it('should hand onCancel the partial answers when Ctrl-C is pressed', async () => {
      const ui = screenSetup({ columns: 60 });
      const opts = { ansi: ui.ansi, terminal: ui.terminal };
      const onCancel = vi.fn();

      const result = group(
        {
          name: () => text({ ...opts, message: 'Name?' }),
          sure: () => confirm({ ...opts, message: 'Sure?' }),
        },
        { onCancel }
      ).catch((error: unknown) => error);

      await tick();
      for (const key of ['a', ENTER, CTRL_C]) {
        ui.stdin.send(key);
        await tick();
      }

      expect(isCancel(await result)).toBe(true);
      expect(onCancel).toHaveBeenCalledWith({ name: 'a' }, expect.any(PromptError));
    });

    it('should go back a step on Escape and show the earlier answer there', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const ui = screenSetup({ columns: 60, rows: 12 });
        const opts = { ansi: ui.ansi, terminal: ui.terminal };

        const result = group<{ name: string; ok: boolean; pm: string }>({
          name: (_answers, step) => text({ ...opts, message: 'Name?', ...step }),
          pm: ({ name }, step) =>
            select({
              ...opts,
              choices: ['npm', 'pnpm', 'yarn'],
              message: `Package manager for ${name}?`,
              ...step,
            }),
          ok: (_answers, step) => confirm({ ...opts, message: 'Create it?', ...step }),
        });

        const send = async (...keys: string[]): Promise<void> => {
          for (const key of keys) {
            ui.stdin.send(key);
            await vi.advanceTimersByTimeAsync(ESCAPE_TIMEOUT);
            await tick();
          }
        };

        await tick();
        await send('a', 'd', 'a', ENTER, '\u001b[B', '\u001b[B', ENTER);
        expect(ui.log.at(-1)).to.contain('Create it?');

        // back to the list, which opens on what was picked
        await send(ESC);
        expect(ui.log.join('\n')).not.to.contain('Create it?');
        expect(ui.log.find((row) => row.includes('❯'))).to.contain('yarn');

        // and back again to the name, which comes back holding what was typed
        await send(ESC);
        expect(ui.log.at(-1)).to.contain('? Name? ada');

        // an edit, and forward again: the list is asked again rather than
        // skipped, under the new name, still opening on the earlier answer
        await send('m', ENTER);
        expect(ui.log.join('\n')).to.contain('Package manager for adam?');
        await send(ENTER, 'y');

        expect(await result).to.deep.equal({ name: 'adam', ok: true, pm: 'yarn' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('types', () => {
    it('should type the answers by key', () => {
      const run = () =>
        group({
          name: async () => 'ada',
          age: async () => 36,
          ok: async () => true,
        });

      expectTypeOf(run).returns.resolves.toEqualTypeOf<{
        name: string;
        age: number;
        ok: boolean;
      }>();
    });

    it('should type an earlier answer in a later step when the shape is named', () => {
      interface Shape {
        count: number;
        label: string;
      }

      const run = () =>
        group<Shape>({
          count: async () => 3,
          label: async ({ count }) => {
            expectTypeOf(count).toEqualTypeOf<number | undefined>();
            return `${count ?? 0} items`;
          },
        });

      expectTypeOf(run).returns.resolves.toEqualTypeOf<Shape>();
    });

    it('should check each step against the shape that was named', () => {
      group<{ a: number }>({
        // @ts-expect-error -- a is a number
        a: async () => 'x',
      });
    });

    it('should not offer a step its own answer', () => {
      group({
        // @ts-expect-error -- a step cannot read the answer it is producing
        a: async ({ a }) => a,
      });
    });

    it('should type the partial handed to onCancel', () => {
      const run = () =>
        group(
          { n: async () => 1, s: async () => 'x' },
          {
            onCancel: (partial) => {
              expectTypeOf(partial).toEqualTypeOf<Partial<{ n: number; s: string }>>();
            },
          }
        );

      expectTypeOf(run).returns.resolves.toEqualTypeOf<{ n: number; s: string }>();
    });

    it('should type what a step is handed as its own answer', () => {
      group<{ count: number; tags: string[] }>({
        count: (_answers, step) => {
          expectTypeOf(step).toEqualTypeOf<GroupStep<number>>();
          expectTypeOf(step.value).toEqualTypeOf<number | undefined>();
          return 1;
        },
        tags: (_answers, step) => {
          expectTypeOf(step.value).toEqualTypeOf<string[] | undefined>();
          return [];
        },
      });
    });

    it('should type a union answer from a step that can answer two ways', () => {
      const run = () => group({ pick: async (): Promise<'a' | 'b'> => 'a' });
      expectTypeOf(run).returns.resolves.toEqualTypeOf<{ pick: 'a' | 'b' }>();
    });
  });
});

/** A terminal whose stdout and stderr are different streams, so the split is observable. */
function split(opts: { columns?: number; errTTY?: boolean; outTTY?: boolean } = {}) {
  const stdout = createStream({ columns: opts.columns ?? 40, isTTY: opts.outTTY ?? true });
  const stderr = createStream({ columns: opts.columns ?? 40, isTTY: opts.errTTY ?? true });
  const stdin = createInput();
  const terminal = createTerminal({
    env: {},
    isTTY: opts.outTTY ?? true,
    proc: { listenerCount: () => 0, on: () => {}, removeListener: () => {} },
    stderr: stderr as unknown as OutputStream,
    stdin: stdin as unknown as InputStream,
    stdout: stdout as unknown as OutputStream,
  });
  return { stderr, stdout, terminal };
}

describe('intro(), outro() and cancel()', () => {
  afterEach(() => {
    setQuiet(undefined);
  });

  it('should write each to stderr and nothing to stdout', () => {
    const { stderr, stdout, terminal } = split();

    intro('create-app', { colorLevel: 0, terminal });
    outro('All done', { colorLevel: 0, terminal });
    cancel('Stopped', { colorLevel: 0, terminal });

    expect(stderr.text).to.equal('▶ create-app\n✔ All done\n✖ Stopped\n');
    expect(stdout.written).to.deep.equal([]);
  });

  it('should say Cancelled when cancel() is given no message', () => {
    const { stderr, terminal } = split();
    cancel(undefined, { colorLevel: 0, terminal });
    expect(stderr.text).to.equal('✖ Cancelled\n');
  });

  it('should write nothing when stdout is not a terminal', () => {
    const { stderr, terminal } = split({ outTTY: false });
    intro('x', { terminal });
    outro('x', { terminal });
    cancel('x', { terminal });
    expect(stderr.written).to.deep.equal([]);
  });

  it('should write nothing when stderr is not a terminal', () => {
    // `mycli 2>log` must not get a frame in the log
    const { stderr, terminal } = split({ errTTY: false });
    intro('x', { terminal });
    expect(stderr.written).to.deep.equal([]);
  });

  it('should write nothing when asked to be quiet', () => {
    const { stderr, terminal } = split();
    intro('x', { quiet: true, terminal });
    outro('x', { quiet: true, terminal });
    cancel('x', { quiet: true, terminal });
    expect(stderr.written).to.deep.equal([]);
  });

  it('should write nothing under the process-wide --quiet request', () => {
    const { stderr, terminal } = split();
    setQuiet(true);
    intro('x', { terminal });
    expect(stderr.written).to.deep.equal([]);

    setQuiet(false);
    intro('x', { colorLevel: 0, terminal });
    expect(stderr.text).to.equal('▶ x\n');
  });

  it('should draw in the framework roles', () => {
    const { stderr, terminal } = split();
    intro('t', { colorLevel: 1, terminal });
    outro('t', { colorLevel: 1, terminal });
    cancel('t', { colorLevel: 1, terminal });

    const [i, o, c] = stderr.output.split('\n');
    expect(i).to.contain(`${ESC}[36m▶`); // accent mark
    expect(i).to.contain(`${ESC}[1;39mt`); // heading message
    expect(o).to.contain(`${ESC}[32m✔`); // success
    expect(c).to.contain(`${ESC}[31m✖`); // error
  });

  it('should let a theme restyle it', () => {
    const { stderr, terminal } = split();
    outro('t', { colorLevel: 1, terminal, theme: '.sigil-success { color: magenta }' });
    expect(stderr.output).to.contain(`${ESC}[35m✔`);
  });

  it('should wrap a long message at the terminal width, under its own mark', () => {
    const { stderr, terminal } = split({ columns: 14 });
    intro('one two three four', { colorLevel: 0, terminal });
    expect(stderr.text.split('\n').filter(Boolean)).to.deep.equal(['▶ one two', '  three four']);
  });

  it('should draw no control character a message holds', () => {
    const { stderr, terminal } = split();
    outro(`a${ESC}[2Jb`, { colorLevel: 0, terminal });
    expect(stderr.output).not.to.contain(`${ESC}[2J`);
  });
});
