import { path, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
/**
 * A path prompt: a text field that completes against the file system.
 *
 *   node demos/components/18-path.js
 *   node demos/components/18-path.js | cat    <- a scripted run, no terminal needed
 *
 * Type a path. Tab fills in as much as every candidate agrees on, and a list of
 * the candidates sits under the field. Up and Down walk the list; Enter on the
 * field answers with what you typed, and Enter on a highlighted entry takes it.
 * A directory completes with a separator on the end, so typing carries on into
 * it. Try `~/`, a directory that is not there, and `.` for the dotfiles that are
 * skipped until you ask.
 *
 * Piped, there is nobody to type, so the same prompts are driven by a scripted
 * keyboard over a throwaway directory and the screen is printed after each step.
 * That is the in-process terminal the `testing` subpath gives an app's own tests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

async function interactive() {
  try {
    const config = await path({
      message: 'Which config file?',
      extensions: ['json', 'yaml', 'yml'],
      placeholder: './',
    });
    const outDir = await path({
      message: 'Where should the output go?',
      // only directories are offered, and the answer is resolved against `root`
      directory: true,
      root: process.cwd(),
    });

    console.log('\n---');
    console.log({ config, outDir });
  } catch (err) {
    if (err instanceof PromptError) {
      // a prompt with nobody to answer it rejects, and Ctrl-C is the abort
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

/** Lets the file system answer: a read is real I/O, which a tick does not wait for. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function scripted() {
  const root = mkdtempSync(join(tmpdir(), 'sigil-path-demo-'));

  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, '.cache'));
    for (const file of [
      'app.json',
      'app.yaml',
      'README.md',
      '.env',
      'src/main.ts',
      'src/main.test.ts',
    ]) {
      writeFileSync(join(root, file), '');
    }

    const ui = createTestTerminal({ columns: 56, rows: 10 });
    const show = async (label, ...keys) => {
      await ui.press(...keys);
      await settle();
      console.log(`-- ${label}`);
      console.log(ui.lines.join('\n'));
      console.log();
    };

    // a root, so a relative answer comes back absolute and these paths are
    // under the throwaway directory
    const config = path({
      message: 'Which config?',
      root,
      terminal: ui.terminal,
      extensions: ['json', 'yaml', 'ts'],
    });
    await settle();
    console.log('-- opened: the root, with .cache and .env skipped');
    console.log(ui.lines.join('\n'));
    console.log();

    await show('a', 'a');
    await show('Tab: the longest prefix they share', KEYS.tab);
    await show('Tab again: nothing more to add', KEYS.tab);
    await show(
      'Ctrl-U, then s and Tab: a lone directory takes a separator',
      '\u0015',
      's',
      KEYS.tab
    );
    await show('main. -- two candidates', 'm', 'a', 'i', 'n', '.');
    await show('Tab: they share main.t', KEYS.tab);
    await show('Down: highlight one', KEYS.down);
    await show('Up: back to nothing highlighted, so Enter would mean the field', KEYS.up);

    await ui.press(KEYS.down, KEYS.down, KEYS.enter);
    console.log(`answer: ${relative(root, await config)}\n`);

    const dir = path({
      message: 'Output directory?',
      root,
      terminal: ui.terminal,
      directory: true,
      hidden: true,
    });
    await settle();
    console.log('-- directory + hidden: only directories, dotfiles included');
    console.log(ui.lines.join('\n'));
    console.log();
    await ui.press('d', KEYS.tab, KEYS.enter);
    console.log(`answer: ${relative(root, await dir)}`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

// both sides, because the field is read off stdin and drawn to the terminal's output
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
