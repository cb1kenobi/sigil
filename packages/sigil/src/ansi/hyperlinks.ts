import type { ColorSupportOptions } from './color-support.js';

/**
 * Whether a stream's terminal turns an OSC 8 sequence into a link.
 *
 * Read off the environment rather than asked of the terminal, for the reason
 * `supportsColor()` is: there is no query a terminal answers about OSC 8, and a
 * string being built has no terminal to ask anyway.
 *
 * **An unknown terminal is a no**, and that is the whole of the design. The two
 * ways to be wrong are not the same size. A yes on a terminal that swallows the
 * sequence without drawing a link -- which is what a conforming parser does with
 * an OSC it does not know -- prints the link's words and loses where it pointed,
 * with nothing on screen to say there was a URL at all. A no on a terminal that
 * could have drawn one prints the URL beside the words: longer, and complete. So
 * a terminal is a yes only when it is one known to draw them.
 *
 * Precedence, highest first:
 *
 * 1. `FORCE_HYPERLINK` -- `0` or `false` is no, anything else (the empty string
 *    included) is yes. It wins over the TTY check, for the reason `FORCE_COLOR`
 *    does: forcing the answer through a pipe is what a variable like it is for.
 * 2. `TERM=dumb`, or not a TTY -- no.
 * 3. Inside tmux or screen -- no. tmux passes OSC 8 through only when its own
 *    configuration says so, and nothing in the environment says whether it does.
 * 4. A CI runner -- no. A log viewer is not a terminal, whatever it emulates.
 * 5. The terminals known to draw them: iTerm2 from 3.1, WezTerm, VS Code's
 *    terminal from 1.72, Ghostty, kitty, Windows Terminal, foot, Alacritty from
 *    0.11, Konsole from 21.04, and the VTE family (GNOME Terminal, Tilix, Terminator
 *    and the rest) from 0.50.
 *
 * @param opts - The stream and environment to detect for.
 * @returns Whether to write links as OSC 8.
 */
export function supportsHyperlinks(opts: ColorSupportOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const forced = env.FORCE_HYPERLINK;

  if (forced !== undefined) {
    return forced !== '0' && forced !== 'false';
  }

  if (env.TERM === 'dumb') {
    return false;
  }

  const stream = 'stream' in opts ? opts.stream : process.stdout;
  const isTTY = opts.isTTY ?? stream?.isTTY ?? false;
  if (!isTTY) {
    return false;
  }

  const { TERM = '', TERM_PROGRAM = '', TERM_PROGRAM_VERSION = '' } = env;

  if (env.TMUX !== undefined || TERM_PROGRAM === 'tmux' || /^(?:screen|tmux)/.test(TERM)) {
    return false;
  }

  if (env.CI !== undefined || env.GITHUB_ACTIONS !== undefined || env.TEAMCITY_VERSION) {
    return false;
  }

  switch (TERM_PROGRAM) {
    case 'iTerm.app': {
      return atLeast(TERM_PROGRAM_VERSION, [3, 1]);
    }
    case 'vscode': {
      return atLeast(TERM_PROGRAM_VERSION, [1, 72]);
    }
    case 'WezTerm':
    case 'ghostty': {
      return true;
    }
    // no default: an unrecognised TERM_PROGRAM falls through to the variables
    // below, which a terminal sets whatever program launched the shell
  }

  // Alacritty says which version it is nowhere, and drew them from 0.11 -- which
  // is old enough, in late 2022, that the release it cannot prove is the one
  // nobody is still running
  if (
    env.WT_SESSION !== undefined ||
    env.KITTY_WINDOW_ID !== undefined ||
    env.ALACRITTY_WINDOW_ID !== undefined ||
    TERM === 'xterm-kitty' ||
    TERM === 'alacritty' ||
    /^foot(?:-|$)/.test(TERM)
  ) {
    return true;
  }

  // Konsole writes its version as one number, 21.04.0 being 210400
  if (env.KONSOLE_VERSION !== undefined) {
    return Number(env.KONSOLE_VERSION) >= 210400;
  }

  // the VTE widget, which is GNOME Terminal and most of what is built on it,
  // writes 0.50.0 as 5000
  if (env.VTE_VERSION !== undefined) {
    return Number(env.VTE_VERSION) >= 5000;
  }

  return false;
}

/**
 * Whether a dotted version is at least the one given.
 *
 * @param version - The version, as a terminal reports it.
 * @param floor - The major and minor it has to reach.
 * @returns Whether it does; a version that does not parse does not.
 */
function atLeast(version: string, floor: readonly [number, number]): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) {
    return false;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > floor[0] || (major === floor[0] && minor >= floor[1]);
}
