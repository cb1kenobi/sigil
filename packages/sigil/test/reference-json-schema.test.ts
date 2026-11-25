import {
  commandSurface,
  inputSchema,
  inputSchemas,
  inputSchemasJson,
  JSON_SCHEMA_DIALECT,
  type CommandSurface,
  type JsonSchema,
} from '../src/reference/index.js';
import type { Schema } from '../src/types.js';
import { checkValue, outsideChoices } from '../src/util/transform.js';
import { describe, expect, it } from 'vitest';

/** The surface for an app. */
async function surface(schema: Schema): Promise<CommandSurface> {
  return await commandSurface({ name: 'mycli', ...schema });
}

/** The input schema of the command at a path, given as words. */
async function schemaAt(schema: Schema, path = ''): Promise<JsonSchema> {
  const app = await surface(schema);
  const cmd = app.commands.find((c) => c.path.join(' ') === path);
  if (!cmd) {
    throw new Error(`No "${path}" in ${JSON.stringify(app.commands.map((c) => c.path))}`);
  }
  return inputSchema(app, cmd);
}

/** One property of the root's input schema, for an app with one option. */
async function property(format: string, decl: Record<string, unknown> = {}): Promise<JsonSchema> {
  const schema = await schemaAt({ options: { [format]: decl } });
  const props = Object.values(schema.properties ?? {});
  expect(props).toHaveLength(1);
  return props[0];
}

/**
 * Whether a value satisfies a schema, for exactly the keywords `json-schema.ts`
 * writes. A validator of the test's own rather than a dependency: the package
 * has none, and the subset is small enough to read in one go -- which is also
 * what makes it a check on the keywords rather than on a library's reading of
 * them.
 */
function valid(schema: JsonSchema, value: unknown): boolean {
  if (schema.anyOf) {
    return schema.anyOf.some((it) => valid(it, value));
  }
  if (schema.not && valid(schema.not, value)) {
    return false;
  }
  if ('const' in schema) {
    return Object.is(value, schema.const);
  }
  if (schema.enum && !schema.enum.some((it) => Object.is(it, value))) {
    return false;
  }

  switch (schema.type) {
    case 'array':
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems ?? 0) &&
        value.every((it) => valid(schema.items ?? {}, it))
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        (schema.type === 'number' || Number.isInteger(value)) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case 'string':
      return (
        typeof value === 'string' &&
        (schema.pattern === undefined || new RegExp(schema.pattern, 'u').test(value))
      );
    default:
      return true;
  }
}

/** Values a caller might send, of every JSON kind and every awkward shape. */
const SAMPLES: unknown[] = [
  '',
  ' ',
  'a',
  '007',
  'yes',
  'no',
  'true',
  '8080',
  '2024-06-15',
  '2024-06-15T12:00:00Z',
  '2024-06-15t12:00:00z',
  '2024-06-15T12:00:00+05:30',
  '2024-02-30',
  '2024-01-01T24:00:00',
  '9999-99-99',
  'x\u001by',
  0,
  1,
  -1,
  1.5,
  8080,
  Number.MAX_SAFE_INTEGER,
  2 ** 53,
  1e21,
  1_718_452_800_000,
  true,
  false,
  null,
  [],
  ['a'],
  {},
  { a: 1 },
];

describe('a command as JSON Schema', () => {
  it('should write an object schema in the 2020-12 dialect that refuses what is undeclared', async () => {
    expect(await schemaAt({ options: { '--name <value>': {} } })).toEqual({
      $schema: JSON_SCHEMA_DIALECT,
      additionalProperties: false,
      properties: { name: { type: 'string' } },
      required: ['name'],
      type: 'object',
    });
  });

  it('should write each data type in the typed form checkValue() takes', async () => {
    const safe = { maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER };

    expect(await property('--x [v]', { type: 'string' })).toEqual({ type: 'string' });
    expect(await property('--x [v]', { type: 'int' })).toEqual({ ...safe, type: 'integer' });
    expect(await property('--x [v]', { type: 'number' })).toEqual({ type: 'number' });
    expect(await property('--x [v]', { type: 'bool' })).toEqual({ type: 'boolean' });
    expect(await property('--x [v]', { type: 'yesno' })).toEqual({ type: 'boolean' });
    expect(await property('--x [v]', { type: 'auto' })).toEqual({});
    // a string sent to `json` is read as JSON text, so `"a"` is refused: the
    // caller sends the value itself. Found by the soundness test below
    expect(await property('--x [v]', { type: 'json' })).toEqual({ not: { type: 'string' } });

    const date = await property('--x [v]', { type: 'date' });
    expect(date.type).toBe('string');
    // the parser's own pattern rather than a second spelling of it
    expect(new RegExp(date.pattern ?? '', 'u').test('2024-06-15T12:00:00+05:30')).toBe(true);
    expect(new RegExp(date.pattern ?? '', 'u').test('June 15')).toBe(false);
  });

  it('should name each property after the argv destination', async () => {
    const schema = await schemaAt({
      args: [{ name: 'out-file' }],
      options: { '--log-level [level]': {}, '-v, --verbose': {} },
      run() {},
    });
    expect(Object.keys(schema.properties ?? {})).toEqual(['logLevel', 'verbose', 'outFile']);
  });

  it('should carry a description', async () => {
    expect(await property('--name [v]', { desc: 'Who to greet' })).toEqual({
      description: 'Who to greet',
      type: 'string',
    });
  });

  describe('choices', () => {
    it('should become an enum of the values the parser compares against', async () => {
      expect((await property('--port [p]', { choices: [80, 443], type: 'int' })).enum).toEqual([
        80, 443,
      ]);
      expect((await property('--mode [m]', { choices: ['fast', 'slow'] })).enum).toEqual([
        'fast',
        'slow',
      ]);
    });

    it('should leave out a choice no caller can send and have it arrive as itself', async () => {
      // `'443'` on an int arrives as 443, which is not among the choices, so the
      // parser refuses it and so must the schema. An unsafe integer is refused
      // by checkValue() outright
      expect(
        (await property('--port [p]', { choices: [80, '443', 2 ** 60], type: 'int' })).enum
      ).toEqual([80]);
      // `'7'` on auto is guessed into 7, the same shape on the type that guesses
      expect((await property('--x [v]', { choices: ['7', 'seven'], type: 'auto' })).enum).toEqual([
        'seven',
      ]);
    });

    it('should keep a choice holding a control character as the character', async () => {
      // the surface's `choices` escape it for a reader; a caller sends the
      // value, so the escaped spelling would be a value nothing accepts
      expect((await property('--x [v]', { choices: ['a\u001bb'] })).enum).toEqual(['a\u001bb']);
    });

    it('should say nothing is accepted when no choice can be sent', async () => {
      expect((await property('--port [p]', { choices: ['80'], type: 'int' })).enum).toEqual([]);
    });
  });

  describe('required', () => {
    it('should require an option and an argument written as required', async () => {
      const schema = await schemaAt({
        args: [{ name: '<entry>' }, { name: '[out]' }],
        options: { '--name <value>': {}, '--tag [value]': {} },
        run() {},
      });
      expect(schema.required).toEqual(['name', 'entry']);
    });

    it('should not require what a default fills', async () => {
      const schema = await schemaAt({
        args: [{ default: 'index.js', name: '<entry>' }],
        options: { '--name <value>': { default: 'world' } },
        run() {},
      });
      expect(schema.required).toBeUndefined();
      expect(schema.properties?.name.default).toBe('world');
      expect(schema.properties?.entry.default).toBe('index.js');
    });
  });

  describe('lists', () => {
    it('should make a repeatable option an array', async () => {
      expect(await property('--tag [t]', { multiple: true, type: 'int' })).toMatchObject({
        items: { type: 'integer' },
        type: 'array',
      });
    });

    it('should make a variadic argument an array that has to hold one when required', async () => {
      const schema = await schemaAt({
        args: [{ name: '<files...>' }],
        run() {},
      });
      expect(schema.properties?.files).toEqual({
        items: { type: 'string' },
        minItems: 1,
        type: 'array',
      });

      const optional = await schemaAt({ args: [{ name: '[files...]' }], run() {} });
      expect(optional.properties?.files).toEqual({ items: { type: 'string' }, type: 'array' });
    });

    it('should wrap a single default for a list, as the parser does', async () => {
      expect((await property('--tag [t]', { default: 'a', multiple: true })).default).toEqual([
        'a',
      ]);
    });
  });

  describe('defaults', () => {
    it('should coerce a string default to the declared type', async () => {
      expect((await property('--port [p]', { default: '8080', type: 'int' })).default).toBe(8080);
      expect((await property('--on', { default: 'yes' })).default).toBe(true);
      expect((await property('--data [d]', { default: '{"a":1}', type: 'json' })).default).toEqual({
        a: 1,
      });
    });

    it('should state a date default as written, so the schema does not depend on the time zone', async () => {
      // a date with no offset reads as local midnight, so its instant is a
      // different string on every machine and a committed schema would flap.
      // Measured: `2024-06-15` came out as `2024-06-15T05:00:00.000Z` in Chicago
      expect((await property('--when [d]', { default: '2024-06-15', type: 'date' })).default).toBe(
        '2024-06-15'
      );
      // a `Date` is an instant already, and has one spelling everywhere
      expect(
        (await property('--when [d]', { default: new Date(Date.UTC(2024, 5, 15)), type: 'date' }))
          .default
      ).toBe('2024-06-15T00:00:00.000Z');
    });

    it('should leave out a default it cannot state', async () => {
      expect(await property('--x [v]', { default: () => 'computed' })).toEqual({ type: 'string' });
      expect(await property('--x [v]', { default: Symbol('nope'), type: 'auto' })).toEqual({});
    });
  });

  describe('flags', () => {
    it('should be a boolean that is off when nobody used it', async () => {
      expect(await property('--verbose')).toEqual({ default: false, type: 'boolean' });
    });

    it('should name a negated flag on its own by the positive destination, on by default', async () => {
      // `--no-color` alone is `argv.color`, true unless used
      const schema = await schemaAt({ options: { '--no-color': { desc: 'Plain output' } } });
      expect(schema.properties).toEqual({
        color: { default: true, description: 'Plain output', type: 'boolean' },
      });
    });

    it('should pair a flag with its negated twin as one boolean', async () => {
      const schema = await schemaAt({
        options: { '--color': { desc: 'Colour' }, '--no-color': { desc: 'No colour' } },
      });
      expect(schema.properties).toEqual({
        color: { default: false, description: 'Colour', type: 'boolean' },
      });
    });

    it('should make a counter an integer that starts at zero', async () => {
      expect(await property('-v', { type: 'count' })).toMatchObject({
        default: 0,
        type: 'integer',
      });
    });
  });

  it('should pair a valued option with its negated twin as the value or false', async () => {
    const schema = await schemaAt({
      options: { '--cheese <type>': { desc: 'Which cheese' }, '--no-cheese': {} },
    });
    expect(schema.properties).toEqual({
      cheese: { anyOf: [{ type: 'string' }, { const: false }], description: 'Which cheese' },
    });
    expect(schema.required).toEqual(['cheese']);
  });

  describe('the context chain', () => {
    const app: Schema = {
      args: [{ name: '[root-arg]' }],
      commands: {
        db: {
          commands: {
            migrate: {
              args: [{ name: '<target>' }],
              options: { '--name <value>': { desc: 'nearest' }, '--to [version]': {} },
              run() {},
            },
          },
          options: { '--url [url]': {} },
        },
      },
      options: { '--config [file]': {}, '--name [value]': { desc: 'outer' } },
    };

    it("should include every ancestor's options and not their arguments", async () => {
      const schema = await schemaAt(app, 'db migrate');
      expect(Object.keys(schema.properties ?? {})).toEqual([
        'config',
        'name',
        'url',
        'to',
        'target',
      ]);
      expect(schema.properties?.rootArg).toBeUndefined();
    });

    it('should let the nearest declaration of a destination win', async () => {
      const schema = await schemaAt(app, 'db migrate');
      expect(schema.properties?.name.description).toBe('nearest');
      expect(schema.required).toEqual(['name', 'target']);
    });
  });

  it('should leave out a hidden option unless asked', async () => {
    const app = await surface({ options: { '--secret [s]': { hidden: true }, '--shown [s]': {} } });
    expect(Object.keys(inputSchema(app, app.commands[0]).properties ?? {})).toEqual(['shown']);
    expect(
      Object.keys(inputSchema(app, app.commands[0], { hidden: true }).properties ?? {})
    ).toEqual(['secret', 'shown']);
  });

  it('should leave out the options a format declaration adds', async () => {
    // they pick how a result is presented and never reach argv
    const schema = await schemaAt(
      { commands: { list: { format: true, options: { '--all': {} }, run() {} } } },
      'list'
    );
    expect(Object.keys(schema.properties ?? {})).toEqual(['all']);
  });
});

describe('every runnable command of an app', () => {
  it('should list the runnable commands, without namespaces or hidden ones', async () => {
    const doc = inputSchemas(
      await surface({
        commands: {
          db: { commands: { migrate: { desc: 'Migrate', run() {} } } },
          secret: { hidden: true, run() {} },
          serve: { run() {} },
        },
      })
    );
    expect(doc.program).toBe('mycli');
    expect(doc.commands.map((cmd) => cmd.path.join(' '))).toEqual(['db migrate', 'serve']);
    expect(doc.commands[0].description).toBe('Migrate');
  });

  it('should include a hidden command when asked', async () => {
    const doc = inputSchemas(await surface({ commands: { secret: { hidden: true, run() {} } } }), {
      hidden: true,
    });
    expect(doc.commands.map((cmd) => cmd.path.join(' '))).toEqual(['secret']);
  });

  it('should include the root when the schema itself runs', async () => {
    const doc = inputSchemas(await surface({ args: [{ name: '[who]' }], run() {} }));
    expect(doc.commands.map((cmd) => cmd.path)).toEqual([[]]);
  });

  it('should be JSON', async () => {
    const doc = inputSchemas(
      await surface({ options: { '--port [p]': { default: '80', type: 'int' } }, run() {} })
    );
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

describe('the document as text', () => {
  it('should write nothing a terminal acts on or hides, and parse back to the same values', async () => {
    // JSON.stringify() escapes C0 and nothing else, so DEL, C1, a format
    // character and an astral one reached the terminal raw. Each is written
    // as a \u escape -- two for the astral one -- which is the same string
    const odd = ['a\u007fb', 'a\u0085b', 'a\u202eb', 'a\u{e0001}b', 'a\u001bb'];
    const app = await surface({
      options: { '--x [v]': { choices: odd, desc: 'flag \u2028 here' } },
      run() {},
    });
    const text = inputSchemasJson(app);

    // the document's own line breaks are the one control character it may hold
    expect(text.replaceAll('\n', '')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(text).toContain('\\udb40\\udc01');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(inputSchemas(app));
    expect(JSON.parse(text).commands[0].inputSchema.properties.x.enum).toEqual(odd);
  });
});

describe('soundness', () => {
  // whatever a schema accepts, the parser has to take: checkValue() judges a
  // typed value, and the declaration's `choices` judge what that becomes. The
  // converse is deliberately not promised -- see the module comment
  const TYPES = ['auto', 'bool', 'count', 'date', 'int', 'json', 'number', 'string', 'yesno'];

  /**
   * The values the schema accepts and checkValue() refuses, which is the list
   * of documented gaps and nothing else.
   */
  function refused(schema: JsonSchema, type: string, choices?: unknown[]): unknown[] {
    return SAMPLES.filter((value) => valid(schema, value)).filter((value) => {
      try {
        return outsideChoices(choices, checkValue(value, type)).length > 0;
      } catch {
        return true;
      }
    });
  }

  it.each(TYPES)(
    'should accept nothing a %s option refuses but a day that does not exist',
    async (type) => {
      const schema = await property('--x [v]', { type: type === 'count' ? 'int' : type });
      // the calendar and the clock are checked after the shape, arithmetically,
      // and a pattern cannot say "a day that exists"
      expect(refused(schema, type)).toEqual(
        type === 'date' ? ['2024-02-30', '2024-01-01T24:00:00', '9999-99-99'] : []
      );
    }
  );

  it('should accept no value outside the choices', async () => {
    const choices = [80, '443', 2 ** 60, 8080];
    const schema = await property('--port [p]', { choices, type: 'int' });
    expect(refused(schema, 'int', choices)).toEqual([]);
    expect(SAMPLES.filter((value) => valid(schema, value))).toEqual([8080]);
  });

  it('should accept no list a repeatable option refuses', async () => {
    const schema = await property('--tag [t]', { multiple: true, type: 'int' });
    for (const value of [[], [1, 2], [1.5], ['a'], [2 ** 53]]) {
      if (valid(schema, value)) {
        expect(() => (value as unknown[]).map((it) => checkValue(it, 'int'))).not.toThrow();
      }
    }
    expect(valid(schema, [1.5])).toBe(false);
    expect(valid(schema, [2 ** 53])).toBe(false);
  });
});
