import { completionScript } from '../src/completion/index.js';
import { completionSpec } from '../src/completion/spec.js';
import { parse } from '../src/parser/parse.js';
import type { Schema } from '../src/types.js';
import { describe, expect, it } from 'vitest';

/**
 * The two errors the completion printer throws that quote a value the caller
 * chose, and that echoed it raw (SIG-592).
 *
 * SIG-576 made the installer's messages inert and left these two: the program
 * name in "is not a name a shell can register for" and the shell name in
 * "Unknown shell". The first reaches stderr through `errorHandler()`, which
 * prints a message as it finds it; the second is reached only by a caller of
 * `completionScript()`, since the parse refuses an unknown shell first through
 * the argument's own `choices`. Either way a control character in the value
 * reached the terminal. Written as escapes and never as raw bytes, for the
 * reason `sources.test.ts` exists.
 */

/** U+202E, the right-to-left override, which reverses the line it is printed on. */
const BIDI = String.fromCodePoint(0x202e);

/** A window retitle and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

async function state(schema: Schema) {
  return await parse({ argv: [], env: {}, schema });
}

describe('what a completion error echoes', () => {
  it('should escape the program name in the refusal to register for it', async () => {
    // `programOf()` has already flattened every control character out of the
    // name, so what reaches the message is a format character and the
    // whitespace that makes the name unregisterable
    const name = `my${BIDI}cli two`;
    const error = await completionSpec(await state({ name })).catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"my\\u{202E}cli two" is not a name');
    expect((error as Error).message).not.toContain(BIDI);
  });

  it('should escape the shell name in the refusal of an unknown shell', async () => {
    const error = await completionScript(await state({ name: 'mycli' }), HOSTILE + BIDI).catch(
      (e: unknown) => e as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'Unknown shell "\\x1B]0;T\\x07\\x0Aforged: error\\u{202E}":'
    );
    // nothing a terminal would act on, and no second line
    expect((error as Error).message).not.toMatch(/[\p{Cc}\u202e]/u);
  });
});
