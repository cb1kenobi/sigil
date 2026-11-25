import {
  assertRouteName,
  isPrivateRoute,
  readRoutes,
  resolveRoutes,
} from '../../src/parser/command/routes.js';
import { parse } from '../../src/parser/parse.js';
import { Internal } from '../../src/types.js';
import { escapeControls } from '../../src/util/escape-controls.js';
import { tempDir } from '../temp.js';
import { type Dirent, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routes = path.join(__dirname, 'fixtures/routes');

/**
 * A directory of command modules is a tree rather than a list: a subdirectory
 * is a command with the commands inside it as its subcommands, and an `index`
 * module beside them is that command itself.
 *
 * Every level is read when something asks for it and not before, which is the
 * same promise a lazily loaded module already makes and is what the tree is
 * worth having for.
 */
describe('filesystem routing', () => {
  describe('the tree', () => {
    it('should register a file in the directory as a command', async () => {
      const result = await parse({ argv: ['build'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('build');
      expect(result.cmd?.desc).to.equal('build the app');
    });

    it('should register a subdirectory as a command with subcommands', async () => {
      const result = await parse({ argv: ['config', 'set'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('set');
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['set', 'config', 'global']);
    });

    it("should run a directory's own index module", async () => {
      const result = await parse({ argv: ['config'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('config');
      expect(result.cmd?.desc).to.equal('configure the app');
      expect(await result.cmd?.run?.(result as never)).to.equal('configured');
    });

    it('should not register an index module as a command of its own', async () => {
      const result = await parse({ argv: ['config'], schema: { commands: routes } });
      expect(result.cmd?.[Internal].commands.find('index')).to.equal(undefined);
      expect([...result.cmd![Internal].commands.keys()].sort()).to.deep.equal(['get', 'set']);
    });

    it('should recurse as far as argv names', async () => {
      const result = await parse({ argv: ['db', 'migrate', 'up'], schema: { commands: routes } });
      expect(result.cmd?.desc).to.equal('migrate up');
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['up', 'migrate', 'db', 'global']);
    });

    it('should leave a directory with no index module runnable by nobody', async () => {
      // `deploy` is a namespace: it matches and lists what is under it, and
      // there is no module for it to have a `run` from
      const result = await parse({ argv: ['deploy'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('deploy');
      expect(result.cmd?.run).to.equal(undefined);
      expect([...result.cmd![Internal].commands.keys()]).to.deep.equal(['prod']);
    });

    it('should take a directory holding nothing but an index module', async () => {
      const result = await parse({ argv: ['only-index'], schema: { commands: routes } });
      expect(result.cmd?.desc).to.equal('nothing beside it');
      expect(result.cmd?.[Internal].commands.size).to.equal(0);
    });

    it('should skip a dot-prefixed entry', async () => {
      const result = await parse({ schema: { commands: routes } });
      const names = [...result.contexts[0][Internal].commands.keys()];
      expect(names).to.not.contain('.hidden-not-a-route');
      // `completion` and `help` are the parser's own, added to the root
      // alongside `--help`, and `routes-pkg` is `pkg/` under the name its own
      // package.json gives it
      expect(names.sort()).to.deep.equal([
        'build',
        'clash',
        'completion',
        'config',
        'db',
        'deploy',
        'help',
        'only-index',
        'private-index',
        'routes-pkg',
      ]);
    });
  });

  /**
   * A `_` prefix is the one way to keep something out of the tree that is
   * otherwise a perfectly good route: a helper module, a shared component, a
   * fixture directory. Without it `commands/_helpers.js` is a command called
   * `_helpers`, which is a footgun the moment a routes tree is the normal way
   * to write an app.
   *
   * It is enforced here rather than only in the build because the two walks
   * have to agree -- an app that routes differently bundled and unbundled is
   * the one divergence a user cannot debug.
   */
  describe('an underscore-prefixed entry', () => {
    it('should not be a command', async () => {
      const result = await parse({ schema: { commands: routes } });
      const names = [...result.contexts[0][Internal].commands.keys()];
      expect(names).to.not.contain('_helpers');
      expect(names).to.not.contain('_shared');
    });

    it('should not be reachable by name', async () => {
      await expect(parse({ argv: ['_helpers'], schema: { commands: routes } })).rejects.toThrow(
        'Unexpected argument "_helpers"'
      );
    });

    it('should keep a private directory out of the tree', async () => {
      await expect(parse({ argv: ['_shared'], schema: { commands: routes } })).rejects.toThrow(
        'Unexpected argument "_shared"'
      );
    });

    it('should leave an underscore in the middle of a name alone', () => {
      // the rule is the prefix and only the prefix; a name is never searched
      // for an underscore somewhere inside it
      expect(isPrivateRoute('my_command.js')).to.equal(false);
      expect(isPrivateRoute('_my-command.js')).to.equal(true);
      expect(isPrivateRoute('.gitkeep')).to.equal(true);
    });

    it("should not be a directory's own index module either", async () => {
      // `private-index/` holds `_index.js` and `real.js`: the prefix takes the
      // index the same way it takes any other route, so the directory is a
      // namespace with nothing to run rather than a command whose `run` came
      // from a module somebody had deliberately hidden
      const result = await parse({ argv: ['private-index'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('private-index');
      expect(result.cmd?.run).to.equal(undefined);
      expect(result.cmd?.desc).to.equal(undefined);
      expect([...result.cmd![Internal].commands.keys()]).to.deep.equal(['real']);
    });

    it('should still be one command when a declaration names it', async () => {
      // a path somebody wrote is an explicit statement and gets the command it
      // asked for, which is the same asymmetry as a path nobody named being a
      // directory *of* commands while a named one is *one* command
      const result = await parse({
        argv: ['helpers'],
        schema: { commands: { helpers: path.join(routes, '_helpers.js') } },
      });
      expect(result.cmd?.name).to.equal('helpers');
      expect(result.cmd?.desc).to.equal('not a command');
    });
  });

  describe('a package the walk found', () => {
    it('should be named by its package.json rather than by its directory', async () => {
      // the directory is `pkg/` and the package calls itself `routes-pkg`; a
      // package names itself, which is what a package a declaration pointed at
      // has always done
      const result = await parse({ argv: ['routes-pkg'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('routes-pkg');

      // and the directory name is not a second way to reach it
      await expect(parse({ argv: ['pkg'], schema: { commands: routes } })).rejects.toThrow(
        'Unexpected argument "pkg"'
      );
    });

    it('should be named and described without being imported', async () => {
      // both answers come out of `package.json`, which is a file read rather
      // than an import -- so the name is known in time to match on and the
      // module still waits for a match
      const result = await parse({ schema: { commands: routes } });
      const pkg = result.contexts[0][Internal].commands.get('routes-pkg');
      expect(pkg?.[Internal].loaded).to.equal(false);
      expect(pkg?.desc).to.equal('a package found by the walk');
    });

    it('should resolve its entry through exports when it is matched', async () => {
      const result = await parse({ argv: ['routes-pkg'], schema: { commands: routes } });
      expect(result.cmd?.[Internal].loaded).to.equal(true);
      expect(result.cmd?.desc).to.equal('the package module itself');
    });

    it('should not have its own directory walked for subcommands', async () => {
      // `exports` says which module is the command, so the files beside it are
      // the package's internals rather than routes
      const result = await parse({ argv: ['routes-pkg'], schema: { commands: routes } });
      expect([...result.cmd![Internal].commands.keys()]).to.deep.equal([]);
    });
  });

  describe('one level at a time', () => {
    /**
     * `clash/` holds a `dupe.js` and a `dupe/`, which is an error -- and the
     * error is what makes the laziness observable: walked while the schema was
     * built it would throw before argv was read at all, so a parse that never
     * mentions `clash` proves nothing under it was ever read.
     */
    it('should not walk a directory nobody named', async () => {
      const result = await parse({ argv: ['build'], schema: { commands: routes } });
      expect(result.cmd?.name).to.equal('build');

      const clash = result.contexts.at(-1)?.[Internal].commands.get('clash');
      expect(clash?.[Internal].loaded).to.equal(false);
      expect(clash?.[Internal].commands.size).to.equal(0);
    });

    it('should walk a directory when argv names it', async () => {
      await expect(parse({ argv: ['clash'], schema: { commands: routes } })).rejects.toThrow(
        /Two entries in .* both declare a "dupe" command: "dupe" and "dupe\.js"/
      );
    });

    it('should leave a level it did not reach unread', async () => {
      const result = await parse({ argv: ['db'], schema: { commands: routes } });
      const migrate = result.cmd?.[Internal].commands.get('migrate');
      expect(migrate?.[Internal].loaded).to.equal(false);
      expect(migrate?.[Internal].commands.size).to.equal(0);
    });
  });

  /**
   * A `commands.json` in a routed directory describes and aliases the commands
   * in it **without loading a module** (SIG-324). A routed tree otherwise lists
   * by name alone until each module has been imported, and a module's own
   * `name` or `alias` can never route, because the module is read only after
   * argv has matched its file.
   *
   * It is the placeholder rule said in a file: an entry is what a hand-declared
   * placeholder would have said, so its `desc` is what help shows before the
   * module loads and the module's own wins after, and its `alias` and `default`
   * route because they are read when the command is registered. The walk still
   * decides what exists -- an entry describes a command and never creates or
   * removes one.
   */
  describe('a commands.json', () => {
    const described = path.join(__dirname, 'fixtures/routes-manifest');
    const defaulted = path.join(__dirname, 'fixtures/routes-manifest-default');

    it('should describe a route without loading its module', async () => {
      const result = await parse({ argv: [], schema: { commands: described } });
      const build = result.contexts[0][Internal].commands.get('build');

      expect(build?.desc).to.equal('described');
      expect(build?.[Internal].loaded).to.equal(false);
    });

    it('should leave a route with no entry listing by name alone', async () => {
      // the pair, because either half alone passes a sabotage: `undescribed`
      // having no description passes when the file is ignored outright, and
      // `build` having one passes when an entry is applied to every route. It is
      // the two together that say the file is read per route
      const result = await parse({ argv: [], schema: { commands: described } });
      const registry = result.contexts[0][Internal].commands;

      expect(registry.get('build')?.desc).to.equal('described');
      expect(registry.get('undescribed')?.desc).to.equal(undefined);
      expect(registry.get('undescribed')?.[Internal].loaded).to.equal(false);
    });

    it("should lose to the module's own desc once it loads", async () => {
      // which is what a hand-declared placeholder already did, so this is not
      // a second precedence rule to remember
      const result = await parse({ argv: ['build'], schema: { commands: described } });

      expect(result.cmd?.[Internal].loaded).to.equal(true);
      expect(result.cmd?.desc).to.equal('build the app');
    });

    it('should keep its desc for a module that declares none', async () => {
      const result = await parse({ argv: ['list'], schema: { commands: described } });

      expect(result.cmd?.[Internal].loaded).to.equal(true);
      expect(result.cmd?.desc).to.equal('List the things');
    });

    it('should hide a route the file says is hidden', async () => {
      const result = await parse({ argv: [], schema: { commands: described } });
      const registry = result.contexts[0][Internal].commands;

      expect(registry.get('secret')?.hidden).to.equal(true);
      expect(registry.get('build')?.hidden).to.equal(false);
    });

    it('should route an alias, which no module could', async () => {
      const result = await parse({ argv: ['compile'], schema: { commands: described } });

      expect(result.cmd?.name).to.equal('build');
      expect(await result.cmd?.run?.(result as never)).to.equal('built');
    });

    it('should take an alias written as a string', async () => {
      const result = await parse({ argv: ['ls'], schema: { commands: described } });

      expect(result.cmd?.name).to.equal('list');
      expect(await result.cmd?.run?.(result as never)).to.equal('listed');
    });

    it('should keep an alias out of the help label, as the alias property does', async () => {
      // an entry's `alias` means what a placeholder's `alias` property means,
      // and that one routes without being advertised (SIG-225)
      const result = await parse({ argv: ['b'], schema: { commands: described } });

      expect(result.cmd?.name).to.equal('build');
      expect(result.cmd?.[Internal].label).to.equal('build');
    });

    it('should describe a directory in its parent, and its children in its own', async () => {
      // each level reads its own file when it is walked: nothing is carried
      // down from the level above
      const root = await parse({ argv: [], schema: { commands: described } });
      const db = root.contexts[0][Internal].commands.get('db');
      expect(db?.desc).to.equal('database tasks');

      const nested = await parse({ argv: ['database', 'm'], schema: { commands: described } });
      expect(nested.contexts.map((c) => c.name)).to.deep.equal(['migrate', 'db', 'global']);
      expect(nested.cmd?.desc).to.equal('run migrations');
      expect(await nested.cmd?.run?.(nested as never)).to.equal('migrated');
    });

    it('should read the file of a directory a named path points at, for what is inside it', async () => {
      // `commands: { db: './db' }` is one command the schema describes, and
      // the routes under it are the directory's own to describe
      const result = await parse({
        argv: ['db', 'm'],
        schema: { commands: { db: path.join(described, 'db') } },
      });

      expect(result.cmd?.name).to.equal('migrate');
      expect(result.cmd?.desc).to.equal('run migrations');
    });

    it('should lose to a package manifest, which cannot go stale', async () => {
      // the filesystem wins wherever it has an answer: reading a `package.json`
      // is free, so an entry fills only what the walk could not say. The entry
      // is keyed by the name the package gives itself, and its alias routes
      const result = await parse({ argv: [], schema: { commands: described } });
      expect(result.contexts[0][Internal].commands.get('routes-pkg')?.desc).to.equal(
        'from its package.json'
      );

      const aliased = await parse({ argv: ['rp'], schema: { commands: described } });
      expect(aliased.cmd?.name).to.equal('routes-pkg');
    });

    it('should not create a command for an entry with no route', async () => {
      // the walk decides what exists, so a stale entry is ignored -- and its
      // alias does not route either. `sigil check` and `sigil build` warn
      const result = await parse({ argv: [], schema: { commands: described } });
      const names = [...result.contexts[0][Internal].commands.keys()];
      expect(names).to.not.contain('gone');

      await expect(parse({ argv: ['g'], schema: { commands: described } })).rejects.toThrow(
        'Unexpected argument "g"'
      );
    });

    it('should make an entry the default, which a module saying so cannot', async () => {
      // `commands.jsonc`, with a comment and a trailing comma, is read too
      const result = await parse({ argv: [], schema: { commands: defaulted } });

      expect(result.cmd?.name).to.equal('open');
      expect(await result.cmd?.run?.(result as never)).to.equal('opened');
    });

    it('should still route and list a default by its own name', async () => {
      const result = await parse({ argv: ['open'], schema: { commands: defaulted } });
      expect(result.cmd?.name).to.equal('open');

      const other = await parse({ argv: ['close'], schema: { commands: defaulted } });
      expect(other.cmd?.name).to.equal('close');
      expect(other.cmd?.desc).to.equal('close it');
    });

    it('should ignore a routeInfo left on a schema, as custom data', async () => {
      // `Schema.routeInfo` is gone, and nothing reads it any more
      const result = await parse({
        argv: [],
        schema: { commands: routes, routeInfo: { build: { desc: 'lifted' } } } as never,
      });

      expect(result.contexts[0][Internal].commands.get('build')?.desc).to.equal(undefined);
    });

    describe('what it refuses', () => {
      /** A directory holding `build.js` and the given files. */
      function app(files: Record<string, string>): string {
        const dir = tempDir('sigil-routes-manifest-');
        writeFileSync(path.join(dir, 'build.js'), 'export default { run() {} };\n');
        writeFileSync(path.join(dir, 'other.js'), 'export default { run() {} };\n');
        for (const [name, text] of Object.entries(files)) {
          writeFileSync(path.join(dir, name), text);
        }
        return dir;
      }

      const refuses = (files: Record<string, string>, message: string | RegExp) =>
        expect(parse({ argv: [], schema: { commands: app(files) } })).rejects.toThrow(message);

      it('should refuse a file that is not JSON, naming it', async () => {
        await refuses({ 'commands.json': '{ "build": ' }, /Failed to parse .*commands\.json/);
      });

      it('should refuse both spellings in one directory', async () => {
        // the two-routes-one-name error rather than a preference order
        await refuses(
          { 'commands.json': '{}', 'commands.jsonc': '{}' },
          /has more than one commands manifest: "commands\.json", "commands\.jsonc"/
        );
      });

      it('should refuse a file that is not an object of objects', async () => {
        await refuses({ 'commands.json': '[]' }, /commands\.json to be an object of commands/);
        await refuses({ 'commands.json': '{ "build": "x" }' }, /"build" in .*commands\.json/);
      });

      it.each([
        ['desc', '42', 'a string'],
        ['hidden', '"yes"', 'a boolean'],
        ['default', '1', 'a boolean'],
        ['alias', '42', 'a string or list of strings'],
        ['alias', '["b", 42]', 'a string or list of strings'],
      ])('should refuse a %s of %s, naming the file', async (property, value, expected) => {
        const dir = app({ 'commands.json': `{ "build": { "${property}": ${value} } }` });

        await expect(parse({ argv: [], schema: { commands: dir } })).rejects.toThrow(
          `Expected ${property} for "build" in ${path.join(dir, 'commands.json')} to be ${expected}`
        );
      });

      it('should refuse a control or format character in an alias, as it does in a route name (SIG-673)', async () => {
        // an alias is a spelling argv can match, and a `commands.json` dropped into an
        // installed app's commands directory is no more the app's own than a file
        // dropped there. The characters are the ones a route name refuses
        for (const code of [0x07, 0x1b, 0x7f, 0x9b, 0xad, 0x200b, 0x202e]) {
          const alias = `a${String.fromCodePoint(code)}b`;
          const dir = app({ 'commands.json': JSON.stringify({ build: { alias: [alias] } }) });

          const error = await parse({ argv: [], schema: { commands: dir } }).then(
            () => undefined,
            (e: unknown) => e as Error
          );

          const shown = escapeControls(alias);
          expect(error?.message, shown).toContain(
            `Invalid alias "${shown}" for "build" in ${escapeControls(path.join(dir, 'commands.json'))}: it contains a control or format character`
          );
          expect(error?.message, shown).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        }
      });

      it('should refuse in an alias what a route name is refused, for the same reason (SIG-679)', () => {
        // one definition: every code point of the classes a name is refused for, the
        // syntax a name string reads, and the characters either one lets through,
        // answers the same for a name and for an alias -- and says the same thing
        const dir = app({});
        const reasonAsName = (name: string) => {
          try {
            assertRouteName(name, 'the test');
            return undefined;
          } catch (err) {
            return /the command name ".*?" (.*)\. A route is named exactly/s.exec(
              (err as Error).message
            )?.[1];
          }
        };
        const reasonAsAlias = (alias: string) => {
          writeFileSync(
            path.join(dir, 'commands.json'),
            JSON.stringify({ build: { alias: [alias] } })
          );
          try {
            readRoutes(dir);
            return undefined;
          } catch (err) {
            return /: it (.*)$/s.exec((err as Error).message)?.[1];
          }
        };

        const codes = [
          ...Array.from({ length: 0xa0 }, (_, i) => i),
          0xad,
          0x600,
          0x1680,
          0x2000,
          0x200a,
          0x200b,
          0x200c,
          0x200d,
          0x200e,
          0x2028,
          0x2029,
          0x202a,
          0x202f,
          0x205f,
          0x2060,
          0x2066,
          0x3000,
          0x3164,
          0xfeff,
          0xe0001,
        ];
        let refused = 0;

        for (const code of codes) {
          const c = String.fromCodePoint(code);

          // in the middle, and first, where `!`, `@`, `<` and `[` are what they are
          for (const spelling of [`a${c}b`, `${c}b`]) {
            const asName = reasonAsName(spelling);
            expect(reasonAsAlias(spelling), escapeControls(spelling)).toBe(asName);
            refused += asName === undefined ? 0 : 1;
          }
        }

        for (const spelling of ['', 'a,b', 'a/b', '<x>', '[x]', '!x', '@x', 'a b', 'ok', 'a-b']) {
          const asName = reasonAsName(spelling);

          expect(reasonAsAlias(spelling), escapeControls(spelling)).toBe(asName);
          refused += asName === undefined ? 0 : 1;
        }

        // a loop that refused nothing would agree with itself trivially
        expect(refused).toBeGreaterThan(100);
      });

      it.each([
        ['whitespace', 'a b', /: it contains whitespace/],
        ['a tab', 'a\tb', /: it contains whitespace/],
        ['a no-break space', 'a\u00a0b', /: it contains whitespace/],
        ['a line separator', 'a\u2028b', /: it contains whitespace/],
        ['a comma', 'a,b', /: it contains a ","/],
        ['a slash', 'a/b', /: it contains a "\/"/],
        ['a leading <', '<x>', /: it starts with "<"/],
        ['a leading [', '[x]', /: it starts with "\["/],
        ['a leading !', '!x', /: it starts with "!"/],
        ['a leading @', '@x', /: it starts with "@"/],
        ['an empty alias', '', /: it is empty/],
      ])(
        'should refuse an alias holding %s, naming the alias, the route and the file (SIG-679)',
        async (_what, alias, message) => {
          const dir = app({ 'commands.json': JSON.stringify({ build: { alias } }) });
          const error = await parse({ argv: [], schema: { commands: dir } }).then(
            () => undefined,
            (e: unknown) => e as Error
          );

          expect(error?.message).toContain(
            `Invalid alias "${escapeControls(alias)}" for "build" in ${escapeControls(path.join(dir, 'commands.json'))}`
          );
          expect(error?.message).toMatch(message);
          // one refusal: the leading `!` or `@` is not said a second time
          expect(error?.message).not.toContain('plain name');
          expect(error?.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        }
      );

      it('should refuse the whole file for one bad alias among good ones (SIG-679)', async () => {
        // not skipped: a skipped alias silently stops routing on the machine the file
        // was dropped onto
        const dir = app({ 'commands.json': '{ "build": { "alias": ["b", "a b"] } }' });

        await expect(parse({ argv: ['b'], schema: { commands: dir } })).rejects.toThrow(
          /Invalid alias "a b" for "build" in .*commands\.json: it contains whitespace/
        );
      });

      it('should let an alias hold the two joiners and a blank character, as a route name may', async () => {
        // U+200C and U+200D spell words in Persian and several Indic scripts; U+3164
        // is no sequence and no reordering, only a name that prints blank
        for (const code of [0x200c, 0x200d, 0x3164]) {
          const alias = `a${String.fromCodePoint(code)}b`;
          const dir = app({ 'commands.json': JSON.stringify({ build: { alias: [alias] } }) });
          const result = await parse({ argv: [alias], schema: { commands: dir } });

          expect(result.cmd?.name, escapeControls(alias)).toBe('build');
        }
      });

      it('should refuse two entries that are both default', async () => {
        await refuses(
          {
            'commands.json': '{ "other": { "default": true }, "build": { "default": true } }',
          },
          /Only one default command is allowed: "build" and "other" are both default in .*commands\.json/
        );
      });

      it.each([
        ['an entry that is not an object', '{ "z\\u001b[2J\\nx": 5 }', /"z\\x1B\[2J\\x0Ax" in /],
        [
          'a desc of the wrong type',
          '{ "z\\u001b\\nx": { "desc": 1 } }',
          /desc for "z\\x1B\\x0Ax" in /,
        ],
        [
          'a hidden of the wrong type',
          '{ "z\\u001b\\nx": { "hidden": 1 } }',
          /hidden for "z\\x1B\\x0Ax" in /,
        ],
        [
          'a default of the wrong type',
          '{ "z\\u001b\\nx": { "default": 1 } }',
          /default for "z\\x1B\\x0Ax" in /,
        ],
        [
          'an alias of the wrong type',
          '{ "z\\u001b\\nx": { "alias": 1 } }',
          /alias for "z\\x1B\\x0Ax" in /,
        ],
        [
          'a name-string alias',
          '{ "z\\u001b\\nx": { "alias": ["@y\\u001b\\nw"] } }',
          /Invalid alias "@y\\x1B\\x0Aw" for "z\\x1B\\x0Ax" in /,
        ],
        [
          'two defaults',
          '{ "a\\u001b\\n": { "default": true }, "b\\u001b\\n": { "default": true } }',
          /"a\\x1B\\x0A" and "b\\x1B\\x0A" are both default in /,
        ],
      ])(
        'should escape a control character in a key it echoes, in %s (SIG-443)',
        async (_, json, expected) => {
          // a `commands.json` key is whatever the file holds, and these refusals
          // reach the terminal raw at run time and become a build diagnostic
          // line, where a newline is a line the reader's tooling reads as a
          // second diagnostic
          const dir = app({ 'commands.json': json });

          const error = await parse({ argv: [], schema: { commands: dir } }).then(
            () => undefined,
            (e: unknown) => e as Error
          );

          expect(error?.message).toMatch(expected);
          expect(error?.message).not.toMatch(/\p{Cc}/u);
        }
      );

      it('should ignore a property it does not know', async () => {
        // ignored rather than refused, for the reason a stale entry is: the
        // app runs as it would without it, and `sigil check` says so
        const dir = app({ 'commands.json': '{ "build": { "aliases": ["b"], "desc": "d" } }' });
        const result = await parse({ argv: [], schema: { commands: dir } });

        expect(result.contexts[0][Internal].commands.get('build')?.desc).to.equal('d');
        await expect(parse({ argv: ['b'], schema: { commands: dir } })).rejects.toThrow(
          'Unexpected argument "b"'
        );
      });
    });
  });

  /**
   * A command declares its subcommands the same way the schema does, and the
   * runtime has always read every shape here -- but `Command.commands` was
   * typed `Record<string, AnyCommand>` while the schema's field was wide, so
   * the two documented spellings that involve a path were a **type error** on a
   * nested command. Nothing in this repository had hit it, because every case
   * above declares its paths on the schema.
   *
   * These run, so they pin the behaviour; `tsconfig.json` includes `./test`, so
   * they also pin the type -- narrowing it again fails `pnpm check` rather than
   * waiting for somebody's app to find out.
   */
  describe("a nested command's own subcommands", () => {
    const foo = path.join(__dirname, 'fixtures/simple/foo.js');

    it('should take a path to a directory of them', async () => {
      const result = await parse({
        argv: ['group', 'foo'],
        schema: { commands: { group: { commands: path.join(__dirname, 'fixtures/simple') } } },
      });

      expect(result.cmd?.name).to.equal('foo');
      expect(result.cmd?.desc).to.equal('foo!');
    });

    it('should take a path as a value', async () => {
      const result = await parse({
        argv: ['group', 'foo'],
        schema: { commands: { group: { commands: { foo } } } },
      });

      expect(result.cmd?.desc).to.equal('foo!');
    });

    it('should take a list of paths', async () => {
      const result = await parse({
        argv: ['group', 'foo'],
        schema: { commands: { group: { commands: [foo] } } },
      });

      expect(result.cmd?.desc).to.equal('foo!');
    });

    it('should take a list of declarations', async () => {
      const result = await parse({
        argv: ['group', 'foo'],
        schema: {
          commands: { group: { commands: [{ name: 'foo', desc: 'inline foo' }] } },
        },
      });

      expect(result.cmd?.desc).to.equal('inline foo');
    });

    it('should take a map of declarations, which it always did', async () => {
      const result = await parse({
        argv: ['group', 'foo'],
        schema: { commands: { group: { commands: { foo: { desc: 'inline foo' } } } } },
      });

      expect(result.cmd?.desc).to.equal('inline foo');
    });

    it('should resolve a relative path against the schema it was declared in', async () => {
      // the rule a path in any command declaration follows, which is the whole
      // reason a nested command needs the wide type rather than an absolute one
      const result = await parse({
        argv: ['group', 'foo'],
        schema: {
          baseDir: __dirname,
          commands: { group: { commands: './fixtures/simple' } },
        },
      });

      expect(result.cmd?.desc).to.equal('foo!');
    });
  });

  describe('TypeScript', () => {
    const ts = path.join(__dirname, 'fixtures/routes-ts');

    it('should route a .ts file', async () => {
      const result = await parse({ argv: ['deploy'], schema: { commands: ts } });
      expect(result.cmd?.name).to.equal('deploy');
      expect(result.cmd?.desc).to.equal('deploy the app');
    });

    it('should take a .mts index module', async () => {
      const result = await parse({ argv: ['settings'], schema: { commands: ts } });
      expect(result.cmd?.desc).to.equal('settings are on');
    });

    it('should register a .cts subcommand', async () => {
      // registered here and *loaded* in `packages/cli/test/typescript.test.ts`,
      // which spawns a real node: vite transforms anything this suite imports
      // and cannot read a `.cts`, while node strips its types and loads it as
      // the CommonJS the extension says it is
      const result = await parse({ argv: ['settings'], schema: { commands: ts } });
      const edit = result.cmd?.[Internal].commands.get('edit');
      expect(edit?.name).to.equal('edit');
      expect(edit?.[Internal].path).to.match(/edit\.cts$/);
    });

    it('should resolve a package whose exports names a .ts entry', async () => {
      const result = await parse({ argv: ['pkg-ts'], schema: { commands: ts } });
      expect(result.cmd?.desc).to.equal('the TypeScript package module');
    });

    it('should not route a declaration file', async () => {
      // `deploy.d.ts` parses as a name of `deploy.d` and an extension of
      // `.ts`, so left alone it is a command called `deploy.d` -- and beside
      // the `deploy.ts` it describes it is a second claim on `deploy`, which
      // would be the collision error on a directory that is perfectly ordinary
      const result = await parse({ schema: { commands: ts } });
      const names = [...result.contexts[0][Internal].commands.keys()];
      expect(names).to.not.contain('deploy.d');
      expect(names.sort()).to.deep.equal(['completion', 'deploy', 'help', 'pkg-ts', 'settings']);
    });

    it('should refuse a .ts and a .js claiming one name', async () => {
      // the same rule two routes of one name already follow. Picking one by a
      // preference order is how somebody edits the file that is not loaded
      await expect(
        parse({ schema: { commands: path.join(__dirname, 'fixtures/routes-clash-ts') } })
      ).rejects.toThrow(/both declare a "build" command/);
    });
  });

  describe('a named path', () => {
    it('should make one command out of a directory', async () => {
      const result = await parse({
        argv: ['settings', 'set'],
        schema: { commands: { settings: path.join(routes, 'config') } },
      });
      expect(result.cmd?.name).to.equal('set');
      expect(result.contexts.map((c) => c.name)).to.deep.equal(['set', 'settings', 'global']);
    });

    it('should refuse a directory with no command in it', async () => {
      await expect(
        parse({ schema: { commands: { nope: path.join(__dirname, 'fixtures/empty') } } })
      ).rejects.toThrow('Unsupported command module');
    });
  });

  describe('path and run together', () => {
    it('should refuse a command declaring both', async () => {
      await expect(
        parse({
          schema: {
            commands: {
              build: { path: path.join(routes, 'build.js'), run: () => undefined },
            },
          },
        })
      ).rejects.toThrow('Cannot combine "path" with "run" in the "build" command');
    });

    it('should refuse a module declaring both', async () => {
      await expect(
        parse({
          argv: ['both'],
          schema: { commands: { both: path.join(__dirname, 'fixtures/path-and-run.js') } },
        })
      ).rejects.toThrow('Cannot combine "path" with "run"');
    });
  });
  /**
   * `load` is `path` said as a function rather than as a file, and it exists
   * for one reason: a bundled app has no file to read. Its command modules are
   * chunks a bundler named, reached by a dynamic `import()` the bundler
   * rewrote, so `sigil build` emits a loader where the unbundled tree had a
   * path -- and the deferral, which is most of the startup-time argument for
   * having a tree at all, survives bundling.
   */
  describe('a generated tree', () => {
    it('should load a command from its loader', async () => {
      const result = await parse({
        argv: ['build'],
        schema: {
          commands: {
            build: {
              load: () => Promise.resolve({ default: { desc: 'built', run: () => 'ran' } }),
            },
          },
        },
      });
      expect(result.cmd?.name).to.equal('build');
      expect(result.cmd?.desc).to.equal('built');
      expect(await result.cmd?.run?.(result as never)).to.equal('ran');
    });

    it('should not call the loader until the command is matched', async () => {
      let called = 0;
      const load = () => {
        called++;
        return Promise.resolve({ default: { run: () => 'ran' } });
      };

      await parse({ argv: [], schema: { commands: { build: { load }, other: { load } } } });
      expect(called).to.equal(0);

      await parse({ argv: ['build'], schema: { commands: { build: { load }, other: { load } } } });
      expect(called).to.equal(1);
    });

    it('should keep a description the tree baked in when the module has none', async () => {
      // the whole point of lifting `desc` statically is that help has it
      // before the module loads; the module's own still wins where it has one
      const result = await parse({
        argv: ['build'],
        schema: {
          commands: {
            build: { desc: 'baked at build time', load: () => Promise.resolve({ default: {} }) },
          },
        },
      });
      expect(result.cmd?.desc).to.equal('baked at build time');
    });

    it("should let the module's own description win over the baked one", async () => {
      const result = await parse({
        argv: ['build'],
        schema: {
          commands: {
            build: {
              desc: 'baked',
              load: () => Promise.resolve({ default: { desc: 'from the module' } }),
            },
          },
        },
      });
      expect(result.cmd?.desc).to.equal('from the module');
    });

    it('should take a loader that hands back the command rather than a module', async () => {
      // so that a loader is not silently a different contract from an import
      const result = await parse({
        argv: ['build'],
        schema: { commands: { build: { load: () => Promise.resolve({ desc: 'bare' }) } } },
      });
      expect(result.cmd?.desc).to.equal('bare');
    });

    it('should carry the placeholder subcommands a generated tree declared', async () => {
      const result = await parse({
        argv: ['db', 'migrate'],
        schema: {
          commands: {
            db: {
              commands: {
                migrate: { load: () => Promise.resolve({ default: { run: () => 'migrated' } }) },
              },
              load: () => Promise.resolve({ default: { desc: 'the database' } }),
            },
          },
        },
      });
      expect(result.cmd?.name).to.equal('migrate');
      expect(await result.cmd?.run?.(result as never)).to.equal('migrated');
    });

    it('should refuse a loader beside a run', async () => {
      await expect(
        parse({
          schema: {
            commands: { build: { load: () => Promise.resolve({}), run: () => undefined } },
          },
        })
      ).rejects.toThrow('Cannot combine "load" with "run" in the "build" command');
    });

    it('should refuse a loader beside a path', async () => {
      // both name the module that is the command, so only one of them can be
      await expect(
        parse({
          schema: {
            commands: {
              build: { load: () => Promise.resolve({}), path: path.join(routes, 'build.js') },
            },
          },
        })
      ).rejects.toThrow('Cannot combine "load" with "path" in the "build" command');
    });

    it('should refuse a loader that is not a function', async () => {
      await expect(
        parse({ schema: { commands: { build: { load: 'nope' as never } } } })
      ).rejects.toThrow('Invalid load function in "build" command');
    });

    it('should name the command whose loader threw, since a loader has no name', async () => {
      // a bundled app's loader is an anonymous closure, so the underlying
      // message is the whole of what a reader gets unless the command is named
      // -- and the export check beside this one already named it
      await expect(
        parse({
          argv: ['build'],
          schema: { commands: { build: { load: () => Promise.reject(new Error('no chunk')) } } },
        })
      ).rejects.toThrow(`Failed to load command module (the "build" command's loader): no chunk`);
    });

    it('should refuse a loader whose module is not a command object', async () => {
      // named by the command rather than by a file, because there is no file
      await expect(
        parse({
          argv: ['build'],
          schema: { commands: { build: { load: () => Promise.resolve({ default: null }) } } },
        })
      ).rejects.toThrow(/not a valid command object: the "build" command's loader/);
    });

    it('should try the loader again after one that threw', async () => {
      // a module that throws must throw again the next time the command is
      // matched rather than quietly resolving to the placeholder
      let attempts = 0;
      const load = () => {
        attempts++;
        return Promise.reject(new Error('flaky'));
      };
      const schema = { commands: { build: { load } } };

      await expect(parse({ argv: ['build'], schema })).rejects.toThrow('flaky');
      await expect(parse({ argv: ['build'], schema })).rejects.toThrow('flaky');
      expect(attempts).to.equal(2);
    });
  });

  /**
   * A level's routes are sorted before they are registered, because `readdir`
   * hands them over in the file system's order -- and sorted by code unit
   * rather than by `localeCompare`, which reads the process locale. The inputs
   * are ones every collation orders the other way, so these fail under
   * `localeCompare` on any machine rather than only on one set to a language
   * that happens to disagree: no collation puts `B` before `a`, and none puts
   * `a-b` before `a_b`, while code-unit order puts both first.
   */
  describe('the order a level is read in', () => {
    /** A directory entry that is a plain file. */
    function file(name: string): Dirent {
      return { isDirectory: () => false, isSymbolicLink: () => false, name } as Dirent;
    }

    it('should sort the routes by code unit, not by the process locale', () => {
      const found = resolveRoutes('/nowhere', [
        file('a_b.js'),
        file('a.js'),
        file('a-b.js'),
        file('B.js'),
      ]);
      // the *entries* are sorted, extension and all, so `a-b.js` is before
      // `a.js` because `-` is before `.`
      expect(found.map((route) => route.name)).to.deep.equal(['B', 'a-b', 'a', 'a_b']);
    });

    it('should register a routed tree in code-unit order at every level', async () => {
      const dir = tempDir('sigil-route-order-');
      for (const name of ['a.js', 'B.js', 'ns/c.js', 'ns/D.js']) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), 'export default { run() {} };\n');
      }

      // the root's level is read when the schema is built and `ns/` when argv
      // names it, which are the two places `resolveRoutes()` is asked from
      const root = await parse({ argv: [], schema: { commands: dir } });
      const own = (names: Iterable<string>) =>
        [...names].filter((name) => name !== 'completion' && name !== 'help');
      expect(own(root.contexts[0][Internal].commands.keys())).to.deep.equal(['B', 'a', 'ns']);

      const nested = await parse({ argv: ['ns'], schema: { commands: dir } });
      expect([...nested.cmd![Internal].commands.keys()]).to.deep.equal(['D', 'c']);
    });
  });

  /**
   * A route is named by the file system, and a command name string is not
   * what the file system speaks (SIG-389). `my cmd.mjs` was `my` with an alias
   * of `cmd`, `!secret.mjs` was a hidden `secret`, `[id].mjs` failed every run
   * with `Unable to determine command name`, and `@acme/deploy` registered as
   * `acme/deploy` -- a command nobody could type -- while a collision was only
   * ever asked about the raw name, so two files could collapse onto one
   * command and nothing said so.
   */
  describe("a route's name is taken literally", () => {
    /** A directory entry that is a plain file or a plain directory. */
    function entry(name: string, directory = false): Dirent {
      return { isDirectory: () => directory, isSymbolicLink: () => false, name } as Dirent;
    }

    /** A directory holding the given files, each a command that reports its own path. */
    function app(files: Record<string, string>): string {
      const dir = tempDir('sigil-route-names-');
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
      }
      return dir;
    }

    const mod = "export default { desc: 'a module', run() { return 'ran'; } };\n";

    /** A package directory whose manifest says `name`. */
    function pkgFiles(dir: string, name: string | undefined): Record<string, string> {
      return {
        [`${dir}/index.mjs`]: "export default { run() { return 'ran pkg'; } };\n",
        [`${dir}/package.json`]: JSON.stringify({
          ...(name === undefined ? {} : { name }),
          main: 'index.mjs',
          type: 'module',
        }),
      };
    }

    describe('what is refused', () => {
      // asked of `resolveRoutes()` over entries that were never on a disk, which is
      // what lets a name no Windows file system will hold (`<`, a tab) be tested
      // everywhere without a skip -- and is the function `sigil build` shares
      it.each([
        ['my cmd.mjs', /contains whitespace/],
        ['a,b.mjs', /contains a ","/],
        ['a\tb.mjs', /contains whitespace/],
        ['!secret.mjs', /starts with "!".*hiding the command/],
        ['@scoped.mjs', /starts with "@".*an alias/],
        ['<id>.mjs', /starts with "<".*an argument/],
        ['[id].mjs', /starts with "\[".*an argument/],
      ])('should refuse the file %j', (name, reason) => {
        expect(() => resolveRoutes('/nowhere', [entry(name)])).toThrow(reason);
      });

      it('should say how to alias a route in place of a `@` file name', () => {
        expect(() => resolveRoutes('/nowhere', [entry('@x.mjs')])).toThrow(
          /to alias a route, name the file without the "@" and list the alias in a commands\.json beside it$/
        );
      });

      it('should say how to hide a route in place of a `!` directory', () => {
        expect(() => resolveRoutes('/nowhere', [entry('!d', true)])).toThrow(
          /to hide a route, name the file without the "!" and add an entry with "hidden": true for that name to a commands\.json beside it$/
        );
      });

      it('should compute no replacement name, which was wrong for an index, an existing file and a quote', () => {
        // naming `!index.js`'s successor sent somebody to a top-level `index`, which is
        // nothing; `!x.js` beside `x.js` was told to rename onto it; and a name holding
        // a quote came back as JSON that did not parse. One fixed sentence is right for
        // every one of them. A backslash is a separator on Windows, where no entry a
        // directory listing hands over can hold one, so that case is POSIX's alone
        for (const name of [
          '!index.mjs',
          '!x.mjs',
          '!a"b.mjs',
          ...(process.platform === 'win32' ? [] : ['!a\\b.mjs']),
          '@acme.mjs',
          '!a b.mjs',
        ]) {
          let message = '';
          try {
            resolveRoutes('/nowhere', [entry(name)]);
          } catch (err) {
            message = (err as Error).message;
          }
          expect(message, name).toContain('commands.json beside it');
          expect(message, name).not.toContain('rename it to');
          expect(message, name).not.toContain('{ "');
        }
      });

      it('should call a space a separator and not say so of whitespace that is not one', () => {
        // `parseName()` splits at a comma and a space and nothing else, so a claim
        // that a tab or a no-break space separates aliases is not true of it
        expect(() => resolveRoutes('/nowhere', [entry('a b.mjs')])).toThrow(
          /contains whitespace, which a command name string reads as a separator between aliases/
        );

        for (const name of ['a\tb.mjs', 'a\u00A0b.mjs', 'a\u3000b.mjs']) {
          let message = '';
          try {
            resolveRoutes('/nowhere', [entry(name)]);
          } catch (err) {
            message = (err as Error).message;
          }
          expect(message, name).toContain('contains whitespace, which cannot be typed reliably');
          expect(message, name).not.toContain('separator');
        }
      });

      it('should escape a control character in a name it echoes, and still refuse it for what it is', () => {
        // a file called `!x ESC ] 0 ; PWNED BEL .mjs` put a live OSC on stderr, twice
        const name = '!x\x1b]0;PWNED\x07.mjs';
        let message = '';
        try {
          resolveRoutes('/nowhere\x1b[31m', [entry(name)]);
        } catch (err) {
          message = (err as Error).message;
        }

        expect(message).toContain('Cannot route the file "!x\\x1B]0;PWNED\\x07.mjs"');
        expect(message).toContain('nowhere\\x1B[31m');
        expect(message).toContain('starts with "!"');
        expect(message).not.toMatch(/\p{Cc}/u);
      });

      it('should refuse a control or format character in a name, for being one (SIG-662)', () => {
        // a routed name is the file system's, and `Did you mean` offers it back to a
        // terminal: a name holding one is a name nobody can type and a sequence
        // waiting for something to print it. U+2028 is `\p{Zl}`, which is neither
        // `\p{Cc}` nor `\p{Cf}`, and `/\s/` already refuses it as whitespace
        for (const code of [0x07, 0x1b, 0x7f, 0x9b, 0xad, 0x200b, 0x202e]) {
          const name = `a${String.fromCodePoint(code)}b`;
          let message = '';
          try {
            resolveRoutes('/nowhere', [entry(`${name}.mjs`)]);
          } catch (err) {
            message = (err as Error).message;
          }

          const shown = escapeControls(name);
          expect(message, shown).toContain(`Cannot route the file "${shown}.mjs"`);
          expect(message, shown).toContain(
            'contains a control or format character, which a terminal would act on or draw as something else'
          );
          expect(message, shown).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        }
      });

      it('should let the two joiners through, since a script spells words with them', () => {
        // Persian needs U+200C and several Indic scripts U+200D; neither reorders
        // or hides anything the way the bidi controls and U+200B do
        for (const code of [0x200c, 0x200d]) {
          const name = `a${String.fromCodePoint(code)}b`;
          expect(
            resolveRoutes('/nowhere', [entry(`${name}.mjs`)]).map((route) => route.name)
          ).to.deep.equal([name]);
        }
      });

      it('should refuse a control or format character in a directory name too', () => {
        expect(() => resolveRoutes('/nowhere', [entry('d\x1b[2J', true)])).toThrow(
          /Cannot route the directory "d\\x1B\[2J" in "[^"]*": the command name "d\\x1B\[2J" contains a control or format character/
        );
      });

      it('should escape a control character in a directory name it echoes', () => {
        // the directory branch of `entryRoute()` is its own call site
        let message = '';
        try {
          resolveRoutes('/nowhere', [entry('!d\x1b]0;PWNED\x07', true)]);
        } catch (err) {
          message = (err as Error).message;
        }

        expect(message).toContain('Cannot route the directory "!d\\x1B]0;PWNED\\x07"');
        expect(message).not.toMatch(/\p{Cc}/u);
      });

      it('should escape a character no route refuses in the two names a collision echoes', () => {
        // a control or format character is refused before two names can collide
        // (SIG-662), so this uses U+3164 HANGUL FILLER, which `escapeControls()`
        // names and `assertRouteName()` does not: `a` plus it as a file and as a
        // directory are one command, and both spellings, the name and the directory
        // they are in are echoed
        let message = '';
        try {
          resolveRoutes('/no\x1b[31mwhere', [entry('a\u3164.mjs'), entry('a\u3164', true)]);
        } catch (err) {
          message = (err as Error).message;
        }

        expect(message).toContain(
          'both declare a "a\\u{3164}" command: "a\\u{3164}" and "a\\u{3164}.mjs"'
        );
        expect(message).toContain('no\\x1B[31mwhere');
        expect(message).not.toMatch(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/u);
      });

      it('should refuse a directory by the same rules, naming it', () => {
        expect(() => resolveRoutes('/nowhere', [entry('my dir', true)])).toThrow(
          /Cannot route the directory "my dir" in "[^"]*nowhere": the command name "my dir" contains whitespace/
        );
        expect(() => resolveRoutes('/nowhere', [entry('[id]', true)])).toThrow(/starts with "\["/);
      });

      it('should say which file, and that a commands.json is how to alias or hide a route', () => {
        expect(() => resolveRoutes('/nowhere', [entry('!secret.mjs')])).toThrow(
          /Cannot route the file "!secret\.mjs" in .*nowhere.*to hide a route, name the file without the "!" and add an entry with "hidden": true for that name to a commands\.json beside it$/
        );
      });

      it('should leave an ordinary name alone, hyphens and underscores in the middle included', () => {
        expect(
          resolveRoutes('/nowhere', [entry('a-b.mjs'), entry('my_cmd.mjs'), entry('v1.2.mjs')]).map(
            (route) => route.name
          )
        ).to.deep.equal(['a-b', 'my_cmd', 'v1.2']);
      });

      it('should refuse `my cmd.mjs` beside `my.mjs`, which used to collapse onto one command', async () => {
        // the name `my` was claimed twice and nothing threw: the raw names differ,
        // so the collision check passed, and `x my` ran whichever registered last
        const dir = app({ 'my cmd.mjs': mod, 'my.mjs': mod });
        await expect(parse({ argv: ['my'], schema: { commands: dir } })).rejects.toThrow(
          /Cannot route the file "my cmd\.mjs"/
        );
      });

      it('should refuse `!secret.mjs` rather than register a hidden `secret`', async () => {
        const dir = app({ '!secret.mjs': mod });
        await expect(parse({ argv: [], schema: { commands: dir } })).rejects.toThrow(
          /Cannot route the file "!secret\.mjs"/
        );
      });

      it('should refuse `[id].mjs` with a message about the file, not "Unable to determine command name"', async () => {
        const dir = app({ '[id].mjs': mod });
        const refused = parse({ argv: [], schema: { commands: dir } });
        await expect(refused).rejects.toThrow(/Cannot route the file "\[id\]\.mjs"/);
        await expect(refused).rejects.not.toThrow(/Unable to determine/);
      });

      it('should refuse a bad name two levels down, when that level is walked', async () => {
        const dir = app({ 'db/my cmd.mjs': mod, 'db/index.mjs': mod });
        // the root is fine and says nothing, which is the laziness the walk is for
        const root = await parse({ argv: [], schema: { commands: dir } });
        expect(root.contexts[0][Internal].commands.has('db')).to.equal(true);
        await expect(parse({ argv: ['db'], schema: { commands: dir } })).rejects.toThrow(
          /Cannot route the file "my cmd\.mjs"/
        );
      });

      it('should refuse a file that a path names on its own, by the same rule', async () => {
        const dir = app({ 'my cmd.mjs': mod });
        await expect(
          parse({ argv: [], schema: { commands: path.join(dir, 'my cmd.mjs') } })
        ).rejects.toThrow(/Cannot route the file ".*my cmd\.mjs"/);
      });

      it.skipIf(process.platform === 'win32')(
        'should escape what it echoes of a file a path names on its own',
        async () => {
          // an escape cannot be in a Windows file name at all
          const dir = app({ '!x\x1b]0;PWNED\x07.mjs': mod });
          const refused = parse({
            argv: [],
            schema: { commands: path.join(dir, '!x\x1b]0;PWNED\x07.mjs') },
          });
          await expect(refused).rejects.toThrow('!x\\x1B]0;PWNED\\x07.mjs"');
          await expect(refused).rejects.not.toThrow(/\p{Cc}/u);
          await expect(refused).rejects.toThrow(
            /to hide a route, name the file without the "!" and add an entry with "hidden": true for that name to a commands\.json beside it$/
          );
        }
      );

      it('should not refuse a declaration, whose name string is still a name string', async () => {
        // only a name the file system or a manifest gave is literal: a key and a
        // `name` are written by the author, who meant the syntax
        const result = await parse({
          argv: ['purge'],
          schema: { commands: { 'purge, pg': { run() {} } } },
        });
        expect(result.cmd?.name).to.equal('purge');
        expect(result.cmd?.[Internal].aliases.has('pg')).to.equal(true);
      });

      it('should not refuse a private or hidden entry, which is no route at all', () => {
        expect(
          resolveRoutes('/nowhere', [
            entry('_my cmd.mjs'),
            entry('.my cmd.mjs'),
            entry('ok.mjs'),
          ]).map((route) => route.name)
        ).to.deep.equal(['ok']);
      });
    });

    describe('a scoped package', () => {
      it('should register as the name after its scope, when the walk finds it', async () => {
        const dir = app(pkgFiles('deploy', '@acme/deploy'));
        const result = await parse({ argv: ['deploy'], schema: { commands: dir } });
        expect(result.cmd?.name).to.equal('deploy');
        expect(await result.cmd?.run?.(result as never)).to.equal('ran pkg');

        const names = [...result.contexts.at(-1)![Internal].commands.keys()];
        expect(names).to.contain('deploy');
        expect(names).to.not.contain('acme/deploy');
        expect(names).to.not.contain('@acme/deploy');
      });

      it('should not be reachable by its scoped spelling', async () => {
        const dir = app(pkgFiles('deploy', '@acme/deploy'));
        await expect(parse({ argv: ['acme/deploy'], schema: { commands: dir } })).rejects.toThrow(
          'Unexpected argument "acme/deploy"'
        );
      });

      it('should be named without being imported, scope off', async () => {
        const dir = app(pkgFiles('anything', '@acme/deploy'));
        const result = await parse({ argv: [], schema: { commands: dir } });
        const pkg = result.contexts[0][Internal].commands.get('deploy');
        expect(pkg?.[Internal].loaded).to.equal(false);
      });

      it('should register as the name after its scope, when a declaration points at it', async () => {
        // "a package names itself, wherever it was found": a path as a value and an
        // unnamed path are two ways to point at one, and the rule is the same
        const dir = app(pkgFiles('deploy', '@acme/deploy'));
        const pkgDir = path.join(dir, 'deploy');

        const keyed = await parse({ argv: ['deploy'], schema: { commands: { x: pkgDir } } });
        expect(keyed.cmd?.name).to.equal('deploy');
        expect(await keyed.cmd?.run?.(keyed as never)).to.equal('ran pkg');

        const bare = await parse({ argv: ['deploy'], schema: { commands: pkgDir } });
        expect(bare.cmd?.name).to.equal('deploy');

        const listed = await parse({ argv: ['deploy'], schema: { commands: [pkgDir] } });
        expect(listed.cmd?.name).to.equal('deploy');
      });

      it("should still lose its name to its own module's, which is a declaration", async () => {
        // the module's `name` is a name string and is read as one, so this is the
        // one place a package may still say `deploy, d`
        const dir = app({
          'pkg/index.mjs': "export default { name: 'ship, s', run() {} };\n",
          'pkg/package.json': JSON.stringify({ main: 'index.mjs', name: '@acme/deploy' }),
        });
        const result = await parse({
          argv: ['s'],
          schema: { commands: { x: path.join(dir, 'pkg') } },
        });
        expect(result.cmd?.name).to.equal('ship');
      });

      it('should not refuse a manifest the module never consulted', async () => {
        const dir = app({
          'pkg/index.mjs': "export default { name: 'ship', run() {} };\n",
          'pkg/package.json': JSON.stringify({ main: 'index.mjs', name: 'not a name' }),
        });
        const result = await parse({
          argv: ['ship'],
          schema: { commands: { x: path.join(dir, 'pkg') } },
        });
        expect(result.cmd?.name).to.equal('ship');
      });

      it('should be named by its directory when its manifest names nothing', async () => {
        const dir = app(pkgFiles('plain', undefined));
        const result = await parse({ argv: ['plain'], schema: { commands: dir } });
        expect(result.cmd?.name).to.equal('plain');
      });

      it('should collide on the name that registers, not the directory it sits in', async () => {
        // `deploy.mjs` and a package that calls itself `@acme/deploy` are both
        // `deploy`, whatever the package's directory is called
        const dir = app({ 'deploy.mjs': mod, ...pkgFiles('ship-it', '@acme/deploy') });
        await expect(parse({ argv: [], schema: { commands: dir } })).rejects.toThrow(
          /Two entries in .* both declare a "deploy" command: "deploy\.mjs" and "ship-it"/
        );
      });

      it.each([
        ['42', 42],
        ['a boolean', true],
        ['a list', ['a']],
        ['an object', { n: 'a' }],
      ])('should refuse a manifest name that is %s, naming the package', async (_what, name) => {
        // the build never builds a command for a walked package, so a number used to
        // be baked as the key and routed in the built app while source refused it
        const dir = app({
          'pkg/index.mjs': mod,
          'pkg/package.json': JSON.stringify({ main: 'index.mjs', name }),
        });
        const refusal =
          /Cannot route the package ".*pkg": its package\.json name is .*, which is not a string/;

        await expect(parse({ argv: [], schema: { commands: dir } })).rejects.toThrow(refusal);
        await expect(
          parse({ argv: [], schema: { commands: { x: path.join(dir, 'pkg') } } })
        ).rejects.toThrow(refusal);
      });

      it.each([
        ['null', 'null'],
        ['42', '42'],
        ['true', 'true'],
        ['an empty list', '[]'],
      ])(
        'should refuse a manifest name of %s whatever the entry is called and whether or not the module names itself',
        async (_what, json) => {
          // Node's own reader throws ERR_INVALID_PACKAGE_CONFIG for any present name that
          // is not a string, `null` included -- but only when it reads the format from the
          // manifest, which is a `.js` or `.ts` entry and not a `.mjs`. So the same
          // package ran or failed by extension, and a build that never imports it baked
          // the one source could not start. Refused before the import, in sigil's words
          for (const entryFile of ['index.js', 'index.mjs', 'index.ts', 'index.mts']) {
            for (const own of ['', "name: 'mine', "]) {
              const dir = app({
                [`pkg/${entryFile}`]: `export default { ${own}run() {} };\n`,
                'pkg/package.json': `{ "main": "${entryFile}", "name": ${json}, "type": "module" }`,
              });
              const refusal =
                /Cannot route the package ".*pkg": its package\.json name is .*, which is not a string/;
              const label = `${entryFile} ${own}`;

              await expect(
                parse({ argv: [], schema: { commands: dir } }),
                `walked ${label}`
              ).rejects.toThrow(refusal);
              await expect(
                parse({ argv: [], schema: { commands: { x: path.join(dir, 'pkg') } } }),
                `keyed ${label}`
              ).rejects.toThrow(refusal);
            }
          }
        }
      );

      it('should escape a C1 control character in the non-string manifest name it echoes', async () => {
        // `JSON.stringify()` leaves U+009B, the one-character CSI, as it found it
        const dir = app({
          'pkg/index.mjs': mod,
          'pkg/package.json': JSON.stringify({ main: 'index.mjs', name: ['\u009b2J'] }),
        });
        const refused = parse({ argv: [], schema: { commands: dir } });
        await expect(refused).rejects.toThrow('\\x9B2J');
        await expect(refused).rejects.not.toThrow(/\p{Cc}/u);
      });

      it('should say an empty manifest name is empty', async () => {
        const dir = app(pkgFiles('pkg', ''));
        await expect(parse({ argv: [], schema: { commands: dir } })).rejects.toThrow(/is empty/);
        await expect(
          parse({ argv: [], schema: { commands: { x: path.join(dir, 'pkg') } } })
        ).rejects.toThrow(/is empty/);
      });

      it('should escape a control character in a manifest name and in the directory it echoes', async () => {
        const dir = app(pkgFiles('pkg', '@acme/a b\x1b]0;PWNED\x07'));
        for (const commands of [dir, { x: path.join(dir, 'pkg') }]) {
          const refused = parse({ argv: [], schema: { commands } });
          await expect(refused).rejects.toThrow('a b\\x1B]0;PWNED\\x07');
          await expect(refused).rejects.not.toThrow(/\p{Cc}/u);
        }
      });

      it.each([
        ['@acme/my pkg', /contains whitespace/],
        ['my pkg', /contains whitespace/],
        ['@acme/', /is empty/],
        ['@acme', /starts with "@"/],
        ['@acme/@inner', /starts with "@"/],
        ['@acme/a/b', /contains a "\/"/],
        ['a/b', /contains a "\/"/],
        ['!hidden', /starts with "!"/],
        ['[id]', /starts with "\["/],
        ['a,b', /contains a ","/],
      ])('should refuse the manifest name %j, naming the package', async (name, reason) => {
        const dir = app(pkgFiles('pkg', name));
        const walked = parse({ argv: [], schema: { commands: dir } });
        await expect(walked).rejects.toThrow(reason);
        await expect(walked).rejects.toThrow(
          /Cannot route the package ".*pkg" \(its package\.json name is/
        );

        const pointed = parse({ argv: [], schema: { commands: { x: path.join(dir, 'pkg') } } });
        await expect(pointed).rejects.toThrow(reason);
      });
    });

    describe('a commands.json', () => {
      it('should still hide and alias a route the file system named', async () => {
        // the supported way to do what `!secret.mjs` and `my cmd.mjs` used to do
        const dir = app({
          'commands.json': JSON.stringify({
            secret: { hidden: true },
            ship: { alias: ['s', 'release'] },
          }),
          'secret.mjs': mod,
          'ship.mjs': mod,
        });

        const hidden = await parse({ argv: [], schema: { commands: dir } });
        expect(hidden.contexts[0][Internal].commands.get('secret')?.hidden).to.equal(true);

        const aliased = await parse({ argv: ['release'], schema: { commands: dir } });
        expect(aliased.cmd?.name).to.equal('ship');
      });

      it('should describe a scoped package under the name it registers as', async () => {
        const dir = app({
          'commands.json': JSON.stringify({ deploy: { alias: ['d'], hidden: true } }),
          ...pkgFiles('pkg', '@acme/deploy'),
        });
        const result = await parse({ argv: ['d'], schema: { commands: dir } });
        expect(result.cmd?.name).to.equal('deploy');
        expect(result.cmd?.hidden).to.equal(true);
      });
    });
  });
});
