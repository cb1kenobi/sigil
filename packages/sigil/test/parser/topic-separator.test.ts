import { renderHelp, resolveHelp } from '../../src/help/index.js';
import { initCommand } from '../../src/parser/command/init-command.js';
import { initOption } from '../../src/parser/option/init-option.js';
import { parse } from '../../src/parser/parse.js';
import { Internal, type Schema } from '../../src/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routes = path.join(__dirname, 'fixtures/routes');

/**
 * `mycli db:migrate:up` is oclif's spelling of a command path, and it is a
 * tokenizer alias over the tree the parser already walks rather than a second
 * way of resolving anything. Routes are untouched: `db/migrate/up.js` produces
 * the same tree either way.
 *
 * The hazard is that a positional value holds a colon all the time -- a URL,
 * `host:port`, `node:22`, `10:30` -- so the whole feature rests on one rule:
 * the token is tried whole first, then split, and the split is used only when
 * **every** segment resolves as a command against successively inner contexts.
 */
describe('topicSeparator', () => {
  const inline = () => ({
    args: ['[target]'],
    commands: {
      db: {
        args: ['[dsn]'],
        commands: {
          migrate: {
            commands: { up: { run: () => 'up' } },
            options: { '--steps [n]': 'how many' },
            run: () => 'migrate',
          },
        },
        options: { '--dsn [url]': 'where' },
        run: () => 'db',
      },
      fetch: { args: ['[url]'], run: () => 'fetched' },
    },
    name: 'mycli',
    options: { '-v, --verbose': 'noisy' },
    topicSeparator: ':' as const,
  });

  describe('the declaration', () => {
    it('should default to the space form', async () => {
      // nothing is split, so a coloned token stays the value it was -- which is
      // what makes the default an off switch rather than a rare separator
      const result = await parse({
        argv: ['db:migrate'],
        schema: { args: ['[target]'], commands: { db: { commands: { migrate: {} } } } },
      });
      expect(result.cmd).to.equal(undefined);
      expect(result.argv.target).to.equal('db:migrate');
    });

    it('should accept the space form written out', async () => {
      const result = await parse({
        argv: ['db'],
        schema: { commands: { db: { run: () => 'db' } } as never, topicSeparator: ' ' },
      });
      expect(result.cmd?.name).to.equal('db');
    });

    it('should refuse a separator that is neither', async () => {
      // the rule a non-boolean `hidden` already follows: a declaration that
      // cannot mean anything fails where it was written
      await expect(parse({ argv: [], schema: { topicSeparator: '/' as never } })).rejects.toThrow(
        new TypeError('Expected topicSeparator to be " " or ":", not "/"')
      );
    });

    it('should refuse it on every run rather than on the one that types a colon', async () => {
      // asked unconditionally, the way `formats` is: only a coloned token would
      // ever read the answer, so an app with a bad one would run for months
      await expect(
        parse({ argv: ['build'], schema: { commands: { build: {} }, topicSeparator: 2 as never } })
      ).rejects.toThrow(new TypeError('Expected topicSeparator to be " " or ":", not 2'));
    });
  });

  describe('resolving a path', () => {
    it('should resolve a two-segment token', async () => {
      const result = await parse({ argv: ['db:migrate'], schema: inline() });
      expect(result.cmd?.name).to.equal('migrate');
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['migrate', 'db', 'mycli']);
    });

    it('should resolve a three-segment token', async () => {
      const result = await parse({ argv: ['db:migrate:up'], schema: inline() });
      expect(result.cmd?.name).to.equal('up');
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['up', 'migrate', 'db', 'mycli']);
    });

    it('should keep the space form working alongside it', async () => {
      // both, rather than oclif's choice between the two: the "every segment
      // resolves" rule means the space form already works, so refusing it
      // would be code added to take something away
      const result = await parse({ argv: ['db', 'migrate', 'up'], schema: inline() });
      expect(result.cmd?.name).to.equal('up');
    });

    it('should resolve a mixed form, which falls out rather than being implemented', async () => {
      const left = await parse({ argv: ['db:migrate', 'up'], schema: inline() });
      expect(left.cmd?.name).to.equal('up');

      const right = await parse({ argv: ['db', 'migrate:up'], schema: inline() });
      expect(right.cmd?.name).to.equal('up');
    });

    it('should resolve the options the path walked past', async () => {
      // one token named three commands, and an option resolves across the
      // whole chain -- so `--steps` is `migrate`'s and `--verbose` is the
      // root's, exactly as the space form leaves them
      const result = await parse({
        argv: ['db:migrate', '--steps', '3', '--verbose'],
        schema: inline(),
      });
      expect(result.cmd?.name).to.equal('migrate');
      expect(result.argv.steps).to.equal('3');
      expect(result.argv.verbose).to.equal(true);
    });

    it('should resolve an option declared before the coloned token', async () => {
      // the pass loop is what makes this work and it is untouched: `--steps`
      // is not declared on the pass that reads it, and the next pass has
      // `migrate` in the chain
      const result = await parse({ argv: ['--verbose', 'db:migrate:up'], schema: inline() });
      expect(result.cmd?.name).to.equal('up');
      expect(result.argv.verbose).to.equal(true);
    });

    it('should resolve an alias in any segment', async () => {
      const result = await parse({
        argv: ['d:m'],
        schema: {
          commands: {
            db: { alias: 'd', commands: { migrate: { alias: 'm', run: () => 'm' } } },
          },
          topicSeparator: ':',
        },
      });
      expect(result.cmd?.name).to.equal('migrate');
    });

    it('should record each segment as it was typed, not as the command is named', async () => {
      // an alias is a spelling argv reached the command by, and what `state.$`
      // is for is what argv said
      const result = await parse({
        argv: ['d:m'],
        schema: {
          commands: {
            db: { alias: 'd', commands: { migrate: { alias: 'm', run: () => 'm' } } },
          },
          topicSeparator: ':',
        },
      });
      const named = result.$.filter((parsed) => parsed.type === 'Command');
      expect(named.map((parsed) => parsed.inputs[0])).to.deep.equal(['d', 'm']);
      expect(named.map((parsed) => (parsed as { cmd: { name: string } }).cmd.name)).to.deep.equal([
        'db',
        'migrate',
      ]);
    });

    it('should count one command per segment, not one per token', async () => {
      // everything downstream counts `ParsedCommand` entries -- help trims a
      // chain back to the commands argv *named* -- so a token that named three
      // has to be three entries
      const result = await parse({ argv: ['db:migrate:up'], schema: inline() });
      const named = result.$.filter((parsed) => parsed.type === 'Command');
      expect(named.map((parsed) => parsed.inputs[0])).to.deep.equal(['db', 'migrate', 'up']);
    });
  });

  describe('a value that holds a colon is never split', () => {
    it.each([
      ['a URL', 'http://example.com/a:b'],
      ['a host and port', 'localhost:8080'],
      ['an image tag', 'node:22'],
      ['a time', '10:30'],
      ['a Windows drive-relative path', 'C:foo'],
      ['a lone separator', ':'],
      ['a leading separator', ':db'],
      ['a trailing separator', 'db:'],
      ['a doubled separator', 'db::migrate'],
    ])('should leave %s alone', async (_what, value) => {
      const result = await parse({ argv: ['fetch', value], schema: inline() });
      expect(result.cmd?.name).to.equal('fetch');
      expect(result.argv.url).to.equal(value);
    });

    it('should refuse an empty segment before loading anything', async () => {
      // a trailing colon is something a *value* has, and `find()` would refuse
      // the empty name one step later anyway -- after `db` had been loaded to
      // find out what is under it. So the check changes no answer and still
      // earns its place: what it buys is that a value never imports a module
      let loads = 0;
      const schema = {
        args: ['[target]'],
        commands: {
          db: {
            load: async () => {
              loads++;
              return { commands: { migrate: { run: () => 'migrated' } } };
            },
          },
        },
        topicSeparator: ':' as const,
      };

      const refused = await parse({ argv: ['db:'], schema });
      expect(refused.argv.target).to.equal('db:');
      expect(loads).to.equal(0);

      // and the path that really is one still loads it, so the count above is
      // a measurement rather than a schema that cannot load at all
      const resolved = await parse({ argv: ['db:migrate'], schema });
      expect(resolved.cmd?.name).to.equal('migrate');
      expect(loads).to.equal(1);
    });

    it('should leave a partly resolving path alone, whole', async () => {
      // `db` is a command and `bogus` is not, so the token is not a path and
      // nothing about it is consumed. Without the all-or-nothing rule `db`
      // would have joined the chain and `bogus` would have landed on its
      // `[dsn]` argument -- a value eaten by a command nobody named
      const result = await parse({ argv: ['db:bogus'], schema: inline() });
      expect(result.cmd).to.equal(undefined);
      expect(result.argv.target).to.equal('db:bogus');
    });

    it('should take a refused path back off the context chain', async () => {
      // the walk grows the chain as it goes, because a matched command joins
      // it before its module is loaded -- so a token that turns out not to be
      // a path has to leave the chain exactly as it found it, or the root's
      // own `[target]` is not what the value lands on
      const result = await parse({ argv: ['db:bogus'], schema: inline() });
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['mycli']);
      expect(result.argv.target).to.equal('db:bogus');
    });

    it('should leave a path whose last segment is a value alone', async () => {
      const result = await parse({ argv: ['db:migrate:7'], schema: inline() });
      expect(result.cmd).to.equal(undefined);
      expect(result.argv.target).to.equal('db:migrate:7');
    });

    it('should leave a value alone where no command resolves at all', async () => {
      const result = await parse({ argv: ['fetch', 'git:github.com'], schema: inline() });
      expect(result.argv.url).to.equal('git:github.com');
    });

    it('should not read a coloned value as a path for a *parent* context', async () => {
      // commands resolve against the innermost context, and a coloned token
      // gets the same rule rather than a reach back up the chain: `db` is the
      // root's command and the context here is `migrate`, which declares
      // neither it nor an argument to take it
      await expect(
        parse({ argv: ['db', 'migrate', 'db:migrate'], schema: inline() })
      ).rejects.toThrow(/Unexpected argument "db:migrate"/);
    });

    it('should try the whole token before splitting it', async () => {
      // a command may legitimately be *named* with a separator in it, and a
      // name wins over a path spelled the same way
      const result = await parse({
        argv: ['db:migrate'],
        schema: {
          commands: {
            'db:migrate': { run: () => 'named' },
            db: { commands: { migrate: { run: () => 'path' } } },
          },
          topicSeparator: ':',
        },
      });
      expect(result.cmd?.name).to.equal('db:migrate');
    });

    it('should leave an option-like token to the option passes', async () => {
      const result = await parse({ argv: ['--verbose', 'fetch', 'a:b'], schema: inline() });
      expect(result.argv.verbose).to.equal(true);
      expect(result.argv.url).to.equal('a:b');
    });

    it('should not split an attached option value', async () => {
      const result = await parse({ argv: ['db', '--dsn=pg:5432'], schema: inline() });
      expect(result.argv.dsn).to.equal('pg:5432');
    });
  });

  describe('a routed tree', () => {
    it('should resolve a coloned path over directories', async () => {
      const result = await parse({
        argv: ['db:migrate:up'],
        schema: { commands: routes, topicSeparator: ':' },
      });
      expect(result.cmd?.desc).to.equal('migrate up');
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['up', 'migrate', 'db', 'global']);
    });

    it("should keep a refused path's loads rather than dropping them", async () => {
      // the loads a refused path had to make are what cannot be undone, so the
      // level that was read goes back into its parent's registry as the command
      // it loaded into. `loadCommand()` answers a second call with the
      // placeholder it was given, so a dropped load would leave this later
      // match holding `config`'s placeholder -- which has the level's own
      // subcommands, because reading the directory mutates it, and *not* the
      // `desc` or the `run` that `config/index.js` declares. A command that
      // parses and does nothing
      const result = await parse({
        argv: ['config:bogus', 'config'],
        schema: { commands: routes, topicSeparator: ':' },
        settings: { allowUnexpectedArguments: true },
      });
      expect(result._).to.deep.equal(['config:bogus']);
      expect(result.cmd?.name).to.equal('config');
      expect(result.cmd?.desc).to.equal('configure the app');
      expect(typeof result.cmd?.run).to.equal('function');
    });
  });

  describe('hooks', () => {
    it("should fire each command's parse hook, in the order they were typed", async () => {
      const fired: string[] = [];
      const result = await parse({
        argv: ['db:migrate:up'],
        schema: {
          commands: {
            db: {
              commands: {
                migrate: {
                  commands: { up: { hooks: { parse: () => void fired.push('up') } } },
                  hooks: { parse: () => void fired.push('migrate') },
                },
              },
              hooks: { parse: () => void fired.push('db') },
            },
          },
          topicSeparator: ':',
        },
      });
      expect(result.cmd?.name).to.equal('up');
      expect(fired).to.deep.equal(['db', 'migrate', 'up']);
    });

    it("should see an option a walked-past command's parse hook added", async () => {
      // all three hooks fire at the one token, so an option added by any of
      // them is in the registry before the rest of argv is read
      const result = await parse({
        argv: ['db:migrate', '--steps', '3'],
        schema: {
          commands: {
            db: {
              commands: {
                migrate: {
                  hooks: {
                    async parse({ options }) {
                      options.add(await initOption({ desc: 'how many', format: '--steps [n]' }));
                    },
                  },
                },
              },
            },
          },
          topicSeparator: ':',
        },
      });
      expect(result.argv.steps).to.equal('3');
    });

    it('should not reach a command an ancestor parse hook contributed', async () => {
      // the one divergence from the space form, and it is intrinsic: a `parse`
      // hook fires when a command joins the chain, and nothing may join until
      // the whole path has resolved -- so the hook that would add `migrate` has
      // not run when `migrate` is looked for. The space form reaches it,
      // because `db` is committed before the next token is read
      const schema = (): Schema => ({
        args: ['[target]'],
        commands: {
          db: {
            hooks: {
              async parse({ commands }) {
                commands.add(await initCommand({ name: 'migrate', run: () => 'migrated' }));
              },
            },
          },
        },
        topicSeparator: ':',
      });

      const spaced = await parse({ argv: ['db', 'migrate'], schema: schema() });
      expect(spaced.cmd?.name).to.equal('migrate');

      const coloned = await parse({ argv: ['db:migrate'], schema: schema() });
      expect(coloned.cmd).to.equal(undefined);
      expect(coloned.argv.target).to.equal('db:migrate');
    });
  });

  describe('a module that will not load', () => {
    it('should be in the chain for its own beforeError hooks', async () => {
      // the contract the space form keeps in as many words: a matched command
      // joins the chain *before* the module behind it is loaded, so a module
      // that will not load is an error that command's own hooks still see. A
      // refusal is a token that was never a path; a throw is a command that
      // really did match
      const fired: string[] = [];
      const schema = (): Schema => ({
        commands: {
          db: {
            commands: { migrate: { run: () => 'm' } },
            hooks: { beforeError: () => void fired.push('db') },
            load: () => {
              throw new Error('nope');
            },
          },
        },
        hooks: { beforeError: () => void fired.push('schema') },
        topicSeparator: ':',
      });

      await expect(parse({ argv: ['db:migrate'], schema: schema() })).rejects.toThrow(/nope/);
      expect(fired).to.deep.equal(['db', 'schema']);

      // ...which is what the space form already did, and the point is that the
      // two answer the same
      fired.length = 0;
      await expect(parse({ argv: ['db', 'migrate'], schema: schema() })).rejects.toThrow(/nope/);
      expect(fired).to.deep.equal(['db', 'schema']);
    });
  });

  describe('help', () => {
    it('should print the usage path with the separator', async () => {
      const result = await parse({ argv: ['db:migrate', '--help'], schema: inline() });
      const screen = await resolveHelp(result, { name: 'mycli', width: 80 });
      expect(screen).to.include('Usage: mycli db:migrate');
    });

    it('should print the usage path with a space by default', async () => {
      const result = await parse({
        argv: ['db', 'migrate', '--help'],
        schema: { ...inline(), topicSeparator: ' ' as const },
      });
      const screen = await resolveHelp(result, { name: 'mycli', width: 80 });
      expect(screen).to.include('Usage: mycli db migrate');
    });

    it('should list a subcommand by its own name rather than by its path', async () => {
      // the list is the children of the command being described, so a row is
      // what to append rather than a whole path -- and the space form still
      // works, so `migrate` is typeable exactly as printed
      const result = await parse({ argv: ['db', '--help'], schema: inline() });
      const screen = await resolveHelp(result, { name: 'mycli', width: 80 });
      expect(screen).to.include('Usage: mycli db');
      expect(screen).to.match(/^\s+migrate/m);
    });

    it('should answer a coloned path given to the help command', async () => {
      const result = await parse({ argv: ['help', 'db:migrate'], schema: inline() });
      const screen = await resolveHelp(result, { name: 'mycli', width: 80 });
      expect(screen).to.include('Usage: mycli db:migrate');
      expect(screen).to.include('--steps');
    });

    it("should report a refused help path whole, under the parse's own rule", async () => {
      // one rule rather than two, and the message is what it buys: splitting
      // on the first segment alone would report `Unknown command "http"`
      // about a URL, where this says what the parse says about the same token
      await expect(parse({ argv: ['help', 'db:bogus'], schema: inline() })).rejects.toThrow(
        /Unknown command "db:bogus"/
      );

      await expect(
        parse({ argv: ['help', 'http://example.com'], schema: inline() })
      ).rejects.toThrow(/Unknown command "http:\/\/example\.com"/);
    });

    it('should render with no schema at all', async () => {
      // `renderHelp()` takes anything carrying a context chain, and a caller
      // with no schema gets the space form rather than a throw
      const result = await parse({ argv: ['db', 'migrate'], schema: inline() });
      const screen = renderHelp({ contexts: result.contexts }, { name: 'mycli', width: 80 });
      expect(screen).to.include('Usage: mycli db migrate');
    });
  });

  describe('what it costs a parse that does not use it', () => {
    it('should read no level where the first segment is not a command', async () => {
      // the overwhelming case, and it is one `Map` lookup: `http` is not a
      // command, so nothing is loaded and no directory is read
      const schema = { args: ['[target]'], commands: routes, topicSeparator: ':' as const };
      const result = await parse({ argv: ['http://example.com'], schema });
      expect(result.argv.target).to.equal('http://example.com');
      // the root's level was read to register its commands; nothing under it was
      const root = result.contexts.at(-1)!;
      expect(root[Internal].commands.find('db')?.[Internal].loaded).to.equal(false);
    });
  });
});
