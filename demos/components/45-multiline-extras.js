import { multiline, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';

/**
 * A multiline field with line numbers, a gutter mark, a character limit and
 * syntax highlighting.
 *
 *   node demos/components/45-multiline-extras.js
 *   node demos/components/45-multiline-extras.js | cat    <- scripted, no terminal
 *
 * The numbers count lines of the value, so a line that soft wraps is numbered on
 * its first row only, and the caret's line is the one number not muted. The mark
 * is drawn on every row. Neither is part of the answer.
 *
 * The highlighter below is two regular expressions, which is the point: there is
 * no grammar in the framework, and `highlight` is handed the whole value and
 * answers with spans of it. The block comment runs over a line break, which a
 * highlighter handed one line at a time could not say. `keyword` and `comment`
 * are names the framework draws in a role -- the accent and muted -- so they are
 * coloured with no stylesheet. Piped, there is no colour to see, and what the
 * scripted run shows is the layout and the limit.
 *
 * The count under the field is the limit: at 120 it turns to the warning colour,
 * typing inserts nothing, and a paste is cut to what fits.
 */

const KEYWORDS = /\b(?:const|let|return|function|if|else)\b/g;
const COMMENTS = /\/\*[^]*?\*\/|\/\/.*/g;

/** Every match of a pattern, as spans of one token. */
function spans(value, pattern, token) {
  return [...value.matchAll(pattern)].map((m) => ({
    end: m.index + m[0].length,
    start: m.index,
    token,
  }));
}

const options = {
  charLimit: 120,
  gutter: '│ ',
  // comments last, so a keyword inside one is drawn as the comment: where two
  // spans cover one character the later wins
  highlight: (value) => [
    ...spans(value, KEYWORDS, 'keyword'),
    ...spans(value, COMMENTS, 'comment'),
  ],
  initial: '/* double a number,\n   or say why not */\nfunction double(n) {\n  return n * 2;\n}',
  lineNumbers: true,
  message: 'Transform',
};

async function interactive() {
  try {
    const code = await multiline(options);
    console.log('\n---');
    console.log(code);
  } catch (err) {
    if (err instanceof PromptError) {
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

async function scripted() {
  const ui = createTestTerminal({ columns: 40, rows: 12 });
  const print = (label) => {
    console.log(`-- ${label}`);
    console.log(ui.lines.join('\n'));
    console.log();
  };

  const answer = multiline({ ...options, terminal: ui.terminal });
  // a prompt that rejects while keys are still going in is an unhandled rejection
  answer.catch(() => {});

  await ui.press();
  print('opened: five lines, numbered, with the caret on the last');

  await ui.press(KEYS.up, KEYS.end, ' // and a comment long enough to wrap');
  print('a line that soft wraps is numbered once');

  await ui.paste(' and a paste far too long to fit under the limit at all');
  print('the paste is cut to what fits, and the count says full');

  await ui.press(ctrl('d'));
  const code = await answer;
  print('Ctrl-D: one line in the log');
  console.log(JSON.stringify(code));
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
