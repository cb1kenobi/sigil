import { initArg } from '../../src/parser/argument/init-arg.js';
import { initCommand } from '../../src/parser/command/init-command.js';
import { initOption } from '../../src/parser/option/init-option.js';
import { OptionRegistry } from '../../src/parser/option/option-registry.js';
import { parse } from '../../src/parser/parse.js';
import { runCommand } from '../../src/testing/command.js';
import type { Schema } from '../../src/types.js';
import { tempDir } from '../temp.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SIG-650: SIG-412 escaped every argv and environment value an error quotes, and
 * left the errors raised while a schema is *built* out. They quote the
 * declaration as it was written, so a control or format character in a
 * declared alias, format, name, type or path reached the terminal raw -- and a
 * schema is not always the app's own source: `sigil build`, `sigil reference` and
 * `sigil check` print what a loaded schema throws, a routed directory's names
 * are the file system's, and so are the paths in a load error.
 *
 * Each kind of site is thrown once per hostile value, and each is held to two
 * things: the message holds the escape, and holds no character that is
 * one. The two values are the two classes `escapeControls()` handles
 * differently -- a control character becomes `\xNN` and a format character
 * `\u{NNNN}` -- so a site that escaped only one of them is caught.
 */

// written as code points, never as the characters: the source check refuses
// both classes in a committed file
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCodePoint(0x202e);
const LS = String.fromCodePoint(0x2028);

/** What a message must not hold: `escapeControls()`'s classes, less the ones no test value reaches. */
const RAW = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const HOSTILE = [
  { escaped: '\\x1B]0;PWNED\\x07', kind: 'a control character', raw: `${ESC}]0;PWNED${BEL}` },
  { escaped: '\\u{202E}', kind: 'a format character', raw: RLO },
] as const;

/**
 * The message of what a call throws, or of the rejection of what it returns.
 *
 * @param fn - The call.
 * @returns The message, which fails the test when nothing was thrown.
 */
async function messageOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw and nothing was thrown');
}

interface Site {
  /** The error's own words around what it quotes, which has to survive. */
  frame: (escaped: string) => string | string[];
  /** Throws, given the hostile value. */
  throws: (raw: string) => unknown;
}

const sites: Record<string, Site> = {
  'an option format that is not a long name': {
    frame: (e) => `Invalid option format: --a${e}`,
    throws: (raw) => initOption({ format: `--a${raw}` }),
  },
  'an option format that is not a name, a hint or a flag': {
    frame: (e) => `Invalid option format: a${e}`,
    throws: (raw) => initOption({ format: `a${raw}` }),
  },
  'an option alias': {
    frame: (e) => `Invalid option alias "--al${e}"`,
    throws: (raw) => initOption({ alias: [`--al${raw}`], format: '--x' }),
  },
  'an option data type': {
    frame: (e) => `Option "x" has unsupported data type "t${e}"`,
    throws: (raw) => initOption({ format: '--x <v>', type: `t${raw}` as never }),
  },
  'an option name in a data type refusal': {
    frame: (e) => `Option "x${e}" has unsupported data type "t"`,
    throws: (raw) => initOption({ name: `x${raw}`, type: 't' as never }),
  },
  'an option name in a group refusal': {
    frame: (e) => `option "x${e}" group`,
    throws: (raw) => initOption({ group: 'Global', name: `x${raw}` }),
  },
  'two options claiming one spelling': {
    frame: (e) => `Options "--a <v${e}> -z" and "--b <v${e}> -z" both declare -z`,
    throws: async (raw) => {
      const options = new OptionRegistry();
      await options.add({ format: `--a <v${raw}> -z` });
      await options.add({ format: `--b <v${raw}> -z` });
    },
  },
  'an argument name': {
    // quoted through `JSON.stringify()`, which writes a control character as
    // `\\u001b` itself and leaves the format characters to `escapeControls()`
    frame: (e) => `Invalid argument name: "a${e.startsWith('\\x') ? '\\u001b]0;PWNED\\u0007' : e}"`,
    throws: (raw) => initArg(`a${raw}`),
  },
  'an argument data type': {
    frame: (e) => `Argument "a" has unsupported data type "t${e}"`,
    throws: (raw) => initArg({ name: 'a', type: `t${raw}` as never }),
  },
  'a variadic argument that is not last': {
    frame: (e) => `is followed by [b] in the "x${e}" command`,
    throws: (raw) => initCommand({ args: [{ name: '[a...]' }, { name: '[b]' }], name: `x${raw}` }),
  },
  'a command name beside a run that is not a function': {
    frame: (e) => `Invalid run function in "x${e}" command`,
    throws: (raw) => initCommand({ name: `x${raw}`, run: 'no' as never }),
  },
  'a command name beside a path and a run': {
    frame: (e) => `in the "x${e}" command:`,
    throws: (raw) => initCommand({ name: `x${raw}`, path: './p.js', run() {} }),
  },
  'a command name beside a load that is not a function': {
    frame: (e) => `Invalid load function in "x${e}" command`,
    throws: (raw) => initCommand({ load: 'no' as never, name: `x${raw}` }),
  },
  'a command name beside a hidden that is not a boolean': {
    frame: (e) => `Expected hidden to be a boolean in "x${e}" command`,
    throws: (raw) => initCommand({ hidden: 'yes' as never, name: `x${raw}` }),
  },
  'a command name beside a default that is not a boolean': {
    frame: (e) => `Expected default in "x${e}" command to be a boolean`,
    throws: (raw) => initCommand({ default: 'yes' as never, name: `x${raw}` }),
  },
  'a command name string that names nothing': {
    frame: (e) => `Unable to determine command name from "[${e}]"`,
    throws: (raw) => initCommand({ name: `[${raw}]` }),
  },
  'a command alias in name-string syntax': {
    frame: (e) => `Invalid alias "@a${e}" in the "x" command`,
    throws: (raw) => initCommand({ alias: [`@a${raw}`], name: 'x' }),
  },
  'the fix a command alias is offered': {
    frame: (e) => `so write "a${e}"`,
    throws: (raw) => initCommand({ alias: [`@a${raw}`], name: 'x' }),
  },
  'a command name beside inline arguments': {
    frame: (e) => `with inline arguments "x${e} <a>"`,
    throws: (raw) => initCommand({ args: ['b'], name: `x${raw} <a>` }),
  },
  'a command description that is not a string': {
    frame: (e) => `Expected desc for the "x${e}" command`,
    throws: (raw) => initCommand({ desc: 5 as never, name: `x${raw}` }),
  },
  'a symbol given as an argument definition': {
    frame: (e) => `Invalid argument definition: Symbol(a${e})`,
    throws: (raw) => initArg(Symbol(`a${raw}`) as never),
  },
  'a command name beside a locked property': {
    frame: (e) => `Cannot set "args" on the initialized "x${e}" command`,
    throws: async (raw) => {
      const cmd = await initCommand({ name: `x${raw}`, run() {} });
      (cmd as { args: unknown }).args = [];
    },
  },
  'a hint that is variadic': {
    frame: (e) => `Option "x${e}" hint cannot be variadic`,
    throws: (raw) => initOption({ hint: 'v...', name: `x${raw}` }),
  },
  'a counter that collects': {
    frame: (e) => `Option "x${e}" cannot be a counter and collect`,
    throws: (raw) => initOption({ multiple: true, name: `x${raw}`, type: 'count' }),
  },
  'an alias that is the name of a built-in command': {
    frame: (e) => `The "x${e}" command's alias "help" is the name of the built-in "help" command`,
    throws: (raw) =>
      parse({
        argv: [`x${raw}`],
        schema: {
          commands: {
            [`x${raw}`]: { load: () => Promise.resolve({ default: { alias: 'help', run() {} } }) },
          },
        },
      }),
  },
  'a module that renames its command onto a built-in': {
    frame: (e) =>
      `The "x${e}" command's module renames it "help", which is the name of the built-in`,
    throws: (raw) =>
      parse({
        argv: [`x${raw}`],
        schema: {
          commands: {
            [`x${raw}`]: { load: () => Promise.resolve({ default: { name: 'help', run() {} } }) },
          },
        },
      }),
  },
  'a module that renames its command onto a sibling': {
    frame: (e) => `The "x${e}" command's module renames it "y${e}", which is the name of a sibling`,
    throws: (raw) =>
      parse({
        argv: [`x${raw}`],
        schema: {
          commands: {
            [`x${raw}`]: {
              load: () => Promise.resolve({ default: { name: `y${raw}`, run() {} } }),
            },
            [`y${raw}`]: { run() {} },
          },
        },
      }),
  },
  'a command module that is not an object': {
    frame: (e) => `is not a valid command object: the "x${e}" command's loader`,
    throws: (raw) =>
      parse({
        argv: [`x${raw}`],
        schema: { commands: { [`x${raw}`]: { load: async () => 5 as never } } },
      }),
  },
  'a command loader that rejects': {
    frame: (e) => `Failed to load command module (the "x${e}" command's loader): no chunk`,
    throws: (raw) =>
      parse({
        argv: [`x${raw}`],
        schema: {
          commands: {
            [`x${raw}`]: {
              load: async () => {
                throw new Error('no chunk');
              },
            },
          },
        },
      }),
  },
  'a hook that hands back a command declaring a module': {
    frame: (e) => `The "x${e}" command's subcommandLoaded hook returned a command declaring "path"`,
    throws: (raw) =>
      parse({
        argv: [`x${raw}`, 'b'],
        schema: {
          commands: {
            [`x${raw}`]: {
              commands: { b: { load: async () => ({}) } },
              hooks: { subcommandLoaded: () => ({ path: './p.js' }) },
            },
          },
        },
      }),
  },
  'a format declared as nothing at all': {
    frame: (e) => `Expected format in "x${e}" command to name at least one format`,
    throws: (raw) =>
      parse({
        argv: [],
        schema: { commands: { [`x${raw}`]: { format: [], run() {} } } },
      }),
  },
  'two default siblings': {
    frame: (e) => `"a${e}" and "b" are both default`,
    throws: (raw) =>
      initCommand({
        commands: { [`a${raw}`]: { default: true, run() {} }, b: { default: true, run() {} } },
        name: 'root',
      }),
  },
  'an alias that is a sibling name': {
    frame: (e) => `The "a${e}" command's alias "b${e}" is the name of a sibling command`,
    throws: (raw) =>
      initCommand({
        commands: { [`a${raw}`]: { alias: [`b${raw}`], run() {} }, [`b${raw}`]: { run() {} } },
        name: 'root',
      }),
  },
  'a command module path it cannot use': {
    frame: (e) => ['Unsupported command module "', `p${e}"`],
    throws: (raw) => parse({ argv: [], schema: { commands: `/nowhere/p${raw}` } }),
  },
  'a command module that is not there': {
    frame: (e) => ['Command module not found: ', `p${e}.js`],
    throws: (raw) =>
      parse({ argv: ['x'], schema: { commands: { x: { path: `/nowhere/p${raw}.js` } } } }),
  },
  'a hook that is not a function': {
    frame: (e) => `Expected "h${e}" hook to be a function`,
    throws: (raw) => parse({ argv: [], schema: { hooks: { [`h${raw}`]: 5 } as never } }),
  },
  'a default chain that leads back to itself': {
    frame: (e) => `Default commands form a cycle: "a${e}"`,
    throws: (raw) =>
      parse({
        argv: [],
        schema: {
          commands: {
            [`a${raw}`]: {
              commands: { b: { default: true, load: async () => ({}) } },
              default: true,
              hooks: { subcommandLoaded: ({ parent }) => parent },
            },
          },
        },
      }),
  },
  'a command that declares a format that is not a list': {
    frame: (e) => `Expected format in "x${e}" command to be true`,
    throws: (raw) =>
      parse({
        argv: [],
        schema: { commands: { [`x${raw}`]: { format: 'nope' as never, run() {} } } },
      }),
  },
};

describe('an error raised while a schema is built', () => {
  for (const [site, { frame, throws }] of Object.entries(sites)) {
    describe(`quoting ${site}`, () => {
      for (const { escaped, kind, raw } of HOSTILE) {
        it(`should escape ${kind}`, async () => {
          const message = await messageOf(() => throws(raw));

          for (const part of [frame(escaped)].flat()) {
            expect(message).toContain(part);
          }
          expect(message).not.toMatch(RAW);
        });
      }
    });
  }
});

describe('an error raised on the way to a command', () => {
  for (const { escaped, kind, raw } of HOSTILE) {
    it(`should escape ${kind} in the name of a command that declares a format the app lacks`, async () => {
      const schema: Schema = {
        commands: { [`x${raw}`]: { format: [`f${raw}`], run() {} } },
        name: 'mycli',
      };
      const ran = await runCommand({ argv: [`x${raw}`], schema });

      expect(ran.err).toContain(
        `The "x${escaped}" command declares the "f${escaped}" output format`
      );
      expect(ran.err.trimEnd()).not.toMatch(RAW);
    });

    it(`should escape ${kind} in the name of a command that presents no formats`, async () => {
      const schema: Schema = {
        commands: {
          db: { commands: { [`x${raw}`]: { format: false, run() {} } }, format: true },
        },
        name: 'mycli',
      } as never;
      const ran = await runCommand({ argv: ['db', `x${raw}`, '--json'], schema });

      expect(ran.err).toContain(`The "x${escaped}" command presents no output formats`);
      expect(ran.err.trimEnd()).not.toMatch(RAW);
    });
  }
});

describe('a name `\\s` lets through and a name nothing validates', () => {
  // `\\s` is in the pattern an argument name is read with, so the one place a name
  // that passed it can still hold a format character is its own padding
  it('should escape a line separator padding an argument name, beside its data type', async () => {
    const message = await messageOf(() => initArg({ name: `[a]${LS}`, type: 't' as never }));

    expect(message).toBe('Argument "[a]\\u{2028}" has unsupported data type "t"');
  });

  it('should escape a line separator padding an argument name, beside its description', async () => {
    const message = await messageOf(() => initArg({ desc: 5 as never, name: `[a]${LS}` }));

    expect(message).toContain('Expected desc for the "[a]\\u{2028}" argument');
  });

  // an option declared by `name` alone is never read against `\\w[\\w-]*`, which
  // only a `format` is, so its label can hold anything -- reached through the
  // registry a hook is handed
  for (const { escaped, kind, raw } of HOSTILE) {
    it(`should escape ${kind} in the label of a required option declared by name alone`, async () => {
      const schema: Schema = {
        hooks: {
          init: async ({ options }) => {
            await options.add({ hint: 'v', name: `x${raw}`, required: true });
          },
        },
        name: 'mycli',
        run() {},
      } as never;
      const ran = await runCommand({ argv: [], schema });

      expect(ran.err).toContain(`Missing required options: --x${escaped}`);
      expect(ran.err.trimEnd()).not.toMatch(RAW);
    });
  }
});

// a name with a control character in it cannot be made on Windows, so there is
// nothing for these to read there
describe.skipIf(process.platform === 'win32')('a name the file system chose', () => {
  for (const { escaped, kind, raw } of HOSTILE) {
    it(`should refuse ${kind} in a directory name, and echo it escaped (SIG-662)`, async () => {
      const root = tempDir('sigil-init-errors-');
      const dir = join(root, `d${raw}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'index.js'), 'export default {};');

      const message = await messageOf(() =>
        parse({ argv: [`d${raw}`], schema: { commands: root } })
      );
      expect(message).toContain(`Cannot route the directory "d${escaped}"`);
      expect(message).toContain('contains a control or format character');
      expect(message).not.toMatch(RAW);
    });

    it(`should refuse ${kind} in a file name, and echo it escaped (SIG-662)`, async () => {
      const root = tempDir('sigil-init-errors-');
      writeFileSync(join(root, `f${raw}.js`), 'export default {};');

      const message = await messageOf(() => parse({ argv: ['x'], schema: { commands: root } }));
      expect(message).toContain(`Cannot route the file "f${escaped}.js"`);
      expect(message).not.toMatch(RAW);
    });

    it(`should escape ${kind} in a package whose manifest is not JSON`, async () => {
      const root = tempDir('sigil-init-errors-');
      const dir = join(root, `p${raw}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), '{');

      const message = await messageOf(() =>
        parse({ argv: [`p${raw}`], schema: { commands: root } })
      );
      expect(message).toContain(`p${escaped}`);
      expect(message).toContain('Failed to JSON parse');
      expect(message).not.toMatch(RAW);
    });

    // V8's message quotes the text it failed on, and a manifest in an installed
    // app's commands directory is not the app's own file (SIG-662)
    it(`should escape ${kind} in the text V8 quotes of a manifest that is not JSON`, async () => {
      const root = tempDir('sigil-init-errors-');
      const dir = join(root, 'p');
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), `[${raw}`);

      const message = await messageOf(() => parse({ argv: ['p'], schema: { commands: root } }));
      expect(message).toContain('Failed to JSON parse');
      expect(message).toContain(escaped);
      expect(message).not.toMatch(RAW);
    });

    it(`should escape ${kind} in a package with no entry point`, async () => {
      const root = tempDir('sigil-init-errors-');
      const dir = join(root, `p${raw}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), '{"main":"./nope.js"}');

      const message = await messageOf(() =>
        parse({ argv: [`p${raw}`], schema: { commands: root } })
      );
      expect(message).toContain(`p${escaped}`);
      expect(message).toContain('does not have a valid');
      expect(message).not.toMatch(RAW);
    });

    it(`should escape ${kind} in the path a module's own error repeats, which has no code to tell it by`, async () => {
      const root = tempDir('sigil-init-errors-');
      const dir = join(root, `c${raw}`);
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'bad.mjs'),
        "import { fileURLToPath } from 'node:url';\nthrow new SyntaxError(fileURLToPath(import.meta.url) + ': Expected property name');"
      );

      const message = await messageOf(() => parse({ argv: ['bad'], schema: { commands: dir } }));
      expect(message).toContain(`c${escaped}`);
      expect(message).not.toMatch(RAW);
    });

    it(`should escape ${kind} in the path Node quotes when a module imports what is missing`, async () => {
      const root = tempDir('sigil-init-errors-');
      const dir = join(root, `c${raw}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'bad.mjs'), "import './missing-module.mjs';\nexport default {};");

      const message = await messageOf(() => parse({ argv: ['bad'], schema: { commands: dir } }));
      expect(message).toContain('Failed to load command module');
      expect(message).toContain(`c${escaped}`);
      expect(message).not.toMatch(RAW);
    });
  }
});

// a control or format character is refused as a route name before anything can be
// said about two index modules, so this site is reached by a character the refusal
// does not name and `escapeControls()` does: U+3164 HANGUL FILLER, drawn blank
describe.skipIf(process.platform === 'win32')('a name the refusal lets through', () => {
  it('should escape it in a directory holding two index modules', async () => {
    const root = tempDir('sigil-init-errors-');
    const dir = join(root, `d${String.fromCodePoint(0x3164)}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), 'export default {};');
    writeFileSync(join(dir, 'index.ts'), 'export default {};');

    const message = await messageOf(() =>
      parse({ argv: [`d${String.fromCodePoint(0x3164)}`], schema: { commands: root } })
    );
    expect(message).toContain('d\\u{3164}');
    expect(message).toContain('has more than one index module');
    expect(message).not.toContain(String.fromCodePoint(0x3164));
  });
});

// the one routed name that still reaches `Did you mean`: a blank letter is no
// sequence and no reordering, so the route is kept and the suggestion escapes it
describe.skipIf(process.platform === 'win32')('a suggestion offering a routed name', () => {
  it('should escape what a file name held that the refusal lets through', async () => {
    const root = tempDir('sigil-init-errors-');
    const blank = String.fromCodePoint(0x3164);
    writeFileSync(join(root, `build${blank}.js`), 'export default { run() {} };');

    const message = await messageOf(() => parse({ argv: ['buil'], schema: { commands: root } }));
    expect(message).toContain('Did you mean "build\\u{3164}"?');
    expect(message).not.toContain(blank);
  });
});

describe.skipIf(process.platform === 'win32')("a module's own message", () => {
  it('should keep its SGR and its lines, because only the path is the file system', async () => {
    const root = tempDir('sigil-init-errors-');
    writeFileSync(
      join(root, 'bad.mjs'),
      "const e = new Error('\\u001b[31mred\\u001b[39m\\nsecond line');\ne.code = 'E_APP';\nthrow e;"
    );

    const message = await messageOf(() => parse({ argv: ['bad'], schema: { commands: root } }));
    expect(message).toContain(`${ESC}[31mred${ESC}[39m\nsecond line`);
  });
});

describe('what `sigil reference` and the surface snapshot print of a refused schema', () => {
  it('should not let an alias holding an ESC reach stderr live', async () => {
    const ran = await runCommand({
      argv: [],
      schema: { options: { '--x': { alias: [`--al${ESC}ias`] } }, run() {} },
    });

    expect(ran.err).toBe('Error: Invalid option alias "--al\\x1Bias"\n');
  });
});
