import { createFullscreenCanvas } from '../../src/canvas/index.js';
import {
  createLog,
  LOG_SYMBOLS,
  LOG_SYMBOLS_ASCII,
  log as processLog,
} from '../../src/components/log.js';
import { createProgress } from '../../src/components/progress.js';
import { createSpinner } from '../../src/components/spinner.js';
import { setQuiet } from '../../src/style/output.js';
import { createTerminal, type OutputStream } from '../../src/terminal/index.js';
import { createLiveRegion } from '../../src/terminal/live.js';
import { createStream, screenSetup } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  setQuiet(undefined);
  vi.unstubAllEnvs();
});

const ESC = String.fromCharCode(0x1b);

/** A terminal whose two streams are separate, so that which one is written is visible. */
function split(opts: { columns?: number; err?: boolean; out?: boolean } = {}) {
  const stdout = createStream({ columns: opts.columns ?? 40, isTTY: opts.out ?? true });
  const stderr = createStream({ columns: opts.columns ?? 40, isTTY: opts.err ?? true });
  // what is asserted is the text, and the carriage returns a screen gets are
  // asserted once, in their own test, off `raw`
  const raw: string[] = [];
  const record = stderr.write.bind(stderr);
  stderr.write = (chunk: string): boolean => {
    raw.push(chunk);
    return record(chunk.replace(/\r/g, ''));
  };
  const terminal = createTerminal({
    env: {},
    isTTY: opts.out ?? true,
    proc: { listenerCount: () => 0, on() {}, removeListener() {} },
    stderr: stderr as unknown as OutputStream,
    stdin: undefined,
    stdout: stdout as unknown as OutputStream,
  });
  return { raw, stderr, stdout, terminal };
}

describe('a status line', () => {
  it('should lead each level with its own glyph', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    log.info('one');
    log.success('two');
    log.warn('three');
    log.error('four');
    log.step('five');

    expect(stderr.output).toBe(
      [
        `${LOG_SYMBOLS.info} one`,
        `${LOG_SYMBOLS.success} two`,
        `${LOG_SYMBOLS.warn} three`,
        `${LOG_SYMBOLS.error} four`,
        `${LOG_SYMBOLS.step} five`,
        '',
      ].join('\n')
    );
  });

  it('should write every level to stderr and nothing to stdout', () => {
    // a command's run() returns data and a serializer prints it to stdout, so a
    // status line there would arrive in the middle of `mycli --format json | jq`
    const { stderr, stdout, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    log.info('a');
    log.success('b');
    log.warn('c');
    log.error('d');
    log.step('e');
    log.message('f');

    expect(stdout.output).toBe('');
    expect(stderr.text.split('\n').filter(Boolean)).toHaveLength(6);
  });

  it('should write a message with no glyph when it is given none', () => {
    const { stderr, terminal } = split();
    createLog({ colorLevel: 0, terminal }).message('just text');
    expect(stderr.output).toBe('just text\n');
  });

  it('should write a message with the symbol it is given', () => {
    const { stderr, terminal } = split();
    createLog({ colorLevel: 0, terminal }).message('custom', { symbol: '*' });
    expect(stderr.output).toBe('* custom\n');
  });

  it('should use the ASCII glyphs when asked to', () => {
    const { stderr, terminal } = split();
    const log = createLog({ ascii: true, colorLevel: 0, terminal });

    log.info('a');
    log.success('b');
    log.warn('c');
    log.error('d');
    log.step('e');

    expect(stderr.output).toBe(
      [
        `${LOG_SYMBOLS_ASCII.info} a`,
        `${LOG_SYMBOLS_ASCII.success} b`,
        `${LOG_SYMBOLS_ASCII.warn} c`,
        `${LOG_SYMBOLS_ASCII.error} d`,
        `${LOG_SYMBOLS_ASCII.step} e`,
        '',
      ].join('\n')
    );
    // and nothing outside ASCII, which is what the set is for
    // eslint-disable-next-line no-control-regex
    expect(/^[\u0000-\u007f]*$/.test(stderr.output)).toBe(true);
  });

  it('should let one glyph be replaced without the rest', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, symbols: { warn: '!!' }, terminal });

    log.warn('careful');
    log.info('fine');

    expect(stderr.output).toBe(`!! careful\n${LOG_SYMBOLS.info} fine\n`);
  });
});

describe('a status line, styled', () => {
  it('should colour the glyph by its theme role and leave the message alone', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 3, terminal });

    log.success('built');

    // the glyph is green (the role) and is closed again before the message,
    // which is left in the terminal's own colour
    expect(stderr.output).toBe(`${ESC}[32m${LOG_SYMBOLS.success} ${ESC}[39mbuilt\n`);
  });

  it('should draw each level in a different role', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 1, terminal });

    log.info('i');
    log.success('s');
    log.warn('w');
    log.error('e');
    log.step('t');

    const codes = stderr.output
      .split('\n')
      .filter(Boolean)
      // eslint-disable-next-line no-control-regex
      .map((line) => /\u001b\[(\d+)m/.exec(line)?.[1]);

    // blue, green, yellow, red and cyan: the five roles, no two the same
    expect(codes).toEqual(['34', '32', '33', '31', '36']);
  });

  it('should follow a theme that restyles a role', () => {
    const { stderr, terminal } = split();
    createLog({ colorLevel: 1, terminal, theme: '.sigil-warn { color: magenta }' }).warn('x');
    expect(stderr.output).toContain(`${ESC}[35m`);
  });

  it('should draw plain text at colour level 0', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    log.error('x');
    log.info('y');

    expect(stderr.output).not.toContain(ESC);
  });

  it('should write no escape sequence when stderr is not a terminal', () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', undefined);
    const { stderr, terminal } = split({ err: false });

    createLog({ terminal }).error('piped');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.error} piped\n`);
  });

  it('should detect its colour from stderr rather than from stdout', () => {
    // `mycli > out.json` leaves stdout a file and stderr the screen: the lines
    // that are for a person are the ones that should still be coloured
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('TERM', 'xterm-256color');
    const { stderr, terminal } = split({ err: true, out: false });

    createLog({ terminal }).error('on the screen');

    expect(stderr.output).toContain(ESC);
  });
});

describe('a multi-line status line', () => {
  it('should hold the glyph column under every continuation line', () => {
    const { stderr, terminal } = split();
    createLog({ colorLevel: 0, terminal }).warn('first\nsecond\n\nfourth');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.warn} first\n  second\n\n  fourth\n`);
  });

  it('should end each line with a carriage return on a screen and not in a file', () => {
    // raw mode turns the terminal's own translation off, and a prompt's is on
    const screen = split();
    createLog({ colorLevel: 0, terminal: screen.terminal }).info('a\nb');
    expect(screen.raw.join('')).toBe(`${LOG_SYMBOLS.info} a\r\n  b\r\n`);

    const file = split({ err: false });
    createLog({ colorLevel: 0, terminal: file.terminal }).info('a\nb');
    expect(file.raw.join('')).toBe(`${LOG_SYMBOLS.info} a\n  b\n`);
  });

  it('should wrap to the width of the terminal and keep the indent', () => {
    const { stderr, terminal } = split({ columns: 20 });
    createLog({ colorLevel: 0, terminal }).info('alpha beta gamma delta epsilon');

    expect(stderr.output.split('\n')).toEqual([
      `${LOG_SYMBOLS.info} alpha beta gamma`,
      '  delta epsilon',
      '',
    ]);
  });

  it('should not wrap a line written to a file', () => {
    const { stderr, terminal } = split({ columns: 20, err: false });
    const message = 'alpha beta gamma delta epsilon zeta eta theta';
    createLog({ colorLevel: 0, terminal }).info(message);

    expect(stderr.output).toBe(`${LOG_SYMBOLS.info} ${message}\n`);
  });

  it('should measure a wide glyph by its columns, not its length', () => {
    const { stderr, terminal } = split({ columns: 12 });
    createLog({ colorLevel: 0, terminal }).message('aaa bbb', { symbol: '日本' });

    // the glyph takes four columns with its gap, leaving eight
    expect(stderr.output.split('\n')).toEqual(['日本 aaa bbb', '']);
  });
});

describe('a status line under the quiet axis', () => {
  it('should drop the levels that are progress and keep the ones that are not', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    setQuiet(true);
    log.info('i');
    log.success('s');
    log.step('t');
    log.message('m');
    log.warn('w');
    log.error('e');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.warn} w\n${LOG_SYMBOLS.error} e\n`);
  });

  it('should be asked when the line is written, not when the logger was made', () => {
    // `log` exists at module scope, before main() has read argv
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    log.info('before');
    setQuiet(true);
    log.info('during');
    setQuiet(undefined);
    log.info('after');

    expect(stderr.text).toBe(`${LOG_SYMBOLS.info} before\n${LOG_SYMBOLS.info} after\n`);
  });

  it('should be silenced by its own option without the process being quiet', () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, quiet: true, terminal });

    log.info('i');
    log.error('e');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.error} e\n`);
  });

  it('should opt out of a quiet process with quiet: false', () => {
    const { stderr, terminal } = split();
    setQuiet(true);
    createLog({ colorLevel: 0, quiet: false, terminal }).info('still here');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.info} still here\n`);
  });

  it('should write on a terminal that is not a screen', () => {
    // reduced, not quiet: a log file is where a status line is most wanted
    const { stderr, terminal } = split({ err: false, out: false });
    createLog({ colorLevel: 0, terminal }).info('in a file');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.info} in a file\n`);
  });
});

describe('a status line while something is on screen', () => {
  it('should print above a running spinner and leave the spinner at the bottom', () => {
    const h = screenSetup({ columns: 30 });
    const spinner = createSpinner({ terminal: h.terminal, text: 'working' });
    const log = createLog({ colorLevel: 0, terminal: h.terminal });

    spinner.start();
    log.info('step one done');
    log.warn('careful');

    expect(h.log).toHaveLength(3);
    expect(h.log[0]).toBe(`${LOG_SYMBOLS.info} step one done`);
    expect(h.log[1]).toBe(`${LOG_SYMBOLS.warn} careful`);
    // one spinner row, not two: the frame was taken down and put back
    expect(h.log[2]).toMatch(/working$/);

    spinner.succeed('done');
    expect(h.log.at(-1)).toBe(`${LOG_SYMBOLS.success} done`);
    expect(h.log.filter((line) => line.includes('working'))).toHaveLength(0);
  });

  it('should print above a progress bar', () => {
    const h = screenSetup({ columns: 40 });
    const bar = createProgress({ terminal: h.terminal, text: 'copy', total: 10 });
    const log = createLog({ colorLevel: 0, terminal: h.terminal });

    bar.tick(5);
    log.step('halfway');

    expect(h.log[0]).toBe(`${LOG_SYMBOLS.step} halfway`);
    expect(h.log).toHaveLength(2);
    expect(h.log[1]).toContain('copy');
    bar.stop();
  });

  it('should keep a multi-line message intact above a spinner', () => {
    const h = screenSetup({ columns: 30 });
    const spinner = createSpinner({ terminal: h.terminal, text: 'working' });

    spinner.start();
    createLog({ colorLevel: 0, terminal: h.terminal }).error('bad\nreally bad');

    expect(h.log.slice(0, 2)).toEqual([`${LOG_SYMBOLS.error} bad`, '  really bad']);
    expect(h.log).toHaveLength(3);
    spinner.stop();
  });

  it('should draw the line once the spinner has settled, with nothing to get out of the way of', () => {
    const h = screenSetup({ columns: 30 });
    const spinner = createSpinner({ terminal: h.terminal, text: 'working' });
    spinner.start();
    spinner.stop();
    createLog({ colorLevel: 0, terminal: h.terminal }).info('after');

    expect(h.log.at(-1)).toBe(`${LOG_SYMBOLS.info} after`);
  });

  it('should send the line to stderr and leave stdout to the frame', () => {
    const { stderr, stdout, terminal } = split();
    const spinner = createSpinner({ terminal, text: 'working' });
    spinner.start();
    stdout.written.length = 0;

    createLog({ colorLevel: 0, terminal }).info('to the screen');

    expect(stderr.output.replace(/\r/g, '')).toBe(`${LOG_SYMBOLS.info} to the screen\n`);
    // stdout was asked only to take the frame down and put it back
    expect(stdout.output).not.toContain('to the screen');
    expect(stdout.output).toContain('working');
    spinner.stop();
  });

  it('should not disturb the frame for a stderr that is not a screen', () => {
    // `mycli 2> errors.log` with a spinner on the terminal: nothing to get out
    // of the way of, and erasing it would only flicker
    const { stderr, stdout, terminal } = split({ err: false });
    const spinner = createSpinner({ terminal, text: 'working' });
    spinner.start();
    stdout.written.length = 0;

    createLog({ colorLevel: 0, terminal }).info('to a file');

    expect(stdout.output).toBe('');
    expect(stderr.output).toBe(`${LOG_SYMBOLS.info} to a file\n`);
    spinner.stop();
  });

  it('should print above a live region that is not a canvas', () => {
    const h = screenSetup({ columns: 30 });
    const region = createLiveRegion({ terminal: h.terminal });
    region.render('frame body');
    createLog({ colorLevel: 0, terminal: h.terminal }).info('above');

    // the live region writes a bare newline, which the screen model does not
    // return the carriage for; the order is the claim
    expect(h.log.map((line) => line.trim())).toEqual([`${LOG_SYMBOLS.info} above`, 'frame body']);
    region.stop();
  });

  it('should send a line above a live region to stderr and not stdout', () => {
    const { stderr, stdout, terminal } = split();
    const region = createLiveRegion({ terminal });
    region.render('frame body');
    stdout.written.length = 0;

    createLog({ colorLevel: 0, terminal }).info('above');

    expect(stderr.output).toBe(`${LOG_SYMBOLS.info} above\n`);
    expect(stdout.output).not.toContain('above');
    // and the frame was taken down and drawn again around it
    expect(stdout.output).toContain('frame body');
    region.stop();
  });

  it('should hold a line behind a full-screen app and write it to stderr on the way out', () => {
    const { stderr, stdout, terminal } = split();
    const backend = createFullscreenCanvas({ terminal });
    backend.render((painter) => painter.text(0, 0, 'app'));
    // the log goes where the app can't see it, until it is done
    backend.write('held on stdout');
    createLog({ colorLevel: 0, terminal }).info('held on stderr');
    expect(stderr.output).not.toContain('held on stderr');

    backend.done();

    expect(stderr.output).toContain('held on stderr');
    expect(stderr.output).not.toContain('held on stdout');
    expect(stdout.output).toContain('held on stdout');
    expect(stdout.output).not.toContain('held on stderr');
  });
});

describe('the terminal under a status line', () => {
  it('should write to stderr when nothing holds the live region', () => {
    const { stderr, stdout, terminal } = split();
    terminal.writeStatus('plain');

    expect(stderr.output).toBe('plain\n');
    expect(stdout.output).toBe('');
  });

  it('should hand the line to whoever holds the region', () => {
    const { stderr, terminal } = split();
    const lines: string[] = [];
    const claim = terminal.claimLive(undefined, (text) => lines.push(text));

    terminal.writeStatus('x\n');
    expect(lines).toEqual(['x\n']);
    expect(stderr.output).toBe('');

    claim.release();
    terminal.writeStatus('y');
    expect(stderr.output).toBe('y\n');
  });

  it('should go to stderr once the region holder has been evicted', () => {
    const { stderr, terminal } = split();
    const lines: string[] = [];
    terminal.claimLive(undefined, (text) => lines.push(text));
    terminal.claimLive();

    terminal.writeStatus('z');

    // the second claim named nobody to get out of the way
    expect(lines).toEqual([]);
    expect(stderr.output).toBe('z\n');
  });
});

describe('the process logger', () => {
  it('should be a logger over the process terminal', () => {
    expect(Object.keys(processLog).sort()).toEqual([
      'error',
      'info',
      'message',
      'step',
      'success',
      'warn',
    ]);
  });
});
