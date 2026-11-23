/**
 * The error a prompt raises, in a module that imports nothing.
 *
 * It lived in `prompt.ts` and was reached from there by anything that needed to
 * throw one or ask `instanceof` -- `tokensOf()` among them, so a code view paid
 * for the whole prompt stack to be able to refuse a bad token name (SIG-597).
 * `prompt.ts` re-exports it, so `PromptError` is still the same class from the
 * same published names.
 */

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
