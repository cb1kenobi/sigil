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
      schema: { commands: { list: { format: true, run: () => 1 } }, name: 'mycli' } as never,
    });
    const entry = (await commandCatalog(state)).find((it) => it.path.join(' ') === 'list');

    expect(entry?.slots).toEqual([]);
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
      schema: { commands: { off: { format: false }, plain: {} }, name: 'm' } as never,
    });
    const commands = state.contexts[0][Internal].commands;

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
   * Reachable through the **built-in**, which is what makes `assertSerialized()`
   * a guard rather than a tripwire: `JSON.stringify` answers the *value*
   * `undefined` for a function and for a symbol, so without it the word
   * `undefined` would reach stdout.
   */
  it('should refuse a value json answers nothing for', async () => {
    const schema: Schema = {
      commands: { list: { format: true, run: () => () => 1 } },
      name: 'mycli',
    } as never;
    const ran = await run(['list', '--json'], schema);

    expect(ran.out).toBe('');
    expect(JSON.parse(ran.err).error.message).toContain(
      'Expected the "json" output format to return a string'
    );
  });

  it('should let what json throws about reach the error path', async () => {
    const schema: Schema = {
      commands: { list: { format: true, run: () => ({ n: 1n }) } },
      name: 'mycli',
    } as never;

    expect((await run(['list', '--json'], schema)).err).toContain('BigInt');
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
    expect((await parse({ argv: ['list', '--json'], schema: app() })).quiet).toBeUndefined();
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

  /** A version is a question about the program, not a command's answer. */
  it('should leave --version printing the version', async () => {
    const schema: Schema = { format: true, name: 'mycli', version: '1.2.3' } as never;

    expect((await run(['--version', '--json'], schema)).out).toBe('1.2.3\n');
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
