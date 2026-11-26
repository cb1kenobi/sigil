import { hasAnsi, hasIntroducer, strip, stripWellFormed } from '../../src/ansi/strip.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CAN = String.fromCharCode(0x18);
const SUB = String.fromCharCode(0x1a);
const ST = `${ESC}\\`;

describe('strip()', () => {
  it('should leave a plain string alone', () => {
    expect(strip('')).toBe('');
    expect(strip('hello')).toBe('hello');
    expect(strip('café 日本語')).toBe('café 日本語');
  });

  it('should remove SGR sequences', () => {
    expect(strip(`${ESC}[31mred${ESC}[39m`)).toBe('red');
    expect(strip(`${ESC}[1m${ESC}[4m${ESC}[38;2;95;135;175mx${ESC}[0m`)).toBe('x');
    expect(strip(`${ESC}[38;5;214mx${ESC}[39m`)).toBe('x');
  });

  it('should remove cursor and erase sequences', () => {
    expect(strip(`${ESC}[2J${ESC}[H`)).toBe('');
    expect(strip(`a${ESC}[3Db${ESC}[?25lc`)).toBe('abc');
    expect(strip(`${ESC}[1;2;3;4;5;6;7;8;9;10H`)).toBe('');
  });

  it('should remove an OSC hyperlink, both terminators', () => {
    expect(strip(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe('link');
    expect(strip(`${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`)).toBe('link');
  });

  it('should remove an OSC window title, semicolons and spaces and all', () => {
    expect(strip(`${ESC}]0;my cli: building; almost${BEL}done`)).toBe('done');
  });

  it('should remove DCS, APC, and the other string sequences', () => {
    expect(strip(`${ESC}P1;2|payload${ST}x`)).toBe('x');
    expect(strip(`${ESC}_tmux;whatever${ST}x`)).toBe('x');
    expect(strip(`${ESC}^private${ST}x`)).toBe('x');
    expect(strip(`${ESC}X${ST}x`)).toBe('x');
  });

  it('should remove a CSI with colon sub-parameters or an intermediate byte', () => {
    // curly underline, a device status query, and a private mode report
    expect(strip(`${ESC}[4:3mx${ESC}[4:0m`)).toBe('x');
    expect(strip(`${ESC}[58;2;0;255;0mx${ESC}[59m`)).toBe('x');
    expect(strip(`${ESC}[1$qx`)).toBe('x');
    expect(strip(`${ESC}[>"px`)).toBe('x');
  });

  it('should remove two and three character escapes', () => {
    expect(strip(`${ESC}(Bx`)).toBe('x');
    expect(strip(`${ESC}7x${ESC}8`)).toBe('x');
    expect(strip(`${ESC}=x${ESC}>`)).toBe('x');
  });

  it('should remove single byte C1 introducers', () => {
    expect(strip('31mred39m')).toBe('red');
    expect(strip(`0;title${BEL}x`)).toBe('x');
  });

  // a half written sequence is still not printable text, and leaving part of
  // one behind would corrupt whatever measures or wraps the result next
  it('should remove a sequence truncated at the end of the string', () => {
    expect(strip(`red${ESC}[3`)).toBe('red');
    expect(strip(`red${ESC}[`)).toBe('red');
    expect(strip(`red${ESC}`)).toBe('red');
    expect(strip(`red${ESC}]8;;https://example.com`)).toBe('red');
    expect(strip(`red${ESC}Ppayload`)).toBe('red');
  });

  // a terminal leaves the string state on a cancel or on an ESC, so an
  // unterminated one must not swallow everything printable after it
  it('should end a string sequence where a terminal ends it', () => {
    expect(strip(`${ESC}]0;title${CAN}visible`)).toBe('visible');
    expect(strip(`${ESC}]0;title${SUB}visible`)).toBe('visible');
    expect(strip(`${ESC}]0;title${ESC}[31mred`)).toBe('red');
    expect(strip(`${ESC}Ppayload${CAN}visible`)).toBe('visible');
    expect(strip(`${ESC}_apc${ESC}[0mvisible`)).toBe('visible');
  });

  it('should not eat text that only looks like a sequence', () => {
    expect(strip('[31mred')).toBe('[31mred');
    expect(strip('a[1;2Hb')).toBe('a[1;2Hb');
  });

  it('should be idempotent', () => {
    const once = strip(`${ESC}[31m${ESC}]8;;x${BEL}red${ESC}[39m`);
    expect(strip(once)).toBe(once);
  });
});

describe('hasAnsi()', () => {
  it('should report whether a string carries a sequence', () => {
    expect(hasAnsi('plain')).toBe(false);
    expect(hasAnsi('')).toBe(false);
    expect(hasAnsi(`${ESC}[31mred${ESC}[39m`)).toBe(true);
    expect(hasAnsi('31m')).toBe(true);
  });

  // a `g` flagged regex kept between calls carries `lastIndex`, which makes
  // `test()` answer differently depending on what ran before it
  it('should answer the same way every time', () => {
    const str = `${ESC}[31mred${ESC}[39m`;
    expect(hasAnsi(str)).toBe(true);
    expect(hasAnsi(str)).toBe(true);
    expect(hasAnsi(str)).toBe(true);
  });
});

describe('hasIntroducer()', () => {
  it('should be false for the other controls, which strip() leaves alone', () => {
    const plain = 'a\tb\nc\r\nd\u0000e\u007ff';
    expect(hasIntroducer(plain)).toBe(false);
    expect(strip(plain)).toBe(plain);
  });

  it('should be true for an ESC and for every C1 character', () => {
    expect(hasIntroducer(`a${ESC}`)).toBe(true);
    for (let code = 0x80; code <= 0x9f; code++) {
      expect(hasIntroducer(`a${String.fromCharCode(code)}b`), code.toString(16)).toBe(true);
    }
    expect(hasIntroducer('\u00A0')).toBe(false);
  });

  // what it is for: a whole string can hold no sequence while a slice of it
  // does, so hasAnsi() of the whole says nothing about its slices
  it('should answer for every slice, where hasAnsi() answers for the whole', () => {
    const csi = String.fromCharCode(0x9b);
    const whole = `${csi}12中`;
    expect(hasAnsi(whole)).toBe(false);
    expect(strip(whole.slice(0, 3))).toBe('');
    expect(hasIntroducer(whole)).toBe(true);
  });
});

// SIG-710: `strip()` reads a lone introducer as a sequence that never ends and takes
// the text after it, which is the terminal's reading and is left alone. What a drawn
// string needs is the other reading, and it is the same grammar read for what is whole
describe('stripWellFormed()', () => {
  const C1 = (code: number): string => String.fromCharCode(code);
  const ST1 = C1(0x9c);
  const MARK = '\uFFFD';

  it('should remove every sequence strip() removes, where each is whole', () => {
    const whole = [
      `${ESC}[31mred${ESC}[39m`,
      `${ESC}[1;2;3H${ESC}[?25l${ESC}[2J`,
      `${C1(0x9b)}31mred${C1(0x9b)}39m`,
      `${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`,
      `${ESC}]0;title${ST}text`,
      `${C1(0x9d)}0;title${ST1}text`,
      `${ESC}Pdata${ST}text${ESC}_apc${ST}${ESC}^pm${ST}${ESC}Xsos${ST}`,
      `${C1(0x90)}data${ST1}text`,
      `a${ESC}cb${ESC}7c${ESC}(0d`,
    ];
    for (const str of whole) {
      expect(stripWellFormed(str, MARK), JSON.stringify(str)).toBe(strip(str));
    }
    expect(stripWellFormed(`${ESC}[31mred${ESC}[39m`, MARK)).toBe('red');
  });

  it('should leave a string with no introducer in it as it is', () => {
    const plain = 'caf\u00e9 \u65e5\u672c\u8a9e a\tb\nc';
    expect(stripWellFormed(plain, MARK)).toBe(plain);
  });

  // a Latin-1 decoding of UTF-8 puts C1 characters inside ordinary words
  it('should keep the text after a lone C1 character, and mark the character', () => {
    for (let code = 0x80; code <= 0x9f; code++) {
      if (code === 0x9c) {
        // a lone ST ends nothing, and is as lone as the rest
        expect(stripWellFormed(`a${ST1}\u4e2d rest`, MARK)).toBe(`a${MARK}\u4e2d rest`);
        continue;
      }
      expect(stripWellFormed(`caf${C1(code)}\u4e2d rest`, MARK), code.toString(16)).toBe(
        `caf${MARK}\u4e2d rest`
      );
    }
    // and strip() itself is the terminal's reading, unchanged
    expect(strip(`caf${C1(0x9f)} rest`)).toBe('caf');
    expect(strip(`caf${C1(0x9d)} rest`)).toBe('caf');
    expect(strip(`caf${C1(0x9b)}`)).toBe('caf');
  });

  it('should keep the text after a bare ESC, and mark it', () => {
    expect(stripWellFormed(`caf${ESC}`, MARK)).toBe(`caf${MARK}`);
    expect(stripWellFormed(`caf${ESC}\u4e2d rest`, MARK)).toBe(`caf${MARK}\u4e2d rest`);
    // an intermediate with nothing to escape is a bare ESC and a space
    expect(stripWellFormed(`a${ESC} \u4e2d`, MARK)).toBe(`a${MARK} \u4e2d`);
    // and an ESC that another sequence follows is bare, and the sequence is not
    expect(stripWellFormed(`a${ESC}${ESC}[31mb`, MARK)).toBe(`a${MARK}b`);
    expect(strip(`caf${ESC}`)).toBe('caf');
  });

  it('should keep a CSI that has no final byte, as an introducer and its text', () => {
    expect(stripWellFormed(`a${ESC}[31`, MARK)).toBe(`a${MARK}[31`);
    expect(stripWellFormed(`a${C1(0x9b)}31`, MARK)).toBe(`a${MARK}31`);
    expect(stripWellFormed(`a${ESC}[\u4e2d`, MARK)).toBe(`a${MARK}[\u4e2d`);
    expect(stripWellFormed(`a${ESC}[`, MARK)).toBe(`a${MARK}[`);
  });

  // decided: an OSC cut off at the end of the string is not removed. The text of a
  // sequence that was meant is only its payload, and one that was not meant keeps
  // its words; neither is a cell's to carry out
  it('should keep a string sequence that is never terminated', () => {
    expect(stripWellFormed(`a${ESC}]0;title`, MARK)).toBe(`a${MARK}]0;title`);
    expect(stripWellFormed(`a${ESC}]8;;https://example.com${BEL}link${ESC}]8;;`, MARK)).toBe(
      `alink${MARK}]8;;`
    );
    expect(stripWellFormed(`a${C1(0x9d)}0;title`, MARK)).toBe(`a${MARK}0;title`);
    // cancelled rather than terminated, so it is not whole either
    expect(stripWellFormed(`a${ESC}]0;t${CAN}rest`, MARK)).toBe(`a${MARK}]0;t${CAN}rest`);
    expect(stripWellFormed(`a${ESC}]0;t${SUB}rest`, MARK)).toBe(`a${MARK}]0;t${SUB}rest`);
    // and what is inside one that was never whole is read again
    expect(stripWellFormed(`${C1(0x9d)} caf${C1(0x9f)}\u4e2d`, MARK)).toBe(
      `${MARK} caf${MARK}\u4e2d`
    );
  });

  // the grammar is a terminal's: a C1 CSI is whole with a final byte after it, and a
  // letter is one, so `\u009B` and `m` are the sequence `ESC [ m` said in one byte
  it('should take a C1 introducer and the letter after it as a whole sequence', () => {
    expect(stripWellFormed(`na${C1(0x9b)}me`, MARK)).toBe('nae');
    expect(stripWellFormed(`na${C1(0x9b)}\u4e2dme`, MARK)).toBe(`na${MARK}\u4e2dme`);
  });

  // `ESC [` is not the only introducer that a sequence of its own can follow
  it('should mark an ESC that opens a sequence and is followed by nothing', () => {
    for (const opener of [']', 'P', 'X', '^', '_', '[']) {
      expect(stripWellFormed(`a${ESC}${opener}`, MARK), opener).toBe(`a${MARK}${opener}`);
      expect(stripWellFormed(`a${ESC}${opener}${ESC}[31mb`, MARK), opener).toBe(
        `a${MARK}${opener}b`
      );
    }
    // with an intermediate in front it is a different sequence, and a whole one
    expect(stripWellFormed(`a${ESC} Pb`, MARK)).toBe('ab');
  });

  // the first version recursed into what followed each introducer, one frame each
  it('should read a long run of lone introducers in a loop, not a recursion', () => {
    // and in linear time: each was matched to the end of the string and rescanned,
    // which is ten seconds for a hundred thousand and a test that cannot finish
    const run = C1(0x9d).repeat(100_000);
    expect(stripWellFormed(`a${run}b`, MARK)).toBe(`a${MARK.repeat(100_000)}b`);
    const words = `word${C1(0x9f)}`.repeat(20_000);
    expect(stripWellFormed(words, MARK)).toBe(`word${MARK}`.repeat(20_000));
    const mojibake = Buffer.from('\u201d'.repeat(5_000), 'utf8').toString('latin1');
    expect(stripWellFormed(mojibake, MARK)).not.toMatch(/[\u0080-\u009f]/u);
  });

  it('should mark with whatever it is given, and not read it as a pattern', () => {
    expect(stripWellFormed(`a${C1(0x85)}b`, '$&')).toBe('a$&b');
    expect(stripWellFormed(`a${C1(0x85)}b`, '')).toBe('ab');
  });
});

// SIG-724: the ESC form is the only one anybody writes on purpose, and a C1 character
// in a string a person wrote is a Latin-1 decoding of UTF-8 punctuation, so it is text
describe('stripWellFormed() with c1 read as text', () => {
  const C1 = (code: number): string => String.fromCharCode(code);
  const ST1 = C1(0x9c);
  const MARK = '\uFFFD';
  const text = (str: string): string => stripWellFormed(str, MARK, { c1: 'text' });

  it('should keep the words between a pair of curly quotes read as Latin-1', () => {
    expect(text(`${C1(0x9d)}quoted words${ST1} after`)).toBe(`${MARK}quoted words${MARK} after`);
    // the same sequence read as a terminal does, which is the default and unchanged
    expect(stripWellFormed(`${C1(0x9d)}quoted words${ST1} after`, MARK)).toBe(' after');
    const mojibake = Buffer.from('\u201cquoted words\u201d and more', 'utf8').toString('latin1');
    expect(text(mojibake)).not.toMatch(/[\u0080-\u009f]/u);
    expect(text(mojibake)).toContain('quoted words');
    expect(text(mojibake)).toContain(' and more');
  });

  it('should keep the text after a C1 CSI, which is a lone character here', () => {
    expect(text(`m\u00c4${C1(0x9b)} sto`)).toBe(`m\u00c4${MARK} sto`);
    expect(stripWellFormed(`m\u00c4${C1(0x9b)} sto`, MARK)).toBe('m\u00c4to');
    expect(text(`na${C1(0x9b)}me`)).toBe(`na${MARK}me`);
    expect(text(`${C1(0x90)}data${ST1}text`)).toBe(`${MARK}data${MARK}text`);
  });

  it('should mark every C1 character and keep everything around it', () => {
    for (let code = 0x80; code <= 0x9f; code++) {
      expect(text(`caf${C1(code)} rest ${C1(code)}x`), code.toString(16)).toBe(
        `caf${MARK} rest ${MARK}x`
      );
    }
  });

  it('should still remove every ESC-form sequence that is whole', () => {
    const whole = [
      `${ESC}[31mred${ESC}[39m`,
      `${ESC}[1;2;3H${ESC}[?25l${ESC}[2J`,
      `${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`,
      `${ESC}]0;title${ST}text`,
      `${ESC}Pdata${ST}text${ESC}_apc${ST}${ESC}^pm${ST}${ESC}Xsos${ST}`,
      `a${ESC}cb${ESC}7c${ESC}(0d`,
    ];
    for (const str of whole) {
      expect(text(str), JSON.stringify(str)).toBe(stripWellFormed(str, MARK));
    }
    expect(text(`${ESC}[31mcaf${C1(0x9f)} rest${ESC}[39m`)).toBe(`caf${MARK} rest`);
  });

  // decided: U+009C is a C1 character, so it is text and not a terminator, and an OSC
  // that only it would close is one that never ended
  it('should not close an ESC string with U+009C', () => {
    expect(text(`${ESC}]0;title${ST1}text`)).toBe(`${MARK}]0;title${MARK}text`);
    expect(text(`${ESC}Pdata${ST1}text`)).toBe(`${MARK}Pdata${MARK}text`);
    // it ends the payload and does not carry it on to a BEL that is further along
    expect(text(`a${ESC}]0;t${ST1}x${BEL}y`)).toBe(`a${MARK}]0;t${MARK}x${BEL}y`);
    // BEL and ESC \ still do
    expect(text(`${ESC}]0;title${BEL}text`)).toBe('text');
    expect(text(`${ESC}]0;title${ST}text`)).toBe('text');
    // the default is unchanged
    expect(stripWellFormed(`${ESC}]0;title${ST1}text`, MARK)).toBe('text');
  });

  it('should keep what the default keeps for an unended or lone ESC form', () => {
    for (const str of [`caf${ESC}`, `a${ESC}[31`, `a${ESC}]0;title`, `a${ESC}${ESC}[31mb`]) {
      expect(text(str), JSON.stringify(str)).toBe(stripWellFormed(str, MARK));
    }
  });

  it('should read a long run of C1 characters in linear time and without a recursion', () => {
    const run = C1(0x9d).repeat(100_000);
    const started = performance.now();
    expect(text(`a${run}b`)).toBe(`a${MARK.repeat(100_000)}b`);
    expect(text(`${ESC}]${run}`)).toBe(`${MARK}]${MARK.repeat(100_000)}`);
    expect(text(`${C1(0x9b)}${' '.repeat(100_000)}`)).toBe(`${MARK}${' '.repeat(100_000)}`);
    const words = `word${C1(0x9f)}`.repeat(20_000);
    expect(text(words)).toBe(`word${MARK}`.repeat(20_000));
    // a bound and not a measurement: it was ten seconds when each was rescanned
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('should leave strip() as a terminal reads it', () => {
    expect(strip(`${C1(0x9d)}quoted words${ST1} after`)).toBe(' after');
    expect(strip(`m\u00c4${C1(0x9b)} sto`)).toBe('m\u00c4to');
    expect(strip(`caf${C1(0x9f)} rest`)).toBe('caf');
  });
});
