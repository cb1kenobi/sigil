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
 * ## A bare `completion` on a terminal installs it
 *
 * Which is what makes it exit zero: it has done something. It asks which shell
 * -- a `select()` with what `$SHELL` named already highlighted, so the detected
 * answer is one Enter away and the override is an arrow key, which is where
 * `select()` earns its place over a `confirm()` -- then shows the exact path it
 * will write and the exact line to add, asks, writes the file and prints the
 * line. The line is printed rather than appended, because a `.zshrc` is a file
 * the user has an opinion about and very often has under version control.
 * `--uninstall` is the same thing backwards.
 *
 * With nobody to ask it prints the instructions and exits non-zero, which is
 * what it did before an installer existed -- and that falls out of one
 * mechanism rather than a second reading of "is there a terminal": `run()` in
 * `components/prompt.ts` rejects with a `PromptError` when either end is not a
 * terminal, so the fallback is a `catch`. A check of our own would read
 * `process.stdout.isTTY` where the prompt reads the `Terminal` wrapper *and*
 * stdin, and the two disagree about `app completion < /dev/null` from a
 * terminal. What that costs is the 9.5ms of module load the prompts are --
 * measured, eight runs each -- on a path whose answer is already an error.
 *
 * The stderr and the non-zero are still the better *error* rather than an
 * answer: `app completion > file` must not fill the file the reader wanted a
 * script in, and a script that checked the exit code still sees that nothing
 * was installed.
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
    options: {
      // the only option, and there is deliberately no `--force` beside it.
      // `sigil add` needs one because it has nobody to ask; this asks, so a
      // file that is not ours is named in the plan and the question says what
      // replacing it means. A flag whose whole job is to answer a question
      // somebody is being asked anyway is one more thing to document
      '--uninstall': { desc: __`Remove the script instead of writing one` },
    },

    async run(state: ParseState) {
      // `find` over the same list `choices` was built from, which narrows to
      // `ShellName` with no cast: `choices` has judged the value by the time
      // any `run` is reached, so a match is the shell and a miss is argv
      // having named none
      const named = SHELL_NAMES.find((name) => name === state.argv.shell);
      const uninstall = state.argv.uninstall === true;

      // the scriptable form, unchanged: a named shell prints, which is what
      // `gh`, `kubectl`, `rustup` and `deno` all do and what both generated
      // headers document the redirect for. `--uninstall` is the one thing that
      // makes a named shell mean something else, because there the shell says
      // *which* installation to take out rather than what to print
      if (named !== undefined && !uninstall) {
        const { completionScript } = await import('../completion/index.js');
        process.stdout.write(await completionScript(state, named));
        return;
      }

      // everything the installer is lives behind this, which is what keeps the
      // parse chunk a dispatcher: see `interactive.ts` for the measurement
      const { runInstaller } = await import('../completion/interactive.js');
      process.exitCode = await runInstaller(state, { shell: named, uninstall });
    },
  });

  // what makes `app completion zsh` reachable on an app with a required global
  // option: the script is a function of the schema, so a value argv did not
  // carry is not missing from anything. See `needsNoValues`
  command[Internal].needsNoValues = true;

  internal.commands.add(command);
}
