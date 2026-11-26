/**
 * What a command declares about running it: `readOnly`, `destructive` and
 * `idempotent` (SIG-718). Validated where the schema is built, recorded on the
 * surface as declared, and printed in the JSON Schema document as MCP's tool
 * annotations.
 */

import { main } from '../src/index.js';
import { commandSurface, inputSchemas, type CommandSurface } from '../src/reference/index.js';
import type { Schema } from '../src/types.js';
import { describe, expect, it } from 'vitest';

/** The surface for an app. */
async function surface(schema: Schema): Promise<CommandSurface> {
  return await commandSurface({ name: 'mycli', ...schema });
}

/** One command's surface record, by path. */
async function at(schema: Schema, path: string) {
  const found = (await surface(schema)).commands.find((cmd) => cmd.path.join(' ') === path);
  if (!found) {
    throw new Error(`No "${path}"`);
  }
  return found;
}

describe('command annotations', () => {
  it('should be recorded on the surface exactly as declared', async () => {
    const schema: Schema = {
      commands: {
        status: { idempotent: true, readOnly: true, run() {} },
        wipe: { destructive: true, idempotent: false, run() {} },
        plain: { run() {} },
      },
    };

    expect(await at(schema, 'status')).toMatchObject({ idempotent: true, readOnly: true });
    // `false` is a statement and undeclared is not, so the two stay apart
    const wipe = await at(schema, 'wipe');
    expect(wipe.destructive).toBe(true);
    expect(wipe.idempotent).toBe(false);
    expect(wipe.readOnly).toBeUndefined();

    const plain = await at(schema, 'plain');
    expect([plain.destructive, plain.idempotent, plain.readOnly]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("should take the root's from the schema, which is the root command", async () => {
    expect(await at({ readOnly: true, run() {} }, '')).toMatchObject({ readOnly: true });
  });

  it('should take what a lazily loaded module declares', async () => {
    const schema: Schema = {
      commands: {
        lazy: {
          load: () => Promise.resolve({ default: { destructive: true, run() {} } }),
        },
      },
    };
    expect((await at(schema, 'lazy')).destructive).toBe(true);
  });

  describe('in the JSON Schema document', () => {
    it("should be MCP's tool annotations, with only what was declared", async () => {
      const doc = inputSchemas(
        await surface({
          commands: {
            plain: { run() {} },
            status: { idempotent: true, readOnly: true, run() {} },
            wipe: { destructive: true, readOnly: false, run() {} },
          },
        })
      );
      const byPath = Object.fromEntries(doc.commands.map((cmd) => [cmd.path.join(' '), cmd]));

      expect(byPath.status?.annotations).toEqual({ idempotentHint: true, readOnlyHint: true });
      expect(byPath.wipe?.annotations).toEqual({ destructiveHint: true, readOnlyHint: false });
      // absent rather than `{}` or a set of `false`s: MCP has a default of its
      // own for an absent hint, and a `false` would be a claim nobody made
      expect(byPath.plain && 'annotations' in byPath.plain).toBe(false);
    });
  });

  describe('validation', () => {
    it.each(['readOnly', 'destructive', 'idempotent'])(
      'should refuse a %s that is not a boolean, as hidden is refused',
      async (key) => {
        await expect(surface({ commands: { go: { [key]: 'yes', run() {} } } })).rejects.toThrow(
          `Expected ${key} to be a boolean in "go" command`
        );
      }
    );

    it('should refuse a command that is both read-only and destructive', async () => {
      await expect(
        surface({ commands: { go: { destructive: true, readOnly: true, run() {} } } })
      ).rejects.toThrow('both readOnly and destructive');
    });

    it('should refuse the pair when a placeholder and its module each say one', async () => {
      // the module is merged over the placeholder before it is initialized, so
      // the contradiction is one command's, refused when the module loads
      const schema: Schema = {
        commands: {
          go: {
            load: () => Promise.resolve({ default: { destructive: true, run() {} } }),
            readOnly: true,
          },
        },
      };
      await expect(surface(schema)).rejects.toThrow('both readOnly and destructive');
    });

    it('should refuse it where main() builds the schema, before anything runs', async () => {
      let ran = false;
      await expect(
        main({
          argv: ['go'],
          schema: {
            commands: {
              go: {
                // the type refuses it, so this is the untyped caller the
                // runtime check is for
                readOnly: 1 as unknown as boolean,
                run() {
                  ran = true;
                },
              },
            },
            name: 'mycli',
          },
          settings: { errorHandler: false },
        })
      ).rejects.toThrow('Expected readOnly to be a boolean in "go" command');
      expect(ran).toBe(false);
    });
  });
});
