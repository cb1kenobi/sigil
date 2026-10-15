import { type Ansi, createAnsi } from '../ansi/index.js';
import {
  createTerminal,
  type InputStream,
  type OutputStream,
  type Terminal,
} from '../terminal/index.js';
import { Screen, screenStream } from './screen.js';
import { PassThrough } from 'node:stream';

/**
 * A terminal a test can drive: a screen to read, and a way to press keys.
 *
 * ## Why a prompt needs this and not a pty
 *
 * Node has no pty and this package has no dependency to add one. What a prompt
 * actually reads about its terminal is `isTTY` on both ends -- `run()` rejects
 * outright when either is not one, which is `PromptError`'s whole purpose -- and
 * what it reads *from* it is bytes on an `InputStream`. Both of those are
 * satisfiable by objects, so a prompt is drivable in-process with no pty, no
 * child and no real clock, and `press()` is how.
 *
 * ## Why the frames are replayed rather than read
 *
 * A component draws through a canvas, and a canvas frame is a **diff against
 * the frame before it** -- so the last thing written is a handful of changed
 * cells with cursor movements between them, and asserting on it says nothing
 * about what is on screen. The bytes are replayed against `Screen` instead,
 * which answers the question a test means: after these frames, what is the user
 * looking at.
 *
 * ## The two details nobody guesses
 *
 * `proc` is a stub rather than `process`. A terminal installs `exit` and signal
 * handlers and puts an `EPIPE` guard on each stream it writes to, and a suite
 * builds a great many terminals -- which is how `live.test.ts` came to leave
 * eleven listeners on the *real* `process.stderr` and trip node's leak warning
 * over streams those tests never meant to touch.
 *
 * `ansi` is level 0 by default, so what a test reads is the text rather than the
 * styling. `Screen` keeps characters and not colour, bar the one attribute
 * something on screen is made of rather than merely wearing -- see
 * `Screen.lastInverse` -- so a claim about *colour* belongs in a run on
 * `runOnTerminal()`, where a real styler writes real sequences a test can read.
 */

/** A `data` listener's stream, as a real `PassThrough` rather than something shaped like one. */
export interface TestInput extends PassThrough {
  isTTY: boolean;
  /** Whether raw mode is on, so a test can assert who put it back. */
  rawMode: boolean;
  setRawMode(mode: boolean): TestInput;
}

/** A terminal, a screen, and the keyboard. */
export interface TestTerminal {
  /** A styler, at `level` -- 0 by default, so a frame reads as text. */
  readonly ansi: Ansi;
  /**
   * Everything the main buffer has held, trailing blank rows dropped.
   *
   * The **main** buffer, which is what is on screen until something switches to
   * the alternate one -- after that, `viewport` is what is showing and this is
   * the log behind it. Which is the distinction a full-screen app makes and the
   * reason both are here.
   *
   * This is the one to reach for. There is deliberately no `frame`: the
   * harness this grew out of had one meaning "the last row anything was drawn
   * on", which is the whole of a one-line component and is a trap for anything
   * taller -- `frame` on a three-row list answers its last row. `lines.at(-1)`
   * is that, spelled so nobody misreads it.
   */
  readonly lines: string[];
  /** Every byte written, for the few claims that really are bytes. */
  readonly output: string;
  /**
   * Sends a bracketed paste, which is not the same as typing the text.
   *
   * A terminal brackets a paste so that an application can tell content from
   * keystrokes, and the prompts read the markers: a newline inside a paste is
   * part of the value where a typed Enter submits. A test that wrote the text
   * bare would be testing the other thing.
   *
   * @param text - What was pasted.
   * @returns Settled, so the next assertion sees the frame it caused.
   */
  paste(text: string): Promise<void>;
  /**
   * Sends each argument as one read, letting what is listening act on it.
   *
   * One argument is one chunk, which is the distinction that matters: a
   * terminal delivers a keystroke as its own read and a paste as one read
   * holding many characters, and a prompt treats them differently. So
   * `press(KEYS.up, KEYS.enter)` is two keystrokes and `press('chris')` is one
   * read of five characters.
   *
   * The one key this cannot settle is a lone `KEYS.escape`: there is no byte
   * that tells Escape from the start of an Alt chord, so the router *holds* it
   * for `ESCAPE_TIMEOUT` and no number of turns of the event loop will make it
   * a key. Advance the clock, or press something after it -- see `alt()`.
   *
   * @param chunks - The reads, in order.
   * @returns Settled, so the next assertion sees the frames they caused.
   */
  press(...chunks: string[]): Promise<void>;
  /** Resizes the screen and tells the terminal, as a window change does. */
  resize(width: number, height: number): void;
  /** The screen model, for the viewport, the cursor and the clipboard. */
  readonly screen: Screen;
  /** Stdin, for anything `press()` does not cover. */
  readonly stdin: TestInput;
  /** The terminal to hand a component. */
  readonly terminal: Terminal;
  /** The viewport row by row, blank rows included. */
  readonly viewport: string[];
}

/** How to build one. */
export interface TestTerminalOptions {
  /**
   * The colour level the styler reports. Defaults to 0.
   *
   * Raising it changes what a component *writes* and not what `Screen` can be
   * asked: the model keeps characters. It is here for a test that reads
   * `output` for a sequence.
   */
  readonly colorLevel?: 0 | 1 | 2 | 3;
  /** Columns. Defaults to 40, which is narrow enough to see wrapping. */
  readonly columns?: number;
  /** The environment the terminal detects from. Defaults to none at all. */
  readonly env?: Record<string, string | undefined>;
  /** Whether stdin claims to be a terminal. Defaults to `isTTY`. */
  readonly inputTTY?: boolean;
  /** Whether the output claims to be a terminal. Defaults to `true`. */
  readonly isTTY?: boolean;
  /** Rows. Defaults to 8. */
  readonly rows?: number;
}

/**
 * The escape, built rather than written as a literal.
 *
 * A raw control character in source is invisible in an editor and in a diff,
 * which is the rule `src/ansi/codes.ts` is written under -- and it is declared
 * above the table that reads it, because a `const` further down the file is in
 * its temporal dead zone when the table is built.
 */
const ESC = String.fromCharCode(0x1b);

/** The keys `KEYS` names, as a union so that a misspelling is a type error. */
export type TestKeyName =
  | 'backspace'
  | 'delete'
  | 'down'
  | 'end'
  | 'enter'
  | 'escape'
  | 'home'
  | 'left'
  | 'pageDown'
  | 'pageUp'
  | 'right'
  | 'shiftTab'
  | 'space'
  | 'tab'
  | 'up';

/**
 * The keys a terminal sends, by name.
 *
 * Written down because the bytes are not guessable and getting one wrong is a
 * test that passes while pressing nothing: an unrecognised CSI decodes to a key
 * whose name is its own sequence, and a prompt types nothing for it. The names
 * are a union rather than a `Record<string, string>` for the same reason --
 * `KEYS.pagedown` would otherwise be `undefined`, and pressing `undefined` is a
 * read of the word.
 *
 * Frozen, because it is exported and a caller that wrote to it would change what
 * every test in the process presses.
 *
 * `shiftTab` is the one shifted key here, and that is not an omission: the
 * legacy encoding has no spelling for shift with a plain character -- Shift-A
 * arrives as `A` with no flag -- so there is nothing for the others to be.
 */
export const KEYS: { readonly [K in TestKeyName]: string } = Object.freeze({
  backspace: '\u007f',
  delete: `${ESC}[3~`,
  down: `${ESC}[B`,
  end: `${ESC}[F`,
  enter: '\r',
  escape: ESC,
  home: `${ESC}[H`,
  left: `${ESC}[D`,
  pageDown: `${ESC}[6~`,
  pageUp: `${ESC}[5~`,
  right: `${ESC}[C`,
  shiftTab: `${ESC}[Z`,
  space: ' ',
  tab: '\t',
  up: `${ESC}[A`,
});

/**
 * A letter held with Ctrl, as a terminal sends it.
 *
 * `Ctrl-A` is byte 1 and the alphabet runs from there, which is why this is
 * arithmetic rather than a table: the sixteen a prompt reads are no more
 * special than the ten it does not.
 *
 * @param letter - One ASCII letter, in either case.
 * @returns The byte the terminal sends.
 * @throws If it is not a letter, because there is no byte to send.
 */
export function ctrl(letter: string): string {
  // the type is asked about before the string is, or `ctrl(undefined)` throws a
  // `TypeError` out of `toLowerCase()` rather than the error this documents --
  // and a test file is untyped JavaScript as often as not. Found by review
  if (typeof letter !== 'string' || letter.length !== 1) {
    throw new Error(`ctrl() takes one ASCII letter, not ${JSON.stringify(letter)}`);
  }
  const code = letter.toLowerCase().codePointAt(0) ?? 0;
  if (code < 0x61 || code > 0x7a) {
    throw new Error(`ctrl() takes one ASCII letter, not ${JSON.stringify(letter)}`);
  }
  return String.fromCharCode(code - 0x60);
}

/**
 * A key held with Alt, which a terminal sends as `ESC` and then the key.
 *
 * Which is why a lone Escape costs `ESCAPE_TIMEOUT` before it is a key: there is
 * no byte that distinguishes the two, so the router waits to find out whether
 * something follows. A test pressing `KEYS.escape` has to let that timer fire,
 * and `press()` does not -- advance the clock, or press something after it.
 *
 * @param key - The key held, as a character or one of `KEYS`.
 * @returns The bytes.
 */
export function alt(key: string): string {
  // refused rather than interpolated, because `alt(undefined)` is `ESC` and then
  // the **word** `undefined`, which a prompt types in a character at a time --
  // an assertion failing on `nundefined` names nothing. Found by review
  if (typeof key !== 'string' || key === '') {
    throw new Error(`alt() takes a key to hold it with, not ${JSON.stringify(key)}`);
  }
  return `${ESC}${key}`;
}

/**
 * Lets pending work settle, so what was sent has been acted on.
 *
 * `setImmediate` rather than a chain of resolved promises, and the difference is
 * observable rather than belt-and-braces. The stream here is a `PassThrough`,
 * which emits `data` synchronously from `write()`, so the keys *have* arrived --
 * what has not finished is everything downstream of them. A prompt queues each
 * key through a promise chain and a `validate` may be async, so a fixed number
 * of microtask turns stops part way through: measured, an `await
 * Promise.resolve()` twice leaves the validator's message off the screen where a
 * `setImmediate`, which drains every pending microtask before it runs, puts it
 * there. It is also what `helpers.ts` already uses, and two spellings of one
 * idea is how the two come to disagree.
 *
 * @param times - How many turns to take.
 * @returns Settled.
 */
export async function tick(times = 2): Promise<void> {
  // `tick(Infinity)` is a loop with no end in a helper a test awaits, and
  // `tick(0)`, `tick(NaN)` and `tick(-1)` each settle **nothing** while looking
  // like they settled something -- which is worse, because the assertion after
  // one of those fails for a reason nobody would guess. A count that is not a
  // whole number of at least one turn is not an instruction, so the default
  // stands, which is the rule every other option here follows. Found by review
  const turns = Number.isSafeInteger(times) && times >= 1 ? times : 2;

  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Builds a terminal over a screen model, with a keyboard.
 *
 * @param opts - The size, the colour level, and whether either end is a terminal.
 * @returns The fixture.
 */
export function createTestTerminal(opts: TestTerminalOptions = {}): TestTerminal {
  // `=== undefined` rather than `??`, because `null` is exactly the value the
  // guard is for: `opts.columns ?? 40` silently used 40 for it. The same shape
  // `runOnTerminal()` had. Found by review
  const screen = new Screen(
    opts.columns === undefined ? 40 : opts.columns,
    opts.rows === undefined ? 8 : opts.rows
  );
  const stream = screenStream(screen);
  const written: string[] = [];
  const paint = stream.write.bind(stream);
  stream.write = (chunk: string): boolean => {
    written.push(chunk);
    return paint(chunk);
  };

  const stdin = new PassThrough() as TestInput;
  stdin.isTTY = opts.inputTTY ?? opts.isTTY ?? true;
  stdin.rawMode = false;
  stdin.setRawMode = (mode: boolean): TestInput => {
    stdin.rawMode = mode;
    return stdin;
  };

  // a stub rather than `process`: see the note at the top of this file
  const proc = {
    listenerCount: (): number => 0,
    on: (): void => {},
    removeListener: (): void => {},
  };

  const terminal = createTerminal({
    env: opts.env ?? {},
    isTTY: opts.isTTY ?? true,
    proc,
    // the one stream stands in for both, so that whatever a terminal attaches
    // to its streams lands here rather than on the real process's
    stderr: stream as unknown as OutputStream,
    stdin: stdin as unknown as InputStream,
    stdout: stream as unknown as OutputStream,
  });

  return {
    ansi: createAnsi({ level: opts.colorLevel ?? 0 }),

    get lines(): string[] {
      return screen.written;
    },

    get output(): string {
      return written.join('');
    },

    async paste(text: string): Promise<void> {
      // refused rather than interpolated, for `alt()`'s reason: a
      // `paste(undefined)` pastes the word. Found by review
      if (typeof text !== 'string') {
        throw new Error(`paste() takes the text that was pasted, not ${JSON.stringify(text)}`);
      }
      // the markers the router reads. A paste that arrives in one read is the
      // realistic shape and is also the one that cannot be mistaken for typing
      stdin.write(`${ESC}[200~${text}${ESC}[201~`);
      await tick();
    },

    async press(...chunks: string[]): Promise<void> {
      // `paste()`'s rule, for uniformity: a `PassThrough` throws its own
      // `ERR_INVALID_ARG_TYPE` for a non-string, which is loud by accident
      // rather than by design, and an API where one of the two methods names
      // the mistake is worse than one where both do
      for (const chunk of chunks) {
        if (typeof chunk !== 'string') {
          throw new Error(`press() takes the reads to send, not ${JSON.stringify(chunk)}`);
        }
      }
      // one write per argument, which is what "one argument is one read" means
      // -- and it is a statement about what this does rather than a claim
      // about what it buys: joining them changes no answer for any prompt
      // here, because the router joins a held tail with the next read and
      // serialises the keys of one chunk through the same queue. `paste()` is
      // the distinction that *is* observable. The `tick()` is not inert: it is
      // what makes the method's promise true, and an async `validate` is the
      // input that shows it
      for (const chunk of chunks) {
        stdin.write(chunk);
        await tick();
      }
    },

    resize(width: number, height: number): void {
      stream.resize(width, height);
    },

    screen,
    stdin,
    terminal,

    get viewport(): string[] {
      return screen.viewport;
    },
  };
}
