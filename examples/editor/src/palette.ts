/**
 * The command palette: a field over a list of the editor's commands, ranked by
 * a fuzzy match as it is typed, in a dialog.
 *
 * `commandPalette()` in the components is a prompt over a CLI's command tree --
 * `commandCatalog()` reads a schema's commands, their arguments and their
 * options, and the answer is an argv to run. An app's own actions are none of
 * those things, so what this takes from it is the half underneath: `rankBy()` to
 * order the commands and `highlightRuns()` to draw what matched, in an
 * `openModal()` the app already uses for its confirms.
 */

import type { App } from '@ttylabs/sigil/app';
import {
  highlightRuns,
  keyLabel,
  listControl,
  ListView,
  openModal,
  type Ranked,
  rankBy,
  TextField,
} from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';
import type { InputRouter } from '@ttylabs/sigil/input';
import { Computed, State } from '@ttylabs/sigil/signals';

/** One thing the palette can do. */
export interface Command {
  /** What identifies it: the list's key. */
  readonly id: string;
  /** What it is called, which is what is matched and shown. */
  readonly title: string;
  /** The key that does the same thing outside the palette, as a spec: `ctrl+s`. */
  readonly keys?: string;
  /** Does it. Called by whoever opened the palette, once it has closed. */
  run(): void;
}

/** What the palette is opened with. */
export interface PaletteHost {
  /** The app, whose renderer the dialog goes over -- read when it opens, from a key. */
  readonly app: App;
  readonly input: InputRouter;
  /**
   * Builds the dialog's body under an owner that the palette disposes when it
   * closes, because it is opened from a key and a key handler has none (SIG-335).
   */
  owned<T>(build: () => T): { dispose: () => void; value: T };
}

/**
 * Opens the palette.
 *
 * Typing filters, Up and Down move the cursor without leaving the field, Enter
 * runs the command under it, and Escape closes it having run nothing.
 *
 * @param host - The renderer, the router, and an owner for the body.
 * @param commands - What it offers, in the order they are listed before anything is typed.
 * @returns The command chosen, once the palette has closed, or nothing for Escape. Not run
 *   here: the caller runs it once it has put away whatever it set while the palette was
 *   open, which a command that opens a dialog of its own has to find put away.
 */
export async function openPalette(
  host: PaletteHost,
  commands: readonly Command[]
): Promise<Command | undefined> {
  let close: (id: string | undefined) => void = () => {};
  const built = host.owned(() => {
    const query = new State('');
    const ranked = new Computed<Ranked<Command>[]>(() =>
      rankBy(query.get(), commands, (command) => command.title)
    );
    const current = new State<string | undefined>(commands[0]?.id);
    // the best match is the one Enter runs, so an edit puts the cursor on it
    // rather than leaving it on whichever row it was on, which a list does. In
    // the field's `onChange` rather than an effect over `ranked`: an effect runs
    // with the next frame, and an Enter that arrives in the same read as the
    // typing -- a paste, or fast fingers -- would run the row the cursor was on
    // before the query changed. `ranked` is a `Computed`, so reading it here
    // works it out now
    const field = TextField({
      onChange: () => current.set(ranked.get()[0]?.item.id),
      placeholder: 'Type a command',
      value: query,
    });
    const list = ListView<Ranked<Command>, string>({
      current,
      empty: 'No command matches',
      items: ranked,
      key: (entry) => entry.item.id,
      onActivate: (id) => close(id),
      props: { class: 'palette-list', height: Math.min(10, commands.length) },
      row: (entry) => {
        const runs = highlightRuns(entry.item.title, entry.match.matched);
        return box(
          { class: 'palette-row' },
          box(
            { class: 'palette-title' },
            ...runs.map((run) =>
              text(run.text, { class: run.on ? 'sigil-accent' : '', 'white-space': 'pre' })
            )
          ),
          text(entry.item.keys === undefined ? '' : keyLabel(entry.item.keys), {
            class: 'palette-keys sigil-muted',
          })
        );
      },
    });
    const body = box({ class: 'palette' }, field, list);
    // the field keeps the focus while the cursor moves, so typing never has to
    // come back to it: Up, Down and Enter are the field's to leave alone, and the
    // body around it hears them -- the dialog hands a key to the focused element
    // and its ancestors up to its panel
    body.onKey = (event) => {
      const name = event.key.name;
      if (name === 'up' || name === 'down') {
        // moved over `ranked` rather than through the list's own selection, whose
        // rows are the ones its last frame drew -- the same reason as above
        const rows = ranked.get();
        const at = rows.findIndex((row) => row.item.id === current.get());
        const next = rows[Math.min(Math.max(at + (name === 'up' ? -1 : 1), 0), rows.length - 1)];
        if (next !== undefined) {
          current.set(next.item.id);
          listControl<string>(list)?.reveal(next.item.id);
        }
      } else if (name === 'enter') {
        const id = current.get();
        // nothing matches, or the cursor is on a row the query has since dropped
        close(ranked.get().some((row) => row.item.id === id) ? id : undefined);
      } else {
        return;
      }
      event.stop();
    };
    return { body, field };
  });

  const dialog = openModal<string>(host.app.view, {
    actions: [],
    body: built.value.body,
    input: host.input,
    title: 'Command palette',
    width: 56,
  });
  close = (id) => dialog.close(id);
  host.input.focus.focus(built.value.field);
  const id = await dialog.result;
  built.dispose();
  return commands.find((command) => command.id === id);
}
