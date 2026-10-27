// The update check an app switches on instead of calling.
//
// `check()` is the mechanism and this is the policy around it: when a person
// is there to be told, what to look up, and when to say it. It is a module of
// its own, imported by `main()` only for a schema that asked, so an app that
// did not pays for none of it -- not the worker, not the cache, not the
// spawn.

import debug from '../debug/index.js';
import { __ } from '../i18n/index.js';
import { cache } from '../paths.js';
import { getQuiet } from '../style/output.js';
import type { Schema } from '../types.js';
import { isChecker, isNewer, type UpdateChecker } from './checker.js';
import { bakedConfig } from './host.js';
import { check, type UpdateCheckOptions, type UpdateNotice } from './index.js';

const { log } = debug('sigil:updates');

/** What the check reads about the process, so a test need not become a terminal. */
export interface UpdateEnvironment {
  readonly env?: Record<string, string | undefined>;
  readonly stderr?: { isTTY?: boolean; write(text: string): unknown };
}

/** An environment variable that is set to something other than "no". */
function on(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Why a check should not happen here, or `undefined` when it should.
 *
 * Asked **before** anything is fetched, and that is a decision rather than a
 * tidiness: the notice is for a person at a terminal, so where it cannot be
 * shown the lookup has nothing to be for. A script that runs a CLI two hundred
 * times a day should not be spawning a worker, writing a cache and making a
 * request on each, to learn something nobody will read.
 *
 * @param environment - The environment and stderr to ask.
 * @returns The reason, for the debug log.
 */
export function skipReason(environment: UpdateEnvironment = {}): string | undefined {
  const { env = process.env, stderr = process.stderr } = environment;

  if (stderr.isTTY !== true) {
    return 'stderr is not a terminal';
  }

  // `--quiet`, and a `--format`, which implies it: a notice is not a result,
  // and a script that asked for none of the surrounding talk did not ask for
  // this either
  if (getQuiet() === true) {
    return 'quiet was asked for';
  }

  // the two conventions that exist: `CI` is set by every CI system there is,
  // and `NO_UPDATE_NOTIFIER` is what update-notifier has taught a decade of
  // tools to honour, so a user who has set it once has set it for everything
  if (on(env.CI)) {
    return 'CI is set';
  }

  if (on(env.NO_UPDATE_NOTIFIER)) {
    return 'NO_UPDATE_NOTIFIER is set';
  }

  return undefined;
}

/**
 * What `Schema.updateCheck` says, as options.
 *
 * It is one of three things: `true`, which is the defaults; a checker, which is
 * the one option nearly every binary has to give and so is accepted bare
 * instead of as `{ checker }`; or the options themselves.
 *
 * @param declared - The schema's `updateCheck`, already known to be truthy.
 * @returns The options.
 */
export function updateCheckOptions(
  declared: true | UpdateChecker | UpdateCheckOptions
): UpdateCheckOptions {
  if (declared === true) {
    return {};
  }
  return isChecker(declared) ? { checker: declared } : declared;
}

/**
 * Starts the check and hands back what to call when the command is done.
 *
 * Started **before** the command rather than after it, and the order is the
 * point. In an app that has a runtime the worker outlives the CLI either way,
 * but in a single-file executable the fetch happens in this process and can
 * only finish if the process is still alive -- so the command's own running
 * time is the window it gets, and a check begun after the work is a check
 * begun on the way out of the door.
 *
 * What it reports is still what the **previous** run found, because that is
 * what the cache holds when `check()` returns. The first run says nothing.
 *
 * Nothing in here can fail the command it is attached to. An update notice is
 * the least important thing the program prints, and a bug in it is not an
 * excuse for a non-zero exit.
 *
 * @param schema - The schema, for its name, its version and its options.
 * @param environment - The environment and stderr, for a test.
 * @returns What to call once the command has succeeded, or `undefined` when
 *   there is no check to report.
 */
export async function beginUpdateCheck(
  schema: Schema,
  environment: UpdateEnvironment = {}
): Promise<(() => Promise<void>) | undefined> {
  try {
    const declared = schema.updateCheck;
    if (!declared) {
      return undefined;
    }

    const reason = skipReason(environment);
    if (reason) {
      log(`Update check skipped: ${reason}`);
      return undefined;
    }

    const opts = updateCheckOptions(declared);
    const { message, ...checkOptions } = opts;

    // called here although a `version` function is documented as called only
    // for `--version`: that laziness is for an app that reads a file to answer,
    // and an app that asked for an update check asked to be asked
    const version = typeof schema.version === 'function' ? schema.version() : schema.version;
    const packageName = opts.packageName ?? bakedConfig()?.packageName ?? schema.name;

    // not load-bearing, and said so: without it `check()` throws its own
    // `TypeError` for the empty version or name and the `catch` below turns it
    // into the same silence, so deleting this changes no answer (sabotaged, and
    // the suite stays green). It is here for the message -- it names what the
    // schema is missing, where the other names an option of a function the app
    // never called
    if (!version || !packageName) {
      log('Update check skipped: the schema needs a "version" and a "name" to check against');
      return undefined;
    }

    // a per-program directory, as XDG would have it. The encoded name rather
    // than the raw one, since a scoped package is `@scope/name` and a slash
    // would make the scope a directory
    const cacheDir = opts.cacheDir ?? cache(encodeURIComponent(schema.name ?? packageName));
    if (!cacheDir) {
      // without a cache the fire-and-forget path has nowhere to leave its
      // answer, so it would spawn a worker on every run and never report
      // anything -- which is worse than not checking
      log('Update check skipped: there is no cache directory');
      return undefined;
    }

    const name = schema.name ?? packageName;
    const pending = check({
      ...checkOptions,
      cacheDir,
      packageName,
      packageVersion: version,
    }).catch((err: Error) => {
      log(`Update check failed: ${err.message}`);
      return undefined;
    });
    const stderr = environment.stderr ?? process.stderr;

    return async (): Promise<void> => {
      try {
        const result = await pending;
        if (!result?.latest || !isNewer(result.latest, result.current)) {
          return;
        }

        const notice: UpdateNotice = { current: result.current, latest: result.latest, name };
        const text = message
          ? message(notice)
          : __`A new version of ${name} is available: ${result.current} → ${result.latest}`;

        if (text) {
          stderr.write(`\n${text}\n`);
        }
      } catch (err) {
        log(`Update notice failed: ${(err as Error).message}`);
      }
    };
  } catch (err) {
    log(`Update check failed: ${(err as Error).message}`);
    return undefined;
  }
}
