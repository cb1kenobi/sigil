/**
 * The highlight seam: what a highlighter says, what it is turned into, and the
 * classes a token's cells carry.
 *
 * Every component that draws code -- `codeView()`, `markdown()`, `diff()`,
 * `TextArea()` and the prompts -- asks a `Highlighter` and reads the answer
 * through `tokensOf()`, and none of them needs the rest of `prompt.ts` to do it.
 * It was written there, so each of them imported the prompt stack to reach one
 * function (SIG-597). `prompt.ts` re-exports every name below, so none moved.
 */

import { PromptError } from './prompt-error.js';

/**
 * A stretch of a multiline value that a `highlight` hook says is a token.
 *
 * Offsets into the **whole value** rather than into one line, so a block comment
 * or a string that runs over a line break can be one span -- which a hook handed
 * one line at a time cannot say at all. A highlighter that does work line by line
 * is a `split('\n')` and a running offset away from this shape; one that needs
 * the lines above it has no way back from the other.
 */
export interface HighlightSpan {
  /** The offset the span ends before. */
  end: number;
  /** The offset the span starts at. */
  start: number;
  /**
   * What it is, which becomes the class `sigil-token-<token>` on the cells it
   * covers. `comment`, `function`, `invalid`, `keyword`, `number`, `string` and
   * `type` also draw in a role, so they are coloured with no stylesheet at all;
   * any other name is a hook for the app's own sheet. A letter, then letters,
   * digits and dashes.
   */
  token: string;
}

/**
 * Says which stretches of some code are which tokens -- the one shape every
 * highlight seam takes: `multiline()`, `TextArea()`, `diff()` and `markdown()`.
 *
 * `lang` is what the component knows of the language, and it says where that came
 * from: a code block's fence, a file name's extension in a diff, or the `lang` the
 * app gave. It is `undefined` where nothing said, and a highlighter that only reads
 * one language ignores it. `highlightCode()`, from
 * `@ttylabs/sigil/components/highlight`, is one, for a handful of languages; an
 * app's own is anything else of this shape.
 *
 * @param code - The code: a whole value, side or block, line endings made `\n`.
 * @param lang - Its language, where the component knows one.
 * @returns The spans, as offsets into `code`.
 */
export type Highlighter = (code: string, lang?: string) => readonly HighlightSpan[];

/**
 * What a token may be called, which is what a class may be called.
 *
 * Refused rather than cleaned up, because a name is spliced into a class list:
 * `'a b'` would be two classes and reach rules written for neither, and a name
 * that has to be rewritten to be usable is one a sheet cannot be written against.
 */
const TOKEN_NAME = /^[A-Za-z][\w-]*$/;

/**
 * The token each offset of a value is, from what a `highlight` hook said.
 *
 * **Clipped rather than refused**, which is the other half of the rule above and
 * differs from it on purpose: an offset is arithmetic a highlighter does over a
 * value it was just handed, and one a little past the end is a slip that marks
 * nothing, while a bad name is a bug in a sheet nobody can write. A `NaN` offset
 * marks nothing either, since every comparison against one is false.
 *
 * @param value - What the spans are offsets into.
 * @param spans - What the hook said.
 * @returns A token per offset, `undefined` where none was named.
 * @throws {PromptError} When a span names a token no class can carry.
 */
export function tokensOf(value: string, spans: readonly HighlightSpan[]): (string | undefined)[] {
  const tokens: (string | undefined)[] = Array.from({ length: value.length });

  for (const span of spans) {
    if (typeof span.token !== 'string' || !TOKEN_NAME.test(span.token)) {
      throw new PromptError(
        `A highlight span names a token no class can carry: ${JSON.stringify(span.token)}`
      );
    }
    const to = Math.min(value.length, span.end);
    for (let at = Math.max(0, Math.ceil(span.start)); at < to; at++) {
      tokens[at] = span.token;
    }
  }

  return tokens;
}

/**
 * The classes a token's cells carry: `sigil-token` and `sigil-token-<token>` for an
 * app's sheet, and a role beside them where there is one.
 *
 * One spelling for the three places that draw a token -- the prompt's layer, the
 * text area's and a code view's run -- which each wrote it out, so that a change to
 * it was three edits and the one missed was a theme that reached two of them.
 *
 * The role is **asked for rather than looked up**: `TOKEN_ROLE` is the theme's, and
 * this module is the one a code view reaches without the theme's graph behind it
 * (SIG-597). Every caller says `TOKEN_ROLE.get(token)` -- or a role of its own, as
 * a diff's context lines do -- which is the one line each already had.
 *
 * @param token - The token.
 * @param role - The role to draw in, if it has one.
 * @returns The class list, space separated.
 */
export function tokenClasses(token: string, role?: string): string {
  return `sigil-token sigil-token-${token}${role ? ` ${role}` : ''}`;
}
