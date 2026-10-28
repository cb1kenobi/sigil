import { createAnsi } from '../../src/ansi/index.js';
import { autocomplete, type AutocompleteOptions } from '../../src/components/autocomplete.js';
import { PromptError } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const TAB = '\t';
const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const PAGEDOWN = '\u001b[6~';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/**
 * Waits for a frame the renderer paced itself.
 *
 * An answer that arrives with no key behind it is drawn by the next frame rather
 * than by the one a key handler forces, and that frame is a timer.
 */
async function frame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await tick();
}

/**
 * Starts the prompt and reports how it settled.
 *
 * The handler is attached before any key is sent, for `prompt.test.ts`'s own
 * reason: a prompt can reject while `type()` is still awaiting, and a promise that
 * rejects before anything is listening is an unhandled rejection.
 */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** A prompt over a screen, with no theme and no colour. */
function open<T = string>(ui: ScreenHarness, opts: Partial<AutocompleteOptions<T>> = {}) {
  return autocomplete<T>({
    ansi: ui.ansi,
    // an answer that arrives with no key behind it is drawn by a frame the
    // renderer paces, and a test cannot wait thirty milliseconds for each
    frameMs: 0,
    message: 'Pick',
    terminal: ui.terminal,
    ...opts,
  } as AutocompleteOptions<T>);
}

/** What the screen shows now, one row per entry, blank rows dropped. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter((line) => line !== '');
}

/** A promise that is settled from outside, for a source that answers when told. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1'];

describe('autocomplete() over a static list', () => {
  it('should offer every choice before anything is typed', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await tick();

    expect(rows(ui)).toEqual([
      '? Pick',
      '  ❯ us-east-1',
      '    us-west-2',
      '    eu-central-1',
      '    ap-south-1',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should answer with the first choice on Enter', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, ENTER);

    expect((await answer).value).toBe('us-east-1');
  });

  it('should narrow the list as a term is typed', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'e', 'u');

    expect(rows(ui)).toEqual(['? Pick eu', '  ❯ eu-central-1']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('eu-central-1');
  });

  it('should rank the better match first', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ['xx-west', 'west', 'a-w-e-s-t'] }));

    await type(ui.stdin, 'w', 'e', 's', 't');

    expect(rows(ui).slice(1)).toEqual(['  ❯ west', '    xx-west', '    a-w-e-s-t']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('west');
  });

  it("should answer with a choice's value, and with its label when it has none", async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open<number | string>(ui, {
        choices: [{ label: 'Production', value: 3 }, { label: 'Staging' }],
      })
    );

    await type(ui.stdin, DOWN, ENTER);
    expect((await answer).value).toBe('Staging');

    const second = screenSetup({ rows: 10 });
    const byValue = settle(open<number>(second, { choices: [{ label: 'Production', value: 3 }] }));
    await type(second.stdin, ENTER);
    expect((await byValue).value).toBe(3);
  });

  it('should show a choice hint beside its label', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ hint: 'the big one', label: 'Production', value: 'prod' }] })
    );

    await tick();
    expect(rows(ui)[1]).toBe('  ❯ Production the big one');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should move the highlight with Up and Down, wrapping at both ends', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ['a1', 'a2', 'a3'] }));

    await type(ui.stdin, UP);
    expect(rows(ui)).toContain('  ❯ a3');

    await type(ui.stdin, DOWN);
    expect(rows(ui)).toContain('  ❯ a1');

    await type(ui.stdin, DOWN, DOWN, ENTER);
    expect((await answer).value).toBe('a3');
  });

  it('should put the highlight back at the top when the term changes', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ['alpha', 'beta', 'gamma'] }));

    // `a` keeps all three; the highlight was on `gamma` and the new ranking has a
    // different row there
    await type(ui.stdin, DOWN, DOWN, 'a', ENTER);

    expect((await answer).value).toBe('alpha');
  });

  it('should say nothing matches, and do nothing on Enter until something does', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'z', 'z', ENTER);
    expect(rows(ui)).toEqual(['? Pick zz', '  No matches']);

    await type(ui.stdin, BACKSPACE, BACKSPACE, ENTER);
    expect((await answer).value).toBe('us-east-1');
  });

  it('should start with the text given as `initial`, already filtering', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, initial: 'ap' }));

    await tick();
    expect(rows(ui)).toEqual(['? Pick ap', '  ❯ ap-south-1']);

    // the caret is at the end, so typing extends it
    await type(ui.stdin, '-', 's', ENTER);
    expect((await answer).value).toBe('ap-south-1');
  });

  it('should show the placeholder until something is typed', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, placeholder: 'a region' }));

    await tick();
    expect(rows(ui)[0]).toBe('? Pick a region');

    await type(ui.stdin, 'u');
    expect(rows(ui)[0]).toBe('? Pick u');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should edit the term in the middle, as a text field does', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    // `uw` matches only us-west-2; stepping left and putting an `s` between
    // them makes `usw`, which still does
    await type(ui.stdin, 'u', 'w', LEFT, 's');
    expect(rows(ui)).toEqual(['? Pick usw', '  ❯ us-west-2']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('us-west-2');
  });

  describe('Tab', () => {
    it("should complete the highlighted choice's label into the field", async () => {
      const ui = screenSetup({ rows: 10 });
      const answer = settle(open(ui, { choices: REGIONS }));

      await type(ui.stdin, 'c', 'e', TAB);

      expect(rows(ui)).toEqual(['? Pick eu-central-1', '  ❯ eu-central-1']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should complete the label even when the value is something else', async () => {
      const ui = screenSetup({ rows: 10 });
      const answer = settle(open(ui, { choices: [{ label: 'Production', value: 3 }] }));

      await type(ui.stdin, 'p', TAB);
      expect(rows(ui)[0]).toBe('? Pick Production');

      await type(ui.stdin, ENTER);
      expect((await answer).value).toBe(3);
    });

    it('should keep the choice it completed under the highlight', async () => {
      const ui = screenSetup({ rows: 10 });
      // `ab` is a prefix of both; after completing the second the field holds
      // `abc` and Enter must answer what Tab showed
      const answer = settle(open(ui, { choices: ['ab', 'abc'] }));

      await type(ui.stdin, 'a', DOWN, TAB, ENTER);

      expect((await answer).value).toBe('abc');
    });

    it('should keep the highlight on the row it completed when two share a label', async () => {
      const ui = screenSetup({ rows: 10 });
      // ranking `dup` ties them and the first is what the ranking would put on
      // top, so a highlight that went back to the top would answer 1
      const answer = settle(
        open<number>(ui, {
          choices: [
            { label: 'dup', value: 1 },
            { label: 'dup', value: 2 },
          ],
        })
      );

      await type(ui.stdin, DOWN, TAB, ENTER);

      expect((await answer).value).toBe(2);
    });

    it('should do nothing where nothing matches', async () => {
      const ui = screenSetup({ rows: 10 });
      const answer = settle(open(ui, { choices: REGIONS }));

      await type(ui.stdin, 'z', TAB);
      expect(rows(ui)[0]).toBe('? Pick z');

      await type(ui.stdin, CTRL_C);
      await answer;
    });
  });

  it('should show a window of a list longer than the rows it has', async () => {
    const ui = screenSetup({ rows: 12 });
    const choices = Array.from({ length: 20 }, (_, i) => `item${String(i).padStart(2, '0')}`);
    const answer = settle(open(ui, { choices, rows: 3 }));

    await tick();
    expect(rows(ui).slice(1)).toEqual(['  ❯ item00', '    item01', '    item02']);

    await type(ui.stdin, DOWN, DOWN, DOWN);
    expect(rows(ui).slice(1)).toEqual(['    item01', '    item02', '  ❯ item03']);

    // wrapping up from the top lands on the end, and the window follows it
    await type(ui.stdin, UP, UP, UP, UP);
    expect(rows(ui).slice(1)).toEqual(['    item17', '    item18', '  ❯ item19']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('item19');
  });

  it('should page through a long list', async () => {
    const ui = screenSetup({ rows: 12 });
    const choices = Array.from({ length: 20 }, (_, i) => `item${String(i).padStart(2, '0')}`);
    const answer = settle(open(ui, { choices, rows: 5 }));

    await type(ui.stdin, PAGEDOWN, ENTER);

    // a page is the rows less one, so a line of what was read survives the jump
    expect((await answer).value).toBe('item04');
  });

  it('should never take more rows than the terminal has left', async () => {
    const ui = screenSetup({ rows: 5 });
    const choices = Array.from({ length: 20 }, (_, i) => `item${i}`);
    const answer = settle(open(ui, { choices, rows: Infinity }));

    await tick();
    // the question, the list, and the line reserved under it
    expect(rows(ui).length).toBeLessThanOrEqual(5);
    expect(rows(ui)[1]).toBe('  ❯ item0');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should leave the question and its answer in the log', async () => {
    const ui = screenSetup({ columns: 60, rows: 12 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'e', 'u', ENTER);
    await answer;

    // the list goes, so the other regions are not in what is left
    expect(rows(ui)).toEqual(['? Pick eu-central-1']);
  });

  it('should take a pasted term as one line', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    ui.stdin.send('\u001b[200~us\nwest\u001b[201~');
    await tick();

    expect(rows(ui)[0]).toBe('? Pick us west');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should mark the characters of a label that the term matched', async () => {
    const ui = screenSetup({ rows: 10 });
    // colour on, so the matched run is a different run of cells to the rest;
    // `sigil-heading` is the bold that marks it
    const ansi = createAnsi({ level: 1 });
    const answer = settle(open(ui, { ansi, choices: ['us-west-2'] }));

    await type(ui.stdin, 'w');

    // the frame is a diff: what changed is the `w` in the label, rewritten bold
    // (`1` in the sequence's parameters) and nothing else of the row
    expect(ui.output).toMatch(/\[(?:\d+;)*1(?:;\d+)*mw\S*\[0m$/);
    await type(ui.stdin, CTRL_C);
    await answer;
  });

  describe('validate', () => {
    it('should refuse an answer with its message and keep the prompt alive', async () => {
      const ui = screenSetup({ rows: 10 });
      const validate = vi.fn((value: string) =>
        value.startsWith('eu') ? 'not in that region' : undefined
      );
      const answer = settle(open(ui, { choices: REGIONS, validate }));

      await type(ui.stdin, 'e', 'u', ENTER);
      expect(rows(ui)).toEqual(['? Pick eu', '  ❯ eu-central-1', '  not in that region']);

      // the refusal goes with the next key, and the prompt answers once it can
      await type(ui.stdin, BACKSPACE, BACKSPACE, 'u', 's', ENTER);
      expect((await answer).value).toBe('us-east-1');
      expect(validate).toHaveBeenCalledWith('eu-central-1');
    });

    it('should wait for an async validator', async () => {
      const ui = screenSetup({ rows: 10 });
      const answer = settle(
        open(ui, {
          choices: REGIONS,
          validate: async () => {
            await tick();
            return 'nope';
          },
        })
      );

      await type(ui.stdin, ENTER);
      await tick(4);
      expect(rows(ui)).toContain('  nope');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should be handed the value rather than the label', async () => {
      const ui = screenSetup({ rows: 10 });
      const validate = vi.fn(() => undefined);
      const answer = settle(
        open<number>(ui, { choices: [{ label: 'Production', value: 3 }], validate })
      );

      await type(ui.stdin, ENTER);
      await answer;

      expect(validate).toHaveBeenCalledWith(3);
    });
  });
});

describe('autocomplete() and a disabled choice', () => {
  it('should not offer a disabled choice from a static list', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ disabled: true, label: 'prod' }, 'dev', { label: 'qa' }] })
    );

    await tick();

    expect(rows(ui)).toEqual(['? Pick', '  ❯ dev', '    qa']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('dev');
  });

  it('should not answer with, or complete to, a disabled choice that matches what is typed', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ disabled: 'locked', label: 'production' }, 'product-docs'] })
    );

    await type(ui.stdin, 'prod', TAB);
    expect(rows(ui)[0]).toBe('? Pick product-docs');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('product-docs');
  });

  it('should refuse a list in which every choice is disabled', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(
      open(ui, {
        choices: [
          { disabled: true, label: 'a' },
          { disabled: 'no', label: 'b' },
        ],
      })
    );

    expect(settled.error?.message).toMatch(/no choices to offer/);
  });

  it('should not offer a disabled choice a source returns', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { source: () => [{ disabled: true, label: 'prod' }, 'dev', 'qa'] })
    );

    await frame();

    expect(rows(ui)).toEqual(['? Pick', '  ❯ dev', '    qa']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('dev');
  });
});

describe('autocomplete() over a source', () => {
  it('should ask for the empty term when it opens, and show what comes back', async () => {
    const ui = screenSetup({ rows: 10 });
    const source = vi.fn(async (_term: string) => ['one', 'two']);
    const answer = settle(open(ui, { source }));

    await frame();

    expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0]?.[0]).toBe('');
    expect(rows(ui)).toEqual(['? Pick', '  ❯ one', '    two']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('one');
  });

  it('should not answer from a list that belongs to an earlier term', async () => {
    const ui = screenSetup({ rows: 10 });
    const next = deferred<string[]>();
    const answer = settle(
      open(ui, { source: (term) => (term === '' ? ['old-term-row'] : next.promise) })
    );

    await frame();
    expect(rows(ui)[1]).toBe('  ❯ old-term-row');

    // the row on screen answers the empty term, and `x` has been asked for: it is
    // still drawn, and Enter must not hand it over as though it were current
    await type(ui.stdin, 'x', ENTER);
    expect(rows(ui)[1]).toBe('  ❯ old-term-row');

    next.resolve(['new-term-row']);
    await frame();
    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('new-term-row');
  });

  it('should say a lookup is out until it answers', async () => {
    const ui = screenSetup({ rows: 10 });
    const pending = deferred<string[]>();
    const answer = settle(open(ui, { source: () => pending.promise }));

    await frame();
    expect(rows(ui)).toEqual(['? Pick', '  Searching...']);

    pending.resolve(['late']);
    await frame();
    expect(rows(ui)).toEqual(['? Pick', '  ❯ late']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('late');
  });

  it('should ask again with the new term on each change', async () => {
    const ui = screenSetup({ rows: 10 });
    const source = vi.fn(async (term: string) => [`${term}-result`]);
    const answer = settle(open(ui, { source }));

    await type(ui.stdin, 'a', 'b');

    expect(source.mock.calls.map(([term]) => term)).toEqual(['', 'a', 'ab']);
    expect(rows(ui)).toEqual(['? Pick ab', '  ❯ ab-result']);

    await type(ui.stdin, BACKSPACE);
    expect(source.mock.calls.at(-1)?.[0]).toBe('a');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should not ask again for a key that changes nothing', async () => {
    const ui = screenSetup({ rows: 10 });
    const source = vi.fn(async () => ['x', 'y']);
    const answer = settle(open(ui, { source }));

    // arrows, Home, Tab on an unchanged label and a backspace at the start of
    // an empty field all leave the term where it was
    await type(ui.stdin, DOWN, UP, LEFT, BACKSPACE, '\u001b[H');

    expect(source).toHaveBeenCalledTimes(1);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should abort the previous lookup when the term changes', async () => {
    const ui = screenSetup({ rows: 10 });
    const signals: AbortSignal[] = [];
    const answer = settle(
      open(ui, {
        source: (_term, signal) => {
          signals.push(signal);
          return new Promise<string[]>(() => {});
        },
      })
    );

    await frame();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    await type(ui.stdin, 'a');
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should never write the result of a lookup that was aborted', async () => {
    const ui = screenSetup({ rows: 10 });
    const lookups = new Map<string, ReturnType<typeof deferred<string[]>>>();
    const source = (term: string) => {
      const lookup = deferred<string[]>();
      lookups.set(term, lookup);
      return lookup.promise;
    };
    const answer = settle(open(ui, { source }));

    await type(ui.stdin, 'a', 'b');

    // the answer for `a` arrives after `ab` was asked for: it must not be shown,
    // nor stop the prompt saying a lookup is out
    lookups.get('a')?.resolve(['stale-answer']);
    await frame();
    expect(rows(ui)).toEqual(['? Pick ab', '  Searching...']);

    // and nor must it be what Enter answers with
    await type(ui.stdin, ENTER);
    expect(rows(ui)).toEqual(['? Pick ab', '  Searching...']);

    lookups.get('ab')?.resolve(['fresh-answer']);
    await frame();
    expect(rows(ui)).toEqual(['? Pick ab', '  ❯ fresh-answer']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('fresh-answer');
  });

  it('should never write the failure of a lookup that was aborted', async () => {
    const ui = screenSetup({ rows: 10 });
    const first = deferred<string[]>();
    let calls = 0;
    const answer = settle(
      open(ui, {
        source: async () => {
          calls++;
          return calls === 1 ? first.promise : ['ok'];
        },
      })
    );

    await type(ui.stdin, 'a');
    first.reject(new Error('the old one failed'));
    await frame();

    expect(rows(ui)).toEqual(['? Pick a', '  ❯ ok']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should show a rejection under the field and carry on', async () => {
    const ui = screenSetup({ rows: 10 });
    const source = vi.fn(async (term: string) => {
      if (term === 'a') {
        throw new Error('registry unreachable');
      }
      return [`${term || 'none'}-found`];
    });
    const answer = settle(open(ui, { source }));

    await type(ui.stdin, 'a');
    expect(rows(ui)).toEqual(['? Pick a', '  registry unreachable']);

    // Enter has nothing to answer with, and the prompt is still alive
    await type(ui.stdin, ENTER);
    expect(rows(ui)).toEqual(['? Pick a', '  registry unreachable']);

    // the next keystroke asks again, which is the recovery
    await type(ui.stdin, BACKSPACE);
    expect(rows(ui)).toEqual(['? Pick', '  ❯ none-found']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('none-found');
  });

  it('should show a source that throws before it returns a promise', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        source: (term) => {
          if (term === 'x') {
            throw new Error('bad term');
          }
          return ['fine'];
        },
      })
    );

    await type(ui.stdin, 'x');
    expect(rows(ui)).toEqual(['? Pick x', '  bad term']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should show what a source returns as it is, without filtering it again', async () => {
    const ui = screenSetup({ rows: 10 });
    // nothing here matches `zzz`, and a source that matched on something other
    // than the label -- a description, an id -- is the reason it is not filtered
    const answer = settle(open(ui, { source: async () => ['alpha', 'beta'] }));

    await type(ui.stdin, 'z', 'z', 'z');

    expect(rows(ui)).toEqual(['? Pick zzz', '  ❯ alpha', '    beta']);

    await type(ui.stdin, DOWN, ENTER);
    expect((await answer).value).toBe('beta');
  });

  it('should take choices objects from a source, and answer with their values', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open<{ id: number } | string>(ui, {
        source: async () => [{ label: 'Widget', value: { id: 7 } }, 'plain'],
      })
    );

    await frame();
    await type(ui.stdin, ENTER);

    expect((await answer).value).toEqual({ id: 7 });
  });

  it('should say nothing matches when a source answers with nothing', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { source: async () => [] }));

    await frame();
    expect(rows(ui)).toEqual(['? Pick', '  No matches']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should abort the lookup in flight when the prompt is answered', async () => {
    const ui = screenSetup({ rows: 10 });
    const signals: AbortSignal[] = [];
    const answer = settle(
      open(ui, {
        source: async (_term, signal) => {
          signals.push(signal);
          return ['one'];
        },
      })
    );

    await frame();
    await type(ui.stdin, ENTER);
    await answer;

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('should abort the lookup in flight when the prompt is cancelled', async () => {
    const ui = screenSetup({ rows: 10 });
    const signals: AbortSignal[] = [];
    const answer = settle(
      open(ui, {
        source: (_term, signal) => {
          signals.push(signal);
          return new Promise<string[]>(() => {});
        },
      })
    );

    await frame();
    await type(ui.stdin, CTRL_C);

    expect((await answer).error?.aborted).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('should draw nothing for an answer that arrives after the prompt is over', async () => {
    const ui = screenSetup({ rows: 10 });
    const late = deferred<string[]>();
    const answer = settle(open(ui, { source: () => late.promise }));

    await frame();
    await type(ui.stdin, CTRL_C);
    await answer;

    const before = ui.written.length;
    late.resolve(['too late']);
    await frame();

    expect(ui.written.length).toBe(before);
  });

  it('should validate a value from a source too', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { source: async () => ['one'], validate: () => 'taken' }));

    await frame();
    await type(ui.stdin, ENTER);
    expect(rows(ui)).toContain('  taken');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should complete a label from a source and look it up', async () => {
    const ui = screenSetup({ rows: 10 });
    const source = vi.fn(async (term: string) => (term === '' ? ['react', 'redux'] : [term]));
    const answer = settle(open(ui, { source }));

    await frame();
    await type(ui.stdin, DOWN, TAB);

    expect(source.mock.calls.at(-1)?.[0]).toBe('redux');
    expect(rows(ui)[0]).toBe('? Pick redux');

    await type(ui.stdin, CTRL_C);
    await answer;
  });
});

describe('autocomplete() where it cannot work', () => {
  it('should refuse to exist where the input is not a terminal', async () => {
    const ui = screenSetup({ inputTTY: false });
    const settled = await settle(open(ui, { choices: REGIONS }));
    expect(settled.error?.message).toMatch(/not a terminal/);
    expect(settled.error?.aborted).toBe(false);
  });

  it('should not call a source where there is nobody to answer', async () => {
    const ui = screenSetup({ isTTY: false });
    const source = vi.fn(async () => ['x']);
    const settled = await settle(open(ui, { source }));

    expect(settled.error?.message).toMatch(/not a terminal/);
    expect(source).not.toHaveBeenCalled();
  });

  it('should leave Ctrl-C the abort every prompt takes', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, CTRL_C);

    expect((await answer).error?.aborted).toBe(true);
  });

  it('should refuse an empty list of choices', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, { choices: [] }));
    expect(settled.error?.message).toMatch(/no choices to offer/);
  });

  it('should refuse to be given neither choices nor a source', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, {}));
    expect(settled.error?.message).toMatch(/either choices or a source/);
  });

  it('should refuse to be given both', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, { choices: REGIONS, source: async () => [] }));
    expect(settled.error?.message).toMatch(/both choices and a source/);
  });
});
