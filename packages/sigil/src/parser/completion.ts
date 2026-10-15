/**
 * The `completion` command a schema gets for free, wired the way `help` is.
 *
 * ## Why the framework owns it
 *
 * The same argument `--version` settled, and it lands harder here. A completion
 * script is printed from the command tree, the options and the `choices` an app
 * declared -- all of which are the *parser's*, not the app's, so an app writing
 * its own completion command would be reimplementing the walk this one does.
 * And `sigil build` generates the executable and calls `main()`, so a command
 * an app wrapped around `main()` is not in the bundle: a completion command
 * that was the app's would work from source and vanish once built, which is the
 * divergence `--version` is already written down for.
 *
 * On the root, because that is where a command every invocation can reach
 * belongs, and nothing is added over the top of what the app declared: an app
 * with its own `completion` keeps it and gets nothing from here, which is the
 * only reading of a declaration that means anything.
 *
 * `schema.completion: false` turns it off, for an app that does not want the
 * name taken.
 *
 * ## A named shell prints; a missing one says how to install
 *
 * `app completion bash > …` is the scriptable form and is what `gh`, `kubectl`,
 * `rustup` and `deno` all do -- both generated headers document the redirect, so
 * it stays a printer and nothing about it moved.
 *
 * What moved is the **bare** form. `Missing required arguments: <shell>` was the
 * answer to "set up completion for me", and it names the grammar rather than the
 * thing to do -- to a reader who does not necessarily know which shell they are
 * in. So `[shell]` is optional: omitted, it reads `$SHELL` and prints the routes
 * for what it found, or names the shells it can print for when it cannot tell.
 * An invalid name is still an error, because `choices` is judged on the way in.
 *
 * It goes to stderr and exits non-zero, which is the better *error* rather than
 * an answer: `app completion > file` must not fill the file the reader wanted a
 * script in. What makes it exit zero is having actually installed something,
 * which is the installer's -- and that is a separate ticket because it writes to
 * a user's home directory, which had four decisions in it that belong to the
 * user. Three are now taken: write the script file, **print** the rc line rather
 * than editing a dotfile, and confirm first. What is left to it is the paths, the
 * idempotency and taking it back out again.
 *
 * ## The emitters are behind a dynamic import
 *
 * `run` reaches them with `await import()`, exactly as `main()` reaches the
 * parser and the help screen. So a CLI that answers `--version` pays for the
 * command *existing* -- a name in a registry and an argument -- and not for
 * anything that prints a script.
 */

// the names alone, and statically: a `choices` list has to exist while the
// schema is built, so this is on the parse path -- which is why it is its own
// module rather than the barrel. It imports nothing and holds two short
// strings, so a bundler folds it into the chunk the parse is already in,
// where a dynamic import would be a second module fetch on every run of
// every app. The *emitters* are the thing worth deferring, and `run` below is
// where that happens
import { SHELL_NAMES } from '../completion/shells.js';
import { __ } from '../i18n/index.js';
import { Internal, type InternalCommand, type ParseState, type Schema } from '../types.js';
import { initCommand } from './command/init-command.js';

/**
 * Adds `completion` to the root context, unless the app has its own or has
 * turned it off.
 *
 * @param root - The root context, built from the schema.
 * @param schema - The schema, for `completion: false`.
 */
export async function registerCompletion(root: InternalCommand, schema: Schema): Promise<void> {
  if (schema.completion === false) {
    return;
  }

  const internal = root[Internal];

  // `find()` answers about the aliases as well as the name, which is what has
  // to be free: an app whose `shell` command is aliased `completion` would
  // otherwise have that alias quietly repointed at this one
  if (internal.commands.find('completion')) {
    return;
  }

  const command = await initCommand({
    args: [
      {
        choices: SHELL_NAMES,
        desc: __`The shell to generate for`,
        // optional, because `Missing required arguments: <shell>` is the
        // worst answer available to "set up completion for me": it names
        // the grammar rather than the thing to do, and the reader does not
        // necessarily know which shell they are in. Named, it prints the
        // script; omitted, it says how to install one for the shell it
        // found. An invalid name is still an error, because `choices` is
        // judged on the way in
        name: '[shell]',
      },
    ],
    desc: __`Print a shell completion script`,
    name: 'completion',

    async run(state: ParseState) {
      const { completionScript } = await import('../completion/index.js');
      const { detectShell, instructions } = await import('../completion/install.js');

      // `choices` has judged it by the time any `run` is reached, so a string
      // here is one of the shells
      const named = state.argv.shell;
      if (typeof named === 'string') {
        process.stdout.write(await completionScript(state, named));
        return;
      }

      const program = state.schema.name ?? 'app';
      const shell = detectShell(process.env);

      // stderr and a non-zero exit, because this is the better *error*
      // rather than an answer: `app completion > file` must not write
      // instructions into what the reader wanted a script in, and a script
      // that checked the exit code still sees that no shell was named. What
      // makes it exit zero is having actually installed something, which is
      // the installer's to do
      process.stderr.write(
        shell
          ? `${__`Set up completion for ${program}, detected ${shell}:`}\n\n${instructions(shell, program)}`
          : `${__`Name a shell to set up completion for ${program}:`}\n\n${SHELL_NAMES.map(
              (name) => `    ${program} completion ${name}\n`
            ).join('')}\n`
      );
      process.exitCode = 1;
    },
  });

  // what makes `app completion zsh` reachable on an app with a required global
  // option: the script is a function of the schema, so a value argv did not
  // carry is not missing from anything. See `needsNoValues`
  command[Internal].needsNoValues = true;

  internal.commands.add(command);
}
