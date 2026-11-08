/**
 * Captured console output: a bounded ring of lines, and the patch that fills it.
 *
 * Split out of the debug overlay (SIG-310) because `runApp()` captures the
 * console by default now and the overlay is a scroll box, a pane and a stats
 * line that an app which never opens it must not carry. The overlay re-exports
 * everything here, so `@ttylabs/sigil/components` is the surface it always was;
 * what moved is which module a runner that only wants the ring has to load.
 * Imports nothing of the renderer, the element tree or the stylesheet.
 */

/**
 * Which console method produced a line.
 *
 * `trace` is deliberately not one of them: it prints a stack rather than a line,
 * and replacing it with a formatted line would throw the stack away -- which is
 * the whole of what anybody calls it for.
 */
export type LogLevel = 'debug' | 'error' | 'info' | 'log' | 'warn';

/** The console methods the capture replaces, in a fixed order. */
const LEVELS: readonly LogLevel[] = ['debug', 'error', 'info', 'log', 'warn'];

/** One captured line. */
export interface LogEntry {
  /** When it was pushed, from the ring's clock. */
  at: number;
  /** Which console method it came through. */
  level: LogLevel;
  /**
   * A monotonic counter, so a reader can tell what it has already seen.
   *
   * Carried on the entry rather than derived from a position, because a `clear()`
   * leaves the positions meaning something different while the sequence numbers
   * go on meaning exactly what they did.
   */
  seq: number;
  /** The formatted text. One line: a multi-line write becomes several entries. */
  text: string;
}

/**
 * A bounded buffer of captured lines.
 *
 * **A ring rather than the unbounded buffer the full-screen backend keeps**, and
 * the reasoning inverts between the two rather than being inconsistent. That one
 * is unbounded because a cap that silently drops the start of a log is its own
 * trap -- that log is for *keeping*, and it is flushed to the main screen where
 * its reader is. This is for *watching*: the last few hundred lines are the ones
 * anybody reads off a pane, and an unbounded one behind a live overlay is a leak
 * for the life of the process.
 *
 * **And it is not a signal**, which is the ticket's own first loop hazard
 * answered rather than worked around. A signal write notifies, and a
 * notification reaches the renderer's scheduler -- so pushing a line would ask
 * for a frame, from inside whatever effect did the logging. What reads it is
 * `Renderer.onFrame()`, which is a frame that was already happening.
 */
export interface LogRing {
  /** The entry at a position, oldest first, or `undefined` past the end. */
  at(index: number): LogEntry | undefined;
  /** How many lines it holds at most. */
  readonly capacity: number;
  /** Drops everything, which counts as a change. */
  clear(): void;
  /** How many lines have fallen off the front since it was built. */
  readonly dropped: number;
  /** Every line it holds, oldest first. A copy. */
  entries(): readonly LogEntry[];
  /**
   * Pushes one write, split into a line per newline.
   *
   * Split because the pane draws one row per entry at a fixed height, so a write
   * holding a newline would be one row with two lines in it -- which overflows
   * its slot. A write that is only whitespace is still a line: a blank line in a
   * log is something somebody printed.
   *
   * @param level - Which console method.
   * @param text - The formatted text.
   */
  push(level: LogLevel, text: string): void;
  /** How many lines it holds. */
  readonly size: number;
  /**
   * How many times it has changed: a push of a line, or a `clear()`.
   *
   * What a reader compares to find out whether it has anything to do, which is
   * why a `clear()` counts. Not "how many lines have ever been pushed" -- that
   * is each entry's own `seq`, and a counter that answered both questions would
   * answer one of them wrongly the first time anything was cleared.
   */
  readonly version: number;
}

export interface LogRingOptions {
  /** How many lines to hold. Defaults to 500. A floor of one. */
  capacity?: number;
  /** Where `LogEntry.at` comes from. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called with each line once it is in the ring, in order.
   *
   * What lets a ring be a destination and a pass-through at once: `runApp()` in
   * inline mode writes every captured line above the live region the moment it
   * arrives, and keeps the ring for `app.logs` besides (SIG-310). A write that
   * wraps the ring is called once per line it split into, after the line has
   * pushed an older one out if it had to. Not a signal and not a way to ask for a
   * frame -- see `LogRing` -- and a throw from it propagates to whoever called
   * `console.log()`, which is where a broken sink should be heard.
   */
  onPush?: (entry: LogEntry) => void;
}

/** How many lines a ring holds when nobody says. */
const CAPACITY = 500;

/**
 * Builds a ring.
 *
 * @param opts - The capacity and the clock.
 * @returns The ring.
 */
export function createLogRing(opts: LogRingOptions = {}): LogRing {
  // `Math.max(1, ...)` is not the whole guard, because `Math.max(1, NaN)` is
  // `NaN`: a ring of `NaN` slots holds `size < NaN`, which is false, so the
  // first push wraps into slot `NaN % NaN` and every line after it is lost
  // while `size` stays zero. The same trap `readInt()` and the typewriter's
  // interval already carry an entry for -- a comparison against `NaN` is false
  // in both directions, so the floor has to be asked about the value's shape
  const asked = opts.capacity;
  const capacity =
    typeof asked === 'number' && Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : CAPACITY;
  const clock = opts.now ?? Date.now;
  const onPush = opts.onPush;
  /**
   * The slots, which only ever grow to `capacity`.
   *
   * Allocated as it fills rather than up front, so a ring of five hundred that
   * nothing ever logs to costs one empty array.
   */
  const slots: LogEntry[] = [];
  /** Where the oldest entry is, once the ring has wrapped. */
  let head = 0;
  let size = 0;
  let dropped = 0;
  let seq = 0;
  let version = 0;

  const ring: LogRing = {
    at(index: number): LogEntry | undefined {
      if (!Number.isInteger(index) || index < 0 || index >= size) {
        return undefined;
      }
      return slots[(head + index) % capacity];
    },

    capacity,

    clear(): void {
      slots.length = 0;
      head = 0;
      size = 0;
      version++;
    },

    get dropped() {
      return dropped;
    },

    entries(): readonly LogEntry[] {
      const found: LogEntry[] = [];
      for (let i = 0; i < size; i++) {
        const entry = slots[(head + i) % capacity];
        if (entry !== undefined) {
          found.push(entry);
        }
      }
      return found;
    },

    push(level: LogLevel, value: string): void {
      const at = clock();
      // split on either line ending, because what reaches here is whatever
      // somebody passed to `console.log` and a string read off a file on Windows
      // carries CRLF. A single trailing newline is the one a `console.log` would
      // have added itself and is not a blank line somebody wrote
      const lines = value.replace(/\r?\n$/, '').split(/\r?\n/);
      for (const line of lines) {
        const entry: LogEntry = { at, level, seq: seq++, text: line };
        if (size < capacity) {
          slots[(head + size) % capacity] = entry;
          size++;
        } else {
          // wrapped: the slot the oldest entry is in is the slot the newest goes
          // into, and the head moves on to what is now the oldest
          slots[head] = entry;
          head = (head + 1) % capacity;
          dropped++;
        }
        version++;
        onPush?.(entry);
      }
    },

    get size() {
      return size;
    },

    get version() {
      return version;
    },
  };

  return ring;
}

/** What `captureConsole()` hands back. */
export interface ConsoleCapture {
  /**
   * Whether **this** call was the one that replaced the console methods.
   *
   * `false` where a capture was already installed, which is the rule
   * `hideCursor()`, `setRawMode()` and `enableBracketedPaste()` already keep:
   * put back what *you* attached, and say whether there was anything to put
   * back. A second capture is a no-op reporting `false` rather than an error,
   * because two live overlays in one process is a thing that can happen and is
   * not a failure -- the first one's ring is the one being filled.
   */
  readonly installed: boolean;
  /**
   * Puts back what this call replaced.
   *
   * Idempotent, and a no-op for a capture that did not install. A method whose
   * current value is no longer the one this installed is **left alone**: that is
   * somebody else's patch over ours, and "put back what you attached" taken
   * literally means not removing a patch we did not attach.
   *
   * What that leaves behind is an orphan, and it is inherent rather than a hole:
   * their patch is holding *ours* as its original, so when they restore, our
   * patch is live with nobody left holding the real method -- and the other
   * answer, writing our original over theirs, breaks their restore instead.
   * Two parties patching one global without coordinating cannot both be put
   * back, so what this does is say so rather than report a success it did not
   * have. The latch is freed either way, because holding it would let one
   * foreign patch refuse every later capture for the life of the process.
   *
   * @returns Whether the console is back. `false` for a capture that did not
   *   install, for a call made once it already was, and for one that found a
   *   method somebody else had patched over -- which stays **retryable**, so a
   *   later call made after they restore puts that one back and answers `true`.
   */
  restore(): boolean;
}

export interface CaptureOptions {
  /**
   * The console to patch. Defaults to the global one.
   *
   * A parameter so that a test can exercise the patching without the suite's own
   * reporter losing its console, which is the same seam `ReportStream` is in the
   * toolchain. A capture installed on an object of its own is still exclusive of
   * a capture installed on the global one, for the reason the latch records.
   */
  console?: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
}

/** What one installation replaced, so that it can be put back exactly. */
interface Installed {
  /** What was there before, per level. */
  originals: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
  /** What was put there, so a patch over ours is not clobbered. */
  patched: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
  /** The object patched, which is the global console unless a test said otherwise. */
  target: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
}

/**
 * The live installation, if there is one.
 *
 * Module scope rather than per call, because the thing being guarded is a
 * **global**: two captures racing over `console.log` would each record the
 * other's patch as the original, and whichever restored second would put the
 * first one's patch back for ever. One latch is what makes `installed` a true
 * statement rather than a hopeful one.
 */
let active: Installed | undefined;

/** A capture that did not install, which is one object rather than one per call. */
const NOT_INSTALLED: ConsoleCapture = { installed: false, restore: () => false };

/**
 * Replaces the console methods with ones that push into a ring.
 *
 * Nothing is forwarded to the real console, and that is the feature rather than
 * an omission: forwarding into a full-screen backend's held buffer is exactly
 * the failure this exists for, and forwarding past it to the raw stream would
 * write into the alternate screen the renderer is diffing. The ring is the
 * destination. Anything that has to reach a file has `DEBUG` and `src/debug/`,
 * which is a different feature wearing the same hat.
 *
 * **`runApp()` calls this for you** and owns the pairing (SIG-310): it installs
 * one into a ring of its own, exposes it as `app.logs`, and puts the console back
 * on every way out. An app that installs its own before `runApp()` gets this one's
 * `installed: false` answer from the runner, which then leaves it alone -- the
 * patch is global, so one of the two owns it.
 *
 * @param ring - Where the lines go.
 * @param opts - The console to patch.
 * @returns Whether this call installed, and how to put it back.
 */
export function captureConsole(ring: LogRing, opts: CaptureOptions = {}): ConsoleCapture {
  if (active !== undefined) {
    return NOT_INSTALLED;
  }

  const target = (opts.console ?? console) as Partial<
    Record<LogLevel, (...args: unknown[]) => void>
  >;
  const installed: Installed = { originals: {}, patched: {}, target };
  // asked for here rather than imported: `node:util` brings `worker_threads`
  // and the stream stack behind it, and the components entry that holds this is
  // loaded by every app that draws anything, overlay or not. SIG-328
  const { format } = process.getBuiltinModule('node:util');

  // recorded before anything is replaced, and unwound on the way out of a
  // throw: `format()` is Node's own and a property assignment on a frozen or
  // accessor-backed console can throw, so a half-installed capture is reachable
  // -- and half of a patched console with nothing holding the originals is worse
  // than none of one
  try {
    for (const level of LEVELS) {
      const original = target[level];
      const patch = (...args: unknown[]): void => {
        ring.push(level, format(...args));
      };
      installed.originals[level] = original;
      installed.patched[level] = patch;
      target[level] = patch;
    }
  } catch (error) {
    for (const level of LEVELS) {
      if (installed.patched[level] !== undefined && target[level] === installed.patched[level]) {
        restoreOne(installed, level);
      }
    }
    throw error;
  }

  active = installed;

  /**
   * Which methods this call has managed to put back.
   *
   * Per level rather than one flag, because a restore that could not put a
   * method back has to stay **retryable** for that one: somebody else's patch
   * over ours is holding ours as its original, so the moment they restore, our
   * patch is what is live and a second `restore()` can put the real method back.
   * A single latch made that unreachable, and the sabotage pass is what said so
   * -- removing it was *better* for that sequence, which is not something a fast
   * path can be.
   *
   * A retry is safe because `restoreOne()` only ever writes where our own patch
   * is still the one there: a capture installed in between holds the console, and
   * a retry leaves it alone exactly as the first call left the foreign patch.
   */
  const done = new Set<LogLevel>();
  return {
    installed: true,
    restore(): boolean {
      if (done.size === LEVELS.length) {
        return false;
      }
      // the latch goes on the first call whatever it managed, because holding it
      // would let one foreign patch refuse every later capture for the life of
      // the process
      if (active === installed) {
        active = undefined;
      }
      // no `done.has()` check in front of this, and the sabotage pass is why: a
      // level already put back is one whose patch is no longer ours, so
      // `restoreOne()` refuses it and the `add` is never reached -- the guard
      // could not change an answer, which is what this repo deletes rather than
      // comments
      for (const level of LEVELS) {
        if (restoreOne(installed, level)) {
          done.add(level);
        }
      }
      return done.size === LEVELS.length;
    },
  };
}

/**
 * Puts one method back, and only where ours is still the one there.
 *
 * @param installed - What this installation recorded.
 * @param level - Which method.
 * @returns Whether it put that one back.
 */
function restoreOne(installed: Installed, level: LogLevel): boolean {
  const { originals, patched, target } = installed;
  if (target[level] !== patched[level]) {
    // somebody patched over ours. Removing theirs is not "putting back what you
    // attached", and the original they are holding is ours -- so leaving it is
    // the only answer that does not break their restore
    return false;
  }
  const original = originals[level];
  if (original === undefined) {
    delete target[level];
  } else {
    target[level] = original;
  }
  return true;
}
