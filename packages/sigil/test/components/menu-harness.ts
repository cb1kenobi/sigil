import { strip } from '../../src/ansi/index.js';
import { type Element, renderToLines } from '../../src/element/index.js';
import { ESCAPE_TIMEOUT, type MouseSurface } from '../../src/input/index.js';
import { flush } from '../../src/signals/index.js';
import { KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';

/**
 * What the menu, menubar and dropdown tests share: a screen, the mouse reports a
 * terminal sends, and the waits a key needs.
 */

export const WIDTH = 40;
export const HEIGHT = 12;
const ESC = String.fromCharCode(0x1b);

/** Pointer motion with nothing held, at a zero-based canvas cell. */
export const move = (x: number, y: number): string => `${ESC}[<35;${x + 1};${y + 1}M`;
/** Motion with the left button held. */
export const drag = (x: number, y: number): string => `${ESC}[<32;${x + 1};${y + 1}M`;
/** A press of a button at a zero-based cell. */
export const press = (x: number, y: number, button = 0): string =>
  `${ESC}[<${button};${x + 1};${y + 1}M`;
/** A release of a button at a zero-based cell. */
export const release = (x: number, y: number, button = 0): string =>
  `${ESC}[<${button};${x + 1};${y + 1}m`;
/** A press and its release, which is a click. */
export const click = (x: number, y: number, button = 0): string[] => [
  press(x, y, button),
  release(x, y, button),
];

/** A canvas at the screen's origin, which is all the router asks of one. */
export function surface(): MouseSurface {
  return {
    height: HEIGHT,
    locate: async () => true,
    origin: { x: 0, y: 0 },
    toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
    width: WIDTH,
  };
}

/** The screen as a person would read it, trailing space trimmed. Also lays the tree out. */
export function picture(root: Element): string[] {
  return renderToLines(root, {
    cascade: themedCascade(),
    colorLevel: 0,
    height: HEIGHT,
    width: WIDTH,
  }).map((line) => strip(line).trimEnd());
}

/** Lets a key act, and the effects it caused. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  flush();
}

/** A lone Escape is held for the key deadline, so it needs the clock to pass. */
export async function escape(term: { press(...chunks: string[]): Promise<void> }): Promise<void> {
  await term.press(KEYS.escape);
  await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
  await settle();
}

/** The row of the screen that holds some text. */
export function rowOf(lines: string[], words: string): number {
  return lines.findIndex((line) => line.includes(words));
}
