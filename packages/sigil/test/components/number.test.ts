import { number, type NumberOptions } from '../../src/components/number.js';
import { PromptError } from '../../src/components/prompt.js';
import { loadCatalog } from '../../src/i18n/index.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

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

/** Sends keys one at a time, letting the prompt act on each. */
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

/** Asks a number prompt on a fresh screen. */
function ask(opts: Partial<NumberOptions> = {}, columns = 60) {
  const ui = screenSetup({ columns });
  const answer = settle(number({ ansi: ui.ansi, message: 'Port', terminal: ui.terminal, ...opts }));
  return { answer, ui };
}

/** The question line, which is where the field is. */
function line(ui: ScreenHarness): string {
  return ui.log[0] ?? '';
}

/** What the field holds, read off the question line after the message. */
function field(ui: ScreenHarness): string {
  return line(ui).replace(/^\S+ Port ?/, '');
}

/**
 * What the last frame drew in reverse video, which is what the caret marks.
 *
 * Read off the bytes, because the screen model keeps characters and the caret is
 * styling -- and only at a colour level above 0, which drops the attributes.
 */
function caret(ui: ScreenHarness): string {
  const out = ui.output;
  const at = out.lastIndexOf('\u001b[7m');
  if (at === -1) {
    return '';
  }
  const rest = out.slice(at + '\u001b[7m'.length);
  // eslint-disable-next-line no-control-regex
  const end = rest.search(/\u001b[[\]]/);
  return end === -1 ? rest : rest.slice(0, end);
}

const ENTER = '\r';
const CTRL_C = '\u0003';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const HOME = '\u001b[H';
const BACKSPACE = '\u007f';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

describe('number()', () => {
  describe('typing', () => {
    it('should return what was typed as a number', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '8080');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(8080);
    });

    it('should ignore a letter as it is typed, without an error', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '8a0e8x0');

      expect(field(ui)).to.equal('8080');
      expect(ui.log.length).to.equal(1);

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(8080);
    });

    it('should not accept a decimal point unless it is a float prompt', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '1.5');

      expect(field(ui)).to.equal('15');
    });

    it('should accept one decimal point in a float prompt', async () => {
      const { answer, ui } = ask({ float: true });

      await keys(ui.stdin, '1.5.2');
      expect(field(ui)).to.equal('1.52');

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(1.52);
    });

    it('should accept a leading minus when there is no minimum', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '-12');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(-12);
    });

    it('should accept a minus when the minimum is negative', async () => {
      const { ui } = ask({ min: -5 });

      await keys(ui.stdin, '-1');

      expect(field(ui)).to.equal('-1');
    });

    it('should refuse a minus when nothing below zero is allowed', async () => {
      const { ui } = ask({ min: 0 });

      await keys(ui.stdin, '-1');

      expect(field(ui)).to.equal('1');
    });

    it('should accept a minus only at the start, and only once', async () => {
      const { ui } = ask();

      await keys(ui.stdin, '5-');
      expect(field(ui)).to.equal('5');

      await type(ui.stdin, HOME);
      await keys(ui.stdin, '--');
      expect(field(ui)).to.equal('-5');

      // the second is at the start as well, which is why it takes its own rule
      await type(ui.stdin, HOME);
      await keys(ui.stdin, '-');
      expect(field(ui)).to.equal('-5');
    });

    it('should hold a paste to the same rule as a keystroke', async () => {
      const { answer, ui } = ask({ float: true });

      await type(ui.stdin, `${PASTE_START}-1,2.5 x 3.4${PASTE_END}`);
      expect(field(ui)).to.equal('-12.534');

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(-12.534);
    });

    it('should drop the digits that are not ASCII', async () => {
      // a fullwidth or Arabic-Indic digit is a digit to a human and a NaN to
      // `Number()`, and the field would be holding text the parser refuses
      const { ui } = ask();

      await keys(ui.stdin, '１٣7');

      expect(field(ui)).to.equal('7');
    });

    it('should edit with the text field’s own keys', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '1234');
      await type(ui.stdin, LEFT, LEFT, BACKSPACE);
      expect(field(ui)).to.equal('134');

      await keys(ui.stdin, '9');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(1934);
    });

    it('should mark the cluster under the caret', async () => {
      const { ui } = ask({ colorLevel: 1 });

      await keys(ui.stdin, '12');
      expect(caret(ui)).to.equal(' ');

      await type(ui.stdin, LEFT);
      expect(caret(ui)).to.equal('2');
      expect(ui.screen.lastInverse).to.deep.equal({ column: line(ui).indexOf('12') + 1, row: 0 });

      await type(ui.stdin, HOME);
      expect(caret(ui)).to.equal('1');
    });

    it('should start with the initial value in the field, editable', async () => {
      const { answer, ui } = ask({ initial: 42 });

      expect(field(ui)).to.equal('42');
      await keys(ui.stdin, '0');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(420);
    });

    it('should keep the caret on screen when the answer is wider than the room', async () => {
      const { ui } = ask({ colorLevel: 1 }, 14);

      await keys(ui.stdin, '123456789012');

      // the head takes eight columns of fourteen, and the caret is past the last
      // digit with the front of the answer scrolled out of view
      expect(ui.log.length).to.equal(1);
      expect(ui.screen.lastInverse?.row).to.equal(0);
      expect(field(ui)).to.match(/^\d+$/);
      expect(field(ui).length).to.be.lessThan(12);
    });
  });

  describe('stepping', () => {
    it('should step up and down by one', async () => {
      const { answer, ui } = ask({ initial: 5 });

      await type(ui.stdin, UP, UP, DOWN);
      expect(field(ui)).to.equal('6');

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(6);
    });

    it('should step by the step it was given', async () => {
      const { ui } = ask({ initial: 100, step: 25 });

      await type(ui.stdin, UP);
      expect(field(ui)).to.equal('125');

      await type(ui.stdin, DOWN, DOWN);
      expect(field(ui)).to.equal('75');
    });

    it('should stop at the maximum rather than going past it', async () => {
      const { ui } = ask({ initial: 8, max: 10, step: 5 });

      await type(ui.stdin, UP);
      expect(field(ui)).to.equal('10');

      await type(ui.stdin, UP);
      expect(field(ui)).to.equal('10');
    });

    it('should stop at the minimum rather than going past it', async () => {
      const { ui } = ask({ initial: 2, min: 1, step: 5 });

      await type(ui.stdin, DOWN);

      expect(field(ui)).to.equal('1');
    });

    it('should bring a value that is outside the range back into it', async () => {
      const { ui } = ask({ initial: 500, max: 10 });

      await type(ui.stdin, DOWN);

      expect(field(ui)).to.equal('10');
    });

    it('should not leave floating point noise on a float step', async () => {
      const { answer, ui } = ask({ float: true, initial: 0.2, step: 0.1 });

      await type(ui.stdin, UP);
      expect(field(ui)).to.equal('0.3');

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(0.3);
    });

    it('should not round a value’s own digits away when it has more than the step', async () => {
      const { ui } = ask({ float: true, initial: 0.125, step: 0.1 });

      await type(ui.stdin, UP);

      expect(field(ui)).to.equal('0.225');
    });

    it('should write a small float out without an exponent', async () => {
      // `String(1e-7)` is `1e-7` and an `e` is the one character the field will
      // not let anybody type
      const { ui } = ask({ float: true, initial: 0.0000001, step: 0.0000001 });

      await type(ui.stdin, UP);

      expect(field(ui)).to.equal('0.0000002');
    });

    it('should land on the default from an empty field, then step', async () => {
      const { ui } = ask({ default: 8080 });

      await type(ui.stdin, UP);
      expect(field(ui)).to.equal('8080');

      await type(ui.stdin, UP);
      expect(field(ui)).to.equal('8081');
    });

    it('should land on the minimum from an empty field when there is no default', async () => {
      const { ui } = ask({ min: 10 });

      await type(ui.stdin, DOWN);

      expect(field(ui)).to.equal('10');
    });

    it('should land on a negative minimum rather than on zero', async () => {
      const { ui } = ask({ min: -5 });

      await type(ui.stdin, UP);

      expect(field(ui)).to.equal('-5');
    });

    it('should land on zero from an empty field with neither', async () => {
      const { ui } = ask();

      await type(ui.stdin, DOWN);
      expect(field(ui)).to.equal('0');

      await type(ui.stdin, DOWN);
      expect(field(ui)).to.equal('-1');
    });

    it('should land in the range when zero is outside it', async () => {
      const { ui } = ask({ max: -3 });

      await type(ui.stdin, UP);

      expect(field(ui)).to.equal('-3');
    });

    it('should leave a half-written number alone rather than guessing', async () => {
      const { ui } = ask({ float: true });

      await keys(ui.stdin, '.');
      await type(ui.stdin, UP);

      expect(field(ui)).to.equal('.');
    });

    it('should not step an integer past the largest the parser represents', async () => {
      const { ui } = ask({ initial: Number.MAX_SAFE_INTEGER });

      await type(ui.stdin, UP);

      expect(field(ui)).to.equal(String(Number.MAX_SAFE_INTEGER));
    });

    it('should put the caret at the end after a step', async () => {
      const { answer, ui } = ask({ initial: 9 });

      await type(ui.stdin, LEFT, UP);
      await keys(ui.stdin, '5');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(105);
    });
  });

  describe('answering', () => {
    it('should return the default for an empty answer', async () => {
      const { answer, ui } = ask({ default: 8080 });

      expect(field(ui)).to.equal('8080');
      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(8080);
    });

    it('should show the placeholder in place of the default', async () => {
      const { ui } = ask({ default: 8080, placeholder: 'a port' });

      expect(field(ui)).to.equal('a port');
    });

    it('should ask again for an empty answer when there is no default', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, ENTER);
      expect(ui.log).to.include('  Enter a number');

      await keys(ui.stdin, '3');
      expect(ui.log.length).to.equal(1);

      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(3);
    });

    it('should refuse an answer below the minimum and name the bound', async () => {
      const { answer, ui } = ask({ min: 10 });

      await keys(ui.stdin, '3');
      await type(ui.stdin, ENTER);

      expect(ui.log).to.include('  Must be at least 10');

      // not clamped: the prompt is still waiting, and it is waiting on the 3
      await type(ui.stdin, BACKSPACE);
      await keys(ui.stdin, '12');
      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(12);
    });

    it('should refuse an answer above the maximum and name the bound', async () => {
      const { answer, ui } = ask({ max: 65535 });

      await keys(ui.stdin, '70000');
      await type(ui.stdin, ENTER);

      expect(ui.log).to.include('  Must be at most 65535');
      expect(field(ui)).to.equal('70000');

      await type(ui.stdin, CTRL_C);
      expect((await answer).error?.aborted).to.equal(true);
    });

    it('should hold a default outside the range to the range', async () => {
      const { ui } = ask({ default: 5, min: 10 });

      await type(ui.stdin, ENTER);

      expect(ui.log).to.include('  Must be at least 10');
    });

    it('should clear the complaint on the next key', async () => {
      const { ui } = ask({ min: 10 });

      await keys(ui.stdin, '3');
      await type(ui.stdin, ENTER);
      await keys(ui.stdin, '4');

      expect(ui.log.length).to.equal(1);
    });

    it('should read the text the way the parser reads an int', async () => {
      // the claim that makes this the parser's prompt rather than a second
      // opinion: past 2^53-1 `Number()` answers a different integer, and the
      // parser refuses it rather than return one
      const { answer, ui } = ask();

      await keys(ui.stdin, '9007199254740993');
      await type(ui.stdin, ENTER);

      expect(ui.log).to.include('  Integer is too large to be exact: 9007199254740993');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should refuse a lone minus with the parser’s message', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '-');
      await type(ui.stdin, ENTER);

      expect(ui.log).to.include('  Invalid integer: -');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should read a float the way the parser reads a number', async () => {
      const { answer, ui } = ask({ float: true });

      await keys(ui.stdin, '.');
      await type(ui.stdin, ENTER);
      expect(ui.log).to.include('  Invalid number: .');

      await keys(ui.stdin, '5');
      await type(ui.stdin, ENTER);
      expect((await answer).value).to.equal(0.5);
    });

    it('should answer zero for a minus zero', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '-0');
      await type(ui.stdin, ENTER);

      expect(Object.is((await answer).value, 0)).to.equal(true);
    });

    it('should run validate on the number, after the range', async () => {
      const seen: unknown[] = [];
      const { answer, ui } = ask({
        max: 100,
        validate: (value) => {
          seen.push(value);
          return value % 2 === 0 ? undefined : 'Must be even';
        },
      });

      await keys(ui.stdin, '101');
      await type(ui.stdin, ENTER);
      expect(seen).toStrictEqual([]);

      await type(ui.stdin, BACKSPACE, BACKSPACE);
      await keys(ui.stdin, '7');
      await type(ui.stdin, ENTER);
      expect(ui.log).to.include('  Must be even');

      await type(ui.stdin, BACKSPACE);
      await keys(ui.stdin, '8');
      await type(ui.stdin, ENTER);

      expect(seen).toStrictEqual([17, 18]);
      expect((await answer).value).to.equal(18);
    });

    it('should leave the answer on the line once it is given', async () => {
      const { answer, ui } = ask();

      await keys(ui.stdin, '0042');
      await type(ui.stdin, ENTER);
      await answer;

      // the number rather than the text that was typed
      expect(ui.log).to.deep.equal(['? Port 42']);
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
        number({ ansi: ui.ansi, message: 'Port', terminal: ui.terminal })
      ).rejects.toThrow('Cannot prompt for "Port" because the input is not a terminal');
    });

    it.each([
      ['a minimum above the maximum', { max: 1, min: 2 }, '`min` is greater than `max`'],
      ['a step of zero', { step: 0 }, '`step` must be greater than zero'],
      ['a negative step', { step: -1 }, '`step` must be greater than zero'],
      ['a step that is not a number', { step: Number.NaN }, '`step` is not a finite number'],
      ['an infinite maximum', { max: Infinity }, '`max` is not a finite number'],
      ['a fractional step on an int', { step: 0.5 }, '`step` is not an integer'],
      ['a fractional default on an int', { default: 0.5 }, '`default` is not an integer'],
    ] as const)('should refuse %s', async (_name, opts, why) => {
      const ui = screenSetup();

      await expect(
        number({ ansi: ui.ansi, message: 'Port', terminal: ui.terminal, ...opts })
      ).rejects.toThrow(why);
    });

    it('should allow fractions in every option of a float prompt', async () => {
      const { answer, ui } = ask({ default: 0.5, float: true, max: 1.5, min: 0.25, step: 0.25 });

      await type(ui.stdin, ENTER);

      expect((await answer).value).to.equal(0.5);
    });
  });

  describe('translated', () => {
    afterEach(async () => {
      await loadCatalog(undefined, {});
    });

    it('should say which bound in the catalog’s words', async () => {
      await loadCatalog(
        { de: async () => ({ 'Must be at least {0}': 'Mindestens {0}' }) },
        {},
        'de'
      );
      const { answer, ui } = ask({ min: 10 });

      await keys(ui.stdin, '3');
      await type(ui.stdin, ENTER);

      expect(ui.log).to.include('  Mindestens 10');

      await type(ui.stdin, CTRL_C);
      await answer;
    });
  });
});
