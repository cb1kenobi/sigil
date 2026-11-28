/**
 * Telemetry: one event per run from `afterRun` and `beforeError`, holding the
 * command's declared name and an error's code -- never what was typed.
 *
 *   node demos/parser/14-telemetry.js
 *   node demos/parser/14-telemetry.js deploy api --env staging
 *   DO_NOT_TRACK=1 node demos/parser/14-telemetry.js
 *
 * Each event is printed rather than sent, so you can see exactly what would
 * leave the machine. packages/sigil/docs/telemetry.md is the whole recipe: asking
 * first, sending from a detached process so no run waits on the network, and the
 * test that keeps a typed value out of the event.
 */
import { main, UsageError } from '@ttylabs/sigil';

/** The runs `afterRun` recorded, so `beforeError` does not record them again. */
const recorded = new WeakSet();

function record(event) {
  // any value at all means no, and it wins over everything
  if (process.env.DO_NOT_TRACK) {
    return;
  }
  console.log(`  telemetry: ${JSON.stringify(event)}`);
}

// `contexts` is innermost first, and each is the declared command, so an alias
// or a typo never reaches the event
const commandOf = (state) =>
  (state?.contexts ?? [])
    .map((cmd) => cmd.name)
    .toReversed()
    .join(' ');

// a message repeats what was typed; a code and a class name do not
const errorOf = (err) =>
  err instanceof UsageError ? err.code : err instanceof Error ? err.name : typeof err;

const schema = {
  name: 'demo',
  hooks: {
    afterRun({ result, ms, state }) {
      recorded.add(state);
      record({
        command: commandOf(state),
        ok: result.ok,
        error: result.ok ? undefined : errorOf(result.error),
        ms: Math.round(ms),
      });
    },

    // the only hook a failed parse reaches
    beforeError(err, state) {
      if (state === undefined || !recorded.has(state)) {
        record({ command: commandOf(state), ok: false, error: errorOf(err) });
      }
    },
  },

  completion: false,
  schema: false,
  commands: {
    'deploy, d': {
      args: ['<service>'],
      options: {
        '-e, --env [name]': { choices: ['staging', 'production'], default: 'staging' },
      },
      run: ({ argv }) => console.log(`  deploying ${argv.service} to ${argv.env}`),
    },
    fail: {
      run() {
        throw new Error('Could not read /home/ada/.config/demo/token');
      },
    },
  },
};

const runs =
  process.argv.length > 2
    ? [process.argv.slice(2)]
    : [
        ['deploy', 'api', '--env', 'production'],
        // an alias, and an option nobody declared: accepted, and neither is recorded
        ['d', 'api', '--token', 'hunter2'],
        // a typo never reaches a command, so only `beforeError` sees it
        ['deplyo', 'api'],
        ['deploy', 'api', '--env', 'prod'],
        // a throw fires both hooks, and is still one event
        ['fail'],
      ];

for (const argv of runs) {
  console.log(`$ demo ${argv.join(' ')}`);
  try {
    // `errorHandler: false` hands the error back, so it is printed here, on
    // stdout, beside the event that left it out
    await main({ argv, schema, settings: { errorHandler: false } });
  } catch (err) {
    console.log(`  error: ${err.message}`);
  }
}
