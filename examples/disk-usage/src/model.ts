/**
 * Everything the visualizer does, which is everything but the tree it draws: the
 * scan, the selection both panes follow, the map's root, the keys and the delete.
 *
 * `root.tsx` builds the screen and hands the parts a key reaches back through
 * `attach()`, the arrangement every example with a model has. Here it is not for a
 * twin -- the visualizer is JSX alone -- but so that the model can be read without
 * a screen: what the panes show is a handful of signals over one immutable tree.
 */

import { DiskContext, formatCount, formatSize, isInside, printable } from './disk.ts';
import {
  chainTo,
  type DiskNode,
  findNode,
  type Progress,
  removePath,
  type Scan,
  scanDisk,
  shownPath,
  startProgress,
} from './scan.ts';
import { useApp } from '@ttylabs/sigil/app';
import {
  confirmModal,
  describeTreeListView,
  type NoteVariant,
  showToast,
  type TreeChoice,
  treeListControl,
} from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter, KeyEvent } from '@ttylabs/sigil/input';
import { createEffect, onCleanup, onMount, useContext } from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';
import { basename, dirname } from 'node:path';

/** What the root hands back once it has built the screen. */
export interface Parts {
  /** The panel the tree is in, which scopes the keys the footer lists for it. */
  readonly panel: Element;
  /** The tree list view. */
  readonly tree: Element;
}

/** The model, as the root reads it. */
export interface Model {
  /** Hands the model the parts of the screen its keys reach. */
  attach(parts: Parts): void;
  /** The tree's cursor: the selected path, which the map outlines. */
  readonly current: State<string | undefined>;
  /** The tree's open branches. */
  readonly expanded: State<ReadonlySet<string>>;
  /** The directory scanned, for the top line. */
  readonly path: string;
  /** The right of the top line: the total, and how far a scan that is running has got. */
  readonly totals: () => string;
  /** The line under the panes: what the selection is. */
  readonly info: () => string;
  /** The router, which the footer reads. */
  readonly input: InputRouter;
  /** The tree, as the tree list view reads it: the root node, or nothing before the first scan. */
  readonly items: Computed<TreeChoice<string> | readonly TreeChoice<string>[]>;
  /** What the map says where there is no map. */
  readonly mapMessage: () => string;
  /** What the map draws. */
  readonly mapRoot: Computed<DiskNode | undefined>;
  /** The map's title: which directory it shows. */
  readonly mapTitle: () => string;
  /** Enter or a double click on a row: map that directory, or the one that file is in. */
  mapIt(path: string): void;
  /** The node a tree row stands for. */
  nodeOf(choice: TreeChoice<string>): DiskNode | undefined;
  /** A click on the map: select what was clicked, and open the tree down to it. */
  pick(path: string): void;
  /** The scan the panes show. */
  readonly scan: State<Scan | undefined>;
  /** What just happened, at the left of the footer. */
  readonly status: State<string>;
}

/** How often a running scan's counts reach the screen. */
const PROGRESS_MS = 100;

/**
 * Builds the visualizer's state and keys, and starts the first scan. Called once,
 * from the root's body, where the app and the context are there to be read.
 *
 * @returns The model.
 */
export function createModel(): Model {
  const app = useApp();
  // always there under `runApp()`, which refuses to call a component at all
  // without a terminal to read keys from -- typed as possibly missing for that
  const input = app.input as InputRouter;
  if (!input) {
    throw new Error('The disk usage visualizer needs keys: run it with runApp() on a terminal');
  }
  const disk = useContext(DiskContext);

  // -- state ------------------------------------------------------------------
  const scan = new State<Scan | undefined>(undefined);
  /** The running scan's counts, copied out of it on a timer, or `undefined` with none running. */
  const progress = new State<Progress | undefined>(undefined);
  /** Why the last scan failed, when it failed outright. */
  const failed = new State('');
  const current = new State<string | undefined>(undefined);
  const expanded = new State<ReadonlySet<string>>(new Set());
  /** The directory the map shows, by path; the scan's root while it is unset. */
  const zoom = new State<string | undefined>(undefined);
  const status = new State('');

  let parts: Parts | undefined;
  let disposed = false;
  let running: AbortController | undefined;
  /**
   * Set from the moment a delete asks until the disk has answered: a second `d`
   * opens no second confirm, and `r` scans nothing, while a delete is on its way.
   * A scan started under an `rm` would read half of what it removes and put it
   * back on screen when it ends.
   */
  let deleting = false;
  onCleanup(() => {
    disposed = true;
    running?.abort();
  });

  const toast = (message: string, variant: NoteVariant = 'error'): void => {
    if (!disposed) {
      showToast(app.view, { message: printable(message), variant, width: 48 });
    }
  };

  // -- the tree, as the tree list view reads it -------------------------------
  // a node's choice is made once per node, and a node is never changed -- a
  // delete makes new ones above it and leaves the rest -- so the list keeps every
  // row it drew for a subtree the delete did not touch
  const choices = new WeakMap<DiskNode, TreeChoice<string>>();
  const nodes = new WeakMap<TreeChoice<string>, DiskNode>();
  const choiceOf = (node: DiskNode): TreeChoice<string> => {
    let choice = choices.get(node);
    if (choice === undefined) {
      if (node.children === undefined) {
        choice = { text: printable(node.name), value: node.path };
      } else {
        // the children are made into choices only when something reads them,
        // which the tree does for a branch it shows: a tree of a few hundred
        // thousand names costs what is open rather than what is there
        let made: readonly TreeChoice<string>[] | undefined;
        const children = node.children;
        choice = {
          get items(): readonly TreeChoice<string>[] {
            made ??= children.map(choiceOf);
            return made;
          },
          text: printable(node.name),
          value: node.path,
        };
      }
      choices.set(node, choice);
      nodes.set(choice, node);
    }
    return choice;
  };

  const items = new Computed<TreeChoice<string> | readonly TreeChoice<string>[]>(() => {
    const found = scan.get();
    return found === undefined ? [] : choiceOf(found.root);
  });

  const mapRoot = new Computed<DiskNode | undefined>(() => {
    const found = scan.get();
    if (found === undefined) {
      return undefined;
    }
    const path = zoom.get();
    return (path === undefined ? undefined : findNode(found.root, path)) ?? found.root;
  });

  // the map follows the selection out: a node outside the directory it shows
  // takes it up to the nearest directory both are in, so what is selected is
  // always on the map
  createEffect(() => {
    const path = current.get();
    const top = mapRoot.get();
    if (path === undefined || top === undefined || isInside(path, top.path)) {
      return;
    }
    let up = top.path;
    while (!isInside(path, up)) {
      const next = dirname(up);
      if (next === up) {
        break;
      }
      up = next;
    }
    untrack(() => zoom.set(up));
  });

  // -- scanning -----------------------------------------------------------------
  /**
   * Scans the root, throwing away a scan still running. `again` is whether
   * somebody asked, which is what the status says once it ends -- "Rescanned"
   * for `r` even when the first scan had not finished, since that is the key
   * that was pressed.
   */
  const rescan = async (again: boolean): Promise<void> => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    const counts = startProgress();
    const started = performance.now();
    progress.set({ ...counts });
    failed.set('');
    status.set(again ? 'Rescanning...' : 'Scanning...');
    // the scan writes its counts into one object as it goes, and the screen is
    // told about them a few times a second rather than once per file
    const timer = setInterval(() => {
      progress.set({ ...counts });
    }, PROGRESS_MS);
    // stopped the moment the scan is thrown away, rather than once its walk next
    // looks at the signal: until then it would go on writing its own counts over
    // the scan that replaced it
    controller.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    try {
      const found = await scanDisk(disk, { progress: counts, signal: controller.signal });
      if (controller.signal.aborted || disposed) {
        return;
      }
      scan.set(found);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      status.set(
        `${again ? 'Rescanned' : 'Scanned'} ${formatCount(found.root.files)} files in ${seconds} s` +
          (found.errors > 0 ? `, ${formatCount(found.errors)} unreadable` : '')
      );
      // the selection and the open branches stay where they were if those are
      // still there, and go to the root otherwise
      const at = untrack(() => current.get());
      if (at === undefined || findNode(found.root, at) === undefined) {
        current.set(found.root.path);
      }
      const open = untrack(() => expanded.get());
      expanded.set(
        new Set([
          found.root.path,
          ...[...open].filter((p) => findNode(found.root, p) !== undefined),
        ])
      );
    } catch (err) {
      if (controller.signal.aborted || disposed) {
        return;
      }
      const message = `Could not scan ${disk.root}: ${err instanceof Error ? err.message : String(err)}`;
      failed.set(message);
      status.set('Scan failed');
      // the map says why only where there is no tree to draw; over the last
      // scan's tree, which stays, it is said here
      if (untrack(() => scan.get()) !== undefined) {
        toast(message);
      }
    } finally {
      clearInterval(timer);
      if (running === controller) {
        running = undefined;
        progress.set(undefined);
      }
    }
  };

  // -- what the screen says ---------------------------------------------------
  const totals = (): string => {
    const found = scan.get();
    const counts = progress.get();
    const parts: string[] = [];
    if (counts !== undefined) {
      parts.push(`scanning ${formatCount(counts.files)} files, ${formatSize(counts.bytes)}`);
    }
    if (found !== undefined) {
      parts.push(`${formatSize(found.root.bytes)} in ${formatCount(found.root.files)} files`);
    }
    return parts.join(' · ');
  };

  const mapMessage = (): string => {
    const why = failed.get();
    if (why !== '') {
      return printable(why);
    }
    const counts = progress.get();
    if (counts !== undefined) {
      return [
        'Scanning...',
        `${formatCount(counts.files)} files, ${formatSize(counts.bytes)}`,
        printable(counts.where),
      ].join('\n');
    }
    const found = scan.get();
    if (found === undefined) {
      return '';
    }
    // a directory that could not be listed is not an empty one, whether it is
    // the root or one Enter mapped
    return printable(mapRoot.get()?.note ?? 'Nothing here takes any space');
  };

  const mapTitle = (): string => {
    const found = scan.get();
    const top = mapRoot.get();
    if (found === undefined || top === undefined) {
      return 'Map';
    }
    return `Map: ${printable(shownPath(found.root, top.path))}`;
  };

  const info = (): string => {
    const found = scan.get();
    const path = current.get();
    const node = found === undefined || path === undefined ? undefined : findNode(found.root, path);
    if (found === undefined || node === undefined) {
      return '';
    }
    const share =
      found.root.bytes > 0 ? ` · ${((node.bytes / found.root.bytes) * 100).toFixed(1)}%` : '';
    const what =
      node.kind === 'directory'
        ? ` · ${formatCount(node.files)} files`
        : node.kind === 'link'
          ? ' · a link, not followed'
          : node.kind === 'other'
            ? ' · not a file'
            : '';
    const linked =
      node.link === undefined
        ? ''
        : node.bytes === 0
          ? ` · a hard link, counted at ${printable(shownPath(found.root, found.links.get(node.link)?.[0] ?? ''))}`
          : ' · a hard link, counted here once';
    const note = node.note === undefined ? '' : ` · ${node.note}`;
    return `${printable(shownPath(found.root, node.path))} · ${formatSize(node.bytes)}${share}${what}${linked}${note}`;
  };

  // -- actions ----------------------------------------------------------------
  const nodeAt = (path: string | undefined): DiskNode | undefined => {
    const found = untrack(() => scan.get());
    return found === undefined || path === undefined ? undefined : findNode(found.root, path);
  };

  /**
   * Enter or a double click, as the tree's `onActivate`: the map shows the directory
   * activated, or the one a file activated is in.
   */
  const zoomIn = (path: string): void => {
    const node = nodeAt(path);
    if (node === undefined) {
      return;
    }
    const dir = node.children === undefined ? dirname(node.path) : node.path;
    zoom.set(dir);
    status.set(`Map: ${printable(basename(dir) || dir)}`);
  };

  const zoomOut = (): void => {
    const found = untrack(() => scan.get());
    const top = untrack(() => mapRoot.get());
    if (found === undefined || top === undefined || top === found.root) {
      return;
    }
    zoom.set(dirname(top.path));
  };

  const pick = (path: string): void => {
    const found = untrack(() => scan.get());
    if (found === undefined) {
      return;
    }
    // every directory on the way down is opened, so the row is there to be on
    const chain = chainTo(found.root, path).slice(0, -1);
    const open = new Set(untrack(() => expanded.get()));
    for (const node of chain) {
      open.add(node.path);
    }
    expanded.set(open);
    current.set(path);
    if (parts) {
      input.focus.focus(parts.tree);
    }
  };

  const deleteSelected = async (): Promise<void> => {
    const found = untrack(() => scan.get());
    const path = untrack(() => current.get());
    const node = nodeAt(path);
    if (found === undefined || node === undefined || deleting) {
      return;
    }
    if (untrack(() => progress.get()) !== undefined) {
      status.set('Wait for the scan to finish before deleting');
      return;
    }
    if (node === found.root) {
      status.set('The root is not deleted from here');
      return;
    }
    const whole =
      node.kind === 'directory'
        ? `the directory ${node.name} and everything in it (${formatSize(node.bytes)}, ${formatCount(node.files)} files)`
        : `${node.name} (${formatSize(node.bytes)})`;
    deleting = true;
    let failure: unknown;
    try {
      const yes = await confirmModal(app.view, {
        initial: 'no',
        input,
        message: printable(`Delete ${whole}? It does not go to the trash: this cannot be undone.`),
        title: 'Delete',
        yes: 'Delete',
      });
      if (!yes || disposed) {
        return;
      }
      await disk.remove(node.path);
    } catch (err) {
      failure = err;
    } finally {
      deleting = false;
    }
    if (disposed) {
      return;
    }
    if (failure !== undefined) {
      toast(
        `Could not delete ${node.name}: ${failure instanceof Error ? failure.message : String(failure)}`
      );
      // part of a directory may have gone before the error, so the sizes are
      // read again rather than guessed at
      void rescan(true);
      return;
    }
    // the cursor goes to the next item in the same directory, or the one before
    // the last, or up to the directory once it is empty. The tree is the one the
    // confirm was asked over: `d` is refused while a scan runs, and `r` while a
    // delete does
    const parent = findNode(found.root, dirname(node.path));
    const siblings = parent?.children ?? [];
    const at = siblings.findIndex((child) => child.path === node.path);
    const next = siblings[at + 1] ?? siblings[at - 1] ?? parent;
    const after = removePath(found, node.path);
    scan.set(after);
    if (next !== undefined) {
      current.set(next.path);
    }
    const freed = found.root.bytes - after.root.bytes;
    status.set(`Deleted ${printable(node.name)}, freed ${formatSize(freed)}`);
    toast(`Deleted ${node.name}`, 'success');
  };

  // -- keys -------------------------------------------------------------------
  const treeKey = (event: KeyEvent): void => {
    const { key } = event;
    if (key.ctrl || key.meta || event.paste) {
      return;
    }
    if (key.name === 'd' || key.name === 'delete') {
      void deleteSelected();
    } else if (key.name === 'backspace') {
      zoomOut();
    } else {
      return;
    }
    event.stop();
  };

  const attach = (given: Parts): void => {
    parts = given;
    given.panel.onKey = treeKey;

    // the footer follows the focus: the tree's own moves, and the panel's keys
    // described with the panel as the scope
    const off: (() => void)[] = [describeTreeListView(input, given.tree, { activate: 'map it' })];
    const say = (spec: string, description: string, priority = 3): void => {
      off.push(input.describe(spec, { description, priority, scope: given.panel }));
    };
    say('backspace', 'map up', 2);
    say('d', 'delete', 2);
    // `r` is a fallback: it comes after the focused element, so a dialog keeps
    // it, and it runs with nothing focused. `q` is the runner's
    const askedRescan = (): void => {
      if (deleting) {
        status.set('Wait for the delete to finish before scanning again');
        return;
      }
      void rescan(true);
    };
    off.push(input.fallback('r', askedRescan, { description: 'rescan', priority: 2 }));
    onCleanup(() => {
      for (const fn of off) {
        fn();
      }
    });

    // a selection the tree does not show yet -- a click on the map, a rescan --
    // is scrolled to
    createEffect(() => {
      const path = current.get();
      const list = treeListControl<string>(given.tree)?.list;
      if (path !== undefined && list !== undefined) {
        untrack(() => list.reveal(path));
      }
    });

    onMount(() => {
      input.focus.focus(given.tree);
    });
  };

  void rescan(false);

  return {
    attach,
    current,
    expanded,
    info,
    input,
    items,
    mapIt: zoomIn,
    mapMessage,
    mapRoot,
    mapTitle,
    nodeOf: (choice) => nodes.get(choice),
    path: printable(disk.root),
    pick,
    scan,
    status,
    totals,
  };
}
