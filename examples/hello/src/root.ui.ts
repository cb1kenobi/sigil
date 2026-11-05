/**
 * hello's root component, in the `ui` tag.
 *
 * The same component as `root.tsx`, line for line, and the smoke test asserts
 * that the two draw the same screen -- which is the claim behind having two
 * syntaxes at all: one IR, so neither is a second-class spelling of the other.
 * This one runs as it is, because Node strips the types and there is no JSX to
 * compile: `node src/ui.ts` and nothing in between. What it gives up is the
 * checking -- a misspelt prop inside the template is a runtime refusal rather
 * than an editor's red line.
 *
 * A component is interpolated rather than named (`<${Row} />`), because a tag
 * has no scope to look a name up in; host elements stay bare.
 */

import { ITEMS } from './common.ts';
import { useApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { onMount } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { ui } from '@ttylabs/sigil/template';

export { stylesheet } from './common.ts';

/**
 * Three rows to move between and press, and a line that adds them up.
 *
 * @returns The screen.
 */
export function App(): Element {
  // the app this is running under: its router, and the way to end it. Read in
  // the body, since a handler that runs later has no owner to ask
  const app = useApp();
  const counts = ITEMS.map(() => new State(0));

  const rows = ITEMS.map((name, index) => {
    const count = counts[index] as State<number>;
    const row = ui`
      <box class="row" focusable>
        <text class="name">${name}</text>
        <text>${() => String(count.get())}</text>
      </box>
    `;
    row.onKey = (event) => {
      if (event.key.name === 'enter' || event.key.name === 'space') {
        event.stop();
        count.set(count.get() + 1);
      }
    };
    return row;
  });

  app.input?.bind('up', () => app.input?.focus.previous());
  app.input?.bind('down', () => app.input?.focus.next());
  app.input?.bind('q', () => app.exit());

  onMount(() => app.input?.focus.focus(rows[0]));

  return ui`
    <box class="app">
      <text class="title">hello, full screen</text>
      <text class="hint">Tab or the arrows move, Enter counts, q quits</text>
      <box class="rows">${rows}</box>
      <text class="status">${() => `${counts.reduce((sum, count) => sum + count.get(), 0)} presses`}</text>
    </box>
  `;
}
