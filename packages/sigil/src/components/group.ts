import { ansi as defaultAnsi } from '../ansi/index.js';
import { box, renderToString, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { mountLevel } from './mount.js';
import { PromptError } from './prompt.js';

/**
 * Whether something a prompt rejected with is a person leaving.
 *
 * A predicate over a caught error rather than a value a prompt resolves with:
 * every prompt still rejects, and `PromptError.aborted` is what separates Ctrl-C
 * from a prompt reached where nobody can answer it. That second kind is a bug in
 * the program's wiring, so it is not a cancel and a `catch` that treated it as
 * one would hide the very failure `PromptError` exists to make loud.
 *
 * @param error - Whatever was caught.
 * @returns `true` for a `PromptError` raised by the person cancelling.
 */
export function isCancel(error: unknown): error is PromptError {
  return error instanceof PromptError && error.aborted;
}

/**
 * The steps of a group, as an object of named functions.
 *
 * Each step is handed what the steps before it answered. The type cannot say
 * *which* those are -- object keys have an order at runtime and none in the type
 * system -- so every other step's answer is offered as optional, and a step reads
 * the ones it knows come first.
 *
 * **`T` is inferred from what the steps resolve with, and that stops working for
 * a step that reads its argument.** Such a step is contextually typed from `T`,
 * which is what is being inferred, so TypeScript fixes `T` before it has looked
 * at that step's return -- the key is then `unknown` in the result. Measured on
 * TypeScript 7 over four spellings of this type, clack's own included. Name the
 * shape, `group<{ name: string; greeting: string }>({ ... })`, and every step is
 * typed and checked against it; leave it off and every step that ignores its
 * argument is still inferred.
 */
export type GroupSteps<T> = {
  [K in keyof T]: (answers: Partial<Omit<T, K>>) => Promise<T[K]> | T[K];
};

export interface GroupOptions<T> {
  /**
   * Called with the answers collected so far when a step is cancelled.
   *
   * What it does decides what `group()` does. Returning nothing leaves the
   * `PromptError` to be rethrown; **throwing replaces it**, and so does
   * *returning* an `Error`, the way a `beforeError` hook may replace an error and
   * never suppress one. A group has no result to hand back for steps that did not
   * run, so there is no way to swallow the cancel -- which is also why the
   * partial answers are an argument rather than a return value.
   *
   * Not called for a step that fails for any other reason.
   */
  onCancel?: (partial: Partial<T>, error: PromptError) => Error | Promise<Error | void> | void;
}

/**
 * Runs prompts in order and collects what they answered.
 *
 * A step is any async function, usually a prompt, so a title or a list of
 * choices that depends on an earlier answer is a closure over the answers it is
 * handed. Steps run one at a time in key order -- the order `Object.keys()` gives,
 * so a key that reads as an integer is first, as it is anywhere in JavaScript.
 *
 * A step that is cancelled calls `onCancel` and rethrows. A step that throws
 * anything else is a bug in the step: it propagates untouched and `onCancel` is
 * not told, because "the person left" and "the program is wrong" are different
 * things to report.
 *
 * Going back a step is not offered.
 *
 * @param steps - The named steps.
 * @param opts - What to do on a cancel.
 * @returns The answers, keyed by step.
 */
export async function group<T>(steps: GroupSteps<T>, opts: GroupOptions<T> = {}): Promise<T> {
  const answers: Partial<T> = {};

  for (const key of Object.keys(steps) as (keyof T & string)[]) {
    const step = steps[key];
    if (typeof step !== 'function') {
      throw new TypeError(`group() step "${key}" must be a function`);
    }

    let value: T[keyof T & string];
    try {
      // a copy, so a step that writes to what it was handed cannot change an
      // answer a later step reads
      value = await step({ ...answers });
    } catch (error) {
      if (!isCancel(error)) {
        throw error;
      }

      const replaced = await opts.onCancel?.(answers, error);
      throw replaced instanceof Error ? replaced : error;
    }

    // defined rather than assigned: a step called `__proto__` is legal and an
    // assignment would set the prototype and drop the answer
    Object.defineProperty(answers, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  return answers as T;
}

/** The marks a session's frame is written with, matching the spinner's. */
const MARKS = { cancel: '✖', intro: '▶', outro: '✔' } as const;

export interface FrameOptions extends StyledOptions {
  /** Whether this is chrome that `--quiet` should silence. Defaults to the process's request. */
  quiet?: boolean;
  /** The terminal to write through. Defaults to the process's. */
  terminal?: Terminal;
}

/**
 * Writes one framing line to stderr.
 *
 * Stderr, because a command's `run()` returns data for a serializer to present
 * and a prompt's own chrome must not corrupt it: `mycli init --json | jq` has to
 * receive JSON whatever the session said around the questions. Nothing is written
 * when stdout is not a terminal -- the prompts reject there, so there is no
 * session to frame -- or when stderr is not one, or when the process was asked to
 * be quiet.
 *
 * Drawn through the same cascade as every other built-in rather than with a
 * hard-coded colour, so a theme restyles it. It is plain output and not a live
 * region: nothing on a frame changes, and claiming the region would evict a
 * spinner for a line that stays.
 *
 * @param kind - Which mark and role.
 * @param message - What to say.
 * @param opts - Where to write and how to style.
 */
function frame(kind: keyof typeof MARKS, message: string, opts: FrameOptions): void {
  const terminal = opts.terminal ?? defaultTerminal;

  if (!terminal.isTTY || !terminal.stderr.isTTY || mountLevel({ ...opts, terminal }) === 'quiet') {
    return;
  }

  const role = { cancel: 'sigil-error', intro: 'sigil-accent', outro: 'sigil-success' }[kind];
  const tree = box(
    { class: 'sigil-session' },
    textNode(MARKS[kind], {
      class: `sigil-symbol ${role}`,
      'flex-shrink': 0,
      'margin-right': 1,
    }),
    textNode(message, { class: kind === 'intro' ? 'sigil-heading' : role })
  );

  const out = renderToString(tree, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    width: Math.max(1, terminal.width),
  });
  terminal.writeErr(`${out}\n`);
}

/**
 * Opens a session, above its first prompt.
 *
 * @param message - The title.
 * @param opts - Where to write and how to style.
 */
export function intro(message: string, opts: FrameOptions = {}): void {
  frame('intro', message, opts);
}

/**
 * Closes a session that ran to the end.
 *
 * @param message - The closing line.
 * @param opts - Where to write and how to style.
 */
export function outro(message: string, opts: FrameOptions = {}): void {
  frame('outro', message, opts);
}

/**
 * Closes a session that was left.
 *
 * @param message - What to say. `Cancelled` where it is omitted.
 * @param opts - Where to write and how to style.
 */
export function cancel(message: string = __`Cancelled`, opts: FrameOptions = {}): void {
  frame('cancel', message, opts);
}
