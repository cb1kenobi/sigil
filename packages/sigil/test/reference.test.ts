import { completionSpec } from '../src/completion/spec.js';
import { commandCatalog } from '../src/components/catalog.js';
import { initCommand } from '../src/parser/command/init-command.js';
import { parse } from '../src/parser/parse.js';
import {
  commandSurface,
  type CommandSurface,
  type SurfaceCommand,
} from '../src/reference/index.js';
import { Internal, type CommandExample, type Schema } from '../src/types.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Its own fixture directory, so that nothing else in the suite imports what is
 * in it: the ESM loader caches a module, so a counter shared with another
 * test's fixture reads as unchanged whichever test ran first -- which is the
 * trap the completion fixtures already carry a comment about.
 */
const fixtures = join(here, 'fixtures/reference/commands');

/** The surface for an app, which is what a reference is printed from. */
async function surface(schema: Schema): Promise<CommandSurface> {
  return await commandSurface({ name: 'mycli', ...schema });
}

/** The command paths a surface holds, in the order it holds them. */
function paths(it: CommandSurface): string[] {
  return it.commands.map((cmd) => cmd.path.join(' '));
}

/** One command out of a surface, by its path. */
function at(it: CommandSurface, path: string): SurfaceCommand {
  const found = it.commands.find((cmd) => cmd.path.join(' ') === path);

  if (!found) {
    throw new Error(`No "${path}" in the surface: ${JSON.stringify(paths(it))}`);
  }
  return found;
}

/** One option out of a command, by a spelling that reaches it. */
function opt(cmd: SurfaceCommand, spelling: string) {
  const found = cmd.options.find((it) => it.long.includes(spelling) || it.short.includes(spelling));

  if (!found) {
    throw new Error(
      `No "${spelling}" at "${cmd.path.join(' ')}": ${JSON.stringify(
        cmd.options.map((it) => [...it.long, ...it.short])
      )}`
    );
  }
  return found;
}

describe('the command surface', () => {
  it('should refuse an app that declares no name', async () => {
    // a reference has to say what to type. `completionSpec()` refuses a missing
    // name too and the two refusals are **not** one -- it cleans the name with
    // `oneLine()` first and refuses a leading dash, where this refuses what that
    // one merely strips and accepts a dash. The test below is the half that
    // separates them; this one is the case both answer the same way
    await expect(commandSurface({ commands: {} })).rejects.toThrow(/declares no name/u);
    await expect(commandSurface({ name: '   ' })).rejects.toThrow(/declares no name/u);
  });

  it('should refuse a name a reference could not print', async () => {
    // the other two thirds of that refusal, which the test above cannot reach:
    // the name is trimmed first, so a whitespace-only one is already the empty
    // case -- what needs its own input is whitespace *inside* a name and a
    // control character in one. Measured before the guard was written: a name
    // holding a newline produced a second `#` heading in the generated page and
    // split a table row, and the front-matter title carried the raw byte. Found
    // by review
    for (const name of ['my cli', 'my\ncli', 'my\u0001cli']) {
      await expect(commandSurface({ name }), name).rejects.toThrow(/holds (a control|whitespace)/u);
    }
  });

  it('should not print the name it is refusing', async () => {
    // a refusal is a message, and `errorHandler()` writes one to stderr -- so a
    // raw escape in `schema.name` ran on the terminal of whoever built the app,
    // which is this repository's rule about what ships arriving through the one
    // path that is supposed to be the safe one. Measured: the message held the
    // `ESC` byte. So it says what is wrong rather than showing it. Found by
    // review
    for (const name of ['\u001b]8;;x\u0007', 'my\ncli', 'my\u0001cli']) {
      const err = await commandSurface({ name }).then(
        () => new Error('accepted'),
        (it: unknown) => it as Error
      );

      expect(err.message, name).not.toMatch(/\p{Cc}/u);
      expect(err.message, name).not.toContain('cli');
      expect(err.message, name).toContain('holds');
    }
  });

  it('should order the walk by code unit rather than by the machine locale', async () => {
    // the order a *reference* reads in, which is this walk's own: a page order
    // decided by `localeCompare` is one that differs between a German CI runner
    // and an English one, and the markdown is a committed artifact. `Zed`
    // before `ant` is the discriminator -- ICU puts the lowercase word first in
    // every locale there is, and a code-unit sort puts every uppercase letter
    // before every lowercase one. Found by review
    const it = await surface({ commands: { Zed: { run() {} }, ant: { run() {} } } });

    expect(paths(it)).toStrictEqual(['', 'Zed', 'ant']);
    // the discriminator said out loud, so this cannot quietly become a test
    // about two names the two orders happen to agree about
    expect('Zed'.localeCompare('ant')).toBeGreaterThan(0);
  });

  it('should record which path has a handler and which is only a namespace', async () => {
    // both are a thing argv reaches: a namespace with no `index` module lists
    // its children and has no `run`, so one gaining a handler is a path that
    // did nothing and now does something. Found by review
    const it = await surface({ baseDir: fixtures, commands: '.' });

    expect(at(it, 'nested')?.runnable).toBe(false);
    expect(at(it, 'nested deep')?.runnable).toBe(true);
    // and the root's, which is a schema with no `run` of its own
    expect(at(it, '')?.runnable).toBe(false);
  });

  it('should record which command a bare invocation runs', async () => {
    // a `default` command is dispatched when argv named none, so moving the
    // mark changes what `mycli` on its own does -- which is a surface change
    // nothing recorded. Found by review
    const it = await surface({
      commands: { go: { default: true, run() {} }, stay: { run() {} } },
    });

    expect(at(it, 'go')?.default).toBe(true);
    expect(at(it, 'stay')?.default).toBe(false);
    expect(at(it, '')?.default).toBe(false);
  });

  it('should hold the root as a command of its own', async () => {
    const it = await surface({
      args: ['[where]'],
      desc: 'A program',
      options: { '--verbose': { type: 'bool' } },
    });

    expect(it.program).toBe('mycli');
    expect(at(it, '').desc).toBe('A program');
    expect(at(it, '').args.map((arg) => arg.name)).toStrictEqual(['where']);
    expect(opt(at(it, ''), '--verbose').takesValue).toBe(false);
  });

  it('should record every command pre-order, parents before their own children', async () => {
    const it = await surface({
      commands: {
        db: { commands: { migrate: { run() {} }, seed: { run() {} } } },
        zed: { run() {} },
      },
    });

    // depth-first in name order, which is the order a reference reads in: a
    // command is followed by what is under it rather than by its siblings
    expect(paths(it)).toStrictEqual(['', 'db', 'db migrate', 'db seed', 'zed']);
  });

  it('should keep an argument in declaration order, which is its position', async () => {
    const it = await surface({
      commands: { copy: { args: ['<from>', '<to>', '[rest...]'], run() {} } },
    });

    expect(at(it, 'copy').args.map((arg) => arg.name)).toStrictEqual(['from', 'to', 'rest']);
    expect(at(it, 'copy').args.map((arg) => [arg.required, arg.multiple])).toStrictEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
  });

  it('should record a hidden command, where a catalog leaves it out', async () => {
    const schema: Schema = {
      name: 'mycli',
      commands: { seen: { run() {} }, unseen: { hidden: true, run() {} } },
    };
    const it = await commandSurface(schema);
    const root = await initCommand({ ...schema });

    // the sharpest difference between the two readers, and the reason the
    // surface records `hidden` rather than filtering on it: a hidden command is
    // not listed and is still reachable, so a *reference* leaves it out and a
    // *snapshot* has to record it -- hiding one is not the same as removing it
    expect(paths(it)).toContain('unseen');
    expect(at(it, 'unseen').hidden).toBe(true);
    expect(commandCatalog({ contexts: [root] }).map((entry) => entry.label)).not.toContain(
      'unseen'
    );
  });

  it('should keep the framework out, because it records what the app declared', async () => {
    const schema: Schema = { name: 'mycli', commands: { go: { run() {} } }, version: '1.0.0' };
    const it = await commandSurface(schema);
    const state = await parse({ argv: [], env: {}, schema });

    // `help`, `completion`, `--help` and `--version` are added by `parse()`, so
    // a surface built from the schema simply does not have them -- which is the
    // answer rather than a filter: an app's snapshot should move when the app
    // moves and not when the framework does. The parse is here to say they are
    // real rather than that the schema never had them
    expect(paths(it)).toStrictEqual(['', 'go']);
    expect([...state.contexts[0]![Internal].commands.keys()]).toEqual(
      expect.arrayContaining(['help', 'completion'])
    );
    expect(at(it, '').options).toStrictEqual([]);
  });

  describe('an option', () => {
    it('should record only the spellings that reach it', async () => {
      // `initOption()` puts a negated flag's positive spelling in its own
      // `long`, and `OptionRegistry.add()` then gives that spelling to the
      // valued twin where there is one -- so a declaration's list over-reports,
      // and a reference built from it would say `--cheese` reaches the off
      // switch
      const it = await surface({
        commands: {
          eat: { options: { '--cheese <type>': {}, '--no-cheese': {} }, run() {} },
        },
      });
      const eat = at(it, 'eat');

      expect(opt(eat, '--cheese').takesValue).toBe(true);
      expect(opt(eat, '--no-cheese').long).toStrictEqual(['--no-cheese']);
    });

    it('should not record a short spelling a sibling option took', async () => {
      // the *short* half of the same rule, and it needs its own input: a
      // negated flag's implied positive spelling is a **long** one, so the
      // negated case never reaches `short`. `OptionRegistry.add()` writes
      // `#chars[alias] = key` with no `??=`, so a later option declaring the
      // same short name simply takes it -- and `-c` documented on both would be
      // a reference saying a token reaches an option it does not
      const it = await surface({
        commands: {
          go: {
            options: { '-c, --cheese [t]': {}, '-c, --count': { type: 'bool' } },
            run() {},
          },
        },
      });

      expect(opt(at(it, 'go'), '--cheese').short).toStrictEqual([]);
      expect(opt(at(it, 'go'), '--count').short).toStrictEqual(['-c']);
    });

    it('should keep a lone negated flag answering to both spellings', async () => {
      // nothing else claims the positive form, so the registry gives it to the
      // negated flag and it really does resolve -- which is what makes dropping
      // it from a snapshot a surface change
      const it = await surface({
        commands: { build: { options: { '--no-clean': {} }, run() {} } },
      });

      expect(opt(at(it, 'build'), '--no-clean').long).toStrictEqual(['--no-clean', '--clean']);
      expect(opt(at(it, 'build'), '--no-clean').negate).toBe(true);
    });

    it('should spell a choice the way argv has to type it', async () => {
      // a `yesno` coerces `yes` to `true`, so a declaration whose choices are
      // the booleans is reachable only by the words. Shared with the completion
      // spec rather than worked out again, because "what can be typed here" has
      // one right answer
      const it = await surface({
        commands: {
          go: { options: { '--sure [yn]': { choices: [true, false], type: 'yesno' } }, run() {} },
        },
      });

      expect(opt(at(it, 'go'), '--sure').choices).toStrictEqual(['yes', 'no']);
    });

    it('should not add the words a bare bool takes, which only a menu wants', async () => {
      // `valuesFor()` offers `true`/`false` for a flagless `bool` because a
      // completion menu has nothing else to put there. A reference records what
      // the *declaration* said, and the type already says the rest
      const it = await surface({
        commands: { go: { options: { '--mode [m]': { type: 'bool' } }, run() {} } },
      });

      expect(opt(at(it, 'go'), '--mode').choices).toStrictEqual([]);
    });

    it('should be its own declaration and not its ancestors', async () => {
      // options resolve across the whole chain, so recording the chain would
      // put a root option in every command's entry and make one declaration N
      // diffs. The inheritance is a fact about the parser, so a printer says it
      // once
      const it = await surface({
        commands: { go: { options: { '--near': { type: 'bool' } }, run() {} } },
        options: { '--far': { type: 'bool' } },
      });

      expect(at(it, 'go').options.flatMap((o) => o.long)).toStrictEqual(['--near']);
      expect(at(it, '').options.flatMap((o) => o.long)).toStrictEqual(['--far']);
    });

    it('should record a hidden option, for the reason a hidden command is recorded', async () => {
      const it = await surface({
        commands: { go: { options: { '--secret': { hidden: true, type: 'bool' } }, run() {} } },
      });

      expect(opt(at(it, 'go'), '--secret').hidden).toBe(true);
    });

    it('should record the environment variables an argument reads', async () => {
      // an argument reads them exactly as an option does -- `initArg()` stores
      // `envs` and `envValue()` reads them with the same first-wins rule -- and
      // this recorded none, so renaming one could not fail a check. In
      // declaration order, because that order is the precedence. Found by review
      const it = await surface({
        commands: { go: { args: [{ env: ['ENTRY', 'FALLBACK'], name: '<entry>' }], run() {} } },
      });

      expect(at(it, 'go').args[0]?.env).toStrictEqual(['ENTRY', 'FALLBACK']);
    });

    it('should record a default, and not a flag\u2019s implied one', async () => {
      // help's own test: a flag's implied `false` is noise rather than
      // information, so it is dropped there and here -- and this is what the
      // *markdown* prints, where the page said less than `--help` about the same
      // declaration. The snapshot drops it deliberately. Found by review
      const it = await surface({
        commands: {
          go: {
            options: { '--flag': { type: 'bool' }, '--out [dir]': { default: 'dist' } },
            run() {},
          },
        },
      });
      const option = (name: string) => at(it, 'go').options.find((opt) => opt.name === name);

      expect(option('out')?.default).toBe('dist');
      expect(option('flag')?.default).toBeUndefined();
    });

    it('should keep an example help would print, whatever it labelled it', async () => {
      // help's `exampleList()` keeps any entry with a truthy `text` and prints the
      // label only where there is one, and requiring a `label` too dropped the
      // example from the reference -- which is the one place a reference may not
      // say less than help about what it was given. Found by review
      const it = await surface({
        commands: {
          go: {
            // `CommandExample.label` is **required** in the declaration type, so
            // this shape is reachable from JavaScript rather than from
            // TypeScript. The cast is here rather than the type being widened,
            // because that is a change to `Command`'s own public types and what
            // is being fixed is that help tolerates the shape and the reference
            // did not
            examples: [
              { text: 'mycli go --now' },
              { label: 'Later' },
            ] as unknown as CommandExample[],
            run() {},
          },
        },
      });

      // the one with text, and not the one without: an example with no command
      // line is nothing help prints either
      expect(at(it, 'go').examples).toStrictEqual([{ label: undefined, text: 'mycli go --now' }]);
    });

    it('should record the environment variables it reads', async () => {
      const it = await surface({
        commands: { go: { options: { '--port [n]': { env: ['PORT', 'SERVER_PORT'] } }, run() {} } },
      });

      // in declaration order, because normalizing an order belongs to the
      // projection that wants a stable diff rather than to the walk
      expect(opt(at(it, 'go'), '--port').env).toStrictEqual(['PORT', 'SERVER_PORT']);
    });
  });

  describe('a command', () => {
    it('should record every token that reaches it, the name first', async () => {
      const it = await surface({
        commands: { remove: { alias: ['rm', 'del'], run() {} } },
      });

      expect(at(it, 'remove').tokens).toStrictEqual(['remove', 'del', 'rm']);
    });

    it('should not record an alias a sibling answers to', async () => {
      // the registry keys its lookup by name *and* alias and a later
      // registration overwrites, so an alias a sibling also answers to belongs
      // to the sibling -- documenting it here would document a path the parser
      // sends somewhere else. `tokensFor()` is the completion spec's own answer
      const it = await surface({
        commands: { ship: { alias: 'go', run() {} }, zoom: { alias: 'go', run() {} } },
      });

      const tokens = [at(it, 'ship').tokens, at(it, 'zoom').tokens];
      expect(tokens.flat().filter((token) => token === 'go')).toHaveLength(1);
    });

    it('should skip a command no token reaches at all', async () => {
      // a sibling's alias can shadow a command's own *name*, which leaves it
      // with nothing to be typed as -- and a reference page for a command
      // nobody can run is a page naming a path the parser refuses
      const it = await surface({
        commands: { gone: { run() {} }, other: { alias: 'gone', run() {} } },
      });

      expect(paths(it)).not.toContain('gone');
      expect(paths(it)).toContain('other');
    });

    it('should normalize examples, dropping one with a hole in it', async () => {
      const it = await surface({
        commands: {
          go: {
            examples: [{ label: 'The usual', text: 'mycli go' }, { label: 'No text' } as never],
            run() {},
          },
        },
      });

      expect(at(it, 'go').examples).toStrictEqual([{ label: 'The usual', text: 'mycli go' }]);
    });

    it('should take one example on its own, not only a list of them', async () => {
      const it = await surface({
        commands: { go: { examples: { label: 'The usual', text: 'mycli go' }, run() {} } },
      });

      expect(at(it, 'go').examples).toHaveLength(1);
    });

    it('should stop at a cycle rather than walking it', async () => {
      // a registry holds initialized commands and `initCommand()` hands one
      // straight back, so a declaration naming a command already in its own
      // subtree is a cycle rather than a copy
      const inner = await initCommand({ name: 'inner', run() {} });
      const outer = await initCommand({ commands: { inner }, name: 'outer' });
      inner[Internal].commands.add(outer);

      const it = await commandSurface({ commands: { outer }, name: 'mycli' });

      expect(paths(it)).toStrictEqual(['', 'outer', 'outer inner']);
    });
  });

  describe('a routed tree', () => {
    it('should read a directory, with what each module declares', async () => {
      // nothing lifts an option, so a surface over a routed app is the proof
      // that the modules were imported: `--deep` is declared *inside*
      // `nested/deep.js` and there is no other way to know it is there
      const it = await surface({ baseDir: fixtures, commands: '.' });

      expect(paths(it)).toStrictEqual(['', 'nested', 'nested deep', 'top']);
      expect(at(it, 'top').desc).toBe('A top-level command');
      expect(opt(at(it, 'nested deep'), '--deep').takesValue).toBe(true);
      expect(at(it, 'nested deep').args.map((arg) => arg.name)).toStrictEqual(['what']);
    });
  });

  it('should reach every command the completion spec reaches', async () => {
    // the differential that keeps the two walks from drifting about the thing
    // they do agree on, which is which paths exist. They answer different
    // questions -- a namespace is noise to a catalog and every option is a
    // candidate to a shell -- and neither is derivable from the other, so this
    // is what says a third reader of one registry is still one answer
    const schema: Schema = {
      baseDir: fixtures,
      commands: '.',
      completion: false,
      help: false,
      name: 'mycli',
    };
    // `baseDir` as the third argument, which is how `parse()` passes it and how
    // `commandSurface()` does: without it a relative `commands` resolves from
    // the process's working directory, which here is the repository root
    const root = await initCommand({ ...schema }, undefined, schema.baseDir);
    const spec = await completionSpec({ contexts: [root], schema });
    const it = await commandSurface(schema);

    expect(paths(it).sort()).toStrictEqual(spec.commands.map((cmd) => cmd.path.join(' ')).sort());

    // and what that set **is**, because the differential alone cannot see a
    // command the two walks both drop: they share the cycle guard and the route
    // reader, so an answer of nothing at all satisfied a comparison of two
    // sorted lists. Found by review
    expect(paths(it).sort()).toStrictEqual(['', 'nested', 'nested deep', 'top']);

    // and the surface's own order, which the sorted comparison destroys: the
    // walk is pre-order, so a parent precedes its children and the markdown's
    // page order is the command tree's rather than the alphabet's
    expect(paths(it)).toStrictEqual(['', 'nested', 'nested deep', 'top']);
  });
});
