import { applyMask, maskedText, type MaskedTextOptions } from '../../src/components/masked-text.js';
import { PromptError } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * Starts a prompt and reports how it settled, for the reason `prompt.test.ts`
 * records: the handler has to be attached before any key is sent.
 */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** Sends chunks one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Types a string a character at a time, which is what a keyboard does. */
async function keys(stdin: { send(chunk: string): void }, text: string) {
  await type(stdin, ...text);
}

const PHONE = '(###) ###-####';

/** Asks a masked prompt on a fresh screen. */
function ask(opts: Partial<MaskedTextOptions> = {}, columns = 60) {
  const ui = screenSetup({ columns });
  const answer = settle(
    maskedText({
      ansi: ui.ansi,
      message: 'Phone',
      template: PHONE,
      terminal: ui.terminal,
      ...opts,
    })
  );
  return { answer, ui };
}

/** What the field shows, read off the question line after the message. */
function field(ui: ScreenHarness): string {
  return (ui.log[0] ?? '').replace(/^\S+ Phone ?/, '');
}

const ENTER = '\r';
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const HOME = '\u001b[H';
const END = '\u001b[F';
const DELETE = '\u001b[3~';
const BACKSPACE = '\u007f';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

describe('applyMask()', () => {
  it('should fill the slots and draw the fixed characters between them', () => {
    expect(applyMask(PHONE, '5551234567')).toStrictEqual({
      complete: true,
      dropped: 0,
      raw: '5551234567',
      value: '(555) 123-4567',
    });
  });

  it('should read text that is already formatted the same as raw characters', () => {
    expect(applyMask(PHONE, '(555) 123-4567')).toStrictEqual(applyMask(PHONE, '5551234567'));
  });

  it('should drop what does not fit and count it', () => {
    const applied = applyMask(PHONE, '555.123.4567');

    expect(applied.value).to.equal('(555) 123-4567');
    expect(applied.dropped).to.equal(2);
  });

  it('should leave the fixed characters after the last thing filled undrawn', () => {
    expect(applyMask(PHONE, '5551')).toStrictEqual({
      complete: false,
      dropped: 0,
      raw: '5551',
      value: '(555) 1',
    });
    expect(applyMask(PHONE, '').value).to.equal('');
  });

  it('should drop what is left over once every slot is full', () => {
    const applied = applyMask(PHONE, '555123456789');

    expect(applied.dropped).to.equal(2);
    expect(applied.raw).to.equal('5551234567');
  });

  it('should not take a fixed digit for a slot', () => {
    // `1` is the template's, so pasting it formatted must not fill a `#` with it
    expect(applyMask('+1 ###', '+1 555').raw).to.equal('555');
    expect(applyMask('+1 ###', '555').raw).to.equal('555');
  });

  it('should take letters, alphanumerics and hex digits as the built-in slots say', () => {
    expect(applyMask('AAA', 'ab1c').raw).to.equal('abc');
    expect(applyMask('NNN', 'a-1 b').raw).to.equal('a1b');
    expect(applyMask('HH', 'xg1f').raw).to.equal('1f');
    expect(applyMask('**', 'a b').raw).to.equal('ab');
  });

  it('should treat the character after a backslash as a fixed one', () => {
    const applied = applyMask('\\#-#', '7');

    expect(applied.value).to.equal('#-7');
    expect(applied.complete).to.equal(true);
  });

  it('should take slots of its own, and let them replace a built-in one', () => {
    const slots = { K: { match: /[a-z0-9]/i, transform: (ch: string) => ch.toUpperCase() } };
    expect(applyMask('KK-KK', 'ab12', slots).value).to.equal('AB-12');
    expect(applyMask('#', 'x', { '#': /x/ }).raw).to.equal('x');
  });

  it('should match a slot against the whole character, not a part of one', () => {
    // an unanchored `/a/` would accept `ab`; a cluster is one character
    expect(applyMask('A', 'é').raw).to.equal('');
    expect(applyMask('K', 'é', { K: /\p{L}\p{M}/u }).raw).to.equal('é');
  });

  it('should refuse a transform that gives nothing back', () => {
    expect(applyMask('K', 'x', { K: { match: /x/, transform: () => '' } }).raw).to.equal('');
  });

  it('should ignore the global and sticky flags of a slot pattern', () => {
    const slots = { D: /[0-9]/gy };

    expect(applyMask('DDD', '123', slots).raw).to.equal('123');
    // the pattern is not left holding a position between characters
    expect(applyMask('DDD', '123', slots).raw).to.equal('123');
  });

  it.each([
    ['no slot', 'abc', 'at least one slot'],
    ['a trailing backslash', '#\\', 'cannot end in a backslash'],
  ])('should reject a template with %s', (_name, template, why) => {
    expect(() => applyMask(template, '1')).toThrow(why);
  });

  it.each([['ab'], ['\\'], ['']])('should reject a slot named "%s"', (name) => {
    expect(() => applyMask('#', '1', { [name]: /x/ })).toThrow('single character');
  });
});

describe('maskedText()', () => {
  describe('typing', () => {
    it('should draw the blank template, dimmed, before anything is typed', () => {
      const { ui } = ask();

      expect(field(ui)).to.equal('(___) ___-____');
    });

    it('should fill the slots and skip the fixed characters', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '55512');

      expect(field(ui)).to.equal('(555) 12_-____');
    });

    it('should answer the formatted text', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '5551234567');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal('(555) 123-4567');
    });

    it('should ignore a character the slot does not accept', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '5a5 5');

      expect(field(ui)).to.equal('(555) ___-____');
    });

    it('should ignore typing once every slot is full', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '555123456789');

      expect(field(ui)).to.equal('(555) 123-4567');
    });

    it('should not take a typed fixed character for the template’s own', async () => {
      // typing is not formatted text: `1` in `+1 ###` is a digit for the slot
      const { ui } = ask({ template: '+1 ###' });

      await keys(ui.stdin, '1');

      expect(field(ui)).to.equal('+1 1__');
    });

    it('should keep what a slot’s transform gave', async () => {
      const { answer, ui } = ask({
        slots: { K: { match: /[a-z]/i, transform: (ch) => ch.toUpperCase() } },
        template: 'KK-KK',
      });

      await keys(ui.stdin, 'abcd');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal('AB-CD');
    });
  });

  describe('the caret', () => {
    it('should step over fixed characters going left and going right', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '5551');
      // the caret is on slot 4; three lefts cross the `) ` and land on slot 1
      await type(ui.stdin, LEFT, LEFT, LEFT);
      await keys(ui.stdin, '9');
      expect(field(ui)).to.equal('(595) 1__-____');

      // the caret moved on to slot 2, and two rights cross the `) ` again to slot 4
      await type(ui.stdin, RIGHT, RIGHT);
      await keys(ui.stdin, '2');
      expect(field(ui)).to.equal('(595) 12_-____');

      await type(ui.stdin, CTRL_C);
      expect((await answer).error?.aborted).to.equal(true);
    });

    it('should empty the slot before the caret on backspace, across a fixed character', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '5551');
      await type(ui.stdin, BACKSPACE);
      expect(field(ui)).to.equal('(555) ___-____');

      // the caret is back on slot 3, so the next backspace is the `5` before the `) `
      await type(ui.stdin, BACKSPACE);
      expect(field(ui)).to.equal('(55_) ___-____');

      await keys(ui.stdin, '7');
      expect(field(ui)).to.equal('(557) ___-____');
    });

    it('should do nothing on backspace at the start', async () => {
      const { ui } = ask();

      await type(ui.stdin, BACKSPACE);
      await keys(ui.stdin, '1');

      expect(field(ui)).to.equal('(1__) ___-____');
    });

    it('should empty the slot under the caret on delete without moving it', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '5551');
      await type(ui.stdin, LEFT, LEFT, LEFT, LEFT);
      await type(ui.stdin, DELETE);
      expect(field(ui)).to.equal('(_55) 1__-____');

      await keys(ui.stdin, '8');
      expect(field(ui)).to.equal('(855) 1__-____');
    });

    it('should delete past the end without a complaint', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '5551234567');
      await type(ui.stdin, DELETE);

      expect(field(ui)).to.equal('(555) 123-4567');
    });

    it('should go to the first slot on home and after the last thing typed on end', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '555');
      await type(ui.stdin, HOME);
      await keys(ui.stdin, '9');
      expect(field(ui)).to.equal('(955) ___-____');

      await type(ui.stdin, END);
      await keys(ui.stdin, '8');
      expect(field(ui)).to.equal('(955) 8__-____');
    });

    it('should overwrite what is under the caret rather than push it along', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '5551');
      await type(ui.stdin, HOME);
      await keys(ui.stdin, '9');

      expect(field(ui)).to.equal('(955) 1__-____');
    });

    it('should clear everything before the caret on ctrl-u', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '555123');
      await type(ui.stdin, LEFT, LEFT, CTRL_U);

      expect(field(ui)).to.equal('(___) _23-____');
    });
  });

  describe('enter', () => {
    it('should say what is wrong, and keep the prompt open, while a slot is empty', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '555');
      await type(ui.stdin, ENTER);
      expect(ui.log).to.include('  Fill in every blank');

      await keys(ui.stdin, '1234567');
      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal('(555) 123-4567');
    });

    it('should not answer a field with a gap in it', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '5551234567');
      await type(ui.stdin, LEFT, DELETE, ENTER);
      expect(ui.log).to.include('  Fill in every blank');

      await keys(ui.stdin, '9');
      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal('(555) 123-4569');
    });

    it('should be given the formatted answer by validate, and its message keeps the prompt open', async () => {
      const seen: string[] = [];
      const { answer, ui } = ask({
        validate(value) {
          seen.push(value);
          return value.startsWith('(555)') ? 'No fictional numbers' : undefined;
        },
      });

      await keys(ui.stdin, '5551234567');
      await type(ui.stdin, ENTER);
      expect(ui.log).to.include('  No fictional numbers');

      await type(ui.stdin, HOME);
      await keys(ui.stdin, '2');
      await type(ui.stdin, ENTER);

      expect(seen).toStrictEqual(['(555) 123-4567', '(255) 123-4567']);
      expect((await answer).value).to.equal('(255) 123-4567');
    });
  });

  describe('paste', () => {
    it('should fill the slots from formatted text', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, `${PASTE_START}(555) 123-4567${PASTE_END}`);
      expect(field(ui)).to.equal('(555) 123-4567');

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal('(555) 123-4567');
    });

    it('should fill the slots from raw characters, dropping what does not fit', async () => {
      const { ui } = ask();

      await type(ui.stdin, `${PASTE_START}555.123.4567${PASTE_END}`);

      expect(field(ui)).to.equal('(555) 123-4567');
    });

    it('should flatten a pasted block onto the one line', async () => {
      const { ui } = ask();

      await type(ui.stdin, `${PASTE_START}555\n123\n4567${PASTE_END}`);

      expect(field(ui)).to.equal('(555) 123-4567');
    });

    it('should start at the caret', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '555');
      await type(ui.stdin, `${PASTE_START}12${PASTE_END}`);

      expect(field(ui)).to.equal('(555) 12_-____');
    });

    it('should not read a fixed digit of the template as a slot', async () => {
      const { ui } = ask({ template: '+1 ###' });

      await type(ui.stdin, `${PASTE_START}+1 555${PASTE_END}`);

      expect(field(ui)).to.equal('+1 555');
    });

    it('should leave the field alone when nothing in the paste fits', async () => {
      const { ui } = ask();

      await type(ui.stdin, `${PASTE_START}hello${PASTE_END}`);

      expect(field(ui)).to.equal('(___) ___-____');
    });
  });

  describe('initial and default', () => {
    it('should start the field with an initial, read the way a paste is', async () => {
      const { answer, ui } = ask({ initial: '555123' });

      expect(field(ui)).to.equal('(555) 123-____');

      await keys(ui.stdin, '4567');
      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal('(555) 123-4567');
    });

    it('should accept an initial that is already formatted', () => {
      const { ui } = ask({ initial: '(555) 123-4567' });

      expect(field(ui)).to.equal('(555) 123-4567');
    });

    it('should answer the default, formatted, when nothing was typed', async () => {
      const { answer, ui } = ask({ default: '5551234567' });

      expect(field(ui)).to.equal('(555) 123-4567');

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal('(555) 123-4567');
    });

    it('should prefer what was typed to the default', async () => {
      const { answer, ui } = ask({ default: '5551234567' });

      await keys(ui.stdin, '2125550100');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal('(212) 555-0100');
    });

    it('should go back to the default when what was typed is taken out again', async () => {
      const { answer, ui } = ask({ default: '5551234567' });

      await keys(ui.stdin, '9');
      expect(field(ui)).to.equal('(9__) ___-____');

      await type(ui.stdin, BACKSPACE, ENTER);
      expect((await answer).value).to.equal('(555) 123-4567');
    });

    it('should show a placeholder in place of the blank template and the default', async () => {
      const { ui } = ask({ default: '5551234567', placeholder: 'your number' });

      expect(field(ui)).to.equal('your number');

      await keys(ui.stdin, '5');
      expect(field(ui)).to.equal('(5__) ___-____');
    });

    it('should type at the first slot while a placeholder is showing, wherever the keys moved', async () => {
      const { ui } = ask({ placeholder: 'your number' });

      // the caret is drawn on the first character of the placeholder, so these
      // must not move it somewhere the person cannot see
      await type(ui.stdin, RIGHT, RIGHT, END);
      await keys(ui.stdin, '7');

      expect(field(ui)).to.equal('(7__) ___-____');
    });
  });

  describe('being answered', () => {
    it('should leave the formatted answer on the line once it is given', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '5551234567');
      await type(ui.stdin, ENTER);
      await answer;

      expect(ui.log).to.deep.equal(['? Phone (555) 123-4567']);
    });

    it('should reject when the person gives up', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, CTRL_C);

      const { error } = await answer;
      expect(error).toBeInstanceOf(PromptError);
      expect(error?.aborted).to.equal(true);
    });
  });

  describe('being asked', () => {
    it('should reject, rather than wait, where nobody can answer', async () => {
      const ui = screenSetup({ isTTY: false });

      await expect(
        maskedText({ ansi: ui.ansi, message: 'Phone', template: PHONE, terminal: ui.terminal })
      ).rejects.toThrow('Cannot prompt for "Phone" because the input is not a terminal');
    });

    it.each([
      ['a template with no slot', { template: 'abc' }, '`template` is not usable'],
      ['a template ending in a backslash', { template: '#\\' }, '`template` is not usable'],
      ['a slot of two characters', { slots: { ab: /x/ } }, 'single character'],
      ['a default that leaves a slot empty', { default: '555' }, '`default` does not fill'],
      ['a default with a character that fits nowhere', { default: '5551234567x' }, '`default`'],
      ['an initial with a character that fits nowhere', { initial: '555-x' }, '`initial` has'],
    ] as const)('should refuse %s', async (_name, opts, why) => {
      const ui = screenSetup();

      await expect(
        maskedText({
          ansi: ui.ansi,
          message: 'Phone',
          template: PHONE,
          terminal: ui.terminal,
          ...opts,
        })
      ).rejects.toThrow(why);
    });
  });
});
