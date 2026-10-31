import { filePicker, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
/**
 * A file picker: browse a directory tree with the arrows.
 *
 *   node demos/components/35-file-picker.js
 *   node demos/components/35-file-picker.js | cat    <- a scripted run, no terminal needed
 *
 * `path()` is a field you type a path into; this is a list you walk. Right goes
 * into the highlighted directory, Left or Backspace comes back out onto the one
 * you left, Enter goes into a directory and chooses a file, and `.` shows the
 * dotfiles that are skipped until you ask. The answer is the entry you land on.
 *
 * Piped, there is nobody to press keys, so the same prompts are driven by a
 * scripted keyboard over a throwaway directory and the screen is printed after
 * each step. That is the in-process terminal the `testing` subpath gives an
 * app's own tests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

async function interactive() {
  try {
    const config = await filePicker({
      message: 'Which config file?',
      extensions: ['json', 'yaml', 'yml'],
    });
    const outDir = await filePicker({
      message: 'Where should the output go?',
      // files are not listed, and the first row is the directory you are in
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
  const root = mkdtempSync(join(tmpdir(), 'sigil-file-picker-demo-'));

  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, '.cache'));
    for (const file of [
      'app.json',
      'app.yaml',
      'README.md',
      '.env',
      'src/main.ts',
      'src/util.ts',
    ]) {
      writeFileSync(join(root, file), '');
    }

    const ui = createTestTerminal({ columns: 130, rows: 10 });
    const show = async (label, ...keys) => {
      await ui.press(...keys);
      await settle();
      console.log(`-- ${label}`);
      console.log(ui.lines.join('\n'));
      console.log();
    };

    const config = filePicker({
      message: 'Which config?',
      root,
      terminal: ui.terminal,
      extensions: ['json', 'yaml', 'ts'],
    });
    await settle();
    console.log('-- opened: directories first, with .cache and .env skipped');
    console.log(ui.lines.join('\n'));
    console.log();

    await show('Up: wraps to the last row', KEYS.up);
    await show(
      'Home, Down, Down, then Right: into src',
      KEYS.home,
      KEYS.down,
      KEYS.down,
      KEYS.right
    );
    await show('Left: back out, onto the directory it left', KEYS.left);
    await show('.: the dotfiles, with the highlight kept', '.');
    await show('.: and hidden again', '.');

    await ui.press(KEYS.right, KEYS.down, KEYS.enter);
    console.log(`answer: ${relative(root, await config)}\n`);

    const dir = filePicker({
      message: 'Output directory?',
      root,
      terminal: ui.terminal,
      directory: true,
      confine: true,
    });
    await settle();
    console.log('-- directory + confine: directories only, and "." is the one it is in');
    console.log(ui.lines.join('\n'));
    console.log();

    await show('Left at the root: confined, so nowhere to go', KEYS.left);
    await ui.press(KEYS.enter);
    console.log(`answer: ${relative(root, await dir) || '.'}`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

// both sides, because keys are read off stdin and the list is drawn to the terminal's output
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
