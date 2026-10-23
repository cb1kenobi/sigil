import debug from './debug/index.js';
import { errorHandler } from './error-handler.js';
import { fireBeforeError, stateFromError } from './error-hooks.js';
import { assertSerialized, formatFor } from './format.js';
import { loadCatalog } from './i18n/index.js';
import { fireAfterRun } from './run-hooks.js';
import {
  type AppOptions,
  type InternalCommand,
  type ParseState,
  type RunResult,
  type Schema,
  type Settings,
} from './types.js';

export * from './types.js';
export { command } from './command.js';
export { options } from './options.js';
export { errorExitCode, errorHandler, renderError } from './error-handler.js';

const { log } = debug('sigil');

/*
get cwd(): string {
    return process.cwd();
  }

  set cwd(v: string) {
    process.chdir(v);
  }
*/

/**
 * Parses argv against the schema and runs the command that wins.
 *
 * Errors thrown by `parse()` or by the command's `run()` are rendered by
 * `errorHandler()` -- the message, no stack trace -- and turned into a
 * non-zero `process.exitCode`; `main()` then resolves with `undefined`. A
 * bin script is the expected caller, so failing loudly through an unhandled
 * rejection is the wrong default. Set `settings.errorHandler` to `false` to
 * have the error rethrown instead, or to a function to render it yourself.
 *
 * @param opts - The app options.
 * @returns The command's return value, the parse state when the command
 * returned nothing or no command ran, or `undefined` when an error was
 * handled.
 */
export async function main(opts: AppOptions = {}): Promise<ParseState | unknown> {
  let state: ParseState | undefined;
  let hooksFired = false;
  /** What the process-wide quiet request was before this run, if it moved. */
  let restoreQuiet: (() => void) | undefined;

  try {
    if (opts?.settings?.assertCwd !== false) {
      assertCwd();
    }

    // before `parse()`, because `__` renders where it is called and a parse
    // error is the first thing that can be printed. It follows that a locale
    // set later -- by `setLocale()`, once the app has read its config -- cannot
    // reach a message already rendered, so a parse error and `--help` are
    // always in the environment's locale. That is the right answer rather than
    // a gap: an app whose parse failed never got to read its config.
    await loadCatalog(opts.schema?.locales, process.env, opts.locale, opts.schema?.defaultLocale);

    const { parse } = await import('./parser/parse.js');

    // read the app options before the catch below, which speaks only for
    // `parse()`: a property of the caller's own that throws on the way in
    // has not been through the hooks yet
    const parseOpts = {
      argv: opts.argv || process.argv.slice(2),
      env: process.env,
      schema: opts.schema,
      settings: opts.settings,
    };

    try {
      state = await parse(parseOpts);
    } catch (err) {
      // `parse()` owns its own error path and has already fired the hooks
      // on whatever it throws -- firing them again here would double up
      hooksFired = true;
      throw err;
    }

    // recorded before anything is printed, and here rather than in `parse()`:
    // a parser owes its caller no process-wide side effect, where `main()`
    // already owns `process.exitCode` and the error handler, so one more fact
    // about the process is in character.
    //
    // Set only when argv asked, so a programmatic `setQuiet(true)` is not
    // cleared by a parse that did not name the flag -- and **put back** on the
    // way out, which is the rule every other thing this attaches follows. One
    // `main()` per process is the ordinary case and neither half shows there;
    // what shows is a host that calls it twice, which the command palette's own
    // documented `await main({ argv: chosen.argv, schema })` is, and where a
    // `--quiet` on the first run silenced every run after it with nothing in
    // argv to explain why
    // a format implies quiet, and that is the whole reason this ticket waited on
    // the quiet axis: a spinner interleaved with JSON on stdout is unusable, so
    // asking for machine output is asking for nothing else. One condition rather
    // than `state.quiet` being set for both, so that flag keeps meaning "argv
    // asked" and the implication reads where it is made
    if (state.quiet || state.format !== undefined) {
      const { quietGeneration, getQuiet, setQuiet, rewindQuiet } =
        await import('./style/output.js');
      const before = getQuiet();
      const was = quietGeneration();
      setQuiet(true);
      const mine = quietGeneration();
      restoreQuiet = (): void => {
        // only where nobody has written since, which is the rule
        // `captureConsole()`'s own `restoreOne()` keeps -- a method whose
        // current value is no longer ours is left alone -- asked the one way a
        // boolean admits. A command that said `setQuiet()` through the
        // documented door had that reversed by the teardown of a run already
        // over, and a *value* test closed only half of it: comparing `true` to
        // `true` cannot tell "nobody wrote" from "the command asked for the
        // same thing", so a dispatcher asking for quiet for what follows still
        // lost it. A token can tell them apart, which is the shape of check
        // `unanchor()` gives a reply about a stale anchor.
        //
        // And it **rewinds** rather than writing, because a write of its own is
        // what made the nested case leak: see `rewindQuiet()`
        if (quietGeneration() === mine) {
          rewindQuiet(before, was);
        }
      };
    }

    if (state.help) {
      await printHelp(state);
      return state;
    }

    // after help, which outranks it, and before the command runs: `--version`
    // is a question about the program rather than work to do
    if (state.version !== undefined) {
      process.stdout.write(`${state.version}\n`);
      return state;
    }

    const { cmd } = state;
    if (cmd?.run) {
      log(`Executing command "${cmd.name}"`);

      // a throw is an **result** rather than an exit, which is the whole of
      // what makes `afterRun` a `finally` rather than a success callback: there
      // is one path out of here whichever way `run()` went, and the hooks are
      // on it. Inline rather than in a helper of its own, so that the `throw`
      // that reaches `handleError()` is readable beside the hooks that precede
      // it -- and so that the narrowing `cmd?.run` just did is the narrowing
      // the call uses, rather than an assertion standing in for it
      const started = performance.now();
      let result: RunResult;

      try {
        result = { ok: true, value: await cmd.run(state) };
      } catch (err) {
        result = { error: err, ok: false };
      }

      // `performance.now()` rather than `Date.now()`: monotonic, so a system
      // clock that moved mid-command cannot make a duration negative, and
      // sub-millisecond, where `Date.now()` reads `0` for anything quick --
      // which is most commands, and a timing line saying `0ms` for all of them
      // is one nobody reads twice
      const ms = performance.now() - started;

      // the first consumer of the result, and that is why it is written off
      // the result rather than off two locals: it reads the two things a hook
      // is handed, so a shape that could not say whether the command failed, or
      // how long it took, is a shape this line could not be written over
      log(`Command "${cmd.name}" ${result.ok ? 'returned' : 'threw'} after ${ms.toFixed(3)}ms`);

      // the hooks, then the error -- in that order, which is what lets a hook
      // flush its log and have the error still report. `fireAfterRun()` does
      // not throw, so nothing it does can get between this error and
      // `handleError()` below
      await fireAfterRun(cmd, result, ms, state);

      if (!result.ok) {
        throw result.error;
      }

      // the format registry is the reader the comment here used to say would
      // come, and this is why `result.value` is kept apart from what `main()`
      // returns: `?? state` is the return value's own substitution, and
      // serializing the parse state because a command returned nothing would be
      // presenting the framework's bookkeeping as the command's answer
      if (state.format !== undefined) {
        writeFormatted(state, cmd, result.value);
      }

      // the `?? state` substitution is `main()`'s return value and not the
      // command's result: `result.value` is what `run()` handed back, so a
      // command that returned nothing is a command that returned nothing
      // wherever a hook asks what it did
      return result.value ?? state;
    }

    // nothing ran and there was nothing to run: a CLI that is all subcommands
    // has nothing to do without one, and printing nothing at all tells the
    // reader neither what went wrong nor what is available. It goes to stdout
    // and exits zero like `--help`, because being asked what the program does
    // and answering is not a failure.
    //
    // In `main()` rather than in the app's own bin, which is where the
    // toolchain used to do it: `sigil build` generates the executable and
    // calls `main()`, so anything an app wrapped around it is not in the
    // bundle -- and a built CLI printed nothing at all where the same source
    // printed help.
    //
    // Three things have to be true, and each was a test saying so. The app
    // declared `commands`, because a schema that declares none is one being
    // used as a parser and a help screen is not what its caller asked for --
    // the `help` command this adds to every schema means the *registry* is
    // never empty, so the declaration is what has to be asked about. Help is
    // not turned off, since `help: false` means this app answers for what
    // help means. And nothing already answered: a command with a `run`, a
    // `default` command, `--help` and `--version` all leave before here.
    const declaredCommands = state.schema.commands !== undefined;

    if (declaredCommands && state.schema.help !== false && state.version === undefined) {
      await printHelp({ ...state, help: { contexts: state.contexts, via: 'empty' } });
    }

    return state;
  } catch (err) {
    // a parse error never got to return a state, but it carries the one it
    // died with, which is where the matched command comes from
    return await handleError(err, state ?? stateFromError(err), opts, hooksFired);
  } finally {
    restoreQuiet?.();
  }
}

/**
 * Presents what a command returned in the format argv selected.
 *
 * To **stdout**, which is the contract: selecting a format is asking for the
 * answer on stdout and nothing else there, which is what the quiet implication
 * buys. The error form goes to stderr through `errorHandler()`, as an error
 * always does, and the exit code carries the verdict.
 *
 * A command that opted in and returned `undefined` is **refused**, which is the
 * one call here a reader may want the reasoning for. Three answers were
 * available and only this one can be acted on. Printing nothing leaves a script
 * with empty stdout and exit zero, so `jq` fails with "Unexpected end of input"
 * and the failure names nothing. Printing `null` claims the command's answer was
 * `null`, which is a lie if it meant to return something. A refusal names the
 * command, goes to stderr and exits non-zero, which is what a script's `set -e`
 * is for -- and `--format json` that produces no JSON is the property that
 * parses and does nothing, which this repository calls worse than one that does
 * not exist.
 *
 * It runs **after** the `afterRun` hooks, which is the honest ordering rather
 * than a convenience: the command really did return, so a hook that asked what
 * it did is right to have been told `ok`. What failed is the presentation, and
 * the error it throws reaches the same path every other one does -- serialized
 * in the selected format, because `renderError()` reads the state.
 *
 * @param state - The parse state, for the schema and the selected name.
 * @param cmd - The command that ran, for the message.
 * @param value - What `run()` returned.
 * @throws If the command returned nothing, or the serializer answered with
 *   something that is not text.
 */
function writeFormatted(state: ParseState, cmd: InternalCommand, value: unknown): void {
  const name = state.format!;

  if (value === undefined) {
    throw new Error(
      `The "${cmd.name}" command returned nothing to present as "${name}". A command that declares "format" has to return the data it presents.`
    );
  }

  // resolved against the whole registry rather than against what this command
  // accepts, which is safe by construction rather than by luck: `detectFormat()`
  // set `state.format` only after `formatFor()` had judged the name against the
  // chain's own accepted set, so a name that is here is one that passed. Passing
  // the narrowing again would mean carrying it on the state -- a second field
  // answering a question already answered -- and `true` is a superset of it, so
  // the two cannot disagree about which serializer this name names
  const text = assertSerialized(formatFor(state.schema, name)(value), name);

  // exactly one trailing newline, which is `errorHandler()`'s own rule: a
  // line-oriented consumer wants one and a serializer that already ended with
  // one must not produce a blank line
  process.stdout.write(`${text.replace(/[\r\n]+$/, '')}\n`);
}

/**
 * Writes the help screen and sets the exit code.
 *
 * The help module is imported here rather than at the top, the same way the
 * parser is: a bin script that never prints help should not pay to load the
 * renderer, the wrapper, and the width tables to find that out.
 *
 * @param state - The parse state, carrying the request.
 */
async function printHelp(state: ParseState): Promise<void> {
  const { resolveHelp } = await import('./help/index.js');
  log(`Printing help for "${state.help?.contexts[0]?.name}"`);
  process.stdout.write(`${await resolveHelp(state)}\n`);
  process.exitCode = exitCode(state.settings.helpExitCode);
}

/**
 * The exit code to set after printing help.
 *
 * Zero unless the app said otherwise: being asked what a command does and
 * answering is not a failure. A value that is not an exit code is not an
 * instruction, and assigning it would turn printing help into a crash.
 *
 * @param code - The configured code.
 * @returns The code to set.
 */
function exitCode(code: number | undefined): number {
  return Number.isInteger(code) && code! >= 0 && code! < 256 ? code! : 0;
}

/**
 * The single error path for `main()`. Everything thrown between the working
 * directory check and the command's `run()` resolving arrives here.
 *
 * @param err - The thrown value.
 * @param state - The parse state, if parsing got far enough to produce one.
 * @param opts - The app options.
 * @param hooksFired - Set when the `beforeError` hooks have already run, which
 * is every error `parse()` threw.
 */
async function handleError(
  err: unknown,
  state: ParseState | undefined,
  opts: AppOptions,
  hooksFired = false
): Promise<undefined> {
  // the hooks fire before anything is rendered and before the opt-out below,
  // so the error a hook replaced is the one that gets rendered, handed to a
  // custom handler, or rethrown -- the same error whichever way it leaves
  const reported = hooksFired ? err : await fireBeforeError(err, state, appSchema(opts));

  const handler = errorHandlerSetting(opts);

  if (handler === false) {
    throw reported;
  }

  if (typeof handler === 'function') {
    await handler(reported, { state });
    return;
  }

  errorHandler(reported, { state });
}

/**
 * Reads the error handler setting without letting a throwing getter escape.
 * Falling back to the built-in handler reports the original error; letting the
 * read throw would report neither it nor the bad getter.
 *
 * @param opts - The app options.
 * @returns The configured handler, or `undefined` for the built-in one.
 */
function errorHandlerSetting(opts: AppOptions): Settings['errorHandler'] {
  try {
    return opts?.settings?.errorHandler;
  } catch {
    return undefined;
  }
}

/**
 * Reads the schema off the app options without letting a throwing getter
 * escape. This runs on the error path, where the only thing worse than a bad
 * schema is a second error hiding the first.
 *
 * @param opts - The app options.
 * @returns The schema, if the options carry a readable one.
 */
function appSchema(opts: AppOptions): Schema | undefined {
  try {
    return opts?.schema;
  } catch {
    return undefined;
  }
}

function assertCwd() {
  try {
    process.cwd();
  } catch (err) {
    if (err instanceof Error && err.message.includes('uv_cwd')) {
      throw new Error('Current working directory does not exist');
    }
  }
}

export default main;
