/**
 * More spinner frame sets, as data to copy in rather than code to import.
 *
 * `spinner.ts` ships seven sets in `@ttylabs/sigil/components` -- `DOTS`, `LINE`,
 * `ARC`, `CIRCLE`, `GROW`, `ARROW` and `BOUNCING_BAR` -- and these are the long
 * tail. They are not exported by the package: this file is a registry entry and
 * nothing imports it, so no app pays for a set it did not ask for. `sigil add
 * spinner-frames` copies it into the app, where it is the app's to trim, and a set
 * goes to a spinner the way a built-in one does --
 * `createSpinner({ frames: DOTS_2 })` -- imported from wherever `add` put this
 * file. (Not written out as an import here: the registry rewrites every relative
 * specifier in an entry, a comment's included.)
 *
 * Every set obeys the rule the built-in ones do -- each frame the same width, and
 * one cell unless the set is plain ASCII -- and is measured by the same test, so
 * a set that would make the label beside it jump is not here to copy.
 */

import type { SpinnerFrames } from './spinner.js';

/** All eight dots but one, the gap going round. */
export const DOTS_2: SpinnerFrames = {
  frames: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  interval: 80,
};

/** Three dots and a tail, winding. */
export const DOTS_3: SpinnerFrames = {
  frames: ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠴', '⠲', '⠳', '⠓'],
  interval: 80,
};

/** One dot walking round the edge of the cell. */
export const DOTS_ORBIT: SpinnerFrames = {
  frames: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  interval: 100,
};

/** A cell filling up with dots and draining again, like an hourglass. */
export const SAND: SpinnerFrames = {
  frames: [
    '⠁',
    '⠂',
    '⠄',
    '⡀',
    '⡈',
    '⡐',
    '⡠',
    '⣀',
    '⣁',
    '⣂',
    '⣄',
    '⣌',
    '⣔',
    '⣤',
    '⣥',
    '⣦',
    '⣮',
    '⣶',
    '⣷',
    '⣿',
    '⡿',
    '⠿',
    '⢟',
    '⠟',
    '⡛',
    '⠛',
    '⠫',
    '⢋',
    '⠋',
    '⠍',
    '⡉',
    '⠉',
    '⠑',
    '⠡',
    '⢁',
  ],
  interval: 80,
};

/** A star that twinkles. */
export const STAR: SpinnerFrames = { frames: ['✶', '✸', '✹', '✺', '✹', '✷'], interval: 70 };

/** A triangle turning in the corner of the cell. */
export const TRIANGLE: SpinnerFrames = { frames: ['◢', '◣', '◤', '◥'], interval: 50 };

/** A square with a quarter filled, turning. */
export const SQUARE: SpinnerFrames = { frames: ['◰', '◳', '◲', '◱'], interval: 180 };

/** A bar that grows and shrinks sideways inside one cell. */
export const GROW_HORIZONTAL: SpinnerFrames = {
  frames: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '▊', '▋', '▌', '▍', '▎'],
  interval: 120,
};

/** A box-drawing corner going round. */
export const PIPE: SpinnerFrames = {
  frames: ['┤', '┘', '┴', '└', '├', '┌', '┬', '┐'],
  interval: 100,
};

/** A switch flipping. */
export const TOGGLE: SpinnerFrames = { frames: ['⊶', '⊷'], interval: 250 };

/** Dots counting up to an ellipsis, in ASCII. */
export const SIMPLE_DOTS: SpinnerFrames = { frames: ['.  ', '.. ', '...', '   '], interval: 400 };

/** Dots scrolling through, in ASCII. */
export const SIMPLE_DOTS_SCROLLING: SpinnerFrames = {
  frames: ['.  ', '.. ', '...', ' ..', '  .', '   '],
  interval: 200,
};
