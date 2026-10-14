import { bashQuote, completionScript, SHELL_NAMES, SHELLS } from '../src/completion/index.js';
import { detectShell, installHint, instructions } from '../src/completion/install.js';
import { completionSpec, oneLine, type CompletionSpec } from '../src/completion/spec.js';
import { zshPair, zshQuote } from '../src/completion/zsh.js';
import { commandCatalog } from '../src/components/catalog.js';
import { resolveHelp } from '../src/help/index.js';
import { parse } from '../src/parser/parse.js';
import { Internal, type ParseState, type Schema } from '../src/types.js';
import { whichSync } from '../src/which.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures/completion/commands');
// its own directory, so nothing else in this file imports what is in it: the
// ESM loader caches a module, so a counter shared with another test's fixture
// reads as unchanged whichever test ran first -- which is a test that passes
// because somebody else already paid the import
const hiddenFixtures = join(here, 'fixtures/completion/hidden');

const ESC = String.fromCharCode(0x1b);

/**
 * The state a parse ends in, which is what a script is printed from.
 *
 * Through the real parser rather than a hand-built chain, for the reason the
 * catalog's own tests give: the whole claim is that this reads what the parser
 * built, and a literal chain would be a second spelling of the registries that
 * passes whatever the reader happened to do with them.
 *
 * @param schema - The app.
 * @returns The parse state.
 */
async function state(schema: Schema): Promise<ParseState> {
  return await parse({ argv: [], env: {}, schema: { name: 'mycli', ...schema } });
}

/** The spec for an app. */
async function spec(schema: Schema): Promise<CompletionSpec> {
  return await completionSpec(await state(schema));
}

/** The command paths a spec holds, as they are typed. */
function paths(it: CompletionSpec): string[] {
  return it.commands.map((cmd) => cmd.path.join(' '));
}

/** One command out of a spec, by its path. */
function at(it: CompletionSpec, path: string) {
  const found = it.commands.find((cmd) => cmd.path.join(' ') === path);
  if (!found) {
    throw new Error(`No "${path}" in the spec: ${JSON.stringify(paths(it))}`);
  }
  return found;
}

/** Every option spelling a command offers. */
function spellings(it: CompletionSpec, path: string): string[] {
  return at(it, path).options.flatMap((opt) => opt.spellings);
}

describe('completionSpec()', () => {
  it("should list the root's commands, sorted, with the parser's own among them", async () => {
    const found = await spec({
      commands: {
        deploy: { desc: 'ship it', run(): void {} },
        build: { desc: 'build it', run(): void {} },
      },
    });

    expect(paths(found)).toEqual(['', 'build', 'completion', 'deploy', 'help']);
    // a description is read off the *parent's* entry for a command, which is
    // the one place a shell shows one: you complete at a command rather than
    // displaying the one you are already in
    expect(at(found, '').subcommands.map((sub) => sub.desc)).toEqual([
      'build it',
      'Print a shell completion script',
      'ship it',
      'Show help for a command',
    ]);
  });

  it('should carry the argv path from the root', async () => {
    const found = await spec({
      commands: {
        db: {
          commands: {
            migrate: { commands: { up: { run(): void {} } } },
          },
        },
      },
      completion: false,
      help: false,
    });

    expect(paths(found)).toEqual(['', 'db', 'db migrate', 'db migrate up']);
    expect(at(found, 'db').subcommands.map((sub) => sub.name)).toEqual(['migrate']);
  });

  it('should offer every command the catalog lists', async () => {
    // the differential the ticket asks for, and what it keeps honest is that
    // the two readers of one registry answer the same about *what is there*.
    // They part on the question each is for -- a catalog leaves a namespace out
    // because selecting one runs nothing, and completion offers every path
    // segment because you have to type `db` to reach `db migrate` -- so the
    // catalog is asked with `namespaces: true`, which is the same set
    const schema: Schema = {
      commands: {
        build: { desc: 'build it', run(): void {} },
        db: {
          desc: 'db things',
          commands: {
            migrate: { desc: 'migrate', run(): void {} },
            seed: { desc: 'seed', run(): void {} },
          },
        },
        '!quiet': { desc: 'hidden', run(): void {} },
      },
    };

    const parsed = await state(schema);
    const listed = commandCatalog(parsed, { namespaces: true })
      .map((entry) => entry.label)
      .sort();

    // the root is this one's and not the catalog's: a catalog lists commands to
    // *run* and the program itself is not one of them, while a script has to
    // complete at the bare program name
    const offered = paths(await completionSpec(parsed))
      .filter((path) => path !== '')
      .sort();

    expect(offered).toEqual(listed);
    expect(offered).toContain('db migrate');
    expect(offered).not.toContain('quiet');
  });

  it('should leave a hidden command and everything under it out', async () => {
    const found = await spec({
      commands: {
        '!private': {
          desc: 'hidden',
          commands: { inner: { run(): void {} } },
        },
        shown: { run(): void {} },
      },
      completion: false,
      help: false,
    });

    expect(paths(found)).toEqual(['', 'shown']);
  });

  it('should leave out a command its own module hides, which the catalog cannot see', async () => {
    // the half eager loading buys: `hidden` is additive and a module may set
    // it, so a routed command that hides itself is listed by a catalog -- which
    // never imports anything -- and is not offered here
    const schema: Schema = { commands: fixtures, completion: false, help: false };
    const parsed = await state(schema);

    expect(paths(await completionSpec(parsed))).toEqual(['', 'build', 'db', 'db migrate']);

    // ...and the catalog, reading the same tree without importing it, does
    // list it. Both are right about the question each is asked
    expect(commandCatalog(await state(schema)).map((entry) => entry.label)).toContain('quiet');
  });

  it('should not import a module whose placeholder is already hidden', async () => {
    // a `!` name prefix is on the placeholder, so there is nothing to read: the
    // fixture counts its own imports and nothing is ever meant to pay one
    const found = await spec({ commands: hiddenFixtures, completion: false, help: false });

    expect(paths(found)).toEqual(['', 'shown']);
    expect((globalThis as Record<string, unknown>).__sigilSecretImported).toBeUndefined();
  });

  it('should read a lazily loaded command, which only its module has', async () => {
    // the whole reason the walk imports: `--out` is declared *inside*
    // `build.js`, and nothing lifts an option -- `sigil build` lifts `desc` and
    // `hidden` and stops there -- so a script that did not load would offer
    // `build` with the root's options and none of its own
    const found = await spec({ commands: fixtures, completion: false, help: false });

    expect(spellings(found, 'build')).toContain('--out');
    expect(at(found, '').subcommands).toEqual([
      { desc: 'build the app', name: 'build', tokens: ['build'] },
      { desc: 'database things', name: 'db', tokens: ['db'] },
    ]);
    expect(
      at(found, 'db migrate').options.find((opt) => opt.spellings.includes('--to'))?.values
    ).toEqual(['head', 'base']);
  });

  it('should offer the name a command routes by, not the one its module gives itself', async () => {
    // only the placeholder's name routes, so offering the module's would offer
    // a token the parser answers `Unknown command` to
    const found = await spec({
      commands: {
        outer: { load: () => Promise.resolve({ default: { desc: 'renamed', name: 'inner' } }) },
      },
      completion: false,
      help: false,
    });

    expect(paths(found)).toEqual(['', 'outer']);
    expect(at(found, '').subcommands).toEqual([
      { desc: 'renamed', name: 'outer', tokens: ['outer'] },
    ]);
  });

  it('should offer every token a command answers to, not only its name', async () => {
    // an alias is a token the parser accepts, and one that is not a prefix of
    // its own name is otherwise unreachable: nothing starting with `rm`
    // completes to `remove`
    const found = await spec({
      commands: {
        'remove, rm': { alias: 'del', desc: 'remove it', run(): void {} },
      },
      completion: false,
      help: false,
    });

    expect(at(found, '').subcommands).toEqual([
      { desc: 'remove it', name: 'remove', tokens: ['remove', 'del', 'rm'] },
    ]);
    // the path is still the canonical one, so everything keyed on it stays
    // keyed on one spelling
    expect(paths(found)).toEqual(['', 'remove']);
  });

  it('should leave out a token a sibling also answers to', async () => {
    // the registry keys its lookup by name *and* alias and a later
    // registration overwrites, so an alias a sibling's name shadows reaches
    // the sibling -- offering it would offer a token that goes elsewhere.
    // Nothing refuses such a schema, so the registry's own answer is the only
    // exact one
    const found = await spec({
      commands: {
        'build, ship': { desc: 'build it', run(): void {} },
        ship: { desc: 'ship it', run(): void {} },
      },
      completion: false,
      help: false,
    });

    // who owns it, not merely that one of them does: dropping `ship` from the
    // sibling and leaving `build` claiming it passes a count
    expect(at(found, '').subcommands).toEqual([
      { desc: 'build it', name: 'build', tokens: ['build'] },
      { desc: 'ship it', name: 'ship', tokens: ['ship'] },
    ]);
  });

  it('should leave out a command with no token left at all', async () => {
    // the registry keys by name *and* alias and a later registration
    // overwrites, so a sibling declared **after** `ship` and aliased `ship`
    // takes its own name away from it -- and a command with no token is one
    // completion cannot reach. It is also the sharper half: an empty pattern
    // list is a `case` arm reading `) ... ;;`, which is a syntax error in the
    // whole generated script rather than one command missing from it
    const found = await spec({
      commands: {
        ship: { desc: 'ship it', run(): void {} },
        'build, ship': { desc: 'build it', run(): void {} },
      },
      completion: false,
      help: false,
    });

    expect(at(found, '').subcommands).toEqual([
      { desc: 'build it', name: 'build', tokens: ['build', 'ship'] },
    ]);
    expect(paths(found)).toEqual(['', 'build']);
  });

  it('should leave out a name no shell can offer', async () => {
    // the `typeable()` rule met on a *name* rather than on a value: zsh's
    // `_describe` is line-oriented, so a newline in one breaks the element it
    // is in, and an escape in one reaches the screen on every tab
    const found = await spec({
      commands: {
        [`two${ESC}lines`]: { desc: 'unofferable', run(): void {} },
        fine: { desc: 'fine', run(): void {} },
      },
      completion: false,
      help: false,
    });

    expect(paths(found)).toEqual(['', 'fine']);
  });

  it('should leave a hidden option out', async () => {
    const found = await spec({
      completion: false,
      help: false,
      options: { '--shown': 'shown', '--secret': { desc: 'secret', hidden: true } },
    });

    expect(spellings(found, '')).toEqual(['--shown']);
  });

  it('should keep --help and --version, which are typed even though their values are not', async () => {
    // the opposite call from `slotsFor()`, and for the opposite reason: what
    // `parserOwned` says is that the option's *value* is not the app's, and
    // `--help` is a thing a user types
    const found = await spec({ version: '1.0.0' });

    expect(spellings(found, '')).toEqual(['--help', '-h', '--version', '-v']);
  });

  it("should offer an ancestor's options at a subcommand", async () => {
    const found = await spec({
      commands: { build: { options: { '--out <dir>': 'out' }, run(): void {} } },
      completion: false,
      help: false,
      options: { '--config [file]': 'config' },
    });

    expect(spellings(found, 'build')).toEqual(['--out', '--config']);
  });

  it('should let a nearer declaration shadow an outer one of the same spelling', async () => {
    // the order the registry lookup already resolves in, so offering both would
    // describe an option that does something else here
    const found = await spec({
      commands: {
        build: { options: { '--mode [m]': { choices: ['fast'], desc: 'inner' } }, run(): void {} },
      },
      completion: false,
      help: false,
      options: { '--mode [m]': { choices: ['slow'], desc: 'outer' } },
    });

    const options = at(found, 'build').options;
    expect(options).toHaveLength(1);
    expect(options[0]?.desc).toBe('inner');
    expect(options[0]?.values).toEqual(['fast']);
  });

  it('should offer both spellings of a negated flag', async () => {
    const found = await spec({
      completion: false,
      help: false,
      options: { '--no-color': 'no colour' },
    });

    expect(spellings(found, '')).toEqual(['--no-color', '--color']);
  });

  it('should offer the words a bool and a yesno take', async () => {
    const found = await spec({
      completion: false,
      help: false,
      options: {
        '--flag': 'a flag',
        '--b [v]': { desc: 'a bool', type: 'bool' },
        '--y [v]': { desc: 'a yesno', type: 'yesno' },
        '--s [v]': 'a string',
      },
    });

    const options = at(found, '').options;
    const byName = (name: string) => options.find((opt) => opt.spellings.includes(name));

    // a flag takes no value at all, so there is nothing to offer after it
    expect(byName('--flag')).toMatchObject({ takesValue: false });
    expect(byName('--flag')?.values).toBeUndefined();
    expect(byName('--b')).toMatchObject({ takesValue: true, values: ['true', 'false'] });
    expect(byName('--y')).toMatchObject({ takesValue: true, values: ['yes', 'no'] });
    // anything the type will coerce, which is where a shell falls back to files
    expect(byName('--s')?.values).toBeUndefined();
  });

  it("should offer a yesno's boolean choices as the words they are typed as", async () => {
    // a `yesno` coerces `yes` to `true`, so the tokens that reach a choice of
    // `[true, false]` are the words -- offering `true` would offer a token the
    // choice check then refuses
    const found = await spec({
      completion: false,
      help: false,
      options: { '--y [v]': { choices: [true, false], desc: 'a yesno', type: 'yesno' } },
    });

    expect(at(found, '').options[0]?.values).toEqual(['yes', 'no']);
  });

  it('should take the union of a command positional choices', async () => {
    const found = await spec({
      args: [
        { choices: ['a', 'b'], name: '[one]' },
        { choices: ['b', 'c'], name: '[two]' },
      ],
      completion: false,
      help: false,
    });

    expect(at(found, '').argValues).toEqual(['a', 'b', 'c']);
  });

  it("should offer a default command's own arguments and options at its parent", async () => {
    // a default command is dispatched when argv names no command, so it *is*
    // `contexts[0]`: a bare positional at the parent is one of its arguments
    // and its options resolve there. Measured rather than reasoned --
    // `deep --port=notanumber` answers `Invalid integer`, which is the
    // declared type doing the coercing rather than an unknown option
    const found = await spec({
      commands: {
        serve: {
          args: [{ choices: ['pub', 'www'], name: '[dir]' }],
          default: true,
          desc: 'serve it',
          options: { '--port [n]': { choices: ['80', '443'], desc: 'port' } },
          run(): void {},
        },
      },
      completion: false,
      help: false,
    });

    expect(at(found, '').argValues).toEqual(['pub', 'www']);
    expect(spellings(found, '')).toEqual(['--port']);
  });

  it("should let the parent's own declaration shadow its default's", async () => {
    // the measured order, and it is the opposite of the chain the parser
    // resolves with once the default has joined it: `sh --mode slow` takes the
    // root's choices and `sh serve --mode fast` takes serve's, over the same
    // two declarations
    const found = await spec({
      commands: {
        serve: {
          default: true,
          options: { '--mode [m]': { choices: ['fast'], desc: 'serve mode' } },
          run(): void {},
        },
      },
      completion: false,
      help: false,
      options: { '--mode [m]': { choices: ['slow'], desc: 'root mode' } },
    });

    const options = at(found, '').options;
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ desc: 'root mode', values: ['slow'] });
  });

  it('should take nothing from a hidden default command', async () => {
    // `hidden` says do not list this command, and a completion menu is a
    // listing -- including of the values it would take
    const found = await spec({
      commands: {
        '!serve': {
          args: [{ choices: ['pub'], name: '[dir]' }],
          default: true,
          options: { '--port [n]': { choices: ['80'], desc: 'port' } },
          run(): void {},
        },
      },
      completion: false,
      help: false,
    });

    expect(at(found, '').argValues).toEqual([]);
    expect(spellings(found, '')).toEqual([]);
  });

  it('should not offer a value holding a control character', async () => {
    // dropped rather than cleaned, which is the opposite call from a
    // description: a value is inserted into the command line, so a cleaned one
    // would type a token that is not the value
    const found = await spec({
      completion: false,
      help: false,
      options: { '--x [v]': { choices: [`a${ESC}b`, 'fine'], desc: 'x' } },
    });

    expect(at(found, '').options[0]?.values).toEqual(['fine']);
  });

  it("should not fall through to the type's own words when a list was declared", async () => {
    // `choices: []` is a list the parser refuses every value against, so
    // offering `true` and `false` would offer two tokens the parse rejects
    const found = await spec({
      completion: false,
      help: false,
      options: { '--b [v]': { choices: [], desc: 'nothing at all', type: 'bool' } },
    });

    expect(at(found, '').options[0]).toMatchObject({ takesValue: true });
    expect(at(found, '').options[0]?.values).toBeUndefined();
  });

  it('should drop every value holding a control character, not only the first', async () => {
    // two of them, because the pattern that answers this is asked once per
    // value: with the `g` flag on it, `test()` leaves `lastIndex` past the
    // first match and the second value is searched from part way in
    const found = await spec({
      completion: false,
      help: false,
      options: { '--x [v]': { choices: [`a${ESC}b`, `c${ESC}d`, 'fine'], desc: 'x' } },
    });

    expect(at(found, '').options[0]?.values).toEqual(['fine']);
  });

  it('should not offer an empty value, which is a candidate nothing can pick', async () => {
    const found = await spec({
      completion: false,
      help: false,
      options: { '--x [v]': { choices: ['', 'fine'], desc: 'x' } },
    });

    expect(at(found, '').options[0]?.values).toEqual(['fine']);
  });

  it('should not walk a command that reaches itself', async () => {
    // a registry holds initialized commands and `initCommand()` hands one
    // straight back, so a declaration naming a command in its own subtree is a
    // cycle rather than a copy
    const parsed = await state({ commands: { a: { run(): void {} } }, completion: false });
    const a = parsed.contexts[0]![Internal].commands.find('a')!;
    a[Internal].commands.add(a);

    expect(paths(await completionSpec(parsed))).toEqual(['', 'a', 'help']);
  });

  it('should refuse a schema with no program name to register for', async () => {
    await expect(completionSpec({ contexts: (await state({})).contexts })).rejects.toThrow(
      /declares no name/
    );
  });

  it('should refuse a program name no shell can register for', async () => {
    // a script names its program in three places and one of them is zsh's
    // `#compdef` line, which is a comment and so cannot be quoted at all
    await expect(spec({ name: 'two words' })).rejects.toThrow(/"two words" is not a name/);

    // and a leading dash, where quoting does not help: quote removal happens
    // before a builtin reads its words, so `complete -o default -F _x '-D'` is
    // `complete: -D: invalid option` and the name is never registered
    await expect(spec({ name: '-D' })).rejects.toThrow(/"-D" is not a name/);
  });

  it('should refuse a target with no context chain', async () => {
    await expect(completionSpec({ contexts: [] })).rejects.toThrow(/context chain/);
  });
});

describe('oneLine()', () => {
  it('should collapse whitespace, because every shell shows one line', () => {
    expect(oneLine('two\nlines\there')).toBe('two lines here');
    expect(oneLine('  padded  ')).toBe('padded');
  });

  it('should drop a control character, which a shell would print', () => {
    expect(oneLine(`red${ESC}[31m`)).toBe('red[31m');
  });

  it('should answer nothing for what is not a description', () => {
    expect(oneLine(undefined)).toBeUndefined();
    expect(oneLine(42)).toBeUndefined();
    expect(oneLine('   ')).toBeUndefined();
  });
});

describe('quoting', () => {
  it('should make a bash single-quoted literal of anything', () => {
    expect(bashQuote("it's")).toBe("'it'\\''s'");
    expect(bashQuote('`x` $y "z"')).toBe('\'`x` $y "z"\'');
  });

  it('should make a zsh single-quoted literal of anything', () => {
    expect(zshQuote("it's")).toBe("'it'\\''s'");
  });

  it('should escape a colon and a backslash in a zsh value', () => {
    // `_describe` reads the element itself: it splits on the first colon that
    // is not backslash-escaped, so a colon in the *value* has to be `\:` or the
    // value is cut in half -- and a backslash has to be doubled or it escapes
    // whatever follows it
    expect(zshPair('a:b', 'what')).toBe("'a\\:b:what'");
    expect(zshPair('a\\b')).toBe("'a\\\\b'");
    expect(zshPair('plain')).toBe("'plain'");
  });
});

describe('the emitted scripts', () => {
  /** An app with something hostile in every position. */
  const hostile: Schema = {
    args: [{ choices: ["a'b", 'c`d'], name: '[target]' }],
    commands: {
      "it's": { desc: 'a quote in the name', run(): void {} },
      ok: {
        desc: `back\`tick $HOME "quoted" 'single' ${ESC}[31m\nsecond\tline`,
        options: { '--x [v]': { choices: ["v'1", 'v$2'], desc: "don't `run` $this" } },
        run(): void {},
      },
    },
    name: 'mycli',
    version: '1.0.0',
  };

  it.each(SHELL_NAMES)(
    'should carry no raw control character into the %s script',
    async (shell) => {
      const script = await completionScript(await state(hostile), shell);

      // a raw escape sequence in a file the shell prints on every tab is a
      // sequence waiting to be executed, which is the rule this repository keeps
      // for what it ships. `\t`, `\n` and `\r` are the script's own formatting
      expect(script.replaceAll(/[\t\n\r]/gu, '')).not.toMatch(/\p{Cc}/u);
      expect(script).not.toContain(ESC);
    }
  );

  it.each(SHELL_NAMES)('should quote a name holding a quote, in the %s script', async (shell) => {
    const script = await completionScript(await state(hostile), shell);

    // `'it'\''s'` is close-escape-reopen, which is the only way a single-quoted
    // shell string can hold one
    expect(script).toContain("'it'\\''s'");
    // ...and never the bare name, which would end the quote and leave `s'` as
    // code
    expect(script).not.toMatch(/(?<!\\')'it's'/u);
  });

  it('should put every description inside quotes in the zsh script', async () => {
    const script = await completionScript(await state(hostile), 'zsh');

    // the description is the one thing bash never shows and zsh always does,
    // so this is where a backtick or a `$` would be executed
    expect(script).toContain("'ok:back`tick $HOME \"quoted\" '\\''single'\\'' [31m second line'");
  });

  it('should answer every command path exactly once in the bash script', async () => {
    const found = await spec(hostile);
    const script = await completionScript(await state(hostile), 'bash');

    const resolve = /__mycli_resolve\(\) \{\n([\s\S]*?)\n\}/u.exec(script)?.[1];
    expect(resolve).toBeTruthy();

    // the path a word takes you to is said once, which is what the walk reads
    // -- so the subcommand names are not written out a second time to answer
    // "is this word a command". Every path but the root, which nothing
    // resolves *to*
    const answered = [...resolve!.matchAll(/\) __mycli_next=('(?:[^']|'\\'')*') ;;/gu)].map(
      ([, p]) => p.slice(1, -1).replaceAll("'\\''", "'")
    );
    expect(answered.sort()).toEqual(
      paths(found)
        .filter((path) => path !== '')
        .sort()
    );
  });

  it('should refuse a shell it cannot emit', async () => {
    await expect(completionScript(await state({}), 'fish')).rejects.toThrow(/Unknown shell "fish"/);
  });

  it('should refuse a key it inherited rather than one it declares', async () => {
    // the rule every lookup table here keeps: the map is frozen and is not
    // null-prototype, so `SHELLS['constructor']` reads back a function and
    // would be called as an emitter
    await expect(completionScript(await state({}), 'constructor')).rejects.toThrow(
      /Unknown shell "constructor"/
    );
  });

  it('should have an emitter for every shell it names', () => {
    expect(Object.keys(SHELLS).sort()).toEqual([...SHELL_NAMES].sort());
  });
});

/**
 * What a call wrote to stdout.
 *
 * @param run - The call.
 * @returns Everything it wrote.
 */
async function written(run: () => unknown): Promise<string> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  (process.stdout as { write: unknown }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };

  try {
    await run();
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }

  return chunks.join('');
}

/**
 * What `run` wrote to stderr, and the exit code it left behind.
 *
 * A twin of `written()` rather than a parameter on it, because the two streams
 * are the whole of what this command decides between: a script goes to stdout
 * so that `> file` is the documented idiom, and instructions go to stderr so
 * that the same redirect does not fill that file with prose. A helper that took
 * the stream would let a test assert the right text on the wrong one.
 *
 * @param run - What to run.
 * @returns What reached stderr, and `process.exitCode` afterwards.
 */
async function toStderr(run: () => unknown): Promise<{ code: unknown; text: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write;
  const before = process.exitCode;
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };

  try {
    await run();
    return { code: process.exitCode, text: chunks.join('') };
  } finally {
    (process.stderr as { write: unknown }).write = write;
    // put it back, or one test asserting a failure leaves the whole run
    // reporting one -- vitest reads this process's own code
    process.exitCode = before;
  }
}

describe('the completion command', () => {
  it('should be added to every schema', async () => {
    const parsed = await state({ commands: { build: { run(): void {} } } });
    const found = parsed.contexts[0]![Internal].commands.find('completion');

    expect(found?.name).toBe('completion');
    expect(typeof found?.run).toBe('function');
    // the shells are the argument's `choices`, so help lists them and a wrong
    // value is the parser's own error rather than one of this module's
    expect(found?.[Internal].args[0]?.choices).toEqual(SHELL_NAMES);
  });

  it('should add nothing when the schema turns it off', async () => {
    const parsed = await state({ completion: false });

    expect(parsed.contexts[0]![Internal].commands.find('completion')).toBeUndefined();
  });

  it("should leave an app's own completion command alone", async () => {
    const parsed = await state({
      commands: { completion: { desc: 'mine', run: () => 'mine' } },
    });
    const found = parsed.contexts[0]![Internal].commands.find('completion');

    expect(found?.desc).toBe('mine');
    expect(found?.run?.({} as ParseState)).toBe('mine');
  });

  it("should leave an app's alias for completion alone", async () => {
    // `find()` answers about the aliases as well as the name, which is what has
    // to be free: an app whose `shell` command is aliased `completion` would
    // otherwise have that alias quietly repointed
    const parsed = await state({
      commands: { 'shell, completion': { desc: 'mine', run: () => 'mine' } },
    });
    const found = parsed.contexts[0]![Internal].commands.find('completion');

    expect(found?.name).toBe('shell');
  });

  it('should print a script through the command', async () => {
    const parsed = await parse({
      argv: ['completion', 'bash'],
      env: {},
      schema: { commands: { build: { run(): void {} } }, name: 'mycli' },
    });

    expect(await written(() => parsed.cmd?.run?.(parsed))).toContain(
      'complete -o default -F _mycli'
    );
  });

  it.each([
    ['/bin/zsh', 'zsh'],
    ['/usr/local/bin/bash', 'bash'],
    ['/opt/homebrew/bin/bash', 'bash'],
    ['bash', 'bash'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', undefined],
    ['/bin/bash5', undefined],
    ['/bin/csh', undefined],
    ['/usr/bin/fish', undefined],
    ['', undefined],
  ])('should read %s as %s', (path, shell) => {
    // the basename of either separator, because the value is a path -- and a
    // version suffix is deliberately not read, since guessing there is how
    // `csh` comes back as something it is not. The `.exe` is the same rule
    // meeting Windows: it is nothing this emits a script for, so it is no
    // answer rather than a wrong one
    expect(detectShell({ SHELL: path })).toBe(shell);
  });

  it('should read no SHELL at all as no shell', () => {
    expect(detectShell({})).toBeUndefined();
  });

  it('should say how to install for the shell it found, rather than naming the grammar', async () => {
    const parsed = await parse({
      argv: ['completion'],
      env: {},
      schema: { commands: { build: { run(): void {} } }, name: 'mycli' },
    });

    const shell = process.env['SHELL'];
    process.env['SHELL'] = '/bin/zsh';

    try {
      const { code, text } = await toStderr(() => parsed.cmd?.run?.(parsed));

      // `Missing required arguments: <shell>` is what this replaced, and the
      // thing wrong with it is that it names the grammar rather than the
      // thing to do
      expect(text).not.toContain('Missing required');
      expect(text).toContain('detected zsh');
      expect(text).toContain('mycli completion zsh > "${fpath[1]}/_mycli"');
      expect(text).toContain('Then restart your shell.');

      // stderr and non-zero, because this is the better *error* rather than
      // an answer: `mycli completion > file` must not fill the file the
      // reader wanted a script in, and a script that read the exit code
      // still sees that no shell was named
      expect(code).toBe(1);
    } finally {
      if (shell === undefined) {
        delete process.env['SHELL'];
      } else {
        process.env['SHELL'] = shell;
      }
    }
  });

  it('should name the shells where it cannot tell which one, rather than guessing', async () => {
    const parsed = await parse({
      argv: ['completion'],
      env: {},
      schema: { commands: { build: { run(): void {} } }, name: 'mycli' },
    });

    const shell = process.env['SHELL'];
    process.env['SHELL'] = '/bin/csh';

    try {
      const { code, text } = await toStderr(() => parsed.cmd?.run?.(parsed));

      // every shell it can print for, as the command to run. Not a guess at
      // `bash` because that is the commoner one: a reader in `csh` told to
      // run the bash recipe is a reader who installs nothing and does not
      // find out why
      for (const name of SHELL_NAMES) {
        expect(text).toContain(`mycli completion ${name}`);
      }

      expect(text).not.toContain('detected');
      expect(code).toBe(1);
    } finally {
      if (shell === undefined) {
        delete process.env['SHELL'];
      } else {
        process.env['SHELL'] = shell;
      }
    }
  });

  it('should say the shell is optional, which is where that spelling is visible', async () => {
    // a sabotage pass is what asked for this. `needsNoValues` skips the
    // *missing* checks, so `<shell>` and `[shell]` behave identically at the
    // throw site and every test about the no-shell path passed either way --
    // where the difference is the contract: help is what tells a reader
    // whether they have to name one, and inference types a required argument
    // as non-optional
    const state = await parse({
      argv: ['completion', '--help'],
      env: {},
      schema: { commands: { build: { run(): void {} } }, name: 'mycli' },
    });
    const help = await resolveHelp(state, { width: 80 });

    expect(help).toContain('Usage: mycli completion [options] [shell]');
    expect(help).toMatch(/\[shell\]\s+The shell to generate for/);
    expect(help).not.toContain('<shell>');
  });

  it('should still refuse a shell it has no emitter for', async () => {
    // the half that has to keep working: `[shell]` is optional and its
    // `choices` are judged on the way in, so a name is still an error. The
    // short-circuit is only over what is *missing*
    await expect(
      parse({
        argv: ['completion', 'fish'],
        env: {},
        schema: { commands: { build: { run(): void {} } }, name: 'mycli' },
      })
    ).rejects.toThrow(/Invalid value "fish"/);
  });

  it.each([...SHELL_NAMES])(
    'should carry the same install routes in the %s script as it prints as instructions',
    async (shell) => {
      // one module, two readers, and this is what says they cannot come apart:
      // every command the instructions name appears in the generated script's
      // own header, which is the reason `installHint()` is data rather than
      // text in two templates
      const parsed = await parse({
        argv: ['completion', shell],
        env: {},
        schema: { commands: { build: { run(): void {} } }, name: 'mycli' },
      });

      const script = await written(() => parsed.cmd?.run?.(parsed));

      for (const route of installHint(shell, 'mycli').routes) {
        for (const command of route.commands) {
          expect(script).toContain(command);
          expect(instructions(shell, 'mycli')).toContain(command);
        }
      }
    }
  );

  it('should print a script without the required options the app declared', async () => {
    // this used to throw `Missing required options: --token`, on the argument
    // that making it win meant a field on `ParseState` and a change to what
    // `parse()` validates for every app. The cost is smaller than that: an
    // internal `needsNoValues` on the command and one shared predicate, with
    // no public surface at all -- and what the old reading cost was the only
    // command an app cannot reimplement being unreachable on every app with a
    // required global option, which is `rq --token x completion bash` to find
    // out how to set up tab completion
    const unasked = await parse({
      argv: ['completion', 'bash'],
      env: {},
      schema: { name: 'mycli', options: { '--token <t>': 'a token' } },
    });

    expect(await written(() => unasked.cmd?.run?.(unasked))).toContain(
      'complete -o default -F _mycli'
    );

    // and passing it still works, which is the half that must not have moved:
    // what changed is whether a missing value is an *error*, not whether a
    // value argv carried is read
    const parsed = await parse({
      argv: ['--token', 'x', 'completion', 'bash'],
      env: {},
      schema: { name: 'mycli', options: { '--token <t>': 'a token' } },
    });

    expect(parsed.cmd?.name).toBe('completion');
    expect(await written(() => parsed.cmd?.run?.(parsed))).toContain(
      'complete -o default -F _mycli'
    );
  });

  it('should refuse a shell the choices do not name, through the parse', async () => {
    await expect(
      parse({ argv: ['completion', 'fish'], env: {}, schema: { name: 'mycli' } })
    ).rejects.toThrow(/fish/);
  });
});

describe('the scripts as shell programs', () => {
  const bash = whichSync('bash');
  const zsh = whichSync('zsh');
  const dir = mkdtempSync(join(tmpdir(), 'sigil-completion-'));

  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  /** An app with a nested tree, choices and a name needing quoting. */
  const app: Schema = {
    commands: {
      build: {
        args: [{ choices: ['web', 'native'], name: '[target]' }],
        desc: "build it: don't `rm -rf /` $HOME",
        options: {
          '-m, --mode [m]': { choices: ['fast', 'slow'], desc: 'how' },
          '--no-color': 'no colour',
          '--out <dir>': 'where',
          // a `:` is in the default `COMP_WORDBREAKS`, and `host:port`,
          // `pkg:version` and an image tag are ordinary values
          '--tag <t>': { choices: ['a:b', 'host:port', 'plain'], desc: 'tag' },
        },
        run(): void {},
      },
      db: { commands: { migrate: { desc: 'migrate', run(): void {} } }, desc: 'db' },
      "it's": { desc: 'a quote', run(): void {} },
      // an alias that is a prefix of nothing, so only offering it makes it
      // reachable -- and only resolving it makes the rest of the line
      // complete against `remove`
      'remove, rm': { desc: 'remove it', options: { '--force': 'force' }, run(): void {} },
    },
    name: 'mycli',
    options: { '--config [file]': 'config' },
    version: '1.0.0',
  };

  /** Writes a script out and hands back its path. */
  async function write(shell: string): Promise<string> {
    const path = join(dir, `completion.${shell}`);
    writeFileSync(path, await completionScript(await state(app), shell));
    return path;
  }

  it.skipIf(!bash)('should parse as bash', async () => {
    // the check that says the generator produced a *program* rather than
    // plausible text, over a schema whose description holds a quote, a
    // backtick, a `$` and an `rm -rf /`. What `-n` answers is **syntax**:
    // `echo $(whoami)` parses, so this cannot say the quoting is safe, and the
    // injection claim is the `quoting` block's -- which asserts the bytes --
    // plus the drivers, which run the script and read what it offered. What it
    // does catch is a quote or a pattern that ended a construct early, which
    // is how a description reaches the grammar, and it is what caught an empty
    // `case` pattern from a command with no token left
    execFileSync(bash!, ['-n', await write('bash')]);
  });

  it.skipIf(!zsh)('should parse as zsh', async () => {
    execFileSync(zsh!, ['-n', await write('zsh')]);
  });

  it.skipIf(!bash)('should insert only what readline is replacing', async () => {
    // There are **two** word models and the script has to answer both, which is
    // what makes this three regimes rather than one. bash 3.2's own manual says
    // `COMP_WORDS` is "split on shell metacharacters as the shell parser would
    // separate them"; bash 4.0 changed it to "split into words as readline
    // would split it, using COMP_WORDBREAKS". So `--tag host:port` is **one**
    // word in 3.2 and **five** in 4 and later, and `--mode=fast` is one and
    // three. That is axis one.
    //
    // Axis two is independent of it and is the one that bites: readline
    // replaces only what follows the **last** character of the word that is in
    // `$COMP_WORDBREAKS`, in every version. Measured in bash 3.2 by reading the
    // backspaces readline wrote before inserting -- `--mode=fa` then TAB erases
    // two characters -- so a candidate carrying the `--mode=` is inserted twice
    // and the line comes out `--mode=--mode=fast`. That was shipped, and so was
    // `host:host:port`; both were found by driving a real bash rather than by
    // any of the hand-fed cases below, which had the two axes conflated.
    //
    // One mechanism answers both: rejoin the words the shell split, filter a
    // candidate by the whole word, and take the kept prefix back off whatever
    // is inserted.
    const script = await write('bash');

    /**
     * @param regime - `'bash32'` is the whole word with the default breaks,
     *   `'bash5'` is the same line split the way bash 4+ splits it, and
     *   `'noBreaks'` is a shell whose `COMP_WORDBREAKS` has neither character.
     * @param words - The words that regime hands over.
     * @returns What `COMPREPLY` came back as.
     */
    const drive = (regime: 'bash32' | 'bash5' | 'noBreaks', words: string[]): string[] =>
      execFileSync(
        bash!,
        [
          // `-u` for the reason the driver above takes it: `"${empty[@]}"`
          // is an error in the bash this has to run in, and this branch has
          // an empty-array guard of its own
          '-u',
          '-c',
          [
            regime === 'noBreaks'
              ? 'COMP_WORDBREAKS="${COMP_WORDBREAKS//[=:]}"'
              : // both other regimes are the default, which really does
                // hold `=` and `:` -- asserted, so that a bash whose
                // default differs fails here rather than silently passing
                'case "$COMP_WORDBREAKS" in *=*) ;; *) echo "no = break" >&2; exit 1 ;; esac\n' +
                'case "$COMP_WORDBREAKS" in *:*) ;; *) echo "no : break" >&2; exit 1 ;; esac',
            `source ${bashQuote(script)}`,
            `COMP_WORDS=(${words.map(bashQuote).join(' ')})`,
            `COMP_CWORD=${words.length - 1}`,
            'COMPREPLY=()',
            '_mycli',
            'if [ ${#COMPREPLY[@]} -gt 0 ]; then printf \'%s\\n\' "${COMPREPLY[@]}"; fi',
          ].join('\n'),
        ],
        { encoding: 'utf8' }
      )
        .split('\n')
        .filter((line) => line !== '');

    // bash 3.2: one word, and the candidate is the part after the break
    expect(drive('bash32', ['mycli', 'build', '--mode='])).toEqual(['fast', 'slow']);
    expect(drive('bash32', ['mycli', 'build', '--mode=f'])).toEqual(['fast']);
    // a *short* option takes an attached value too -- `-p=5` resolves
    expect(drive('bash32', ['mycli', 'build', '-m='])).toEqual(['fast', 'slow']);
    // an option whose values nothing declared offers none, in every regime
    expect(drive('bash32', ['mycli', 'build', '--out='])).toEqual([]);
    // a `:` in the *value* rather than between an option and its value: the
    // candidate is filtered by the whole word and inserted from the colon on
    expect(drive('bash32', ['mycli', 'build', '--tag', ''])).toEqual(['a:b', 'host:port', 'plain']);
    expect(drive('bash32', ['mycli', 'build', '--tag', 'host:po'])).toEqual(['port']);
    expect(drive('bash32', ['mycli', 'build', '--tag', 'a:'])).toEqual(['b']);
    // ...and a value that holds one does not take the walk with it
    expect(drive('bash32', ['mycli', 'build', '--tag', 'host:port', ''])).toEqual([
      'web',
      'native',
    ]);

    // bash 4 and later, where the same lines arrive split
    expect(drive('bash5', ['mycli', 'build', '--mode', '=', ''])).toEqual(['fast', 'slow']);
    expect(drive('bash5', ['mycli', 'build', '--mode', '=', 'f'])).toEqual(['fast']);
    // the line ending on the break itself, which is a word list of its own
    expect(drive('bash5', ['mycli', 'build', '--mode', '='])).toEqual(['fast', 'slow']);
    expect(drive('bash5', ['mycli', 'build', '-m', '=', ''])).toEqual(['fast', 'slow']);
    expect(drive('bash5', ['mycli', 'build', '--out', '=', ''])).toEqual([]);
    expect(drive('bash5', ['mycli', 'build', '--tag', 'host', ':', 'po'])).toEqual(['port']);
    expect(drive('bash5', ['mycli', 'build', '--tag', 'a', ':'])).toEqual(['b']);
    expect(drive('bash5', ['mycli', 'build', '--tag', ''])).toEqual(['a:b', 'host:port', 'plain']);
    // the `=` is a word of its own and must not be read as a path component:
    // what follows it is still `build`'s, and so is what follows a split value
    expect(drive('bash5', ['mycli', 'build', '--mode', '=', 'fast', ''])).toEqual([
      'web',
      'native',
    ]);
    expect(drive('bash5', ['mycli', 'build', '--tag', 'host', ':', 'port', ''])).toEqual([
      'web',
      'native',
    ]);

    // and a shell whose `COMP_WORDBREAKS` holds neither, where readline
    // replaces the whole word and every candidate carries the prefix back
    expect(drive('noBreaks', ['mycli', 'build', '--mode='])).toEqual([
      '--mode=fast',
      '--mode=slow',
    ]);
    expect(drive('noBreaks', ['mycli', 'build', '--mode=f'])).toEqual(['--mode=fast']);
    expect(drive('noBreaks', ['mycli', 'build', '-m='])).toEqual(['-m=fast', '-m=slow']);
    expect(drive('noBreaks', ['mycli', 'build', '--tag', 'host:po'])).toEqual(['host:port']);
  });

  it.skipIf(!zsh)('should register itself for the program when it is sourced', async () => {
    // a zsh completion is normally a file on `$fpath` that ends by *calling*
    // its function, and the obvious thing to do with a command that prints one
    // is `source <(mycli completion zsh)` -- where that call runs the function
    // with no completion to do. The `$funcstack[1]` test is what makes one file
    // work both ways, and sourcing is the half only a real zsh can answer:
    // without it zsh writes four `can only be called from completion function`
    // errors and registers nothing at all
    const script = await write('zsh');
    const driver = join(dir, 'source.zsh');
    writeFileSync(
      driver,
      [
        'autoload -Uz compinit',
        'compinit -u -D 2>/dev/null',
        'source "$1"',
        'print -r -- "registered:${_comps[mycli]:-none}"',
      ].join('\n')
    );

    const out = execFileSync(zsh!, ['-f', driver, script], { encoding: 'utf8' });

    expect(out).toContain('registered:_mycli');
  });

  it.skipIf(!zsh)('should leave $PATH alone, which `local path` does not', async () => {
    // zsh's `path` is a **special** parameter tied to `PATH`, so a function
    // that declares `local path=''` runs with no `$PATH` at all -- measured,
    // `whence -p ls` finds nothing inside one. This function calls into the
    // whole completion system, which is third-party shell code that may run an
    // external command, so every local it declares carries the generated
    // prefix. The stub reports what the function sees
    const script = await write('zsh');
    const driver = join(dir, 'path.zsh');
    writeFileSync(
      driver,
      [
        'compdef() { return 0 }',
        'compset() { return 0 }',
        '_describe() { print -r -- "len:${#PATH}"; return 0 }',
        '_files() { print -r -- "len:${#PATH}"; return 0 }',
        'source "$1"',
        'shift',
        'typeset -g -a words=("$@")',
        // `${#words[@]}` rather than `$#words`, which under `ksh_arrays` is the
        // **length of element zero** -- so the driver standing in for zsh
        // handed the function a `CURRENT` of 5 for a four-word line and the
        // option before the cursor read as empty. The driver being wrong
        // about the very option it is set up to exercise is the
        // fixture-cannot-reach-the-branch shape, met in the harness
        'typeset -g -i CURRENT=${#words[@]}',
        '_mycli || true',
      ].join('\n')
    );

    const before = process.env.PATH?.length ?? 0;
    expect(before).toBeGreaterThan(0);

    const out = execFileSync(zsh!, ['-f', driver, script, 'mycli', ''], { encoding: 'utf8' });

    expect(out.trim()).toBe(`len:${before}`);
  });

  /**
   * A driver that stubs zsh's completion system and reports what it was asked.
   *
   * The completion system stubbed rather than a pty driven: what is being
   * asserted is that the function asks the right questions with the right data,
   * and `_describe`, `_files` and `compset` actually doing their jobs is zsh's
   * claim rather than this file's. No pty, no sleeps, no timing -- which is the
   * shape this repository insists on after a timing test flaked one busy
   * machine later.
   *
   * `$FN` names the function to call, defaulting to `_mycli`.
   *
   * @param name - A file name of its own, so two tests do not share a path.
   * @param options - `setopt` lines to run before the script is sourced, for
   *   the options a user's own `.zshrc` may be in.
   * @returns The driver's path.
   */
  function zshDriver(name: string, options: readonly string[] = []): string {
    const driver = join(dir, name);
    writeFileSync(
      driver,
      [
        ...options,
        'compdef() { return 0 }',
        'compset() { print -r -- "call:compset $*"; return 0 }',
        '_describe() {',
        '\tlocal name=${@[-1]}',
        '\tlocal -a vals',
        '\teval "vals=(\\"\\${${name}[@]}\\")"',
        '\tlocal v',
        '\tfor v in "${vals[@]}"; do print -r -- "cand:$v"; done',
        '\treturn 0',
        '}',
        "_files() { print -r -- 'call:files'; return 0 }",
        'source "$1"',
        'shift',
        'typeset -g -a words=("$@")',
        // `${#words[@]}` rather than `$#words`, which under `ksh_arrays` is the
        // **length of element zero** -- so the driver standing in for zsh
        // handed the function a `CURRENT` of 5 for a four-word line and the
        // option before the cursor read as empty. The driver being wrong
        // about the very option it is set up to exercise is the
        // fixture-cannot-reach-the-branch shape, met in the harness
        'typeset -g -i CURRENT=${#words[@]}',
        // `|| true`, because a completion function answers non-zero when it
        // has no matches and that is the terminator's correct answer
        // the function to call comes from the environment rather than from a
        // positional, because the positionals *are* the command line
        '${FN:-_mycli} || true',
      ].join('\n')
    );
    return driver;
  }

  it.skipIf(!zsh)('should complete what the spec says, driven in a real zsh', async () => {
    // zsh filters by prefix itself, inside `_describe`, so the function offers
    // the whole set at a position and the current word narrows it. bash is the
    // other way round and filters in the script, which is why the two drivers
    // expect different things for the same line
    const script = await write('zsh');
    const driver = zshDriver('drive.zsh');

    /** What the stubs saw, for one command line. */
    const drive = (words: string[]): string[] =>
      execFileSync(zsh!, ['-f', driver, script, ...words], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line !== '');

    // the hostile description arrives intact and inert: the backtick and the
    // `$HOME` are printed rather than run, which is what the quoting is for
    const described = `cand:build:${(app.commands as Record<string, { desc: string }>).build.desc}`;

    expect(drive(['mycli', ''])).toEqual([
      described,
      'cand:completion:Print a shell completion script',
      'cand:db:db',
      'cand:help:Show help for a command',
      "cand:it's:a quote",
      // the alias carries its command's description, which is what makes a
      // doubled entry read as one thing in a zsh menu
      'cand:remove:remove it',
      'cand:rm:remove it',
    ]);

    expect(drive(['mycli', 'rm', '--'])).toContain('cand:--force:force');

    expect(drive(['mycli', 'db', ''])).toEqual(['cand:migrate:migrate']);
    expect(drive(['mycli', 'build', ''])).toEqual(['cand:web', 'cand:native']);
    expect(drive(['mycli', 'build', '--mode', ''])).toEqual(['cand:fast', 'cand:slow']);

    // the one path that strips a prefix off the match, and what this asserts is
    // the *call* rather than the insertion: the stub answers 0 without
    // touching the word, so a `compset` that stripped the wrong amount looks
    // identical here. Which is why the offset is in the assertion -- `--mode`
    // is six characters, so the prefix is seven -- and why what happens to the
    // word is the pty test's claim rather than this one's. `-p N` rather than
    // `-P '*='`, because that pattern is greedy and a value holding an `=`
    // loses everything up to its last one
    expect(drive(['mycli', 'build', '--mode=f'])).toEqual([
      'call:compset -p 7',
      'cand:fast',
      'cand:slow',
    ]);

    // the short spelling takes an attached value too, and the offset follows
    // the spelling that was typed rather than the longest one
    expect(drive(['mycli', 'build', '-m='])).toEqual([
      'call:compset -p 3',
      'cand:fast',
      'cand:slow',
    ]);

    // an option whose values nothing declared, and the terminator -- which
    // offers files rather than giving up, so that the two emitters agree about
    // a line bash answers with `-o default`
    expect(drive(['mycli', 'build', '--out', ''])).toEqual(['call:files']);
    expect(drive(['mycli', 'build', '--', ''])).toEqual(['call:files']);

    // a word that extends no known path leaves the path where it was
    expect(drive(['mycli', 'nope', ''])).toContain(described);
  });

  it.skipIf(!zsh)('should walk a path under a user who set ksh_arrays', async () => {
    // `ksh_arrays` makes every array zero-based, so `${line[2]}` is the *third*
    // word rather than the second and the walk skips one: measured, `mycli db
    // <TAB>` offered the root's commands. `setopt localoptions no_ksh_arrays`
    // is the whole fix, and it is one option rather than `emulate -L zsh` --
    // which was the first fix and broke a real completion, because
    // `localoptions` scopes over everything the function calls and `_files`
    // then failed with `no matches found: *:globbed-files`
    const script = await write('zsh');
    const driver = zshDriver('ksh.zsh', ['setopt ksh_arrays']);
    const drive = (words: string[]): string[] =>
      execFileSync(zsh!, ['-f', driver, script, ...words], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line !== '');

    expect(drive(['mycli', 'db', ''])).toEqual(['cand:migrate:migrate']);
    expect(drive(['mycli', 'build', '--mode', ''])).toEqual(['cand:fast', 'cand:slow']);
  });

  it.skipIf(!zsh)('should offer subcommands and arguments together', async () => {
    // `_describe` answers zero when it had nothing to offer, so a zsh function
    // written as `_subs && return` stops at the subcommands and never reaches
    // the arguments -- and a parent with both is ordinary, because a `default`
    // command's own positionals are offered at its parent. bash adds both
    // lists to one `COMPREPLY`, so this is the shape the two emitters had
    // disagreed about
    const both: Schema = {
      commands: {
        db: { commands: { migrate: { desc: 'migrate', run(): void {} } }, desc: 'db' },
        serve: {
          args: [{ choices: ['pub', 'priv'], name: '[dir]' }],
          default: true,
          desc: 'serve',
          run(): void {},
        },
      },
      help: false,
      name: 'both',
    };

    const path = join(dir, 'both.zsh');
    writeFileSync(path, await completionScript(await state(both), 'zsh'));
    const driver = zshDriver('both-drive.zsh');
    const out = execFileSync(zsh!, ['-f', driver, path, 'both', ''], {
      encoding: 'utf8',
      env: { ...process.env, FN: '_both' },
    });

    expect(out.split('\n').filter((line) => line !== '')).toEqual([
      'cand:completion:Print a shell completion script',
      'cand:db:db',
      'cand:serve:serve',
      'cand:pub',
      'cand:priv',
    ]);
  });

  it.skipIf(!bash)('should define the function it tells bash to call', async () => {
    // the one thing in either script that cannot be quoted is the *function
    // name*, so a program name holding a shell metacharacter is the injection
    // a quote cannot close: `_my;cli() { ... }` parses, defines a function
    // called `cli`, and leaves `complete -F _my` naming one that is not there
    const script = join(dir, 'named.bash');
    writeFileSync(script, await completionScript(await state({ ...app, name: 'my;cli' }), 'bash'));

    // read the name out of the registration rather than writing it down here,
    // so what is asserted is that the two agree rather than what either says
    const named = /^complete .*-F (\S+) /mu.exec(readFileSync(script, 'utf8'))?.[1];
    expect(named).toBeTruthy();

    // quoted, because the mangling this is about is a *split*: unquoted,
    // `declare -F _my;cli` is `declare -F _my` -- which fails -- followed by
    // `cli`, which the broken definition really did define, so the script
    // exits zero and the test passes over the defect it is named for
    execFileSync(bash!, [
      '-c',
      `source ${bashQuote(script)}\ndeclare -F ${bashQuote(named!)} > /dev/null`,
    ]);
  });

  it.skipIf(!bash)('should complete what the spec says, driven in a real bash', async () => {
    // `readline` calls the function with `COMP_WORDS` and `COMP_CWORD` set and
    // reads `COMPREPLY` back, so doing exactly that is the end-to-end check --
    // and `-u` is on, because a user's shell may have it and bash 3.2 errors on
    // `"${empty[@]}"`
    const script = await write('bash');
    const cases: [string[], string[]][] = [
      [
        ['mycli', ''],
        ['build', 'completion', 'db', 'help', "it's", 'remove', 'rm'],
      ],
      [['mycli', 'b'], ['build']],
      [['mycli', 'db', ''], ['migrate']],
      [
        ['mycli', 'build', ''],
        ['web', 'native'],
      ],
      // declaration order within the command, then the ancestors' outward,
      // which is the order the registry resolves in
      [
        ['mycli', 'build', '--'],
        ['--mode', '--no-color', '--color', '--out', '--tag', '--config', '--help', '--version'],
      ],
      [
        ['mycli', 'build', '--mode', ''],
        ['fast', 'slow'],
      ],
      // bash breaks `--mode=` into three words, so the option is two back
      [
        ['mycli', 'build', '--mode', '=', ''],
        ['fast', 'slow'],
      ],
      // `--out` takes a value, so `build` is that value rather than a command:
      // the path stays at the root and the root's commands are what is offered
      [
        ['mycli', '--config', 'build', ''],
        ['build', 'completion', 'db', 'help', "it's", 'remove', 'rm'],
      ],
      // nothing at all after the terminator, which is where extra arguments go
      [['mycli', 'build', '--', ''], []],
      // an option whose values nothing declared: the script offers none and
      // `-o default` is what makes a file the answer. Both spellings, because
      // the `=` form has a branch of its own -- and `"${empty[@]}"` under
      // `-u` is an error in the bash this has to run in, so each branch needs
      // its own guard and each guard needs its own case
      [['mycli', 'build', '--out', ''], []],
      [['mycli', 'build', '--out', '=', ''], []],
      [['mycli', 'i'], ["it's"]],
      [
        ['mycli', 'r'],
        ['remove', 'rm'],
      ],
      // the alias resolved: these are `remove`'s own options rather than the
      // root's, which is what says the walk followed it
      [['mycli', 'rm', '--f'], ['--force']],
      // a `cur` with a glob in it: the filter is `case "$c" in "$cur"*)`,
      // where the quoted half is literal, so `*` matches a name beginning
      // with one and there is none. Unquoted it is a pattern and matches
      // everything, which is a menu of every command for a word that is
      // prefix to none of them
      [['mycli', '*'], []],
      // an option's value attached with an `=`, where the value is also a
      // command name: the `=` arrives as a word of its own and the value has
      // still to come, so the skip has to survive it
      [
        ['mycli', '--config', '=', 'build', ''],
        ['build', 'completion', 'db', 'help', "it's", 'remove', 'rm'],
      ],
      // a word that extends no known path is not a command, so the path stays
      // where it was rather than moving somewhere nothing is offered
      [
        ['mycli', 'nope', ''],
        ['build', 'completion', 'db', 'help', "it's", 'remove', 'rm'],
      ],
    ];

    for (const [words, expected] of cases) {
      const driver = [
        `source ${bashQuote(script)}`,
        `COMP_WORDS=(${words.map(bashQuote).join(' ')})`,
        `COMP_CWORD=${words.length - 1}`,
        'COMPREPLY=()',
        '_mycli',
        'if [ ${#COMPREPLY[@]} -gt 0 ]; then printf \'%s\\n\' "${COMPREPLY[@]}"; fi',
      ].join('\n');

      const out = execFileSync(bash!, ['-u', '-c', driver], { encoding: 'utf8' });
      const got = out.split('\n').filter((line) => line !== '');

      expect(got, words.join(' ')).toEqual(expected);
    }
  });
});
