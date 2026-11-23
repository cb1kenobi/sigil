import { commandSurface, type SurfaceOption } from '../src/reference/index.js';
import type { Schema } from '../src/types.js';
import { describe, expect, it } from 'vitest';

/**
 * A command surface that held a format character, or said a choice list was no
 * list (SIG-643).
 *
 * `surface.ts` asked `\p{Cc}` of the program's name and nothing of an `env`
 * name or a `hint`, so U+202E -- the right-to-left override -- went into the
 * snapshot raw, and `declaredValues()` dropped every choice a shell could not
 * type, so an option whose whole list was dropped read as taking any value.
 *
 * Every character is built with `String.fromCodePoint` and never written as a
 * byte, for the reason `sources.test.ts` exists.
 */

/** U+202E, the right-to-left override. */
const BIDI = String.fromCodePoint(0x202e);
/** U+200C, the zero-width non-joiner: a letter of Persian, and `\p{Cf}`. */
const ZWNJ = String.fromCodePoint(0x200c);
/** U+FE0F, the emoji variation selector: default-ignorable, and not `Cf`. */
const VS16 = String.fromCodePoint(0xfe0f);

/** What a surface may not hold, which is the class `escapeControls()` names. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u;

/** The surface for an app, with one option on the root. */
async function option(decl: Record<string, unknown>): Promise<SurfaceOption> {
  const it = await commandSurface({
    name: 'mycli',
    options: { '--pick [value]': decl },
  } as Schema);
  const opt = it.commands[0]?.options[0];

  if (!opt) {
    throw new Error('the root has no option');
  }
  return opt;
}

describe('a format character in the command surface', () => {
  it('should refuse a program name holding one', async () => {
    const err = await commandSurface({ name: `my${BIDI}cli` }).then(
      () => new Error('accepted'),
      (it: unknown) => it as Error
    );

    expect(err.message).toMatch(/holds a control or format character/u);
    // and it does not echo what it is refusing
    expect(err.message).not.toMatch(UNSAFE);
    expect(err.message).not.toContain('cli');
  });

  it('should refuse a program name holding a character no property calls a format one', async () => {
    // a variation selector is a mark and the blank braille pattern a symbol, so a
    // narrower `\p{Cf}` pattern accepts both
    for (const name of [`my${VS16}cli`, `my${String.fromCodePoint(0x2800)}cli`]) {
      await expect(commandSurface({ name }), name).rejects.toThrow(/holds a control or format/u);
    }
  });

  it("should escape an option's env name", async () => {
    const opt = await option({ env: [`PICK${BIDI}`, 'PLAIN'] });

    expect(opt.env).toStrictEqual(['PICK\\u{202E}', 'PLAIN']);
  });

  it("should escape an argument's env name", async () => {
    const it = await commandSurface({
      name: 'mycli',
      args: [{ env: `ENTRY${BIDI}`, name: '[entry]' }],
    } as Schema);

    expect(it.commands[0]?.args[0]?.env).toStrictEqual(['ENTRY\\u{202E}']);
  });

  it("should escape an option's hint", async () => {
    expect((await option({ hint: `to${BIDI}ken` })).hint).toBe('to\\u{202E}ken');
  });

  it('should show a choice holding one escaped rather than dropping it', async () => {
    const opt = await option({ choices: [`a${BIDI}b`, 'c'] });

    expect(opt.choices).toStrictEqual(['a\\u{202E}b', 'c']);
  });

  it('should never turn a choice list into no list', async () => {
    // the ticket's own case, which used to need a control character and since
    // SIG-632 needs only ordinary text: a Persian value with a ZWNJ in it and an
    // emoji with its variation selector were both dropped from the list, which
    // came back empty -- and an empty list is how a surface says any value will
    // do, where the parser enforces this one
    const opt = await option({ choices: [`می${ZWNJ}خواهم`, `❤${VS16}`] });

    expect(opt.choices).toStrictEqual(['می\\u{200C}خواهم', '❤\\u{FE0F}']);
  });

  it('should keep an empty choice rather than reading its list as none', async () => {
    expect((await option({ choices: [''] })).choices).toStrictEqual(['']);
  });

  it("should escape a positional argument's choices", async () => {
    const it = await commandSurface({
      name: 'mycli',
      args: [{ choices: [`x${BIDI}`], name: '<mode>' }],
    } as Schema);

    expect(it.commands[0]?.args[0]?.choices).toStrictEqual(['x\\u{202E}']);
  });

  it('should leave a plain choice, hint and env name exactly as declared', async () => {
    const opt = await option({ choices: ['a', 'b'], env: 'PICK', hint: 'letter' });

    expect([opt.choices, opt.env, opt.hint]).toStrictEqual([['a', 'b'], ['PICK'], 'letter']);
  });

  it('should leave no format character in a command name reaching the surface', async () => {
    // a name is a token, so it is filtered by reachability rather than escaped:
    // `tokensFor()` answers for both printers. Without a typeable alias the
    // command is not in the surface, and with one it is walked under the alias
    const only = await commandSurface({
      name: 'mycli',
      commands: { [`go${BIDI}x`]: { run() {} } },
    });
    const aliased = await commandSurface({
      name: 'mycli',
      commands: { [`go${BIDI}x, fine`]: { run() {} } },
    });

    expect(only.commands.map((it) => it.path)).toStrictEqual([[]]);
    expect(aliased.commands.map((it) => it.path)).toStrictEqual([[], ['fine']]);
    expect(JSON.stringify([only, aliased])).not.toMatch(UNSAFE);
  });
});
