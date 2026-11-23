import { layoutField, offsetIn } from '../../src/components/field-layout.js';
import {
  layoutField as fromPrompt,
  offsetIn as offsetFromPrompt,
} from '../../src/components/prompt.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** A component's source, read off disk. */
function source(name: string): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'components', `${name}.ts`),
    'utf-8'
  );
}

describe('the field layout', () => {
  it('should name no new function: prompt.ts re-exports what it moved', () => {
    // SIG-615 moved both out of `prompt.ts`; a second copy there would be a second
    // layout, and the prompts and the text area would wrap differently
    expect(fromPrompt).toBe(layoutField);
    expect(offsetFromPrompt).toBe(offsetIn);
  });

  it('should lay a value out and find the offset a column aims at', () => {
    const laid = layoutField('hello world', 3, 8);

    expect(laid.rows.map((row) => row.start)).toEqual([0, 6]);
    expect(laid.caret).toMatchObject({ row: 0, x: 3 });
    expect(offsetIn(laid, 11, 1, 2)).toBe(8);
  });

  it.each(['text-area'])(
    'should have %s read the layout from field-layout.ts and never through prompt.ts',
    (name) => {
      // `prompt.ts` re-exports `layoutField()` and the bundler sees through that, so
      // the dist graph stays small -- but an ejected copy's import is rewritten to
      // `@ttylabs/sigil/components/prompt`, which is the whole stack again (SIG-615)
      expect(source(name)).not.toMatch(/from '\.\/prompt\.js'/);
      expect(source(name)).toMatch(
        /import \{[^}]*\blayoutField\b[^}]*\} from '\.\/field-layout\.js'/
      );
    }
  );

  it('should have number() read layoutField() from field-layout.ts', () => {
    const text = source('number');

    expect(text).toMatch(/import \{[^}]*\blayoutField\b[^}]*\} from '\.\/field-layout\.js'/);
    // the import of the prompt module is the one statement that must not name it
    for (const [, names] of text.matchAll(/import \{([^}]*)\} from '\.\/prompt\.js'/g)) {
      expect(names).not.toMatch(/\b(?:layoutField|offsetIn)\b/);
    }
  });
});
