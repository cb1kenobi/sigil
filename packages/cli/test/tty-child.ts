import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * What a test needs to drive a prompt in a spawned child: a preload that makes
 * the child believe it has a terminal, and keys typed into it the way a person
 * types them.
 *
 * One definition for the two files that spawn a prompting child --
 * `completion-install-tty.test.ts` and `package-prompt-tty.test.ts` -- which
 * each carried a copy of both.
 */

/**
 * A preload making the child's three streams answer `isTTY`.
 *
 * `Object.defineProperty` rather than an assignment, for the reason
 * `output-forms.test.ts` and `runOnTerminal()` both give: a piped
 * `process.stdout` is not a `tty.WriteStream` and what it does with a write to
 * a property it never declared is not a thing to depend on. **stdin** is in the
 * list here where those two have only the output streams, because the prompts
 * refuse to run unless *both* ends claim to be a terminal -- which is the
 * mechanism the no-TTY fallback is, so a preload that faked one of them would
 * be testing the fallback while believing it tested the prompt. `columns` and
 * `rows` come with it, because a renderer with no width draws nothing
 * assertable and the prompts read the terminal's width for their own layout.
 */
export const TTY_PRELOAD: string = ttyPreload();

/**
 * {@link TTY_PRELOAD} for a terminal of another width.
 *
 * A message that carries a path wraps at the width the child believes it has, and
 * where the temp directory is long -- every Windows runner's -- wraps through the
 * middle of a phrase a test asserts on. A test about the words, and not about how
 * they wrap, asks for a terminal wide enough not to.
 *
 * @param columns - The width the child's streams report. Defaults to 80.
 * @returns A `data:` URL for `--import`.
 */
export function ttyPreload(columns = 80): string {
  return `data:text/javascript,${encodeURIComponent(
    ['stdout', 'stderr', 'stdin']
      .map(
        (s) =>
          `Object.defineProperty(process.${s},"isTTY",{configurable:true,value:true});` +
          `Object.defineProperty(process.${s},"columns",{configurable:true,value:${columns}});` +
          `Object.defineProperty(process.${s},"rows",{configurable:true,value:24});`
      )
      .join('')
  )}`;
}

/** How long the child's output has to stay still before it counts as waiting. */
const QUIET_MS = 100;

/** How long to wait for a key to show any effect before typing the next anyway. */
const CAP_MS = 5000;

/** How often the output is looked at. */
const POLL_MS = 10;

/**
 * Types `keys` into the child one at a time, then closes its stdin.
 *
 * A key is written only once the child has **visibly dealt with the one before
 * it**: its output has grown since that key was written and then stayed still
 * for {@link QUIET_MS}. The first key waits the same way for the child's first
 * output. That is what a person at a terminal does -- read the prompt, then
 * answer it -- and it is what a prompt needs, because each prompt has to get
 * its key as a read of its own.
 *
 * The version this replaced wrote on a timer, 500ms and then 250ms apart,
 * whatever the child was doing. On a loaded CI runner two keys could both be
 * waiting in the pipe when the child next read, so they arrived as **one**
 * read: the shell prompt took both Enters, the confirm after it got nothing,
 * and the `end()` that followed cancelled it (SIG-300). The output growing
 * after a key is the proof the child read that key, so no two keys are ever
 * unread at once.
 *
 * A key that prints nothing would stall that rule forever, so each wait is
 * capped at {@link CAP_MS}, after which the next key goes anyway; every key the
 * callers type today prints something, so the cap is a backstop rather than the
 * schedule. A child that has exited is typed into no further.
 *
 * @param child - The spawned child, with all three streams piped.
 * @param keys - What to type, one entry per keystroke.
 */
export function typeKeys(child: ChildProcessWithoutNullStreams, keys: readonly string[]): void {
  let output = 0;
  let changedAt = Date.now();
  const count = (chunk: Buffer): void => {
    output += chunk.length;
    changedAt = Date.now();
  };
  child.stdout.on('data', count);
  child.stderr.on('data', count);

  let exited = false;
  child.on('close', () => {
    exited = true;
  });
  // a key can make the child exit -- a Ctrl-C does -- and a write or an `end()`
  // racing that exit fails with EPIPE. What the child did is what the test
  // asserts, from its exit code and its output, so a pipe it already closed is
  // not a failure of the test
  child.stdin.on('error', () => {});

  let at = 0;
  let mark = 0;
  let waitingSince = Date.now();

  const poll = (): void => {
    if (exited) {
      return;
    }
    const now = Date.now();
    const handled = output > mark && now - changedAt >= QUIET_MS;
    if (handled || now - waitingSince >= CAP_MS) {
      if (at === keys.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(keys[at++]);
      mark = output;
      waitingSince = now;
    }
    setTimeout(poll, POLL_MS);
  };

  setTimeout(poll, POLL_MS);
}
