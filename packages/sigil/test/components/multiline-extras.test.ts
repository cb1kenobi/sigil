import { strip } from '../../src/ansi/strip.js';
import {
  fieldBox,
  fieldLayers,
  fitted,
  gutterLayers,
  gutterOf,
  type HighlightSpan,
  layoutField,
  multiline,
  PromptError,
  tokenLayer,
  tokensOf,
} from '../../src/components/prompt.js';
import {
  arrange,
  box,
  renderToString,
  resolveStyles,
  selectableAt,
} from '../../src/element/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { graphemes } from '../../src/width/index.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * The textarea extras on `multiline()`: line numbers, a gutter mark, a character
 * limit and a highlight hook. `multiline.test.ts` is the field's own suite and is
 * left as it was, which is the check that none of this moved a field that asks
 * for none of it.
 */

/** Starts a prompt and reports how it settled, attached before any key is sent. */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** The rows under the question and over the footer, with the indent taken off. */
function fieldRows(ui: ScreenHarness): string[] {
  return ui.log.slice(1, -1).map((row) => row.slice(2));
}

/** A highlighter that names every match of a pattern as one token. */
function matching(pattern: RegExp, token: string): (value: string) => HighlightSpan[] {
  return (value) =>
    [...value.matchAll(pattern)].map((m) => ({
      end: m.index + m[0].length,
      start: m.index,
      token,
    }));
}

/**
 * A pattern for `text` written with the SGR parameter `code` among those opening it.
 *
 * Read as parameters rather than as one spelling, because a transition combines
 * what it closes with what it opens. Built from a string rather than written as a
 * literal, so that no control character sits in a pattern.
 */
function sgr(code: number, text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`${String.fromCharCode(0x1b)}\\[(?:\\d+;)*${code}m${escaped}`);
}

const ENTER = '\r';
const CTRL_D = '\u0004';
const UP = '\u001b[A';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const BACKSPACE = '\u007f';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';
const SGR_DIM = '\u001b[2m';

describe('multiline() line numbers and a gutter', () => {
  it('should number each line down the left of the field', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      initial: 'one\ntwo\nthree',
      lineNumbers: true,
      message: 'Why?',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'x');
    expect(fieldRows(ui)).to.deep.equal([' 1 one', ' 2 two', ' 3 threex']);

    await type(ui.stdin, CTRL_D);
    // the numbers are the field's and never the value's
    expect(await answer).to.equal('one\ntwo\nthreex');
  });

  it('should number a soft-wrapped line on its first row only', async () => {
    // forty columns, two of indent and three of gutter leave thirty-five, and the
    // caret takes one of those
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      initial: 'aaaa bbbb cccc dddd eeee ffff gggg hhhh\nz',
      lineNumbers: true,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'z');
    expect(fieldRows(ui)).to.deep.equal([
      ' 1 aaaa bbbb cccc dddd eeee ffff gggg',
      '   hhhh',
      ' 2 zz',
    ]);

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should hold two columns for the numbers, so the tenth line moves nothing', async () => {
    const ui = screenSetup({ rows: 16 });
    const answer = multiline({
      ansi: ui.ansi,
      initial: Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n'),
      lineNumbers: true,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'x');
    const before = fieldRows(ui)[0];
    await type(ui.stdin, ENTER, 'y');

    expect(fieldRows(ui)[0], 'the first line moved when the tenth arrived').to.equal(before);
    expect(fieldRows(ui).at(-1)).to.equal('10 y');

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should widen at a hundred lines, which is what the numbers need', async () => {
    const ui = screenSetup({ rows: 6 });
    const answer = multiline({
      ansi: ui.ansi,
      initial: Array.from({ length: 100 }, (_, i) => `${i + 1}`).join('\n'),
      lineNumbers: true,
      message: 'Hm',
      rows: 2,
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'x');
    expect(fieldRows(ui)).to.deep.equal([' 99 99', '100 100x']);

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should draw the mark on every row, wrapped or not', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      gutter: '│ ',
      initial: 'aaaa bbbb cccc dddd eeee ffff gggg\nz',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'z');
    // two columns of mark leave thirty-six, and the caret takes one
    expect(fieldRows(ui)).to.deep.equal(['│ aaaa bbbb cccc dddd eeee ffff gggg', '│ zz']);

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('aaaa bbbb cccc dddd eeee ffff gggg\nzz');
  });

  it('should draw the number and then the mark when it has both', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      gutter: '│ ',
      initial: 'a\nb',
      lineNumbers: true,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'c');
    expect(fieldRows(ui)).to.deep.equal([' 1 │ a', ' 2 │ bc']);

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should put the caret beside the gutter rather than under it', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      colorLevel: 1,
      gutter: '> ',
      initial: 'ab',
      lineNumbers: true,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, LEFT);
    // two of indent, two digits, a gap and two of mark: the `b` is at column eight
    expect(ui.screen.lastInverse).to.deep.equal({ column: 8, row: 1 });

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should number only the first row while the placeholder shows', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      lineNumbers: true,
      message: 'Hm',
      placeholder: 'first\nsecond',
      terminal: ui.terminal,
    });

    await type(ui.stdin, RIGHT);
    // a placeholder is not lines anybody wrote, so it is one line however it reads
    expect(fieldRows(ui)).to.deep.equal([' 1 first', '   second']);

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should go once the prompt is answered, leaving the one line it always left', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      gutter: '│ ',
      initial: 'a\nb',
      lineNumbers: true,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, CTRL_D);
    await answer;

    expect(ui.log).to.have.length(1);
    expect(ui.log[0]).to.match(/ Hm a \(\+1 more line\)$/);
  });

  it('should refuse a mark holding a control character, which no cell can hold', async () => {
    const ui = screenSetup();
    const { error } = await settle(
      multiline({ ansi: ui.ansi, gutter: '\t', message: 'Hm', terminal: ui.terminal })
    );

    expect(error).to.be.instanceOf(PromptError);
    expect(error?.message).to.contain('`gutter`');
  });
});

describe('gutterOf()', () => {
  it('should number a line on the row it starts and leave a continuation blank', () => {
    const value = 'aaa bbb\nc';
    expect(gutterOf(value, layoutField(value, 0, 5))).to.deep.equal([1, undefined, 2]);
  });

  it('should number an empty line, and the one after a trailing break', () => {
    const value = 'a\n\nb\n';
    expect(gutterOf(value, layoutField(value, 0, 20))).to.deep.equal([1, 2, 3, 4]);
  });

  it('should number a value it was not laid out from as one line', () => {
    // which is how the field numbers its placeholder
    expect(gutterOf('', layoutField('a\nb', 0, 20))).to.deep.equal([1, undefined]);
  });
});

describe('gutterLayers()', () => {
  /** The gutter for a value, with the caret's line marked active. */
  function frameOf(value: string, active: number | undefined) {
    const layout = layoutField(value, 0, 20);
    return {
      active,
      digits: 2,
      mark: '',
      numbers: gutterOf(value, layout),
      top: 0,
      visible: layout.rows.length,
    };
  }

  it('should mute every number but the caret line', () => {
    const frame = frameOf('a\nb\nc', 1);
    const { active, gutter } = gutterLayers(() => frame);
    const host = box({ position: 'relative' }, gutter, active);
    const out = renderToString(host, { cascade: themedCascade(), colorLevel: 1, width: 10 });
    const rows = out.split('\n');

    expect(strip(out)).to.equal(' 1\n 2\n 3');
    expect(rows[0], 'line 1 is not muted').to.contain(SGR_DIM);
    expect(rows[1], 'the caret line is muted').to.not.contain(SGR_DIM);
    expect(rows[2], 'line 3 is not muted').to.contain(SGR_DIM);
  });

  it('should draw only the rows in the window', () => {
    const frame = { ...frameOf('a\nb\nc', 2), top: 1, visible: 2 };
    const { active, gutter } = gutterLayers(() => frame);
    const host = box({ position: 'relative' }, gutter, active);

    expect(strip(renderToString(host, { cascade: themedCascade(), width: 10 }))).to.equal(' 2\n 3');
  });

  it('should leave the gutter out of what a selection copies', () => {
    // a `raw` that does not say it draws text is excluded, which is right here:
    // copying lines out of a numbered field and getting the numbers with them is
    // the thing every editor's gutter exists to avoid. Through `fieldBox()`,
    // because the tree is what decided it: with every layer in one positioned box,
    // the caret's insets covered the gutter and its `drawsText` put the numbers back
    const frame = frameOf('ab', 0);
    const layout = layoutField('ab', 0, 20);
    const tokens = tokensOf('ab', [{ end: 1, start: 0, token: 'keyword' }]);
    const read = () => ({ layout, tokens, top: 0, visible: 1 });
    const layers = fieldLayers(read);
    const { area, host } = fieldBox(
      layers,
      gutterLayers(() => frame)
    );
    // a token layer joins the field's box, the way the prompt adds one
    host.insertBefore(tokenLayer(read, layers.field, 'keyword'), layers.caret);

    resolveStyles(area);
    arrange(area, { height: 1, width: 10 });
    const selectable = selectableAt(area, 10, 1);

    // two of indent, then ` 1 `, then the field
    expect(selectable?.(3, 0), 'a gutter cell can be copied').to.equal(false);
    expect(selectable?.(5, 0), 'a highlighted field cell cannot be copied').to.equal(true);
    expect(selectable?.(6, 0), 'a field cell cannot be copied').to.equal(true);
  });

  it('should be the tree it always was without a gutter', () => {
    const layout = layoutField('ab', 0, 20);
    const layers = fieldLayers(() => ({ layout, top: 0, visible: 1 }));
    const { area, host } = fieldBox(layers);

    expect(area).to.equal(host);
    expect(area.children).to.deep.equal([layers.field, layers.caret]);
  });
});

describe('multiline() charLimit', () => {
  it('should insert nothing typed past the limit, and say where the count is', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 3,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a', 'b');
    expect(ui.log.at(-2)).to.equal('  2/3');
    await type(ui.stdin, 'c', 'd', 'e');
    expect(ui.log.at(-2)).to.equal('  3/3');

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('abc');
  });

  it('should count a line break as one, so enter at the limit inserts nothing', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 3,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a', ENTER, 'b', ENTER, 'c');

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('a\nb');
  });

  it('should count what the caret steps over rather than code units', async () => {
    // a family is seven code points and eleven code units, and one character to
    // anybody looking at it
    const family = '👨‍👩‍👧';
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 2,
      initial: family,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a', 'b');

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal(`${family}a`);
  });

  it('should cut a paste to what fits, at a cluster, rather than refuse it', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 5,
      initial: 'ab',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, `${PASTE_START}c👍🏽d\ne${PASTE_END}`);

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('abc👍🏽d');
  });

  it('should still delete at the limit, and take what fits after', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 2,
      initial: 'ab',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'c', BACKSPACE, 'd');

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('ad');
  });

  it('should draw the count in the warning role at the limit and muted under it', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 2,
      colorLevel: 1,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a');
    const under = ui.output.length;
    await type(ui.stdin, 'b');
    const at = ui.output.slice(under);

    // yellow is the warning role's default; a key that inserts nothing at the
    // limit otherwise reads as a key that did not work
    expect(ui.output.slice(0, under), 'the count under the limit is not muted').to.match(
      sgr(2, '0/2')
    );
    expect(at).to.match(sgr(33, '2/2'));

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should refuse an initial longer than the limit, which somebody wrote', async () => {
    const ui = screenSetup();
    const { error } = await settle(
      multiline({
        ansi: ui.ansi,
        charLimit: 2,
        initial: 'abc',
        message: 'Hm',
        terminal: ui.terminal,
      })
    );

    expect(error).to.be.instanceOf(PromptError);
    expect(error?.message).to.contain('`initial`');
  });

  it('should drop a value longer than the limit for the initial, as every prompt does', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 2,
      initial: 'ok',
      message: 'Hm',
      terminal: ui.terminal,
      value: 'too long',
    });

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('ok');
  });

  it('should take a value that fits', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: 2,
      initial: 'ok',
      message: 'Hm',
      terminal: ui.terminal,
      value: 'no',
    });

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('no');
  });

  it('should refuse a limit that is not a whole number of at least one', async () => {
    for (const charLimit of [0, -1, 1.5, Number.NaN]) {
      const ui = screenSetup();
      const { error } = await settle(
        multiline({ ansi: ui.ansi, charLimit, message: 'Hm', terminal: ui.terminal })
      );

      expect(error, `${charLimit} was taken`).to.be.instanceOf(PromptError);
      expect(error?.message).to.contain('`charLimit`');
    }
  });

  it('should read Infinity as no limit, and draw no count for it', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      charLimit: Infinity,
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a');
    expect(fieldRows(ui)).to.deep.equal(['a']);

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('a');
  });
});

describe('fitted()', () => {
  it('should take all of an insertion that fits', () => {
    expect(fitted('ab', 'xy', 4)).to.equal('xy');
  });

  it('should cut at a cluster rather than inside one', () => {
    expect(fitted('a', '👍🏽b', 2)).to.equal('👍🏽');
  });

  it('should take nothing at the limit, a mark that would join the last cluster included', () => {
    // the mark would add no cluster once it landed, and it is a cluster of its
    // own until it does -- a count that says full over a field that changed
    // anyway is the stranger answer
    expect(fitted('abc', '\u0301', 3)).to.equal('');
  });

  it('should never let a cut insertion past the limit', () => {
    // the claim `fitted()` rests on: inserting at a cluster boundary only ever
    // joins clusters, so counting the insertion's own is enough. Walked over the
    // joins there are -- regional indicators re-pairing, a ZWJ sequence, a
    // combining mark, an emoji modifier, CRLF -- at every boundary of every value
    const parts = ['a', '🇺', '🇸', '🇺🇸', '\u200d', '👩', '\u0301', '🏽', '\r', '\n', 'é', '👨‍👩‍👧'];
    const values = ['', 'ab', '🇺🇸🇫', '🇺', '👩\u200d', 'e\u0301x', '\r', '🇺🇸🇫🇷🇩'];
    const inserts = [...parts, ...parts.flatMap((a) => parts.map((b) => a + b))];

    for (const value of values) {
      const boundaries = [0];
      for (const cluster of graphemes(value)) {
        boundaries.push(boundaries.at(-1)! + cluster.length);
      }
      const used = graphemes(value).length;
      for (const cursor of boundaries) {
        for (const inserted of inserts) {
          for (let limit = Math.max(1, used); limit <= used + 3; limit++) {
            const kept = fitted(value, inserted, limit);
            const result = value.slice(0, cursor) + kept + value.slice(cursor);
            expect(
              graphemes(result).length,
              `${JSON.stringify(inserted)} at ${cursor} of ${JSON.stringify(value)}, limit ${limit}`
            ).to.be.at.most(limit);
          }
        }
      }
    }
  });
});

describe('multiline() highlight', () => {
  it('should leave the answer exactly as typed', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      highlight: matching(/\bconst\b/g, 'keyword'),
      initial: 'const a = 1',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'x');
    expect(fieldRows(ui)).to.deep.equal(['const a = 1x']);

    await type(ui.stdin, CTRL_D);
    expect(await answer).to.equal('const a = 1x');
  });

  it('should draw a token in its role', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      colorLevel: 1,
      highlight: matching(/\bconst\b/g, 'keyword'),
      initial: 'const a',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, LEFT);
    // cyan is the accent's default, and the accent is the keyword's role
    expect(ui.output).to.match(sgr(36, 'const'));

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should ask the hook again when the value changes and not when the caret moves', async () => {
    const asked: string[] = [];
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      highlight: (value) => {
        asked.push(value);
        return [];
      },
      initial: 'ab',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, LEFT, LEFT, RIGHT, 'x', UP);

    expect(asked).to.deep.equal(['ab', 'axb']);

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should hand the hook the whole value, so one span can cross a line break', async () => {
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      colorLevel: 1,
      highlight: matching(/\/\*[^]*?\*\//g, 'comment'),
      initial: 'a /* one\ntwo */ b',
      message: 'Hm',
      terminal: ui.terminal,
    });

    await type(ui.stdin, UP);
    const out = ui.output;
    // the second line opens inside the comment, which a hook handed one line
    // at a time could not have said
    expect(out).to.match(sgr(2, '/* one'));
    expect(out).to.match(sgr(2, 'two */'));

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should not ask about the placeholder, which is not code anybody wrote', async () => {
    const asked: string[] = [];
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      highlight: (value) => {
        asked.push(value);
        return [];
      },
      message: 'Hm',
      placeholder: 'const x',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a', BACKSPACE);
    expect(asked).to.deep.equal(['a']);

    await type(ui.stdin, CTRL_D);
    await answer;
  });

  it('should refuse a token no class can carry', async () => {
    const ui = screenSetup();
    const { error } = await settle(
      multiline({
        ansi: ui.ansi,
        highlight: () => [{ end: 1, start: 0, token: 'two words' }],
        initial: 'a',
        message: 'Hm',
        terminal: ui.terminal,
      })
    );

    expect(error).to.be.instanceOf(PromptError);
    expect(error?.message).to.contain('"two words"');
  });

  it('should reject with what the hook threw, since the hook is the caller', async () => {
    const ui = screenSetup();
    const failure = new Error('grammar missing');
    const answer = settle(
      multiline({
        ansi: ui.ansi,
        highlight: (value) => {
          if (value.includes('x')) {
            throw failure;
          }
          return [];
        },
        message: 'Hm',
        terminal: ui.terminal,
      })
    );

    await type(ui.stdin, 'x');

    expect((await answer).error).to.equal(failure);
  });
});

describe('tokensOf()', () => {
  it('should name each offset a span covers', () => {
    expect(tokensOf('abcd', [{ end: 3, start: 1, token: 'string' }])).to.deep.equal([
      undefined,
      'string',
      'string',
      undefined,
    ]);
  });

  it('should let the later of two spans win where they overlap', () => {
    expect(
      tokensOf('abc', [
        { end: 3, start: 0, token: 'string' },
        { end: 2, start: 1, token: 'keyword' },
      ])
    ).to.deep.equal(['string', 'keyword', 'string']);
  });

  it('should clip a span to the value, and mark nothing for one that is empty or NaN', () => {
    expect(
      tokensOf('ab', [
        { end: 9, start: 1, token: 'string' },
        { end: -1, start: -5, token: 'keyword' },
        { end: 1, start: 1, token: 'keyword' },
        { end: Number.NaN, start: 0, token: 'keyword' },
      ])
    ).to.deep.equal([undefined, 'string']);
  });

  it('should take a name of the app own, and refuse one a class cannot be', () => {
    expect(tokensOf('a', [{ end: 1, start: 0, token: 'my-token_2' }])).to.deep.equal([
      'my-token_2',
    ]);
    for (const token of ['', '2fast', 'a b', 'a.b', '-x']) {
      expect(() => tokensOf('a', [{ end: 1, start: 0, token }]), token).to.throw(PromptError);
    }
  });

  it('should take constructor as a token rather than reading it off a prototype', () => {
    // the role lookup is a `Map` for exactly this name
    const layout = layoutField('ab', 0, 20);
    const tokens = tokensOf('ab', [{ end: 1, start: 0, token: 'constructor' }]);
    const { field } = fieldLayers(() => ({ layout, tokens, top: 0, visible: 1 }));
    const layer = tokenLayer(() => ({ layout, tokens, top: 0, visible: 1 }), field, 'constructor');

    expect(layer.classes).to.deep.equal(['sigil-token', 'sigil-token-constructor']);
  });
});

describe('tokenLayer()', () => {
  /** The field and a layer per token, over one rectangle, as the prompt builds them. */
  function hostOf(value: string, spans: HighlightSpan[], names: string[]) {
    const layout = layoutField(value, value.length, 20);
    const tokens = tokensOf(value, spans);
    const read = () => ({ layout, tokens, top: 0, visible: layout.rows.length });
    const { caret, field } = fieldLayers(read);
    const layers = names.map((name) => tokenLayer(read, field, name));
    return { host: box({ position: 'relative' }, field, ...layers, caret), layers };
  }

  it('should draw its cells, leave the rest to the field, and lose none of them', () => {
    const { host } = hostOf('let x', [{ end: 3, start: 0, token: 'keyword' }], ['keyword']);
    const out = renderToString(host, { cascade: themedCascade(), colorLevel: 1, width: 20 });

    // the caret past the end is a blank of its own
    expect(strip(out)).to.equal('let x ');
    expect(out).to.match(sgr(36, 'let'));
  });

  it('should carry a role for the names every highlighter has, and only a hook otherwise', () => {
    const { layers } = hostOf('a', [], ['comment', 'string', 'decorator']);

    expect(layers.map((layer) => layer.classes)).to.deep.equal([
      ['sigil-token', 'sigil-token-comment', 'sigil-muted'],
      ['sigil-token', 'sigil-token-string', 'sigil-success'],
      ['sigil-token', 'sigil-token-decorator'],
    ]);
  });

  it('should be reached by an app sheet through its own class', () => {
    const { host } = hostOf('@x', [{ end: 2, start: 0, token: 'decorator' }], ['decorator']);
    const out = renderToString(host, {
      cascade: themedCascade({ sheets: ['.sigil-token-decorator { color: magenta }'] }),
      colorLevel: 1,
      width: 20,
    });

    expect(out).to.match(sgr(35, '@x'));
  });

  it('should be copied with the text, which is what its cells are', () => {
    const { host, layers } = hostOf('ab', [{ end: 1, start: 0, token: 'keyword' }], ['keyword']);

    resolveStyles(host);
    arrange(host, { height: 1, width: 4 });
    const selectable = selectableAt(host, 4, 1);

    expect(layers[0].drawsText).to.equal(true);
    // nothing excluded at all is `undefined`, which is every cell copied
    expect(selectable?.(0, 0) ?? true, 'a highlighted cell cannot be copied').to.equal(true);
  });
});
