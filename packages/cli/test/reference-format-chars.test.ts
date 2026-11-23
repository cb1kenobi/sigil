import { referenceDocument, referencePages } from '../src/reference/markdown.ts';
import { snapshotJson } from '../src/reference/snapshot.ts';
import type { Schema } from '@ttylabs/sigil';
import { commandSurface, type CommandSurface } from '@ttylabs/sigil/reference';
import { describe, expect, it } from 'vitest';

/**
 * The markdown reference and the snapshot, over a format character and over a
 * choice list that was filtered to nothing (SIG-643).
 *
 * `markdown.ts` and `surface.ts` each had a pattern of their own, both
 * `\p{Cc}`, so U+202E -- the right-to-left override -- reached a page in a
 * program name and in an example's text and reached the snapshot in an `env`
 * name; and since SIG-632 an option whose every choice was dropped printed the
 * hint placeholder, so the page said any value is accepted where the parser
 * enforces a list.
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

/** What a committed file may not hold: the class `escapeControls()` names. */
const UNSAFE = /[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u;

/** Everything a reference prints, in the one document the layouts share. */
async function printed(
  schema: Schema
): Promise<{ doc: string; snap: string; surface: CommandSurface }> {
  const surface = await commandSurface({ name: 'mycli', ...schema });
  return { doc: referenceDocument(surface), snap: snapshotJson(surface), surface };
}

describe('a format character in the reference', () => {
  it('should refuse a program name holding one, which is the one name printed unchecked', async () => {
    await expect(commandSurface({ name: `my${BIDI}cli` })).rejects.toThrow(
      /holds a control or format character/u
    );
  });

  it("should show an option's hint escaped, in the usage line of a page and its table", async () => {
    const { doc, snap } = await printed({
      options: { '--pick <value>': { hint: `to${BIDI}ken` } },
    });

    expect(doc).toContain('--pick <to\\u{202E}ken>');
    expect(doc).not.toMatch(UNSAFE);
    expect(snap).not.toMatch(UNSAFE);
  });

  it("should write an option's env name into the snapshot escaped", async () => {
    const { doc, snap } = await printed({
      options: { '--pick [value]': { env: [`PICK${BIDI}`, 'PLAIN'] } },
    });

    expect(JSON.parse(snap).commands[0].options[0].env).toStrictEqual(['PICK\\u{202E}', 'PLAIN']);
    expect(snap).not.toMatch(UNSAFE);
    expect(doc).not.toMatch(UNSAFE);
  });

  it('should show a choice holding one escaped, so a reader can see it', async () => {
    const { doc, snap } = await printed({
      options: { '--pick <value>': { choices: [`a${BIDI}b`, 'c'] } },
    });

    expect(doc).toContain('--pick <a\\u{202E}b\\|c>');
    expect(JSON.parse(snap).commands[0].options[0].choices).toStrictEqual(['a\\u{202E}b', 'c']);
    expect(doc).not.toMatch(UNSAFE);
    expect(snap).not.toMatch(UNSAFE);
  });

  it('should never print a choice list that was filtered to nothing as taking any value', async () => {
    // a Persian value with a ZWNJ and an emoji with its variation selector are
    // ordinary text, and both used to be dropped -- leaving no choice, which the
    // page printed as the hint
    const { doc, snap } = await printed({
      options: {
        '--pick <value>': { choices: [`می${ZWNJ}خواهم`, `\u2764${VS16}`], hint: 'anything' },
      },
    });

    expect(doc).not.toContain('anything');
    expect(doc).toContain('--pick <می\\u{200C}خواهم\\|\u2764\\u{FE0F}>');
    expect(JSON.parse(snap).commands[0].options[0].choices).toHaveLength(2);
  });

  it('should print a list of one empty choice as a list', async () => {
    const { doc } = await printed({
      options: { '--pick <value>': { choices: [''], hint: 'anything' } },
    });

    expect(doc).toContain('--pick <"">');
    expect(doc).not.toContain('anything');
  });

  it("should show a positional argument's choices escaped", async () => {
    const { doc } = await printed({
      args: [{ choices: [`x${BIDI}`, 'y'], name: '<mode>' }],
    });

    expect(doc).toContain('mycli <x\\u{202E}|y>');
    expect(doc).not.toMatch(UNSAFE);
  });

  it("should show an example's verbatim text escaped, one line at a time", async () => {
    // `fenced()` was `\p{Cc}` with the newline excused, so a format character
    // went into the fence raw -- and a newline an example holds is still one
    const { doc } = await printed({
      commands: {
        go: { examples: [{ label: 'Go', text: `mycli go ${BIDI}x\nmycli go y` }], run() {} },
      },
    });

    expect(doc).toContain('mycli go \\u{202E}x\nmycli go y');
    expect(doc).not.toMatch(UNSAFE);
  });

  it("should keep an example's tab and read CRLF as one line break", async () => {
    // `split('\n')` left a `\r` on every line, which `escapeControls()` then
    // printed as `\x0D`; and a tab is an example's own indentation
    const { doc } = await printed({
      commands: {
        go: { examples: [{ label: 'Go', text: 'mycli go \\\r\n\t--x\r\nmycli go y' }], run() {} },
      },
    });

    expect(doc).toContain('mycli go \\\n\t--x\nmycli go y');
    expect(doc).not.toContain('\\x0D');
    expect(doc).not.toContain('\\x09');
  });

  it('should print no command whose name holds one, and no raw name in the file names', async () => {
    const surface = await commandSurface({
      name: 'mycli',
      commands: { [`go${BIDI}x`]: { run() {} }, [`two${BIDI}, fine`]: { run() {} } },
    });
    const pages = referencePages(surface);

    expect(pages.map((it) => it.file)).toStrictEqual(['index.md', 'fine.md']);
    expect(JSON.stringify(pages)).not.toMatch(UNSAFE);
    expect(snapshotJson(surface)).not.toMatch(UNSAFE);
  });
});
