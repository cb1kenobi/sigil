import { createSpinner } from '../../src/components/spinner.js';
import main from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import { quietRequested, requestQuiet } from '../../src/style/output.js';
import { Internal, type ParseState, type Schema } from '../../src/types.js';
import { setup } from '../components/helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What a settled spinner leaves in a log. */
const DONE = `✔ done\n`;

afterEach(() => {
  requestQuiet(undefined);
});

/** The root context's option registry, which is where the flag lands. */
async function options(schema: Schema, argv: string[] = []) {
  const state = await parse({ argv, schema });
  return { options: state.contexts[0][Internal].options, state };
}

describe('the --quiet flag', () => {
  it('should be added to a schema that did not declare one', async () => {
    const { options: registry } = await options({ name: 'mycli' });
    expect(registry.find('--quiet')).toBeTruthy();
    expect(registry.find('-q')).toBeTruthy();
  });

  it('should set state.quiet when argv asked for it, in either spelling', async () => {
    expect((await parse({ argv: ['--quiet'], schema: {} })).quiet).toBe(true);
    expect((await parse({ argv: ['-q'], schema: {} })).quiet).toBe(true);
  });

  it('should leave state.quiet alone when argv did not', async () => {
    expect((await parse({ argv: [], schema: {} })).quiet).toBeUndefined();
  });

  /**
   * A flag always has a value and this one is not the app's, which is the rule
   * `--help` and `--version` already keep: an app that never declared `--quiet`
   * should not find `quiet: false` on one of its own destinations.
   */
  it('should not put its value on argv', async () => {
    expect((await parse({ argv: [], schema: {} })).argv).toEqual({});
    expect((await parse({ argv: ['--quiet'], schema: {} })).argv).toEqual({});
  });

  /**
   * `detectHelp()`'s own rule: a default or an environment variable can give a
   * flag a value without anybody asking for it, so what counts is argv having
   * turned it on -- and `--quiet=false` is somebody typing it and saying no.
   */
  it('should read a typed no as a no', async () => {
    expect((await parse({ argv: ['--quiet=false'], schema: {} })).quiet).toBeUndefined();
  });

  it('should be described on the help screen', async () => {
    const { options: registry } = await options({ name: 'mycli' });
    expect(registry.find('--quiet')?.desc).toBe('Suppress progress, not results');
  });
});

describe('a declaration', () => {
  it('should keep an app’s own -q, and get the long form alone', async () => {
    const { options: registry } = await options({
      name: 'mycli',
      options: { '-q, --queue [name]': 'The queue' },
    });
    expect(registry.find('-q')?.name).toBe('queue');
    expect(registry.find('--quiet')).toBeTruthy();
    expect(registry.find('--quiet')?.name).toBe('quiet');
  });

  /**
   * An app that declares `--quiet` owns what quiet means, which is the only
   * reading of a declaration that means anything -- so the framework adds
   * nothing, the value is the app's and reaches `argv`, and nothing is recorded
   * process-wide.
   */
  it('should leave an app’s own --quiet entirely alone', async () => {
    const schema: Schema = { name: 'mycli', options: { '--quiet': 'The app own' } };
    const state = await parse({ argv: ['--quiet'], schema });
    expect(state.quiet).toBeUndefined();
    expect(state.argv).toEqual({ quiet: true });
  });

  /**
   * `find()` answers about spellings and `has()` about the key the registry
   * stores an option under: an option spelled `-x` and named `quiet` takes the
   * key without answering to `--quiet`, and adding one there would replace it.
   */
  it('should leave an option merely named quiet alone', async () => {
    const { options: registry } = await options({
      name: 'mycli',
      options: { '-x': { desc: 'The app own', name: 'quiet' } },
    });
    expect(registry.find('--quiet')).toBeFalsy();
    expect(registry.get('quiet')?.format).toBe('-x');
  });

  /**
   * The other half of the two-reader check, and the one a sabotage pass found
   * unpinned: `has()` answers about the registry **key**, which is an option's
   * name, so an option spelled `--quiet` and named something else is invisible
   * to it -- an explicit `name`, which is the one thing that wins over what the
   * format would have named.
   *
   * Left to `has()` alone the framework adds its own over the top, and what that
   * costs is the app's option: `add()` replaces the spelling, so `--quiet` stops
   * reaching `hush` and the app's own declaration is unreachable.
   */
  it('should leave an option spelled --quiet but named otherwise alone', async () => {
    const schema: Schema = {
      name: 'mycli',
      options: { hush: { desc: 'The app own', format: '--quiet [level]', name: 'hush' } },
    };
    const { options: registry } = await options(schema);
    expect(registry.find('--quiet')?.name).toBe('hush');
    // and no short form either, because the flag was declined entirely
    expect(registry.find('-q')).toBeFalsy();

    // the app's own option is what argv reaches, with its own value
    const state = await parse({ argv: ['--quiet', 'loud'], schema });
    expect(state.quiet).toBeUndefined();
    expect(state.argv).toEqual({ hush: 'loud' });
  });

  it('should add nothing at all when the schema turned it off', async () => {
    const { options: registry, state } = await options({ name: 'mycli', quiet: false }, [
      '--quiet',
    ]);
    expect(registry.find('--quiet')).toBeFalsy();
    expect(registry.find('-q')).toBeFalsy();
    expect(state.quiet).toBeUndefined();
  });
});

describe('repetition and a subcommand', () => {
  /**
   * The one place the three parser-owned flags part company with every valued
   * option here, which is last-wins by destination. It is `--help`'s own rule
   * and is pinned so that it is a decision rather than an accident: changing it
   * for one of the three inside a ticket about that one is how they come to
   * disagree.
   */
  it('should let any typed true win, in either order', async () => {
    expect((await parse({ argv: ['--quiet', '--quiet=false'], schema: {} })).quiet).toBe(true);
    expect((await parse({ argv: ['--quiet=false', '--quiet'], schema: {} })).quiet).toBe(true);
  });

  /**
   * `--no-quiet` is not a negation of this flag: a `no-` twin exists only where
   * one was declared, so it lands on argv as an undeclared option. Worth pinning
   * because it is the spelling somebody reaches for.
   */
  it('should leave --no-quiet as the undeclared option it is', async () => {
    const state = await parse({ argv: ['--no-quiet'], schema: {} });
    expect(state.quiet).toBeUndefined();
    expect(state.argv).toEqual({ noQuiet: true });
  });

  it('should let a subcommand declare its own, which is then the app’s', async () => {
    const schema: Schema = {
      name: 'mycli',
      commands: {
        work: { name: 'work', options: { '--quiet [level]': 'How loud' }, run() {} },
      },
    };
    const state = await parse({ argv: ['work', '--quiet', 'loud'], schema });
    expect(state.quiet).toBeUndefined();
    expect(state.argv.quiet).toBe('loud');
  });

  /**
   * And the shadowing reaches **backwards** over a use typed before the command
   * was named, which is the parser's context rule rather than this flag's: a
   * nearer valued declaration owns the destination a bare root use wrote. Pinned
   * because the docblock's "shadows it for itself alone" does not sound like it.
   */
  it('should let that declaration own a use typed before the command', async () => {
    const schema: Schema = {
      name: 'mycli',
      commands: {
        work: { name: 'work', options: { '--quiet <level>': 'How loud' }, run() {} },
      },
    };
    await expect(parse({ argv: ['--quiet', 'work'], schema })).rejects.toThrow(
      'Missing required options: --quiet'
    );
  });
});

describe('main()', () => {
  /**
   * Nothing is asserted **inside** `run()`, and the sabotage pass is what said
   * so: `main()` renders a throw from a command and resolves, so an assertion
   * there is swallowed -- and then the spinner after it never runs either, which
   * made `output === ''` pass for the wrong reason. So what `run()` does is
   * record, and every claim is made once `main()` has returned.
   *
   * @param argv - What to run.
   * @returns What was written, and what the command saw.
   */
  async function ran(argv: string[]) {
    const { stdout, terminal } = setup({ isTTY: false });
    const seen: (boolean | undefined)[] = [];
    const schema: Schema = {
      name: 'mycli',
      commands: {
        work: {
          name: 'work',
          run(state: ParseState) {
            seen.push(quietRequested());
            createSpinner({ terminal, text: 'working' }).succeed('done');
            return state;
          },
        },
      },
    };

    const before = process.exitCode;
    try {
      await main({ argv, schema });
    } finally {
      // a command that threw sets it, and a green suite reporting a crash is
      // what that leaks into
      process.exitCode = before;
    }
    return { out: stdout.output, seen };
  }

  /**
   * The channel the whole flag rests on. `--quiet` is read while argv is parsed
   * and a spinner is built later inside `run()`, which has no way to pass the
   * answer on to every component it touches -- so `main()` records it, once,
   * and the one fold reads it.
   */
  it('should record the request, so a component nobody wired up honours it', async () => {
    const { out, seen } = await ran(['work', '--quiet']);
    // the command ran, which is what stops an empty stream passing for the
    // wrong reason
    expect(seen).toEqual([true]);
    expect(out).toBe('');
  });

  it('should record nothing for a run that did not ask', async () => {
    const { out, seen } = await ran(['work']);
    expect(seen).toEqual([undefined]);
    expect(out).toBe(DONE);
  });

  /**
   * Set only when argv asked, so a caller who recorded one programmatically is
   * not cleared by a parse that never named the flag. `requestQuiet(undefined)`
   * is the way back, which is what a test does on the way out.
   */
  it('should not clear a request a caller recorded itself', async () => {
    requestQuiet(true);
    await main({ argv: [], schema: { name: 'mycli' } });
    expect(quietRequested()).toBe(true);
  });

  /**
   * And it puts back what it attached, which is the rule every other thing
   * `main()` touches follows. Found by review: a host that calls `main()` twice
   * -- which the command palette's own documented re-entry is -- silenced every
   * run after the first `--quiet`, with nothing in argv to explain why.
   */
  it('should put the request back, so a second run is not the first one’s', async () => {
    const first = await ran(['work', '--quiet']);
    expect(first.seen).toEqual([true]);
    expect(quietRequested()).toBeUndefined();

    const second = await ran(['work']);
    expect(second.seen).toEqual([undefined]);
    expect(second.out).toBe(DONE);
  });

  /**
   * Found by review, in two rounds: the restore first put back the snapshot
   * whatever had happened, which reversed a command's own statement -- and then
   * a *value* test closed only half of it, because comparing `true` to `true`
   * cannot tell "nobody wrote since" from "the command asked for the same
   * thing". So both values are the input here: `false` is the half a value test
   * could see, and **`true` is the half it could not**, which is the dispatcher
   * asking for quiet for what follows.
   */
  it.each([[false], [true]])(
    'should leave a request of %s the command itself made alone',
    async (said) => {
      const schema: Schema = {
        name: 'mycli',
        commands: {
          work: {
            name: 'work',
            run(state: ParseState) {
              requestQuiet(said);
              return state;
            },
          },
        },
      };

      await main({ argv: ['work', '--quiet'], schema });
      expect(quietRequested()).toBe(said);
    }
  );

  /**
   * The leak the restore exists for, reached through the one shape nothing had
   * tried: a **nested** `main()` whose argv also asks. Found by review round 4.
   *
   * A restore spelled as a write moves the token, so the inner run putting the
   * outer's value back made the outer run's own token stale -- and the outer
   * `finally` then declined to clear what it had attached. Both halves are
   * asserted, because the second is the cost: the process stays quiet, and the
   * next run with nothing in argv is silenced by it with nothing to explain why.
   * Three deep as well as two, since a token that rewinds has to unwind a stack
   * rather than one level.
   */
  it.each([[2], [3]])('should put the request back through %i nested runs', async (deep) => {
    const leaf: Schema = { name: 'leaf', commands: { work: { name: 'work', run: () => {} } } };
    let schema = leaf;
    for (let at = 1; at < deep; at++) {
      const inner = schema;
      schema = {
        name: `outer${at}`,
        commands: {
          work: {
            name: 'work',
            async run() {
              await main({ argv: ['work', '--quiet'], schema: inner });
            },
          },
        },
      };
    }

    await main({ argv: ['work', '--quiet'], schema });
    expect(quietRequested()).toBeUndefined();

    // and the run after it, which is what the leak actually costs
    const after = await ran(['work']);
    expect(after.seen).toEqual([undefined]);
    expect(after.out).toBe(DONE);
  });

  it('should put back a request a caller had recorded, rather than clearing it', async () => {
    requestQuiet(true);
    const during = await ran(['work', '--quiet']);
    expect(during.seen).toEqual([true]);
    expect(quietRequested()).toBe(true);
  });

  /**
   * Quiet modulates rather than short-circuiting: help is the answer to the
   * question argv asked, and quiet is about what is said *while working*.
   */
  it('should still print help for --quiet --help', async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await main({ argv: ['--quiet', '--help'], schema: { name: 'mycli' } });
    } finally {
      write.mockRestore();
    }
    expect(written.join('')).toContain('mycli');
  });
});
