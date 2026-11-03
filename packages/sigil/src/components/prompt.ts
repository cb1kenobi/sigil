import { cellWidth } from '../canvas/index.js';
import {
  box,
  cellStyle,
  type Element,
  raw,
  text as textNode,
  toDisplayText,
} from '../element/index.js';
import { __, __n, confirmKeys } from '../i18n/index.js';
import {
  type BindingHelp,
  type BindingInfo,
  createInput,
  formatKey,
  type InputRouter,
  type InputStream,
  type Key,
  type KeyPattern,
  parseKeys,
} from '../input/index.js';
import { isAbort } from '../input/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { graphemes, stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';
import {
  boundary,
  deleteAfter,
  deleteBefore,
  deleteRange,
  insertAt,
  isSpaceCluster,
  pastedBlock,
  pastedLine,
  snap,
  typedText,
  wordAfter,
  wordBefore,
} from './editing.js';
import { keyHelp, type KeyHelpSource, keyLabel } from './key-help.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';

export { ESCAPE_TIMEOUT } from '../input/index.js';

/**
 * Thrown when a prompt cannot be answered, rather than returning a value that
 * looks like an answer.
 *
 * The two ways that happens are different in kind and both matter:
 * `aborted` is somebody pressing Ctrl-C, and not aborted is a prompt reached
 * where there is nobody to ask -- a pipeline, a CI job, a `cron` entry. The
 * second is the one worth failing loudly for: a prompt that waits forever on a
 * stdin that will never produce a keystroke is a hung build with no explanation.
 */
export class PromptError extends Error {
  /** `true` when the person pressed Ctrl-C or Ctrl-D. */
  aborted: boolean;

  constructor(message: string, aborted = false) {
    super(message);
    this.name = 'PromptError';
    this.aborted = aborted;
  }
}

/**
 * Thrown when a prompt asked with `back` is left with Escape, to go back a step.
 *
 * Not a {@link PromptError}, because it is neither of the two things that is: the
 * person has not left and the program is not wired wrong. They asked to see the
 * question before this one again, which is a request to whatever is asking the
 * questions -- `group()`, or an app's own loop -- and a `catch` that reads every
 * `PromptError` as "give up" must not read it as that.
 *
 * Only a prompt given `back: true` throws one, so code that never asks for it never
 * sees one.
 */
export class PromptBack extends Error {
  constructor(message: string = __`Went back`) {
    super(message);
    this.name = 'PromptBack';
  }
}

/** A choice offered by `select()` and `multiselect()`. */
export interface Choice<T = unknown> {
  /**
   * A longer line about the choice, shown under the list while it is the
   * highlighted one. For what does not fit in a `hint` beside the label.
   */
  description?: string;
  /**
   * Whether the choice is on offer. A string is the reason, shown where a hint
   * would be. The cursor skips a disabled choice, `multiselect()`'s select-all
   * leaves it alone, and it is never ticked -- `selected` included.
   */
  disabled?: boolean | string;
  /** Shown after the label, dimmed. */
  hint?: string;
  /** What is shown. */
  label: string;
  /** Whether `multiselect()` starts with it ticked. */
  selected?: boolean;
  /** What is shown once answered, when it should be shorter than the label. */
  short?: string;
  /** What is returned. The label, if omitted. */
  value?: T;
}

/**
 * A line in a choice list that is not a choice: a heading, or a rule between
 * groups. The cursor never lands on one.
 */
export interface Separator {
  /** What it says. */
  readonly separator: string;
}

/** What a choice list is made of. */
export type ChoiceEntry<T = unknown> = Choice<T> | Separator | string;

/**
 * Builds a {@link Separator}.
 *
 * @param label - The heading. A short rule if omitted.
 * @returns The entry to put between choices.
 */
export function separator(label = '────────'): Separator {
  return Object.freeze({ separator: label });
}

export interface PromptOptions extends MountOptions {
  /**
   * Whether Escape leaves the prompt to go back a step. Defaults to `false`, where
   * Escape does nothing, as it always has.
   *
   * Given, Escape rejects with a {@link PromptBack} and takes the prompt off the
   * screen, the way Ctrl-C does with a `PromptError`. It is what `group()` hands
   * every step after its first, and it is checked before the prompt's own keys, so
   * no prompt can take Escape back from it. A prompt that draws a key-help footer
   * lists it there.
   */
  back?: boolean;
  /** What is being asked. */
  message: string;
  /**
   * The input router to read keys through. One is built if not given.
   *
   * An app that already owns a router -- a full-screen one, which had to build
   * one to have a focus ring at all -- hands it over here, and the prompt binds
   * to it rather than taking stdin out from under it. That is what makes "one
   * thing owns stdin" true in an app that prompts: a prompt that builds its own
   * is only correct because nothing else is reading at the time, which is the
   * ordinary case and is not every case.
   *
   * A router handed in is not stopped when the prompt is answered. The prompt
   * removes the handlers it added and nothing else, because the router is not
   * its to give back.
   */
  router?: InputRouter;
  /** Where keys come from. Defaults to the terminal's input. */
  stdin?: InputStream;
  /**
   * Gives the prompt up when this aborts, the way Ctrl-C does.
   *
   * The prompt rejects with the signal's own `reason` -- not a `PromptError` --
   * so `AbortSignal.timeout(10_000)` rejects with the `TimeoutError` it always
   * does and a caller tells a timeout from an abort by the name it already knows.
   * The screen, the cursor and stdin are given back exactly as they are on a
   * cancel. A signal that is already aborted rejects before anything is drawn.
   *
   * A timeout with a default is `AbortSignal.timeout()` and a `catch`; there is no
   * `timeout` option, because the signal is the whole of it.
   */
  signal?: AbortSignal;
}

/**
 * The one option that turns a prompt into lines, on the prompts that have a line
 * form: `text()`, `password()`, `multiline()`, `confirm()`, `select()` and
 * `multiselect()` here, and every prompt in a module of its own but
 * `commandPalette()` and `editor()`, which are drawn whatever the mode.
 */
export interface AccessibleOptions {
  /**
   * Asks with plain lines in and lines out rather than a region that redraws,
   * for a screen reader: the question is written once, what is typed is echoed
   * where it is typed, and nothing already written is ever moved or erased.
   *
   * Unset, `SIGIL_ACCESSIBLE` decides, and unset there too it is off. It is never
   * inferred -- see {@link forcedAccessible} -- and it does not lift the rule that
   * a prompt needs a terminal at both ends: a line form over a pipe would read
   * whatever the pipe carries as the answers.
   */
  accessible?: boolean;
}

export interface TextOptions extends PromptOptions, AccessibleOptions {
  /** Used when the answer is empty. */
  default?: string;
  /** Shown in place of what is typed, for a password. */
  mask?: string;
  /** Shown dimmed when nothing has been typed. */
  placeholder?: string;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept.
   */
  validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
  /**
   * An answer to start from: the field opens holding it, editable, with the caret
   * at its end. Unlike `default`, it is not a fallback -- emptying the field and
   * pressing Enter answers with `default`, not with this.
   */
  value?: string;
}

export interface ConfirmOptions extends PromptOptions, AccessibleOptions {
  /** What Enter alone means. Defaults to `true`. */
  default?: boolean;
  /** An answer to start from, which is what Enter alone means. Beats `default`. */
  value?: boolean;
}

export interface SelectOptions<T> extends PromptOptions, AccessibleOptions {
  /** What to offer. */
  choices: readonly ChoiceEntry<T>[];
  /**
   * Which one starts highlighted, by index into `choices`. Defaults to 0. A
   * separator or a disabled choice is passed over for the next one on offer.
   */
  initial?: number;
  /**
   * Whether the cursor wraps from one end of the list to the other. Defaults to
   * `true`; `false` stops it at the first and last choice on offer.
   */
  loop?: boolean;
  /**
   * An answer to start from: the choice whose `value` this is starts highlighted,
   * and beats `initial`. Compared the way a `Map` compares keys. A value no choice
   * on offer holds is dropped rather than refused, and `initial` decides instead.
   */
  value?: T;
}

export interface MultiselectOptions<T> extends Omit<SelectOptions<T>, 'value'> {
  /** Refuse more than this many. Unlimited if omitted. */
  max?: number;
  /** Refuse fewer than this many. Defaults to 0, or 1 when `required`. */
  min?: number;
  /** Refuse an empty selection. Defaults to `false`. Same as `min: 1`. */
  required?: boolean;
  /**
   * An answer to start from: exactly the choices on offer whose `value` is in it
   * start ticked, and every `selected` is ignored. Compared the way a `Map`
   * compares keys; a value no choice on offer holds is dropped. An empty array is
   * an answer of nothing, so nothing starts ticked.
   */
  value?: readonly T[];
}

/**
 * The glyphs the prompts draw, as one object rather than four literals.
 *
 * Frozen, because it is exported: a shared mutable object one caller can write
 * to is the trap every initial value in the property table is frozen against,
 * and a pointer that changed under `select()` because something else reached
 * for the same glyph is that trap with a frame on it.
 */
export interface PromptSymbols {
  /** The pointer on the active row of a list. */
  readonly cursor: string;
  /** An unticked box, for a multiselect. */
  readonly off: string;
  /** A ticked box. */
  readonly on: string;
  /** The mark in front of a question. */
  readonly question: string;
}

const SYMBOL: PromptSymbols = Object.freeze({
  cursor: '❯',
  off: '◯',
  on: '◉',
  question: '?',
});

/** One line of a choice list: something to pick, or something that only separates. */
type Item<T> =
  | { choice: Choice<T>; kind: 'choice'; offered: boolean }
  | { kind: 'separator'; label: string };

function isSeparator<T>(entry: ChoiceEntry<T>): entry is Separator {
  return typeof entry === 'object' && 'separator' in entry;
}

function toChoice<T>(choice: Choice<T> | string): Choice<T> {
  return typeof choice === 'string' ? { label: choice, value: choice as T } : choice;
}

function toItems<T>(entries: readonly ChoiceEntry<T>[]): Item<T>[] {
  return entries.map((entry): Item<T> => {
    if (isSeparator(entry)) {
      return { kind: 'separator', label: entry.separator };
    }
    const choice = toChoice(entry);
    return { choice, kind: 'choice', offered: !choice.disabled };
  });
}

function isOffered<T>(item: Item<T>): item is Extract<Item<T>, { kind: 'choice' }> {
  return item.kind === 'choice' && item.offered;
}

/**
 * The nearest choice on offer, going one way from a place in the list.
 *
 * A separator and a disabled choice are not on offer, so the cursor steps over
 * them rather than landing and refusing: a cursor you can put on a row that will
 * not take it reads as a key that did nothing. Wrapping is a parameter because
 * it is an option; the walk is at most one lap, so a list with nothing on offer
 * ends where it began rather than looping.
 *
 * @param items - The list.
 * @param from - Where the cursor is.
 * @param direction - `1` for down, `-1` for up.
 * @param loop - Whether the ends are joined.
 * @returns Where the cursor goes. `from` if nothing else is on offer that way.
 */
function seek<T>(
  items: readonly Item<T>[],
  from: number,
  direction: 1 | -1,
  loop: boolean
): number {
  for (let step = 1; step <= items.length; step++) {
    let at = from + direction * step;
    if (loop) {
      at = ((at % items.length) + items.length) % items.length;
    } else if (at < 0 || at >= items.length) {
      break;
    }
    if (isOffered(items[at])) {
      return at;
    }
  }
  return from;
}

/**
 * The first choice on offer at or after a place, wrapping, or `-1` if none is.
 *
 * @param items - The list.
 * @param from - Where to start looking.
 * @returns Its index.
 */
function firstOffered<T>(items: readonly Item<T>[], from: number): number {
  for (let step = 0; step < items.length; step++) {
    const at = (from + step) % items.length;
    if (isOffered(items[at])) {
      return at;
    }
  }
  return -1;
}

/**
 * The first or last choice on offer.
 *
 * @param items - The list.
 * @param direction - `1` for the first, `-1` for the last.
 * @returns Its index.
 */
function edge<T>(items: readonly Item<T>[], direction: 1 | -1): number {
  return direction === 1 ? firstOffered(items, 0) : seek(items, items.length, -1, false);
}

function valueOf<T>(choice: Choice<T>): T {
  return 'value' in choice ? (choice.value as T) : (choice.label as T);
}

/**
 * Whether two answers are one, the way a `Map` compares keys.
 *
 * Which is how a starting `value` finds the choice it names, in every prompt that
 * has choices, and how `autocompleteMultiselect()` already told one tick from
 * another: `NaN` is itself, `0` is `-0`, and an object is only ever itself -- so a
 * step that builds fresh choice objects every time it runs cannot have its answer
 * found again, and a value that is a string or a stable object can.
 *
 * @param a - One answer.
 * @param b - The other.
 * @returns Whether they are the same.
 */
function sameValue(a: unknown, b: unknown): boolean {
  // `Object.is()` for `NaN`, and `===` for the zeroes it tells apart
  return a === b || Object.is(a, b);
}

/** What a choice reads as once the question is answered. */
function shortOf<T>(choice: Choice<T>): string {
  return choice.short ?? choice.label;
}

/** What a prompt's tree and its key handling are, built together under an owner. */
interface Handlers<T> {
  /**
   * Whether this prompt wants a key `isAbort()` would otherwise take.
   *
   * Only Ctrl-D is ever reachable through this, and only the multiline field
   * asks: that is its submit key, and end of input and "that is my answer" are
   * the same gesture -- a field escaped by the key that submits it has no way
   * out. Ctrl-C is refused above, because an app that cannot be quit because a
   * field swallowed it is the failure the binding order exists to prevent.
   *
   * Absent for the other four prompts, so the abort path they take is the one
   * they always took.
   */
  claims?(k: Key): boolean;
  /** Handles a key. Returning `{ value }` finishes. */
  key(k: Key): Promise<{ value: T } | void> | ({ value: T } | void);
  /** Handles pasted text, when the prompt is one that can take a block of it. */
  paste?(text: string): void;
  /** Puts the tree into the form left behind once it is answered. */
  settle(value: T): void;
  /** The tree. */
  view: Element;
}

/**
 * Runs a prompt: a canvas, the one input router, and everything put back
 * whichever way it ends.
 *
 * What used to be here -- raw mode, a `data` listener, a decoder, a held tail
 * and the timer that expires it -- is the router's. What is left is the part that
 * is actually a prompt: a tree, what each key does, and a promise.
 *
 * A router of its own unless one was handed in, and the difference is who gives
 * stdin back: one built here is stopped when the prompt ends, and one handed in
 * is left running with only this prompt's handlers removed. Two prompts at once
 * over two routers would both read every key, which is why an app that has a
 * router passes it.
 *
 * @param opts - Where to read and draw.
 * @param make - Builds the tree and says what each key does. Runs under the
 *   renderer's owner, so the effects it creates are disposed with the prompt.
 * @returns The answer.
 */
function run<T>(opts: PromptOptions, make: () => Handlers<T>): Promise<T> {
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);

  // nobody is there to answer, and waiting on a stdin that will never produce a
  // keystroke is a hung build with no explanation. The message names the prompt,
  // because "no TTY" on its own does not say which question went unanswered
  if (!terminal.isTTY || !stdin?.isTTY) {
    return Promise.reject(
      new PromptError(__`Cannot prompt for "${opts.message}" because the input is not a terminal`)
    );
  }

  // asked after the terminal, so a prompt with nobody to answer it still says
  // that; and before anything is mounted, so an abort that came first draws nothing
  if (opts.signal?.aborted) {
    return Promise.reject(opts.signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    let handlers: Handlers<T>;
    let settled = false;
    let mounted: Mounted | undefined;
    let stopInput: (() => void) | undefined;
    let stopListening: (() => void) | undefined;

    /** Everything this prompt took, given back in the order it was taken. */
    function detach(): void {
      stopListening?.();
      stopListening = undefined;
      stopInput?.();
      stopInput = undefined;
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      detach();
      mounted?.stop();
      reject(error);
    }

    /**
     * Where a throw goes, which depends on whether there is still a prompt.
     *
     * Before it is answered, a throw is the answer: the promise rejects. After,
     * the caller already has what it asked for and a frame that failed on the
     * way out is not a reason to take it back -- so it goes to `onError` if the
     * caller wanted to hear about one, and nowhere if it did not.
     *
     * @param error - What was thrown.
     */
    function report(error: unknown): void {
      if (settled) {
        opts.onError?.(error);
        return;
      }
      fail(error);
    }

    function succeed(value: T): void {
      if (settled) {
        return;
      }
      settled = true;
      detach();

      // the answer is the answer whatever the last frame does, so resolving is
      // in a `finally`: a throw from `settle()` would otherwise be caught by
      // the queue, handed to a `fail()` that no-ops because this already set
      // `settled`, and leave the caller awaiting a prompt that is gone
      try {
        handlers.settle(value);
        // painted before the screen is given back, because `done()` leaves
        // what is on screen where it is, and that is still the question
        mounted?.frame();
      } catch (error) {
        report(error);
      } finally {
        mounted?.done();
        resolve(value);
      }
    }

    try {
      mounted = mountLive(
        () => {
          handlers = make();
          return handlers.view;
        },
        {
          ...opts,
          onError: report,
          // a prompt is a **dialogue**, not a progress report, so `--quiet` does
          // not reach it: a silenced one draws no question and then waits
          // forever for an answer to a question nobody was shown. That is the
          // line this axis is drawn along -- what a command says while working
          // is progress, and what it asks is not -- and it is drawn here, where
          // a built-in can state it, rather than left to every app to remember
          quiet: false,
          terminal,
        }
      );
    } catch (error) {
      fail(error);
      return;
    }

    // a throw from the *first frame* does not come back as a throw: the
    // renderer reports it through `onError`, which is `fail()`, and then hands
    // back a handle that has already given the screen up. Carrying on from here
    // built a router over a promise that was already rejected -- stdin left in
    // raw mode with a `data` listener nothing would ever remove, and the next
    // prompt fighting it for keys
    if (settled) {
      return;
    }

    let router: InputRouter;
    const ownRouter = opts.router === undefined;
    try {
      router = opts.router ?? createInput({ root: mounted.renderer.root, stdin, terminal });
    } catch (error) {
      // the frame is already on screen, so it has to come off: a router that
      // could not be built leaves a question nobody can answer, and leaving it
      // drawn is the hang this rejects instead of
      fail(error);
      return;
    }
    stopInput = ownRouter ? () => router.stop() : undefined;

    /** One key at a time, for the reason the binding below records. */
    let queue: Promise<void> = Promise.resolve();

    const offEnd = router.onEnd((error) => {
      // the same nobody-is-there problem as the check above, arriving later
      fail(error ?? new PromptError(__`Input ended before the prompt was answered`));
    });
    const offKey = router.bind((event) => {
      event.stop();
      const key = event.key;

      // Ctrl-C does not wait its turn. Everything else is queued because
      // `handlers.key` may be async -- a `validate` that asks a server -- and a
      // key read while the last one is still being handled would apply to a
      // state that has not caught up; but a prompt that cannot be escaped until
      // a slow validator comes back is a prompt that cannot be escaped, and
      // giving up needs nothing from the state
      // Ctrl-C is never a key a prompt may claim, which is the binding order's own
      // rule said one layer along. Ctrl-D is the other half of `isAbort()` and is
      // claimable, for the reason `Handlers.claims` records
      if (isAbort(key) && !(key.name === 'd' && handlers.claims?.(key))) {
        fail(new PromptError(__`Cancelled`, true));
        return;
      }

      // going back does not wait its turn either, for the same reason: it gives
      // the prompt up and needs nothing from the state. Asked before the prompt's
      // own keys, so a prompt cannot take Escape back from a group -- and only a
      // bare Escape, since Alt-x arrives as ESC x and is a different key
      if (opts.back && key.name === 'escape' && !key.ctrl && !key.meta && !key.shift) {
        fail(new PromptBack());
        return;
      }

      queue = queue
        .then(async () => {
          if (settled) {
            return;
          }

          const done = await handlers.key(key);
          if (done) {
            succeed(done.value);
            return;
          }

          if (!settled) {
            mounted?.frame();
          }
        })
        .catch(report);
    });

    const offPaste = handlers!.paste
      ? router.onPaste((event) => {
          event.stop();
          const text = event.text;
          queue = queue
            .then(() => {
              if (settled) {
                return;
              }
              handlers.paste?.(text);
              mounted?.frame();
            })
            .catch(report);
        })
      : undefined;

    stopInput = () => {
      offEnd();
      offKey();
      offPaste?.();
      // only a router this prompt built is given back: one handed in belongs to
      // an app that is still reading keys with it
      if (ownRouter) {
        router.stop();
      }
    };

    // last, because `fail()` is only a complete teardown once there is a screen
    // and a router to give back. Nothing awaits between the check at the top and
    // here, so the only abort this can see is one a first frame raised itself
    const { signal } = opts;
    if (signal) {
      const onAbort = (): void => fail(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      stopListening = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
      }
    }
  });
}

/** What a field shows when what was typed is wider than the room for it. */
interface Window {
  /** The part before the caret. */
  before: string;
  /** The cluster the caret is on, empty past the end of the value. */
  under: string;
  /** The part after the caret. */
  after: string;
}

/**
 * The part of a value that is on screen, with the caret always in it.
 *
 * A canvas is a fixed number of columns and a field that runs past the edge is
 * clipped there, so a long answer scrolls sideways rather than being cut off --
 * which is what readline does and is the deliberate divergence from what this
 * used to do, where the string was written whole and the terminal wrapped it. A
 * wrapped field cannot work here for a reason worth writing down: there is no
 * inline layout, so the three pieces the caret splits the value into are three
 * flex items, and a wrapped first item leaves the other two beside its *box*
 * rather than after its last line.
 *
 * @param value - What has been typed.
 * @param cursor - Where the caret is, as an offset into it.
 * @param width - How many columns there are.
 * @returns The three pieces, together no wider than `width`.
 */
function windowOf(value: string, cursor: number, width: number): Window {
  const room = Math.max(1, width);
  const end = boundary(value, cursor, 1);
  const under = value.slice(cursor, end);
  // the caret always takes a column, whether it is on a character or past the
  // last one, so the room for the value itself is one less
  const caret = Math.max(1, stringWidth(under));

  let before = value.slice(0, cursor);
  let after = value.slice(end);

  // the caret is kept on screen by dropping clusters from the front, and what
  // is left over at the end goes by dropping them from the back. Both stop when
  // there is nothing left to drop: a two-column caret in a one-column field is
  // a field that cannot hold it, and a loop that insists would never end --
  // which is a hung process rather than a frame one column too wide
  while (before !== '' && stringWidth(before) + caret > room) {
    // the boundary after offset zero, which is the end of the *first* cluster:
    // asking from one gives the end of the second, so the window jumped two
    // characters at a time and settled a column narrower than it had room for
    before = before.slice(boundary(before, 0, 1));
  }
  while (after !== '' && stringWidth(before) + caret + stringWidth(after) > room) {
    after = after.slice(0, boundary(after, after.length, -1));
  }

  return { after, before, under };
}

/**
 * How the head divides the row it is on.
 *
 * Said out loud rather than left to flexing, and the reason has moved. It used to
 * be the one the help template gave: a row's intrinsic height was taken with every
 * child offered the whole content box while placement hands each one a share, so a
 * question measured at the full width and placed in a share of it came out one line
 * tall and the choice list under it was drawn over the rest of the question.
 * SIG-125 closed that in the engine, so no app has to write this subtraction to get
 * a correct layout any more.
 *
 * This survives it for two reasons that were always here. `lines` is the first and
 * it is not about the message at all: the choice list subtracts it to work out how
 * many rows its window has, which is imperative arithmetic no layout answers. And
 * the message is a `min(content, room)` **cap** rather than a share -- what follows
 * it has to start where it ends, so a message that grew into the line would push
 * the caret to the far edge. So the number is computed either way, and the
 * declaration is what keeps the width and the row count one answer.
 *
 * One column is kept back for whatever follows the message, so that a question
 * as long as the terminal still leaves somewhere for the caret to be.
 *
 * @param message - What is being asked.
 * @param room - The columns the whole line has.
 * @returns What the message gets, what is left after it, and how many rows it
 *   takes -- which is what anything drawn *under* the head has to know, and is
 *   worked out here so that the width and the height cannot disagree about it.
 */
function headWidths(
  message: string,
  room: number,
  tail = ''
): { lines: number; message: number; rest: number } {
  // the mark, the mark's margin, and the message's own margin
  const fixed = stringWidth(SYMBOL.question) + 2;
  const avail = room - fixed;
  // **Neither half of the head gives up more than half the line.** The tail's own
  // columns are reserved rather than assumed to be one, and the reservation is
  // capped at half of what there is.
  //
  // Both halves of that were measured, in English. Reserving nothing is what
  // shipped: a hint is a flex item beside a message with `flex-shrink: 0`, so a
  // message that took every column left squeezed the hint into one and the canvas
  // -- capped at the terminal's width -- clipped the rest. `? Overwrite the file`
  // at 22 columns drew `(` where it should have drawn `(Y/n)`, so between about
  // 18 and 24 columns a yes-or-no question had no readable affordance at all.
  // Reserving the tail *in full* is the overcorrection: the multiselect hint is 35
  // columns, so at 40 it left the question four columns and `Pick some things`
  // came out as seven rows of two letters.
  //
  // So a short affordance is always whole -- `(Y/n)` down to 13 columns -- and a
  // long one wraps, with `lines` below counting what that came to
  const forTail = Math.min(
    Math.max(1, stringWidth(toDisplayText(tail))),
    Math.max(1, Math.floor(avail / 2))
  );
  const forMessage = Math.max(1, Math.min(stringWidth(message), avail - forTail));
  const rest = Math.max(1, avail - forMessage);

  return {
    // through the same wrapper the text element draws with, rather than by
    // dividing one width by another: a word too long to fit is broken, and a
    // count that guessed would put a choice list over the question.
    //
    // The *taller* of the two halves, because the head is one flex row. With the
    // tail reserved above it does not wrap and the message is what decides; at a
    // width too narrow for even that, the tail is. Counting the message alone is
    // what let a wrapped hint make the head taller than the choice window
    // believed -- measured, the multiselect head goes 1 to 4 rows at 30 columns
    // while this answered 1, and the row reserved for the error line is what
    // absorbed the first of them
    lines: Math.max(
      wrap(toDisplayText(message), { width: forMessage }).split('\n').length,
      tail === '' ? 1 : wrap(toDisplayText(tail), { width: rest }).split('\n').length
    ),
    message: forMessage,
    rest,
  };
}

/**
 * The head of a prompt: the mark, the message, and whatever follows them.
 *
 * @param message - What is being asked.
 * @param width - The columns the message gets, from `headWidths()`.
 * @param rest - What follows it.
 * @returns The line, and the mark, which every prompt settles.
 */
function promptHead(
  message: string,
  width: number,
  ...rest: Element[]
): { line: Element; mark: Element } {
  const mark = textNode(SYMBOL.question, { class: 'sigil-symbol sigil-accent', 'margin-right': 1 });
  return {
    line: box(
      { class: 'sigil-prompt-line' },
      mark,
      textNode(message, {
        class: 'sigil-prompt-message sigil-heading',
        'flex-shrink': 0,
        'margin-right': 1,
        width,
      }),
      ...rest
    ),
    mark,
  };
}

/**
 * Whether a tail that has to be drawn whole fits beside the question.
 *
 * `headWidths()` caps what it reserves for a tail at half the line, which is right
 * for a tail that can wrap and wrong for one that cannot: the canvas clips what
 * runs past its edge, so at 20 columns `selectKey()`'s expand line drew
 * `(o/S/d/h` and a date field drew `2024-06-`, and at 40 a date with seconds
 * lost them. Such a tail goes beside the question only where the head leaves it
 * every column it needs, and on a line of its own under the question --
 * `underHead()` -- where it would not. Asked of the same arithmetic the head is
 * laid out by, so the answer cannot disagree with what is drawn.
 *
 * A tail the cap always holds whole needs none of this: `confirm()`'s `(Y/n)` is
 * five columns and is whole down to the 13-column floor.
 *
 * @param message - What is being asked.
 * @param room - The columns the whole line has.
 * @param tail - The tail at its widest.
 * @returns Whether the head would leave the tail whole beside the question.
 */
function fitsBeside(message: string, room: number, tail: string): boolean {
  return headWidths(message, room, tail).rest >= stringWidth(toDisplayText(tail));
}

/**
 * A tail on a line of its own under the question, where `fitsBeside()` said it
 * would be cut beside it. Indented to where the message starts.
 *
 * @param tail - What could not go beside the question, and whatever settles in
 *   its place.
 * @returns The row to put under the head.
 */
function underHead(...tail: Element[]): Element {
  return box({ 'margin-left': stringWidth(SYMBOL.question) + 1 }, ...tail);
}

/** Where a prompt's answer settles, from `answerSlot()`. */
interface AnswerSlot {
  /** Goes in the head, after the message and whatever follows it. */
  beside: Element;
  /** Settles the answer: on the question's line where it fits there whole, or under it. */
  show(answer: string): void;
  /** Goes straight under the head. Takes no height until an answer is shown in it. */
  under: Element;
}

/**
 * Whether a settled answer fits beside the question, on its line and whole.
 *
 * The answer is drawn in what the head left after the message, which is `rest`
 * -- and almost nothing reserves for it, so a question as wide as the line left
 * one column and `Show the diff` went down the right edge as `S`, `t`, `d`. A
 * field's answer is `nowrap` and was cut to `S` instead. So an answer goes beside
 * the question only where it is one line there, and under it where it is not.
 * One line rather than a threshold: an answer wrapped at its spaces into what a
 * one-line question left reads as a column beside it, not as an answer, and a
 * number of rows or a longest word would be a line drawn through a picture that
 * nothing measures. Under the question there are always more columns than beside
 * it, so moving it never makes it narrower.
 *
 * @param rest - What the head left after the message, from `headWidths()` -- the
 *   head that is drawn, so the answer cannot disagree with it.
 * @param answer - What the prompt settled to.
 * @returns Whether it goes beside the question.
 */
function answerFits(rest: number, answer: string): boolean {
  return stringWidth(toDisplayText(answer)) <= rest;
}

/**
 * The answer a prompt settles to, in one of two places: beside the question where
 * `answerFits()` says so, and on a row of its own under it, `underHead()`'s, where
 * not. Every prompt that settles to an answer line settles through one of these,
 * so where an answer goes is one rule rather than one per prompt.
 *
 * @param rest - What the head left after the message, from `headWidths()`.
 * @returns The two places, and what settles the answer in one of them.
 */
function answerSlot(rest: number): AnswerSlot {
  const beside = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
  const below = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
  return {
    beside,
    show(answer: string): void {
      const node = answerFits(rest, answer) ? beside : below;
      node.setText(answer);
      node.setProps({ display: 'flex' });
    },
    under: underHead(below),
  };
}

/** Marks the head as answered, which is the only thing every prompt settles. */
function answered(mark: Element): void {
  mark.setProps({ class: 'sigil-symbol is-success sigil-success' });
}

/** A line that is shown only when it has something to say. */
function note(classes: string): Element {
  return textNode('', { class: classes, display: 'none' });
}

/**
 * Puts text on a line that hides itself when there is none.
 *
 * @param element - The line.
 * @param text - What it says, or nothing.
 */
function setNote(element: Element, text: string | undefined): void {
  element.setText(text ?? '');
  element.setProps({ display: text ? 'flex' : 'none' });
}

/** What a footer lists a prompt key as: fixed, or read again whenever the footer is. */
export type PromptKeyHelp = BindingHelp | (() => BindingHelp | undefined);

/**
 * The keys a prompt answers by name, each with what its footer says about it.
 *
 * The prompt's own key table rather than bindings on the router, and that is the
 * decision SIG-205 records under "The built-in prompts draw the footer": a
 * borrowed router belongs to the app, whose described keys would be a false
 * statement under a prompt that swallows every key, and dispatch stays the one
 * function binding `run()` makes, so Ctrl-C, `claims()` and the one-key queue are
 * what they were. It is a {@link KeyHelpSource}, which is the whole of what the
 * footer asks of a router.
 */
export interface PromptKeys<R> extends KeyHelpSource {
  /**
   * Answers a key, and lists it unless `help` is absent or says nothing.
   *
   * A key is matched the way the router matches one -- by its canonical spelling,
   * modifiers and all -- so `up` is not `shift+up`. The first one registered wins.
   *
   * @param keys - One key, as `bind()` spells it, or a pattern for a key built at
   *   run time.
   * @param run - What it does.
   * @param help - What the footer says, or a function asked each time it is read.
   */
  on(keys: string | KeyPattern, run: (k: Key) => R, help?: PromptKeyHelp): void;
  /** The handler a key is bound to, if any. */
  match(k: Key): ((k: Key) => R) | undefined;
  /** Asks the footer to read the help again, after a state a help function reads has moved. */
  refresh(): void;
}

/**
 * Builds an empty {@link PromptKeys}.
 *
 * @returns The table.
 */
function promptKeys<R>(): PromptKeys<R> {
  const entries: { help: PromptKeyHelp | undefined; run: (k: Key) => R; spec: string }[] = [];
  const revision = new State(0);

  return {
    bindings(): readonly BindingInfo[] {
      revision.get();
      const out: BindingInfo[] = [];
      for (const entry of entries) {
        const help = typeof entry.help === 'function' ? entry.help() : entry.help;
        if (help === undefined || help.description === '') {
          continue;
        }
        out.push(
          Object.freeze({
            description: help.description,
            group: help.group,
            keys: entry.spec,
            priority: Number.isFinite(help.priority) ? (help.priority as number) : 0,
            scope: undefined,
          })
        );
      }
      return out;
    },

    match(k: Key): ((k: Key) => R) | undefined {
      const spec = formatKey(k);
      return entries.find((entry) => entry.spec === spec)?.run;
    },

    on(keys: string | KeyPattern, run: (k: Key) => R, help?: PromptKeyHelp): void {
      let pattern: KeyPattern;
      if (typeof keys === 'string') {
        const patterns = parseKeys(keys);
        // a prompt reads one key at a time, so a sequence is a binding that could
        // never be matched -- refused where it is written, like the router's own
        if (patterns.length !== 1) {
          throw new TypeError(`A prompt key is one key, not a sequence: "${keys}"`);
        }
        pattern = patterns[0] as KeyPattern;
      } else {
        pattern = keys;
      }
      entries.push({ help, run, spec: formatKey(pattern) });
      revision.set(revision.get() + 1);
    },

    refresh(): void {
      revision.set(revision.get() + 1);
    },
  };
}

/**
 * The footer under a prompt: its key table, on one row that never wraps.
 *
 * Indented under the question the way the error line is, and given the columns
 * that leaves. One row at every width -- what does not fit is dropped whole,
 * lowest priority first -- so a prompt reserves exactly one row for it.
 *
 * @param keys - The prompt's key table.
 * @param columns - The terminal's width.
 * @param back - Whether Escape goes back a step, which is the prompt's `back`.
 * @returns The footer, in a box to hide once the prompt is answered.
 */
function promptFooter(keys: KeyHelpSource, columns: number, back = false): Element {
  // the back key is `run()`'s rather than the table's, so it is added to what is
  // listed here rather than to the table: an entry there would be a handler that
  // can never run, and this reads the same `back` that `run()` does
  const source: KeyHelpSource = back
    ? {
        bindings: () => [
          ...keys.bindings(),
          Object.freeze({
            description: __`back`,
            group: undefined,
            keys: 'escape',
            priority: 1,
            scope: undefined,
          }),
        ],
      }
    : keys;
  return box(
    { class: 'sigil-prompt-keys', 'padding-left': 2 },
    keyHelp(source, { width: Math.max(0, columns - 2) })
  );
}

/**
 * What a settled answer of several lines leaves in the log: its first line, and
 * how many follow it.
 *
 * One line, which is the house style every prompt here keeps -- `select()` leaves
 * its label and `multiselect()` a comma list. The whole of what was written is the
 * caller's return value, and a log holding a fifty-line paste per prompt is a log
 * nobody reads. Shared by `multiline()` and `editor()`, so the two answers of more
 * than one line cannot come to be summarized two ways.
 *
 * @param written - The answer.
 * @returns The line to leave.
 */
function summaryOf(written: string): string {
  const lines = written.split('\n');
  const more = lines.length - 1;
  return written === ''
    ? __`(empty)`
    : more > 0
      ? `${lines[0]} ${__n(more, '(+{0} more line)', '(+{0} more lines)')}`
      : (lines[0] as string);
}

/**
 * Asks for a line of text.
 *
 * @param opts - What to ask, and how to check the answer.
 * @returns What was typed.
 */
export function text(opts: TextOptions): Promise<string> {
  const terminal = opts.terminal ?? defaultTerminal;
  // flattened the way a paste is, because it is put in the field the way a paste
  // is: a one-line field cannot hold a line break whoever handed it one
  let value = typeof opts.value === 'string' ? pastedLine(opts.value) : '';
  if (asLines(opts)) {
    return lineText(opts, value);
  }
  let cursor = value.length;
  let error: string | undefined;

  return run<string>(opts, () => {
    const before = textNode('', { 'white-space': 'nowrap' });
    const caret = textNode('', { class: 'sigil-caret', 'white-space': 'nowrap' });
    const after = textNode('', { 'white-space': 'nowrap' });
    const field = box({ class: 'sigil-prompt-field' }, before, caret, after);
    const head = headWidths(opts.message, Math.max(1, terminal.width));
    const settled = answerSlot(head.rest);
    const { line, mark } = promptHead(opts.message, head.message, field, settled.beside);
    const complaint = note('sigil-prompt-error sigil-error');
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      settled.under,
      box({ 'padding-left': 2 }, complaint)
    );

    /**
     * What is drawn in place of a piece of the value.
     *
     * A mask is a column count rather than a substitution -- a two-column emoji
     * is two bullets -- so it is applied per piece rather than to the whole
     * value, which is what lets the caret sit between two of them. The pieces
     * still add up to what the whole value masked to, because they are split on
     * cluster boundaries and a width is the sum of its parts.
     *
     * @param part - A piece of the value.
     * @returns The piece, or the mask standing in for it.
     */
    function shown(part: string): string {
      return opts.mask === undefined ? part : opts.mask.repeat(stringWidth(part));
    }

    /** How many columns the value has, once the head has taken its share. */
    function room(): number {
      return head.rest;
    }

    function draw(): void {
      setNote(complaint, error);

      if (value === '') {
        // the caret is on screen from the first frame rather than from the
        // first keystroke: a prompt that only shows where it will type once
        // something has been typed is the same bug one keystroke smaller
        const hint = opts.placeholder ? opts.placeholder : (opts.default ?? '');
        const end = boundary(hint, 0, 1);
        before.setText('');
        // not dimmed along with the rest: it is under the reverse video either
        // way, and dimming it is how a caret comes to read as part of the hint
        // rather than as the place the next character goes
        caret.setText(hint.slice(0, end) || ' ');
        after.setText(hint.slice(end));
        after.setProps({ class: 'sigil-prompt-placeholder sigil-muted' });
        return;
      }

      const pane = windowOf(value, cursor, room());
      before.setText(shown(pane.before));
      // past the last character there is nothing to mark, so the caret is a
      // column of its own rather than a mark on one
      caret.setText(shown(pane.under) || ' ');
      after.setText(shown(pane.after));
      after.setProps({ class: '' });
    }

    /**
     * Types text in at the cursor, which is what a key and a paste both are.
     *
     * @param input - What to insert.
     */
    function insert(input: string): void {
      ({ cursor, value } = insertAt(value, cursor, input));
    }

    draw();

    return {
      async key(k) {
        error = undefined;

        if (k.name === 'enter') {
          const answer = value === '' ? (opts.default ?? '') : value;
          const failed = await opts.validate?.(answer);
          if (typeof failed === 'string' && failed) {
            error = failed;
            draw();
            return;
          }
          return { value: answer };
        }

        if (k.name === 'backspace') {
          ({ cursor, value } = deleteBefore(value, cursor));
        } else if (k.name === 'delete') {
          ({ cursor, value } = deleteAfter(value, cursor));
        } else if (k.name === 'left') {
          cursor = boundary(value, cursor, -1);
        } else if (k.name === 'right') {
          cursor = boundary(value, cursor, 1);
        } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          cursor = 0;
        } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          cursor = value.length;
        } else if (k.ctrl && k.name === 'u') {
          value = value.slice(cursor);
          cursor = 0;
        } else {
          // a printable key, and `typedText()` is what decides whether this was
          // one: a character arrives with its name and its sequence the same
          // string, while a named key's name is one the terminal never sent. What
          // is inserted is the sequence rather than the name
          insert(typedText(k) ?? '');
        }

        draw();
      },

      paste(block: string): void {
        // a one-line field, so the line breaks a pasted block carries are
        // flattened rather than obeyed -- `pastedLine()` is that rule, and it sits
        // beside `pastedBlock()`, which is the multiline field's opposite answer
        // to the same question
        insert(pastedLine(block));
        draw();
      },

      settle(answer: string): void {
        answered(mark);
        // the field is `nowrap` and was cut to what the head left it, so the
        // answer settles in a slot of its own rather than in the field
        field.setProps({ display: 'none' });
        settled.show(opts.mask === undefined ? answer : opts.mask.repeat(stringWidth(answer)));
        setNote(complaint, undefined);
      },

      view,
    };
  });
}

/**
 * Asks for a line of text without showing it.
 *
 * @param opts - What to ask.
 * @returns What was typed.
 */
export function password(opts: TextOptions): Promise<string> {
  return text({ mask: '•', ...opts });
}

/**
 * The key that submits a multiline answer, since Enter cannot.
 *
 * A spec rather than a predicate, because the footer the field draws has to say
 * which key it is: a `(k: Key) => boolean` is more flexible and would need a
 * second option beside it for the label, and two options that can disagree
 * about one key is how a prompt comes to tell the reader to press something
 * that does nothing.
 *
 * `{ meta: true, name: 'enter' }` is Alt-Enter, which is also what
 * Escape-then-Enter arrives as when the two are pressed inside
 * `ESCAPE_TIMEOUT` of each other -- so that sequence is reachable without the
 * field having to hold a mode nothing on screen could show.
 */
export interface SubmitKey {
  /** Whether Ctrl is held. */
  ctrl?: boolean;
  /** Whether Alt is held, which a terminal sends as a leading `ESC`. */
  meta?: boolean;
  /** The key's name, as `decodeKeys()` names it. */
  name: string;
}

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

export interface MultilineOptions extends PromptOptions, AccessibleOptions {
  /**
   * The most characters the answer may hold, counted as what the caret steps
   * over -- grapheme clusters, with a line break as one. Typing at the limit
   * inserts nothing, a paste is cut to what fits, and a count under the field
   * says how many are left. A whole number of at least one.
   */
  charLimit?: number;
  /**
   * A mark drawn at the start of every row of the field, after the line number
   * when there is one -- `'│ '` or `'> '`. Drawn muted, and never part of the
   * value.
   */
  gutter?: string;
  /**
   * Says which stretches of the value are which tokens, for syntax highlighting.
   * Called with the whole value whenever it changes and never when only the caret
   * moved. Spans are clipped to the value; where two cover one character the
   * later one wins.
   *
   * There is no grammar in here and there will not be one: a runtime with no
   * dependencies cannot carry a grammar set, so this is the seam an app fills
   * with whatever highlighter it already has.
   */
  highlight?: (value: string) => readonly HighlightSpan[];
  /**
   * Numbers each line of the value down the left of the field. A line soft
   * wrapped over several rows is numbered on its first, and the caret's line is
   * drawn in the ordinary foreground while the rest are muted.
   */
  lineNumbers?: boolean;
  /**
   * What the field starts with, which the person can then edit.
   *
   * There is deliberately no `default`: `text()` has one because Enter alone is
   * the common gesture there, and here Enter is a newline -- so a field that is
   * meant to come up with something in it comes up with it *visible and
   * editable*, which is the better answer anyway.
   *
   * Its line endings are normalized the way a paste's are, so that the value
   * holds one spelling of a line break and nothing else.
   */
  initial?: string;
  /** Shown dimmed when nothing has been typed. */
  placeholder?: string;
  /**
   * The most rows the field takes before it scrolls. Ten by default, and capped
   * by what the terminal has left under the question.
   *
   * The field *grows* into it rather than starting there: one that reserved ten
   * rows for a one-line answer would hold nine blank rows of the user's
   * scrollback open for the life of the prompt, which is the same argument the
   * auto-height canvas is written for.
   */
  rows?: number;
  /** What submits the answer. Ctrl-D by default. */
  submit?: SubmitKey;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept.
   */
  validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
  /**
   * An answer to start from: the field opens holding it, editable, as it does
   * `initial`. Beats `initial`, and is dropped for it when it holds more than
   * `charLimit` allows.
   */
  value?: string;
}

/**
 * The field arithmetic below is exported for a test and is deliberately *not*
 * in the components barrel.
 *
 * What a multiline field claims is a coordinate -- a caret derived from an
 * offset, a goal column that survives a short row and a wide cluster -- and
 * those are functions of a string, an offset and a width. The screen model a
 * component test reads holds characters rather than styling, so asserting them
 * through it is asserting them through a keyhole: the cell under the caret holds
 * the same character whether or not a caret was drawn there. So the arithmetic
 * is asserted directly and the field is asserted through the screen, which is
 * the split `rowWindow()` and `thumbExtent()` already keep for the scroll box.
 *
 * `layoutField()`, `fieldLayers()` and the shapes they trade in are in the
 * barrel since SIG-201, and for one reason: `number()` is a registry entry, an
 * ejected copy imports only what is published, and it draws its field with
 * exactly these two. That makes `FieldLayout` a promise to the app that ejected
 * it -- narrow, and made on purpose; see "Ejecting `number`, `date` and the
 * palette" in this directory's `AGENTS.md`.
 */

/** One cluster of a field's value, and where it was drawn. */
export interface FieldCell {
  /** The cluster's offset in the value. */
  at: number;
  /** What is drawn for it, which is what a `text` would draw for it. */
  text: string;
  /** How many columns it takes. */
  width: number;
  /** The column it starts at. */
  x: number;
}

/** One row of a field, which is a row on screen rather than a line of the value. */
export interface FieldRow {
  cells: FieldCell[];
  /** The offset the row begins at, which is where an empty row's caret goes. */
  start: number;
  /** The columns its cells take. */
  width: number;
}

/** A value laid out at a width, with the caret placed in it. */
export interface FieldLayout {
  /** Where the caret is drawn, and the cluster it marks. */
  caret: { row: number; text: string; x: number };
  rows: FieldRow[];
  /** The columns the field asks for: its widest row, plus the caret's own. */
  width: number;
}

/** What the two layers of a field read: the rows, the window, and the caret. */
export interface FieldFrame {
  layout: FieldLayout;
  /**
   * The token each offset of the value was highlighted as, where it was. A cell
   * whose cluster starts at a highlighted offset is left to the layer for that
   * token rather than painted by the field, so whoever sets this draws those cells.
   */
  tokens?: readonly (string | undefined)[];
  /** The first row on screen, when the value is taller than the field. */
  top: number;
  /** How many of its rows are on screen. */
  visible: number;
}

/** A cluster of the value, with where it is. */
interface Cluster {
  at: number;
  text: string;
}

/** A run of clusters that are all whitespace or all not, which is what wraps. */
interface ClusterRun {
  clusters: Cluster[];
  space: boolean;
  width: number;
}

/**
 * What one cluster draws, which is what a `text` draws for it.
 *
 * A newline is the line terminator rather than something to draw: it is a
 * cluster of the value and therefore an offset the caret can sit on, and it
 * takes no column. Everything else goes through the same function a `text`
 * reads, which is what makes a tab one space here as well -- the grid models no
 * tab stops, and a field that disagreed with every other text in the library
 * about what a tab is would be a column out per tab.
 *
 * The newline branch fails its own sabotage and is kept, because the sabotage is
 * **equivalent** rather than the branch dead: `cellWidth('\n')` is zero --
 * measured, along with every other control character -- so the cell comes out
 * unpaintable either way. What it buys is that nothing can ever hand a raw `\n`
 * to `CellBuffer.put()`, which *throws* on one. Dropping the mapping altogether
 * is the sharper sabotage and is caught.
 *
 * @param cluster - One grapheme cluster of the value.
 * @returns What to paint, which is empty for anything with no cell.
 */
function clusterText(cluster: string): string {
  return cluster === '\n' ? '' : toDisplayText(cluster);
}

/** How many columns one cluster takes, which is what the grid will give it. */
function clusterWidth(cluster: string): number {
  const text = clusterText(cluster);
  return text === '' ? 0 : cellWidth(text);
}

/** Splits a line's clusters into the runs `wrap()` breaks between. */
function clusterRuns(clusters: readonly Cluster[]): ClusterRun[] {
  const runs: ClusterRun[] = [];
  let current: Cluster[] = [];
  let space = false;
  let width = 0;

  for (const cluster of clusters) {
    const blank = isSpaceCluster(cluster.text);
    if (current.length > 0 && blank !== space) {
      runs.push({ clusters: current, space, width });
      current = [];
      width = 0;
    }
    space = blank;
    current.push(cluster);
    width += clusterWidth(cluster.text);
  }
  if (current.length > 0) {
    runs.push({ clusters: current, space, width });
  }

  return runs;
}

/**
 * Where a caret goes on a row, given the column it would like.
 *
 * **A caret may not be painted on the far half of a wide cluster**, and that is
 * not about how it looks: `CellBuffer` carries a write on either half of one to
 * the other, so a space on the continuation blanks the lead and the character is
 * *gone*. Measured -- `漢` in a two-column grid, a space at column one, and the
 * row comes back as two blanks.
 *
 * Two columns are the only place it can happen and both are reachable. A cluster
 * wider than the wrap limit is placed at column zero anyway, because the break
 * guard asks `x > 0` -- there is nowhere else to put it -- so a field of one or
 * two columns holds a row two columns wide, the reported width is the room, and
 * the clamp under `edge` lands on column one. And a zero-width cell is clamped
 * to the wrap column by `place()`, so a newline after such a cluster is *already*
 * there: `漢\nmore` with End pressed on the first line is the same cell.
 *
 * So the caret backs up to the cluster's lead and **marks the cluster**, which is
 * this field's own rule applied to the only cluster there is room for. It is
 * wrong about where the next character goes -- in a two-column field holding a
 * wide character there is no column that is right about that -- and it is the only
 * answer that keeps the character on screen.
 *
 * @param row - The row the caret is on.
 * @param at - The column it would like.
 * @returns The column to paint in, and what to paint there.
 */
function caretOn(row: FieldRow, at: number): { text: string; x: number } {
  for (const cell of row.cells) {
    if (cell.width > 0 && at >= cell.x && at < cell.x + cell.width) {
      return { text: cell.text, x: cell.x };
    }
  }

  return { text: ' ', x: at };
}

/**
 * A value laid out as rows of cells, with the caret placed among them.
 *
 * **This is what the `raw` node buys and why the field is one.** A wrapping
 * field is the problem the single-line prompt scrolls sideways to avoid: there
 * is no inline layout, so the three pieces the caret splits a value into are
 * three flex items, and a wrapped first item leaves the other two beside its
 * *box* rather than after its last line. A `raw` is one node that measures like
 * a text and paints its own cells, so the value is wrapped once here and the
 * caret is a cell coordinate derived from the offset.
 *
 * **Soft wrap only.** The value keeps exactly the breaks the person typed, and a
 * row is where the field *drew* a break rather than anything in the value.
 *
 * **The caret marks the cluster at the cursor**, which is the single-line
 * field's own rule -- reverse video over a whole grapheme cluster -- and it is
 * what answers the end-of-a-row-versus-start-of-the-next question with no second
 * rule to remember: a cursor at a soft break is drawn at the start of the next
 * row, because that is where the cluster it names was placed. Past the last
 * cluster there is nothing to mark, so the caret is a column of its own.
 *
 * **Every cluster is placed, including the whitespace a break throws away.**
 * `wrap()` drops the trailing whitespace of a line and is right to -- a terminal
 * draws nothing for it. A field cannot: a space is an offset the caret has to be
 * able to sit on, so the gap stays on the row it ended. What that costs is one
 * declared divergence: whitespace that would land past the wrap column is placed
 * *at* it, so a run of several spaces at a break shares one column. They are all
 * blanks, so nothing on screen says so; what it buys is that the caret is always
 * inside the box, with no phantom row for an invisible character.
 *
 * **It wraps at one column less than the room**, which is the single-line
 * field's own rule said again: the caret always takes a column, whether it is on
 * a character or past the last one. The alternative is a caret at column
 * `width`, drawn on a row below the one it belongs to -- and then pressing End
 * on a full row makes the field a row taller, so a key that moved nothing
 * reflows everything under it.
 *
 * @param value - What has been typed, or the placeholder standing in for it.
 * @param cursor - Where the caret is, as an offset into it.
 * @param room - The columns the field has.
 * @returns The rows, the caret, and the width the field asks for.
 */
export function layoutField(value: string, cursor: number, room: number): FieldLayout {
  const limit = Math.max(1, room - 1);
  const at = snap(value, Math.max(0, Math.min(cursor, value.length)));
  const rows: FieldRow[] = [];

  let cells: FieldCell[] = [];
  let start = 0;
  /** The column the next cluster would take, before the clamp. */
  let x = 0;

  /** Ends the row being built and starts one at `next`. */
  const flush = (next: number): void => {
    let width = 0;
    for (const cell of cells) {
      width = Math.max(width, cell.x + cell.width);
    }
    rows.push({ cells, start, width });
    cells = [];
    start = next;
    x = 0;
  };

  const place = (cluster: Cluster): void => {
    const text = clusterText(cluster.text);
    const width = text === '' ? 0 : cellWidth(text);
    cells.push({ at: cluster.at, text, width, x: Math.min(x, limit) });
    x += width;
  };

  // the value's clusters, grouped into the logical lines its newlines define.
  // The terminator belongs to the line it ends, because its offset is a place
  // the caret goes: pressing End on a line puts it there
  const lines: { clusters: Cluster[]; start: number; terminator: Cluster | undefined }[] = [];
  let line: Cluster[] = [];
  let lineStart = 0;
  let offset = 0;

  for (const text of graphemes(value)) {
    const cluster = { at: offset, text };
    offset += text.length;
    if (text === '\n') {
      lines.push({ clusters: line, start: lineStart, terminator: cluster });
      line = [];
      lineStart = offset;
    } else {
      line.push(cluster);
    }
  }
  lines.push({ clusters: line, start: lineStart, terminator: undefined });

  for (const logical of lines) {
    start = logical.start;

    /** The whitespace since the last word, which decides where a break falls. */
    let gap: Cluster[] = [];
    let gapWidth = 0;

    for (const run of clusterRuns(logical.clusters)) {
      if (run.space) {
        gap = run.clusters;
        gapWidth = run.width;
        continue;
      }

      const breaking = x > 0 && x + gapWidth + run.width > limit;
      // the gap goes on the row it ended either way, which is where this parts
      // company with `wrap()` and why
      for (const cluster of gap) {
        place(cluster);
      }
      gap = [];
      gapWidth = 0;
      if (breaking) {
        flush(run.clusters[0].at);
      }

      for (const cluster of run.clusters) {
        // only reachable for a word that did not fit a row of its own, since
        // the row was already broken for one that did: this is where it is cut
        if (x > 0 && x + clusterWidth(cluster.text) > limit) {
          flush(cluster.at);
        }
        place(cluster);
      }
    }

    for (const cluster of gap) {
      place(cluster);
    }
    if (logical.terminator) {
      place(logical.terminator);
    }
    flush(logical.terminator ? logical.terminator.at + 1 : value.length);
  }

  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, row.width);
  }
  // the caret's own column is what the `+ 1` is, and it is what makes the clamp
  // below a no-op anywhere but a one-column field -- where `limit` cannot be
  // zero, so a cell really can land on the column the box ends at
  const width = Math.min(Math.max(1, room), widest + 1);
  const edge = width - 1;

  for (const [row, built] of rows.entries()) {
    for (const cell of built.cells) {
      if (cell.at === at) {
        // through `caretOn()` whatever the cell is, which is one rule rather
        // than two: a cell of positive width finds itself there and takes its
        // own text, and a cell with no cell at all -- a newline, a lone
        // combining mark, a control character a caller handed in -- has nothing
        // to mark, so it comes back a blank unless the column it was clamped to
        // belongs to a cluster. `place()` clamps a zero-width cell to the wrap
        // column, which a wide cluster may already be sitting on
        const on = caretOn(built, Math.min(edge, cell.x));
        return { caret: { row, text: on.text, x: on.x }, rows, width };
      }
    }
  }

  // past the last cluster, which is the one position no cluster owns -- and it is
  // the last row's, because every other row's end is the next row's start
  const last = rows.at(-1);
  const on = last ? caretOn(last, Math.min(edge, last.width)) : { text: ' ', x: 0 };
  return { caret: { row: rows.length - 1, text: on.text, x: on.x }, rows, width };
}

/**
 * The offset a vertical move lands on, given the column it is aiming for.
 *
 * **The goal is a display column rather than an offset**, which is the thing a
 * from-scratch textarea gets wrong: a remembered offset drifts left through a
 * short row, and an offset and a column stop being the same number the moment a
 * row holds a wide character. So Up-Up-Down comes back to the column it started
 * in, through a short row and through a row of CJK.
 *
 * The last cluster whose column is at or before the goal, which is where a caret
 * can be: aiming past the end of a row lands on its last position, and aiming at
 * the far half of a wide cluster lands on that cluster rather than between its
 * halves.
 *
 * @param layout - The value as it is drawn.
 * @param length - The value's length, for the one position no cluster owns.
 * @param row - The row to land on.
 * @param column - The column to aim for.
 * @returns The offset.
 */
export function offsetIn(layout: FieldLayout, length: number, row: number, column: number): number {
  const index = Math.max(0, Math.min(row, layout.rows.length - 1));
  const target = layout.rows[index];

  // the position past the last cluster, which only the last row has: every other
  // row's end is the next row's start, and belongs to that row.
  //
  // Aimed at the column the caret would be *drawn* in rather than at the row's
  // own extent, because the two part company exactly where the whitespace clamp
  // bit: a row ending in a run of spaces is `limit + 1` wide while the caret past
  // it is drawn at `limit`, so a goal column -- which can never exceed the edge --
  // could not reach the end of the value at all. `layoutField()` computes that
  // column the same way, which is what keeps the two agreeing
  if (index === layout.rows.length - 1 && column >= Math.min(layout.width - 1, target.width)) {
    return length;
  }

  let found = target.start;
  for (const cell of target.cells) {
    if (cell.x > column) {
      break;
    }
    // at or before, and the *last* such cell: a run of whitespace clamped to the
    // wrap column shares it, and the caret belongs on the last of them
    found = cell.at;
  }

  return found;
}

/**
 * The offset the logical line holding `at` starts at.
 *
 * **Home, End, Ctrl-A, Ctrl-E, Ctrl-U and Ctrl-K are the logical line and not
 * the row on screen**, which is the one place this field is a terminal field
 * rather than a textarea. Three reasons, and the third is the deciding one.
 * Ctrl-A and Ctrl-E *are* readline's names for the ends of a line, so making
 * them mean something else here is the surprise rather than the consistency.
 * nano, vim and emacs all answer the logical line for Home. And the visual
 * reading has a wart it cannot avoid: the last caret position on a
 * soft-wrapped row is *on* its last cluster rather than after it -- there is no
 * column after it, which is the whole reason the row broke -- so a visual End
 * leaves the caret one character short of where "end" reads.
 *
 * Vertical movement stays visual, because that is what the person can see and
 * because a goal column is a column.
 *
 * @param value - What has been typed.
 * @param at - An offset in it.
 * @returns The offset after the previous newline, or zero.
 */
export function lineStart(value: string, at: number): number {
  return (at <= 0 ? -1 : value.lastIndexOf('\n', at - 1)) + 1;
}

/**
 * The offset the logical line holding `at` ends at, which is its newline's own.
 *
 * Before the newline rather than after it, so that End leaves the caret where
 * the next character would go on *this* line and Ctrl-K kills the line's text
 * without joining it to the next -- which is what readline's `kill-line` does.
 *
 * @param value - What has been typed.
 * @param at - An offset in it.
 * @returns The offset of the next newline, or the end of the value.
 */
export function lineEnd(value: string, at: number): number {
  const found = value.indexOf('\n', Math.max(0, at));
  return found === -1 ? value.length : found;
}

/**
 * The field and its caret, as two `raw` elements over one rectangle.
 *
 * **Two elements because one cannot resolve two styles**, which is the scroll
 * bar's own shape and the decrypt's: the caret carries `.sigil-caret` and is
 * therefore `inverse` through the ordinary cascade, so a theme reaches it where
 * it reaches everything else. At colour level 0 the seven attributes go, so no
 * caret is drawn there at all -- which is the rule the single-line field's caret
 * already follows and is right: a reverse-video caret would be the one sequence
 * `NO_COLOR` could not switch off.
 *
 * **The caret paints at the field's box rather than at its own.** Its insets
 * resolve against the host's padding box, so a `padding` an app writes on the
 * host would otherwise put every caret a column away from the character it
 * marks. Reading the box of the frame it is in is what a `raw` is for.
 *
 * **`drawsText` on both, rather than `selectable: true`.** A `raw` is not
 * selectable unless something says so, which is right for a sparkline and wrong
 * for a field whose cells *are* the text; `drawsText` changes the **default**, so
 * a `selectable={false}` on a pane still reaches the field the way it reaches
 * the texts inside it, where an answer would have beaten it. On the caret layer
 * too, and that is not decoration: it repaints the cluster under the caret, so
 * without it that one cell would be the one character of the field a selection
 * could not copy.
 *
 * A function of a frame rather than part of `multiline()`, so that what it draws
 * is testable with no terminal and no keystrokes -- which is the rule the layout
 * engine and the selector engine already keep, and is the only way to ask what a
 * cell's `selectable` came out as.
 *
 * @param read - The frame to draw: the rows, the window, and the caret.
 * @returns The two elements, the field named first because it is the one in flow.
 */
export function fieldLayers(read: () => FieldFrame): { caret: Element; field: Element } {
  const field = raw(
    {
      drawsText: true,
      // the frame's own width rather than the one it was offered, because the
      // layout was taken at a room the component already knew
      measure: () => {
        const { layout, visible } = read();
        return {
          height: visible,
          minHeight: visible,
          minWidth: layout.width,
          width: layout.width,
        };
      },
      paint: (painter, area, element) => {
        const { layout, tokens, top, visible } = read();
        const style = cellStyle(element.style);

        // the window rather than the box, and a `Math.min` of the two was written
        // here and taken out again for failing its sabotage: the measure asks for
        // exactly `visible` rows, so the box's own height is that number -- and
        // where a parent gave it more, drawing the rows that were not asked for
        // would be drawing outside the window rather than inside the box
        for (let row = 0; row < visible && top + row < layout.rows.length; row++) {
          for (const cell of layout.rows[top + row].cells) {
            // a cluster with no cell is not painted, and the guard is a tripwire
            // rather than a saving: `CellBuffer.put()` *throws* on a control
            // character rather than dropping it, and a throw from inside paint
            // takes the frame and the renderer with it. `clusterText()` already
            // gives one no text, so nothing the field itself produces reaches
            // this -- what does is a `FieldCell` somebody else built.
            //
            // A highlighted cell is skipped rather than painted under its token's
            // layer, which is the decrypt's two layers again: a `raw` leaves the
            // cells it does not want alone. **Declared rather than claimed** -- the
            // token layer paints after the field, so a cell painted by both comes
            // out the same, and the sabotage that drops this is equivalent. What
            // it buys is one writer per cell, which is the shape to reason about
            if (cell.width > 0 && tokens?.[cell.at] === undefined) {
              painter.text(area.x + cell.x, area.y + row, cell.text, style);
            }
          }
        }
      },
    },
    { class: 'sigil-prompt-field' }
  );

  const caret = raw(
    {
      drawsText: true,
      // never asked, because a box given both insets on an axis is as wide as
      // they say
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, _area, element) => {
        const { layout, top, visible } = read();
        const area = field.content ?? field.box;
        const row = layout.caret.row - top;
        // the window rather than the box, which is the same number: the measure
        // asked for `visible` rows and nothing in this tree squeezes the cross
        // axis below what a line's largest item reported. A second bound on
        // `area.height` was written here and taken out again for failing its
        // sabotage -- the grid refuses a cell outside itself, so what it was
        // standing against was a box this component cannot produce
        if (!area || row < 0 || row >= visible) {
          return;
        }
        painter.text(
          area.x + layout.caret.x,
          area.y + row,
          layout.caret.text,
          cellStyle(element.style)
        );
      },
    },
    {
      bottom: 0,
      class: 'sigil-caret',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    }
  );

  return { caret, field };
}

/**
 * The role a token draws in, for the handful of names every highlighter has.
 *
 * **A role rather than a declaration**, which is the rule the framework sheet
 * keeps everywhere: a declaration two built-ins share lives on a role, and the
 * component class beside it is the narrower hook. So a keyword is the accent
 * because a theme that recoloured the accent meant it, and `.sigil-token-keyword`
 * is there for a sheet that wants keywords alone. Seven, because those are the
 * seven every highlighter emits under one spelling or another and each has a role
 * that reads right for it -- de-emphasis for a comment, the error role for what
 * the highlighter could not parse. Anything else is a hook with no default.
 *
 * A `Map`, for the reason a registry's lookup table is null-prototype: a token
 * is a name an app chose, and `constructor` reads back truthy off a plain object.
 */
export const TOKEN_ROLE: ReadonlyMap<string, string> = new Map([
  ['comment', 'sigil-muted'],
  ['function', 'sigil-heading'],
  ['invalid', 'sigil-error'],
  ['keyword', 'sigil-accent'],
  ['number', 'sigil-info'],
  ['string', 'sigil-success'],
  ['type', 'sigil-warn'],
]);

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
 * The layer one token's cells are drawn in.
 *
 * **One layer per token, because one element cannot resolve two styles** -- the
 * caret's reason, the scroll bar's and the decrypt's. A layer carries
 * `sigil-token-<token>` and, for the names in `TOKEN_ROLE`, the role beside it,
 * so the cascade decides its colour: a theme reaches it, the light half reaches
 * it, and at colour level 0 it is plain text like everything else. Absolute over
 * the field with all four insets, painting at the field's box for the reason the
 * caret does, and painting only the cells the field skipped.
 *
 * @param read - The frame to draw.
 * @param field - The field the cells are in, whose box is where they go.
 * @param token - The token this layer draws.
 * @returns The layer.
 */
export function tokenLayer(read: () => FieldFrame, field: Element, token: string): Element {
  const role = TOKEN_ROLE.get(token);

  return raw(
    {
      drawsText: true,
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, _area, element) => {
        const { layout, tokens, top, visible } = read();
        const area = field.content ?? field.box;
        if (!area || !tokens) {
          return;
        }
        const style = cellStyle(element.style);
        for (let row = 0; row < visible && top + row < layout.rows.length; row++) {
          for (const cell of layout.rows[top + row].cells) {
            if (cell.width > 0 && tokens[cell.at] === token) {
              painter.text(area.x + cell.x, area.y + row, cell.text, style);
            }
          }
        }
      },
    },
    {
      bottom: 0,
      class: `sigil-token sigil-token-${token}${role ? ` ${role}` : ''}`,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    }
  );
}

/** What the gutter beside a field reads. */
export interface GutterFrame {
  /** The row whose number is drawn in the ordinary foreground, if it is numbered. */
  active: number | undefined;
  /** How many columns the numbers take, or zero when there are none. */
  digits: number;
  /** What is drawn on every row after the number. */
  mark: string;
  /** The line number each row starts, or `undefined` for a row a soft wrap made. */
  numbers: readonly (number | undefined)[];
  /** The first row on screen. */
  top: number;
  /** How many rows are on screen. */
  visible: number;
}

/**
 * The line number each row of a field starts, and nothing for a row that
 * continues one.
 *
 * **A line is numbered on its first row only**, which is what every editor that
 * soft wraps does: the number is the value's line, and a row is where the field
 * drew a break rather than anything in the value. Numbering rows instead would
 * make the numbers change when the terminal was resized.
 *
 * A row starts a line when it is the first or the offset before it is a newline,
 * which is the one thing `layoutField()` promises about a row's `start`: a soft
 * break is never at a line's first cluster, because a row is only ever broken
 * once something is on it.
 *
 * @param value - What was laid out. The placeholder is laid out as one line, so
 *   a field showing it is handed `''` and numbers its first row alone.
 * @param layout - The rows.
 * @returns A number or nothing, per row.
 */
export function gutterOf(value: string, layout: FieldLayout): (number | undefined)[] {
  const numbers: (number | undefined)[] = [];
  let line = 0;

  for (const [index, row] of layout.rows.entries()) {
    if (index === 0 || value[row.start - 1] === '\n') {
      line++;
      numbers.push(line);
    } else {
      numbers.push(undefined);
    }
  }

  return numbers;
}

/**
 * How many columns a gutter takes.
 *
 * **Two digits at the least**, so the field does not move a column right at the
 * tenth line: ten is the field's default row cap, which makes the tenth line one
 * an ordinary answer reaches, and a gutter that widened there would shift every
 * character already typed while somebody was typing. A hundred lines widen it,
 * which is a paste rather than a sentence.
 *
 * @param lines - How many lines the value has.
 * @param numbered - Whether lines are numbered at all.
 * @param mark - What is drawn on every row.
 * @returns The digits, and the whole width with the gap after them and the mark.
 */
function gutterWidth(
  lines: number,
  numbered: boolean,
  mark: string
): { digits: number; width: number } {
  const digits = numbered ? Math.max(2, String(lines).length) : 0;
  return { digits, width: gutterColumns(digits, mark) };
}

/** The columns a gutter of so many digits and this mark takes: the gap is one. */
function gutterColumns(digits: number, mark: string): number {
  return (digits > 0 ? digits + 1 : 0) + stringWidth(mark);
}

/**
 * The gutter beside a field, as two `raw` elements over one rectangle.
 *
 * The gutter is muted and in flow, so it is what reserves the columns; the
 * caret's line number is the second layer, absolute over it, because one element
 * cannot resolve two styles and the line the caret is on is the one number that
 * should not be de-emphasised. The same shape as the field and its caret, and
 * the active layer paints at the gutter's box for the reason the caret paints at
 * the field's.
 *
 * @param read - The frame to draw.
 * @returns The two elements, the gutter named first because it is the one in flow.
 */
export function gutterLayers(read: () => GutterFrame): { active: Element; gutter: Element } {
  /** Right-aligned in the digits, or nothing for a row a soft wrap made. */
  const label = (frame: GutterFrame, row: number): string | undefined => {
    const number = frame.numbers[row];
    return number === undefined || frame.digits === 0
      ? undefined
      : String(number).padStart(frame.digits);
  };

  const gutter = raw(
    {
      measure: () => {
        const frame = read();
        const columns = gutterColumns(frame.digits, frame.mark);
        return {
          height: frame.visible,
          minHeight: frame.visible,
          minWidth: columns,
          width: columns,
        };
      },
      paint: (painter, area, element) => {
        const frame = read();
        const style = cellStyle(element.style);
        const after = frame.digits > 0 ? frame.digits + 1 : 0;

        for (let row = 0; row < frame.visible && frame.top + row < frame.numbers.length; row++) {
          const at = frame.top + row;
          const text = label(frame, at);
          // the caret's line is the other layer's, and left to it for the reason
          // the field leaves a highlighted cell to its token: one writer per cell.
          // Equivalent under sabotage, since that layer paints over this one
          if (text !== undefined && at !== frame.active) {
            painter.text(area.x, area.y + row, text, style);
          }
          if (frame.mark !== '') {
            painter.text(area.x + after, area.y + row, frame.mark, style);
          }
        }
      },
    },
    { class: 'sigil-prompt-gutter sigil-muted' }
  );

  const active = raw(
    {
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, _area, element) => {
        const frame = read();
        const area = gutter.content ?? gutter.box;
        const row = frame.active === undefined ? -1 : frame.active - frame.top;
        const text = frame.active === undefined ? undefined : label(frame, frame.active);
        if (!area || text === undefined || row < 0 || row >= frame.visible) {
          return;
        }
        painter.text(area.x, area.y + row, text, cellStyle(element.style));
      },
    },
    {
      bottom: 0,
      class: 'sigil-prompt-gutter-active',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    }
  );

  return { active, gutter };
}

/**
 * The box a field and its gutter sit in, under the question.
 *
 * `position: relative` with no insets moves nothing and is what gives the caret
 * layer a containing block to resolve its own against. Without a gutter this is
 * the tree the field always had.
 *
 * **With one, the gutter and the field each get a positioned box of their own**,
 * and that is about the selection rather than the paint. Every layer over the
 * field is absolute with all four insets, so it covers its containing block --
 * and the caret's `drawsText` over a block that also held the gutter put the line
 * numbers back into what a selection copies, which is the thing the gutter not
 * drawing text is there to prevent. Found by the test that asks, which is why
 * this is a function rather than inline in `multiline()`.
 *
 * @param layers - The field and its caret.
 * @param gutter - The gutter and its active number, when there is one.
 * @returns The box to put under the question, and the one a token layer joins.
 */
export function fieldBox(
  layers: { caret: Element; field: Element },
  gutter?: { active: Element; gutter: Element }
): { area: Element; host: Element } {
  if (!gutter) {
    const host = box(
      { class: 'sigil-prompt-multiline', 'padding-left': 2, position: 'relative' },
      layers.field,
      layers.caret
    );
    return { area: host, host };
  }

  const host = box({ position: 'relative' }, layers.field, layers.caret);
  const area = box(
    { class: 'sigil-prompt-multiline', 'padding-left': 2 },
    box({ position: 'relative' }, gutter.gutter, gutter.active),
    host
  );
  return { area, host };
}

/**
 * What an insertion becomes under a character limit: as much of it as fits, cut
 * at a cluster.
 *
 * **The insertion's own clusters are what is counted, and that is enough.** It
 * looks like the result should be counted instead, since the two disagree --
 * a combining mark typed after an `e` is a cluster on its own and adds none to
 * the value -- and the first version of this did count the result, in a loop
 * that cut one cluster at a time until it fitted. The loop never ran. Inserting
 * at a cluster boundary can only *join* clusters, never split one more than it
 * joins: every segmentation rule but one forbids a break rather than making one,
 * and the one that does -- regional indicators pairing off from the start of a
 * run -- splits a pair only by joining the indicator in front of it into another.
 * So the value after an insertion of `n` clusters holds at most `n` more, and
 * taking the room's worth is always within the limit. `should never let a cut
 * insertion past the limit` is the property, walked over the joins there are.
 *
 * What it costs is that a mark that would join the last cluster of a full field
 * is refused, since it is a cluster of its own until it lands. A count that says
 * full and a field that changed anyway would be the stranger of the two.
 *
 * @param value - What has been typed.
 * @param inserted - What is being inserted, already normalized.
 * @param limit - The most clusters the value may hold.
 * @returns What to insert, which may be nothing.
 */
export function fitted(value: string, inserted: string, limit: number): string {
  const room = limit - graphemes(value).length;
  const clusters = graphemes(inserted);
  return room >= clusters.length ? inserted : clusters.slice(0, Math.max(0, room)).join('');
}

/**
 * How many rows a field may take, from what the caller asked for.
 *
 * **Enumerated rather than clamped**, which is the rule the typewriter's own
 * interval keeps and the trap it keeps it for: `Math.min(NaN, anything)` is
 * `NaN`, so a `rows` of `NaN` reached the measure as a height of `NaN` and the
 * layout engine was handed a box no arithmetic can place -- and a fractional one
 * reached it as a fractional height, which is the thing a declaration is refused
 * for.
 *
 * `Infinity` **passes through**, unlike the typewriter's interval, and the
 * difference is what the value means: there it is a wait with no end, and here
 * it is a field with no cap of its own, which the terminal then bounds. Said
 * precisely because the first version of this said it and did the opposite --
 * `Number.isFinite()` refused `Infinity` while the comment claimed the
 * `Math.min` below was what limited it, and the test named for the branch could
 * not tell a cap of ten from a cap of the terminal's room. Found by review.
 *
 * @param rows - What the caller asked for.
 * @returns A whole number of rows, or the default.
 */
function rowCap(rows: number | undefined, fallback = 10): number {
  // `rows >= 1` is what refuses `NaN`, since every comparison against it is
  // false -- so `Number.isFinite()` beside it was refusing `Infinity` as well,
  // which is the one value the comment above says passes through
  //
  // `fallback` is the palette's: its default is what the terminal has left
  // under the question rather than ten, and the rule about what a `rows` may be
  // is this one said once. Without it the palette had its own, and `Math.max(1,
  // NaN)` is `NaN` -- which blanked the list while keeping the empty message
  // hidden, because `rank >= NaN` is false for every row
  return rows !== undefined && rows >= 1 ? Math.floor(rows) : fallback;
}

/**
 * Asks for several lines of text.
 *
 * Enter inserts a newline, so submitting is a key of its own -- Ctrl-D by
 * default, and `submit` names another. That is the one thing that *had* to move
 * from `text()`; everything else here is the same editing rules over a list of
 * lines, shared through `editing.ts` rather than written twice. The caret is
 * painted into the frame rather than by moving the terminal's own cursor, which
 * is what keeps the region's repaint arithmetic honest and is not this ticket's
 * to renegotiate.
 *
 * **A pasted block keeps its line breaks**, which is the deliberate inverse of
 * what `text()` does with one. The two rules sit next to each other in
 * `editing.ts` so that the inversion is visible rather than discovered: a
 * one-line field flattens a paste because obeying a break there submits half an
 * address, and a multiline field keeps them because keeping them is the entire
 * point of having more than one line.
 *
 * @param opts - What to ask, and how to check the answer.
 * @returns What was typed.
 */
export function multiline(opts: MultilineOptions): Promise<string> {
  const terminal = opts.terminal ?? defaultTerminal;
  const submit = opts.submit ?? { ctrl: true, name: 'd' };

  // a key with no name is one `decodeKeys()` never produces, so a field given one
  // has no way to be submitted at all -- which is the hang `PromptError` exists
  // for, and is refused the way a choice list with nothing to offer is rather
  // than by quietly putting the default back
  if (submit.name === '') {
    return Promise.reject(
      new PromptError(`"${opts.message}" has no key to submit with: \`submit.name\` is empty`)
    );
  }
  // a limit of no characters is a field nobody can type in, and a fraction or a
  // `NaN` is a limit nothing can be counted against -- refused rather than read as
  // no limit, because a caller who set one is relying on the answer keeping to it.
  // `Infinity` is no limit, the way it is no row cap
  const limit = opts.charLimit;
  if (limit !== undefined && limit !== Infinity && !(Number.isInteger(limit) && limit >= 1)) {
    return Promise.reject(
      new PromptError(
        `"${opts.message}" has a \`charLimit\` that is not a whole number of at least one: ${limit}`
      )
    );
  }
  const counted = limit !== undefined && limit !== Infinity;
  /** Whether a value keeps to the limit, which is every value when there is none. */
  const fits = (candidate: string): boolean =>
    !counted || graphemes(candidate).length <= (limit as number);

  // a mark is drawn on every row, and `CellBuffer.put()` throws on a control
  // character -- so one here would take the first frame down rather than draw
  const mark = opts.gutter ?? '';
  if (/\p{Cc}/u.test(mark)) {
    return Promise.reject(
      new PromptError(`"${opts.message}" has a \`gutter\` holding a control character`)
    );
  }

  // through the same normalizer a paste goes through, so that the value holds
  // one spelling of a line break and every rule below can split on it
  const initial = pastedBlock(opts.initial ?? '');
  // an `initial` is something somebody wrote, so one over the limit is a bug and is
  // refused; a `value` is usually an earlier answer to a question that has changed
  // since, so one over it is dropped for `initial` -- the rule every prompt keeps
  if (!fits(initial)) {
    return Promise.reject(
      new PromptError(`"${opts.message}" has an \`initial\` longer than its \`charLimit\``)
    );
  }
  const given = typeof opts.value === 'string' ? pastedBlock(opts.value) : undefined;
  let value = given !== undefined && fits(given) ? given : initial;
  // after every refusal above, which are about the options rather than about how
  // the question is drawn, and before anything a drawn field needs
  if (asLines(opts)) {
    return lineMultiline(opts, submit, value, counted ? (limit as number) : undefined);
  }
  let cursor = value.length;
  let error: string | undefined;
  /**
   * The column a run of vertical moves is aiming for.
   *
   * Cleared by anything else, which is what makes Up-Up-Down end in the column
   * it started in rather than wherever the shortest row on the way left it.
   */
  let goal: number | undefined;
  /** The first row on screen, when the value is taller than the field. */
  let top = 0;

  return run<string>(opts, () => {
    const head = headWidths(opts.message, Math.max(1, terminal.width));
    const answer = answerSlot(head.rest);
    const { line, mark: headMark } = promptHead(opts.message, head.message, answer.beside);
    const complaint = note('sigil-prompt-error sigil-error');

    // the one key this field has that nobody would guess, and the only one it
    // lists: everything else is the editing a text field always has, and stays
    // in the chain below. Matched through the table, so the key the footer names
    // and the key that submits are one record
    const keys = promptKeys<Promise<{ value: string } | void>>();
    keys.on(
      { ctrl: submit.ctrl ?? false, meta: submit.meta ?? false, name: submit.name, shift: false },
      async () => {
        const failed = await opts.validate?.(value);
        if (typeof failed === 'string' && failed) {
          error = failed;
          draw();
          return;
        }
        return { value };
      },
      { description: __`submit` }
    );
    const footer = promptFooter(keys, terminal.width, opts.back);
    /** How many characters there are and may be, when there is a limit. */
    const count = textNode('', {
      class: 'sigil-prompt-count sigil-muted',
      display: counted ? 'flex' : 'none',
    });

    /** The columns under the question, before the gutter takes its share. */
    const indent = Math.max(1, Math.max(1, terminal.width) - 2);
    /**
     * The columns the field has, once the indent and the gutter are taken.
     *
     * Worked out again on every draw, because the gutter widens at a hundred lines
     * -- and computed rather than measured, for the reason the layout is.
     */
    let room = indent;
    /**
     * The rows the field may take before it scrolls.
     *
     * Capped by what is left under the question and over the error line and the
     * footer, which are reserved either way so that showing an error does not
     * push the last row of the field off the screen -- the rule the choice list
     * already keeps. The count is a row of its own when there is one.
     */
    const cap = Math.max(
      1,
      Math.min(rowCap(opts.rows), Math.max(1, terminal.height) - head.lines - 2 - (counted ? 1 : 0))
    );

    /**
     * The layout on screen, as a plain field.
     *
     * Computed in `draw()` at a room the component already knows rather than at
     * the width the box was given, which is the rule the single-line field keeps
     * -- `windowOf()` is handed `head.rest` -- and is what makes the measure and
     * the paint one answer rather than two that have to be kept in agreement.
     */
    let layout = layoutField(value, cursor, room);
    /** How many of its rows are on screen. */
    let visible = 1;
    /** The token per offset of what is on screen, or nothing while it is not highlighted. */
    let tokens: (string | undefined)[] | undefined;
    /**
     * The value the hook was last asked about, and what it said.
     *
     * Kept so a key that only moves the caret does not run a highlighter over the
     * whole value again: the tokens are a function of the value, and nothing else.
     */
    let highlighted: { tokens: (string | undefined)[]; value: string } | undefined;

    const frame = (): FieldFrame => ({ layout, tokens, top, visible });
    const { caret: caretLayer, field } = fieldLayers(frame);
    /** A layer per token the hook has named, made the first time it names one. */
    const layers = new Map<string, Element>();

    const numbered = opts.lineNumbers === true;
    let gutterFrame: GutterFrame = {
      active: undefined,
      digits: 0,
      mark,
      numbers: [],
      top: 0,
      visible: 1,
    };
    // no gutter at all unless one was asked for, so a field without one is the
    // tree it always was
    const gutter = numbered || mark !== '' ? gutterLayers(() => gutterFrame) : undefined;

    const { area, host } = fieldBox({ caret: caretLayer, field }, gutter);

    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      answer.under,
      area,
      box({ 'padding-left': 2 }, count),
      box({ 'padding-left': 2 }, complaint),
      footer
    );

    function draw(): void {
      setNote(complaint, error);

      // the placeholder is drawn by the field with its class switched rather than
      // by a layer of its own: one element cannot resolve two styles, and there
      // is only ever one of the two to draw
      const shown = value === '' ? opts.placeholder : undefined;

      // the placeholder is never highlighted, since it is not code anybody wrote
      tokens = undefined;
      if (opts.highlight && shown === undefined) {
        if (highlighted?.value !== value) {
          highlighted = { tokens: tokensOf(value, opts.highlight(value)), value };
          for (const token of new Set(highlighted.tokens)) {
            if (token !== undefined && !layers.has(token)) {
              const layer = tokenLayer(frame, field, token);
              layers.set(token, layer);
              // before the caret, which paints over whatever it marks
              host.insertBefore(layer, caretLayer);
            }
          }
        }
        tokens = highlighted.tokens;
      }

      const lines = shown === undefined ? value.split('\n').length : 1;
      const widths = gutter ? gutterWidth(lines, numbered, mark) : { digits: 0, width: 0 };
      room = Math.max(1, indent - widths.width);

      layout = layoutField(shown ?? value, shown === undefined ? cursor : 0, room);
      visible = Math.max(1, Math.min(layout.rows.length, cap));
      top = windowStart(layout.rows.length, layout.caret.row, visible, top);

      if (gutter) {
        // the placeholder is one line however it wraps, so it is numbered as `''`
        const numbers = gutterOf(shown === undefined ? value : '', layout);
        // the caret's line is numbered on the row it starts on, which is the
        // nearest numbered row at or above the caret's
        let active: number | undefined;
        for (let row = layout.caret.row; row >= 0 && active === undefined; row--) {
          active = numbers[row] === undefined ? undefined : row;
        }
        gutterFrame = { active, digits: widths.digits, mark, numbers, top, visible };
        gutter.gutter.invalidateMeasure();
        gutter.active.invalidatePaint();
      }

      if (counted) {
        const used = graphemes(value).length;
        count.setText(`${used}/${limit}`);
        // the warning role at the limit, because a key that inserts nothing there
        // otherwise reads as a key that did not work
        count.setProps({
          class: `sigil-prompt-count ${used >= (limit as number) ? 'sigil-warn' : 'sigil-muted'}`,
        });
      }

      field.setProps({
        class:
          shown === undefined
            ? 'sigil-prompt-field'
            : 'sigil-prompt-field sigil-prompt-placeholder sigil-muted',
      });
      field.invalidateMeasure();
      for (const layer of layers.values()) {
        layer.invalidatePaint();
      }
      caretLayer.invalidatePaint();
    }

    /**
     * What of an insertion the limit lets in, which is all of it when there is none.
     *
     * @param inserted - What a key or a paste would insert.
     * @returns What to insert.
     */
    function admit(inserted: string): string {
      return counted ? fitted(value, inserted, limit as number) : inserted;
    }

    /**
     * Moves the caret, which is the one place a cursor is written.
     *
     * Through `snap()` and clamped, so that an offset worked out from a row of
     * the *placeholder* -- which is what the rows describe while the value is
     * empty -- can never be stored as a cursor into the value.
     *
     * **Declared rather than claimed**: it cannot change an answer today and it
     * fails its own sabotage, because the one way an offset from the wrong
     * string gets here is with a value of `''` -- the placeholder shows only
     * then -- and every rule below answers the same for any offset into that.
     * What it buys is that this is the one place a cursor is written, so the
     * invariant every rule below reads is asserted here rather than assumed of
     * each of them.
     *
     * @param to - Where to put it.
     */
    function move(to: number): void {
      cursor = snap(value, Math.max(0, Math.min(to, value.length)));
    }

    /**
     * Moves the caret by rows, keeping the column it is aiming for.
     *
     * Going up from the first row and down from the last land on the ends of the
     * value, which is what a textarea does: there is no row to go to, and a caret
     * that moved nowhere reads as a key that did not work.
     *
     * @param by - How many rows, signed.
     */
    function vertical(by: number): void {
      goal ??= layout.caret.x;
      const to = layout.caret.row + by;

      if (to < 0) {
        move(0);
      } else if (to >= layout.rows.length) {
        move(value.length);
      } else {
        move(offsetIn(layout, value.length, to, goal));
      }
    }

    draw();

    return {
      // Ctrl-D is this field's submit key and `isAbort()` would otherwise take
      // it: end of input and "that is my answer" are the same gesture, and a
      // field escaped by the key that submits it has no way out. Ctrl-C is never
      // claimable, which `run()` is what enforces
      claims(k) {
        return keys.match(k) !== undefined;
      },

      async key(k) {
        error = undefined;

        const bound = keys.match(k);
        if (bound) {
          return bound(k);
        }

        const vertically = k.name === 'up' || k.name === 'down';
        const paging = k.name === 'pageup' || k.name === 'pagedown';
        const word = k.ctrl || k.meta;

        if (k.name === 'enter') {
          ({ cursor, value } = insertAt(value, cursor, admit('\n')));
        } else if (k.name === 'backspace') {
          ({ cursor, value } = word
            ? deleteRange(value, wordBefore(value, cursor), cursor)
            : deleteBefore(value, cursor));
        } else if (k.name === 'delete') {
          ({ cursor, value } = word
            ? deleteRange(value, cursor, wordAfter(value, cursor))
            : deleteAfter(value, cursor));
        } else if (k.ctrl && k.name === 'w') {
          ({ cursor, value } = deleteRange(value, wordBefore(value, cursor), cursor));
        } else if (k.meta && k.name === 'd') {
          ({ cursor, value } = deleteRange(value, cursor, wordAfter(value, cursor)));
        } else if (k.name === 'left') {
          move(word ? wordBefore(value, cursor) : boundary(value, cursor, -1));
        } else if (k.name === 'right') {
          move(word ? wordAfter(value, cursor) : boundary(value, cursor, 1));
        } else if (k.meta && k.name === 'b') {
          move(wordBefore(value, cursor));
        } else if (k.meta && k.name === 'f') {
          move(wordAfter(value, cursor));
        } else if (vertically) {
          vertical(k.name === 'up' ? -1 : 1);
        } else if (paging) {
          vertical(k.name === 'pageup' ? -visible : visible);
        } else if (k.ctrl && (k.name === 'home' || k.name === 'end')) {
          // the whole value rather than the line, which is the one place the
          // modifier means something here
          move(k.name === 'home' ? 0 : value.length);
        } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          move(lineStart(value, cursor));
        } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          move(lineEnd(value, cursor));
        } else if (k.ctrl && k.name === 'u') {
          ({ cursor, value } = deleteRange(value, lineStart(value, cursor), cursor));
        } else if (k.ctrl && k.name === 'k') {
          ({ cursor, value } = deleteRange(value, cursor, lineEnd(value, cursor)));
        } else {
          ({ cursor, value } = insertAt(value, cursor, admit(typedText(k) ?? '')));
        }

        // a run of vertical moves keeps the column it is aiming for and
        // everything else gives it up, which is the whole of what a goal column
        // is. Cleared after the move, because `vertical()` is what reads it
        if (!vertically && !paging) {
          goal = undefined;
        }

        draw();
      },

      paste(block: string): void {
        // the opposite of what `text()` does with a block, and the reason is
        // under `pastedBlock()`: the breaks are what a multiline field is for
        // under `pastedBlock()`: the breaks are what a multiline field is for.
        // Cut to what the limit lets in, at a cluster, so a paste that does not
        // fit keeps its beginning rather than being refused whole
        ({ cursor, value } = insertAt(value, cursor, admit(pastedBlock(block))));
        goal = undefined;
        draw();
      },

      settle(written: string): void {
        answered(headMark);
        footer.setProps({ display: 'none' });
        // one line in the log, for the reason `summaryOf()` records
        answer.show(summaryOf(written));
        for (const layer of [
          field,
          caretLayer,
          count,
          ...layers.values(),
          ...(gutter ? [gutter.gutter, gutter.active] : []),
        ]) {
          layer.setProps({ display: 'none' });
        }
        setNote(complaint, undefined);
      },

      view,
    };
  });
}

/**
 * Asks a yes or no question.
 *
 * @param opts - What to ask.
 * @returns The answer.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  // a starting answer is what Enter alone means, which is what `default` already
  // is -- so the two are one setting here, and the answer a person gave wins
  const fallback = typeof opts.value === 'boolean' ? opts.value : (opts.default ?? true);
  if (asLines(opts)) {
    return lineConfirm(opts, fallback);
  }

  return run<boolean>(opts, () => {
    // one catalog entry decides both what is drawn and what is accepted, so the
    // hint cannot be a false statement about the keys. `confirmKeys()` has why
    // that is one entry rather than three, and why English stays accepted
    const keys = confirmKeys(__`y/n`, fallback);
    const tail = textNode(keys.hint, {
      class: 'sigil-prompt-hint sigil-muted',
    });
    const head = headWidths(
      opts.message,
      Math.max(1, (opts.terminal ?? defaultTerminal).width),
      keys.hint
    );
    // the hint is reserved, so `yes` and `no` are beside the question at every
    // width the head is drawn at -- through the slot all the same, so that a
    // translation wider than its own hint goes under the question rather than
    // being cut
    const answer = answerSlot(head.rest);
    const { line, mark } = promptHead(opts.message, head.message, tail, answer.beside);

    return {
      key(k) {
        if (k.name === 'enter') {
          return { value: fallback };
        }

        // a modifier makes it a different key, which is the rule the key
        // sequences already keep -- the hint says `Y` rather than `ctrl-Y`, so
        // reading Ctrl-Y as yes is the hint being wrong about what it accepts
        if (k.ctrl || k.meta) {
          return;
        }

        const ch = k.name.toLowerCase();
        if (keys.yes.includes(ch)) {
          return { value: true };
        }
        if (keys.no.includes(ch)) {
          return { value: false };
        }
      },

      settle(yes: boolean): void {
        answered(mark);
        tail.setProps({ display: 'none' });
        answer.show(yes ? __`yes` : __`no`);
      },

      view: box({ class: 'sigil-prompt', 'flex-direction': 'column' }, line, answer.under),
    };
  });
}

/** One row of a choice list, and the parts of it that change. */
interface ChoiceRow {
  /** Whether the row can never be ticked or highlighted. */
  disabled: boolean;
  hint: Element;
  kind: Item<unknown>['kind'];
  label: Element;
  mark: Element;
  pointer: Element;
  row: Element;
}

/**
 * Builds the rows a choice list is drawn as.
 *
 * @param items - The choices and the separators between them.
 * @param ticked - Whether each row carries a tick box, for a multiselect.
 * @returns The rows and the box holding them.
 */
function choiceRows<T>(
  items: readonly Item<T>[],
  ticked: boolean
): { list: Element; rows: ChoiceRow[] } {
  const rows = items.map((item): ChoiceRow => {
    // the cursor on every row, hidden where it is not the active one: a text of
    // nothing but spaces measures zero, since `white-space: normal` collapses a
    // run of them, so a blank standing in for the cursor indented an inactive
    // row one column less than an active one. Hidden content still takes its
    // space, and reserving it with the same glyph is what keeps the column the
    // cursor's own width rather than a guess at it.
    const pointer = textNode(SYMBOL.cursor, { 'margin-right': 1, visibility: 'hidden' });
    const mark = textNode(SYMBOL.off, { class: 'sigil-choice-mark', 'margin-right': 1 });

    if (item.kind === 'separator') {
      // a heading starts in the cursor's column, over the labels it introduces,
      // where a row of labels is indented past the cursor and the box
      pointer.setProps({ display: 'none' });
      mark.setProps({ display: 'none' });
      const label = textNode(item.label, { class: 'sigil-choice-separator sigil-muted' });
      const hint = textNode('', { display: 'none' });
      return {
        disabled: true,
        hint,
        kind: 'separator',
        label,
        mark,
        pointer,
        row: box({ class: 'sigil-choice sigil-choice-heading' }, pointer, mark, label, hint),
      };
    }

    const { choice } = item;
    const reason =
      typeof choice.disabled === 'string' && choice.disabled
        ? choice.disabled
        : choice.disabled
          ? __`disabled`
          : choice.hint;
    const label = textNode(choice.label, item.offered ? {} : { class: 'sigil-muted' });
    const hint = textNode(reason ?? '', {
      class: 'sigil-choice-hint sigil-muted',
      display: reason ? 'flex' : 'none',
      'margin-left': 1,
    });

    if (!ticked) {
      mark.setProps({ display: 'none' });
    }

    return {
      disabled: !item.offered,
      hint,
      kind: 'choice',
      label,
      mark,
      pointer,
      row: box({ class: 'sigil-choice' }, pointer, mark, label, hint),
    };
  });

  return {
    list: box({ 'flex-direction': 'column' }, ...rows.map((row) => row.row)),
    rows,
  };
}

/**
 * The line under a list that says more about the highlighted choice.
 *
 * @param items - The choices.
 * @returns The line, how many rows to keep back for it, and a way to point it at
 *   a choice. Nothing is kept back when no choice has a description.
 */
function describing<T>(items: readonly Item<T>[]): {
  line: Element;
  reserved: number;
  show(active: number): void;
} {
  const line = textNode('', {
    class: 'sigil-choice-description sigil-muted',
    display: 'none',
    'margin-left': 2,
  });
  const any = items.some((item) => item.kind === 'choice' && item.choice.description);

  return {
    line,
    reserved: any ? 1 : 0,
    show(active: number): void {
      const item = items[active];
      const text = item?.kind === 'choice' ? item.choice.description : undefined;
      line.setText(text ?? '');
      line.setProps({ display: text ? 'flex' : 'none' });
    },
  };
}

/**
 * Which rows are on screen, keeping the active one among them.
 *
 * A canvas is a fixed number of rows and what does not fit is clipped, where the
 * live region wrote every line and let the terminal scroll -- which was broken in
 * its own way, since the repaint then walked the cursor up into the log. So a
 * list longer than the screen shows a window of itself and the window follows the
 * highlight, which is what every prompt library does and what stops an arrow key
 * moving a cursor nobody can see.
 *
 * Kept as the smallest move rather than as stored scroll state: the only thing
 * that has to be true is that `active` is on screen, and recomputing it from
 * `active` alone means nothing to keep in agreement.
 *
 * @param count - How many choices there are.
 * @param active - Which is highlighted.
 * @param room - How many rows the list may take.
 * @param from - Where the window starts now.
 * @returns Where it starts next.
 */
function windowStart(count: number, active: number, room: number, from: number): number {
  const visible = Math.max(1, Math.min(room, count));
  const start = Math.min(Math.max(0, from), Math.max(0, count - visible));

  if (active < start) {
    return active;
  }
  if (active >= start + visible) {
    return active - visible + 1;
  }
  return start;
}

/**
 * Draws which row is highlighted, which are ticked, and which are on screen.
 *
 * @param rows - The rows.
 * @param active - Which is highlighted.
 * @param start - The first row on screen.
 * @param room - How many rows the list may take.
 * @param ticked - Which are ticked, for a multiselect.
 */
function paintChoices(
  rows: ChoiceRow[],
  active: number,
  start: number,
  room: number,
  ticked?: ReadonlySet<number>
): void {
  const visible = Math.max(1, Math.min(room, rows.length));

  for (const [i, row] of rows.entries()) {
    const here = i === active;
    const shown = i >= start && i < start + visible ? 'flex' : 'none';

    if (row.kind === 'separator') {
      row.row.setProps({ display: shown });
      continue;
    }

    row.pointer.setProps({
      class: here ? 'sigil-choice-pointer' : '',
      visibility: here ? 'visible' : 'hidden',
    });
    row.row.setProps({
      class: here ? 'sigil-choice is-active sigil-accent' : 'sigil-choice',
      display: shown,
    });
    if (ticked) {
      const on = ticked.has(i);
      row.mark.setText(on ? SYMBOL.on : SYMBOL.off);
      row.mark.setProps({
        class: on
          ? 'sigil-choice-mark is-on sigil-success'
          : row.disabled
            ? 'sigil-choice-mark sigil-muted'
            : 'sigil-choice-mark',
      });
    }
  }
}

/**
 * The list a prompt was handed, checked and ready to walk.
 *
 * @param opts - The prompt's options.
 * @param value - An answer to start the cursor on. `undefined` is none.
 * @returns The items and where the cursor starts, or the error to reject with.
 */
function offering<T>(
  opts: Omit<SelectOptions<T>, 'value'>,
  value?: T
): { active: number; items: Item<T>[] } | PromptError {
  const items = toItems<T>(opts.choices);
  // a starting answer names a choice by what it answers with, and is dropped when
  // none on offer does: it may be an earlier answer to a list that has changed
  const named =
    value === undefined
      ? -1
      : items.findIndex((item) => isOffered(item) && sameValue(valueOf(item.choice), value));
  const wanted = named >= 0 ? named : Math.min(Math.max(0, opts.initial ?? 0), items.length - 1);
  const active = firstOffered(items, wanted);

  // a list with nothing in it and a list with nothing on offer are the same
  // question to the person at the keyboard, which is why they are one message
  if (active < 0) {
    return new PromptError(`"${opts.message}" has no choices to offer`);
  }
  return { active, items };
}

/**
 * Asks for one of a list.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen value.
 */
export function select<T = string>(opts: SelectOptions<T>): Promise<T> {
  const offer = offering(opts, opts.value);

  if (offer instanceof PromptError) {
    return Promise.reject(offer);
  }

  if (asLines(opts)) {
    return runLine(opts, choiceForm<T, T>(offer.items, offer.active, { heading: [opts.message] }));
  }

  const { items } = offer;
  let { active } = offer;
  let start = 0;
  const loop = opts.loop ?? true;
  const terminal = opts.terminal ?? defaultTerminal;

  /** The highlighted choice. It is always one, since the cursor only lands on those. */
  function current(): Choice<T> {
    return (items[active] as Extract<Item<T>, { kind: 'choice' }>).choice;
  }

  return run<T>(opts, () => {
    const head = headWidths(opts.message, Math.max(1, terminal.width));
    const answer = answerSlot(head.rest);
    const { line, mark } = promptHead(opts.message, head.message, answer.beside);
    const { list, rows } = choiceRows(items, false);
    const described = describing(items);
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      answer.under,
      list,
      described.line
    );

    /** The rows the list has, once the question and a description have taken theirs. */
    const room = (): number =>
      Math.max(1, Math.max(1, terminal.height) - head.lines - described.reserved);

    function draw(): void {
      start = windowStart(items.length, active, room(), start);
      paintChoices(rows, active, start, room());
      described.show(active);
    }

    draw();

    return {
      key(k) {
        if (k.name === 'enter') {
          return { value: valueOf(current()) };
        }
        // wrapping by default, because a list you cannot get to the end of by
        // going up is a list you have to know the length of
        if (k.name === 'up') {
          active = seek(items, active, -1, loop);
        } else if (k.name === 'down') {
          active = seek(items, active, 1, loop);
        } else if (k.name === 'home') {
          active = edge(items, 1);
        } else if (k.name === 'end') {
          active = edge(items, -1);
        }
        draw();
      },

      settle(): void {
        answered(mark);
        answer.show(shortOf(current()));
        // the list goes: what is left is the question and its answer, which is
        // the one line worth keeping in a log
        list.setProps({ display: 'none' });
        described.line.setProps({ display: 'none' });
      },

      view,
    };
  });
}

/**
 * Asks for any number of a list.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen values, in the order they are listed.
 */
export function multiselect<T = string>(opts: MultiselectOptions<T>): Promise<T[]> {
  const offer = offering(opts);

  if (offer instanceof PromptError) {
    return Promise.reject(offer);
  }

  const min = opts.min ?? (opts.required ? 1 : 0);
  const max = opts.max ?? Number.POSITIVE_INFINITY;

  // asked rather than compared, because every comparison with `NaN` is false: a
  // `max` of `NaN` would accept any number of choices and say nothing about it
  if (!Number.isInteger(min) || min < 0 || (max !== Infinity && !Number.isInteger(max))) {
    return Promise.reject(
      new PromptError(`"${opts.message}" has a min or max that is not a whole number`)
    );
  }
  if (min > max) {
    return Promise.reject(new PromptError(`"${opts.message}" has a min greater than its max`));
  }

  const { items } = offer;
  let { active } = offer;
  const offered = items.flatMap((item, i) => (isOffered(item) ? [i] : []));
  // a disabled choice is never ticked, whatever `selected` says -- or a starting
  // answer, which replaces every `selected` when there is one
  const given = Array.isArray(opts.value) ? (opts.value as readonly T[]) : undefined;
  const ticked = new Set<number>(
    offered.filter((i) => {
      const choice = (items[i] as Extract<Item<T>, { kind: 'choice' }>).choice;
      return given ? given.some((value) => sameValue(value, valueOf(choice))) : choice.selected;
    })
  );
  if (asLines(opts)) {
    return lineMultiselect(opts, items, ticked, complaint);
  }
  const loop = opts.loop ?? true;
  let error: string | undefined;
  let start = 0;
  const terminal = opts.terminal ?? defaultTerminal;

  function choiceAt(i: number): Choice<T> {
    return (items[i] as Extract<Item<T>, { kind: 'choice' }>).choice;
  }

  function chosen(): T[] {
    return [...ticked].sort((a, b) => a - b).map((i) => valueOf(choiceAt(i)));
  }

  /** What is wrong with a selection of this many, by default the one as it stands. */
  function complaint(count = ticked.size): string | undefined {
    if (count < min) {
      return min === 1 ? __`Choose at least one` : __`Choose at least ${min}`;
    }
    if (count > max) {
      return __`Choose at most ${max}`;
    }
    return undefined;
  }

  /** Ticks every choice on offer, or none if every one already is. */
  function all(): void {
    // a disabled choice is neither ticked by this nor unticked by it
    if (offered.every((i) => ticked.has(i))) {
      for (const i of offered) {
        ticked.delete(i);
      }
    } else {
      for (const i of offered) {
        ticked.add(i);
      }
    }
  }

  /** Flips every choice on offer. */
  function invert(): void {
    for (const i of offered) {
      if (ticked.has(i)) {
        ticked.delete(i);
      } else {
        ticked.add(i);
      }
    }
  }

  return run<T[]>(opts, () => {
    const head = headWidths(opts.message, Math.max(1, terminal.width));
    const answer = answerSlot(head.rest);
    const { line, mark } = promptHead(opts.message, head.message, answer.beside);
    const { list, rows } = choiceRows(items, true);
    const described = describing(items);
    const problem = note('sigil-prompt-error sigil-error');

    // the keys, each with the line the footer lists it as. The arrows are not
    // listed, for the reason `select()` has no footer at all: they are the keys
    // nobody has to be told. Ctrl-A is the older spelling of select-all and is
    // kept, unlisted, because one key per line is what the footer has room for
    const keys = promptKeys<{ value: T[] } | void>();
    keys.on('up', () => void (active = seek(items, active, -1, loop)));
    keys.on('down', () => void (active = seek(items, active, 1, loop)));
    keys.on(
      'space',
      () => {
        if (ticked.has(active)) {
          ticked.delete(active);
        } else {
          ticked.add(active);
        }
      },
      { description: __`select`, priority: 3 }
    );
    keys.on('a', all, { description: __`all`, priority: 2 });
    keys.on('ctrl+a', all);
    keys.on('i', invert, { description: __`invert`, priority: 1 });
    keys.on(
      'enter',
      () => {
        error = complaint();
        return error ? undefined : { value: chosen() };
      },
      { description: __`confirm`, priority: 3 }
    );

    const footer = promptFooter(keys, terminal.width, opts.back);
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      answer.under,
      list,
      described.line,
      box({ 'padding-left': 2 }, problem),
      footer
    );

    // the question's rows, the description's, the line an error would take and
    // the footer's: reserved either way, so that showing one does not push the
    // last choice off the screen
    const room = (): number =>
      Math.max(1, Math.max(1, terminal.height) - head.lines - 2 - described.reserved);

    function draw(): void {
      start = windowStart(items.length, active, room(), start);
      setNote(problem, error);
      paintChoices(rows, active, start, room(), ticked);
      described.show(active);
    }

    draw();

    return {
      key(k) {
        error = undefined;
        const done = keys.match(k)?.(k);
        if (done) {
          return done;
        }
        draw();
      },

      settle(values: T[]): void {
        answered(mark);
        answer.show(
          values.length
            ? [...ticked]
                .sort((a, b) => a - b)
                .map((i) => shortOf(choiceAt(i)))
                .join(', ')
            : __`none`
        );
        list.setProps({ display: 'none' });
        described.line.setProps({ display: 'none' });
        footer.setProps({ display: 'none' });
        setNote(problem, undefined);
      },

      view,
    };
  });
}

/**
 * Whether the person asked for line prompts, or `undefined` where nobody said.
 *
 * `SIGIL_ACCESSIBLE` is the third `SIGIL_` variable and is namespaced for the
 * reason `SIGIL_REDUCED_MOTION` is: there is no cross-tool convention for it,
 * so an unnamespaced name would be claiming a standard that does not exist. It
 * is a variable at all, where quiet deliberately is not one, because quiet is a
 * statement about one invocation and argv is where that goes; this is a
 * statement about the person, true of every invocation of every app they run,
 * which is what a shell profile is for. Nothing guesses it -- there is no
 * reliable way to ask whether a screen reader is listening, and a guess that
 * came out wrong would hand a sighted person a numbered list for every question.
 *
 * It reads the vocabulary a boolean property does, `1`, `on`, `yes`, `true` and
 * their opposites. A value that is neither falls through rather than deciding,
 * and an empty variable is unset, the two rules `forcedMotion()` keeps.
 *
 * ```js
 * import { forcedAccessible } from '@ttylabs/sigil/components';
 *
 * forcedAccessible(); // true with SIGIL_ACCESSIBLE=1, else undefined
 * ```
 *
 * @param env - The environment. The process's, by default.
 * @returns The preference, or `undefined` where nobody said.
 */
export function forcedAccessible(
  env: Record<string, string | undefined> = process.env
): boolean | undefined {
  const raw = env.SIGIL_ACCESSIBLE?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === '1' || raw === 'on' || raw === 'yes' || raw === 'true') {
    return true;
  }
  if (raw === '0' || raw === 'off' || raw === 'no' || raw === 'false') {
    return false;
  }
  return undefined;
}

/**
 * Whether a prompt is asked as lines.
 *
 * The option beats the variable, which is the most-specific-source rule every
 * fold here keeps. Read strictly rather than as truthy, because `'false'` is a
 * string somebody passes and reading it as on is the trap `setQuiet()` records.
 */
function asLines(opts: AccessibleOptions): boolean {
  return typeof opts.accessible === 'boolean' ? opts.accessible : (forcedAccessible() ?? false);
}

/** How a line form asks, and how it reads what comes back. */
interface LineForm<T> {
  /** The line the reply is typed after, written again after every complaint. */
  ask: string;
  /** Lines written once, above the first ask: the list a number is chosen from. */
  before?: readonly string[];
  /** Whether what is typed is written back. Off for a masked field. */
  echo: boolean;
  /** Cuts what is typed to what may be added to the reply, for a character limit. */
  fit?(reply: string, inserted: string): string;
  /** Whether a refused reply is handed back to edit, rather than asked for afresh. */
  keep?: boolean;
  /**
   * Reads a reply: the answer, and a line saying what it was when the reply alone
   * does not -- a `2` -- or a complaint to write before asking again, or the next
   * question to ask, for a prompt that is several of them: a directory gone into,
   * a search to pick from.
   */
  read(reply: string): LineReply<T> | Promise<LineReply<T>>;
  /** What the reply starts holding, written out as though it had been typed. */
  start?: string;
  /** The key that submits a multiline reply, where Enter is a line break. */
  submit?: SubmitKey;
}

/** An answer a line form read, and what to say about it. */
interface LineRead<T> {
  said?: string;
  value: T;
}

/** What reading a reply comes to: an answer, a complaint, or the next question. */
type LineReply<T> = LineForm<T> | LineRead<T> | string;

export type { LineRead as PromptLineRead, LineReply as PromptLineReply };

/** A line break, spelled for a terminal whatever its output translation is. */
const NEWLINE = '\r\n';

/** Text as it is written back, which is the same text with its breaks spelled. */
function echoed(text: string): string {
  return text.replaceAll('\n', NEWLINE);
}

/** Whether a key is a multiline field's submit key, modifiers and all. */
function submits(k: Key, submit: SubmitKey | undefined): boolean {
  return (
    submit !== undefined &&
    k.name === submit.name &&
    k.ctrl === (submit.ctrl ?? false) &&
    k.meta === (submit.meta ?? false) &&
    !k.shift
  );
}

/**
 * The question as the line a reply is typed after.
 *
 * No `?` mark in front and no colour on any of it: a screen reader reads a glyph
 * aloud, and a role drawn in colour is one it cannot hear. What is typed
 * follows one space after it, which is where the drawn prompt puts its field.
 */
function question(message: string, hint?: string): string {
  return hint ? `${message} ${hint} ` : `${message} `;
}

/**
 * Runs a prompt as lines: written once, echoed as typed, never redrawn.
 *
 * The drawn prompts' `run()` with everything that repaints taken out, and
 * nothing else changed about what a prompt is: the same terminal check, the same
 * router -- raw mode, the paste markers, Ctrl-C as a key -- the same abort and
 * back rules, and stdin given back the same way however it ends. Raw rather than
 * the terminal's own cooked mode because cooked mode cannot hide a password, sends
 * Ctrl-C as a signal that kills the process rather than a key that cancels, and
 * ends the stream for good on a Ctrl-D, so the next prompt would have nothing to
 * read. What cooked mode gives a screen reader is kept by hand: characters are
 * echoed where they are typed, and Backspace writes `\b \b`, the very bytes the
 * terminal's own echo writes, and never past the start of the line.
 *
 * The first form may be a function that builds it, for a question that has to
 * read something -- a directory -- before it can be written. It is called once
 * the terminal has been checked and the keys are being listened for, so Ctrl-C,
 * Escape and an abort are answered while the read is out, which is the freeze
 * `filePicker()` records otherwise; what is typed meanwhile waits behind it. One
 * that throws rather than rejecting is refused before anything is written, and
 * `lead` is written straight after it is called, so the question is on screen
 * before whatever it waits on.
 *
 * @param opts - Where to read and write.
 * @param first - What to ask and how to read the reply, or a function giving it.
 * @param lead - Lines written straight away, before `first` is.
 * @returns The answer.
 */
function runLine<T>(
  opts: PromptOptions,
  first: LineForm<T> | (() => LineForm<T> | Promise<LineForm<T>>),
  lead: readonly string[] = []
): Promise<T> {
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);

  // the rule the drawn prompts keep, and asked first for their reason. Asking as
  // lines is a different way to draw a question, not a different answer to
  // whether anybody is there to read one
  if (!terminal.isTTY || !stdin?.isTTY) {
    return Promise.reject(
      new PromptError(__`Cannot prompt for "${opts.message}" because the input is not a terminal`)
    );
  }
  if (opts.signal?.aborted) {
    return Promise.reject(opts.signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    let router: InputRouter;
    const ownRouter = opts.router === undefined;
    try {
      router = opts.router ?? createInput({ stdin, terminal });
    } catch (error) {
      // nothing has been written yet, so there is nothing to finish the line of
      reject(error);
      return;
    }

    let settled = false;
    /** The question being asked: the first, until a reply leads to another. */
    let form: LineForm<T> | undefined;
    let reply = '';
    /** One key at a time, for the reason `run()` records: a `validate` may be async. */
    let queue: Promise<void> = Promise.resolve();
    const write = (chunk: string): void => void terminal.write(chunk);

    function end(): void {
      settled = true;
      stop();
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      end();
      // what was written stays where it is, the question and whatever was typed
      // after it, and the next output starts under it: taking nothing back is the
      // whole of this form, and it holds for a cancel as much as for an answer
      write(NEWLINE);
      reject(error);
    }

    function ask(): void {
      write(form!.ask);
      if (form!.echo) {
        write(echoed(reply));
      }
    }

    /** Asks a question: the lines it is chosen from, then the line it is typed after. */
    function begin(next: LineForm<T>): void {
      form = next;
      reply = next.start ?? '';
      for (const line of next.before ?? []) {
        write(`${line}${NEWLINE}`);
      }
      ask();
    }

    /** Types text at the end of the reply, which is the only place a line has. */
    function type(input: string): void {
      const admitted = form!.fit ? form!.fit(reply, input) : input;
      if (admitted === '') {
        return;
      }
      reply += admitted;
      if (form!.echo) {
        write(echoed(admitted));
      }
    }

    /**
     * Takes clusters off the end of the line being typed, never past its start.
     *
     * A line already ended is a line already read, which is cooked mode's rule
     * and the only one a transcript can keep: going back up a row to erase it is
     * a redraw.
     */
    function erase(count: number): void {
      const start = reply.lastIndexOf('\n') + 1;
      for (let n = 0; n < count && reply.length > start; n++) {
        const at = boundary(reply, reply.length, -1);
        const width = stringWidth(reply.slice(at));
        reply = reply.slice(0, at);
        if (form!.echo && width > 0) {
          write('\b'.repeat(width) + ' '.repeat(width) + '\b'.repeat(width));
        }
      }
    }

    async function submit(): Promise<void> {
      write(NEWLINE);
      const read = await form!.read(reply);
      // an abort can land while a `validate` is still out
      if (settled) {
        return;
      }
      if (typeof read === 'string') {
        write(`${read}${NEWLINE}`);
        if (!form!.keep) {
          reply = '';
        }
        ask();
        return;
      }
      if ('ask' in read) {
        // the next question, under the reply that led to it: nothing above is
        // taken back, which is what keeps several questions one transcript
        begin(read);
        return;
      }
      end();
      if (read.said) {
        write(`${read.said}${NEWLINE}`);
      }
      resolve(read.value);
    }

    function press(k: Key, submitting: boolean): Promise<void> | void {
      if (form!.submit ? submitting : k.name === 'enter') {
        return submit();
      }
      if (k.name === 'enter') {
        type('\n');
      } else if (k.name === 'backspace') {
        erase(1);
      } else if (k.ctrl && k.name === 'u') {
        erase(Infinity);
      } else {
        // the arrows, Home, End and Delete edit somewhere other than the end of
        // the line, which a line that is never redrawn has no way to show -- so
        // they do nothing, as they do nothing in cooked mode
        type(typedText(k) ?? '');
      }
    }

    const offEnd = router.onEnd((error) => {
      fail(error ?? new PromptError(__`Input ended before the prompt was answered`));
    });
    const offKey = router.bind((event) => {
      event.stop();
      const k = event.key;
      const submitting = submits(k, form?.submit);

      if (isAbort(k) && !(k.name === 'd' && submitting)) {
        fail(new PromptError(__`Cancelled`, true));
        return;
      }
      if (opts.back && k.name === 'escape' && !k.ctrl && !k.meta && !k.shift) {
        fail(new PromptBack());
        return;
      }

      queue = queue
        .then(() => {
          if (!settled) {
            return press(k, submitting);
          }
        })
        .catch(fail);
    });
    const offPaste = router.onPaste((event) => {
      event.stop();
      const block = event.text;
      queue = queue
        .then(() => {
          if (!settled) {
            type(form!.submit ? pastedBlock(block) : pastedLine(block));
          }
        })
        .catch(fail);
    });
    const onAbort = (): void => fail(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    function stop(): void {
      offEnd();
      offKey();
      offPaste();
      opts.signal?.removeEventListener('abort', onAbort);
      if (ownRouter) {
        router.stop();
      }
    }

    let ready: LineForm<T> | Promise<LineForm<T>>;
    try {
      ready = typeof first === 'function' ? first() : first;
    } catch (error) {
      // nothing has been written yet, so there is nothing to finish the line of
      end();
      reject(error);
      return;
    }
    for (const line of lead) {
      write(`${line}${NEWLINE}`);
    }
    if (ready instanceof Promise) {
      // the keys queue behind it, so nothing typed meanwhile is read against a
      // question that has not been asked yet
      queue = ready
        .then((next) => {
          if (!settled) {
            begin(next);
          }
        })
        .catch(fail);
    } else {
      begin(ready);
    }
  });
}

/** `text()` and `password()` as a line. */
function lineText(opts: TextOptions, start: string): Promise<string> {
  // a masked field echoes nothing, so it says nothing about its default either --
  // read aloud is shown to everyone in the room -- and opens on no earlier answer,
  // since text nobody can see is not text anybody should be typing after
  const hidden = opts.mask !== undefined;
  return runLine<string>(opts, {
    ask: question(
      opts.message,
      opts.default && !hidden ? __`(default: ${opts.default})` : undefined
    ),
    echo: !hidden,
    keep: !hidden,
    async read(reply) {
      const answer = reply === '' ? (opts.default ?? '') : reply;
      const failed = await opts.validate?.(answer);
      return typeof failed === 'string' && failed ? failed : { value: answer };
    },
    start: hidden ? '' : start,
  });
}

/** `multiline()` as lines, ended by its submit key rather than by Enter. */
function lineMultiline(
  opts: MultilineOptions,
  submit: SubmitKey,
  start: string,
  limit: number | undefined
): Promise<string> {
  // spelled the way the drawn field's footer spells it, `ctrl-d`, through the same
  // translated labels -- one name for one key whichever form is asking
  const key = formatKey({
    ctrl: submit.ctrl ?? false,
    meta: submit.meta ?? false,
    name: submit.name,
    shift: false,
  });
  const hints = [__`(${keyLabel(key)} to submit)`];
  if (limit !== undefined) {
    hints.unshift(__n(limit, '(at most {0} character)', '(at most {0} characters)'));
  }
  return runLine<string>(opts, {
    // the reply starts on a line of its own, since it is several of them
    ask: `${question(opts.message, hints.join(' ')).trimEnd()}${NEWLINE}`,
    echo: true,
    fit: limit === undefined ? undefined : (reply, inserted) => fitted(reply, inserted, limit),
    keep: true,
    async read(reply) {
      const failed = await opts.validate?.(reply);
      return typeof failed === 'string' && failed ? failed : { value: reply };
    },
    start,
    submit,
  });
}

/** `confirm()` as a line: a word, or Enter alone for the default. */
function lineConfirm(opts: ConfirmOptions, fallback: boolean): Promise<boolean> {
  // the catalog entry the drawn prompt reads, so the hint is the same `(Y/n)` and
  // the keys it names are the keys accepted -- each as a whole reply here, beside
  // the word it stands for, in the catalog's language and in English
  const keys = confirmKeys(__`y/n`, fallback);
  const yes = new Set([...keys.yes, __`yes`.toLowerCase(), 'yes']);
  const no = new Set([...keys.no, __`no`.toLowerCase(), 'no']);
  return runLine<boolean>(opts, {
    ask: question(opts.message, keys.hint),
    echo: true,
    read(reply) {
      const said = reply.trim().toLowerCase();
      if (said === '') {
        return { value: fallback };
      }
      if (yes.has(said)) {
        return { value: true };
      }
      if (no.has(said)) {
        return { value: false };
      }
      return __`Answer ${keys.yes[0]} or ${keys.no[0]}`;
    },
  });
}

/**
 * A choice list written out as lines, numbering what can be chosen.
 *
 * Only a choice on offer is numbered, so the numbers run without a gap and a
 * number is always something that can be picked; a disabled one is still listed,
 * after a dash, because why it cannot be chosen is worth hearing. A separator
 * with words in it is a heading and is listed; one without -- the default rule
 * of box-drawing characters -- is a picture, and a screen reader reads each of
 * its characters aloud by name.
 *
 * @param items - The choices and the separators between them.
 * @returns The lines, and which item each number names.
 */
function numberedList<T>(items: readonly Item<T>[]): { lines: string[]; numbered: number[] } {
  const lines: string[] = [];
  const numbered: number[] = [];

  for (const [i, item] of items.entries()) {
    if (item.kind === 'separator') {
      if (/[\p{L}\p{N}]/u.test(item.label)) {
        lines.push(`  ${item.label}`);
      }
      continue;
    }

    const { choice } = item;
    const reason =
      typeof choice.disabled === 'string' && choice.disabled
        ? choice.disabled
        : choice.disabled
          ? __`disabled`
          : choice.hint;
    const label = reason ? `${choice.label} (${reason})` : choice.label;
    if (item.offered) {
      numbered.push(i);
      lines.push(`  ${numbered.length}. ${label}`);
    } else {
      lines.push(`  - ${label}`);
    }
    if (choice.description) {
      lines.push(`    ${choice.description}`);
    }
  }

  return { lines, numbered };
}

/** A whole number from 1 to `count` as typed, or `undefined`. */
function numberIn(token: string, count: number): number | undefined {
  if (!/^\d+$/.test(token)) {
    return undefined;
  }
  const n = Number(token);
  return n >= 1 && n <= count ? n : undefined;
}

/** How a numbered list of choices is asked, and what picking one comes to. */
interface LineChoice<V, T> {
  /** The lines above the list: the question, and whatever says where it is. */
  heading: readonly string[];
  /**
   * What a picked choice comes to, which is the answer and a `Chosen:` line when
   * this is not given. A string refuses it and asks for a number again -- a
   * `validate` -- and a form asks a question after it: the next directory.
   */
  pick?(choice: Choice<V>): LineReply<T> | Promise<LineReply<T>>;
}

export type { LineChoice as PromptLineChoice };

/**
 * A numbered list of choices as a line form: `select()`'s, and the one every
 * prompt that comes down to picking one of a list asks with.
 *
 * Numbers only, for the reason `select()` records: a list of versions labelled
 * `18`, `20` and `22` makes a reply of `20` mean two things.
 *
 * @param items - The choices, and the separators between them.
 * @param active - What Enter alone picks, which is always a choice on offer.
 * @param how - What is written above the list, and what a pick comes to.
 * @returns The form.
 */
function choiceForm<V, T>(
  items: readonly Item<V>[],
  active: number,
  how: LineChoice<V, T>
): LineForm<T> {
  const { lines, numbered } = numberedList(items);
  const count = numbered.length;
  // `active` is always on offer -- `offering()` lands on nothing else -- so the
  // highlight the drawn list would open on has a number, and it is the default
  const fallback = numbered.indexOf(active) + 1;

  return {
    ask: question(__`Choose a number from 1 to ${count}`, __`(default: ${fallback})`),
    before: [...how.heading, ...lines],
    echo: true,
    read(reply) {
      const said = reply.trim();
      const n = said === '' ? fallback : numberIn(said, count);
      if (n === undefined) {
        return __`Enter a number from 1 to ${count}`;
      }
      const choice = (items[numbered[n - 1] as number] as Extract<Item<V>, { kind: 'choice' }>)
        .choice;
      if (how.pick) {
        return how.pick(choice);
      }
      return { said: __`Chosen: ${shortOf(choice)}`, value: valueOf(choice) as unknown as T };
    },
  };
}

/**
 * A numbered list of choices as a line form, from choices as a prompt is handed
 * them -- for a prompt outside this file whose answer is one of a list.
 *
 * `select()`'s own list and its own reading of a number, so the two cannot come
 * to disagree about what `3` means, which choices are numbered, or how a
 * disabled one is said.
 *
 * @param message - The question, for the refusal of a list with nothing on offer.
 * @param entries - The choices, and the separators between them.
 * @param how - What is written above the list and what a pick comes to; `value`
 *   or `initial` is what Enter alone picks, as they are for `select()`.
 * @returns The form, or the error a list with nothing on offer is refused with.
 */
function lineChoice<V, T = V>(
  message: string,
  entries: readonly ChoiceEntry<V>[],
  how: LineChoice<V, T> & { initial?: number; value?: V }
): LineForm<T> | PromptError {
  const offer = offering<V>({ choices: entries, initial: how.initial, message }, how.value);
  return offer instanceof PromptError ? offer : choiceForm(offer.items, offer.active, how);
}

/**
 * The numbers a reply names, in the order it names them, ranges counted out.
 *
 * `multiselect()`'s reading, shared with every reply that is a list of numbers:
 * commas or spaces between them, and `2-4` or `4-2` for a run of them, so most of
 * a long list is not typed a number at a time. A number may come twice; whether
 * that means anything is the caller's to say.
 *
 * @param said - The reply.
 * @param count - The highest number there is.
 * @returns The numbers, or what is wrong with the first that is not one.
 */
function numbersIn(said: string, count: number): number[] | string {
  const out: number[] = [];
  for (const token of said.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    const from = numberIn(range ? (range[1] as string) : token, count);
    const to = range ? numberIn(range[2] as string, count) : from;
    if (from === undefined || to === undefined) {
      return __`"${token}" is not a number from 1 to ${count}`;
    }
    const step = to < from ? -1 : 1;
    for (let n = from; n !== to + step; n += step) {
      out.push(n);
    }
  }
  return out;
}

/**
 * Choices written out as a numbered list, and which choice each number names.
 *
 * For a prompt outside this file that reads its own reply -- several numbers,
 * an order -- over `select()`'s list.
 *
 * @param entries - The choices, and the separators between them.
 * @returns The lines, and the choice each number names, the first at index 0.
 */
function lineList<V>(entries: readonly ChoiceEntry<V>[]): {
  choices: Choice<V>[];
  lines: string[];
} {
  const items = toItems(entries);
  const { lines, numbered } = numberedList(items);
  return {
    choices: numbered.map((at) => (items[at] as Extract<Item<V>, { kind: 'choice' }>).choice),
    lines,
  };
}

/**
 * `multiselect()` as a numbered list and a reply of numbers.
 *
 * The reply **replaces** the selection rather than toggling it: a list of what is
 * wanted is a statement that stands on its own, where a toggle means holding the
 * current state in your head across a transcript. Enter alone keeps what was
 * already ticked, and the word `none` -- the one the drawn prompt settles on for
 * an empty answer -- is how to say nothing when something was.
 *
 * @param opts - What to ask.
 * @param items - The choices.
 * @param ticked - What starts ticked, which is what Enter alone answers.
 * @param complaint - What is wrong with a selection of a given size, if anything.
 * @returns The chosen values, in the order they are listed.
 */
function lineMultiselect<T>(
  opts: MultiselectOptions<T>,
  items: readonly Item<T>[],
  ticked: ReadonlySet<number>,
  complaint: (count: number) => string | undefined
): Promise<T[]> {
  const { lines, numbered } = numberedList(items);
  const count = numbered.length;
  const none = __`none`;
  const start = numbered.flatMap((item, at) => (ticked.has(item) ? [at + 1] : []));

  return runLine<T[]>(opts, {
    ask: question(
      __`Choose numbers from 1 to ${count}, separated by commas`,
      __`(default: ${start.length ? start.join(', ') : none})`
    ),
    before: [opts.message, ...lines],
    echo: true,
    read(reply) {
      const said = reply.trim();
      let chosen: Set<number>;
      if (said === '') {
        chosen = new Set(start);
      } else if (said.toLowerCase() === none.toLowerCase() || said.toLowerCase() === 'none') {
        chosen = new Set();
      } else {
        const named = numbersIn(said, count);
        if (typeof named === 'string') {
          return named;
        }
        chosen = new Set(named);
      }

      const problem = complaint(chosen.size);
      if (problem) {
        return problem;
      }
      const picked = [...chosen]
        .sort((a, b) => a - b)
        .map(
          (n) => (items[numbered[n - 1] as number] as Extract<Item<T>, { kind: 'choice' }>).choice
        );
      return {
        said: __`Chosen: ${picked.length ? picked.map(shortOf).join(', ') : none}`,
        value: picked.map(valueOf),
      };
    },
  });
}

/**
 * The prompt plumbing, for a component that is prompt-shaped and is not one of
 * the six.
 *
 * A palette is a filter field over a list, which is a prompt by every structural
 * measure -- a canvas, the one input router, a question, an answer, and
 * everything put back whichever way it ends -- and is not a *prompt* in the
 * sense this file is about: it reads the command registry rather than asking for
 * a value. So it borrows the machinery and lives in its own module.
 *
 * Exported rather than copied, because `run()` is the delicate half of a prompt
 * and a second reading of it is a second set of answers about the settled/detach
 * ordering, the throw that happens on the first frame before there is a handle to
 * tear down, and the one-key-at-a-time queue. The drawing helpers come with it
 * for the same reason the arithmetic does: `windowStart()` and `windowOf()` are
 * the two windows a list and a one-line field need, and both are the kind of
 * pure function this repository already publishes for its own testability.
 *
 * The line engine is here for the same reason, and for the prompts in modules of
 * their own that have a line form: `runLinePrompt()` is `run()`'s twin for
 * accessible mode, `promptAsLines()` is the switch, and `promptLineQuestion()`
 * the line a reply is typed after. An ejected `number()` imports them from the
 * package as it imports `runPrompt()`, so they are published the same way.
 *
 * The list, tree, picker and search prompts add three more beside them, for a
 * second reading of a numbered list would be a second answer about what `3`
 * means: `promptLineChoice()` is `select()`'s list and its reading of a number,
 * `promptLineList()` the list alone, and `promptLineNumbers()` `multiselect()`'s
 * reading of several numbers and ranges.
 *
 * Nothing here moved. The bodies are where they were, and the only edit to
 * `test/components/prompt.test.ts` is one added assertion about the surface this
 * block creates -- no existing test moved, which is the check an extraction
 * gets: a test that had to move is a behaviour that changed.
 */
export {
  answered as promptAnswered,
  answerFits as promptAnswerFits,
  asLines as promptAsLines,
  answerSlot as promptAnswerSlot,
  sameValue as promptSameValue,
  promptFooter,
  promptKeys,
  rowCap as promptRowCap,
  headWidths as promptHeadWidths,
  fitsBeside as promptTailFits,
  note as promptNote,
  promptHead as promptHeadLine,
  question as promptLineQuestion,
  underHead as promptUnderHead,
  run as runPrompt,
  runLine as runLinePrompt,
  setNote as setPromptNote,
  summaryOf as promptSummary,
  SYMBOL as PROMPT_SYMBOLS,
  toChoice as promptChoice,
  valueOf as promptValue,
  windowOf as promptWindow,
  windowStart as listWindow,
  lineChoice as promptLineChoice,
  lineList as promptLineList,
  numbersIn as promptLineNumbers,
};
export type {
  AnswerSlot as PromptAnswerSlot,
  Handlers as PromptHandlers,
  LineForm as PromptLineForm,
  Window as PromptWindow,
};
