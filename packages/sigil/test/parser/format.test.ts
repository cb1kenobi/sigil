import { completionSpec } from '../../src/completion/spec.js';
import { commandCatalog } from '../../src/components/catalog.js';
import { errorHandler, renderError } from '../../src/error-handler.js';
import main from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import { commandSurface } from '../../src/reference/surface.js';
import { getQuiet, setQuiet } from '../../src/style/output.js';
import { Internal, type OutputFormat, type Schema } from '../../src/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  setQuiet(undefined);
});

/** A serializer that is obviously not the built-in one. */
const yaml: OutputFormat = (value) => `yaml:${JSON.stringify(value)}`;

/** What a run wrote, and what it exited with. */
interface Ran {
  code: number | string | undefined;
  err: string;
  out: string;
}

/**
 * Runs `main()` with both streams captured.
 *
 * `main()` rather than `parse()` wherever the claim is about what reaches a
 * stream, because the serialization is `main()`'s: `parse()` settles which
 * format was asked for and nothing else. Both are used here, and which one a
 * test reaches for is the claim it is making.
 *
 * @param argv - The argv to parse.
 * @param schema - The schema.
 * @returns What was written and the exit code.
 */
async function run(argv: string[], schema: Schema): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const before = process.exitCode;
  process.exitCode = 0;

  try {
    await main({ argv, schema });
    return { code: process.exitCode, err: err.join(''), out: out.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
    process.exitCode = before;
  }
}

/** A schema with one opted-in command that returns data. */
function app(format: unknown = true, formats?: Record<string, OutputFormat>): Schema {
  return {
    commands: { list: { format, run: () => ({ items: ['a', 'b'] }) } } as never,
    formats,
    name: 'mycli',
  };
}

describe('the --format option', () => {
  it('should be added to a command that opted in, and to no other', async () => {
    const state = await parse({
      argv: [],
      schema: { commands: { list: { format: true }, other: {} }, name: 'mycli' },
    });
    const commands = state.contexts[0][Internal].commands;

    expect(commands.find('list')?.[Internal].options.find('--format')).toBeTruthy();
    expect(commands.find('list')?.[Internal].options.find('--json')).toBeTruthy();
    expect(commands.find('other')?.[Internal].options.find('--format')).toBeUndefined();
    expect(commands.find('other')?.[Internal].options.find('--json')).toBeUndefined();
  });

  /**
   * The whole of the per-command rule. A full-screen dashboard has no data to
   * serialize, so a `--format` on it would be an option that parses and does
   * nothing -- which this repository calls worse than no option at all.
   *
   * What "unknown option" comes to depends on `allowUnknownOptions`, which is
   * on by default: the token lands on `argv` as the pass-through that setting is
   * for, and nothing serializes. Turned off it is the error, which is the half
   * worth pinning, because it is what says the option really is absent rather
   * than present and inert.
   */
  it('should leave --format unknown on a command that did not opt in', async () => {
    const schema: Schema = {
      commands: { other: { run: () => ({ a: 1 }) } },
      name: 'mycli',
      settings: undefined,
    } as never;

    expect((await run(['other', '--format', 'json'], schema)).out).toBe('');

    await expect(
      parse({
        argv: ['other', '--format', 'json'],
        schema,
        settings: { allowUnknownOptions: false },
      })
    ).rejects.toThrow('Unknown option "--format"');
  });

  /**
   * `[name]` rather than `<name>`, because `<value>` in an option format makes
   * the **option** required rather than its value -- which would make every run
   * of an opted-in command fail for not having asked for a format.
   */
  it('should not make itself required', async () => {
    expect((await run(['list'], app())).code).toBe(0);
  });

  it('should not put its value on argv, in either spelling', async () => {
    const seen: unknown[] = [];
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: ({ argv }: { argv: Record<string, unknown> }) => {
            seen.push({ ...argv });
            return { a: 1 };
          },
        },
      },
      name: 'mycli',
    } as never;

    await run(['list', '--format', 'json'], schema);
    await run(['list', '--json'], schema);

    expect(seen).toEqual([{}, {}]);
  });

  it('should be described on the help screen', async () => {
    const state = await parse({ argv: [], schema: app() });
    const options = state.contexts[0][Internal].commands.find('list')?.[Internal].options;

    expect(options?.find('--format')?.desc).toBe('Present the result in this format');
    expect(options?.find('--json')?.desc).toBe('Present the result as JSON');
  });

  /**
   * No short form, which is a decision rather than an omission: unlike `-h`,
   * `-v` and `-q` there is no consensus on one, and `-f` is `--force` or
   * `--file` far more often than it is `--format`. `--output` is left alone for
   * the sharper version of the same reason -- it means an output *file* in
   * every tool a user of this framework has typed.
   */
  it('should take neither -f nor --output', async () => {
    const state = await parse({ argv: [], schema: app() });
    const options = state.contexts[0][Internal].commands.find('list')?.[Internal].options;

    // the presence half, or this passes the day the option stops being added
    // at all -- which is the absence-only shape this suite refuses elsewhere
    expect(options?.find('--format')).toBeTruthy();
    expect(options?.find('-f')).toBeUndefined();
    expect(options?.find('--output')).toBeUndefined();
  });
});

describe('what the walkers see', () => {
  /**
   * The option belongs in the generated reference and in a completion script
   * where `--help`, `--version` and `--quiet` do not, and the reason is what
   * puts it in `initCommand()`: those three are added by the **parse**, so a
   * surface built by initializing the schema does not have them -- "an app's
   * snapshot should move when the app moves and not when the framework does".
   * This one is the app's, because the command declared `format`.
   */
  it('should be in the generated reference, where the command opted in', async () => {
    const { commands } = await commandSurface({
      commands: { list: { format: true }, other: {} },
      name: 'mycli',
    } as never);
    const spellings = (path: string[]) =>
      commands
        .find((it) => it.path.join(' ') === path.join(' '))
        ?.options.flatMap((opt) => opt.long);

    expect(spellings(['list'])).toEqual(['--format', '--json']);
    expect(spellings(['other'])).toEqual([]);
  });

  it('should be in a completion script, where the command opted in', async () => {
    const state = await parse({
      argv: [],
      schema: { commands: { list: { format: true }, other: {} }, name: 'mycli' } as never,
    });
    const { commands } = await completionSpec(state);
    const spellings = (path: string[]) =>
      commands
        .find((it) => it.path.join(' ') === path.join(' '))
        ?.options.flatMap((opt) => opt.spellings);

    expect(spellings(['list'])).toContain('--format');
    expect(spellings(['list'])).toContain('--json');
    expect(spellings(['other'])).not.toContain('--format');
  });

  /**
   * And it is **not** a palette slot, which is the right answer rather than an
   * omission: a slot is a value the command *needs* before it can run, and
   * `--format` is optional. The catalog is the one of the three readers that
   * asks a different question.
   */
  it('should not be a palette slot', async () => {
    const state = await parse({
      argv: [],
      schema: {
        commands: { list: { format: true, options: { '--req <r>': {} }, run: () => 1 } },
        name: 'mycli',
      } as never,
    });
    const entry = (await commandCatalog(state)).find((it) => it.path.join(' ') === 'list');

    // the required option beside it is what says the catalog is reading this
    // command's options at all -- without it the empty list would pass for a
    // catalog that had stopped looking
    expect(entry?.slots.map((slot) => slot.spelling)).toEqual(['--req']);
  });
});

describe('selecting a format', () => {
  it('should serialize what run() returned, to stdout', async () => {
    expect(await run(['list', '--format', 'json'], app())).toEqual({
      code: 0,
      err: '',
      out: '{\n  "items": [\n    "a",\n    "b"\n  ]\n}\n',
    });
  });

  it('should take --json as sugar for --format json', async () => {
    expect((await run(['list', '--json'], app())).out).toBe(
      (await run(['list', '--format', 'json'], app())).out
    );
  });

  it('should write nothing where argv asked for no format', async () => {
    expect(await run(['list'], app())).toEqual({ code: 0, err: '', out: '' });
  });

  /**
   * **Last wins**, which is where a format parts company with the three flags
   * the parser owns: those are questions, so any typed true wins in either
   * order, and a format is a value, so the rule is the one every valued option
   * in this schema already follows.
   */
  it('should let the last spelling that named a format win', async () => {
    const schema = app(true, { yaml });

    expect((await run(['list', '--json', '--format', 'yaml'], schema)).out).toBe(
      'yaml:{"items":["a","b"]}\n'
    );
    expect((await run(['list', '--format', 'yaml', '--json'], schema)).out).toBe(
      '{\n  "items": [\n    "a",\n    "b"\n  ]\n}\n'
    );
  });

  /**
   * A `false` names nothing, so `--json=false` contributes nothing rather than
   * selecting JSON -- and `--json --json=false` is still JSON, because the
   * first use is the last one that said anything. Which is `--quiet`'s own
   * reading of a typed no, arriving through the last-wins rule rather than
   * through a special case.
   */
  it('should read a typed no as naming nothing', async () => {
    expect((await run(['list', '--json=false'], app())).out).toBe('');
    expect((await run(['list', '--json', '--json=false'], app())).out).not.toBe('');
  });

  it('should refuse a name this app does not provide, naming what it does', async () => {
    expect((await run(['list', '--format', 'yaml'], app())).err).toBe(
      'Error: Unknown output format "yaml". This command accepts: json\n'
    );
  });

  /**
   * `--format=` is the one way to say "deliberately empty", which the parser
   * records as a value rather than a missing one -- so it reaches here as the
   * empty string and is refused as a format name like any other.
   */
  it('should refuse an empty name', async () => {
    expect((await run(['list', '--format='], app())).err).toContain('Unknown output format ""');
  });

  it('should refuse a bare --format, which takes a value', async () => {
    expect((await run(['list', '--format'], app())).err).toContain(
      'Missing value for option --format'
    );
  });

  /**
   * The accepted set is carried on the option rather than looked up off the
   * declaring command, so a command three levels down presents its ancestor's
   * formats without anything having to ask which declaration won.
   */
  it('should resolve an ancestor’s declaration for a subcommand', async () => {
    const schema: Schema = {
      commands: {
        db: { commands: { list: { run: () => ({ rows: 1 }) } }, format: true },
      },
      name: 'mycli',
    } as never;

    expect((await run(['db', 'list', '--json'], schema)).out).toBe('{\n  "rows": 1\n}\n');
  });

  /**
   * A nearer declaration owns the destination, which is the parser's own
   * context rule -- so the accepted set that comes with it is the nearer one's.
   * The subcommand here presents only `yaml`, so the parent's `json` is refused
   * at it.
   */
  it('should let a nearer declaration narrow what is accepted', async () => {
    const schema: Schema = {
      commands: {
        db: {
          commands: { list: { format: ['yaml'], run: () => ({ rows: 1 }) } },
          format: true,
        },
      },
      formats: { yaml },
      name: 'mycli',
    } as never;

    expect((await run(['db', 'list', '--format', 'yaml'], schema)).out).toBe('yaml:{"rows":1}\n');
    expect((await run(['db', 'list', '--format', 'json'], schema)).err).toContain(
      'This command accepts: yaml'
    );
  });

  /**
   * The same command line with the token moved in front of the subcommand,
   * which is the one arrangement the test above cannot see: the token resolves
   * against the contexts known at that moment, which is `db` alone, so reading
   * the accepted set off the option argv bound to gave `db`'s `true` and
   * `--format json` was taken -- exit 0, the JSON on stdout, with `list`
   * having declared that it presents yaml and nothing else. Two answers to one
   * command line depending on where the token sat. Found by review.
   *
   * `--json` is the sharper half, because the sugar itself is only there
   * because an **ancestor** offered it: `list` accepts `['yaml']`, so no
   * `--json` was added to its registry, and the one that resolves is `db`'s.
   * Which is options resolving across the chain, and is why what a token may
   * *name* has to be the nearest command's answer rather than the answer of
   * whichever registry holds the option.
   */
  it('should narrow what is accepted wherever in the line the token sat', async () => {
    const schema: Schema = {
      commands: {
        db: {
          commands: { list: { format: ['yaml'], run: () => ({ rows: 1 }) } },
          format: true,
        },
      },
      formats: { yaml },
      name: 'mycli',
    } as never;

    // before the subcommand, both spellings
    expect((await run(['db', '--format', 'json', 'list'], schema)).err).toContain(
      'This command accepts: yaml'
    );
    expect((await run(['db', '--json', 'list'], schema)).err).toContain(
      'This command accepts: yaml'
    );

    // and the one it does present is taken from either position
    expect((await run(['db', '--format', 'yaml', 'list'], schema)).out).toBe('yaml:{"rows":1}\n');
  });

  it('should serialize what a default command returned', async () => {
    const schema: Schema = {
      commands: { go: { default: true, format: true, run: () => ({ d: 1 }) } },
      name: 'mycli',
    } as never;

    expect((await run(['--json'], schema)).out).toBe('{\n  "d": 1\n}\n');
  });

  /**
   * Exactly one trailing newline, which is `errorHandler()`'s own rule: a
   * line-oriented consumer wants one, and a serializer that already ended with
   * one must not produce a blank line. A CSV serializer is the shape that
   * ends with one.
   */
  it('should end with exactly one newline, whatever the serializer did', async () => {
    const rows: OutputFormat = () => 'a,b\nc,d\n';

    expect((await run(['list', '--format', 'csv'], app(true, { csv: rows }))).out).toBe(
      'a,b\nc,d\n'
    );
  });
});

describe('the format registry', () => {
  it('should ship json and nothing else', async () => {
    expect((await run(['list', '--format', 'json'], app())).code).toBe(0);
    expect((await run(['list', '--format', 'yaml'], app())).code).toBe(1);
  });

  it('should let an app register its own', async () => {
    expect((await run(['list', '--format', 'yaml'], app(true, { yaml }))).out).toBe(
      'yaml:{"items":["a","b"]}\n'
    );
  });

  /**
   * An app that declares its own `json` keeps it, which is the
   * declaration-respecting rule every free flag here follows, said about a
   * name rather than a spelling.
   */
  it('should let an app replace the built-in json', async () => {
    expect((await run(['list', '--json'], app(true, { json: () => 'MINE' }))).out).toBe('MINE\n');
  });

  it('should refuse a formats that is not an object of functions', async () => {
    await expect(
      parse({ argv: [], schema: { formats: 42 as never, name: 'mycli' } })
    ).rejects.toThrow('Expected schema formats to be an object of names and functions');

    await expect(
      parse({ argv: [], schema: { formats: { yaml: 'nope' as never }, name: 'mycli' } })
    ).rejects.toThrow('Expected the "yaml" schema format to be a function');
  });

  /**
   * Unconditionally, the way the hooks are validated: `detectFormat()` looks
   * only where a command opted in, so an app with a broken `formats` and no
   * command that presents one would otherwise never find out -- which is a
   * declaration that parses and does nothing.
   */
  it('should refuse a broken formats even where no command opted in', async () => {
    await expect(
      parse({ argv: [], schema: { formats: { yaml: 'nope' as never }, name: 'mycli' } })
    ).rejects.toThrow('Expected the "yaml" schema format to be a function');
  });

  /**
   * Every one of these parsed and then did something nobody meant, which is
   * the shape a review round found three of at once. The array is the sharpest
   * because it **works**: `Object.entries` keys it by index, so a format called
   * `0` was mintable and selectable. The `Map` is the shape anybody reaching
   * for a registry writes and contributed nothing at all, so an app that had
   * declared yaml was told it accepts json.
   */
  it.each([
    ['an array', [() => 'x'] as never],
    ['a Map', new Map([['yaml', () => 'x']]) as never],
    [
      'a class instance',
      new (class F {
        yaml = () => 'x';
      })() as never,
    ],
  ])('should refuse a formats written as %s', async (_what, formats) => {
    await expect(parse({ argv: [], schema: { formats, name: 'mycli' } })).rejects.toThrow(
      'written as an object literal'
    );
  });

  /**
   * A name is what a user types after `--format`, and the empty string is the
   * one thing argv can say that is *not* a name: `--format=` is how a value is
   * deliberately left empty, so `{ '': fn }` made that spelling select a
   * format.
   */
  it('should refuse a format with no name', async () => {
    await expect(
      parse({ argv: [], schema: { formats: { '': () => 'x' }, name: 'mycli' } })
    ).rejects.toThrow('the empty string is not one a user can type');
  });

  /**
   * The refusal prints the names a command accepts, so a control character in
   * one is a sequence waiting for a terminal to execute it -- which it did:
   * `This command accepts: json, y<ESC>[31ml` reached stderr with the escape
   * intact. The rule this repository keeps for every byte it emits, met through
   * a declaration.
   */
  it('should refuse a format name holding a control character', async () => {
    await expect(
      parse({
        argv: [],
        schema: { formats: { [`y${String.fromCharCode(0x1b)}[31ml`]: () => 'x' }, name: 'mycli' },
      })
    ).rejects.toThrow('to have no control character in its name');
  });

  /**
   * A serializer is synchronous and the type says so, which a JavaScript app is
   * not bound by -- and an `async` one costs more than a confusing message:
   * what `writeFormatted()` and the error path each create is a promise nobody
   * awaits, so one that **rejects** took the process down with two unhandled
   * rejections about an answer nothing was waiting for. Both halves are pinned:
   * the message names a promise, and the rejection does not escape.
   */
  it('should name a promise and swallow its rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => void seen.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      const ran = await run(
        ['list', '--format', 'slow'],
        app(['slow'], { slow: (() => Promise.reject(new Error('nope'))) as never })
      );

      expect(ran.out).toBe('');
      expect(ran.err).toContain('got a promise: a serializer is synchronous');

      // a rejection is reported on a later turn, so the wait is what makes the
      // absence mean anything
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a declaration', () => {
  it('should offer only the names a list declared', async () => {
    const schema = app(['yaml'], { yaml });

    expect((await run(['list', '--format', 'yaml'], schema)).out).toBe(
      'yaml:{"items":["a","b"]}\n'
    );
    expect((await run(['list', '--format', 'json'], schema)).err).toContain(
      'Unknown output format "json". This command accepts: yaml'
    );
  });

  /**
   * The sugar is offered only where the command accepts `json`, or it would
   * select a format the command refuses. `true` always includes it, because
   * the registry is `json` plus whatever the schema added and there is no way
   * to take it away.
   */
  it('should offer --json only where json is accepted', async () => {
    const state = await parse({
      argv: [],
      schema: {
        commands: { csvOnly: { format: ['csv'] }, every: { format: true } },
        formats: { csv: () => 'x' },
        name: 'mycli',
      } as never,
    });
    const commands = state.contexts[0][Internal].commands;

    expect(commands.find('every')?.[Internal].options.find('--json')).toBeTruthy();
    expect(commands.find('csvOnly')?.[Internal].options.find('--format')).toBeTruthy();
    expect(commands.find('csvOnly')?.[Internal].options.find('--json')).toBeUndefined();
  });

  it('should keep a command’s own --format, and still select with --json', async () => {
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          options: { '--format [x]': 'Mine' },
          run: ({ argv }: { argv: Record<string, unknown> }) => ({ mine: argv.format }),
        },
      },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--format', 'wide', '--json'], schema)).out).toBe(
      '{\n  "mine": "wide"\n}\n'
    );
  });

  /**
   * A merely *named* `format` costs the command the option entirely, where a
   * taken `--json` costs it only the sugar -- which is `registerQuiet()`'s own
   * asymmetry, and is there because replacing a registry key is a worse thing
   * to do to an app than declining to add a spelling.
   */
  it('should decline the option to a command that named something else format', async () => {
    const state = await parse({
      argv: [],
      schema: {
        commands: { list: { format: true, options: { '-x': { name: 'format' } } } },
        name: 'mycli',
      } as never,
    });
    const options = state.contexts[0][Internal].commands.find('list')?.[Internal].options;

    expect(options?.find('--format')).toBeUndefined();
    expect(options?.find('--json')).toBeTruthy();
  });

  /**
   * A command that took both spellings and still declares `format` has no way
   * left to select one, which is a declaration that parses and does nothing.
   * Refused in `registerFormats()`, which is the one place both facts are in
   * hand: what the command declared, and what the registry would let us add.
   */
  it('should refuse a command that left no spelling to select with', async () => {
    await expect(
      parse({
        argv: [],
        schema: {
          commands: {
            list: { format: true, options: { '--format [x]': 'Mine', '--json': { type: 'bool' } } },
          },
          name: 'mycli',
        } as never,
      })
    ).rejects.toThrow('declares "format" and also declares every spelling');
  });

  it('should refuse a format that is neither a boolean nor a list of names', async () => {
    await expect(
      parse({ argv: [], schema: { commands: { list: { format: 'json' } }, name: 'm' } as never })
    ).rejects.toThrow('Expected format in "list" command to be true, false, or a non-empty list');

    await expect(
      parse({ argv: [], schema: { commands: { list: { format: [1] } }, name: 'm' } as never })
    ).rejects.toThrow('Expected format in "list" command to be true, false, or a non-empty list');
  });

  /**
   * An empty list is "I present no format", which is what `false` already
   * says -- and a `--format` that rejects every value is a flag that cannot
   * work. Refused rather than read as `false`, which is the silent reading.
   */
  it('should refuse an empty list', async () => {
    await expect(
      parse({ argv: [], schema: { commands: { list: { format: [] } }, name: 'm' } as never })
    ).rejects.toThrow('to name at least one format');
  });

  it('should add nothing for false or absent', async () => {
    const state = await parse({
      argv: [],
      schema: {
        commands: { off: { format: false }, on: { format: true }, plain: {} },
        name: 'm',
      } as never,
    });
    const commands = state.contexts[0][Internal].commands;

    // and the command beside them that did opt in, so the two absences are
    // about `false` and absence rather than about the option having gone
    expect(commands.find('on')?.[Internal].options.find('--format')).toBeTruthy();
    expect(commands.find('off')?.[Internal].options.find('--format')).toBeUndefined();
    expect(commands.find('plain')?.[Internal].options.find('--format')).toBeUndefined();
  });

  /**
   * Checked whether or not argv asked for a format, so a command naming one
   * this app does not provide fails on every run rather than on the first run
   * that types `--format`. It is the call `initCommand()` makes for a
   * non-boolean `hidden`: a declaration that cannot mean anything fails where
   * it was written.
   */
  it('should refuse a declared name this app does not provide', async () => {
    await expect(parse({ argv: ['list'], schema: app(['yaml']) })).rejects.toThrow(
      'The "list" command declares the "yaml" output format, which this app does not provide'
    );
  });

  /**
   * Only the chain is walked, so a routed tree pays for the commands argv named
   * and nothing else -- which is also what keeps the check from refusing an app
   * over a command nobody ran.
   */
  it('should not refuse a bad declaration on a command argv did not name', async () => {
    const schema: Schema = {
      commands: { bad: { format: ['yaml'] }, list: { format: true, run: () => ({ a: 1 }) } },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--json'], schema)).out).toBe('{\n  "a": 1\n}\n');
    expect((await run(['bad'], schema)).code).toBe(1);
  });
});

describe('what the command returned', () => {
  /**
   * Three answers were available and only this one can be acted on. Printing
   * nothing leaves a script with empty stdout and exit zero, so `jq` fails with
   * "Unexpected end of input" and names nothing; printing `null` claims the
   * command's answer was `null`. A refusal names the command, goes to stderr and
   * exits non-zero.
   */
  it('should refuse a command that returned nothing', async () => {
    const schema: Schema = {
      commands: { list: { format: true, run: () => undefined } },
      name: 'mycli',
    } as never;
    const ran = await run(['list', '--json'], schema);

    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');

    // and the refusal is itself presented in the selected format, because it
    // leaves through the one error path: a script reading stderr gets JSON
    // whichever half of the run failed
    expect(JSON.parse(ran.err).error.message).toContain('returned nothing to present as "json"');
  });

  /** `null` is a value JSON can represent, so it is presented rather than refused. */
  it('should present a null the command meant', async () => {
    const schema: Schema = {
      commands: { list: { format: true, run: () => null } },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--json'], schema)).out).toBe('null\n');
  });

  /**
   * Every one of these is a value `JSON.stringify` writes *something* for
   * rather than refusing, and in each case the something is not what the
   * command returned. They were reaching the pipe until a review round named
   * them: a `Map` of results piped `{}` and said nothing, which is the one
   * thing the house rules name directly.
   *
   * The **path** is the half that makes a message actionable, and the two the
   * built-in already threw for are in the table for exactly that: JSON's own
   * `Do not know how to serialize a BigInt` names no value, so a payload with
   * one `n` somewhere in it left the author to go and find it.
   */
  it.each([
    ['a function', () => ({ a: { b() {} } }), 'JSON has no function', 'a.b'],
    ['a symbol', () => ({ a: Symbol('s') }), 'JSON has no symbol', 'a'],
    ['an undefined inside', () => ({ a: { b: undefined } }), 'JSON has no undefined', 'a.b'],
    // the hole and an `undefined` somebody wrote are the same value to a
    // replacer, which is honest rather than a gap: JSON writes both as `null`
    // eslint-disable-next-line no-sparse-arrays
    ['a hole', () => ({ a: [1, , 2] }), 'JSON has no undefined', 'a.1'],
    ['a NaN', () => ({ a: { b: [0, Number.NaN] } }), 'JSON writes NaN as null', 'a.b.1'],
    ['an Infinity', () => ({ a: -Infinity }), 'JSON writes -Infinity as null', 'a'],
    ['a Map', () => ({ r: new Map([['k', 1]]) }), 'no mapping for Map', 'r'],
    ['a Set', () => ({ r: new Set([1]) }), 'no mapping for Set', 'r'],
    ['an Error', () => ({ r: new Error('boom') }), 'no mapping for Error', 'r'],
    ['a bigint', () => ({ a: 10n }), 'JSON has no bigint', 'a'],
  ])('should refuse %s rather than let json lose it', async (_what, make, says, where) => {
    const schema: Schema = {
      commands: { list: { format: true, run: make } },
      name: 'mycli',
    } as never;
    const ran = await run(['list', '--json'], schema);

    expect(ran.out).toBe('');
    // the error itself is serialized, which is the whole point of the feature:
    // a script gets JSON either way
    const { message } = JSON.parse(ran.err).error as { message: string };
    expect(message).toContain(says);
    expect(message).toContain(`(at "${where}")`);
  });

  /**
   * What JSON writes faithfully is written, and each of these is a value a
   * prototype table would have refused: a class instance is written as its
   * fields, which is what the app asked for, and a boxed `Number` is a
   * non-plain object with no own keys that JSON writes as `5`. Which is why the
   * `{}` family is asked of `JSON.stringify` itself rather than of a table.
   *
   * The pair is the inverse of the table above, so a refusal widened to cover
   * one of these fails here rather than going quiet.
   */
  it.each([
    [
      'a class instance',
      () => ({
        a: new (class F {
          x = 1;
        })(),
      }),
      '{\n  "a": {\n    "x": 1\n  }\n}',
    ],
    ['a boxed number', () => ({ a: new Number(5) }), '{\n  "a": 5\n}'],
    ['a Date', () => ({ a: new Date(0) }), '{\n  "a": "1970-01-01T00:00:00.000Z"\n}'],
    ['a toJSON', () => ({ a: { toJSON: () => 'ok' } }), '{\n  "a": "ok"\n}'],
    // one object reached twice is a DAG rather than a cycle, and the path
    // carried through the replacer collides on it benignly: either path is a
    // true path, and a real cycle is `JSON.stringify`'s own throw
    [
      'a DAG',
      () => {
        const n = { n: 1 };
        return { a: n, b: n };
      },
      '{\n  "a": {\n    "n": 1\n  },\n  "b": {\n    "n": 1\n  }\n}',
    ],
  ])('should write %s, which json holds faithfully', async (_what, make, out) => {
    const schema: Schema = {
      commands: { list: { format: true, run: make } },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--json'], schema)).out).toBe(`${out}\n`);
  });

  /**
   * The cycle is JSON's own throw rather than ours, and the message it already
   * carries is better than anything a replacer could say without a second
   * `WeakSet` of its own.
   */
  it('should let the cycle json throws about reach the error path', async () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const schema: Schema = {
      commands: { list: { format: true, run: () => cyc } },
      name: 'mycli',
    } as never;

    expect(JSON.parse((await run(['list', '--json'], schema)).err).error.message).toContain(
      'circular'
    );
  });

  /**
   * `assertSerialized()`'s own door, now that `lossyAs()` has taken the
   * built-in's: the type says `string` and a JavaScript app is not bound by it,
   * so a serializer that returns nothing is the one reachable way to put the
   * word `undefined` on stdout.
   */
  it('should refuse a serializer that did not answer with text', async () => {
    const schema: Schema = {
      commands: { list: { format: ['bad'], run: () => ({ a: 1 }) } },
      formats: { bad: () => undefined as never },
      name: 'mycli',
    } as never;
    const ran = await run(['list', '--format', 'bad'], schema);

    expect(ran.out).toBe('');
    expect(ran.err).toContain('Expected the "bad" output format to return a string, got undefined');
  });

  /**
   * The command really did return, so a hook that asked what it did is right to
   * have been told `ok` -- what failed is the presentation. Pinned because the
   * ordering is a decision rather than a convenience.
   */
  it('should fire afterRun with ok before refusing what it returned', async () => {
    const seen: boolean[] = [];
    const schema: Schema = {
      commands: { list: { format: true, run: () => undefined } },
      hooks: { afterRun: ({ result }: { result: { ok: boolean } }) => void seen.push(result.ok) },
      name: 'mycli',
    } as never;

    await run(['list', '--json'], schema);

    expect(seen).toEqual([true]);
  });
});

describe('a serialized error', () => {
  it('should present the error in the selected format', async () => {
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: () => {
            throw new TypeError('boom');
          },
        },
      },
      name: 'mycli',
    } as never;
    const ran = await run(['list', '--json'], schema);

    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
    expect(JSON.parse(ran.err)).toEqual({ error: { message: 'boom', name: 'TypeError' } });
  });

  /**
   * `name` is the half a script can branch on, and that is the reason it is
   * there rather than a nicety: a message is translated and a name is not, so a
   * script keyed on the message breaks the moment `LANG` moves. A thrown string
   * has no name, so the field is absent rather than invented.
   */
  it('should carry a name only where the thrown value has one', async () => {
    const thrower = (value: unknown): Schema =>
      ({
        commands: {
          list: {
            format: true,
            run: () => {
              throw value;
            },
          },
        },
        name: 'mycli',
      }) as never;

    expect(JSON.parse((await run(['list', '--json'], thrower('plain'))).err)).toEqual({
      error: { message: 'plain' },
    });
    expect(JSON.parse((await run(['list', '--json'], thrower(new RangeError('r')))).err)).toEqual({
      error: { message: 'r', name: 'RangeError' },
    });
  });

  /**
   * `exitCode` is deliberately absent from the payload: the process already
   * carries the verdict, and putting it in would be the same fact twice.
   */
  it('should leave the verdict to the exit code', async () => {
    const err = Object.assign(new Error('nope'), { exitCode: 3 });
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: () => {
            throw err;
          },
        },
      },
      name: 'mycli',
    } as never;
    const ran = await run(['list', '--json'], schema);

    expect(ran.code).toBe(3);
    expect(JSON.parse(ran.err).error).not.toHaveProperty('exitCode');
  });

  /**
   * A broken serializer must not cost the reader the error they actually
   * needed, which is why `renderError()` has a fallback of its own rather than
   * leaning on `errorHandler()`'s -- that one would re-enter whatever just
   * threw.
   */
  it('should fall back to the message where the serializer throws', async () => {
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: () => {
            throw new Error('boom');
          },
        },
      },
      formats: {
        bad: () => {
          throw new Error('serializer');
        },
      },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--format', 'bad'], schema)).err).toBe('Error: boom\n');
  });

  /**
   * `renderError()` is exported for a caller to wrap, so a broken serializer has
   * to leave text rather than a throw -- which is why the fallback is that
   * function's own rather than `errorHandler()`'s. A sabotage pass is what said
   * this needs a test of its own: with `errorHandler()`'s catch behind it the
   * two guards were covering for each other, and either spelling produced the
   * same text.
   */
  it('should leave text rather than a throw when called directly', () => {
    const state = {
      format: 'bad',
      schema: {
        formats: {
          bad: () => {
            throw new Error('serializer');
          },
        },
      },
    } as never;

    expect(renderError(new Error('boom'), { state })).toBe('Error: boom');
  });

  /**
   * And `errorHandler()`'s own fallback is the format-aware renderer rather
   * than the plain line, which is only observable where a **replaced** renderer
   * throws: falling back to the plain form would silently drop the format the
   * reader asked for in the one case where the app's own renderer is what is
   * broken.
   */
  it('should fall back to the selected format when a replaced renderer throws', () => {
    const written: string[] = [];
    const state = { format: 'json', schema: {} } as never;

    errorHandler(new Error('boom'), {
      render: () => {
        throw new Error('renderer');
      },
      state,
      stderr: {
        write: (chunk: string) => void written.push(chunk),
      } as never,
    });

    expect(JSON.parse(written.join(''))).toEqual({ error: { message: 'boom', name: 'Error' } });
  });

  /**
   * Everything judged **after** argv has been walked is serialized, because by
   * then `detectFormat()` has run. Which is most of what a parse refuses: a
   * missing required option, an unexpected argument, a value outside `choices`.
   */
  it('should present a parse failure judged after the walk', async () => {
    const schema: Schema = {
      commands: { list: { format: true, options: { '--req <r>': {} }, run: () => 1 } },
      name: 'mycli',
    } as never;

    expect(JSON.parse((await run(['list', '--json'], schema)).err)).toEqual({
      error: { message: 'Missing required options: --req', name: 'Error' },
    });
  });

  /**
   * And an invalid **value** is not, which is the one seam in this and is
   * pinned rather than discovered. A value fails "on the way in, while argv is
   * being read", which is before anything has read which format was asked for
   * -- so there is nothing yet to present it in. Positional detection would
   * close half of it and is refused: `--json --port x` serializing while
   * `--port x --json` did not is a rule nobody can reason about.
   */
  it('should fall back to the message for a value that failed on the way in', async () => {
    const schema: Schema = {
      commands: {
        list: { format: true, options: { '--port [n]': { type: 'int' } }, run: () => 1 },
      },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--json', '--port', 'eight'], schema)).err).toBe(
      'Error: Invalid integer: eight\n'
    );
  });
});

describe('the quiet implication', () => {
  /**
   * The whole reason this waited on the quiet axis: a spinner interleaved with
   * JSON on stdout is unusable, so asking for machine output is asking for
   * nothing else.
   */
  it('should record quiet process-wide for the length of the run', async () => {
    const seen: (boolean | undefined)[] = [];
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: () => {
            seen.push(getQuiet());
            return { a: 1 };
          },
        },
      },
      name: 'mycli',
    } as never;

    await run(['list', '--json'], schema);

    expect(seen).toEqual([true]);
    expect(getQuiet()).toBeUndefined();
  });

  it('should leave quiet alone where no format was selected', async () => {
    const seen: (boolean | undefined)[] = [];
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: () => {
            seen.push(getQuiet());
            return { a: 1 };
          },
        },
      },
      name: 'mycli',
    } as never;

    await run(['list'], schema);

    expect(seen).toEqual([undefined]);
  });

  /**
   * `state.quiet` keeps meaning "argv asked", and the implication is made in
   * `main()` where it is read -- so a format does not make the flag read as
   * though it had been typed.
   */
  it('should not set state.quiet', async () => {
    const state = await parse({ argv: ['list', '--json'], schema: app() });

    // and the format *is* settled, so the absence is about which field the
    // implication is made on rather than about the parse having read nothing
    expect(state.format).toBe('json');
    expect(state.quiet).toBeUndefined();
  });

  /**
   * The one branch a command legitimately has, and the one `mark()`'s own doc
   * used to deny: stdout belongs to the serializer once a format was selected,
   * so a command drawing its own human form there has to be able to stop. What
   * is off `argv` is the **name**, which is the two-answers conditional; what
   * `run()` is handed is whether one was asked for.
   */
  it('should hand run() the format while keeping it off argv', async () => {
    const seen: (string | undefined)[] = [];
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: (state: { argv: Record<string, unknown>; format?: string }) => {
            seen.push(state.format, state.argv.format as undefined);
            return { a: 1 };
          },
        },
      },
      name: 'mycli',
    } as never;

    await run(['list', '--json'], schema);
    await run(['list'], schema);

    // the name on the state, nothing on argv, and `undefined` where argv asked
    // for no format at all -- which is what the demo's one branch reads
    expect(seen).toEqual(['json', undefined, undefined, undefined]);
  });
});

describe('what a format does not reach', () => {
  /**
   * Help is the answer to the question and quiet is about what is said while
   * working, so `--help` wins and prints the screen -- which is `--quiet`'s own
   * rule, and is why a format is not a reason to serialize help.
   */
  it('should leave --help printing help', async () => {
    const ran = await run(['list', '--json', '--help'], app());

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('Usage: mycli list');
  });

  /**
   * A version is a question about the program, not a command's answer.
   *
   * The `default` command is what makes the test able to fail, and it was
   * missing: without it there is nothing for a format to present, so stdout was
   * the version whether or not `--version` won. Found by review. With it, a
   * `--version` that stopped short-circuiting prints the JSON instead.
   */
  it('should leave --version printing the version', async () => {
    const schema: Schema = {
      commands: { go: { default: true, format: true, run: () => ({ d: 1 }) } },
      name: 'mycli',
      version: '1.2.3',
    } as never;

    expect((await run(['--version', '--json'], schema)).out).toBe('1.2.3\n');
  });

  /**
   * Which side of the seam a parse error falls on is which pass it came out of,
   * and the boundary is `detectFormat()`: it runs after argv has been **walked**
   * and before it is **judged**. So a value its type rejects is a plain line,
   * because the throw is inside the pass that reads the option and no format had
   * been settled, while a judgement is a payload.
   *
   * Recorded rather than closed -- there is no earlier point that has both the
   * token and a settled chain -- and pinned so that it is a documented seam
   * rather than a surprise. The token order is both ways round, because the
   * first reading of this was that the format being read *first* would settle
   * it, and it does not: the pass is what decides, not the position.
   */
  it.each([
    ['a value its type rejects, format last', ['list', '--n', 'eight', '--json'], false],
    ['a value its type rejects, format first', ['list', '--json', '--n', 'eight'], false],
    ['an unexpected argument', ['list', '--json', 'extra'], true],
  ])('should serialize %s only where argv was being judged', async (_what, argv, serialized) => {
    const schema: Schema = {
      commands: {
        list: { format: true, options: { '--n <v>': { type: 'int' } }, run: () => ({}) },
      },
      name: 'mycli',
    } as never;
    const ran = await run(argv, schema);

    expect(ran.code).toBe(1);
    expect(ran.err.startsWith('{')).toBe(serialized);
    // either way the message is the same one the plain form prints, which is
    // what `errorPayload()` is built from -- and the exit code is the half a
    // script keys on whichever form it got
    expect(serialized ? JSON.parse(ran.err).error.message : ran.err).toContain(
      serialized ? 'Unexpected argument' : 'Invalid integer: eight'
    );
  });
});

describe('the two forms of one result', () => {
  /**
   * The scope item, and the shape the whole design is for: the command computes
   * one value and optionally draws one, and which of the two reaches the
   * terminal is the framework's decision rather than an `if` in the command. So
   * there is one `run()` here with no branch in it, run twice, and the two forms
   * have to describe the same result.
   */
  it('should describe the same result drawn and serialized', async () => {
    const rows = [
      { name: 'alpha', size: 1 },
      { name: 'bravo', size: 2 },
    ];
    const schema: Schema = {
      commands: {
        list: {
          format: true,
          run: () => {
            // the command draws unconditionally -- quiet is what silences it,
            // and `process.stdout.write` is not what quiet reaches, so this
            // writes either way and the test reads both streams
            process.stderr.write(`${rows.map((it) => `${it.name} ${it.size}`).join('\n')}\n`);
            return { rows };
          },
        },
      },
      name: 'mycli',
    } as never;

    const drawn = await run(['list'], schema);
    const serialized = await run(['list', '--json'], schema);

    // the human form is the same either way: the command did not branch
    expect(serialized.err).toBe(drawn.err);

    // and the serialized form says what the drawn one says
    const parsed = JSON.parse(serialized.out) as { rows: typeof rows };

    expect(parsed.rows).toEqual(rows);
    expect(drawn.err.trim().split('\n')).toEqual(parsed.rows.map((it) => `${it.name} ${it.size}`));
  });
});
