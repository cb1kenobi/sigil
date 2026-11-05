/**
 * hello's root component, in JSX.
 *
 * `root.ui.ts` beside it is the same component in the `ui` tag, line for line,
 * and the smoke test asserts that the two draw the same screen. JSX is what an
 * editor can check -- every prop is typed, so `<box padddding={1}>` is an error
 * before anything runs -- and what it costs is a build: Node strips types and
 * does not compile JSX, so this file only ever runs as `sigil build` wrote it.
 */

import { ITEMS } from './common.ts';
import type { AppProps } from './start.ts';
import type { Element } from '@ttylabs/sigil/element';
import { onMount } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

export { stylesheet } from './common.ts';

/**
 * Three rows to move between and press, and a line that adds them up.
 *
 * @param props - The router and the way out.
 * @returns The screen.
 */
export function App({ exit, input }: AppProps): Element {
  const counts = ITEMS.map(() => new State(0));

  const rows = ITEMS.map((name, index) => {
    const count = counts[index] as State<number>;
    const row = (
      <box class="row" focusable>
        <text class="name">{name}</text>
        <text>{() => String(count.get())}</text>
      </box>
    );
    // Enter and Space belong to whichever row has the focus, so they are the
    // row's rather than the app's
    row.onKey = (event) => {
      if (event.key.name === 'enter' || event.key.name === 'space') {
        event.stop();
        count.set(count.get() + 1);
      }
    };
    return row;
  });

  input.bind('up', () => input.focus.previous());
  input.bind('down', () => input.focus.next());
  input.bind('q', () => exit(0));

  // after the first frame, which is when the ring has something in it
  onMount(() => input.focus.focus(rows[0]));

  return (
    <box class="app">
      <text class="title">hello, full screen</text>
      <text class="hint">Tab or the arrows move, Enter counts, q quits</text>
      <box class="rows">{rows}</box>
      <text class="status">
        {() => `${counts.reduce((sum, count) => sum + count.get(), 0)} presses`}
      </text>
    </box>
  );
}
