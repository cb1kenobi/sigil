import { completionScript } from '../src/completion/index.js';
import { programOf } from '../src/completion/spec.js';
import { parse } from '../src/parser/parse.js';
import type { Schema } from '../src/types.js';
import { descriptionLine } from '../src/util/description-line.js';
import { describe, expect, it } from 'vitest';

/**
 * A completion script written with a format character from a program name or a
 * description left in it (SIG-610).
 *
 * `oneLine()` stripped `\p{Cc}` and nothing else, so U+202E -- the right-to-left
 * override, which makes a terminal draw the rest of the line reversed -- went
 * into the header comments, `complete -F` and `#compdef` from a name, and into
 * every menu entry from a description. `app completion bash` then printed
 * reversed lines. The name has no whitespace, so `registerable()` accepted it.
 *
 * Every character is built with `String.fromCodePoint` and never written as a
 * byte, for the reason `sources.test.ts` exists.
 */

/** U+202E, the right-to-left override. */
const BIDI = String.fromCodePoint(0x202e);
/** U+200B, which is not drawn at all. */
const ZWSP = String.fromCodePoint(0x200b);
/** U+2028, which JavaScript and some terminals read as a line break. */
const LS = String.fromCodePoint(0x2028);

/** What a script may not hold, named the way the source check names it. */
const FORMAT = /[\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The whole class `escapeControls()` names, minus the controls a script is made
 * of: wide enough to catch a variation selector and a blank braille pattern,
 * which `FORMAT` does not, so a narrower hand-written pattern in `typeable()`
 * would fail.
 */
const UNSAFE = /[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u;
/** U+FE0F, the emoji variation selector: default-ignorable, and not `Cf`. */
const VS16 = String.fromCodePoint(0xfe0f);
/** U+2800, the blank braille pattern. */
const BRAILLE = String.fromCodePoint(0x2800);

const SHELLS = ['bash', 'zsh'] as const;

async function script(schema: Schema, shell: (typeof SHELLS)[number]): Promise<string> {
  return await completionScript(await parse({ argv: [], env: {}, schema }), shell);
}

describe('a format character in a completion script', () => {
  it.each(SHELLS)('should not reach the %s script from a program name', async (shell) => {
    const out = await script(
      { commands: { go: { desc: 'go', run(): void {} } }, name: `my${BIDI}${ZWSP}cli` },
      shell
    );

    expect(out).not.toMatch(FORMAT);
    // and it registers for the name it reduces to, in each place it appears
    expect(out).toContain('mycli');
    expect(out).toMatch(
      shell === 'bash' ? /complete -o default -F \S+ 'mycli'/u : /^#compdef mycli$/mu
    );
  });

  it.each(SHELLS)('should not reach the %s script from a description', async (shell) => {
    const out = await script(
      {
        commands: {
          go: {
            desc: `deploy${BIDI} it${LS}now`,
            options: { '--force': `force${BIDI}${ZWSP} it` },
            run(): void {},
          },
        },
        name: 'mycli',
      },
      shell
    );

    expect(out).not.toMatch(FORMAT);
  });

  it('should carry the description into the zsh menu without it', async () => {
    // bash shows no description at all, so the line above is vacuous for it and
    // this is the half that has a menu to put one in
    const out = await script(
      { commands: { go: { desc: `deploy${BIDI} it${LS}now`, run(): void {} } }, name: 'mycli' },
      'zsh'
    );

    expect(out).toContain("'go:deploy it now'");
  });

  it('should keep a program name the same one everywhere it is derived from', () => {
    // the installer's path and marker come from `programOf()` too, so the
    // printed header and the installed file cannot disagree about the name
    expect(programOf(`my${BIDI}cli`)).toBe('mycli');
    expect(programOf(`${ZWSP}mycli`)).toBe('mycli');
  });

  it('should leave a single space where a format character sat between two', () => {
    expect(descriptionLine(`a ${ZWSP} b`)).toBe('a b');
    expect(descriptionLine(`a${BIDI}b`)).toBe('ab');
  });

  // SIG-632: a name, an alias and a choice are matched by what argv gives, so
  // each is dropped rather than stripped -- a stripped one is a completion that
  // does not reach what it names

  it.each(SHELLS)('should not reach the %s script from a command name', async (shell) => {
    const out = await script(
      {
        commands: {
          // `go` is typeable, so the command is still walked and offered
          [`go${BIDI}x, go`]: { desc: 'reachable', run(): void {} },
          // nothing else answers to it, so it is not in the script at all
          [`only${ZWSP}name`]: { run(): void {} },
        },
        name: 'mycli',
      },
      shell
    );

    expect(out).not.toMatch(FORMAT);
    expect(out).toContain('go');
    // not the stripped spelling either: that is a token no command answers to
    expect(out).not.toContain('gox');
    expect(out).not.toContain('onlyname');
  });

  it.each(SHELLS)('should not reach the %s script from an alias', async (shell) => {
    const out = await script(
      {
        commands: { go: { alias: [`zz${BIDI}q`, 'okay'], run(): void {} } },
        name: 'mycli',
      },
      shell
    );

    expect(out).not.toMatch(FORMAT);
    expect(out).toContain('okay');
    // dropped, not stripped: `zzq` would be a token that reaches nothing
    expect(out).not.toContain('zzq');
  });

  it.each(SHELLS)('should not reach the %s script from a choice', async (shell) => {
    const out = await script(
      {
        commands: {
          go: {
            options: {
              '--mode [m]': { choices: [`qu${BIDI}ick`, `sl${ZWSP}ugg`, 'safe'], desc: 'm' },
            },
            run(): void {},
          },
        },
        name: 'mycli',
      },
      shell
    );

    expect(out).not.toMatch(FORMAT);
    expect(out).toContain('safe');
    expect(out).not.toContain('quick');
    expect(out).not.toContain('slugg');
  });

  it.each(SHELLS)('should drop every unsafe class member from the %s script', async (shell) => {
    // each is default-ignorable or a blank symbol and none is `\p{Cf}`, so a
    // pattern narrower than `escapeControls()`'s lets it through
    const out = await script(
      {
        commands: {
          go: {
            args: ['[where]'],
            options: {
              '--mode [m]': { choices: [`he${VS16}art`, `bl${BRAILLE}ank`, 'plain'], desc: 'm' },
            },
            run(): void {},
          },
        },
        name: 'mycli',
      },
      shell
    );

    expect(out).not.toMatch(UNSAFE);
    expect(out).toContain('plain');
    expect(out).not.toContain('heart');
    expect(out).not.toContain('blank');
  });

  it.each(SHELLS)('should not reach the %s script from a positional choice', async (shell) => {
    const out = await script(
      {
        commands: {
          go: { args: [{ choices: [`pu${BIDI}b`, 'www'], name: 'dir' }], run(): void {} },
        },
        name: 'mycli',
      },
      shell
    );

    expect(out).not.toMatch(FORMAT);
    expect(out).toContain('www');
    expect(out).not.toContain('pub');
  });
});
