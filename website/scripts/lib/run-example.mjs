import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

/**
 * Runs one component example on a terminal that is not there, and prints what
 * it drew.
 *
 * A component page shows the source of an example and what that example drew,
 * and the two have to be one program: the file in `src/content/components/` is
 * shown on the page verbatim **and** is what this runs. So the example is
 * ordinary app code -- `await select({ message, choices })`, with no terminal
 * handed in and no test harness in sight -- and this is what makes ordinary app
 * code draw somewhere a capture can read:
 *
 * - **The process's streams are replaced before sigil is loaded.**
 *   `@ttylabs/sigil/terminal` builds its default terminal from `process.stdout`
 *   and `process.stdin` when it is first imported, and every component falls
 *   back to that terminal. So the streams are defined here first, claiming to be
 *   a terminal of the size asked for, and everything the example writes --
 *   stdout and stderr, the way one terminal shows both -- is recorded.
 *   `createTestTerminal()` is the repository's own answer for a prompt and is
 *   what the home page's scenes use, but it is a terminal to *hand in*, and an
 *   example that took one would be showing the reader plumbing.
 * - **The clock is fake.** A spinner, a progress bar, a typewriter and the
 *   renderer's own frame loop all run on `setTimeout` and `Date.now`, so a frame
 *   taken on a real clock is whichever one a loaded machine happened to reach.
 *   Here time moves only when a step says so, and the date is fixed, so a date
 *   prompt opens on the same day every time and a capture is the same bytes on
 *   every run. `AbortSignal.timeout()` runs on it too, which is what lets a
 *   recipe show a prompt timing out without waiting ten seconds for it.
 * - **The keys are pressed one read at a time**, as `press()` does, with the
 *   clock advanced a frame after each so that what the key caused is drawn.
 *
 * It prints one JSON object on the real stdout, `{ output }`: the bytes the
 * example wrote. Run by `component-capture.ts`, one child per run, so every run
 * starts from a fresh module graph and a fresh default terminal.
 *
 *   node run-example.mjs '{"file": "...", "columns": 80, "rows": 24, "steps": ["down"]}'
 */

const spec = JSON.parse(process.argv[2]);
const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

// ---------------------------------------------------------------------------
// the clock

/** 9:41 on the day the components page was written, in UTC. */
const EPOCH = Date.UTC(2026, 10, 4, 9, 41, 0);
let now = EPOCH;
let nextId = 1;
/** @type {Map<number, { at: number; fn: Function; args: unknown[]; every?: number }>} */
const timers = new Map();

/** A timer handle shaped like Node's, which is what `unref()` is asked of. */
function handle(id) {
  return {
    hasRef: () => true,
    ref() {
      return this;
    },
    refresh() {
      const timer = timers.get(id);
      if (timer) {
        timer.at = now + (timer.every ?? timer.delay ?? 0);
      }
      return this;
    },
    unref() {
      return this;
    },
    [Symbol.toPrimitive]: () => id,
  };
}

function schedule(fn, delay, args, repeat) {
  const id = nextId++;
  // at least one millisecond, as Node's own timers are: a frame that asks for
  // the next one at once would otherwise run forever without the clock moving
  const ms = Math.max(1, Number(delay) || 0);
  timers.set(id, {
    args,
    at: now + ms,
    delay: ms,
    every: repeat ? Math.max(1, ms) : undefined,
    fn,
  });
  return handle(id);
}

function clear(timer) {
  if (timer !== undefined && timer !== null) {
    timers.delete(Number(timer));
  }
}

const realSetTimeout = setTimeout;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(now);
    } else {
      super(...args);
    }
  }

  static now() {
    return now;
  }
}

globalThis.Date = FakeDate;
globalThis.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
globalThis.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
globalThis.clearTimeout = clear;
globalThis.clearInterval = clear;
const performanceNow = () => now - EPOCH;
Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: performanceNow });
AbortSignal.timeout = (ms) => {
  const controller = new AbortController();
  schedule(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms,
    [],
    false
  );
  return controller.signal;
};

/** Lets every pending microtask and immediate run, on the real event loop. */
async function turn(times = 3) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The kinds of libuv request that are real I/O still on its way back. */
const IO = /^(?:FSReq|FSEvent|GetAddrInfo|ProcessWrap|PipeConnectWrap)/;

/**
 * Lets the event loop run until no real I/O is outstanding.
 *
 * The clock is fake and the file system is not: a path prompt reading a
 * directory, or `editor()` asking `PATH` where the editor is, finishes when the
 * disk answers, which on a loaded machine is any number of turns away. So this
 * asks Node what it is still waiting on, rather than guessing a number of turns,
 * and goes on until the answer is nothing.
 */
async function settle() {
  for (let i = 0; i < 1_000; i++) {
    await turn();
    if (!process.getActiveResourcesInfo().some((kind) => IO.test(kind))) {
      await turn();
      return;
    }
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
  throw new Error('an example was still waiting on I/O after two seconds');
}

/**
 * Moves the clock on, running each timer that falls due in the order it falls
 * due, with the event loop let run after each.
 *
 * @param {number} ms - How far.
 */
async function advance(ms) {
  const until = now + ms;
  await settle();
  for (;;) {
    let due;
    for (const [id, timer] of timers) {
      if (timer.at <= until && (due === undefined || timer.at < timers.get(due).at)) {
        due = id;
      }
    }
    if (due === undefined) {
      break;
    }
    const timer = timers.get(due);
    now = Math.max(now, timer.at);
    if (timer.every === undefined) {
      timers.delete(due);
    } else {
      timer.at = now + timer.every;
    }
    timer.fn(...timer.args);
    await settle();
  }
  now = until;
  await settle();
}

// ---------------------------------------------------------------------------
// the terminal

let written = '';
const stdout = new PassThrough();
Object.assign(stdout, {
  columns: spec.columns,
  getColorDepth: () => 4,
  hasColors: () => true,
  isTTY: true,
  rows: spec.rows,
  write(chunk, encoding, callback) {
    // what a terminal's line discipline does on the way out (`onlcr`): a line
    // feed alone returns the carriage too, so a `console.log()` starts its
    // next line at the left edge, as it does in a real terminal
    written += String(chunk).replaceAll(/(?<!\r)\n/g, '\r\n');
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') {
      done();
    }
    return true;
  },
});

const stdin = new PassThrough();
Object.assign(stdin, {
  isRaw: false,
  isTTY: true,
  setRawMode(mode) {
    stdin.isRaw = mode;
    return stdin;
  },
});

for (const [name, stream] of [
  ['stdout', stdout],
  ['stderr', stdout],
  ['stdin', stdin],
]) {
  Object.defineProperty(process, name, { configurable: true, get: () => stream });
}

// ---------------------------------------------------------------------------
// where it is

/**
 * The directory the example says it is in.
 *
 * A file picker shows the absolute path of the directory it is listing, which
 * on a real checkout is wherever the repository was cloned -- so a capture of it
 * would differ from one machine to the next, and say something about the person
 * who ran it. So the example project is presented at one fixed path:
 * `process.cwd()` answers it, `HOME` is above it, and the two `fs/promises` calls
 * the file prompts read a directory with see it as the project it really is.
 * Nothing else about the file system is touched.
 */
if (spec.at) {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fsp = createRequire(import.meta.url)('node:fs/promises');
  const real = process.cwd();
  const shown = spec.at;
  const map = (path) =>
    typeof path === 'string' && (path === shown || path.startsWith(`${shown}/`))
      ? real + path.slice(shown.length)
      : path;

  for (const name of ['readdir', 'stat', 'lstat', 'realpath', 'access']) {
    const original = fsp[name];
    fsp[name] = (path, ...rest) => original(map(path), ...rest);
  }
  syncBuiltinESMExports();
  process.cwd = () => shown;
  process.env.HOME = shown.slice(0, shown.lastIndexOf('/'));
}

// what `main()` reads its arguments from: the example's own file, and nothing after it
process.argv = [process.execPath, spec.file];

if (spec.accessible) {
  process.env.SIGIL_ACCESSIBLE = '1';
}

// imported only now, so that the default terminal is built over the streams above
const { KEYS } = await import('@ttylabs/sigil/testing');

/** What one step sends: a key by name, or text typed as one read. */
function bytesOf(step) {
  if (typeof step === 'string') {
    if (step === 'ctrlC') {
      return '\u0003';
    }
    if (!(step in KEYS)) {
      throw new Error(`no key called "${step}": use a name from KEYS, ctrlC, or { text }`);
    }
    return KEYS[step];
  }
  return step.text;
}

/** One frame, which is what the renderer waits at most between a change and its paint. */
const FRAME = 40;

async function play(steps) {
  for (const step of steps) {
    if (typeof step === 'object' && 'wait' in step) {
      await advance(step.wait);
      continue;
    }
    stdin.write(bytesOf(step));
    // a lone Escape is held until it cannot be the start of a chord
    await advance(step === 'escape' ? 600 : FRAME);
  }
}

/**
 * Loads the example, fresh, and reports how it ended.
 *
 * @param {string | number} tag - Makes the module's address, and so the module, a new one.
 * @returns {{ error: () => unknown; state: () => string }} What it has come to so far.
 */
function start(tag) {
  let state = 'pending';
  let error;
  const url = `${pathToFileURL(spec.file).href}?run=${tag}`;
  import(url).then(
    () => void (state = 'resolved'),
    (thrown) => {
      error = thrown;
      state = `rejected:${thrown?.name ?? 'Error'}`;
    }
  );
  return { error: () => error, state: () => state };
}

const run = start('view');
await advance(FRAME);
await play(spec.steps ?? []);

// an example that threw is a capture that failed, not a picture of an error
if (run.error() !== undefined) {
  writeErr(`${run.error()?.stack ?? run.error()}\n`);
  process.exit(1);
}

writeOut(`${JSON.stringify({ output: written })}\n`);
process.exit(0);
