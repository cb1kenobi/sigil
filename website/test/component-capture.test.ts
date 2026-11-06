import { footerEntries } from '../scripts/lib/component-capture.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('footerEntries()', () => {
  it("should read a prompt's key-help footer as keys and the footer's words", () => {
    const screen = '? Features\n❯ ◯ TypeScript\n  space select · a all · enter confirm';

    assert.deepEqual(footerEntries(screen), [
      { keys: 'space', words: 'select' },
      { keys: 'a', words: 'all' },
      { keys: 'enter', words: 'confirm' },
    ]);
  });

  it('should read keys a footer folds together, and drop the mark of a cut footer', () => {
    assert.deepEqual(footerEntries('? Pick\n  ↑/↓ move · 1/2/3 sort …'), [
      { keys: '↑/↓', words: 'move' },
      { keys: '1/2/3', words: 'sort' },
    ]);
  });

  it('should not take the question, a choice or the cursor row for a footer', () => {
    assert.deepEqual(footerEntries('? Project name ledger'), []);
    assert.deepEqual(footerEntries('? Template\n  cli\n  prompts only'), []);
    assert.deepEqual(footerEntries('? Template\n❯ a apple'), []);
  });
});
