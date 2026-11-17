/**
 * Everything the editor does, which is everything but the tree it draws: the
 * open documents and their text areas, the tabs, saving, closing, quitting, the
 * palette and the keys.
 *
 * `root.tsx` builds the screen and hands the parts a key or the focus reaches
 * back through `attach()`, which is the git client's arrangement. Here it is not
 * for a twin -- the editor is JSX alone -- but because a text area is built per
 * file, when the file is opened, and that is not a thing a template says.
 */

import { type Doc, createDoc, diskText, shownPath, tabLabels } from './documents.ts';
import { type Command, openPalette } from './palette.ts';
import { WorkspaceContext } from './workspace.ts';
import { useApp } from '@ttylabs/sigil/app';
import {
  describeTreeListView,
  directoryRoot,
  highlightCode,
  openModal,
  tabRowView,
  TextArea,
  type TreeChoice,
  treeListControl,
  unicodeSupported,
} from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter, KeyEvent } from '@ttylabs/sigil/input';
import {
  createBranch,
  createEffect,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  useContext,
} from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';
import { copyToClipboard } from '@ttylabs/sigil/terminal';

/** What the root hands back once it has built the screen. */
export interface Parts {
  /** The whole screen: `q` and Escape bubble up to it from whatever has the focus. */
  readonly root: Element;
  /** The file tree. */
  readonly tree: Element;
  /** Where the row of tabs goes: one is built whenever the labels change. */
  readonly tabs: Element;
  /** Where each document's text area goes. */
  readonly areas: Element;
  /** Shown in place of the areas while nothing is open. */
  readonly empty: Element;
  /** The pane the preview is in, hidden for a file that is not Markdown. */
  readonly preview: Element;
  /** The panels, which scope the keys the footer lists. */
  readonly panels: { readonly files: Element; readonly source: Element };
}

/** What the root reads. */
export interface Editor {
  attach(parts: Parts): void;
  readonly input: InputRouter;
  /** The documents that are open, in tab order. */
  readonly docs: State<readonly Doc[]>;
  /** Which of them is showing. */
  readonly active: State<number>;
  /** The file tree's root node: the workspace directory, open. */
  readonly files: TreeChoice<string>;
  /** Enter on a tree node: a directory opens and closes, a file opens in a tab. */
  activate(path: string, node: TreeChoice<string>): void;
  /** The Markdown the preview draws, or nothing. */
  readonly previewSource: Computed<string | undefined>;
  /** Which document the preview is of. */
  readonly previewSubject: Computed<string | undefined>;
  /** The source panel's title: the file's path, and a mark while it is unsaved. */
  readonly title: () => string;
  /** The last thing the editor said: saved, copied, refused. */
  readonly status: State<string>;
  /** The width of the file tree, which its edge drags. */
  readonly sideWidth: State<number>;
  /** The width of the preview, which its edge drags. */
  readonly previewWidth: State<number>;
}

/** What a terminal sends for Ctrl-Home: the text area's move to the start of its value. */
const CTRL_HOME = '\u001b[1;5H';

/** What closing an unsaved file asks, and its three answers. */
type CloseAnswer = 'cancel' | 'discard' | 'save';

/**
 * Builds the editor's state and keys. Called once, from the root's body, which
 * is where the app and the workspace are there to be read.
 *
 * @returns The editor.
 */
export function createEditor(): Editor {
  const app = useApp();
  // always there under `runApp()`, which refuses to call a component at all
  // without a terminal to read keys from -- typed as possibly missing for that
  const input = app.input as InputRouter;
  if (!input) {
    throw new Error('The editor needs keys: run it with runApp() on a terminal');
  }
  const workspace = useContext(WorkspaceContext);
  const unicode = unicodeSupported();
  const mark = unicode ? '●' : '*';

  const docs = new State<readonly Doc[]>([]);
  const active = new State(0);
  const status = new State('');
  const previewOn = new State(true);
  const sideWidth = new State(Math.min(36, Math.max(20, Math.round(app.terminal.width * 0.22))));
  const previewWidth = new State(Math.max(20, Math.round(app.terminal.width * 0.35)));
  /** Whether a dialog is open, so the app's keys do not open a second one under it. */
  let busy = false;

  const current = (): Doc | undefined => {
    const all = docs.get();
    return all[Math.min(Math.max(active.get(), 0), all.length - 1)];
  };

  // a dialog and a text area are built from a key, and a key handler runs with
  // no owner, so their effects would never be disposed: each is built under a
  // branch of the component's owner instead, disposed when it is done with.
  // The settings example and the git client have the same helper; SIG-335 is
  // the ticket for `openModal()` doing it
  const owner = getOwner();
  const owned = <T>(build: () => T): { dispose: () => void; value: T } => {
    const branch = runWithOwner(owner, createBranch);
    return { dispose: branch.dispose, value: runWithOwner(branch.owner, build) };
  };

  /** Each open document's text area, and how to dispose of it. */
  const areas = new Map<Doc, { readonly dispose: () => void; readonly element: Element }>();

  let parts: Parts | undefined;
  let mounted = false;

  /**
   * Paints a frame now, so the router sees what was just shown: it reads a box
   * hidden a moment ago as hidden until a frame has restyled it, so a key that
   * arrives in the same read as the one that showed an area -- a paste, fast
   * typing -- would be taken from the area. The log browser's `redraw()`, for the
   * same reason; SIG-384 is the ticket for the router reading an inline `display`.
   */
  const redraw = (): void => {
    if (mounted) {
      app.view.frame();
    }
  };

  /**
   * Shows the active document's area and hides the rest, and the preview with
   * it. The `display` prop rather than a class, because the router reads a prop
   * that hides the moment it is written and a class only once a frame has run.
   */
  const display = (): void => {
    if (parts === undefined) {
      return;
    }
    const doc = untrack(current);
    for (const [owner, area] of areas) {
      area.element.setProps({ display: owner === doc ? 'flex' : 'none' });
    }
    parts.empty.setProps({ display: doc === undefined ? 'flex' : 'none' });
    const preview = doc?.markdown === true && untrack(() => previewOn.get());
    parts.preview.setProps({ display: preview ? 'flex' : 'none' });
  };

  /** Shows the active document, and gives its area the focus -- or the tree, with none open. */
  const show = (): void => {
    if (parts === undefined) {
      return;
    }
    display();
    const doc = untrack(current);
    const area = doc === undefined ? undefined : areas.get(doc);
    input.focus.focus(area?.element ?? parts.tree);
    redraw();
  };

  /** Builds a document's text area, highlighted where the lexer reads its language. */
  const buildArea = (doc: Doc): void => {
    const built = owned(() =>
      TextArea({
        // the extension is the language: `highlightCode()` maps every name a
        // language goes by, and marks nothing in one it does not read
        highlight: highlightCode,
        lang: doc.lang,
        lineNumbers: true,
        onCopy: (copied) => {
          const sent = copyToClipboard(app.terminal, copied);
          const lines = copied.split('\n').length;
          status.set(
            sent.written
              ? `Copied ${[...copied].length} characters${lines > 1 ? ` on ${lines} lines` : ''}`
              : 'Nothing copied: the terminal did not take it'
          );
        },
        props: { class: 'area', display: 'none' },
        tab: '  ',
        value: doc.value,
      })
    );
    areas.set(doc, { dispose: built.dispose, element: built.value });
    parts?.areas.append(built.value);
  };

  /** Opens a file in a tab, or shows the tab it is already open in. */
  const open = (path: string): void => {
    const all = untrack(() => docs.get());
    const at = all.findIndex((doc) => doc.path === path);
    if (at !== -1) {
      active.set(at);
      show();
      return;
    }
    let text: string;
    try {
      text = workspace.read(path);
    } catch (err) {
      status.set(`Cannot open: ${(err as Error).message}`);
      return;
    }
    const doc = createDoc(path, text);
    buildArea(doc);
    docs.set([...all, doc]);
    active.set(all.length);
    status.set(`Opened ${shownPath(path, workspace.root)}`);
    show();
    // a text area starts with the caret at the end of its value, which is where a
    // typist is in a field and the last place to open a file at: a 50,000-line
    // file would open scrolled to its last line. The area has no handle to move
    // its caret, so the app sends it the key that does, Ctrl-Home, through the
    // router as though it had been typed -- the area has the focus, and `show()`
    // painted the frame that makes the router see it
    input.feed(CTRL_HOME);
  };

  /**
   * Writes a document to disk, if it has changed. A clean one is not written,
   * because writing is not free of consequence: a file whose line endings are
   * mixed is written with one of them, and a Ctrl-S out of habit should not be
   * what converts it.
   */
  const save = (doc: Doc | undefined = untrack(current)): boolean => {
    if (doc === undefined) {
      return false;
    }
    if (!untrack(() => doc.dirty.get())) {
      status.set(`No changes to save in ${shownPath(doc.path, workspace.root)}`);
      return true;
    }
    try {
      workspace.write(doc.path, diskText(doc));
    } catch (err) {
      status.set(`Cannot save: ${(err as Error).message}`);
      return false;
    }
    doc.saved.set(untrack(() => doc.value.get()));
    status.set(`Saved ${shownPath(doc.path, workspace.root)}`);
    return true;
  };

  const saveAll = (): void => {
    const dirty = untrack(() => docs.get()).filter((doc) => untrack(() => doc.dirty.get()));
    let saved = 0;
    for (const doc of dirty) {
      if (!save(doc)) {
        return;
      }
      saved++;
    }
    status.set(
      saved === 0 ? 'Nothing to save' : `Saved ${saved} ${saved === 1 ? 'file' : 'files'}`
    );
  };

  /** Takes a document out of its tab, and disposes of its area. */
  const drop = (doc: Doc): void => {
    const all = untrack(() => docs.get());
    const at = all.indexOf(doc);
    if (at === -1) {
      return;
    }
    const area = areas.get(doc);
    areas.delete(doc);
    area?.element.remove();
    area?.dispose();
    const now = untrack(() => active.get());
    docs.set(all.filter((other) => other !== doc));
    // the tab to the right takes its place, as an editor does, or the one to
    // the left where it was the last
    active.set(Math.max(0, Math.min(now > at ? now - 1 : now, all.length - 2)));
    show();
  };

  /** Asks what to do with an unsaved file that is being closed. */
  const askClose = async (doc: Doc): Promise<CloseAnswer> => {
    busy = true;
    try {
      const dialog = openModal<CloseAnswer>(app.view, {
        actions: [
          { label: 'Save', value: 'save' },
          { label: "Don't save", value: 'discard' },
          { label: 'Cancel', value: 'cancel' },
        ],
        body: "Your changes are lost if you don't save them.",
        input,
        title: `Save the changes to ${doc.name}?`,
        width: 56,
      });
      return (await dialog.result) ?? 'cancel';
    } finally {
      busy = false;
    }
  };

  /** Closes a tab, asking first when the file has unsaved changes. */
  const close = async (doc: Doc | undefined = untrack(current)): Promise<void> => {
    if (doc === undefined || busy) {
      return;
    }
    if (untrack(() => doc.dirty.get())) {
      const answer = await askClose(doc);
      if (answer === 'cancel' || (answer === 'save' && !save(doc))) {
        // the dialog put the focus back where it was, in the area
        return;
      }
      if (answer === 'discard') {
        status.set(`Closed ${doc.name} without saving`);
      }
    }
    drop(doc);
  };

  /** Ends the app, asking first when anything is unsaved. */
  const quit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    const dirty = untrack(() => docs.get()).filter((doc) => untrack(() => doc.dirty.get()));
    if (dirty.length > 0) {
      busy = true;
      let yes: boolean | undefined;
      try {
        const dialog = openModal<boolean>(app.view, {
          actions: [
            { label: 'Quit', value: true },
            { label: 'Cancel', value: false },
          ],
          body:
            dirty.length === 1
              ? `${dirty[0]?.name} has unsaved changes, which are lost if you quit.`
              : `${dirty.length} files have unsaved changes, which are lost if you quit.`,
          // losing work is the one answer that cannot be taken back
          initial: 1,
          input,
          title: 'Quit without saving?',
          width: 56,
        });
        yes = await dialog.result;
      } finally {
        busy = false;
      }
      if (yes !== true) {
        return;
      }
    }
    app.exit(0);
  };

  /** Moves to the next tab, or the previous one, wrapping. */
  const step = (by: number): void => {
    const count = untrack(() => docs.get()).length;
    if (count > 1) {
      active.set((((untrack(() => active.get()) + by) % count) + count) % count);
      show();
    }
  };

  const focusFiles = (): void => {
    if (parts) {
      input.focus.focus(parts.tree);
    }
  };

  const focusSource = (): void => {
    const doc = untrack(current);
    const area = doc === undefined ? undefined : areas.get(doc);
    if (area) {
      input.focus.focus(area.element);
    }
  };

  /** What the palette offers, worked out when it opens: the open tabs change. */
  const commands = (): Command[] => {
    const list: Command[] = [
      { id: 'save', keys: 'ctrl+s', run: () => void save(), title: 'Save' },
      { id: 'save-all', run: saveAll, title: 'Save all' },
      { id: 'close', keys: 'ctrl+w', run: () => void close(), title: 'Close tab' },
      { id: 'next', keys: 'ctrl+pagedown', run: () => step(1), title: 'Next tab' },
      { id: 'previous', keys: 'ctrl+pageup', run: () => step(-1), title: 'Previous tab' },
      {
        id: 'preview',
        run: () => {
          previewOn.set(!untrack(() => previewOn.get()));
          display();
        },
        title: 'Toggle Markdown preview',
      },
      { id: 'files', keys: 'escape', run: focusFiles, title: 'Focus file tree' },
      { id: 'source', run: focusSource, title: 'Focus editor' },
      {
        id: 'reload',
        run: () => {
          treeListControl<string>(parts?.tree as Element)?.reload(files.value ?? workspace.root);
          status.set('Read the file tree again');
        },
        title: 'Reload file tree',
      },
      { id: 'quit', keys: 'q', run: () => void quit(), title: 'Quit' },
    ];
    for (const doc of untrack(() => docs.get())) {
      list.push({
        id: `tab:${doc.path}`,
        run: () => open(doc.path),
        title: `Go to ${shownPath(doc.path, workspace.root)}`,
      });
    }
    return list;
  };

  const palette = async (): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    let chosen: Command | undefined;
    try {
      chosen = await openPalette({ app, input, owned }, commands());
    } finally {
      busy = false;
    }
    // after `busy` is put down, or Close and Quit -- which ask with a dialog of
    // their own, and so refuse to while one is open -- would do nothing
    chosen?.run();
  };

  const files = directoryRoot({ root: workspace.root });

  const activate = (path: string, node: TreeChoice<string>): void => {
    if (node.items !== undefined) {
      treeListControl<string>(parts?.tree as Element)?.toggle(path);
      return;
    }
    open(path);
  };

  const attach = (given: Parts): void => {
    parts = given;
    const { root, panels } = given;

    // the row of tabs is built again whenever a label changes -- a file opened or
    // closed, or a mark coming or going -- because `tabRowView()` reads its labels
    // once (the components' "Tabs", under "Not done"). The active tab is one state
    // across every row, so a row built again shows the same tab
    let row: { dispose: () => void; value: Element } | undefined;
    const labels = new Computed(() => tabLabels(docs.get(), workspace.root, mark).join('\u0000'));
    createEffect(() => {
      const joined = labels.get();
      const had = row !== undefined && untrack(() => input.focus.current.get()) === row.value;
      row?.value.remove();
      row?.dispose();
      row = undefined;
      if (joined === '') {
        return;
      }
      row = owned(() => tabRowView({ active, labels: joined.split('\u0000') }));
      given.tabs.append(row.value);
      if (had) {
        input.focus.focus(row.value);
      }
    });
    onCleanup(() => row?.dispose());

    // the tab row writes `active` with its own keys and clicks, which is the one
    // way it changes that `show()` was not called for
    createEffect(() => {
      active.get();
      display();
    });

    // q quits from anywhere that does not type it. A fallback would be outranked
    // by a focused text area just the same, but `runApp()`'s own quit fallback
    // would run beside it and quit without asking -- every fallback on a key
    // runs -- so this is an `onKey` on the root, which a key bubbles up to from
    // the tree, the tabs, the preview or a pane's edge and which stops it there
    root.onKey = (event: KeyEvent): void => {
      const k = event.key;
      if (event.paste || k.ctrl || k.meta) {
        return;
      }
      if (k.name === 'q') {
        void quit();
      } else if (k.name === 'escape') {
        focusFiles();
      } else {
        return;
      }
      event.stop();
    };

    const off: (() => void)[] = [];
    // app-wide chords are sequences: they come before the focused element, so
    // they work from inside a text area, and after a dialog's own binding, so
    // they are quiet while one is open
    const chord = (keys: string, fn: () => void, description: string, priority: number): void => {
      off.push(input.bind(keys, () => fn(), { description, priority }));
    };
    chord('ctrl+s', () => void save(), 'save', 6);
    chord('ctrl+w', () => void close(), 'close', 5);
    chord('ctrl+p', () => void palette(), 'commands', 7);
    chord('ctrl+pagedown', () => step(1), 'next tab', 1);
    chord('ctrl+pageup', () => step(-1), 'previous tab', 1);
    off.push(
      input.describe('enter', { description: 'open', priority: 4, scope: panels.files }),
      input.describe('escape', { description: 'files', priority: 3, scope: panels.source }),
      input.describe('shift+tab', { description: 'leave', priority: 2, scope: panels.source }),
      describeTreeListView(input, given.tree)
    );
    onCleanup(() => {
      for (const fn of off) {
        fn();
      }
      for (const area of areas.values()) {
        area.dispose();
      }
    });

    onMount(() => {
      mounted = true;
      input.focus.focus(given.tree);
    });
  };

  const previewSource = new Computed(() => {
    const doc = current();
    return doc?.markdown === true && previewOn.get() ? doc.value.get() : undefined;
  });
  const previewSubject = new Computed(() => current()?.path);

  const title = (): string => {
    const doc = current();
    if (doc === undefined) {
      return 'Editor';
    }
    const shown = shownPath(doc.path, workspace.root);
    return doc.dirty.get() ? `${shown} ${mark}` : shown;
  };

  return {
    activate,
    active,
    attach,
    docs,
    files,
    input,
    previewSource,
    previewSubject,
    previewWidth,
    sideWidth,
    status,
    title,
  };
}
