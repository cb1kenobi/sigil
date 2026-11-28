/**
 * The history a REPL keeps: entries in order, and optionally a file they survive in.
 *
 * Not a component and nothing in it draws. It is the half of a REPL that has to be
 * right when two of them run at once, which is a property of a file rather than of
 * a prompt, so it is a module of its own and is tested as one.
 *
 * ```js
 * import { createHistory, replHistoryFile } from '@ttylabs/sigil/components/repl-history';
 *
 * const history = createHistory({ file: replHistoryFile('mycli'), max: 500 });
 * history.add('deploy prod');
 * history.entries; // ['deploy prod'], and the file holds it too
 * ```
 *
 * **The file is append-only, one JSON string a line, and a line is one write.** An
 * entry may hold a line break -- `isContinued()` joins a multiline entry with one --
 * and a JSON string is a line break that cannot be one, so no entry can be read as
 * two. `O_APPEND` puts every write at the end of the file whatever the writers
 * before it did, so two REPLs appending at once interleave whole lines and neither
 * overwrites the other. What is never done is read the file, change it and write it
 * back on every entry, which is the shape that loses one.
 *
 * **Trimming is the only thing that rewrites, and it takes a lock.** The file is cut
 * back to `max` entries when it holds more than a quarter over that -- not on every
 * load, so a file at its cap is not rewritten by every session -- by writing the
 * kept entries to a temporary file and renaming it over the original, so a reader
 * sees the old file or the new one. An append in the middle of that would land in a
 * file about to be replaced, so both take a lock file (`<file>.lock`, created
 * exclusively) for the moment they need it: an append waits for a trim, which is
 * milliseconds, and a trim that cannot get the lock does not happen. A lock older
 * than ten seconds belongs to a process that died, and is taken over.
 *
 * **A failure is never the REPL's.** A history that cannot be read or written
 * -- no permission, a full disk, a directory in the way -- is reported once to
 * `onError` and the in-memory history carries on, since a prompt that dies because
 * it cannot remember what was typed is worse than one that forgets.
 */

import { writeAtomicSync } from '../config/atomic.js';
import { state } from '../paths.js';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface HistoryOptions {
  /**
   * The file entries are kept in, shared with every REPL that names it. Without
   * one the history lives in memory and dies with the process.
   */
  file?: string;
  /** How many entries are kept, in memory and in the file. Defaults to 1,000. A floor of one. */
  max?: number;
  /**
   * Called with what a read or a write of the file threw, at most once per kind of
   * failure. Without one a failure is dropped: the history goes on in memory.
   */
  onError?: (error: unknown) => void;
}

export interface History {
  /**
   * Appends an entry, unless it is blank or the same as the one before it.
   *
   * Other writers' entries are read first, so "the one before it" is the last
   * entry in the file and not the last this process wrote.
   *
   * @param line - What was submitted. A multiline entry holds its line breaks.
   * @returns Whether it was kept.
   */
  add(line: string): boolean;
  /** The entries, oldest first. A copy. */
  readonly entries: readonly string[];
  /** The file, if there is one. */
  readonly file: string | undefined;
  /** How many entries are kept at most. */
  readonly max: number;
  /**
   * Rewrites the file now with the newest `max` entries, under the lock.
   *
   * Done for you when a file is loaded that has grown a quarter past its cap, and
   * here for a session that runs long enough to want it. Nothing is rewritten, and
   * nothing is lost, where another process holds the lock: it is asked again later.
   */
  trim(): void;
  /**
   * Reads what other writers have appended since this one last looked, which is
   * how a REPL started a minute ago hears of what a second one ran.
   */
  sync(): void;
}

/** How many entries are kept when nobody says. */
const MAX = 1000;

/** How long a lock may stand before it is taken to be a dead process's, in ms. */
const STALE_LOCK = 10_000;

/** How long a call that is refused because somebody has the file is retried, in ms. */
const BUSY_WAIT = 2000;

/** How often a waiter looks at whether the lock it waits for is stale, in ms. */
const LOOK_EVERY = 500;

/** How long an append is retried when the file is refused, in ms. */
const APPEND_WAIT = 250;

/** How long an append waits for the lock once it has failed to get it, and after any success it is `LOCK_WAIT` again. */
const LOCK_RETRY = 250;

/**
 * How long a write waits for the lock, in ms.
 *
 * Long, because what it is waiting for is a trim, which is milliseconds, or a dead
 * process's lock, which is taken over after ten seconds: giving up sooner writes an
 * entry into a file that is about to be replaced, which is the loss the lock is for.
 */
const LOCK_WAIT = 5000;

/**
 * Where an app's history belongs: its name under the XDG state directory.
 *
 * @param name - The app's name, which is the directory.
 * @param file - The file in it. Defaults to `history`.
 * @returns The path, or `undefined` where the platform has no state directory to put it in.
 */
export function replHistoryFile(name: string, file = 'history'): string | undefined {
  return state(name, file);
}

/**
 * Reads a file's lines as entries.
 *
 * A line that is not a JSON string is dropped rather than refused: the file is the
 * user's to edit and a hand-written line, or one cut short by a full disk, is not a
 * reason to lose the rest.
 *
 * @param text - The file's text.
 * @returns The entries, in order, with consecutive repeats collapsed.
 */
function parse(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof entry === 'string' && entry.trim() !== '' && entry !== out.at(-1)) {
      out.push(entry);
    }
  }
  return out;
}

/** Sleeps without spinning, which `Atomics.wait` on a private buffer does. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether a file system error is somebody else being in the way rather than a fault.
 *
 * `EEXIST` is, everywhere: the lock is held. On Windows so are `EPERM`, `EBUSY` and
 * `EACCES`, which is what creating a file that another process has just unlinked and
 * not yet finished letting go of answers (delete-pending: the name is still there and
 * cannot be opened), and what opening a file for a moment under a virus scanner or a
 * rename answers -- where POSIX says `EEXIST` or nothing at all. `renameWithRetry()`
 * records the same set for its target (SIG-415). Read per call, for the reason that one
 * is, so the Windows half can be tested on the machine it is written on.
 */
function contended(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'EEXIST' ||
    (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'))
  );
}

/**
 * Runs `fn`, again after a moment while the system says somebody is in the way.
 *
 * By the clock and not by a count: `Atomics.wait()` for a millisecond is a Windows
 * timer tick -- fifteen -- on some machines, so a count of tries is a different number
 * of seconds from one runner to the next.
 *
 * @param fn - A single file system call, safe to repeat.
 * @param ms - How long to keep trying.
 */
function untilFree(fn: () => void, ms = BUSY_WAIT): void {
  const until = Date.now() + ms;
  for (;;) {
    try {
      fn();
      return;
    } catch (error) {
      if (Date.now() >= until || !contended(error)) {
        throw error;
      }
      sleep(1);
    }
  }
}

/**
 * Runs `fn` holding the file's lock, or says it could not get it.
 *
 * @param file - The history file.
 * @param wait - How long to wait for it, in ms.
 * @param fn - What to do while holding it.
 * @returns Whether the lock was held, and so whether `fn` ran.
 */
function locked(file: string, wait: number, fn: () => void): boolean {
  const lock = `${file}.lock`;
  const until = Date.now() + wait;
  /** When the lock was last looked at for age. A stat per poll is most of what a waiter costs. */
  let looked = 0;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (!contended(error)) {
        throw error;
      }
    }
    if (fd !== undefined) {
      try {
        closeSync(fd);
        fn();
      } finally {
        try {
          // retried: on Windows a file another process is opening at that instant
          // cannot be deleted, and a lock left standing is everybody else's ten seconds
          untilFree(() => unlinkSync(lock), BUSY_WAIT);
        } catch {
          // a lock somebody else already took over is theirs to remove
        }
      }
      return true;
    }
    try {
      // looked at twice a second, not every millisecond: a lock is ten seconds from
      // stale at the earliest, and three waiters stat-ing a file the holder is about to
      // delete are what slow the holder down on a file system where every call is a
      // virus-scanned one
      if (Date.now() - looked < LOOK_EVERY) {
        throw new Error('not yet');
      }
      looked = Date.now();
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK) {
        // taken over by touching rather than removing, so two processes that both
        // find it stale do not each delete the one the other just made
        utimesSync(lock, new Date(), new Date());
        unlinkSync(lock);
        continue;
      }
    } catch {
      // gone between the failed create and the stat, or one this user cannot touch.
      // Not a `continue`: a create that is refused for good and a stat that cannot
      // see the lock would then spin with no deadline and no sleep
    }
    if (Date.now() >= until) {
      return false;
    }
    sleep(1);
  }
}

/**
 * Builds a history.
 *
 * @param opts - The file, the cap, and where a failure is reported.
 * @returns The history, already loaded and trimmed.
 */
export function createHistory(opts: HistoryOptions = {}): History {
  const { file } = opts;
  const max = Number.isInteger(opts.max) && (opts.max as number) >= 1 ? (opts.max as number) : MAX;
  let entries: string[] = [];
  /** How much of the file this has read, and which file that was. */
  let offset = 0;
  let identity: string | undefined;
  const reported = new Set<string>();
  /** How long an append waits for the lock, which is nothing once it has not come. */
  let lockWait = LOCK_WAIT;

  function report(kind: string, error: unknown): void {
    if (!reported.has(kind)) {
      reported.add(kind);
      opts.onError?.(error);
    }
  }

  /** Keeps the newest `max`. */
  function cap(): void {
    if (entries.length > max) {
      entries = entries.slice(entries.length - max);
    }
  }

  /** Reads the whole file, and cuts it back if it has grown well past the cap. */
  function load(): void {
    if (file === undefined) {
      return;
    }
    // no file was being read when this started -- not made yet, deleted since, or
    // unreadable -- so what the session holds is not in it and is kept in front of it
    const unread = identity === undefined;
    let text: string;
    try {
      const at = statSync(file);
      text = readFileSync(file, 'utf8');
      identity = `${at.dev}:${at.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report('read', error);
      }
      // what this session holds stays: a file that is gone or cannot be read is
      // no reason to forget what was typed in it
      offset = 0;
      identity = undefined;
      return;
    }
    // only whole lines are consumed, so a writer caught half way is read next time
    const whole = text.lastIndexOf('\n') + 1;
    offset = Buffer.byteLength(text.slice(0, whole));
    const found = parse(text.slice(0, whole));
    entries = unread ? [...entries] : [];
    for (const line of found) {
      if (entries.at(-1) !== line) {
        entries.push(line);
      }
    }
    const lines = text.slice(0, whole).split('\n').length - 1;
    if (lines > max + Math.ceil(max / 4)) {
      trim(0);
    }
    cap();
  }

  /**
   * Rewrites the file with the newest `max` entries, if nobody else is in it.
   *
   * @param wait - How long to wait for the lock, in ms. A load does not wait: it is
   *   on the way to a prompt, and the next one will find the file just as long.
   */
  function trim(wait = LOCK_WAIT): void {
    if (file === undefined) {
      return;
    }
    try {
      locked(file, wait, () => {
        // read again inside the lock: what was read to decide to trim is stale by
        // however long the lock took to get, and an append lands only outside it
        const kept = parse(readFileSync(file, 'utf8')).slice(-max);
        writeAtomicSync(file, kept.map((line) => `${JSON.stringify(line)}\n`).join(''));
        const at = statSync(file);
        identity = `${at.dev}:${at.ino}`;
        offset = at.size;
        entries = kept;
      });
    } catch (error) {
      report('trim', error);
    }
  }

  const history: History = {
    add(line: string): boolean {
      if (line.trim() === '') {
        return false;
      }
      history.sync();
      if (entries.at(-1) === line) {
        return false;
      }
      if (file !== undefined) {
        try {
          mkdirSync(dirname(file), { mode: 0o700, recursive: true });
          let wrote = false;
          /** Whether this line landed at the end of exactly what has been read. */
          let direct = false;
          const write = (): void => {
            // a file whose last line was cut short -- hand-edited, or a full disk --
            // has bytes past what was read as whole lines, and appending to them
            // would make this entry the rest of that one. A line break first ends it;
            // when what is past `offset` is whole lines another writer just
            // appended, it is a blank line, which a read skips
            let lead = '';
            let size = 0;
            try {
              size = statSync(file).size;
              lead = size > offset ? '\n' : '';
            } catch {
              // not there yet: nothing to end
            }
            // a short wait: what it rides out is a scanner holding the file for a
            // moment, and a refusal that is for good costs this much on every entry
            untilFree(
              () => appendFileSync(file, `${lead}${JSON.stringify(line)}\n`, { mode: 0o600 }),
              APPEND_WAIT
            );
            wrote = true;
            // nobody wrote between the `sync()` and the lock, so the file is what was
            // read plus this line, and reading it back would learn nothing
            if (lead === '' && size === offset && identity !== undefined) {
              direct = true;
              offset = size + Buffer.byteLength(`${JSON.stringify(line)}\n`);
            }
          };
          // behind a trim, which is the one thing that rewrites; and after the wait
          // anyway, because an entry that may be lost is better than a prompt that
          // hangs on a lock nobody is going to release. A lock that cannot be made at
          // all -- not held, but refused -- is the same answer: the line is written
          let failed: { error: unknown } | undefined;
          const inside = (): void => {
            // what the write threw is the write's, and not the lock's: the lock was had
            try {
              write();
            } catch (error) {
              failed = { error };
            }
          };
          try {
            if (locked(file, lockWait, inside)) {
              lockWait = LOCK_WAIT;
            } else {
              report('lock', new Error(`Could not lock ${file}.lock to append to the history`));
              // the next entry waits for less, a quarter of a second, and not for another
              // five seconds on what did not come in the first -- and a lock that is had
              // again puts the full wait back, so one dead process's lock does not leave
              // the rest of a session appending beside a trim
              lockWait = LOCK_RETRY;
            }
          } catch (error) {
            report('lock', error);
            lockWait = LOCK_RETRY;
          }
          if (failed !== undefined) {
            throw (failed as { error: unknown }).error;
          }
          if (!wrote) {
            write();
          }
          if (direct) {
            entries.push(line);
            cap();
          } else {
            // read back rather than pushed: whatever another writer appended between
            // the `sync()` above and the write is in the file ahead of this line, and
            // this is how the two come out in the order the file has them
            history.sync();
          }
          return true;
        } catch (error) {
          report('write', error);
        }
      }
      entries.push(line);
      cap();
      return true;
    },

    get entries(): readonly string[] {
      return [...entries];
    },

    file,

    max,

    trim: () => trim(),

    sync(): void {
      if (file === undefined) {
        return;
      }
      let at;
      try {
        at = statSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          report('read', error);
        } else {
          // deleted from under this: what is appended next is a new file, read whole,
          // with what the session holds kept in front of it
          identity = undefined;
          offset = 0;
        }
        return;
      }
      if (`${at.dev}:${at.ino}` !== identity || at.size < offset) {
        // replaced or cut by a trim in another process: what was read is not a
        // prefix of what is there
        load();
        return;
      }
      if (at.size === offset) {
        return;
      }
      try {
        const fd = openSync(file, 'r');
        try {
          const buffer = Buffer.alloc(at.size - offset);
          const got = readSync(fd, buffer, 0, buffer.length, offset);
          const text = buffer.toString('utf8', 0, got);
          const whole = text.lastIndexOf('\n') + 1;
          offset += Buffer.byteLength(text.slice(0, whole));
          for (const line of parse(text.slice(0, whole))) {
            if (entries.at(-1) !== line) {
              entries.push(line);
            }
          }
          cap();
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        report('read', error);
      }
    },
  };

  load();
  return history;
}
