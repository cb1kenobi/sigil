import type { AutocompleteRange } from '../../src/components/autocomplete.js';
import { text } from '../../src/components/prompt.js';
import { createHistory } from '../../src/components/repl-history.js';
import {
  createRepl,
  Repl,
  repl,
  type ReplOptions,
  wordCompleter,
} from '../../src/components/repl.js';
import { box, type Element, renderToLines, renderToString } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import {
  createTestTerminal,
  ctrl,
  KEYS,
  pressEscape,
  tick,
  type TestTerminal,
} from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { tempDir } from '../temp.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const CTRL_C = ctrl('c');
const CTRL_D = ctrl('d');
const CTRL_R = ctrl('r');

/** Every session a test started, so one that failed half way cannot hold the console for the next. */
const open: Array<{ abort(): void; done: Promise<void> }> = [];

afterEach(async () => {
  for (const session of open.splice(0)) {
    session.abort();
    await session.done.catch(() => undefined);
  }
});

/** What a session is: its terminal, what ran, and the promise it ends. */
interface Session {
  done: Promise<void>;
  errors: string[];
  ran: string[];
  term: TestTerminal;
}

/**
 * Starts a REPL over a test terminal.
 *
 * @param opts - What to override.
 * @param term - The terminal, if the test built one.
 * @returns The session, with the first prompt on screen.
 */
async function start(
  opts: Partial<ReplOptions> = {},
  term: TestTerminal = createTestTerminal({ columns: 40, rows: 14 })
): Promise<Session> {
  const ran: string[] = [];
  const errors: string[] = [];
  const control = new AbortController();
  const done = repl({
    // an answer that arrives with no key behind it is drawn by a frame the renderer
    // paces, and a test cannot wait thirty milliseconds for each
    frameMs: 0,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    onSubmit: (line) => {
      ran.push(line);
    },
    signal: control.signal,
    terminal: term.terminal,
    ...opts,
  });
  open.push({ abort: () => control.abort(), done });
  // the abort is how a test that ends with the prompt up gets out, and it is not a failure
  done.catch(() => undefined);
  await tick();
  return { done, errors, ran, term };
}

/** The screen, a row each, with trailing blanks trimmed and blank rows dropped. */
function screen(term: TestTerminal): string[] {
  return term.lines.map((line) => line.trimEnd()).filter((line) => line !== '');
}

/** A promise settled from outside, for a provider that answers when told. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/** Waits for the screen to show something, rather than for a length of time. */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check, { interval: 2, timeout: 2000 });
}

const WORDS = ['deploy', 'destroy', 'status', 'rollback'];

describe('repl() on a terminal', () => {
  it('should draw the prompt and the line, and leave the submitted line in the scrollback', async () => {
    const { term, ran } = await start();

    expect(screen(term)).toEqual(['>']);

    await term.press('d', 'e', 'p', 'l', 'o', 'y', ' ', 'p', 'r', 'o', 'd');
    expect(screen(term)).toEqual(['> deploy prod']);

    await term.press(KEYS.enter);

    expect(ran).toEqual(['deploy prod']);
    // the line as typed stays, and the prompt is back under it
    expect(screen(term)).toEqual(['> deploy prod', '>']);
  });

  it('should take the prompt from the caller', async () => {
    const { term } = await start({ prompt: 'mycli$ ' });

    expect(screen(term)).toEqual(['mycli$']);
  });

  it('should edit with the keys every text field shares', async () => {
    const { term, ran } = await start();

    await term.press('h', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd');
    await term.press(ctrl('w'));
    await term.press(KEYS.home, 'X', KEYS.end, '!');

    expect(screen(term)).toEqual(['> Xhello !']);

    await term.press(KEYS.enter);
    expect(ran).toEqual(['Xhello !']);
  });

  it('should not submit a blank line, and should still draw a fresh prompt', async () => {
    const { term, ran } = await start();

    await term.press(KEYS.enter, ' ', KEYS.enter);

    expect(ran).toEqual([]);
    expect(screen(term)).toEqual(['>', '>', '>']);
  });

  it('should flatten a pasted block to one line rather than submit half of it', async () => {
    const { term, ran } = await start();

    await term.paste('one\ntwo');

    expect(ran).toEqual([]);
    expect(screen(term)).toEqual(['> one two']);
  });

  it('should keep running after a command throws, and say what it said', async () => {
    const seen: string[] = [];
    const { term } = await start({
      onError: undefined,
      onSubmit: (line) => {
        if (line === 'boom') {
          throw new Error('it went wrong');
        }
        seen.push(line);
      },
    });
    const written: string[] = [];
    term.stdin.setMaxListeners(0);
    const original = term.terminal.writeErr.bind(term.terminal);
    term.terminal.writeErr = (chunk: string) => {
      written.push(chunk);
      return original(chunk);
    };

    await term.press(...'boom', KEYS.enter);
    await term.press(...'fine', KEYS.enter);

    expect(written.join('')).toContain('it went wrong');
    expect(seen).toEqual(['fine']);
  });

  it('should wait for an async command before it draws the next prompt', async () => {
    const gate = deferred<void>();
    const { term, ran } = await start({
      onSubmit: async (line) => {
        ran.push(line);
        await gate.promise;
      },
    });

    await term.press(...'slow', KEYS.enter);
    await tick();
    // the line is in the scrollback and there is no prompt yet to type into
    expect(screen(term)).toEqual(['> slow']);

    gate.resolve();
    await until(() => expect(screen(term)).toEqual(['> slow', '>']));
  });

  it('should end when the command says exit, once it has returned', async () => {
    const { term, done } = await start({
      onSubmit: (line, { exit }) => {
        if (line === 'quit') {
          exit();
        }
      },
    });

    await term.press(...'quit', KEYS.enter);
    await done;

    expect(screen(term)).toEqual(['> quit']);
  });

  it('should reject with the signal reason when it aborts, and give the terminal back', async () => {
    const term = createTestTerminal({ columns: 40, rows: 8 });
    const control = new AbortController();
    const done = repl({
      frameMs: 0,
      onSubmit: () => {},
      signal: control.signal,
      terminal: term.terminal,
    });
    await tick();
    const rejection = expect(done).rejects.toThrow('stop it');

    control.abort(new Error('stop it'));

    await rejection;
    expect(term.stdin.rawMode).toBe(false);
    expect(screen(term)).toEqual([]);
  });

  it('should give back raw mode and the console when it ends', async () => {
    const log = console.log;
    const { term, done } = await start();
    expect(term.stdin.rawMode).toBe(true);
    expect(console.log).not.toBe(log);

    await term.press(CTRL_D);
    await done;

    expect(term.stdin.rawMode).toBe(false);
    expect(console.log).toBe(log);
  });
});

describe('a line wider than the screen', () => {
  it('should scroll sideways to keep the caret in view, and keep the prompt', async () => {
    const { term, ran } = await start({}, createTestTerminal({ columns: 20, rows: 6 }));

    await term.press(...'abcdefghijklmnopqrstuvwxyz');

    const row = screen(term)[0] as string;
    expect(row.startsWith('> ')).toBe(true);
    expect(row.length).toBeLessThanOrEqual(20);
    expect(row.endsWith('xyz')).toBe(true);

    await term.press(KEYS.enter);
    expect(ran).toEqual(['abcdefghijklmnopqrstuvwxyz']);
  });

  it('should count a wide character as the two columns it takes', async () => {
    const { term } = await start({ completer: wordCompleter(['日本語']) });

    await term.press('日');

    expect(screen(term)[0]).toBe('> 日本語');
    // the popup's label starts under the word, which is two columns in
    expect(screen(term)[1]?.indexOf('日本語')).toBe(2);
  });
});

describe('history', () => {
  it('should walk back with Up and forward with Down, and restore what was being typed', async () => {
    const { term, ran } = await start();
    await term.press(...'one', KEYS.enter);
    await term.press(...'two', KEYS.enter);
    await term.press(...'dra');

    await term.press(KEYS.up);
    expect(screen(term).at(-1)).toBe('> two');
    await term.press(KEYS.up);
    expect(screen(term).at(-1)).toBe('> one');
    await term.press(KEYS.up);
    // the oldest is as far as it goes
    expect(screen(term).at(-1)).toBe('> one');
    await term.press(KEYS.down, KEYS.down);

    expect(screen(term).at(-1)).toBe('> dra');
    expect(ran).toEqual(['one', 'two']);
  });

  it('should run a recalled line, and edit it first if asked', async () => {
    const { term, ran } = await start();
    await term.press(...'echo hi', KEYS.enter);

    await term.press(KEYS.up, KEYS.left, KEYS.left, 'X');
    await term.press(KEYS.enter);

    expect(ran).toEqual(['echo hi', 'echo Xhi']);
  });

  it('should not record a repeat of the line before it', async () => {
    const history = createHistory();
    const { term } = await start({ history } as Partial<ReplOptions>);
    await term.press(...'same', KEYS.enter);
    await term.press(...'same', KEYS.enter);
    await term.press(...'other', KEYS.enter);

    await term.press(KEYS.up, KEYS.up, KEYS.up);

    expect(screen(term).at(-1)).toBe('> same');
    expect(history.entries).toEqual([]);
  });

  it('should keep a file of it that the next session reads', async () => {
    const historyFile = join(tempDir('sigil-repl-history-'), 'history');
    const first = await start({ historyFile });
    await first.term.press(...'deploy prod', KEYS.enter);
    await first.term.press(CTRL_D);
    await first.done;

    const second = await start({ historyFile });
    await second.term.press(KEYS.up);

    expect(screen(second.term).at(-1)).toBe('> deploy prod');
  });

  it('should hear of a line a second REPL ran, at its next prompt', async () => {
    const historyFile = join(tempDir('sigil-repl-two-'), 'history');
    const a = await start({ historyFile });
    const b = await start({ historyFile });

    await a.term.press(...'from a', KEYS.enter);
    await b.term.press(...'from b', KEYS.enter);
    await a.term.press(KEYS.up);

    // b's is the newest, and a reads it when it starts to walk
    expect(screen(a.term).at(-1)).toBe('> from b');
    await a.term.press(KEYS.up);
    expect(screen(a.term).at(-1)).toBe('> from a');
  });

  describe('Ctrl-R', () => {
    /** A session with three lines already run. */
    async function seeded() {
      const session = await start();
      for (const line of ['git status', 'deploy prod', 'git stash']) {
        await session.term.press(...line, KEYS.enter);
      }
      return session;
    }

    it('should search back for the newest line holding what is typed', async () => {
      const { term } = await seeded();

      await term.press(CTRL_R, 'g', 'i', 't');

      expect(screen(term).at(-1)).toBe('(search: git) git stash');
    });

    it('should find the next older match on a second Ctrl-R', async () => {
      const { term } = await seeded();

      await term.press(CTRL_R, ...'git', CTRL_R);

      expect(screen(term).at(-1)).toBe('(search: git) git status');
    });

    it('should narrow as the query grows and widen as it is rubbed out', async () => {
      const { term } = await seeded();

      await term.press(CTRL_R, ...'git st');
      expect(screen(term).at(-1)).toBe('(search: git st) git stash');
      await term.press(KEYS.backspace, KEYS.backspace, KEYS.backspace, KEYS.backspace);
      expect(screen(term).at(-1)).toBe('(search: gi) git stash');
    });

    it('should put the match in the line on Enter without running it', async () => {
      const { term, ran } = await seeded();

      await term.press(CTRL_R, ...'deploy', KEYS.enter);

      expect(screen(term).at(-1)).toBe('> deploy prod');
      expect(ran).toEqual(['git status', 'deploy prod', 'git stash']);
      await term.press(KEYS.enter);
      expect(ran.at(-1)).toBe('deploy prod');
    });

    it('should put back what was being typed on Escape', async () => {
      const { term } = await seeded();
      await term.press(...'draft');

      await term.press(CTRL_R, ...'deploy');
      await pressEscape(term);

      expect(screen(term).at(-1)).toBe('> draft');
    });

    it('should edit the match from where it was found when an editing key ends the search', async () => {
      const { term, ran } = await seeded();

      await term.press(CTRL_R, ...'prod', KEYS.right, KEYS.right, 'X');
      await term.press(KEYS.enter);

      // the caret was on the match -- at the `p` of `prod` -- and the keys after it
      // are read as ordinary ones
      expect(ran.at(-1)).toBe('deploy prXod');
    });

    it('should say so rather than show a stale line when nothing matches', async () => {
      const { term } = await seeded();

      await term.press(CTRL_R, ...'zzz');

      expect(screen(term).at(-1)).toBe('(search: zzz)');
    });
  });
});

describe('completion', () => {
  it('should list what the provider offers under the start of the word', async () => {
    const { term } = await start({ completer: wordCompleter(WORDS) });

    await term.press(...'run de');

    const rows = screen(term);
    expect(rows[0]).toBe('> run deploy');
    // the pointer takes two columns and the labels start under the word, at column 6
    const popup = rows.slice(1);
    expect(popup.map((row) => row.trimStart())).toEqual(['deploy', 'destroy']);
    expect(popup[0]?.indexOf('deploy')).toBe('> run '.length);
  });

  it('should take the highlighted item on Tab, and the first when none is', async () => {
    const { term } = await start({ completer: wordCompleter(WORDS) });

    await term.press(...'de');
    await term.press(KEYS.tab);

    expect(screen(term)).toEqual(['> deploy']);
  });

  it('should move through the popup with Down, take that item on Enter, and not submit it', async () => {
    const { term, ran } = await start({ completer: wordCompleter(WORDS) });

    await term.press(...'de');
    await term.press(KEYS.down, KEYS.down);
    expect(
      screen(term).some((row) => row.startsWith('  ❯ destroy') || row.includes('❯ destroy'))
    ).toBe(true);
    await term.press(KEYS.enter);

    expect(ran).toEqual([]);
    expect(screen(term)).toEqual(['> destroy']);
  });

  it('should leave Enter to submit the line as typed when nothing is highlighted', async () => {
    const { term, ran } = await start({ completer: wordCompleter(WORDS) });

    await term.press(...'de', KEYS.enter);

    expect(ran).toEqual(['de']);
  });

  it('should close the popup on Escape until the next edit', async () => {
    const { term } = await start({ completer: wordCompleter(WORDS) });
    await term.press(...'de');

    await pressEscape(term);
    // the popup and the suggestion with it
    expect(screen(term)).toEqual(['> de']);

    await term.press('s');
    // `des` and the dim rest of `destroy`, with the popup back under it
    expect(screen(term)[0]).toBe('> destroy');
    expect(
      screen(term)
        .slice(1)
        .map((row) => row.trim())
    ).toEqual(['destroy']);
  });

  it('should replace only the range the provider named', async () => {
    const { term } = await start({ completer: wordCompleter(WORDS) });

    await term.press(...'run de now');
    await term.press(KEYS.left, KEYS.left, KEYS.left, KEYS.left, KEYS.left);
    await term.press('s');
    await term.press(KEYS.tab);

    expect(screen(term)[0]).toBe('> run destroy now');
  });

  it('should ask again when Tab does after Escape, and take a lone answer at once', async () => {
    let asked = 0;
    const { term } = await start({
      completer: (line) => {
        asked += 1;
        return {
          from: 0,
          items: ['status', 'stage'].filter((word) => word.startsWith(line)),
          to: line.length,
        };
      },
    });
    await term.press(...'sta');
    await pressEscape(term);
    expect(asked).toBe(3);

    // two words begin `sta`: Tab asks, and there is no lone answer to take
    await term.press(KEYS.tab);
    expect(asked).toBe(4);
    expect(
      screen(term)
        .slice(1)
        .map((row) => row.trim())
    ).toEqual(['status', 'stage']);

    await term.press('t');
    await pressEscape(term);
    await term.press(KEYS.tab);

    expect(screen(term)).toEqual(['> status']);
  });

  it('should drop an answer to a line that has since changed', async () => {
    const asked: Array<{
      line: string;
      reply: (range: AutocompleteRange) => void;
      signal: AbortSignal;
    }> = [];
    const { term } = await start({
      completer: (line, _cursor, signal) => {
        const answer = deferred<AutocompleteRange>();
        asked.push({ line, reply: answer.resolve, signal });
        return answer.promise;
      },
    });

    await term.press('d');
    await term.press('e');
    expect(asked.map((ask) => ask.line)).toEqual(['d', 'de']);
    // the first was aborted the moment the line moved on
    expect(asked[0]?.signal.aborted).toBe(true);
    expect(asked[1]?.signal.aborted).toBe(false);

    // the slow answer to 'd' lands now, after the edit: it names a word that is not
    // for this line, and must not be listed
    asked[0]?.reply({ from: 0, items: ['dZZ-stale'], to: 1 });
    await tick(3);
    expect(screen(term)).toEqual(['> de']);

    asked[1]?.reply({ from: 0, items: ['deploy'], to: 2 });
    await until(() =>
      expect(
        screen(term)
          .slice(1)
          .map((row) => row.trim())
      ).toEqual(['deploy'])
    );
    expect(screen(term).join('\n')).not.toContain('stale');
  });

  it('should not apply a stale answer on Tab either', async () => {
    const asked: Array<(range: AutocompleteRange) => void> = [];
    const { term } = await start({
      completer: () => {
        const answer = deferred<AutocompleteRange>();
        asked.push(answer.resolve);
        return answer.promise;
      },
    });

    await term.press('d');
    await term.press(KEYS.tab);
    await term.press('e');
    asked[1]?.({ from: 0, items: ['wrong'], to: 1 });
    await tick(3);

    expect(screen(term)).toEqual(['> de']);
  });

  it('should show nothing for a throwing or rejecting provider, and report it', async () => {
    const errors: string[] = [];
    const { term } = await start({
      completer: (line) => {
        if (line === 'a') {
          throw new Error('sync failure');
        }
        return Promise.reject(new Error('async failure'));
      },
      onError: (error) => errors.push((error as Error).message),
    });

    await term.press('a');
    await term.press('b');
    await until(() => expect(errors).toEqual(['sync failure', 'async failure']));

    expect(screen(term)).toEqual(['> ab']);
  });

  it('should refuse a range that is not inside the line', async () => {
    const errors: string[] = [];
    const { term } = await start({
      completer: () => ({ from: 0, items: ['x'], to: 99 }),
      onError: (error) => errors.push((error as Error).message),
    });

    await term.press('a');

    expect(errors[0]).toContain('range');
    expect(screen(term)).toEqual(['> a']);
  });

  it('should show a hint after a label, and a label apart from what is inserted', async () => {
    const { term } = await start({
      completer: (line) => ({
        from: 0,
        items: [{ hint: 'ship it', label: 'deploy (prod)', value: 'deploy' }],
        to: line.length,
      }),
    });

    await term.press('d');
    expect(screen(term)[1]?.trim()).toBe('deploy (prod) ship it');

    await term.press(KEYS.tab);
    expect(screen(term)).toEqual(['> deploy']);
  });

  describe('the inline suggestion', () => {
    it('should show the rest of the best match and take it on Right', async () => {
      const { term, ran } = await start({ completer: wordCompleter(WORDS) });

      await term.press(...'stat');
      // the suggestion is the text after the caret, drawn dim
      expect(screen(term)[0]).toBe('> status');

      await term.press(KEYS.right);
      await term.press(KEYS.enter);

      expect(ran).toEqual(['status']);
    });

    it('should take it on End as well', async () => {
      const { term, ran } = await start({ completer: wordCompleter(WORDS) });

      await term.press(...'rol', KEYS.end, KEYS.enter);

      expect(ran).toEqual(['rollback']);
    });

    it('should leave Right to move the caret where there is nothing to take', async () => {
      const { term, ran } = await start({ completer: wordCompleter(WORDS) });

      await term.press(...'xyz', KEYS.left, KEYS.right, KEYS.enter);

      expect(ran).toEqual(['xyz']);
    });

    it('should be off when suggest is false', async () => {
      const { term, ran } = await start({ completer: wordCompleter(WORDS), suggest: false });

      await term.press(...'stat');
      expect(screen(term)[0]).toBe('> stat');
      await term.press(KEYS.right, KEYS.enter);

      expect(ran).toEqual(['stat']);
    });
  });
});

describe('the footer', () => {
  it('should follow the line as it is typed', async () => {
    const { term } = await start({
      footer: (line) => (line.startsWith('deploy') ? 'deploy <env>' : undefined),
    });

    await term.press(...'stat');
    expect(screen(term)).toEqual(['> stat']);

    await term.press(ctrl('u'), ...'deploy');
    expect(screen(term)).toEqual(['> deploy', 'deploy <env>']);

    await term.press(ctrl('u'));
    expect(screen(term)).toEqual(['>']);
  });

  it('should be handed the caret as well', async () => {
    const seen: Array<[string, number]> = [];
    const { term } = await start({
      footer: (line, cursor) => {
        seen.push([line, cursor]);
        return `at ${cursor}`;
      },
    });

    await term.press('a', 'b', KEYS.left);

    expect(screen(term)).toEqual(['> ab', 'at 1']);
    expect(seen).toContainEqual(['ab', 1]);
  });

  it('should leave the scrollback when the line is submitted', async () => {
    const { term } = await start({ footer: () => 'a hint' });

    await term.press(...'go', KEYS.enter);

    expect(screen(term)).toEqual(['> go', '>', 'a hint']);
  });

  it('should list the keys when help is asked for', async () => {
    const { term } = await start(
      { completer: wordCompleter(WORDS), help: true },
      createTestTerminal({ columns: 100, rows: 14 })
    );

    await term.press('d');
    const rows = screen(term).join('\n');

    expect(rows).toContain('run');
    expect(rows).toContain('complete');
    expect(rows).toContain('history');
  });
});

describe('output while the prompt is up', () => {
  it('should write what is logged above the region and draw the region again', async () => {
    const { term } = await start();
    await term.press(...'typing');

    console.log('a background task finished');

    expect(screen(term)).toEqual(['a background task finished', '> typing']);
  });

  it('should keep every line, in order, with the prompt always last', async () => {
    const { term } = await start();

    console.log('first');
    console.info('second');
    console.log('multi\nline');

    expect(screen(term)).toEqual(['first', 'second', 'multi', 'line', '>']);
  });

  it('should send a warning and an error to stderr, above the region', async () => {
    const term = createTestTerminal({ columns: 40, rows: 8 });
    const errors: string[] = [];
    const original = term.terminal.stderr.write.bind(term.terminal.stderr);
    (term.terminal.stderr as { write: unknown }).write = (chunk: string) => {
      errors.push(chunk);
      return original(chunk);
    };
    await start({}, term);

    console.warn('careful');
    console.error('broken');

    expect(errors.join('')).toContain('careful');
    expect(errors.join('')).toContain('broken');
  });

  it('should hand the console back before a command runs, so its output is its own', async () => {
    const before = console.log;
    let during: unknown;
    const { term } = await start({
      onSubmit: () => {
        during = console.log;
      },
    });
    expect(console.log).not.toBe(before);

    await term.press(...'go', KEYS.enter);

    expect(during).toBe(before);
  });
});

describe('a command that takes the terminal', () => {
  it('should find it free to ask a prompt, and get the REPL back after', async () => {
    const answers: string[] = [];
    const { term, ran } = await start({
      onSubmit: async (line) => {
        ran.push(line);
        if (line === 'name') {
          answers.push(await text({ frameMs: 0, message: 'Name?', terminal: term.terminal }));
        }
      },
    });

    await term.press(...'name', KEYS.enter);
    await until(() => expect(screen(term).at(-1)).toBe('? Name?'));
    await term.press(...'chris', KEYS.enter);
    await until(() => expect(screen(term).at(-1)).toBe('>'));

    expect(answers).toEqual(['chris']);
    // the next line is read by the REPL and not by what was asked
    await term.press(...'next', KEYS.enter);
    expect(ran).toEqual(['name', 'next']);
  });
});

describe('Ctrl-C and Ctrl-D', () => {
  it('should clear the line on Ctrl-C', async () => {
    const { term, ran } = await start();
    await term.press(...'half typed');

    await term.press(CTRL_C);

    expect(screen(term)).toEqual(['>']);
    expect(ran).toEqual([]);
  });

  it('should say how to leave on Ctrl-C at an empty line, and leave on the second', async () => {
    const { term, done, ran } = await start();

    await term.press(CTRL_C);
    expect(screen(term)).toEqual(['>', '(To exit, press Ctrl+C again or Ctrl+D)']);

    await term.press(CTRL_C);
    await done;
    expect(ran).toEqual([]);
  });

  it('should not count a Ctrl-C that cleared a line towards leaving', async () => {
    const { term } = await start();
    await term.press('x', CTRL_C);

    await term.press(CTRL_C);

    expect(screen(term)).toEqual(['>', '(To exit, press Ctrl+C again or Ctrl+D)']);
  });

  it('should forget the first Ctrl-C when anything else is pressed', async () => {
    const { term } = await start();
    await term.press(CTRL_C, 'a', CTRL_C);

    // the second cleared a line, so it neither left nor armed
    expect(screen(term)).toEqual(['>']);
    await term.press(CTRL_C);
    expect(screen(term)).toEqual(['>', '(To exit, press Ctrl+C again or Ctrl+D)']);
  });

  it('should leave on Ctrl-D at an empty line', async () => {
    const { term, done } = await start();

    await term.press(CTRL_D);
    await done;

    expect(screen(term)).toEqual([]);
  });

  it('should delete under the caret on Ctrl-D in a line that has text', async () => {
    const { term } = await start();

    await term.press('a', 'b', 'c', KEYS.left, KEYS.left, CTRL_D);

    expect(screen(term)).toEqual(['> ac']);
  });

  it('should end the session when the input ends', async () => {
    const { term, done } = await start();

    term.stdin.end();

    await done;
  });
});

describe('a line that is not finished', () => {
  it('should ask for another when isContinued says so, and submit them as one', async () => {
    const { term, ran } = await start({ isContinued: (line) => !line.endsWith('}') });

    await term.press(...'if (x) {', KEYS.enter);
    await until(() => expect(screen(term)).toEqual(['> if (x) {', '...']));
    await term.press(...'  go()', KEYS.enter);
    await term.press('}');
    await term.press(KEYS.enter);

    expect(ran).toEqual(['if (x) {\n  go()\n}']);
  });

  it('should be handed the whole text so far', async () => {
    const seen: string[] = [];
    const { term } = await start({
      isContinued: (line) => {
        seen.push(line);
        return line === 'a' || line === 'a\nb';
      },
    });

    await term.press('a', KEYS.enter);
    await tick();
    await term.press('b', KEYS.enter);
    await tick();
    await term.press('c', KEYS.enter);
    await tick();

    expect(seen).toEqual(['a', 'a\nb', 'a\nb\nc']);
  });

  it('should take an async callback', async () => {
    const { term, ran } = await start({ isContinued: async (line) => line === 'open' });

    await term.press(...'open', KEYS.enter);
    await tick();
    await term.press(...'close', KEYS.enter);
    await tick();

    expect(ran).toEqual(['open\nclose']);
  });

  it('should drop the lines held on Ctrl-C', async () => {
    const { term, ran } = await start({ isContinued: (line) => line === 'open' });
    await term.press(...'open', KEYS.enter);
    await tick();

    await term.press(CTRL_C);

    expect(screen(term)).toEqual(['>']);
    await term.press(...'x', KEYS.enter);
    expect(ran).toEqual(['x']);
  });

  it('should record the whole thing as one history entry, and bring it back as rows', async () => {
    const { term, ran } = await start({ isContinued: (line) => line.endsWith('\\') });
    await term.press(...'a \\', KEYS.enter);
    await tick();
    await term.press('b', KEYS.enter);
    await tick();

    await term.press(KEYS.up);

    expect(screen(term).slice(-2)).toEqual(['> a \\', '... b']);
    expect(ran).toEqual(['a \\\nb']);
  });

  it('should leave every row of the line in the scrollback, with the prompt of each', async () => {
    const { term } = await start({ isContinued: (line) => line.endsWith('\\') });

    await term.press(...'first \\', KEYS.enter);
    await tick();
    await term.press(...'second', KEYS.enter);
    await tick();

    expect(screen(term)).toEqual(['> first \\', '... second', '>']);
  });

  it('should submit a line whose callback throws rather than trap the user in it', async () => {
    const { term, ran } = await start({
      isContinued: () => {
        throw new Error('parser fell over');
      },
    });

    await term.press(...'go', KEYS.enter);
    await tick();

    expect(ran).toEqual(['go']);
  });
});

describe('where nobody is typing', () => {
  /** A terminal whose stdin is a pipe. */
  function piped(): TestTerminal {
    return createTestTerminal({ columns: 40, inputTTY: false, rows: 8 });
  }

  it('should run each line of a pipe and end when it ends', async () => {
    const term = piped();
    const ran: string[] = [];
    const done = repl({ onSubmit: (line) => void ran.push(line), terminal: term.terminal });

    term.stdin.end('deploy prod\nstatus\n');
    await done;

    expect(ran).toEqual(['deploy prod', 'status']);
    // no prompt, no editing and no footer: only what the commands wrote
    expect(term.output).toBe('');
  });

  it('should run a last line that has no newline, and skip blank ones', async () => {
    const term = piped();
    const ran: string[] = [];
    const done = repl({ onSubmit: (line) => void ran.push(line), terminal: term.terminal });

    term.stdin.end('one\n\n   \ntwo');
    await done;

    expect(ran).toEqual(['one', 'two']);
  });

  it('should read a CRLF as one line break', async () => {
    const term = piped();
    const ran: string[] = [];
    const done = repl({ onSubmit: (line) => void ran.push(line), terminal: term.terminal });

    term.stdin.end('one\r\ntwo\r\n');
    await done;

    expect(ran).toEqual(['one', 'two']);
  });

  it('should wait for a command before it reads the next, and lose no line while it waits', async () => {
    const term = piped();
    const gate = deferred<void>();
    const ran: string[] = [];
    const done = repl({
      onSubmit: async (line) => {
        ran.push(line);
        if (line === 'slow') {
          await gate.promise;
        }
      },
      terminal: term.terminal,
    });

    term.stdin.end('slow\nafter\nlast\n');
    await tick(3);
    expect(ran).toEqual(['slow']);

    gate.resolve();
    await done;

    expect(ran).toEqual(['slow', 'after', 'last']);
  });

  it('should honour exit() and stop reading', async () => {
    const term = piped();
    const ran: string[] = [];
    const done = repl({
      onSubmit: (line, { exit }) => {
        ran.push(line);
        if (line === 'quit') {
          exit();
        }
      },
      terminal: term.terminal,
    });

    term.stdin.end('a\nquit\nnever\n');
    await done;

    expect(ran).toEqual(['a', 'quit']);
  });

  it('should join lines with isContinued here too', async () => {
    const term = piped();
    const ran: string[] = [];
    const done = repl({
      isContinued: (line) => line.endsWith('\\'),
      onSubmit: (line) => void ran.push(line),
      terminal: term.terminal,
    });

    term.stdin.end('a \\\nb\nc\n');
    await done;

    expect(ran).toEqual(['a \\\nb', 'c']);
  });

  it('should keep going after a command throws', async () => {
    const term = piped();
    const ran: string[] = [];
    const written: string[] = [];
    term.terminal.writeErr = (chunk: string) => void written.push(chunk) as never;
    const done = repl({
      onSubmit: (line) => {
        if (line === 'bad') {
          throw new Error('nope');
        }
        ran.push(line);
      },
      terminal: term.terminal,
    });

    term.stdin.end('bad\ngood\n');
    await done;

    expect(ran).toEqual(['good']);
    expect(written.join('')).toContain('nope');
  });

  it('should keep no history, since nobody is there to walk it', async () => {
    const term = piped();
    const historyFile = join(tempDir('sigil-repl-pipe-'), 'history');
    const done = repl({ historyFile, onSubmit: () => {}, terminal: term.terminal });

    term.stdin.end('secret\n');
    await done;

    expect(createHistory({ file: historyFile }).entries).toEqual([]);
  });

  it('should read lines when accessible is asked for, on a terminal', async () => {
    const term = createTestTerminal({ columns: 40, rows: 8 });
    const ran: string[] = [];
    const done = repl({
      accessible: true,
      onSubmit: (line) => void ran.push(line),
      terminal: term.terminal,
    });
    await tick();

    term.stdin.write('hello\n');
    await tick(3);
    term.stdin.end();
    await done;

    expect(ran).toEqual(['hello']);
    // somebody is typing, so the prompt is written once and never redrawn
    expect(term.output).toContain('> ');
  });
});

describe('Repl() in a layout', () => {
  /** A column holding the REPL under some output of the app's own, with a router over it. */
  function layout(props: Partial<Parameters<typeof Repl>[0]> = {}) {
    const term = createTestTerminal({ columns: 40, rows: 12 });
    const submitted: string[] = [];
    const element = Repl({
      onSubmit: (line) => void submitted.push(line),
      ...props,
    });
    const root = box({ 'flex-direction': 'column', height: 12, width: 40 }, element);
    const input = createInput({ root, terminal: term.terminal });
    input.focus.focus(element);
    const picture = (): string[] =>
      renderToLines(root, { cascade: themedCascade(), colorLevel: 0, width: 40 }).map((line) =>
        line.trimEnd()
      );
    return { element, input, picture, submitted, term };
  }

  /** Lets a key act, and the effect that draws its consequence run. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    flush();
  }

  it('should be the same editor: type, complete, submit', async () => {
    const { input, picture, submitted, term } = layout({ completer: wordCompleter(WORDS) });

    await term.press(...'de');
    await settle();
    expect(picture().filter((row) => row !== '')).toEqual(['> deploy', '  deploy', '  destroy']);

    await term.press(KEYS.tab);
    await settle();
    expect(picture().filter((row) => row !== '')).toEqual(['> deploy']);

    await term.press(KEYS.enter);
    await settle();

    expect(submitted).toEqual(['deploy']);
    // the line is cleared for the next, which is the app's to place the output of
    expect(picture().filter((row) => row !== '')).toEqual(['>']);
    input.stop();
  });

  it('should leave Ctrl-D and a second Ctrl-C to the app unless it gave onExit', async () => {
    const { input, term } = layout();
    const reached: string[] = [];
    input.bind((event) => void reached.push(event.key.name));

    await term.press(CTRL_D);

    expect(reached).toContain('d');
    input.stop();
  });

  it('should take them as its own, and say why, when it has an onExit', async () => {
    const exits: string[] = [];
    const { input, term } = layout({ onExit: (reason) => void exits.push(reason) });

    await term.press(CTRL_D);
    await term.press(CTRL_C, CTRL_C);

    expect(exits).toEqual(['eof', 'interrupt']);
    input.stop();
  });

  it('should take its line from a State, and let the app write it', async () => {
    const line = new State('seed');
    const { picture, term } = layout({ value: line });
    await settle();
    expect(picture()[0]).toBe('> seed');

    await term.press('!');
    expect(line.get()).toBe('seed!');

    line.set('replaced');
    await settle();
    expect(picture()[0]).toBe('> replaced');
  });

  it('should follow a signal the footer reads', async () => {
    const mode = new State('plain');
    const { picture } = layout({ footer: (line) => `${mode.get()}: ${line}` });
    await settle();
    expect(picture().filter(Boolean)).toEqual(['>', 'plain:']);

    mode.set('shouting');
    await settle();

    expect(picture().filter(Boolean)).toEqual(['>', 'shouting:']);
  });

  it('should hold keys while an async command runs, then take them again', async () => {
    const gate = deferred<void>();
    const { term, picture, submitted } = layout({
      onSubmit: async (line) => {
        submitted.push(line);
        await gate.promise;
      },
    });

    await term.press('a', KEYS.enter);
    await term.press('b');
    expect(picture().filter(Boolean)).toEqual(['>']);

    gate.resolve();
    await settle();
    await settle();
    await term.press('c');

    expect(picture().filter(Boolean)).toEqual(['> c']);
  });

  it('should never draw an answer to a line that has since changed', async () => {
    const asked: Array<(range: AutocompleteRange) => void> = [];
    const { picture, term } = layout({
      completer: () => {
        const answer = deferred<AutocompleteRange>();
        asked.push(answer.resolve);
        return answer.promise;
      },
    });

    await term.press('d', 'e');
    // the answer to 'd' lands after the edit. The tree is read at once rather than
    // after a frame, so that what is asserted is what the answer *did*
    asked[0]?.({ from: 0, items: ['dZZ-stale'], to: 1 });
    await settle();
    expect(picture().filter(Boolean)).toEqual(['> de']);

    asked[1]?.({ from: 0, items: ['deploy'], to: 2 });
    await settle();
    expect(picture().filter(Boolean)).toEqual(['> deploy', '  deploy']);
  });

  it('should draw the typed part plain and the suggestion dim, caret on its first letter', async () => {
    const {
      picture: _picture,
      element,
      input,
      term,
    } = layout({ completer: wordCompleter(['status']) });
    const root = element.parent as Element;

    await term.press('s', 't', 'a');
    await settle();
    const drawn = renderToString(root, { cascade: themedCascade(), colorLevel: 1, width: 40 });

    // `sta` as the terminal's own style, then the dim and inverse caret on `t`, and
    // the dim rest of the word after it
    expect(drawn).toContain(`${ESC}[39msta${ESC}[2;7mt${ESC}[27mus`);
    input.stop();
  });

  it('should refuse a bad prop where it is built', () => {
    expect(() => Repl({ onSubmit: 'no' as never })).toThrow(TypeError);
    expect(() => Repl({ maxItems: 0, onSubmit: () => {} })).toThrow(TypeError);
    expect(() => Repl({ onSubmit: () => {}, value: 3 as never })).toThrow(TypeError);
    expect(() => Repl({ onSubmit: () => {}, width: -1 })).toThrow(TypeError);
  });

  it('should be told apart from its controller: settle() freezes it', async () => {
    const controller = createRepl({ onSubmit: () => {}, value: 'kept' });

    controller.settle();

    expect(controller.line.get()).toBe('kept');
    expect(controller.element.focusable).toBe(false);
  });
});

describe('wordCompleter()', () => {
  it('should rank by the word at the caret and name the range that word is', () => {
    const answer = wordCompleter(['deploy', 'destroy', 'status'])(
      'run de',
      6,
      new AbortController().signal
    );

    expect(answer).toMatchObject({ from: 4, to: 6 });
    expect(
      (answer as AutocompleteRange).items.map((item) =>
        typeof item === 'string' ? item : item.label
      )
    ).toEqual(['deploy', 'destroy']);
  });

  it('should replace through the end of the word the caret is inside', () => {
    const answer = wordCompleter(['deploy'])('de now', 2, new AbortController().signal);

    expect(answer).toMatchObject({ from: 0, to: 2 });
  });

  it('should offer every word where the caret follows a space', () => {
    const answer = wordCompleter(['a', 'b'])(
      'x ',
      2,
      new AbortController().signal
    ) as AutocompleteRange;

    expect(answer.items).toHaveLength(2);
    expect(answer).toMatchObject({ from: 2, to: 2 });
  });
});
