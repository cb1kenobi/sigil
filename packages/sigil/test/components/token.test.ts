import { codeRun } from '../../src/components/code-view.js';
import { PromptError } from '../../src/components/prompt-error.js';
import {
  PromptError as FromPrompt,
  tokensOf as tokensFromPrompt,
} from '../../src/components/prompt.js';
import { tokenClasses, tokensOf } from '../../src/components/token.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('the highlight seam', () => {
  it('should name no new class and no new error: prompt.ts re-exports what it moved', () => {
    // SIG-597 moved both out of `prompt.ts`; a copy there would be a second class,
    // and `instanceof PromptError` would be false for half of what is thrown
    expect(FromPrompt).toBe(PromptError);
    expect(tokensFromPrompt).toBe(tokensOf);
  });

  it('should refuse a token name no class can carry with a PromptError', () => {
    expect(() => tokensOf('abc', [{ end: 1, start: 0, token: 'a b' }])).toThrow(PromptError);
  });

  it('should spell a token as sigil-token, its own class, and a role if it has one', () => {
    expect(tokenClasses('keyword')).toBe('sigil-token sigil-token-keyword');
    expect(tokenClasses('keyword', 'accent')).toBe('sigil-token sigil-token-keyword accent');
    expect(tokenClasses('keyword', '')).toBe('sigil-token sigil-token-keyword');
  });

  it('should draw a code run in the spelling tokenClasses() gives, so the layers cannot drift', () => {
    expect(codeRun('x', 'keyword', { role: 'accent' }).classes.join(' ')).toBe(
      tokenClasses('keyword', 'accent')
    );
    expect(codeRun('x', undefined, { role: 'accent' }).classes.join(' ')).toBe('accent');
  });

  it.each(['code-view', 'diff', 'diff-view', 'highlight', 'markdown'])(
    'should have %s read the seam from token.ts and never through prompt.ts',
    (name) => {
      // `prompt.ts` re-exports `tokensOf()`, and the bundler sees through that, so the
      // dist graph stays small -- but an ejected copy's import is rewritten to
      // `@ttylabs/sigil/components/prompt`, which is the whole stack again (SIG-597)
      const source = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'src',
          'components',
          `${name}.ts`
        ),
        'utf-8'
      );

      expect(source).not.toMatch(/from '\.\/prompt\.js'/);
    }
  );
});
