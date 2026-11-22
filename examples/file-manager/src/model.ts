/**
 * Everything the file manager does, which is everything but the tree it draws.
 *
 * The two root components, `root.tsx` and `root.ui.ts`, each build the same
 * screen in their own syntax and hand the parts that keys reach back here through
 * `attach()`. So the states, the reads, the keys and the dialogs are written once,
 * in a module neither root is -- `root.ui.ts` runs unbuilt, and a `.tsx` anywhere
 * in its imports is a module Node cannot load. See "What the twins share" in
 * `examples/AGENTS.md`.
 */

import {
  type Entry,
  type Files,
  FilesContext,
  formatSize,
  isHidden,
  planPaste,
  planRename,
  sortEntries,
  visibleEntries,
} from './files.ts';
import { cannotRead, type PreviewFor, readPreview } from './preview.ts';
import { useApp } from '@ttylabs/sigil/app';
import {
  confirmModal,
  describeListView,
  type NoteVariant,
  openModal,
  showToast,
  TextField,
} from '@ttylabs/sigil/components';
import { type Element, printable } from '@ttylabs/sigil/element';
import type { InputRouter, KeyEvent } from '@ttylabs/sigil/input';
import { createEffect, onCleanup, onMount, useContext } from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';
import { basename, dirname } from 'node:path';

/** What the roots hand back once they have built the screen. */
export interface Parts {
  /** The list of the directory the manager is in, which has the focus. */
  readonly current: Element;
  /** The line the filter is typed on, hidden while it is closed. */
  readonly filterBar: Element;
  /** The filter's text field. */
  readonly filterField: Element;
  readonly panels: {
    readonly current: Element;
    readonly parent: Element;
    readonly preview: Element;
  };
  /** The preview's scroll box, which takes the focus to be scrolled. */
  readonly preview: Element;
}

/** What `y` and `x` hold until `p` pastes it. */
export interface Clip {
  readonly entry: Entry;
  readonly mode: 'copy' | 'move';
}

/** A column of names: the rows, and the name the cursor is on. */
export interface Column {
  readonly cursor: State<string | undefined>;
  readonly items: Computed<readonly Entry[]>;
}

/** The model, as the roots read it. */
export interface Model {
  /** Hands the model the parts of the screen its keys and focus reach. */
  attach(parts: Parts): void;
  /** What `y` or `x` is holding. */
  readonly clip: State<Clip | undefined>;
  /** The directory the manager is in. */
  readonly current: Column & {
    /** What the column says while it has no rows. */
    readonly empty: () => string;
    /** Enter on a row: into a directory, or to the preview of a file. */
    readonly open: (name: string) => void;
  };
  /** The filter's field: its text, and what an edit and Enter do. */
  readonly filter: {
    readonly change: (value: string) => void;
    readonly draft: State<string>;
    readonly submit: () => void;
  };
  /** The right of the header: where the cursor is, and what is narrowing the column. */
  readonly flags: () => string;
  /** The router, which the footer reads. */
  readonly input: InputRouter;
  /** The directory above, with the one the manager is in under its cursor. */
  readonly parent: Column;
  /** The directory the manager is in, whole, for the header. */
  readonly path: () => string;
  /** What the preview column shows. */
  readonly preview: State<PreviewFor>;
  /** A row's size label: a file's size, nothing for anything else. */
  readonly sizeOf: (entry: Entry) => string;
  /** The line at the left of the footer: what just happened. */
  readonly status: () => string;
  /** Each column's title. */
  readonly titles: {
    readonly current: () => string;
    readonly parent: () => string;
    readonly preview: () => string;
  };
}

/**
 * A change the manager declined to make, which is said as a warning rather than
 * as an error: nothing failed, the name was taken.
 */
class Refused extends Error {}

const NOTHING: PreviewFor = { about: '', path: '', preview: { kind: 'note', note: '' } };

/**
 * Builds the manager's state, reads and keys. Called once, from a root's body,
 * which is where the app and the context are there to be read.
 *
 * @returns The model.
 */
export function createModel(): Model {
  const app = useApp();
  // always there under `runApp()`, which refuses to call a component at all
  // without a terminal to read keys from -- typed as possibly missing for that
  const input = app.input as InputRouter;
  if (!input) {
    throw new Error('The file manager needs keys: run it with runApp() on a terminal');
  }
  const files: Files = useContext(FilesContext);

  // -- state ------------------------------------------------------------------
  const dir = new State('');
  const listing = new State<readonly Entry[]>([]);
  const cursor = new State<string | undefined>(undefined);
  const parentListing = new State<readonly Entry[]>([]);
  const parentCursor = new State<string | undefined>(undefined);
  const hidden = new State(false);
  const filter = new State('');
  const draft = new State('');
  const loaded = new State(false);
  const status = new State('');
  /** Why the directory the manager was started in could not be opened. */
  const problem = new State('');
  const clip = new State<Clip | undefined>(undefined);
  const preview = new State<PreviewFor>({
    ...NOTHING,
    preview: { kind: 'note', note: 'Loading...' },
  });

  const shown = new Computed<readonly Entry[]>(() =>
    visibleEntries(listing.get(), { filter: filter.get(), hidden: hidden.get() })
  );
  // the directory the manager is in stays in the parent column even when it is
  // a dot directory and those are not shown: it is where the manager is
  const parentShown = new Computed<readonly Entry[]>(() => {
    const here = parentCursor.get();
    const all = hidden.get();
    return parentListing
      .get()
      .filter((entry) => all || entry.name === here || !isHidden(entry.name));
  });

  /** Where the cursor was in each directory left, so that coming back puts it there again. */
  const remembered = new Map<string, string>();

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // -- what the app says ------------------------------------------------------
  const toast = (message: string, variant: NoteVariant = 'success'): void => {
    if (!disposed) {
      showToast(app.view, { message: printable(message), variant, width: 44 });
    }
  };

  // -- the parts the keys reach -----------------------------------------------
  let parts: Parts | undefined;
  let mounted = false;
  onMount(() => {
    mounted = true;
  });

  /**
   * Draws a frame now, after something was shown and given the focus.
   *
   * The router asks whether the focused element is displayed before it routes a
   * key, and reads that off the style the last frame resolved: a bar shown a
   * moment ago is still hidden to it until a frame has restyled it, and the focus
   * put in its field is taken back at the next key. The log browser measured it
   * with a command typed fast; SIG-384 is the ticket for the router reading a
   * shown inline `display` as current.
   */
  const redraw = (): void => {
    if (mounted && !disposed) {
      app.view.frame();
    }
  };

  const focusList = (): void => {
    if (parts) {
      input.focus.focus(parts.current);
    }
  };

  // -- moving about -----------------------------------------------------------
  /** Which `openDir()` is the latest, so an earlier one that answers late is dropped. */
  let opening = 0;

  /**
   * Shows a directory: reads it and the one above it, then puts the cursor on
   * `select`, or where it was the last time the manager was here, or on the first
   * row.
   *
   * @returns Whether it was read; when it was not, why, and nothing changed.
   */
  const openDir = async (to: string, select?: string): Promise<unknown> => {
    const token = ++opening;
    let next: Entry[];
    try {
      next = sortEntries(await files.list(to));
    } catch (err) {
      // a read overtaken by a newer one is dropped whether it failed or not: its
      // error is about a directory the manager is no longer going to
      return token === opening ? err : undefined;
    }
    const up = dirname(to);
    let above: Entry[] = [];
    if (up !== to) {
      // the directory above being unreadable leaves its column empty, and the
      // one the manager is in still works
      above = sortEntries(await files.list(up).catch(() => []));
    }
    if (token !== opening || disposed) {
      return undefined;
    }

    const from = untrack(() => dir.get());
    if (from !== to) {
      const at = untrack(() => cursor.get());
      if (from !== '' && at !== undefined) {
        remembered.set(from, at);
      }
      // a filter is about the directory it was typed in
      filter.set('');
      draft.set('');
      closeFilter(false);
    }
    const first = visibleEntries(next, {
      filter: untrack(() => filter.get()),
      hidden: untrack(() => hidden.get()),
    })[0]?.name;
    const want =
      select ?? (from === to ? untrack(() => cursor.get()) : remembered.get(to)) ?? first;
    // the cursor before the rows, so the list finds it there when they arrive
    cursor.set(want);
    dir.set(to);
    problem.set('');
    listing.set(next);
    parentCursor.set(up === to ? undefined : basename(to));
    parentListing.set(above);
    loaded.set(true);
    return undefined;
  };

  /** Opens a directory, saying why when it cannot be. */
  const go = async (to: string, select?: string): Promise<void> => {
    const err = await openDir(to, select);
    if (err !== undefined) {
      toast(`${basename(to) || to}: ${cannotRead(err)}`, 'error');
    }
  };

  const currentEntry = (): Entry | undefined => {
    const at = cursor.get();
    return shown.get().find((entry) => entry.name === at);
  };

  const up = (): void => {
    const here = dir.get();
    const above = dirname(here);
    if (above !== here) {
      void go(above, basename(here));
    }
  };

  const into = (entry: Entry | undefined): void => {
    if (!entry) {
      return;
    }
    if (entry.kind === 'directory') {
      void go(entry.path);
    } else if (parts) {
      // a file has nowhere to go but its preview, which then takes the arrows
      input.focus.focus(parts.preview);
    }
  };

  const reload = (): Promise<void> => go(dir.get());

  // -- the preview ------------------------------------------------------------
  // holding `j` down asks for a preview per row; one read at a time, and a read
  // that was overtaken is read again for wherever the cursor is when it ends
  let reading = false;
  let again = false;
  const previewWanted = (): void => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    void (async () => {
      do {
        again = false;
        const entry = untrack(currentEntry);
        const next = entry
          ? await readPreview(files, entry, { hidden: untrack(() => hidden.get()) })
          : NOTHING;
        if (!disposed && !again) {
          preview.set(next);
        }
      } while (again && !disposed);
      reading = false;
    })();
  };

  // -- changing things --------------------------------------------------------
  // one change at a time: a second paste while the first is copying would plan
  // against a directory the first has not finished writing
  let chain: Promise<unknown> = Promise.resolve();
  /**
   * Runs a change, then reads the directory again whatever happened, with the
   * cursor on `select`, and says how it went.
   */
  const act = (task: () => Promise<string>, select?: () => string | undefined): Promise<void> => {
    const next = chain.then(async () => {
      if (disposed) {
        return;
      }
      try {
        toast(await task());
      } catch (err) {
        toast((err as Error).message, err instanceof Refused ? 'warning' : 'error');
      }
      await go(
        untrack(() => dir.get()),
        select?.()
      );
    });
    chain = next.catch(() => {});
    return next;
  };

  const yank = (mode: Clip['mode']): void => {
    const entry = currentEntry();
    if (!entry) {
      return;
    }
    clip.set({ entry, mode });
    status.set(`${mode === 'copy' ? 'Copying' : 'Moving'} ${printable(entry.name)}: p pastes it`);
  };

  const paste = async (): Promise<void> => {
    const held = clip.get();
    if (!held) {
      toast('Nothing to paste: y copies a file and x cuts one', 'warning');
      return;
    }
    const here = dir.get();
    const plan = await planPaste(files, held.mode, held.entry, here);
    if (!plan.ok) {
      toast(plan.reason, 'warning');
      return;
    }
    const name = held.entry.name;
    const as = basename(plan.to);
    const copying = held.mode === 'copy';
    // a copy or a move takes nothing away that another key cannot give back, so
    // its confirm starts on yes; a delete's starts on no, and a trash's on yes
    const yes = await confirmModal(app.view, {
      initial: 'yes',
      input,
      message: printable(
        `${copying ? 'Copy' : 'Move'} ${name} into ${here}${as === name ? '' : ` as ${as}`}?`
      ),
      title: copying ? 'Copy' : 'Move',
      yes: copying ? 'Copy' : 'Move',
    });
    if (!yes) {
      return;
    }
    await act(
      async () => {
        if (copying) {
          await files.copy(held.entry.path, plan.to);
          return `Copied ${name}${as === name ? '' : ` as ${as}`}`;
        }
        // asked again at the last moment, because `rename()` writes over a file
        // on POSIX, and the confirm was time for one to appear
        if (await files.taken(plan.to)) {
          throw new Refused(`${name} is already taken here`);
        }
        await files.move(held.entry.path, plan.to);
        clip.set(undefined);
        status.set('');
        return `Moved ${name}`;
      },
      () => as
    );
  };

  /** Asks for a line in a dialog, and settles with it or with nothing for a cancel. */
  const ask = async (
    title: string,
    initial: string,
    action: string
  ): Promise<string | undefined> => {
    const value = new State(initial);
    let field: Element | undefined;
    const dialog = openModal<boolean>(app.view, {
      actions: [
        { label: action, value: true },
        { label: 'Cancel', value: false },
      ],
      body: () => {
        field = TextField({ onSubmit: () => dialog.close(true), value });
        return field;
      },
      input,
      title,
      width: 52,
    });
    // `initial` names a button, so the field is focused once the dialog is open:
    // SIG-337 is the ticket for a dialog that opens on a field in its body
    input.focus.focus(field);
    const answer = await dialog.result;
    return answer ? value.get() : undefined;
  };

  const renameEntry = async (): Promise<void> => {
    const entry = currentEntry();
    if (!entry) {
      return;
    }
    const name = await ask(`Rename ${printable(entry.name)}`, entry.name, 'Rename');
    if (name === undefined || name === entry.name) {
      return;
    }
    let renamed = false;
    await act(
      async () => {
        // planned inside the chain rather than before it: a change still running
        // ahead of this one -- a copy onto the same name -- or another program can
        // take the name in between, and `rename()` would replace what it made
        const plan = await planRename(files, entry.path, name);
        if (!plan.ok) {
          throw new Refused(plan.reason);
        }
        await files.move(entry.path, plan.to);
        renamed = true;
        if (untrack(() => clip.get())?.entry.path === entry.path) {
          clip.set(undefined);
          status.set('');
        }
        return `Renamed ${entry.name} to ${name}`;
      },
      () => (renamed ? name : entry.name)
    );
  };

  /** Deletes the entry for good, or moves it to the trash: `d` and `t`. */
  const deleteEntry = async (how: 'delete' | 'trash'): Promise<void> => {
    const entry = currentEntry();
    if (!entry) {
      return;
    }
    const tree = entry.kind === 'directory' && !entry.link;
    const what = tree ? `the directory ${entry.name} and everything in it` : entry.name;
    const trashing = how === 'trash';
    const yes = await confirmModal(app.view, {
      initial: trashing ? 'yes' : 'no',
      input,
      message: printable(
        trashing
          ? `Move ${what} to the trash? It can be taken back from there.`
          : `Delete ${what}? It does not go to the trash: this cannot be undone.`
      ),
      title: trashing ? 'Trash' : 'Delete',
      yes: trashing ? 'Trash' : 'Delete',
    });
    if (!yes) {
      return;
    }
    // the cursor goes to the row after, or before when it was the last one
    const rows = shown.get();
    // by name: a change that finished while the confirm was open has replaced
    // every entry with a new object
    const at = rows.findIndex((row) => row.name === entry.name);
    const neighbour = (rows[at + 1] ?? rows[at - 1])?.name;
    let gone = false;
    await act(
      async () => {
        if (trashing) {
          // `trash()` puts the whole path in its message and the reason alone in
          // its `cause`, which is what fits beside the name
          await files.trash(entry.path).catch((err: Error) => {
            const why = err.cause instanceof Error ? err.cause.message : err.message;
            throw new Error(`Could not move ${entry.name} to the trash: ${why}`);
          });
        } else {
          await files.remove(entry.path);
        }
        gone = true;
        if (untrack(() => clip.get())?.entry.path === entry.path) {
          clip.set(undefined);
          status.set('');
        }
        return trashing ? `Moved ${entry.name} to the trash` : `Deleted ${entry.name}`;
      },
      // a trash that was refused left the entry where it was, and the cursor on it
      () => (gone ? neighbour : entry.name)
    );
  };

  const toggleHidden = (): void => {
    const on = !hidden.get();
    hidden.set(on);
    status.set(on ? 'Hidden files: shown' : 'Hidden files: not shown');
  };

  // -- the filter -------------------------------------------------------------
  const openFilter = (): void => {
    if (!parts) {
      return;
    }
    draft.set(filter.get());
    parts.filterBar.setProps({ display: 'flex' });
    input.focus.focus(parts.filterField);
    redraw();
  };

  function closeFilter(focus = true): void {
    if (!parts) {
      return;
    }
    parts.filterBar.setProps({ display: 'none' });
    if (focus) {
      focusList();
      redraw();
    }
  }

  // -- keys -------------------------------------------------------------------
  const keys: Record<'current' | 'filter' | 'preview', (event: KeyEvent) => void> = {
    current: (event) => {
      const name = event.key.name;
      if (event.key.ctrl || event.key.meta) {
        return;
      }
      if (name === 'h' || name === 'left' || name === 'backspace') {
        up();
      } else if (name === 'l' || name === 'right') {
        into(currentEntry());
      } else if (name === 'y') {
        yank('copy');
      } else if (name === 'x') {
        yank('move');
      } else if (name === 'p') {
        void paste();
      } else if (name === 'r') {
        void renameEntry();
      } else if (name === 'd' || name === 'delete') {
        void deleteEntry('delete');
      } else if (name === 't') {
        void deleteEntry('trash');
      } else {
        return;
      }
      event.stop();
    },
    filter: (event) => {
      if (event.key.name === 'escape') {
        event.stop();
        filter.set('');
        draft.set('');
        closeFilter();
      }
    },
    preview: (event) => {
      const name = event.key.name;
      if (name === 'h' || name === 'left' || name === 'escape') {
        event.stop();
        focusList();
      }
    },
  };

  const attach = (given: Parts): void => {
    parts = given;
    const { panels } = given;
    given.filterBar.setProps({ display: 'none' });
    // each panel's own keys, which reach it from whatever inside it has the focus
    panels.current.onKey = keys.current;
    panels.preview.onKey = keys.preview;
    given.filterBar.onKey = keys.filter;

    // the footer follows the focus: each panel's keys are described with the
    // panel as the scope, so they are listed while the focus is inside it
    const off: (() => void)[] = [describeListView(input, given.current)];
    const say = (scope: Element, spec: string, description: string, priority = 3): void => {
      off.push(input.describe(spec, { description, priority, scope }));
    };
    say(panels.current, 'l', 'open');
    say(panels.current, 'h', 'up');
    say(panels.current, 'y', 'copy', 2);
    say(panels.current, 'x', 'cut', 2);
    say(panels.current, 'p', 'paste', 2);
    say(panels.current, 'r', 'rename', 2);
    say(panels.current, 'd', 'delete', 2);
    say(panels.current, 't', 'trash', 2);
    say(panels.preview, 'h', 'back');
    say(given.filterBar, 'enter', 'keep');
    say(given.filterBar, 'escape', 'clear');

    // the app's own keys are fallbacks: they come after the focused element, so
    // a letter typed into the filter or a dialog's field is a letter, and they run
    // with nothing focused. `q` is not here: `runApp()` binds it the same way
    const key = (spec: string, fn: () => void, description: string, priority = 1): void => {
      off.push(input.fallback(spec, fn, { description, priority }));
    };
    key('/', openFilter, 'filter', 2);
    key('.', toggleHidden, 'hidden');
    key('R', () => void reload(), 'reload', 0);
    onCleanup(() => {
      for (const fn of off) {
        fn();
      }
    });

    // the preview follows the cursor, and the rows and the hidden toggle under it
    createEffect(() => {
      shown.get();
      cursor.get();
      hidden.get();
      previewWanted();
    });

    onMount(focusList);
  };

  void (async () => {
    // the start as the directory above spells it: `./readme.md` on a file system
    // that ignores case is `README.md`, and a cursor or a parent column put on
    // the typed spelling finds no row. Only the last name is respelled
    const above = dirname(files.start);
    const typed = basename(files.start);
    const beside = above === files.start ? [] : await files.list(above).catch(() => []);
    let found = beside.find((entry) => entry.name === typed);
    for (const entry of beside) {
      if (
        !found &&
        entry.name.toLowerCase() === typed.toLowerCase() &&
        (await files.same(entry.path, files.start))
      ) {
        found = entry;
      }
    }
    const start = found ? found.path : files.start;
    const err = await openDir(start);
    if (err === undefined) {
      return;
    }
    // a file named on the command line opens its directory with the file
    // selected. Asked of the directory's listing rather than read off the
    // error's code, which for a directory read of a file is not the same on
    // every platform
    if (found && found.kind !== 'directory') {
      if ((await openDir(above, found.name)) === undefined) {
        return;
      }
    }
    toast(`${files.start}: ${cannotRead(err)}`, 'error');
    problem.set(cannotRead(err));
    loaded.set(true);
  })();

  // -- what the roots read ----------------------------------------------------
  const name = (path: string): string => printable(basename(path) || path);

  return {
    attach,
    clip,
    current: {
      cursor,
      empty: () => {
        if (!loaded.get()) {
          return 'Loading...';
        }
        if (problem.get() !== '') {
          return problem.get();
        }
        if (filter.get() !== '') {
          return `Nothing here matches "${printable(filter.get())}"`;
        }
        return listing.get().length ? 'Only hidden files: . shows them' : 'An empty directory';
      },
      items: shown,
      open: () => into(currentEntry()),
    },
    filter: {
      change: (value) => {
        filter.set(value);
      },
      draft,
      submit: () => {
        closeFilter();
      },
    },
    flags: () => {
      const rows = shown.get();
      const at = rows.findIndex((entry) => entry.name === cursor.get());
      const parts = [rows.length ? `${at + 1}/${rows.length}` : '0/0'];
      if (filter.get() !== '') {
        parts.push(`filter "${printable(filter.get())}"`);
      }
      if (hidden.get()) {
        parts.push('hidden');
      }
      return parts.join(' · ');
    },
    input,
    parent: { cursor: parentCursor, items: parentShown },
    path: () => printable(dir.get()),
    preview,
    sizeOf: (entry) => (entry.kind === 'file' ? formatSize(entry.size) : ''),
    status: () => status.get(),
    titles: {
      current: () => (dir.get() === '' ? '' : name(dir.get())),
      parent: () => {
        const here = dir.get();
        const above = dirname(here);
        return here === '' || above === here ? '' : name(above);
      },
      preview: () => {
        const what = preview.get();
        if (what.path === '') {
          return 'Preview';
        }
        return what.about === '' ? name(what.path) : `${name(what.path)} · ${what.about}`;
      },
    },
  };
}
