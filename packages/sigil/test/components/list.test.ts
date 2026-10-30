import { joinList, list, type ListOptions, splitList } from '../../src/components/list.js';
import { PromptError } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * Starts a prompt and reports how it settled, for the reason `prompt.test.ts`
 * records: the handler has to be attached before any key is sent.
 */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Types a string a character at a time, which is what a keyboard does. */
async function keys(stdin: { send(chunk: string): void }, text: string) {
  await type(stdin, ...text);
}

/** Asks a list prompt on a fresh screen. */
function ask(opts: Partial<ListOptions> = {}, columns = 60) {
  const ui = screenSetup({ columns });
  const answer = settle(list({ ansi: ui.ansi, message: 'Tags', terminal: ui.terminal, ...opts }));
  return { answer, ui };
}

/** What the field holds, read off the question line after the message. */
function field(ui: ScreenHarness): string {
  return (ui.log[0] ?? '').replace(/^\S+ Tags ?/, '');
}

const ENTER = '\r';
const CTRL_C = '\u0003';
const LEFT = '\u001b[D';
const BACKSPACE = '\u007f';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

describe('splitList()', () => {
  it('should split on a comma by default and trim each entry', () => {
    expect(splitList('api, web ,db')).toStrictEqual(['api', 'web', 'db']);
  });

  it('should drop an entry with nothing left in it', () => {
    expect(splitList('a, b,, c,')).toStrictEqual(['a', 'b', 'c']);
    expect(splitList(' , ,')).toStrictEqual([]);
  });

  it('should read an empty line as an empty list, not as one empty entry', () => {
    expect(splitList('')).toStrictEqual([]);
  });

  it('should keep a repeated entry', () => {
    expect(splitList('a,b,a')).toStrictEqual(['a', 'b', 'a']);
  });

  it('should match a string separator literally', () => {
    expect(splitList('a.b.c', '.')).toStrictEqual(['a', 'b', 'c']);
    expect(splitList('a||b', '||')).toStrictEqual(['a', 'b']);
  });

  it('should split on a regular expression wherever it matches', () => {
    expect(splitList('a, b  c,d', /[\s,]+/)).toStrictEqual(['a', 'b', 'c', 'd']);
  });

  it('should not let a capture group become an entry', () => {
    expect(splitList('a-b_c', /([-_])/)).toStrictEqual(['a', 'b', 'c']);
  });

  it('should not treat a match with nothing in it as a separator', () => {
    expect(splitList('abc', /x*/)).toStrictEqual(['abc']);
  });

  it('should scan the whole line whatever the global and sticky flags say', () => {
    const sticky = /,/y;
    expect(splitList('a,b,c', sticky)).toStrictEqual(['a', 'b', 'c']);
    expect(splitList('a,b,c', /,/g)).toStrictEqual(['a', 'b', 'c']);
    // and a pattern is not left holding a position from the last call
    expect(splitList('a,b,c', /,/g)).toStrictEqual(['a', 'b', 'c']);
    expect(sticky.lastIndex).to.equal(0);
  });

  it('should honour the other flags', () => {
    expect(splitList('aXbxc', /x/i)).toStrictEqual(['a', 'b', 'c']);
  });
});

describe('joinList()', () => {
  it('should follow a separator with a space', () => {
    expect(joinList(['a', 'b'])).toBe('a, b');
    expect(joinList(['a', 'b'], ';')).toBe('a; b');
  });

  it('should use a whitespace separator as it is', () => {
    expect(joinList(['a', 'b'], ' ')).toBe('a b');
  });

  it('should join for a regular expression with a comma and a space', () => {
    expect(joinList(['a', 'b'], /[\s,]+/)).toBe('a, b');
  });
});

describe('list()', () => {
  describe('typing', () => {
    it('should return the entries as an array', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, 'api, web ,, db,');
      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual(['api', 'web', 'db']);
    });

    it('should show the line as it is typed, not as it will be read', async () => {
      const { ui } = ask();

      await keys(ui.stdin, 'a ,, b');

      expect(field(ui)).to.equal('a ,, b');
    });

    it('should answer an empty list when nothing was typed and there is no default', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual([]);
    });

    it('should split on the separator it was given', async () => {
      const { answer, ui } = ask({ separator: ';' });

      await keys(ui.stdin, 'a,b; c');
      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual(['a,b', 'c']);
    });

    it('should split on a regular expression separator', async () => {
      const { answer, ui } = ask({ separator: /[\s,]+/ });

      await keys(ui.stdin, 'one two,three');
      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual(['one', 'two', 'three']);
    });

    it('should flatten a pasted block onto the one line', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, `${PASTE_START}a, b\nc${PASTE_END}`);
      expect(field(ui)).to.equal('a, b c');

      await type(ui.stdin, ENTER);
      expect((await answer).value).toStrictEqual(['a', 'b c']);
    });

    it('should edit with the text field’s own keys', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, 'a,c');
      await type(ui.stdin, LEFT, LEFT);
      await keys(ui.stdin, 'b');
      await type(ui.stdin, ENTER);
      expect((await answer).value).toStrictEqual(['ab', 'c']);

      const second = ask();
      await keys(second.ui.stdin, 'x,yz');
      await type(second.ui.stdin, BACKSPACE, BACKSPACE, ENTER);
      expect((await second.answer).value).toStrictEqual(['x']);
    });
  });

  describe('initial and default', () => {
    it('should start the field with an array joined by the separator', async () => {
      const { answer, ui } = ask({ initial: ['cli', 'node'] });

      expect(field(ui)).to.equal('cli, node');

      await keys(ui.stdin, ',ts');
      await type(ui.stdin, ENTER);
      expect((await answer).value).toStrictEqual(['cli', 'node', 'ts']);
    });

    it('should start the field with a string as it is', async () => {
      const { answer, ui } = ask({ initial: 'a;b', separator: ';' });

      expect(field(ui)).to.equal('a;b');

      await type(ui.stdin, ENTER);
      expect((await answer).value).toStrictEqual(['a', 'b']);
    });

    it('should answer an initial that was not touched exactly as given', async () => {
      const { answer, ui } = ask({ initial: ['x', 'y'], separator: ';' });

      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual(['x', 'y']);
    });

    it('should answer the default when the line has no entries', async () => {
      const given = ['one', 'two'];
      const { answer, ui } = ask({ default: given });

      // a line of nothing is as empty as no line at all
      await keys(ui.stdin, ' , ,');
      await type(ui.stdin, ENTER);

      const { value } = await answer;
      expect(value).toStrictEqual(['one', 'two']);
      // a copy, so that the caller's array is not the answer's
      expect(value).not.to.equal(given);
    });

    it('should show the default dimmed in the empty field', () => {
      const { ui } = ask({ default: ['one', 'two'] });

      expect(field(ui)).to.equal('one, two');
    });

    it('should show a placeholder in place of the default', () => {
      const { ui } = ask({ default: ['one'], placeholder: 'comma separated' });

      expect(field(ui)).to.equal('comma separated');
    });

    it('should prefer what was typed to the default', async () => {
      const { answer, ui } = ask({ default: ['one'] });

      await keys(ui.stdin, 'two');
      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual(['two']);
    });
  });

  describe('validate', () => {
    it('should be given the entries, and its message keeps the prompt open', async () => {
      const seen: string[][] = [];
      const { answer, ui } = ask({
        validate(value) {
          seen.push(value);
          return value.length < 2 ? 'Give at least two' : undefined;
        },
      });

      await keys(ui.stdin, 'a, ,');
      await type(ui.stdin, ENTER);
      expect(ui.log).to.include('  Give at least two');

      await keys(ui.stdin, ' b');
      await type(ui.stdin, ENTER);

      expect(seen).toStrictEqual([['a'], ['a', 'b']]);
      expect((await answer).value).toStrictEqual(['a', 'b']);
    });

    it('should be given the default when that is the answer', async () => {
      const seen: string[][] = [];
      const { answer, ui } = ask({
        default: ['d'],
        validate(value) {
          seen.push(value);
        },
      });

      await type(ui.stdin, ENTER);
      await answer;

      expect(seen).toStrictEqual([['d']]);
    });
  });

  describe('being answered', () => {
    it('should leave the entries on the line once they are given', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, 'a,  b ,,c');
      await type(ui.stdin, ENTER);
      await answer;

      expect(ui.log).to.deep.equal(['? Tags a, b, c']);
    });

    it('should reject when the person gives up', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, CTRL_C);

      const { error } = await answer;
      expect(error).toBeInstanceOf(PromptError);
      expect(error?.aborted).to.equal(true);
    });
  });

  describe('being asked', () => {
    it('should reject, rather than wait, where nobody can answer', async () => {
      const ui = screenSetup({ isTTY: false });

      await expect(list({ ansi: ui.ansi, message: 'Tags', terminal: ui.terminal })).rejects.toThrow(
        'Cannot prompt for "Tags" because the input is not a terminal'
      );
    });

    it.each([
      ['an empty separator', { separator: '' }, '`separator` is an empty string'],
      [
        'an initial holding the separator',
        { initial: ['a,b'] },
        '`initial` does not survive being joined and split',
      ],
      [
        'an initial with an empty entry',
        { initial: ['a', ''] },
        '`initial` does not survive being joined and split',
      ],
      [
        'an initial with space around an entry',
        { initial: [' a'] },
        '`initial` does not survive being joined and split',
      ],
      [
        'an initial a pattern does not split',
        { initial: ['a', 'b'], separator: /;/ },
        '`initial` does not survive being joined and split',
      ],
    ] as const)('should refuse %s', async (_name, opts, why) => {
      const ui = screenSetup();

      await expect(
        list({ ansi: ui.ansi, message: 'Tags', terminal: ui.terminal, ...opts })
      ).rejects.toThrow(why);
    });

    it('should accept an initial a pattern does split', async () => {
      const { answer, ui } = ask({ initial: ['a', 'b'], separator: /[\s,]+/ });

      await type(ui.stdin, ENTER);

      expect((await answer).value).toStrictEqual(['a', 'b']);
    });
  });
});
