import { parseJsonc } from '../../src/config/jsonc.js';
import { runCommand } from '../../src/testing/command.js';
import type { Schema } from '../../src/types.js';
import { checkValue } from '../../src/util/transform.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * SIG-412: the parser's and the coercions' messages echo argv and environment
 * values, and they echoed them with their control characters intact -- so a
 * value nobody typed (a glob over a hostile file name, a wrapper forwarding a
 * branch name, an environment variable set from a file) wrote escape sequences
 * to stderr through `errorHandler()`. Each echoed value is escaped where the
 * framework throws, and the error handler is left alone, so an app's own styled
 * message keeps its SGR.
 *
 * Every expectation is the whole of stderr, because a sequence the assertion
 * did not look for is exactly what this is about.
 */

const ESC = '\u001b';
const BEL = '\u0007';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * What `main()` wrote to stderr for one run.
 *
 * @param argv - The arguments.
 * @param schema - The schema.
 * @returns Stderr.
 */
async function stderrOf(argv: string[], schema: Schema): Promise<string> {
  const ran = await runCommand({ argv, schema });
  expect(ran.code).toBe(1);
  return ran.err;
}

describe('a value echoed into an error message', () => {
  it('should not put an OSC from a mistyped command onto stderr', async () => {
    const err = await stderrOf([`bu${ESC}]0;PWNED${BEL}ild`], {
      commands: { build: { run() {} } },
      name: 'mycli',
    });

    expect(err).toBe('Error: Unexpected argument "bu\\x1B]0;PWNED\\x07ild"\n');
  });

  it('should not put a clear screen or an OSC 52 from a rejected choice onto stderr', async () => {
    const err = await stderrOf(['--mode', `${ESC}[2J${ESC}]52;c;ZXZpbA==${BEL}x`], {
      name: 'mycli',
      options: { '--mode <m>': { choices: ['a', 'b'] } },
      run() {},
    });

    expect(err).toBe(
      'Error: Invalid value "\\x1B[2J\\x1B]52;c;ZXZpbA==\\x07x" for option --mode\n'
    );
  });

  it('should not put an SGR from a value that is not an integer onto stderr', async () => {
    const err = await stderrOf(['--n', `${ESC}[31m9`], {
      name: 'mycli',
      options: { '--n <n>': { type: 'int' } },
      run() {},
    });

    expect(err).toBe('Error: Invalid integer: \\x1B[31m9\n');
  });

  it('should not let a newline in argv forge a second error line', async () => {
    const err = await stderrOf(['--n', '1\nError: something else'], {
      name: 'mycli',
      options: { '--n <n>': { type: 'int' } },
      run() {},
    });

    expect(err).toBe('Error: Invalid integer: 1\\x0AError: something else\n');
  });

  it('should escape DEL and C1 the way it escapes C0', async () => {
    const err = await stderrOf(['--n', '\u009b2J\u007f'], {
      name: 'mycli',
      options: { '--n <n>': { type: 'number' } },
      run() {},
    });

    expect(err).toBe('Error: Invalid number: \\x9B2J\\x7F\n');
  });

  it('should escape a value from the environment', async () => {
    vi.stubEnv('SIG412_PORT', `${ESC}[31m9`);

    const err = await stderrOf([], {
      name: 'mycli',
      options: { '--port <n>': { env: 'SIG412_PORT', type: 'int' } },
      run() {},
    });

    expect(err).toBe('Error: Invalid integer: \\x1B[31m9\n');
  });

  it.each([
    ['bool', ['--flag=' + ESC + '[2J'], 'Error: Invalid boolean: "\\x1B[2J"\n'],
    ['date', ['--when', ESC + '[2J'], 'Error: Invalid date: "\\x1B[2J"\n'],
    ['count', ['-v=' + ESC + '[2J'], 'Error: Invalid count: \\x1B[2J\n'],
  ])('should escape a value a %s rejects', async (_type, argv, expected) => {
    const err = await stderrOf(argv, {
      name: 'mycli',
      options: {
        '--flag': { type: 'bool' },
        '--when <d>': { type: 'date' },
        '-v': { type: 'count' },
      },
      run() {},
    });

    expect(err).toBe(expected);
  });

  /**
   * The engine's own message quotes the text it failed on, so `json` echoes
   * argv by way of V8 rather than by way of a template.
   */
  it('should escape the text a json option failed to parse', async () => {
    const err = await stderrOf(['--data', `${ESC}[2J`], {
      name: 'mycli',
      options: { '--data <d>': { type: 'json' } },
      run() {},
    });

    // everything but the newline that ends the line
    expect(err.slice(0, -1)).not.toMatch(/\p{Cc}/u);
    expect(err).toContain('\\x1B[2J');
  });

  /**
   * `Unknown option` itself cannot echo one -- it is reached only by a spelling
   * that matched `\w[\w-]*` -- so a dash-led token carrying a control character
   * is an unexpected argument, and is escaped as one, with the pass-through on
   * and with it off.
   */
  it.each([true, false])(
    'should escape a dash-led token that is not an option, allowUnknownOptions %s',
    async (allowUnknownOptions) => {
      const ran = await runCommand({
        argv: [`--verbsoe${ESC}[2J`],
        schema: { name: 'mycli', options: { '--verbose': { type: 'bool' } }, run() {} },
        settings: { allowUnknownOptions },
      });

      expect(ran.err).toBe('Error: Unexpected argument "--verbsoe\\x1B[2J"\n');
    }
  );

  it('should escape the token a suggestion is offered for, and not the suggestion', async () => {
    const err = await stderrOf([`buil${ESC}d`], {
      commands: { build: { run() {} } },
      name: 'mycli',
    });

    expect(err).toBe('Error: Unexpected argument "buil\\x1Bd". Did you mean "build"?\n');
  });

  it('should escape the name help was asked about', async () => {
    const err = await stderrOf(['help', `buil${ESC}d`], {
      commands: { build: { run() {} } },
      name: 'mycli',
    });

    expect(err).toBe('Error: Unknown command "buil\\x1Bd". Did you mean "build"?\n');
  });

  it('should escape extra arguments', async () => {
    const err = await stderrOf(['--', 'a', `b${ESC}[2J`], { name: 'mycli', run() {} });

    expect(err).toBe('Error: Extra arguments are not allowed: a b\\x1B[2J\n');
  });

  it('should escape an output format name', async () => {
    const err = await stderrOf(['list', `--format=${ESC}[2J`], {
      commands: { list: { format: true, run: () => ({}) } } as never,
      name: 'mycli',
    });

    expect(err).toBe('Error: Unknown output format "\\x1B[2J". This command accepts: json\n');
  });

  it('should escape a format name asked of a command that presents none', async () => {
    const err = await stderrOf(['db', 'dashboard', `--format=${ESC}[2J`], {
      commands: {
        db: { commands: { dashboard: { format: false, run: () => undefined } }, format: true },
      },
      name: 'mycli',
    } as never);

    expect(err).toBe(
      'Error: The "dashboard" command presents no output formats, so "\\x1B[2J" cannot be asked for.\n'
    );
  });

  it("should leave an app's own error message as it wrote it", async () => {
    // the line SIG-412 drew: the escaping is at the framework's throw sites and
    // not in the error handler, so a message an app styled keeps its styling
    const err = await stderrOf([], {
      name: 'mycli',
      run() {
        throw new Error(`${ESC}[31mred${ESC}[39m`);
      },
    });

    expect(err).toBe(`Error: ${ESC}[31mred${ESC}[39m\n`);
  });
});

describe('a config value echoed into an error message', () => {
  it('should escape a value from a config file that its type rejects', () => {
    expect(() => checkValue(`${ESC}[2J`, 'int')).toThrow('Invalid integer: \\x1B[2J');
    // a cycle is what JSON cannot write, so the message falls back to the
    // object's string form -- which is the tag, as the object chose to spell it
    const cyclic: Record<PropertyKey, unknown> = { [Symbol.toStringTag]: `${ESC}[2J` };
    cyclic.self = cyclic;
    expect(() => checkValue(cyclic, 'string')).toThrow('Invalid string: [object \\x1B[2J]');
  });

  it('should escape the text of a config file it failed to parse', () => {
    expect(() => parseJsonc(`{ "a": ${ESC}[2J }`, 'config.json')).toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/\p{Cc}/u) })
    );
  });
});
