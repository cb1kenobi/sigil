import { page } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { readFileSync } from 'node:fs';
/**
 * A pager: a long document on the whole screen, with the keys `less` taught everybody.
 *
 *   node demos/components/40-pager.js                  <- a changelog, line numbers on
 *   node demos/components/40-pager.js README.md        <- any file you like
 *   node demos/components/40-pager.js | cat            <- a scripted run, no terminal needed
 *
 * Space and `b` page, `d` and `u` move half a window, `g` and `G` go to either end,
 * `/` searches, `n` and `N` step through the matches, and `q` gives the screen back
 * exactly as it was. Every match is drawn reversed and the current one in the
 * accent; the status line says which one it is and how many there are. A query is
 * literal and smart-case: `fix` finds `Fix`, and `Fix` does not find `fix`.
 *
 * Long lines fold at the window's edge, at the column rather than the word, so
 * every character of the file is on screen in order. Resize the window and the
 * text folds again while the line at the top stays at the top.
 *
 * Piped, there is nobody to press anything, so the same `page()` is driven by a
 * scripted keyboard (`createTestTerminal()` from `@ttylabs/sigil/testing`) and the
 * screen is printed after each step. On its own, `page()` with its output piped
 * writes the document straight through, the way `less` does -- the last step shows
 * that too.
 */

/** A made-up changelog: long enough to page, with things worth searching for. */
function changelog() {
  const out = [];
  const areas = ['parser', 'renderer', 'pager', 'prompts', 'layout', 'theme'];
  for (let minor = 12; minor >= 1; minor--) {
    out.push(`## 0.${minor}.0`, '');
    for (let i = 0; i < 6; i++) {
      const area = areas[(minor + i) % areas.length];
      const kind = i % 3 === 0 ? 'Fix' : i % 3 === 1 ? 'Add' : 'Change';
      out.push(
        `- ${kind} (${area}): ${i % 2 === 0 ? 'a line long enough that a narrow window has to fold it onto the row below' : 'short'}`
      );
    }
    out.push('');
  }
  return out.join('\n');
}

async function interactive() {
  const file = process.argv[2];
  const content = file ? readFileSync(file, 'utf8') : changelog();
  await page(content, { lineNumbers: true });
  console.log('back on the main screen, with the log exactly where it was');
}

async function scripted() {
  const ui = createTestTerminal({ columns: 52, rows: 10 });
  const done = page(changelog(), {
    // frames as fast as the keys arrive, so each step prints the frame it caused
    frameMs: 0,
    lineNumbers: true,
    terminal: ui.terminal,
  });

  const frame = () => new Promise((resolve) => setTimeout(resolve, 20));
  const show = async (label, ...keys) => {
    if (keys.length > 0) {
      await ui.press(...keys);
    }
    await frame();
    console.log(`-- ${label}`);
    console.log(ui.viewport.map((line) => line.trimEnd()).join('\n'));
    console.log();
  };

  await show('opened: line numbers, a folded line numbered once, and where you are');
  await show('Space: a window less a row, so one line of context survives', ' ');
  await show(
    '/fix Enter: smart case, so Fix matches, and the first match on screen is current',
    '/',
    'fix',
    KEYS.enter
  );
  await show('n: the next one is off screen, so the window moves to its line', 'n');
  await show('G: the end', 'G');
  await show('n: the next match from where you are, not the one after the last', 'n');
  await show(
    '/(pager Enter: literal, so a parenthesis is a parenthesis',
    '/',
    '(pager',
    KEYS.enter
  );
  await ui.press('q');
  await done;
  console.log('-- q: the alternate screen is gone and nothing was left in the log');
  console.log(JSON.stringify(ui.lines));
  console.log();

  // and with nobody on the other end at all: the text, straight through
  const piped = createTestTerminal({ columns: 52, isTTY: false });
  await page('first line\nsecond line', { terminal: piped.terminal });
  console.log('-- page() with its output piped writes the document as it was given');
  console.log(piped.output.trimEnd());
}

// both sides, because the keys are read off stdin and the pages drawn to stdout
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
