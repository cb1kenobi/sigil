import { StyledScreen } from '../scripts/lib/styled-screen.ts';
import { strip } from '@ttylabs/sigil/ansi';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ESC = '\u001b';

describe('StyledScreen', () => {
  it('should keep the colour a cell was written in', () => {
    const screen = new StyledScreen(20, 3);
    screen.write(`${ESC}[36m?${ESC}[39m ${ESC}[1mName${ESC}[22m`);

    assert.equal(screen.toSgr(), `${ESC}[36m?${ESC}[0m ${ESC}[1mName${ESC}[0m`);
  });

  it('should read a close code as taking one attribute away and not as another', () => {
    const screen = new StyledScreen(20, 1);
    screen.write(`${ESC}[1;36mab${ESC}[22mcd`);

    // `22` ends bold and leaves the colour, which a list of every code seen would not say
    assert.equal(screen.toSgr(), `${ESC}[1;36mab${ESC}[0m${ESC}[36mcd${ESC}[0m`);
  });

  it('should draw a frame that only repaints part of the screen', () => {
    const screen = new StyledScreen(20, 3);
    // the first frame, then the second one moves up a row and rewrites a cell
    screen.write(`\n\n${ESC}[2A\r${ESC}[36m❯${ESC}[39m one\r\n  two\r\n  three`);
    screen.write(`${ESC}[2A\r${ESC}[2K${ESC}[32m✔${ESC}[39m one`);

    assert.equal(strip(screen.toSgr()), '✔ one\n  two\n  three');
    assert.equal(screen.toSgr().split('\n')[0], `${ESC}[32m✔${ESC}[0m one`);
  });

  it('should forget the colour of a cell that was erased', () => {
    const screen = new StyledScreen(20, 1);
    screen.write(`${ESC}[41m  ${ESC}[0m`);
    screen.write(`\r${ESC}[2K`);

    assert.equal(screen.toSgr(), '');
  });

  it('should wrap a long line the way a terminal does and keep its colour on both rows', () => {
    const screen = new StyledScreen(5, 3);
    screen.write(`${ESC}[31mabcdefg${ESC}[39m`);

    assert.equal(screen.toSgr(), `${ESC}[31mabcde${ESC}[0m\n${ESC}[31mfg${ESC}[0m`);
  });

  it('should refuse a screen that scrolled, because its record would name the wrong rows', () => {
    const screen = new StyledScreen(5, 2);
    screen.write('a\r\nb\r\nc');

    assert.throws(() => screen.toSgr(), /scrolled/);
  });
});
