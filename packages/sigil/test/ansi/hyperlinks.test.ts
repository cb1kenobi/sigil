import { supportsHyperlinks } from '../../src/ansi/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Whether a terminal draws OSC 8 as a link.
 *
 * Every case passes its own environment and says whether it is a TTY, so the
 * terminal the suite happens to run in decides nothing.
 */
const tty = (env: Record<string, string | undefined>): boolean =>
  supportsHyperlinks({ env, isTTY: true });

describe('supportsHyperlinks()', () => {
  it.each([
    ['iTerm2 3.1', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.1.0' }],
    ['iTerm2 3.5', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' }],
    ['VS Code 1.72', { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.72.0' }],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }],
    ['kitty', { TERM: 'xterm-kitty' }],
    ['Windows Terminal', { WT_SESSION: 'abc' }],
    ['foot', { TERM: 'foot' }],
    ['Alacritty', { ALACRITTY_WINDOW_ID: '1', TERM: 'alacritty' }],
    ['Konsole 21.04', { KONSOLE_VERSION: '210400' }],
    ['a VTE terminal from 0.50', { VTE_VERSION: '5000' }],
  ])('should say yes for %s', (_, env) => {
    expect(tty(env)).to.equal(true);
  });

  it.each([
    ['iTerm2 3.0', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.0.15' }],
    ['VS Code 1.71', { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.71.2' }],
    ['Konsole 20.12', { KONSOLE_VERSION: '201200' }],
    ['a VTE terminal before 0.50', { VTE_VERSION: '4802' }],
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal' }],
    ['a terminal nothing says anything about', { TERM: 'xterm-256color' }],
    ['tmux', { TERM: 'tmux-256color', TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux-501/default' }],
    ['screen', { TERM: 'screen' }],
    ['a dumb terminal', { TERM: 'dumb', TERM_PROGRAM: 'WezTerm' }],
    ['CI', { CI: 'true', TERM_PROGRAM: 'WezTerm' }],
  ])('should say no for %s', (_, env) => {
    expect(tty(env)).to.equal(false);
  });

  // an unknown terminal is a no because the two mistakes are not the same size:
  // a yes that is wrong loses the URL, a no that is wrong only shows it
  it('should say no for an unknown terminal', () => {
    expect(tty({})).to.equal(false);
  });

  it('should say no where the stream is not a terminal', () => {
    expect(supportsHyperlinks({ env: { TERM_PROGRAM: 'WezTerm' }, isTTY: false })).to.equal(false);
    expect(supportsHyperlinks({ env: { TERM_PROGRAM: 'WezTerm' }, stream: {} })).to.equal(false);
  });

  it('should read the stream it was given', () => {
    expect(
      supportsHyperlinks({ env: { TERM_PROGRAM: 'WezTerm' }, stream: { isTTY: true } })
    ).to.equal(true);
  });

  it('should take FORCE_HYPERLINK over everything, through a pipe included', () => {
    expect(supportsHyperlinks({ env: { FORCE_HYPERLINK: '1' }, isTTY: false })).to.equal(true);
    expect(supportsHyperlinks({ env: { FORCE_HYPERLINK: '' }, isTTY: false })).to.equal(true);
    expect(tty({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'WezTerm' })).to.equal(false);
    expect(tty({ FORCE_HYPERLINK: 'false', TERM_PROGRAM: 'WezTerm' })).to.equal(false);
  });

  it('should read a version that does not parse as too old', () => {
    expect(tty({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: 'nightly' })).to.equal(false);
  });
});
