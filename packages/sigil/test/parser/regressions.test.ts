import { completionSpec } from '../../src/completion/spec.js';
import { renderHelp } from '../../src/help/index.js';
import type { CommandRegistry } from '../../src/parser/command/command-registry.js';
import { initCommand } from '../../src/parser/command/init-command.js';
import { loadCommand } from '../../src/parser/command/load-command.js';
import { parse } from '../../src/parser/parse.js';
import { commandSurface } from '../../src/reference/surface.js';
import { Argument, Internal, type InternalCommand, type Schema } from '../../src/types.js';
import { camelCase } from '../../src/util/camel-case.js';
import { daysInMonth } from '../../src/util/transform.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression tests for parser correctness fixes. Each block names the defect
 * it guards against; several of these returned a plausible wrong value rather
 * than throwing, so they are easy to reintroduce unnoticed.
 */
describe('regressions', () => {
  describe('short option groups', () => {
    it('should treat an attached value as a value, not more flags', async () => {
      const result = await parse({
        argv: ['-n5'],
        schema: { options: { '-n, --num <n>': { type: 'int' } } },
      });
      expect(result.argv.num).to.equal(5);
    });

    it('should not split a multi-digit negative number into flags', async () => {
      const result = await parse({
        argv: ['--num', '-15'],
        schema: { options: { '-n, --num <n>': { type: 'int' } } },
      });
      expect(result.argv.num).to.equal(-15);
    });

    it('should still expand a group of flags', async () => {
      const result = await parse({
        argv: ['-abc'],
        schema: { options: { '-a': null, '-b': null, '-c': null } },
      });
      expect(result.argv).to.deep.equal({ a: true, b: true, c: true });
    });

    it('should let the last option in a group take the next argument', async () => {
      const result = await parse({
        argv: ['-ab', 'val'],
        schema: { options: { '-a': null, '-b <v>': null } },
      });
      expect(result.argv).to.deep.equal({ a: true, b: 'val' });
    });

    it('should take the rest of the group as the value', async () => {
      const result = await parse({
        argv: ['-abcvalue'],
        schema: { options: { '-a': null, '-b': null, '-c <v>': null } },
      });
      expect(result.argv).to.deep.equal({ a: true, b: true, c: 'value' });
    });

    it('should apply an explicit value to the last flag in a group', async () => {
      const result = await parse({
        argv: ['-ab=false'],
        schema: { options: { '-a': null, '-b': null } },
      });
      expect(result.argv).to.deep.equal({ a: true, b: false });
    });

    it('should resolve a group against a subcommand context', async () => {
      const result = await parse({
        argv: ['build', '-ab'],
        schema: {
          options: { '-a': null },
          commands: { build: { options: { '-b': null } } },
        },
      });
      expect(result.argv).to.deep.equal({ a: true, b: true });
    });
  });

  describe('empty values', () => {
    // `[n]` rather than `<n>` because angle brackets make the option itself
    // required, and a required option rejects an empty value outright
    it('should not coerce an empty value to zero', async () => {
      const result = await parse({
        argv: ['--name='],
        schema: { options: { '--name [n]': { type: 'auto' } } },
      });
      expect(result.argv.name).to.equal('');
    });

    it('should not coerce a blank value to zero', async () => {
      const result = await parse({
        argv: ['--name', ''],
        schema: { options: { '--name [n]': { type: 'auto' } } },
      });
      expect(result.argv.name).to.equal('');
    });
  });

  describe('variadic arguments and later options', () => {
    it('should not drop an option that follows a variadic argument value', async () => {
      const result = await parse({
        argv: ['one', '--foo', 'two'],
        schema: { args: ['[rest...]'], options: { '--foo': null } },
      });
      expect(result.argv.rest).to.deep.equal(['one', 'two']);
      expect(result.argv.foo).to.equal(true);
    });

    it('should not drop an unknown option that follows a variadic argument value', async () => {
      const result = await parse({
        argv: ['one', '--bar'],
        schema: { args: ['[rest...]'] },
      });
      expect(result.argv.rest).to.deep.equal(['one']);
      expect(result.argv.bar).to.equal(true);
    });
  });

  describe('option lookup', () => {
    it('should not resolve a positional value as an option of the same name', async () => {
      const result = await parse({
        argv: ['foo'],
        schema: { args: ['[x]'], options: { '--foo [bar]': null } },
      });
      expect(result.argv.x).to.equal('foo');
    });
  });

  describe('command matching', () => {
    it('should not consume an argument that repeats a command name', async () => {
      const result = await parse({
        argv: ['build', 'build'],
        schema: { commands: { build: { args: ['[x]'] } } },
      });
      expect(result.cmd?.name).to.equal('build');
      expect(result.argv.x).to.equal('build');
    });

    it('should not rematch a nested command name against an outer context', async () => {
      const result = await parse({
        argv: ['a', 'b', 'a'],
        schema: { commands: { a: { commands: { b: { args: ['[x]'] } } } } },
      });
      expect(result.cmd?.name).to.equal('b');
      expect(result.argv.x).to.equal('a');
    });

    it('should still resolve a parent option used after a subcommand', async () => {
      const result = await parse({
        argv: ['build', '--verbose'],
        schema: {
          options: { '--verbose': null },
          commands: { build: {} },
        },
      });
      expect(result.cmd?.name).to.equal('build');
      expect(result.argv.verbose).to.equal(true);
    });

    it('should still resolve a subcommand option used before the subcommand', async () => {
      const result = await parse({
        argv: ['--target', 'x', 'build'],
        schema: { commands: { build: { options: { '--target <t>': null } } } },
      });
      expect(result.cmd?.name).to.equal('build');
      expect(result.argv.target).to.equal('x');
    });
  });

  describe('flag values', () => {
    it('should honor an explicit false on a flag', async () => {
      const result = await parse({
        argv: ['--flag=false'],
        schema: { options: { '--flag': null } },
      });
      expect(result.argv.flag).to.equal(false);
    });

    it('should honor an explicit true on a flag', async () => {
      const result = await parse({
        argv: ['--flag=true'],
        schema: { options: { '--flag': null } },
      });
      expect(result.argv.flag).to.equal(true);
    });

    it('should treat the affirmative form of a negated flag as true', async () => {
      const result = await parse({
        argv: ['--colors'],
        schema: { options: { '--no-colors': null } },
      });
      expect(result.argv.colors).to.equal(true);
    });

    it('should treat an explicit false on a negated flag as a double negative', async () => {
      const result = await parse({
        argv: ['--no-colors=false'],
        schema: { options: { '--no-colors': null } },
      });
      expect(result.argv.colors).to.equal(true);
    });
  });

  describe('choices', () => {
    it('should not validate an option that was never supplied', async () => {
      // `[s]` rather than `<s>` because angle brackets make the option
      // itself required, which is this parser's own convention
      const result = await parse({
        schema: { options: { '--size [s]': { choices: ['sm', 'lg'] } } },
      });
      expect(result.argv.size).to.equal(undefined);
    });

    it('should not validate an optional option that only has a default', async () => {
      const result = await parse({
        schema: { options: { '--size [s]': { choices: ['sm', 'lg'], default: 'sm' } } },
      });
      expect(result.argv.size).to.equal('sm');
    });

    it('should reject an invalid option value', async () => {
      await expect(
        parse({
          argv: ['--size', 'xl'],
          schema: { options: { '--size <s>': { choices: ['sm', 'lg'] } } },
        })
      ).rejects.toThrow('Invalid value "xl" for option --size');
    });

    it('should validate every value of a multiple option', async () => {
      await expect(
        parse({
          argv: ['--size', 'sm', '--size', 'xl'],
          schema: { options: { '--size <s>': { choices: ['sm', 'lg'], multiple: true } } },
        })
      ).rejects.toThrow('Invalid value "xl" for option --size');
    });

    it('should enforce argument choices', async () => {
      await expect(
        parse({
          argv: ['xl'],
          schema: { args: [{ name: '<size>', choices: ['sm', 'lg'] }] },
        })
      ).rejects.toThrow('Invalid value "xl" for argument <size>');
    });

    it('should accept a valid argument value', async () => {
      const result = await parse({
        argv: ['sm'],
        schema: { args: [{ name: '<size>', choices: ['sm', 'lg'] }] },
      });
      expect(result.argv.size).to.equal('sm');
    });

    // `multiple` is about shape, so the shape cannot depend on where the value came
    // from: a string is one value even when it parses to an array
    it('should wrap an environment value that coerces to an array', async () => {
      const options = { '--items [i]': { env: 'ITEMS', multiple: true, type: 'json' } };

      const fromEnv = await parse({
        argv: [],
        env: { ITEMS: '[1,2]' },
        schema: { help: false, options },
      });
      const fromArgv = await parse({
        argv: ['--items', '[1,2]'],
        schema: { help: false, options },
      });

      expect(fromEnv.argv.items).to.deep.equal([[1, 2]]);
      expect(fromEnv.argv.items).to.deep.equal(fromArgv.argv.items);
    });

    // a string default is one value even when it parses to an array, the same way
    // the same text on the command line is one value
    it('should wrap a string default that coerces to an array', async () => {
      const options = { '--items [i]': { default: '[]', multiple: true, type: 'json' } };

      const fromDefault = await parse({ argv: [], schema: { help: false, options } });
      const fromArgv = await parse({ argv: ['--items', '[]'], schema: { help: false, options } });

      expect(fromDefault.argv.items).to.deep.equal([[]]);
      expect(fromDefault.argv.items).to.deep.equal(fromArgv.argv.items);
    });

    it('should wrap an auto environment value that coerces to an array', async () => {
      const result = await parse({
        argv: [],
        env: { ITEMS: '[1,2]' },
        schema: {
          help: false,
          options: { '--items [i]': { env: 'ITEMS', multiple: true, type: 'auto' } },
        },
      });

      expect(result.argv.items).to.deep.equal([[1, 2]]);
    });

    // an array `default` is the list itself, which is the existing rule
    it('should leave an array default as the list', async () => {
      const result = await parse({
        argv: [],
        schema: { help: false, options: { '--tag [t]': { default: ['a', 'b'], multiple: true } } },
      });
      expect(result.argv.tag).to.deep.equal(['a', 'b']);
    });

    // accumulating reads the destination back, so what it reads has to be its own:
    // the rule for a shared destination is that the last writer wins, not that it
    // extends whatever was there
    it('should not let a multiple option extend an argument array', async () => {
      const result = await parse({
        argv: ['a', '-n', '1'],
        schema: {
          help: false,
          args: [{ name: '[tag...]', choices: ['a'] }],
          options: { '-n [v]': { choices: [1], multiple: true, name: 'tag', type: 'int' } },
        },
      });

      // `['a', 1]` used to come out of this, and then failed the option's choices
      expect(result.argv.tag).to.deep.equal([1]);
    });

    it('should not let a counter increment an argument value', async () => {
      const result = await parse({
        argv: ['10', '-v'],
        schema: {
          help: false,
          args: [{ name: '[v]', type: 'int' }],
          options: { '-v': { type: 'count' } },
        },
      });

      // `-v` appeared once, so it is 1 rather than 11
      expect(result.argv.v).to.equal(1);
    });

    // two declarations on one destination replace rather than merge, which is what
    // last-writer-wins means everywhere else and what `src/infer.ts` types: a union
    // of what each source produces, never one value built out of both. An alias is
    // not a second declaration, so it still accumulates.
    it('should let the second declaration of a destination replace the first', async () => {
      const tags = await parse({
        argv: ['cmd', '--tag', 'a', '--label', 'b'],
        schema: {
          help: false,
          options: { '--tag [t]': { multiple: true } },
          commands: { cmd: { options: { '--label [l]': { multiple: true, name: 'tag' } } } },
        },
      });
      expect(tags.argv.tag).to.deep.equal(['b']);

      const counted = await parse({
        argv: ['cmd', '-v', '--verbose'],
        schema: {
          help: false,
          options: { '-v': { name: 'verbose', type: 'count' } },
          commands: { cmd: { options: { '--verbose': { type: 'count' } } } },
        },
      });
      expect(counted.argv.verbose).to.equal(1);
    });

    it('should accumulate across an alias, which is the same declaration', async () => {
      const result = await parse({
        argv: ['--tag', 'a', '-t', 'b'],
        schema: { help: false, options: { '-t, --tag [t]': { multiple: true } } },
      });
      expect(result.argv.tag).to.deep.equal(['a', 'b']);
    });

    it('should still accumulate its own repeated uses', async () => {
      const tags = await parse({
        argv: ['--tag', 'a', '--tag', 'b'],
        schema: { help: false, options: { '--tag [t]': { multiple: true } } },
      });
      expect(tags.argv.tag).to.deep.equal(['a', 'b']);

      const counted = await parse({
        argv: ['-vvv'],
        schema: { help: false, options: { '-v': { type: 'count' } } },
      });
      expect(counted.argv.v).to.equal(3);
    });

    // an option and a positional argument of the same name share a destination,
    // and each has its own `choices`: whoever wrote the value is who it answers
    // to. Validating whatever was on the destination meant the other one's rules
    // were applied to a value it did not produce.
    it('should hold each writer of a shared destination to its own choices', async () => {
      const schema = {
        help: false,
        args: [{ name: 'size', choices: ['big'] }],
        options: { '--size [s]': { choices: ['sm'] } },
      };

      expect((await parse({ argv: ['--size', 'sm'], schema })).argv.size).to.equal('sm');
      expect((await parse({ argv: ['big'], schema })).argv.size).to.equal('big');

      await expect(parse({ argv: ['--size', 'big'], schema })).rejects.toThrow(
        'Invalid value "big" for option --size'
      );
      await expect(parse({ argv: ['sm'], schema })).rejects.toThrow(
        'Invalid value "sm" for argument <size>'
      );
    });
  });

  describe('defaults and environment variables', () => {
    it('should coerce an environment variable to the declared type', async () => {
      const result = await parse({
        env: { N: '42' },
        schema: { options: { '--num <n>': { type: 'int', env: 'N' } } },
      });
      expect(result.argv.num).to.equal(42);
    });

    it('should coerce a string default to the declared type', async () => {
      const result = await parse({
        schema: { options: { '--num <n>': { type: 'int', default: '42' } } },
      });
      expect(result.argv.num).to.equal(42);
    });

    it('should leave a non-string default alone', async () => {
      const result = await parse({
        schema: { options: { '--num <n>': { type: 'int', default: 8080 } } },
      });
      expect(result.argv.num).to.equal(8080);
    });

    it('should wrap an environment fallback for a multiple option', async () => {
      const result = await parse({
        env: { TAG: 'a' },
        schema: { options: { '--tag <t>': { env: 'TAG', multiple: true } } },
      });
      expect(result.argv.tag).to.deep.equal(['a']);
    });

    it('should coerce an argument environment fallback', async () => {
      const result = await parse({
        env: { PORT: '3000' },
        schema: { args: [{ name: '[port]', type: 'int', env: 'PORT' }] },
      });
      expect(result.argv.port).to.equal(3000);
    });

    it('should prefer an environment variable over a default', async () => {
      const result = await parse({
        env: { N: '42' },
        schema: { options: { '--num <n>': { type: 'int', env: 'N', default: 8080 } } },
      });
      expect(result.argv.num).to.equal(42);
    });

    it('should prefer an environment variable over an argument default', async () => {
      const result = await parse({
        env: { PORT: '3000' },
        schema: { args: [{ name: '[port]', type: 'int', env: 'PORT', default: 8080 }] },
      });
      expect(result.argv.port).to.equal(3000);
    });

    it('should reach an environment variable through a flag implicit default', async () => {
      const result = await parse({
        env: { FORCE: 'true' },
        schema: { options: { '--force': { env: 'FORCE' } } },
      });
      expect(result.argv.force).to.equal(true);
    });

    it('should prefer an argv value over an environment variable', async () => {
      const result = await parse({
        argv: ['--num', '7'],
        env: { N: '42' },
        schema: { options: { '--num <n>': { type: 'int', env: 'N', default: 8080 } } },
      });
      expect(result.argv.num).to.equal(7);
    });

    it('should prefer an argv value over a default', async () => {
      const result = await parse({
        argv: ['--num', '7'],
        schema: { options: { '--num <n>': { type: 'int', default: 42 } } },
      });
      expect(result.argv.num).to.equal(7);
    });
  });

  describe('variadic arguments', () => {
    it('should accept <name...>', async () => {
      const result = await parse({
        argv: ['a', 'b'],
        schema: { args: ['<rest...>'] },
      });
      expect(result.argv.rest).to.deep.equal(['a', 'b']);
    });

    it('should accept [name...]', async () => {
      const result = await parse({
        argv: ['a', 'b', 'c'],
        schema: { args: ['<first>', '[rest...]'] },
      });
      expect(result.argv.first).to.equal('a');
      expect(result.argv.rest).to.deep.equal(['b', 'c']);
    });

    it('should still accept [name]...', async () => {
      const result = await parse({
        argv: ['a', 'b', 'c'],
        schema: { args: ['<first>', '[rest]...'] },
      });
      expect(result.argv.first).to.equal('a');
      expect(result.argv.rest).to.deep.equal(['b', 'c']);
    });

    it('should require a variadic declared with angle brackets', async () => {
      await expect(parse({ schema: { args: ['<rest...>'] } })).rejects.toThrow(
        'Missing required arguments: <rest>'
      );
    });
  });

  describe('a variadic argument that is not last', () => {
    it('should allow a variadic as the last argument', async () => {
      const result = await parse({
        argv: ['a', 'b', 'c'],
        schema: { args: ['<first>', '[rest...]'] },
      });
      expect(result.argv.first).to.equal('a');
      expect(result.argv.rest).to.deep.equal(['b', 'c']);
    });

    it('should allow a lone variadic', async () => {
      const result = await parse({ argv: ['a', 'b'], schema: { args: ['[rest...]'] } });
      expect(result.argv.rest).to.deep.equal(['a', 'b']);
    });

    it('should reject a variadic followed by another argument', async () => {
      await expect(parse({ schema: { args: ['<rest...>', '[extra]'] } })).rejects.toThrow(
        'Only the last argument can be variadic: <rest...> is followed by [extra] in the "global" command'
      );
    });

    it('should reject a variadic in the middle', async () => {
      await expect(parse({ schema: { args: ['<first>', '[mid...]', '[last]'] } })).rejects.toThrow(
        'Only the last argument can be variadic: [mid...] is followed by [last] in the "global" command'
      );
    });

    it('should reject two variadics and name the first', async () => {
      await expect(parse({ schema: { args: ['<a...>', '<b...>'] } })).rejects.toThrow(
        'Only the last argument can be variadic: <a...> is followed by <b...> in the "global" command'
      );
    });

    it('should reject the "[name]..." spelling too', async () => {
      await expect(parse({ schema: { args: ['[rest]...', '[extra]'] } })).rejects.toThrow(
        'Only the last argument can be variadic: [rest...] is followed by [extra] in the "global" command'
      );
    });

    it('should reject an explicit multiple that is not last', async () => {
      await expect(
        parse({ schema: { args: [{ name: 'rest', multiple: true }, '[extra]'] } })
      ).rejects.toThrow(
        'Only the last argument can be variadic: [rest...] is followed by [extra] in the "global" command'
      );
    });

    it('should reject args declared inline in a command name', async () => {
      await expect(
        parse({ argv: ['build'], schema: { commands: { 'build <files...> [extra]': {} } } })
      ).rejects.toThrow(
        'Only the last argument can be variadic: <files...> is followed by [extra] in the "build" command'
      );
    });

    it('should reject args declared on a subcommand', async () => {
      await expect(
        parse({ argv: ['build'], schema: { commands: { build: { args: ['a...', 'b'] } } } })
      ).rejects.toThrow(
        'Only the last argument can be variadic: [a...] is followed by [b] in the "build" command'
      );
    });

    it('should reject args declared by a lazy loaded command', async () => {
      const schema = {
        commands: { sub: { path: path.join(__dirname, 'fixtures/variadic/bad-args.js') } },
      };

      // the same schema object must not quietly pass the second time: a
      // failed load leaves the placeholder in place, so it has to be retried
      for (let i = 0; i < 2; i++) {
        await expect(parse({ argv: ['sub'], schema })).rejects.toThrow(
          'Only the last argument can be variadic: <rest...> is followed by [extra] in the "sub" command'
        );
      }
    });

    it('should not promote a later argument before rejecting', async () => {
      const args: Argument[] = [{ name: '[a...]' }, { name: '[b]' }, { name: '<c>' }];
      await expect(parse({ schema: { args } })).rejects.toThrow(
        'Only the last argument can be variadic'
      );
      // promotion runs after the check, and in any case only ever touches
      // the copies the parser owns
      expect(args).to.deep.equal([{ name: '[a...]' }, { name: '[b]' }, { name: '<c>' }]);
    });
  });

  describe('a lazy load that fails', () => {
    it('should throw again instead of passing the second time', async () => {
      const schema = {
        commands: { sub: { path: path.join(__dirname, 'fixtures/variadic/bad-hook.js') } },
      };

      // a command is only fully initialized once its init hooks have run, so
      // a hook that throws leaves the placeholder unloaded and has to run
      // again the next time the command is matched
      for (let i = 0; i < 2; i++) {
        await expect(parse({ argv: ['sub'], schema })).rejects.toThrow('init hook blew up');
      }
    });

    it('should throw again when the same placeholder is reloaded', async () => {
      // every parse now builds its own placeholder, so the retry above no
      // longer pins down the flag itself: load the one placeholder twice
      const { contexts } = await parse({
        argv: [],
        schema: {
          commands: { sub: { path: path.join(__dirname, 'fixtures/variadic/bad-hook.js') } },
        },
      });
      const cmd = contexts[0][Internal].commands.find('sub');
      expect(cmd).to.not.equal(undefined);

      for (let i = 0; i < 2; i++) {
        await expect(loadCommand(cmd!)).rejects.toThrow('init hook blew up');
        expect(cmd![Internal].loaded).to.not.equal(true);
      }
    });
  });

  describe('default data type', () => {
    it('should leave an untyped option value as a string', async () => {
      const result = await parse({
        argv: ['--v', '007'],
        schema: { options: { '--v <x>': null } },
      });
      expect(result.argv.v).to.equal('007');
    });

    it('should leave an untyped argument value as a string', async () => {
      const result = await parse({
        argv: ['007'],
        schema: { args: ['<v>'] },
      });
      expect(result.argv.v).to.equal('007');
    });

    it('should still coerce when a type is declared', async () => {
      const result = await parse({
        argv: ['--v', '007'],
        schema: { options: { '--v <x>': { type: 'int' } } },
      });
      expect(result.argv.v).to.equal(7);
    });
  });

  describe('command hidden', () => {
    it('should not let name parsing overwrite an explicit hidden', async () => {
      const { contexts } = await parse({
        argv: ['visible'],
        schema: { commands: { visible: { hidden: true } } },
      });
      expect(contexts[0].name).to.equal('visible');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should keep an explicit hidden on a command with inline args', async () => {
      const { contexts } = await parse({
        argv: ['build', 'src'],
        schema: { commands: { 'build, @b <path>': { hidden: true } } },
      });
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should keep an explicit hidden on a nested subcommand', async () => {
      const { contexts } = await parse({
        argv: ['outer', 'inner'],
        schema: { commands: { outer: { commands: { inner: { hidden: true } } } } },
      });
      expect(contexts[0].name).to.equal('inner');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should keep an explicit hidden on a lazy loaded command', async () => {
      const { contexts } = await parse({
        argv: ['secret'],
        schema: {
          commands: {
            secret: { path: path.join(__dirname, 'fixtures/hidden/secret.js') },
          },
        },
      });
      expect(contexts[0].name).to.equal('secret');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should keep an explicit hidden on the placeholder of a lazy loaded command', async () => {
      const { contexts } = await parse({
        argv: ['plain'],
        schema: {
          commands: {
            plain: { hidden: true, path: path.join(__dirname, 'fixtures/hidden/plain.js') },
          },
        },
      });
      expect(contexts[0].name).to.equal('plain');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should not let a lazy loaded command un-hide a "!" prefixed name', async () => {
      const { contexts } = await parse({
        argv: ['visible'],
        schema: {
          commands: {
            '!visible': { path: path.join(__dirname, 'fixtures/hidden/visible.js') },
          },
        },
      });
      expect(contexts[0].name).to.equal('visible');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should still hide a command with a "!" prefixed name', async () => {
      const { contexts } = await parse({
        argv: ['foo'],
        schema: { commands: { '!foo': {} } },
      });
      expect(contexts[0].name).to.equal('foo');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should not let an explicit false un-hide a "!" prefixed name', async () => {
      const { contexts } = await parse({
        argv: ['foo'],
        schema: { commands: { '!foo': { hidden: false } } },
      });
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should default hidden to false', async () => {
      const { contexts } = await parse({
        argv: ['foo'],
        schema: { commands: { foo: {} } },
      });
      expect(contexts[0].hidden).to.equal(false);
    });
  });

  describe('command name labels', () => {
    it('should treat a second bare label as an alias, not a rename', async () => {
      const schema = { commands: { 'build, b': {} } };

      let { contexts } = await parse({ argv: ['build'], schema });
      expect(contexts[0].name).to.equal('build');

      ({ contexts } = await parse({ argv: ['b'], schema }));
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0][Internal].label).to.equal('build, b');
    });

    it('should treat a space separated label as an alias', async () => {
      const schema = { commands: { 'build b': {} } };

      let { contexts } = await parse({ argv: ['build'], schema });
      expect(contexts[0].name).to.equal('build');

      ({ contexts } = await parse({ argv: ['b'], schema }));
      expect(contexts[0].name).to.equal('build');
    });

    it('should alias every bare label after the first', async () => {
      const schema = { commands: { 'build, b, compile': {} } };

      for (const name of ['build', 'b', 'compile']) {
        const { contexts } = await parse({ argv: [name], schema });
        expect(contexts[0].name).to.equal('build');
      }

      const { contexts } = await parse({ argv: ['build'], schema });
      expect(contexts[0][Internal].label).to.equal('build, b, compile');
    });

    it('should mix bare and "@" prefixed labels', async () => {
      const schema = { commands: { 'build, @b, compile': {} } };

      for (const name of ['build', 'b', 'compile']) {
        const { contexts } = await parse({ argv: [name], schema });
        expect(contexts[0].name).to.equal('build');
      }
    });

    it('should let a bare label name a command declared after a "@" label', async () => {
      const schema = { commands: { '@ls, list': {} } };

      let { contexts } = await parse({ argv: ['ls'], schema });
      expect(contexts[0].name).to.equal('list');

      ({ contexts } = await parse({ argv: ['list'], schema }));
      expect(contexts[0].name).to.equal('list');
      expect(contexts[0][Internal].label).to.equal('ls, list');
    });

    it('should name the command after a prefixed label when there is no bare label', async () => {
      const { contexts } = await parse({
        argv: ['b'],
        schema: { commands: { '@b, @build': {} } },
      });
      expect(contexts[0].name).to.equal('b');
    });

    it('should alias a bare label on a "!" prefixed command', async () => {
      const schema = { commands: { '!build, b': {} } };

      const { contexts } = await parse({ argv: ['b'], schema });
      expect(contexts[0].name).to.equal('b');
      expect(contexts[0].hidden).to.equal(true);
    });

    it('should hide the whole command when any label is "!" prefixed', async () => {
      const schema = { commands: { 'build, !b': {} } };

      let { contexts } = await parse({ argv: ['build'], schema });
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0].hidden).to.equal(true);
      expect(contexts[0][Internal].label).to.equal('build');

      ({ contexts } = await parse({ argv: ['b'], schema }));
      expect(contexts[0].name).to.equal('build');
    });

    it('should keep inline arguments out of the aliases', async () => {
      const schema = { commands: { 'build, b <path>': {} } };

      const { argv, contexts } = await parse({ argv: ['b', 'src'], schema });
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0][Internal].label).to.equal('build, b');
      expect(argv.path).to.equal('src');
    });

    it('should combine bare labels with the alias property', async () => {
      const schema = { commands: { 'build, b': { alias: 'compile' } } };

      for (const name of ['build', 'b', 'compile']) {
        const { contexts } = await parse({ argv: [name], schema });
        expect(contexts[0].name).to.equal('build');
      }

      const { contexts } = await parse({ argv: ['build'], schema });
      expect(contexts[0][Internal].label).to.equal('build, b');
    });

    // SIG-225: the property takes names, and `!` and `@` are name-string
    // syntax. `!` used to be registered literally, as a command called `!ls`
    // that help then printed with its `!` on
    it('should refuse a "!" or "@" prefixed alias property', async () => {
      await expect(
        parse({ argv: [], schema: { commands: { list: { alias: '!ls' } } } })
      ).rejects.toThrow(
        'Invalid alias "!ls" in the "list" command: "!" is name-string syntax and the alias property takes plain names, so hide the command with "hidden: true" or a "!" in its name'
      );
      await expect(
        parse({ argv: [], schema: { commands: { list: { alias: ['l', '@ls'] } } } })
      ).rejects.toThrow(
        'Invalid alias "@ls" in the "list" command: "@" is name-string syntax and the alias property takes plain names, so write "ls"'
      );
    });

    it('should still take a "!" or "@" inside an alias property', async () => {
      const schema = { commands: { list: { alias: ['l!', 'l@s'] } } };
      for (const name of ['l!', 'l@s']) {
        const { contexts } = await parse({ argv: [name], schema });
        expect(contexts[0].name).to.equal('list');
      }
    });

    it('should ignore leading, trailing, and doubled separators', async () => {
      for (const name of [' build, b', 'build, b, ', 'build,,b']) {
        const { contexts } = await parse({ argv: ['b'], schema: { commands: { [name]: {} } } });
        expect(contexts[0].name).to.equal('build');
        expect(contexts[0][Internal].label).to.equal('build, b');
      }
    });

    it('should hide the command on a stray "!" label', async () => {
      const { contexts } = await parse({
        argv: ['build'],
        schema: { commands: { 'build, !': {} } },
      });
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0].hidden).to.equal(true);
      expect(contexts[0][Internal].label).to.equal('build');
    });

    it('should ignore a stray "@" label', async () => {
      const { contexts } = await parse({
        argv: ['build'],
        schema: { commands: { 'build, @': {} } },
      });
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0].hidden).to.equal(false);
      expect(contexts[0][Internal].label).to.equal('build');
    });

    it('should carry inline aliases onto a lazy loaded command', async () => {
      const { contexts } = await parse({
        argv: ['b'],
        schema: {
          commands: {
            'build, b': { path: path.join(__dirname, 'fixtures/aliases/build.js') },
          },
        },
      });
      expect(contexts[0].name).to.equal('build');
      expect(contexts[0].desc).to.equal('build it');
      expect([...contexts[0][Internal].aliases]).to.deep.equal(['b']);
      expect(contexts[0][Internal].label).to.equal('build, b');
    });

    it("should merge inline aliases with a lazy loaded command's own alias", async () => {
      const schema = {
        commands: {
          'build, b': { path: path.join(__dirname, 'fixtures/aliases/compile.js') },
        },
      };

      // `compile` comes from the module, so it cannot resolve a command the
      // parser has not loaded yet, but it must survive the merge — and the
      // second pass reuses the very same schema object
      for (const name of ['build', 'b']) {
        const { contexts } = await parse({ argv: [name], schema });
        expect(contexts[0].name).to.equal('build');
        expect([...contexts[0][Internal].aliases].sort()).to.deep.equal(['b', 'compile']);
      }
    });

    it('should throw when a name has no label', async () => {
      await expect(parse({ argv: [], schema: { commands: { ' , ': {} } } })).rejects.toThrow(
        'Unable to determine command name from " , "'
      );
    });
  });
  describe('cross-model review round 1', () => {
    // `--name=value` split the token and then trimmed both halves, while a value
    // in the following token was taken as typed, so the two spellings of the
    // same thing disagreed about whitespace the caller meant
    it('should not trim whitespace out of an attached option value', async () => {
      const schema = { options: { '--name [value]': {} } };

      expect((await parse({ argv: ['--name=  padded  '], schema })).argv.name).to.equal(
        '  padded  '
      );
      expect((await parse({ argv: ['--name', '  padded  '], schema })).argv.name).to.equal(
        '  padded  '
      );
    });

    // trimming turned a value that was one space into `''`, which for a required
    // option then failed as a value that was never given
    it('should accept a single space as a required option value', async () => {
      const result = await parse({
        argv: ['--sep= '],
        schema: { options: { '--sep <value>': {} } },
      });
      expect(result.argv.sep).to.equal(' ');
    });

    // `inputs` is the split form -- `--foo=bar` was taken apart before anything
    // knew a terminator preceded it -- so flattening it made two extras of one
    it('should keep an argument after the terminator whole', async () => {
      const result = await parse({
        argv: ['--', '--foo=bar', '-x=1', 'a=b'],
        schema: {},
        settings: { allowExtraArguments: true },
      });
      expect(result._).to.deep.equal(['--foo=bar', '-x=1', 'a=b']);
    });

    // this once read an empty `int` as 0, to match `number` and `count`. That
    // made `PORT=321 mycli --port` answer 0 while `PORT=321 mycli` answered 321:
    // a valueless use beat the environment by being written during the walk.
    // The rule now runs the other way -- an option that takes a value must be
    // given one, and an empty value is a value only where the type has one
    it('should reject an empty int rather than read it as zero', async () => {
      const schema = { options: { '--port [n]': { type: 'int' } } };

      await expect(parse({ argv: ['--port'], schema })).rejects.toThrow(
        'Missing value for option --port'
      );
      await expect(parse({ argv: ['--port='], schema })).rejects.toThrow('Invalid integer:');
      await expect(parse({ argv: ['--port= '], schema })).rejects.toThrow('Invalid integer:');
    });

    // the case that started it: a valueless use no longer outranks the
    // environment, because there is no longer any such thing
    it('should let the environment answer when argv named the option alone', async () => {
      const schema = { options: { '--port [n]': { env: 'PORT', type: 'int' } } };

      expect((await parse({ argv: [], env: { PORT: '321' }, schema })).argv.port).to.equal(321);
      await expect(parse({ argv: ['--port'], env: { PORT: '321' }, schema })).rejects.toThrow(
        'Missing value for option --port'
      );
    });

    // an empty variable is read as unset, so a blank `PORT=` falls through to
    // the default instead of failing the parse on a value nobody meant to set
    it('should treat an empty environment variable as unset', async () => {
      const result = await parse({
        argv: [],
        env: { PORT: '' },
        schema: { options: { '--port [n]': { default: 8080, env: 'PORT', type: 'int' } } },
      });
      expect(result.argv.port).to.equal(8080);
    });

    // every flag read an attached value as a `bool`, so a counter given a number
    // threw, and a counter given `false` was counted up to 1 -- the counting path
    // increments and never looks at the value
    it('should let an explicit value set a counter', async () => {
      const schema = { options: { '-v, --verbose': { type: 'count' } } };

      expect((await parse({ argv: ['-v=2'], schema })).argv.verbose).to.equal(2);
      expect((await parse({ argv: ['--verbose=5'], schema })).argv.verbose).to.equal(5);
      expect((await parse({ argv: ['-v='], schema })).argv.verbose).to.equal(0);

      // and it sets rather than increments, so what follows counts up from it
      expect((await parse({ argv: ['-v', '-v=5', '-v'], schema })).argv.verbose).to.equal(6);
    });

    it('should reject a counter value that is not a number', async () => {
      await expect(
        parse({ argv: ['-v=false'], schema: { options: { '-v': { type: 'count' } } } })
      ).rejects.toThrow('Invalid count: false');
    });

    // the lookup was a plain object, so `#lookup['__proto__'] = name` went
    // through `Object.prototype`'s accessor and was dropped: the command
    // registered and could never be matched
    it('should match a command named __proto__', async () => {
      const result = await parse({
        argv: ['__proto__'],
        schema: { commands: { ['__proto__']: { desc: 'proto' } } },
      });
      expect(result.cmd?.name).to.equal('__proto__');
    });

    // the same plain-object hazard on the option registry. Argv reaches an
    // option by its dashed spelling, which registers fine, so the parse was
    // right -- but the bare name is a key too, and that one was dropped, so
    // `get()` could not find an option the registry holds. The registries are
    // what a hook is handed, so that is somebody's lookup
    it('should find an option named __proto__ by name', async () => {
      const result = await parse({
        argv: ['--__proto__', 'x'],
        schema: { options: { '--__proto__ [v]': {} } },
      });
      const options = result.contexts[0][Internal].options;
      const opt = [...options.values()][0];

      expect(opt.name).to.equal('__proto__');
      expect(options.get('__proto__')).to.equal(opt);
      expect(options.find('--__proto__')).to.equal(opt);
      expect(result.argv.Proto_).to.equal('x');
    });

    // an `exports` map nests, and unwrapping exactly one level left a conditions
    // object that reached `join()` as `[object Object]`
    it('should load a command package with conditional exports', async () => {
      const result = await parse({
        argv: ['conditions'],
        schema: { commands: path.join(__dirname, 'fixtures/good-pkg-export-conditions') },
      });
      expect(result.cmd?.name).to.equal('conditions');
      expect(result.cmd?.desc).to.equal('Conditions command');
    });

    // a fallback array means "the first of these that works", and whether one
    // works is a question about the file system: returning only the first
    // string named a path that does not exist and called the package broken
    it('should try every candidate in an exports fallback array', async () => {
      const result = await parse({
        argv: ['fallback'],
        schema: { commands: path.join(__dirname, 'fixtures/good-pkg-export-fallback') },
      });
      expect(result.cmd?.name).to.equal('fallback');
      expect(result.cmd?.desc).to.equal('Fallback command');
    });

    // `typeof null` is `'object'` and so is an array, so both slipped past the
    // check: the parse succeeded with a command that has no `run`, and the load
    // was recorded as done so it was never retried
    it.each([
      ['null', 'null-default.js'],
      ['an array', 'array-default.js'],
    ])('should reject a command module that default exports %s', async (_label, file) => {
      await expect(
        parse({
          argv: ['foo'],
          schema: { commands: { foo: { path: path.join(__dirname, 'fixtures', file) } } },
        })
      ).rejects.toThrow('Command module default export is not a valid command object');
    });
  });
  describe('cross-model review round 2', () => {
    // `dateRE` checks the shape and `Date` does the rest, and `Date` overflows
    // rather than refusing, so a day that does not exist produced the wrong day
    // instead of the error `9999-99-99` already got
    it.each([
      ['2024-02-30', '2024-03-01'],
      ['2023-02-29', '2023-03-01'],
      ['2024-04-31', '2024-05-01'],
      ['2024-13-01', 'the next year'],
    ])('should reject the impossible date %s', async (value) => {
      await expect(
        parse({ argv: ['--when', value], schema: { options: { '--when <d>': { type: 'date' } } } })
      ).rejects.toThrow(`Invalid date: "${value}"`);
    });

    // the control: the round trip must not reject dates that are real, including
    // a leap day, a month end, and the forms that carry a time
    it.each([
      '2024-02-29',
      '2024-01-31',
      '2024-12-31',
      '2024-06-15T12:30:00',
      '2024-06-15T12:30:00Z',
      '2024-06-15T12:30:00.123Z',
    ])('should still accept the valid date %s', async (value) => {
      const result = await parse({
        argv: ['--when', value],
        schema: { options: { '--when <d>': { type: 'date' } } },
      });
      expect(result.argv.when).to.be.instanceOf(Date);
    });

    it('should still accept a 13-digit epoch', async () => {
      const result = await parse({
        argv: ['--when', '1718454600000'],
        schema: { options: { '--when <d>': { type: 'date' } } },
      });
      expect((result.argv.when as Date).getTime()).to.equal(1718454600000);
    });

    // `Number('')` and `Number(' ')` are both 0, which would make an empty or
    // blank value parse as zero where every other valued type rejects it
    it('should reject an empty or blank number', async () => {
      const schema = { options: { '--port [n]': { type: 'number' } } };

      await expect(parse({ argv: ['--port='], schema })).rejects.toThrow('Invalid number:');
      await expect(parse({ argv: ['--port= '], schema })).rejects.toThrow('Invalid number:');
      await expect(parse({ argv: ['--port=\t'], schema })).rejects.toThrow('Invalid number:');

      // a real number with space around it is still that number: `Number()`
      // trims, and only a value with nothing else in it is the empty one
      expect((await parse({ argv: ['--port= 42 '], schema })).argv.port).to.equal(42);
    });

    // past 2^53-1 a `number` is not the integer that was written, so an id given
    // to an `int` option came back as a different id and nothing said so
    it('should reject an int too large to be exact', async () => {
      await expect(
        parse({
          argv: ['--id', '9007199254740993'],
          schema: { options: { '--id <n>': { type: 'int' } } },
        })
      ).rejects.toThrow('Integer is too large to be exact: 9007199254740993');
    });

    // the control: everything inside the safe range still parses, hex and
    // negatives included
    it.each([
      ['9007199254740991', 9007199254740991],
      ['-9007199254740991', -9007199254740991],
      ['0', 0],
      ['-15', -15],
      ['0xff', 255],
      ['007', 7],
    ])('should still accept the int %s', async (value, expected) => {
      const result = await parse({
        argv: ['--id', value],
        schema: { options: { '--id <n>': { type: 'int' } } },
      });
      expect(result.argv.id).to.equal(expected);
    });
  });
  describe('cross-model review round 3', () => {
    // `/^auto|bool|count|date|int|json|number|string|yesno$/` reads as `^auto` OR
    // `bool` OR ... OR `yesno$`: the alternation binds looser than the anchors, so
    // any string merely containing one of the middle names passed the guard. Past
    // it, `transformValue()` does not know that name and hands back the raw
    // string, so a `type: 'integer'` option quietly produced a string
    it.each(['integer', 'boolean', 'autoload', 'stringify', 'number2', 'jsonl'])(
      'should reject the option data type %s',
      async (type) => {
        await expect(
          parse({ argv: ['--port', '8080'], schema: { options: { '--port <n>': { type } } } })
        ).rejects.toThrow(`Option "port" has unsupported data type "${type}"`);
      }
    );

    it.each(['integer', 'boolean', 'autoload', 'stringify'])(
      'should reject the argument data type %s',
      async (type) => {
        await expect(
          parse({ argv: ['8080'], schema: { args: [{ name: 'port', type }] } })
        ).rejects.toThrow(`Argument "port" has unsupported data type "${type}"`);
      }
    );

    // the control: every name the guard is meant to accept still does
    it.each(['auto', 'bool', 'count', 'date', 'int', 'json', 'number', 'string', 'yesno'])(
      'should still accept the option data type %s',
      async (type) => {
        const flag = type === 'count' || type === 'bool' || type === 'yesno';
        await expect(
          parse({
            argv: [],
            schema: { options: { [flag ? '--on' : '--port [n]']: { type } } },
          })
        ).resolves.toBeTruthy();
      }
    );

    // the parts of a date are checked arithmetically rather than by reading them
    // back off the `Date`, because those getters are local while the value may be
    // UTC -- `2024-06-15T00:00:00Z` is the 14th in Chicago and the 15th in
    // Auckland, so a round trip rejected real instants depending on where it ran
    it('should accept a UTC instant whose local day differs', async () => {
      const schema = { options: { '--when <d>': { type: 'date' } } };

      for (const value of [
        '2024-06-15T00:00:00Z',
        '2024-06-15T23:59:59Z',
        '2024-01-01T00:00:00Z',
      ]) {
        const result = await parse({ argv: ['--when', value], schema });
        expect((result.argv.when as Date).toISOString()).to.equal(new Date(value).toISOString());
      }
    });
  });

  describe('the clock in a date', () => {
    // only the calendar was checked, and hour 24 is a legal two-digit match that
    // `Date` accepts: `2024-01-01T24:00:00` is a perfectly valid `Date` for the
    // next midnight, so the `Invalid Date` guard never fired and a value naming
    // January 1st arrived as the 2nd -- the same overflow as `2024-02-30`
    it.each([
      '2024-01-01T24:00:00',
      '2024-01-01T24:00:00Z',
      '2024-06-15T99:00:00',
      '2024-06-15T12:60:00',
      '2024-06-15T23:59:60',
      '2024-06-15T12:00:00+24:00',
      '2024-06-15T12:00:00-05:60',
    ])('should reject the impossible clock %s', async (value) => {
      await expect(
        parse({ argv: ['--when', value], schema: { options: { '--when <d>': { type: 'date' } } } })
      ).rejects.toThrow(`Invalid date: "${value}"`);
    });

    // the control: the ends of a real clock, and the offsets the docs promised
    // while the pattern took only `Z`
    it.each([
      '2024-06-15T00:00:00',
      '2024-06-15T23:59:59',
      '2024-06-15T23:59:59.999Z',
      '2024-06-15T12:00:00+00:00',
      '2024-06-15T12:00:00-05:30',
      '2024-06-15T12:00:00+14:00',
    ])('should still accept the valid clock %s', async (value) => {
      const result = await parse({
        argv: ['--when', value],
        schema: { options: { '--when <d>': { type: 'date' } } },
      });
      expect(result.argv.when).to.be.instanceOf(Date);
    });

    // an offset is not decoration: it names an instant, and the value has to be
    // that instant wherever the process happens to be running
    it('should read a UTC offset as the instant it names', async () => {
      const result = await parse({
        argv: ['--when', '2024-06-15T12:00:00+05:30'],
        schema: { options: { '--when <d>': { type: 'date' } } },
      });
      expect((result.argv.when as Date).toISOString()).to.equal('2024-06-15T06:30:00.000Z');
    });
  });

  describe('a filled argument reported as missing', () => {
    // the walk is backwards and reported every argument before one it had already
    // found missing, which named a slot `applyFallback()` had just filled: only
    // `<b>` was ever missing, and `<a>` was a value the user had supplied
    it('should not name an argument its default filled', async () => {
      await expect(
        parse({ schema: { args: [{ default: 'filled', name: '<a>' }, '<b>'] } })
      ).rejects.toThrow('Missing required arguments: <b>');
    });

    it('should not name an argument its environment variable filled', async () => {
      await expect(
        parse({ env: { A: 'filled' }, schema: { args: [{ env: 'A', name: '<a>' }, '<b>'] } })
      ).rejects.toThrow('Missing required arguments: <b>');
    });

    // the control: promotion is what collects the run now, and it makes every
    // argument before a required one required, variadic or not
    it.each([
      [['<a>', '<b>', '<c>'], '<a> <b> <c>'],
      [['[a]', '<b>'], '<a> <b>'],
      [['<a>', '<rest...>'], '<a> <rest>'],
      [['[a]', '<b>', 'c'], '<a> <b>'],
    ])('should still name every missing required argument in %s', async (args, expected) => {
      await expect(parse({ schema: { args } })).rejects.toThrow(
        `Missing required arguments: ${expected}`
      );
    });

    it('should still accept a list of arguments that are all optional', async () => {
      const result = await parse({ schema: { args: ['a', 'b'] } });
      expect(result.argv).to.deep.equal({});
    });
  });

  describe('daysInMonth and the first hundred years', () => {
    // `Date.UTC` maps a year of 0 to 99 onto 1900 to 1999, and `daysInMonth()`
    // asked it, so February of year 0 -- a leap year -- was counted with 1900's 28
    // days and `0000-02-29` was refused, while `0100-02-29` is refused for the
    // right reason. The rule is written out so that no year goes through a mapping
    it.each([
      [0, 29],
      [4, 29],
      [96, 29],
      [99, 28],
      [100, 28],
      [400, 29],
      [1900, 28],
      [2000, 29],
      [2023, 28],
      [2024, 29],
      [2100, 28],
    ])('should count February of year %i as %i days', (year, days) => {
      expect(daysInMonth(year, 2)).to.equal(days);
    });

    it.each([
      [1, 31],
      [3, 31],
      [4, 30],
      [5, 31],
      [6, 30],
      [7, 31],
      [8, 31],
      [9, 30],
      [10, 31],
      [11, 30],
      [12, 31],
    ])('should count month %i as %i days in year 0 as in any other', (month, days) => {
      expect(daysInMonth(0, month)).to.equal(days);
      expect(daysInMonth(2023, month)).to.equal(days);
    });

    it.each(['0000-02-29', '0004-02-29', '0096-02-29', '0400-02-29', '0096-02-29T10:00:00'])(
      'should accept the leap day %s as a date',
      async (value) => {
        const result = await parse({
          argv: ['--when', value],
          schema: { options: { '--when <d>': { type: 'date' } } },
        });
        const when = result.argv.when as Date;
        expect(when).to.be.instanceOf(Date);
        expect(when.getMonth()).to.equal(1);
        expect(when.getDate()).to.equal(29);
      }
    );

    it.each(['0000-02-29', '0096-02-29'])(
      'should read the leap day %s as a date in auto',
      async (value) => {
        const result = await parse({
          argv: ['--when', value],
          schema: { options: { '--when <d>': { type: 'auto' } } },
        });
        expect(result.argv.when).to.be.instanceOf(Date);
      }
    );

    it.each(['0001-02-29', '0099-02-29', '0100-02-29', '0300-02-29'])(
      'should still reject %s, which is not a leap day',
      async (value) => {
        await expect(
          parse({
            argv: ['--when', value],
            schema: { options: { '--when <d>': { type: 'date' } } },
          })
        ).rejects.toThrow(`Invalid date: "${value}"`);
      }
    );
  });

  describe('auto and a date that does not exist', () => {
    // `date` has its calendar checked before the `Date` is built and `auto`
    // matched the same `dateRE` with no check at all, so the defect stayed alive
    // on the second path: `2024-02-30` was March 1st and `2024-13-01` an
    // `Invalid Date`, an object whose `getTime()` is `NaN` with nothing saying
    // so. It is not a date, so it is not the date guess -- `auto` ends at the
    // string it was handed, the way it does for JSON it cannot parse
    const impossible = [
      '2024-02-30',
      '2023-02-29',
      '2024-04-31',
      '2024-13-01',
      '2024-00-10',
      '2024-06-15T25:00:00',
      '2024-06-15T12:61:00',
      // the clock and the offset reach `auto` for the same reason the calendar
      // does: they went into the one function both types read a match through
      // rather than beside it, so the widened pattern cannot mean one thing to
      // `date` and another here
      '2024-01-01T24:00:00',
      '2024-06-15T23:59:60',
      '2024-06-15T12:00:00+24:00',
      '2024-06-15T12:00:00-05:60',
    ];

    it.each(impossible)('should leave the impossible date %s a string', async (value) => {
      const result = await parse({
        argv: ['--when', value],
        schema: { options: { '--when <d>': { type: 'auto' } } },
      });
      expect(result.argv.when).to.equal(value);
    });

    // the same values on the path nobody opted into: an undeclared option is
    // coerced with `auto`, which is how this was reachable without anybody
    // writing `type: 'auto'`
    it.each(impossible)(
      'should leave the impossible date %s a string on an undeclared option',
      async (value) => {
        const result = await parse({ argv: ['--when', value], schema: {} });
        expect(result.argv.when).to.equal(value);
      }
    );

    // the control: a date that exists is still a `Date`, the leap day and the
    // forms that carry a time included
    it.each([
      '2024-02-29',
      '2024-01-31',
      '2024-12-31',
      '2024-06-15T12:30:00',
      '2024-06-15T12:30:00Z',
      '2024-06-15T12:30:00.123Z',
      '2024-06-15T12:00:00+00:00',
      '2024-06-15T12:00:00-05:30',
    ])('should still read the valid date %s as a Date', async (value) => {
      const result = await parse({
        argv: ['--when', value],
        schema: { options: { '--when <d>': { type: 'auto' } } },
      });
      expect(result.argv.when).to.be.instanceOf(Date);

      // a value with no time is local midnight, which is what `auto` and `date`
      // both build by appending `T00:00:00` -- `new Date('2024-01-31')` alone is
      // UTC midnight and a different instant everywhere but UTC
      const expected = new Date(value.includes('T') ? value : `${value}T00:00:00`);
      expect((result.argv.when as Date).toISOString()).to.equal(expected.toISOString());
    });

    // the check `auto` now shares is arithmetic, so it does not reject a real
    // instant for being a different day wherever the process happens to run
    it.each(['2024-06-15T00:00:00Z', '2024-06-15T23:59:59Z', '2024-01-01T00:00:00Z'])(
      'should accept the UTC instant %s whose local day differs',
      async (value) => {
        const result = await parse({ argv: ['--when', value], schema: {} });
        expect((result.argv.when as Date).toISOString()).to.equal(new Date(value).toISOString());
      }
    );

    // `date` reads a 13-digit epoch and `auto` reads a number: the two match
    // different shapes on purpose, and sharing the calendar check must not
    // quietly hand `auto` the epoch form as well
    it('should still read a 13-digit epoch as a number', async () => {
      const result = await parse({
        argv: ['--when', '1718454600000'],
        schema: { options: { '--when <d>': { type: 'auto' } } },
      });
      expect(result.argv.when).to.equal(1718454600000);
    });
  });

  describe('destinations and the process locale', () => {
    // `camelCase()` used `toLocaleUpperCase()`, which reads the process locale:
    // in Turkish and Azeri `i` uppercases to `İ` (U+0130), so `--log-info` landed
    // on `logİnfo` while `src/infer.ts` -- which writes the same rule with
    // `Capitalize`, and is locale-independent -- still said `logInfo`. The types
    // and the runtime disagreed on the user's machine and nowhere else
    it('should not read the process locale for a destination', async () => {
      // what the old implementation did wherever the locale was Turkish
      expect('log-info'.replace(/[-_ ]+(\w)/g, (s, m) => m.toLocaleUpperCase('tr-TR'))).to.equal(
        'logİnfo'
      );

      const localeUpper = String.prototype.toLocaleUpperCase;
      const spy = vi.spyOn(String.prototype, 'toLocaleUpperCase').mockImplementation(function (
        this: string
      ) {
        return localeUpper.call(this, 'tr-TR');
      });

      try {
        // the unit, with nothing awaited while the prototype is patched
        expect(camelCase('log-info')).to.equal('logInfo');

        const result = await parse({
          argv: ['--log-info', 'x', '--log-init', 'y', 'z'],
          schema: {
            args: [{ name: 'out-file' }],
            options: { '--log-info <v>': {} },
          },
        });

        expect(result.argv.logInfo).to.equal('x');
        // an undeclared option names its destination the same way
        expect(result.argv.logInit).to.equal('y');
        // and so does an argument
        expect(result.argv.outFile).to.equal('z');
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * A command's own `path` was joined with the directory of the module that
   * declared it and the subcommands that module declared were not, so an
   * installed CLI looked for them in whatever directory the user was standing
   * in. The fixtures under `fixtures/nested` say the same thing from every
   * direction: nothing in them resolves from the working directory, whichever
   * that is, so a path that is not read against the module it was written in
   * does not resolve at all.
   */
  describe("a loaded module's nested commands", () => {
    const nested = path.join(__dirname, 'fixtures/nested');
    const build = { commands: { build: path.join(nested, 'build.js') } };

    it('should resolve a string path against the module that declared it', async () => {
      // vitest runs each test file in a worker thread, where `process.chdir()`
      // throws, so the working directory is left alone and the fixture is what
      // keeps the test honest: this is the path the old resolution produced
      expect(existsSync(path.resolve(process.cwd(), 'all.js'))).to.equal(false);

      const result = await parse({ argv: ['build', 'all'], schema: build });
      expect(result.cmd?.desc).to.equal('build everything');
    });

    it('should resolve an object path against the module that declared it', async () => {
      const result = await parse({ argv: ['build', 'obj'], schema: build });
      expect(result.cmd?.desc).to.equal('reached by the object form');
    });

    // the control: an absolute path never needed a base, and still does not
    // get one -- `resolve()` hands it back rather than hanging it off the
    // module's directory the way `join()` would have
    it('should leave an absolute path alone', async () => {
      const result = await parse({ argv: ['build', 'here'], schema: build });
      expect(result.cmd?.desc).to.equal('reached by an absolute path');
    });

    it("should keep a placeholder's own subcommands with the file that declared it", async () => {
      // `obj` is declared in `build.js` and its module is a directory further
      // down, so the two halves of that command disagree about what `./` means:
      // the subcommand the declaration gave belongs to `build.js`, and only the
      // module's own paths belong to the module
      const result = await parse({ argv: ['build', 'obj', 'carried'], schema: build });
      expect(result.cmd?.desc).to.equal('declared beside the file that declared the placeholder');
    });

    it("should record the loaded module's own directory as its base", async () => {
      // what a hook of the module's reads off the command it is handed, and
      // what the module's own `path` and subcommands resolve against -- the
      // placeholder's subcommands coming across does not drag its base along
      const result = await parse({ argv: ['build', 'obj'], schema: build });
      expect(result.cmd?.[Internal].baseDir).to.equal(path.join(nested, 'sub'));
    });

    it('should follow each module to its own directory', async () => {
      // `all.js` reaches down into `sub/`, and what `sub/deep.js` declares is
      // relative to `sub/` rather than to the module two levels above it
      const result = await parse({ argv: ['build', 'all', 'deep', 'deeper'], schema: build });
      expect(result.cmd?.desc).to.equal('four levels down');
      expect(result.contexts.map((c) => c.name)).to.deep.equal([
        'deeper',
        'deep',
        'all',
        'build',
        'global',
      ]);
    });

    it('should resolve a directory and a package against the module', async () => {
      const schema = { commands: { dirs: path.join(nested, 'dirs.js') } };

      let result = await parse({ argv: ['dirs', 'extra'], schema });
      expect(result.cmd?.desc).to.equal('from a directory next to the module');

      result = await parse({ argv: ['dirs', 'pkg'], schema });
      expect(result.cmd?.desc).to.equal('from a package next to the module');
    });
  });

  describe('siblings registered in the order their initialization finished', () => {
    // a timer fires only once the microtask queue is empty, and building an
    // inline declaration is nothing but microtasks -- so a sibling whose `init`
    // hook waits on one finishes after every inline sibling beside it, however
    // they were declared. That is what makes these tests about the order rather
    // than about timing: under the defect the slow sibling registers last every
    // time, not usually
    //
    // the shared spelling is an alias both siblings declare. These were written
    // over an alias that took a sibling's *name*, which is refused now -- see
    // `an alias that takes a sibling's name` below -- and two aliases are what
    // still share a spelling and still show which registration came last
    const slow = { init: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
    const run = (): void => {};
    const quiet = { completion: false, help: false, quiet: false } as const;

    it('should give a shared spelling to the later sibling when the earlier one is slower', async () => {
      const commands = {
        ship: { alias: 'go', hooks: slow, run },
        other: { alias: 'go', run },
      };

      let result = await parse({ argv: ['go'], schema: { commands } });
      expect(result.cmd?.name).to.equal('other');

      // `ship` lost an alias and kept its name, which is why this is not refused
      result = await parse({ argv: ['ship'], schema: { commands } });
      expect(result.cmd?.name).to.equal('ship');
    });

    it('should give it to the later sibling when the later one is slower', async () => {
      // the control: the order the defect happened to get right
      const result = await parse({
        argv: ['go'],
        schema: {
          commands: { ship: { alias: 'go', run }, other: { alias: 'go', hooks: slow, run } },
        },
      });
      expect(result.cmd?.name).to.equal('other');
    });

    it('should not let an option on the earlier sibling hand it the spelling', async () => {
      // the ticket's own pair: declaring an option is more to initialize, and
      // was enough on its own to move a spelling from one command to the other
      for (const options of [undefined, { '--force': {} }]) {
        const result = await parse({
          argv: ['go'],
          schema: {
            commands: { ship: { alias: 'go', options, run }, other: { alias: 'go', run } },
          },
        });
        expect(result.cmd?.name).to.equal('other');
      }
    });

    it('should do the same for an array of declarations', async () => {
      const result = await parse({
        argv: ['go'],
        schema: {
          commands: [
            { alias: 'go', hooks: slow, name: 'ship', run },
            { alias: 'go', name: 'other', run },
          ],
        },
      });
      expect(result.cmd?.name).to.equal('other');
    });

    it('should register siblings in declaration order', async () => {
      // the order help lists them in, which is the registry's insertion order
      const result = await parse({
        schema: {
          ...quiet,
          commands: { zeta: { hooks: slow, run }, alpha: { run }, mid: { options: { '--x': {} } } },
        },
      });
      expect([...result.contexts[0][Internal].commands.keys()]).to.deep.equal([
        'zeta',
        'alpha',
        'mid',
      ]);
    });

    it('should register a path in declaration order beside an inline declaration', async () => {
      // a package is imported while the schema is built, which is real I/O and
      // the shape a slow sibling has in an app rather than in a test. It names
      // itself `foo`
      //
      // asserted on the registry's order alone: the package declares no alias
      // to share, and the inline sibling taking the package's name is refused
      const pkg = path.join(__dirname, 'fixtures/good-pkg');
      const schema = { ...quiet, commands: [pkg, { name: 'other', run }] };

      const result = await parse({ schema });
      expect([...result.contexts.at(-1)![Internal].commands.keys()]).to.deep.equal([
        'foo',
        'other',
      ]);
    });

    it("should do the same for a lazily loaded module's own commands", async () => {
      const result = await parse({
        argv: ['db', 'go'],
        schema: {
          commands: {
            db: {
              load: () =>
                Promise.resolve({
                  default: {
                    commands: {
                      ship: { alias: 'go', hooks: slow, run },
                      other: { alias: 'go', run },
                    },
                  },
                }),
            },
          },
        },
      });
      expect(result.cmd?.name).to.equal('other');
    });

    it("should do the same for a placeholder's commands handed to its module", async () => {
      // registered on the placeholder, then carried across in the registry's
      // own order -- which is only declaration order if registering was
      const result = await parse({
        argv: ['db', 'go'],
        schema: {
          commands: {
            db: {
              commands: { ship: { alias: 'go', hooks: slow, run }, other: { alias: 'go', run } },
              load: () => Promise.resolve({ default: { desc: 'the module' } }),
            },
          },
        },
      });
      expect(result.contexts[1].desc).to.equal('the module');
      expect(result.cmd?.name).to.equal('other');
    });

    it('should do the same for a command a subcommandLoaded hook replaced', async () => {
      const result = await parse({
        argv: ['db', 'go'],
        schema: {
          commands: { db: { load: () => Promise.resolve({ default: {} }) } },
          hooks: {
            subcommandLoaded: () => ({
              commands: { ship: { alias: 'go', hooks: slow, run }, other: { alias: 'go', run } },
            }),
          },
        },
      });
      expect(result.cmd?.name).to.equal('other');
    });

    it('should keep a directory walk sorted', async () => {
      // asserted unsorted, which the route tests elsewhere do not: they sort
      // the names first, so a walk that registered in `readdir` order would
      // pass them. Sorted by entry, so `pkg/` is where `pkg` sorts even though
      // its manifest names it `routes-pkg`
      const routes = path.join(__dirname, 'fixtures/routes');

      let result = await parse({ schema: { ...quiet, commands: routes } });
      expect([...result.contexts[0][Internal].commands.keys()]).to.deep.equal([
        'build',
        'clash',
        'config',
        'db',
        'deploy',
        'only-index',
        'routes-pkg',
        'private-index',
      ]);

      // and a level walked when argv reached it, which is `loadCommandDir()`
      result = await parse({ argv: ['config'], schema: { ...quiet, commands: routes } });
      expect([...result.cmd![Internal].commands.keys()]).to.deep.equal(['get', 'set']);
    });
  });

  describe("an alias that takes a sibling's name", () => {
    // a later registration wins a shared spelling, and when the spelling is a
    // sibling's *name* that leaves the sibling with none: `mycli ship` ran
    // `other`, nothing reached `ship`, and help went on listing it. Refused
    // wherever siblings arrive -- while the schema is built where the alias is
    // declared there, and when the module loads where only the module knows
    const run = (): void => {};
    const taken = (owner: string, name: string): string =>
      `The "${owner}" command's alias "${name}" is the name of a sibling command: "${name}" would run "${owner}" and nothing could reach the "${name}" command, so remove the alias or rename one of the two`;
    const fixtures = path.join(__dirname, 'fixtures/alias-takes-name');

    it('should refuse a property alias in a commands object', async () => {
      await expect(
        parse({
          argv: ['ship'],
          schema: { commands: { ship: { run }, other: { alias: 'ship', run } } },
        })
      ).rejects.toThrow(taken('other', 'ship'));
    });

    it('should refuse it when the alias is declared before the name', async () => {
      // the name arriving second is the same mistake: one command has lost the
      // one spelling that must always reach it
      await expect(
        parse({ schema: { commands: { other: { alias: ['go', 'ship'], run }, ship: { run } } } })
      ).rejects.toThrow(taken('other', 'ship'));
    });

    it('should refuse a name-string alias, whatever its prefix', async () => {
      for (const label of ['other, ship', 'other @ship', 'other, !ship', '@ship, other']) {
        await expect(
          parse({ schema: { commands: { ship: { run }, [label]: { run } } } })
        ).rejects.toThrow(taken('other', 'ship'));
      }
    });

    it('should refuse it in an array of declarations', async () => {
      await expect(
        parse({
          schema: {
            commands: [
              { name: 'ship', run },
              { alias: 'ship', name: 'other', run },
            ],
          },
        })
      ).rejects.toThrow(taken('other', 'ship'));
    });

    it('should refuse it beside a nested command, at the level it is declared', async () => {
      // a registry is one level of siblings, so the same name one level up is
      // not a sibling and is not refused
      const schema = {
        commands: {
          db: { commands: { migrate: { run }, seed: { alias: 'migrate', run } } },
          migrate: { run },
        },
      };
      await expect(parse({ schema })).rejects.toThrow(taken('seed', 'migrate'));

      const ok = await parse({
        argv: ['migrate'],
        schema: {
          commands: { db: { commands: { seed: { alias: 'migrate', run } } }, migrate: { run } },
        },
      });
      expect(ok.cmd?.name).to.equal('migrate');
    });

    it("should refuse a command an index module declares with a walked route's name", async () => {
      // the walk found `db/migrate.js`, and `db/index.js` declares a `seed`
      // aliased `migrate` beside it -- known once `db` is reached and its level
      // read, which is when it throws
      const schema = { commands: fixtures };
      await expect(parse({ argv: ['db'], schema })).rejects.toThrow(taken('seed', 'migrate'));
    });

    it("should refuse a walked module whose own export takes a sibling route's name", async () => {
      // `deploy.js` exports `alias: 'build'` beside `build.js`. Nothing knows
      // until the module loads, so `mycli build` -- which never loads it -- is
      // fine, and `mycli deploy` is refused
      const schema = { commands: fixtures };
      expect((await parse({ argv: ['build'], schema })).cmd?.name).to.equal('build');
      await expect(parse({ argv: ['deploy'], schema })).rejects.toThrow(taken('deploy', 'build'));
    });

    it("should refuse a lazily loaded module's own alias when it loads", async () => {
      const load = (): Promise<unknown> => Promise.resolve({ default: { alias: 'ship', run } });
      const schema = { commands: { ship: { run }, other: { load } } };

      expect((await parse({ argv: ['ship'], schema })).cmd?.name).to.equal('ship');
      await expect(parse({ argv: ['other'], schema })).rejects.toThrow(taken('other', 'ship'));
      // and through `help`, which loads a command to describe it
      await expect(parse({ argv: ['help', 'other'], schema })).rejects.toThrow(
        taken('other', 'ship')
      );
    });

    it('should refuse it again the next time the command is matched', async () => {
      // the load is not marked done when it is refused, so a second match
      // reads the module again rather than quietly resolving to the placeholder
      const schema = {
        commands: {
          ship: { run },
          other: { load: () => Promise.resolve({ default: { alias: 'ship', run } }) },
        },
      };
      const result = await parse({ schema });
      const root = result.contexts[0];
      const other = root[Internal].commands.find('other')!;

      await expect(loadCommand(other, root)).rejects.toThrow(taken('other', 'ship'));
      expect(other[Internal].loaded).to.equal(false);
      await expect(loadCommand(other, root)).rejects.toThrow(taken('other', 'ship'));
    });

    it('should refuse a module that renames itself onto a sibling alias', async () => {
      // the other direction at load time: the module's name is the late arrival
      const schema = {
        commands: {
          other: { alias: 'ship', run },
          placeholder: { load: () => Promise.resolve({ default: { name: 'ship', run } }) },
        },
      };
      await expect(parse({ argv: ['placeholder'], schema })).rejects.toThrow(
        taken('other', 'ship')
      );
    });

    it("should refuse a module that renames itself onto a sibling's name", async () => {
      // no alias at all, and the same outcome: written back under the name its
      // module gives it, `placeholder` takes `ship`'s key and nothing reaches
      // `ship`. Its own error, because there is no alias to name
      const schema = {
        commands: {
          ship: { run },
          placeholder: { load: () => Promise.resolve({ default: { name: 'ship', run } }) },
        },
      };
      expect((await parse({ argv: ['ship'], schema })).cmd?.name).to.equal('ship');
      await expect(parse({ argv: ['placeholder'], schema })).rejects.toThrow(
        'The "placeholder" command\'s module renames it "ship", which is the name of a sibling command: "ship" would run "placeholder" and nothing could reach the "ship" command, so rename one of the two'
      );
    });

    it('should refuse it through a topic walk', async () => {
      // `db:other` loads `other` as the walk goes, which is the same
      // `loadCommand()` the space form reaches
      const schema = {
        commands: {
          db: {
            commands: {
              ship: { run },
              other: {
                commands: { up: { run } },
                load: () => Promise.resolve({ default: { alias: 'ship' } }),
              },
            },
          },
        },
        topicSeparator: ':' as const,
      };
      await expect(parse({ argv: ['db:other:up'], schema })).rejects.toThrow(
        taken('other', 'ship')
      );
    });

    it('should refuse a subcommandLoaded replacement that brings the alias', async () => {
      const schema = {
        commands: { ship: { run }, other: { load: () => Promise.resolve({ default: { run } }) } },
        hooks: {
          subcommandLoaded: ({ cmd }: { cmd: { name: string } }) =>
            cmd.name === 'other' ? { alias: 'ship', run } : undefined,
        },
      };
      expect((await parse({ argv: ['ship'], schema })).cmd?.name).to.equal('ship');
      await expect(parse({ argv: ['other'], schema })).rejects.toThrow(taken('other', 'ship'));
    });

    it('should refuse a command a hook adds to a registry', async () => {
      // `commands.add()` is the registry's own door, and it is the one a hook
      // is handed, so it asks the same question
      const schema = {
        commands: {
          db: {
            commands: { ship: { run } },
            hooks: {
              parse: async ({ commands }: { commands: CommandRegistry }) => {
                commands.add(await initCommand({ alias: 'ship', name: 'other', run }));
              },
            },
          },
        },
      };
      await expect(parse({ argv: ['db'], schema })).rejects.toThrow(taken('other', 'ship'));
    });

    it('should not refuse a command whose alias is its own name', async () => {
      const result = await parse({
        argv: ['ship'],
        schema: { commands: { 'ship, ship': { alias: 'ship', run } } },
      });
      expect(result.cmd?.name).to.equal('ship');
    });

    it('should still give two siblings sharing an alias to the later one', async () => {
      // losing an alias leaves both commands reachable by name, which is why
      // the later-wins rule is kept there
      const commands = { ship: { alias: 'go', run }, other: { alias: 'go', run } };
      expect((await parse({ argv: ['go'], schema: { commands } })).cmd?.name).to.equal('other');
      expect((await parse({ argv: ['ship'], schema: { commands } })).cmd?.name).to.equal('ship');
    });

    it("should not refuse a renamed module for the placeholder's own name", async () => {
      // the placeholder's slot is the loaded command's own rather than a
      // sibling's, so a module that renames itself and keeps the placeholder's
      // name as an alias is the same command answering to both
      const result = await parse({
        argv: ['ship'],
        schema: {
          commands: {
            other: { run },
            ship: {
              load: () => Promise.resolve({ default: { alias: 'ship', name: 'boat', run } }),
            },
          },
        },
      });
      expect(result.cmd?.name).to.equal('boat');
    });

    it("should not refuse it through a topic walk, whose write-back is the placeholder's", async () => {
      // the walk used to write the loaded command back with `add()`, which asks
      // with the module's own name as the slot, so `ship` read as a sibling's
      // and this was refused. It is `replace()` now, which places rather than
      // registers, and `loadCommand()` has already asked with the right slot
      const result = await parse({
        argv: ['db:ship:up'],
        schema: {
          commands: {
            db: {
              commands: {
                other: { run },
                ship: {
                  commands: { up: { run } },
                  load: () => Promise.resolve({ default: { alias: 'ship', name: 'boat' } }),
                },
              },
            },
          },
          topicSeparator: ':' as const,
        },
      });
      expect(result.cmd?.name).to.equal('up');
      expect(result.contexts.map((cmd) => cmd.name)).to.include('boat');
    });
  });

  describe('help listed an alias beside a command it did not run', () => {
    // two siblings may share an alias and the later declaration wins it, so
    // `{ 'build, go': {}, 'ship, go': {} }` routes `go` to `ship` -- and help
    // read the label off the name string alone and printed `go` beside both.
    // A listing now asks the registry who each name runs, when it is drawn, so
    // the command that lost a spelling stops listing it
    const run = (): void => {};
    const fixtures = path.join(__dirname, 'fixtures/alias-shared-label');
    const bare = { completion: false, help: false, name: 'mycli', quiet: false } as const;

    /** The labels help's `Commands:` list prints for a context chain. */
    const helpLabels = (contexts: InternalCommand[]): string[] => {
      const lines = renderHelp({ contexts }, { width: 80 }).split('\n');
      const start = lines.indexOf('Commands:') + 1;
      const end = lines.indexOf('', start);
      return lines.slice(start, end === -1 ? undefined : end).map((line) => line.trim());
    };

    /** The names the completion menu lists for each of the root's children. */
    const menuLabels = async (contexts: InternalCommand[]): Promise<string[]> => {
      const spec = await completionSpec({ contexts, schema: { name: 'mycli' } });
      return spec.commands[0]!.subcommands.map((sub) => sub.listed.join(', '));
    };

    /** The same, as the markdown reference lists them. */
    const referenceLabels = async (schema: Schema): Promise<string[]> => {
      // the root is the first entry, and lists nothing
      const surface = await commandSurface(schema);
      return surface.commands.slice(1).map((cmd) => cmd.listed.join(', '));
    };

    /** Help, the completion menu and the reference, which must all agree. */
    const listings = async (schema: Schema): Promise<string[][]> => {
      const { contexts } = await parse({ schema: { ...bare, ...schema } });
      return [helpLabels(contexts), await menuLabels(contexts), await referenceLabels(schema)];
    };

    it('should leave a name-string alias a later sibling won out of the label', async () => {
      const commands = { 'build, go': { run }, 'ship, go': { run } };
      expect(await listings({ commands, name: 'mycli' })).to.deep.equal([
        ['build', 'ship, go'],
        ['build', 'ship, go'],
        ['build', 'ship, go'],
      ]);
      expect((await parse({ argv: ['go'], schema: { commands } })).cmd?.name).to.equal('ship');
      expect((await parse({ argv: ['build'], schema: { commands } })).cmd?.name).to.equal('build');
    });

    it('should leave it out when the later sibling won it with an alias property', async () => {
      const commands = { 'build, go': { run }, ship: { alias: 'go', run } };
      expect(await listings({ commands, name: 'mycli' })).to.deep.equal([
        ['build', 'ship'],
        ['build', 'ship'],
        ['build', 'ship'],
      ]);
      expect((await parse({ argv: ['go'], schema: { commands } })).cmd?.name).to.equal('ship');
    });

    it('should keep it on the later sibling that won it from an alias property', async () => {
      // the other order of the same mix was already true: the loser's alias
      // was a property, which no listing prints
      const commands = { build: { alias: 'go', run }, 'ship, go': { run } };
      expect(await listings({ commands, name: 'mycli' })).to.deep.equal([
        ['build', 'ship, go'],
        ['build', 'ship, go'],
        ['build', 'ship, go'],
      ]);
    });

    it('should leave it out in an array of declarations', async () => {
      const commands = [
        { name: 'build, go', run },
        { name: 'ship, go', run },
      ];
      expect(await listings({ commands, name: 'mycli' })).to.deep.equal([
        ['build', 'ship, go'],
        ['build', 'ship, go'],
        ['build', 'ship, go'],
      ]);
    });

    it('should leave it out beside a nested command, at the level it is declared', async () => {
      const schema = {
        ...bare,
        commands: { db: { commands: { 'migrate, go': { run }, 'seed, go': { run } } } },
      };
      const { contexts } = await parse({ argv: ['db'], schema });
      expect(helpLabels(contexts)).to.deep.equal(['migrate', 'seed, go']);
    });

    it('should leave it out of two walked routes, by what the registry says once each loads', async () => {
      // each module publishes `go` in its own name string, so nothing knows
      // about it until that module loads, and `ship.js` is the later route
      const schema = { ...bare, commands: fixtures };

      // `build` loaded alone owns `go`, and says so
      let { contexts } = await parse({ argv: ['build'], schema });
      let root = contexts.at(-1)!;
      expect(root[Internal].commands.find('go')?.name).to.equal('build');
      expect(helpLabels([root])).to.deep.equal(['build, go', 'ship']);

      // ...until `ship` loads in the same tree and takes it, being later
      const ship = root[Internal].commands.find('ship')!;
      root[Internal].commands.replace(ship, await loadCommand(ship, root));
      expect(root[Internal].commands.find('go')?.name).to.equal('ship');
      expect(helpLabels([root])).to.deep.equal(['build', 'ship, go']);
      expect(await menuLabels([root])).to.deep.equal(['build', 'ship, go']);

      // and loaded the other way round, `build` never takes it back
      ({ contexts } = await parse({ argv: ['ship'], schema }));
      root = contexts.at(-1)!;
      const build = root[Internal].commands.find('build')!;
      root[Internal].commands.replace(build, await loadCommand(build, root));
      expect(root[Internal].commands.find('go')?.name).to.equal('ship');
      expect(helpLabels([root])).to.deep.equal(['build', 'ship, go']);
    });

    it("should follow a lazily loaded module's own name string once it loads", async () => {
      const load = (): Promise<unknown> => Promise.resolve({ default: { name: 'ship, go', run } });
      const schema = { ...bare, commands: { 'build, go': { run }, ship: { load } } };

      // nothing has read `ship`'s module, so `go` is still `build`'s
      const before = await parse({ schema });
      expect(helpLabels(before.contexts)).to.deep.equal(['build, go', 'ship']);

      // and once it has, `ship` is the later declaration and owns it
      const after = await parse({ argv: ['ship'], schema });
      const root = after.contexts.at(-1)!;
      expect(root[Internal].commands.find('go')?.name).to.equal('ship');
      expect(helpLabels([root])).to.deep.equal(['build', 'ship, go']);
      expect(await menuLabels([root])).to.deep.equal(['build', 'ship, go']);
    });

    it('should leave it off a lazily loaded module that lost it to a later sibling', async () => {
      // the module is declared first, so loading it claims nothing from `ship`
      const load = (): Promise<unknown> => Promise.resolve({ default: { name: 'build, go', run } });
      const schema = { ...bare, commands: { build: { load }, 'ship, go': { run } } };
      const { contexts } = await parse({ argv: ['build'], schema });
      const root = contexts.at(-1)!;
      expect(root[Internal].commands.find('go')?.name).to.equal('ship');
      expect(helpLabels([root])).to.deep.equal(['build', 'ship, go']);
      expect(renderHelp({ contexts }, { width: 80 })).not.toContain('Alias');
    });

    it('should follow a subcommandLoaded replacement that brings the name string', async () => {
      const schema = {
        ...bare,
        commands: {
          'build, go': { run },
          ship: { load: () => Promise.resolve({ default: { run } }) },
        },
        hooks: {
          subcommandLoaded: ({ cmd }: { cmd: { name: string } }) =>
            cmd.name === 'ship' ? { name: 'ship, go', run } : undefined,
        },
      };
      const { contexts } = await parse({ argv: ['ship'], schema });
      const root = contexts.at(-1)!;
      expect(root[Internal].commands.find('go')?.name).to.equal('ship');
      expect(helpLabels([root])).to.deep.equal(['build', 'ship, go']);
    });

    it('should leave it out when a hook adds the later sibling', async () => {
      const schema = {
        ...bare,
        commands: {
          db: {
            commands: { 'build, go': { run } },
            hooks: {
              parse: async ({ commands }: { commands: CommandRegistry }) => {
                commands.add(await initCommand({ name: 'ship, go', run }));
              },
            },
          },
        },
      };
      const { contexts } = await parse({ argv: ['db'], schema });
      expect(helpLabels(contexts)).to.deep.equal(['build', 'ship, go']);
    });

    it('should leave two alias properties sharing a spelling as they were', async () => {
      // neither is printed, and the later one still runs
      const commands = { build: { alias: 'go', run }, ship: { alias: 'go', run } };
      expect(await listings({ commands, name: 'mycli' })).to.deep.equal([
        ['build', 'ship'],
        ['build', 'ship'],
        ['build', 'ship'],
      ]);
      expect((await parse({ argv: ['go'], schema: { commands } })).cmd?.name).to.equal('ship');
    });
  });

  describe("a loaded command moved to the end of its parent's registry", () => {
    // the module *is* the placeholder's declaration, so a loaded command sits
    // where the placeholder was declared: a spelling it shares with a sibling
    // goes to whichever of the two was declared later, which is SIG-230's rule
    // with "later" meaning the source. Every collision here is between two
    // *aliases*, never an alias and a name
    const run = (): void => {};
    const quiet = { completion: false, help: false, quiet: false } as const;

    // `[target]` is where a refused `:` path lands, and a refused path is the
    // one that loads a command and then goes on to match at the same level --
    // which is the only way a later token in the same parse sees what the walk
    // wrote back. Every command takes one, since the token stays argv's
    const args = ['[target]'];
    const topic = { ...quiet, args, topicSeparator: ':' as const };
    const db = (mod: Record<string, unknown>) => ({
      load: () => Promise.resolve({ default: { args, commands: { migrate: { run } }, ...mod } }),
    });

    describe('through a : topic walk', () => {
      it('should leave a sibling declared later the alias the module shares with it', async () => {
        const schema = {
          ...topic,
          commands: { db: db({ alias: 'x' }), other: { alias: 'x', args, run } },
        };

        const result = await parse({ argv: ['db:bogus', 'x'], schema });
        expect(result.argv.target).to.equal('db:bogus');
        expect(result.cmd?.name).to.equal('other');
      });

      it('should leave a sibling declared later the alias the placeholder lost to it', async () => {
        // the placeholder's own spellings were settled when the schema was
        // built, and loading it is not a reason to settle them again
        const schema = {
          ...topic,
          commands: { db: { alias: 'x', ...db({}) }, other: { alias: 'x', args, run } },
        };

        const result = await parse({ argv: ['db:bogus', 'x'], schema });
        expect(result.cmd?.name).to.equal('other');
      });

      it('should give the module an alias it shares with a sibling declared earlier', async () => {
        // the other half of declaration order, so that a fix which simply
        // never registered a module's aliases does not pass the two above
        const schema = {
          ...topic,
          commands: { other: { alias: 'x', args, run }, db: db({ alias: 'x' }) },
        };

        const result = await parse({ argv: ['db:bogus', 'x'], schema });
        expect(result.cmd?.name).to.equal('db');
        expect(result.cmd?.[Internal].loaded).to.equal(true);
      });

      it('should do the same for a command a subcommandLoaded hook replaced', async () => {
        const result = await parse({
          argv: ['db:bogus', 'x'],
          schema: {
            ...topic,
            commands: { db: db({}), other: { alias: 'x', args, run } },
            hooks: {
              subcommandLoaded: () => ({ alias: 'x', args, commands: { migrate: { run } } }),
            },
          },
        });
        expect(result.cmd?.name).to.equal('other');
      });

      it('should keep declaration order when the module renames the command', async () => {
        const schema = {
          ...topic,
          commands: { db: db({ name: 'database' }), other: { run } },
        };

        const result = await parse({ argv: ['db:bogus'], schema });
        const registry = result.contexts[0][Internal].commands;
        expect([...registry.keys()]).to.deep.equal(['database', 'other']);
        // the spelling the placeholder was reached by still reaches it
        expect(registry.find('db')?.name).to.equal('database');
        expect(registry.find('db')?.[Internal].loaded).to.equal(true);
      });
    });

    describe('through an ordinary match', () => {
      // there was never a write-back here, so the registry kept the
      // placeholder marked loaded and never learned the module's aliases --
      // a different registry from the one the `:` walk left for the same
      // load. Both go through `CommandRegistry.replace()` now
      it('should leave the registry holding the loaded command, in its place', async () => {
        const schema = {
          ...quiet,
          commands: { first: { run }, db: db({ alias: 'x' }), other: { alias: 'x', run } },
        };

        const result = await parse({ argv: ['db', 'migrate'], schema });
        const registry = result.contexts.at(-1)![Internal].commands;
        expect([...registry.keys()]).to.deep.equal(['first', 'db', 'other']);
        expect(registry.get('db')).to.equal(result.contexts[1]);
        expect(registry.find('x')?.name).to.equal('other');
      });

      it('should give the module an alias it shares with a sibling declared earlier', async () => {
        const schema = {
          ...quiet,
          commands: { other: { alias: 'x', run }, db: db({ alias: 'x' }) },
        };

        const result = await parse({ argv: ['db', 'migrate'], schema });
        const registry = result.contexts.at(-1)![Internal].commands;
        expect(registry.find('x')).to.equal(result.contexts[1]);
      });

      it('should keep declaration order when the module renames the command', async () => {
        const schema = { ...quiet, commands: { db: db({ name: 'database' }), other: { run } } };

        const result = await parse({ argv: ['db', 'migrate'], schema });
        const registry = result.contexts.at(-1)![Internal].commands;
        expect([...registry.keys()]).to.deep.equal(['database', 'other']);
        expect(registry.find('db')).to.equal(result.contexts[1]);
      });

      it('should leave alone a command a hook registered under that name during the load', async () => {
        // the load is the parent's to announce, and a hook that registers a
        // `db` of its own has said what `db` is -- there is no placeholder left
        // in the registry for the loaded command to take the place of
        const own = await initCommand({ desc: 'the hook', name: 'db', run });
        const schema = {
          ...quiet,
          commands: { db: db({}), other: { run } },
          hooks: {
            subcommandLoaded: ({ parent }: { parent: InternalCommand }) => {
              parent[Internal].commands.add(own);
            },
          },
        };

        const result = await parse({ argv: ['db', 'migrate'], schema });
        expect(result.contexts.at(-1)![Internal].commands.get('db')).to.equal(own);
      });

      it('should do the same for a default command', async () => {
        const schema = {
          ...quiet,
          commands: { other: { alias: 'x', run }, db: { default: true, ...db({ alias: 'x' }) } },
        };

        const result = await parse({ argv: [], schema });
        const registry = result.contexts.at(-1)![Internal].commands;
        expect(result.cmd?.name).to.equal('db');
        expect(registry.find('x')).to.equal(result.cmd);
        expect(registry.default).to.equal(result.cmd);
      });

      it('should do the same for a command the help command loaded', async () => {
        const schema = {
          commands: { first: { run }, db: db({ alias: 'x' }), other: { alias: 'x', run } },
        };

        const result = await parse({ argv: ['help', 'db'], schema });
        const registry = result.contexts.at(-1)![Internal].commands;
        expect(registry.get('db')?.[Internal].loaded).to.equal(true);
        expect(registry.get('db')).to.equal(result.help?.contexts[0]);
        expect([...registry.keys()].slice(0, 3)).to.deep.equal(['first', 'db', 'other']);
        expect(registry.find('x')?.name).to.equal('other');
      });
    });
  });
});
