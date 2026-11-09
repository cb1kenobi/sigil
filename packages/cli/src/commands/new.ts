/**
 * `sigil new`: scaffold an app.
 *
 * ## What it asks, and what it works out
 *
 * It asks about the three things that change what gets written and have no
 * defensible default for a project that does not exist yet: the name, the
 * language, and whether there is one command or several. It asks about a linter
 * because people have preferences there and the answer is a config file nobody
 * enjoys writing twice.
 *
 * A full-screen app is a fourth, and it is asked **after** the layout because it
 * is something a command does rather than a way of arranging them. Only when
 * there is one does it go on to ask where it is launched from -- the app itself,
 * or a command of its own -- and which template syntax it is written in.
 *
 * It does *not* ask about the package manager -- `npm_config_user_agent` says
 * which one invoked it, so asking would be asking a question whose answer is
 * already on the table. Nor about git, which it just does.
 *
 */

import { displayPath } from '../build/index.ts';
import {
  commandNameProblem,
  DEFAULT_TUI_COMMAND,
  type Language,
  type Layout,
  type Linter,
  type Manager,
  MANAGERS,
  nameProblem,
  otherSyntaxCommand,
  runScript,
  scaffold,
  type ScaffoldFile,
  type Syntax,
  SYNTAXES,
  type Tui,
} from '../scaffold/index.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { confirm, select, text } from '@ttylabs/sigil/components/prompt';
import { expand } from '@ttylabs/sigil/paths';
import { which } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** This toolchain's own manifest, for the versions it writes. */
function toolchainManifest(): { devDependencies: Record<string, string>; version: string } {
  const path = new URL('../../package.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8')) as {
    devDependencies: Record<string, string>;
    version: string;
  };
}

/**
 * Which package manager to use, asked only when there is something to ask.
 *
 * This used to read `npm_config_user_agent`, on the argument that a question
 * whose answer is already on the table is not worth asking. The answer was on
 * the table less often than that assumed: the variable is set by the package
 * manager that *invoked* this process, so running the toolchain directly --
 * `node src/sigil.ts new`, which is the dev loop, and any global install --
 * sets nothing and the scaffold silently said `npm` to somebody who has not
 * used it in years.
 *
 * What is actually knowable is which ones are installed, which is what `which`
 * is for. One installed is not a question. Several is a real preference and
 * nothing here can infer it, so it is asked, with pnpm preselected because it
 * is the one somebody went and installed on purpose.
 *
 * @param argv - The parsed options.
 * @param yes - Whether to take the default rather than asking.
 * @returns The manager to use.
 */
async function askManager(argv: Record<string, unknown>, yes: boolean): Promise<Manager> {
  if (typeof argv.pm === 'string') {
    return argv.pm as Manager;
  }

  const found = await Promise.all(
    MANAGERS.map(async (name) => ((await which(name)) ? name : null))
  );
  const installed = found.filter((name): name is Manager => name !== null);

  // npm ships with node, so nothing found means a PATH this cannot see rather
  // than a machine with no package manager on it -- and naming the one that is
  // always there beats refusing to finish a scaffold that is already written
  if (installed.length === 0) {
    return 'npm';
  }
  if (installed.length === 1) {
    return installed[0] as Manager;
  }

  const preferred: Manager = installed.includes('pnpm') ? 'pnpm' : 'npm';

  if (yes) {
    return preferred;
  }

  return (await select({
    choices: installed.map((name) => ({ label: name, value: name })),
    initial: installed.indexOf(preferred),
    message: 'Which package manager would you like to use?',
  })) as Manager;
}

/** Whether a directory is absent or empty, which is the only place to scaffold. */
function usable(dir: string): boolean {
  if (!existsSync(dir)) {
    return true;
  }
  try {
    // a lone `.git` is fine: `git init` then `sigil new` is an ordinary order
    // to do things in, and refusing it would be refusing the case
    return readdirSync(dir).filter((name) => name !== '.git').length === 0;
  } catch {
    return false;
  }
}

const newApp: AnyCommand = command({
  args: [
    {
      desc: 'The directory to create, which is also the app name',
      name: '[project-name]',
    },
  ],
  desc: 'Create a new app',
  options: {
    '--cwd [dir]': {
      desc: 'Where to create it, defaulting to the working directory',
    },
    '--js': { desc: 'Generate JavaScript files instead of TypeScript', type: 'bool' },
    '--lint [linter]': {
      choices: ['oxlint', 'eslint', 'biome', 'none'],
      desc: 'Which linter to set up',
    },
    '--no-git': { desc: 'Do not run git init' },
    '--pm [manager]': {
      choices: [...MANAGERS],
      desc: 'Which package manager to set the app up with',
    },
    '--no-install': { desc: 'Do not install dependencies' },
    '--single': { desc: 'One command rather than a commands directory', type: 'bool' },
    '--syntax [syntax]': {
      choices: [...SYNTAXES],
      desc: 'Which template syntax the full-screen app is written in',
    },
    // its own destination rather than the negated twin of `--tui`, which is what
    // `negate: false` is for: `--tui` has to stay `false` when it was not passed,
    // and `--no-tui` is the only way to say a script does not want the question
    '--no-tui': {
      desc: 'Do not include a full-screen app, and do not ask',
      negate: false,
      type: 'bool',
    },
    '--tui': {
      desc: 'Include a full-screen app, launched from the app itself',
      type: 'bool',
    },
    '--tui-command [name]': {
      desc: 'Include a full-screen app, launched from a command of this name',
    },
    '-y, --yes': { desc: 'Take the defaults for anything not passed', type: 'bool' },
  },

  async run({ argv }) {
    const yes = Boolean(argv.yes);

    // first, before the name is asked for: a flag that cannot work is refused
    // before any question, so nothing has been answered when it is
    checkTuiFlags(argv, yes);

    const name = await askName(argv.projectName as string | undefined, yes);
    const problem = nameProblem(name);
    if (problem) {
      throw new Error(`${problem}: "${name}"`);
    }

    const dir = join(parentDir(argv.cwd as string | undefined), name);
    if (!usable(dir)) {
      throw new Error(`${displayPath(dir)} already exists and is not empty`);
    }

    const language = await askLanguage(argv, yes);
    const layout = await askLayout(argv, yes);
    const tui = await askTui(argv, yes, layout, name);
    const syntax = await askSyntax(argv, yes, tui);
    const linter = await askLinter(argv, yes);
    const pm = await askManager(argv, yes);

    const own = toolchainManifest();
    const files = scaffold({
      language,
      layout,
      linter,
      // the release workflow installs and runs the app's tests, and doing that
      // with a manager the app was not set up with is how a scaffolded CI fails
      // on its first tag
      manager: pm,
      name,
      syntax,
      tui,
      version: own.version,
      versions: own.devDependencies,
    });

    write(dir, files);

    if (argv.git !== false) {
      run('git', ['init', '--quiet'], dir);
    }
    if (argv.install !== false) {
      process.stdout.write(`\nInstalling with ${pm}...\n`);
      run(pm, ['install'], dir);
    }

    process.stdout.write(
      `\nCreated ${name} in ${displayPath(dir)}.\n\n  cd ${displayPath(relative(process.cwd(), dir) || '.')}\n` +
        (argv.install === false ? `  ${pm} install\n` : '') +
        (tui?.at === 'root' ? `  ${runScript(pm, 'dev')}\n` : '') +
        (tui?.at === 'command' ? `  ${runScript(pm, 'dev', tui.command)}\n` : '') +
        `  ${runScript(pm, 'dev', '--help')}\n` +
        // said once, after the steps and only to somebody who was given JSX: a
        // build is the price of it, and the other syntax is the answer to
        // paying it. One line, and the command is one that runs as it is written;
        // it is not wrapped, since the terminal does that and a hard break at
        // 88 columns is wrong at every other width
        (tui && syntax === 'jsx'
          ? `\nThe app is in JSX, so \`dev\` builds it before it runs. The \`ui\` tag is the build-free alternative: \`${otherSyntaxCommand({ language, layout, name, syntax, tui })}\`\n`
          : '')
    );
  },
});

/**
 * The directory the project is created *in*.
 *
 * The name is validated as an npm package name, so it can never hold a
 * separator -- which is what made `sigil new ~/projects/my-cli` an error rather
 * than a location, and what left an `isAbsolute(name)` branch here that could
 * not be reached. Saying where and saying what it is called are two questions,
 * so they are two inputs.
 *
 * `expand()` rather than `resolve()` alone, because a `~` only reaches a
 * process when the shell did not eat it -- `--cwd "~/projects"` is quoted, and
 * `resolve()` would make a directory *called* `~`. That is the failure
 * `paths.ts` already records, met from the one place a user hands this tool a
 * path to write into.
 *
 * It is not required to exist: the scaffold makes each file's directory as it
 * goes, so a `--cwd` naming somewhere new is `mkdir -p` rather than an error.
 *
 * @param cwd - What `--cwd` said, if anything.
 * @returns The absolute directory to create the project inside.
 */
function parentDir(cwd: string | undefined): string {
  return cwd === undefined ? process.cwd() : resolve(process.cwd(), expand(cwd));
}

/** Asks for the name, or takes the one that was given. */
async function askName(given: string | undefined, yes: boolean): Promise<string> {
  if (given !== undefined) {
    return given;
  }
  if (yes) {
    throw new Error(
      'A project name is required. Pass it as an argument, or drop --yes to be asked.'
    );
  }

  return (await text({ message: 'What is it called?', placeholder: 'my-cli' })).trim();
}

/** Asks whether it is TypeScript, defaulting to yes. */
async function askLanguage(argv: Record<string, unknown>, yes: boolean): Promise<Language> {
  if (argv.js) {
    return 'js';
  }
  if (yes) {
    return 'ts';
  }

  return (await confirm({ message: 'Would you like to use TypeScript?' })) ? 'ts' : 'js';
}

/** Asks whether there are subcommands, defaulting to yes. */
async function askLayout(argv: Record<string, unknown>, yes: boolean): Promise<Layout> {
  if (argv.single) {
    return 'single';
  }
  // a command to launch the app from is a command, so the question has been
  // answered: asking it anyway let somebody say "no, a single command" and then
  // fail with a guard from the scaffold after every question was answered
  if (yes || typeof argv.tuiCommand === 'string') {
    return 'multi';
  }

  return (await select({
    choices: [
      {
        hint: 'a commands/ directory, one file each',
        label: 'Yes, several commands',
        value: 'multi',
      },
      { hint: 'the app itself is the command', label: 'No, a single command', value: 'single' },
    ],
    message: 'Will it have subcommands?',
  })) as Layout;
}

/**
 * Refuses the flag combinations that cannot mean anything, before anything is asked.
 *
 * Three of them, and each is a flag that would otherwise be accepted and do
 * nothing -- which is how a typo becomes an app that is not what was asked for:
 *
 * - `--tui-command` with `--single`, since there is no command to launch from.
 *   The message says what to pass instead, because the intent is clear and only
 *   the spelling is wrong.
 * - A command name that cannot be a file and a command at once.
 * - `--syntax` where nothing will be asked for a TUI at all: under `--yes`, with
 *   neither TUI flag. Interactively it is not refused here, because the answer to
 *   the question that follows may yet be yes.
 *
 * @param argv - The parsed options.
 * @param yes - Whether defaults are being taken.
 */
function checkTuiFlags(argv: Record<string, unknown>, yes: boolean): void {
  const command = argv.tuiCommand;
  const named = typeof command === 'string';

  if (argv.noTui && (argv.tui || named || argv.syntax !== undefined)) {
    throw new Error(
      `--no-tui says there is no full-screen app, and ${argv.tui ? '--tui' : named ? '--tui-command' : '--syntax'} asks for one.`
    );
  }
  if (argv.tui && named) {
    throw new Error(
      '--tui launches the full-screen app from the app itself and --tui-command from a command. Pass one of them.'
    );
  }

  if (named) {
    if (argv.single) {
      throw new Error(
        '--tui-command needs a commands directory to put the command in, and --single has none. Use --tui to launch the full-screen app from the app itself.'
      );
    }
    const problem = commandNameProblem(command);
    if (problem) {
      throw new Error(`${problem}: "${command}"`);
    }
  }

  if (argv.syntax !== undefined && yes && !argv.tui && !named) {
    throw new Error(
      '--syntax chooses how a full-screen app is written, and there is none. Add --tui.'
    );
  }
}

/**
 * Asks whether there is a full-screen app and where it is launched from.
 *
 * Nothing is the default, which is the one question here that is not "yes":
 * most CLIs are not full-screen apps, and one that is knows it. `--tui` is the
 * app itself and `--tui-command` is a command, and either answers the whole
 * question. Interactively, only a multi-command app is asked where, since a
 * single command has nowhere but itself.
 *
 * @param argv - The parsed options.
 * @param yes - Whether to take the default rather than asking.
 * @param layout - How the commands are arranged.
 * @param app - The app's name, which the question names.
 * @returns Where it is launched from, or `undefined` for none.
 */
async function askTui(
  argv: Record<string, unknown>,
  yes: boolean,
  layout: Layout,
  app: string
): Promise<Tui | undefined> {
  if (typeof argv.tuiCommand === 'string') {
    return { at: 'command', command: argv.tuiCommand };
  }
  if (argv.tui) {
    return { at: 'root' };
  }
  // `--no-tui` is how a script that passes every flag but `--yes` says so
  if (yes || argv.noTui) {
    return undefined;
  }

  if (!(await confirm({ default: false, message: 'Include a full-screen app (TUI)?' }))) {
    return undefined;
  }
  if (layout === 'single') {
    return { at: 'root' };
  }

  const where = (await select({
    choices: [
      { hint: 'running it with no command opens the app', label: app, value: 'root' },
      { hint: `${app} on its own shows help`, label: 'A command', value: 'command' },
    ],
    message: `Launch it from \`${app}\`, or from a command?`,
  })) as 'command' | 'root';

  if (where === 'root') {
    return { at: 'root' };
  }

  const command = (
    await text({
      default: DEFAULT_TUI_COMMAND,
      message: 'What is the command called?',
      placeholder: DEFAULT_TUI_COMMAND,
      validate: (value) => commandNameProblem(value.trim() || DEFAULT_TUI_COMMAND),
    })
  ).trim();

  return { at: 'command', command: command || DEFAULT_TUI_COMMAND };
}

/**
 * Asks which template syntax, JSX by default, and only when there is an app to write.
 *
 * @param argv - The parsed options.
 * @param yes - Whether to take the default rather than asking.
 * @param tui - What `askTui()` answered.
 * @returns The syntax, or `undefined` when there is no full-screen app.
 */
async function askSyntax(
  argv: Record<string, unknown>,
  yes: boolean,
  tui: Tui | undefined
): Promise<Syntax | undefined> {
  if (tui === undefined) {
    if (argv.syntax !== undefined) {
      // reached only interactively, by a `--syntax` and then a "no" to the app
      throw new Error('--syntax chooses how a full-screen app is written, and none was asked for');
    }
    return undefined;
  }
  if (typeof argv.syntax === 'string') {
    return argv.syntax as Syntax;
  }
  if (yes) {
    return 'jsx';
  }

  return (await select({
    choices: [
      { hint: 'typed props in an editor; built to run', label: 'JSX', value: 'jsx' },
      { hint: 'runs as it is, with no build', label: 'The ui tag', value: 'ui' },
    ],
    message: 'Which template syntax?',
  })) as Syntax;
}

/** Asks which linter, defaulting to oxlint. */
async function askLinter(argv: Record<string, unknown>, yes: boolean): Promise<Linter> {
  if (typeof argv.lint === 'string') {
    return argv.lint as Linter;
  }
  if (yes) {
    return 'oxlint';
  }

  return (await select({
    choices: [
      { hint: 'fast, near-zero config', label: 'oxlint', value: 'oxlint' },
      { label: 'eslint', value: 'eslint' },
      { label: 'biome', value: 'biome' },
      { label: 'none', value: 'none' },
    ],
    message: 'Which linter would you like to use?',
  })) as Linter;
}

/** Writes the files, making directories as it goes. */
function write(dir: string, files: readonly ScaffoldFile[]): void {
  for (const file of files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents, file.executable ? { mode: 0o755 } : undefined);
  }
}

/**
 * Runs a command in the new app, reporting rather than failing the scaffold.
 *
 * The files are already written by the time either of these runs, so a failed
 * `git init` or a failed install is not a reason to call the whole thing a
 * failure -- it is a reason to say which step to run by hand.
 *
 * @param cmd - The program.
 * @param argv - Its arguments.
 * @param cwd - Where to run it.
 */
function run(cmd: string, argv: string[], cwd: string): void {
  const result = spawnSync(cmd, argv, {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.stderr.write(
      `\n${cmd} ${argv.join(' ')} did not succeed; run it yourself in the new app.\n`
    );
  }
}

export default newApp;
