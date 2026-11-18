/**
 * The scan, and the tree it builds: every name under the root with what it
 * counts for, directories largest first.
 *
 * A tree is never changed once built. A delete makes a new one that shares every
 * subtree it did not touch, so the tree list keeps the rows it already drew for
 * them and the map is laid out again from the new root -- and a scan that is
 * thrown away half done has changed nothing anybody can see.
 */

import { type Category, CATEGORIES, categoryOf, type Disk, isInside, type Kind } from './disk.ts';
import { basename, join, relative, sep } from 'node:path';

/** One name under the root, as the scan found it. */
export interface DiskNode {
  /**
   * What it counts for, in bytes: a file's length, a directory's total. A link
   * counts nothing, nor does a second name of a hard-linked file, whose length is
   * already counted where the first name is.
   */
  readonly bytes: number;
  /** The kind the map colours it by: a file's own, a directory's largest by bytes. */
  readonly category: Category;
  /** A directory's contents, largest first. Absent for anything that is not a directory. */
  readonly children?: readonly DiskNode[];
  /** Regular files at or under it: `1` for a file. */
  readonly files: number;
  readonly kind: Kind;
  /** For a file with more than one name: the key every name shares, `dev:ino`. */
  readonly link?: string;
  /** A directory's bytes by category, in {@link CATEGORIES} order. */
  readonly mix?: readonly number[];
  readonly name: string;
  /** Why it is not all there: a directory on another file system, or one that could not be read. */
  readonly note?: string;
  /** Absolute: the directory it was listed in, joined with its name. */
  readonly path: string;
  /** A file's own length, counted here or not. `0` for anything else. */
  readonly size: number;
}

/** What a scan found. */
export interface Scan {
  /** How many names could not be read. */
  readonly errors: number;
  /**
   * Every file with more than one name that the scan found more than once, by
   * `dev:ino`, its paths in byte order. The first is the one that counts.
   */
  readonly links: ReadonlyMap<string, readonly string[]>;
  readonly root: DiskNode;
}

/** How far a scan has got, which it writes as it goes and the app reads on a timer. */
export interface Progress {
  /** Bytes counted so far, each hard-linked file once. */
  bytes: number;
  dirs: number;
  errors: number;
  files: number;
  /** The directory it read last. */
  where: string;
}

/** A progress with nothing counted yet. */
export function startProgress(): Progress {
  return { bytes: 0, dirs: 0, errors: 0, files: 0, where: '' };
}

/** What {@link scanDisk} is told. */
export interface ScanOptions {
  /**
   * How many reads may be in flight at once. A scan is a few hundred thousand
   * `lstat`s, and one at a time is the time of all of them added up; the disk and
   * the thread pool take many at once, and past a few dozen nothing gets faster.
   */
  readonly parallel?: number;
  /** Written as the scan goes. */
  readonly progress?: Progress;
  /** Ends the scan, which then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** A node while the scan is still filling it in. */
interface Building {
  children?: Building[];
  kind: Kind;
  link?: string;
  name: string;
  note?: string;
  path: string;
  size: number;
}

/**
 * Runs `fn` once fewer than `n` others started here are still running. Only the
 * reads go through it, never the walk that waits on them, so a directory waiting
 * for its children never holds a place one of them needs.
 */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active >= n) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** The error code on a file system error, or its message where it has none. */
function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

/**
 * Reads everything under the disk's root.
 *
 * Asynchronous all the way down, with the reads in flight bounded, so the app
 * draws and takes keys while it runs. A link is listed and never followed, so a
 * link to `/` or a loop of them costs one `lstat`. A directory on another device
 * than the root is listed and not entered, the way `du -x` reads one, so scanning
 * `/` on Linux does not wander into `/proc`, whose `kcore` claims to be 128 TB. A
 * name that vanished between the listing and its `lstat` is left out; one that
 * could not be read is kept, with the reason as its note.
 *
 * @param disk - The disk, and the root to scan.
 * @param opts - The progress to write, a signal to stop it, and how many reads at once.
 * @returns What it found.
 */
export async function scanDisk(disk: Disk, opts: ScanOptions = {}): Promise<Scan> {
  const { signal } = opts;
  const progress = opts.progress ?? startProgress();
  const limit = limiter(opts.parallel ?? 48);
  /** Every name of each hard-linked file found so far. */
  const linked = new Map<string, string[]>();

  signal?.throwIfAborted();
  const rootInfo = await disk.stat(disk.root);
  const top: Building = {
    kind: rootInfo.kind,
    name: basename(disk.root) || disk.root,
    path: disk.root,
    size: rootInfo.size,
  };
  if (rootInfo.kind === 'file') {
    progress.files++;
    progress.bytes += rootInfo.size;
  }

  const walk = async (dir: Building, dev: string): Promise<void> => {
    signal?.throwIfAborted();
    progress.dirs++;
    progress.where = dir.path;
    let names: string[];
    try {
      names = await limit(() => disk.list(dir.path));
    } catch (err) {
      signal?.throwIfAborted();
      dir.children = [];
      dir.note = `Could not be read: ${codeOf(err)}`;
      progress.errors++;
      return;
    }
    const children: Building[] = [];
    dir.children = children;
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir.path, name);
        let info;
        try {
          info = await limit(() => disk.stat(path));
        } catch (err) {
          signal?.throwIfAborted();
          // gone between the listing and now: nothing to count
          if (codeOf(err) !== 'ENOENT') {
            children.push({
              kind: 'other',
              name,
              note: `Could not be read: ${codeOf(err)}`,
              path,
              size: 0,
            });
            progress.errors++;
          }
          return;
        }
        signal?.throwIfAborted();
        const child: Building = { kind: info.kind, name, path, size: info.size };
        children.push(child);
        if (info.kind === 'file') {
          progress.files++;
          if (info.nlink > 1) {
            const key = `${info.dev}:${info.ino}`;
            child.link = key;
            const paths = linked.get(key);
            if (paths === undefined) {
              linked.set(key, [path]);
              progress.bytes += info.size;
            } else {
              paths.push(path);
            }
          } else {
            progress.bytes += info.size;
          }
        } else if (info.kind === 'directory') {
          if (info.dev === dev) {
            await walk(child, dev);
          } else {
            child.children = [];
            child.note = 'On another file system, so not scanned';
          }
        }
      })
    );
  };

  if (rootInfo.kind === 'directory') {
    await walk(top, rootInfo.dev);
  }
  signal?.throwIfAborted();

  // the name that counts is the first in byte order rather than the first a
  // scan happened to reach, so two scans of one tree say the same thing
  const links = new Map<string, readonly string[]>();
  const counted = new Set<string>();
  for (const [key, paths] of linked) {
    paths.sort(byteOrder);
    counted.add(paths[0] as string);
    if (paths.length > 1) {
      links.set(key, paths);
    }
  }

  const finish = (b: Building): DiskNode => {
    if (b.children !== undefined) {
      return directory(
        { kind: b.kind, name: b.name, note: b.note, path: b.path },
        b.children.map(finish)
      );
    }
    const counts = b.kind === 'file' && (b.link === undefined || counted.has(b.path));
    return {
      bytes: counts ? b.size : 0,
      category: categoryOf(b.name),
      files: b.kind === 'file' ? 1 : 0,
      kind: b.kind,
      name: b.name,
      path: b.path,
      size: b.size,
      ...(b.link === undefined || !links.has(b.link) ? {} : { link: b.link }),
      ...(b.note === undefined ? {} : { note: b.note }),
    };
  };

  return { errors: progress.errors, links, root: finish(top) };
}

/** Compares two strings by code unit, which no locale moves. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Largest first, then the most files, then by name, so the order is total. */
function bySize(a: DiskNode, b: DiskNode): number {
  return b.bytes - a.bytes || b.files - a.files || byteOrder(a.name, b.name);
}

/**
 * A directory over its contents: the totals added up and the contents sorted.
 *
 * @param base - What the directory is, apart from its contents.
 * @param children - Its contents, in any order.
 * @returns The node.
 */
function directory(
  base: Pick<DiskNode, 'kind' | 'name' | 'note' | 'path'>,
  children: readonly DiskNode[]
): DiskNode {
  const mix = CATEGORIES.map(() => 0);
  let bytes = 0;
  let files = 0;
  for (const child of children) {
    bytes += child.bytes;
    files += child.files;
    if (child.mix === undefined) {
      mix[CATEGORIES.indexOf(child.category)] += child.bytes;
    } else {
      for (const [i, n] of child.mix.entries()) {
        mix[i] += n;
      }
    }
  }
  let most = CATEGORIES.length - 1;
  for (const [i, n] of mix.entries()) {
    if (n > (mix[most] as number)) {
      most = i;
    }
  }
  return {
    bytes,
    category: CATEGORIES[most] as Category,
    children: children.toSorted(bySize),
    files,
    kind: base.kind,
    mix,
    name: base.name,
    path: base.path,
    size: 0,
    ...(base.note === undefined ? {} : { note: base.note }),
  };
}

/** The names from the root down to `path`, or `undefined` for a path not under it. */
function stepsTo(root: DiskNode, path: string): string[] | undefined {
  if (!isInside(path, root.path)) {
    return undefined;
  }
  const rel = relative(root.path, path);
  return rel === '' ? [] : rel.split(sep);
}

/**
 * Finds a node by its path.
 *
 * @param root - The tree.
 * @param path - Absolute.
 * @returns The node, or `undefined` where nothing in the tree has that path.
 */
export function findNode(root: DiskNode, path: string): DiskNode | undefined {
  const steps = stepsTo(root, path);
  if (steps === undefined) {
    return undefined;
  }
  let node: DiskNode | undefined = root;
  for (const name of steps) {
    node = node?.children?.find((child) => child.name === name);
  }
  return node;
}

/**
 * The nodes from the root down to a path, the root first and the node last.
 *
 * @param root - The tree.
 * @param path - Absolute.
 * @returns The chain, or as much of it as exists.
 */
export function chainTo(root: DiskNode, path: string): DiskNode[] {
  const steps = stepsTo(root, path);
  if (steps === undefined) {
    return [];
  }
  const chain = [root];
  let node: DiskNode | undefined = root;
  for (const name of steps) {
    node = node.children?.find((child) => child.name === name);
    if (node === undefined) {
      break;
    }
    chain.push(node);
  }
  return chain;
}

/**
 * The tree with one node changed or removed, and every directory above it added
 * up and sorted again. Everything not above it is the same object it was.
 *
 * @param node - The tree.
 * @param steps - The names down to the node.
 * @param change - The node's replacement, or `undefined` to remove it.
 * @returns The new tree, or the same one where nothing had that path.
 */
function rebuild(
  node: DiskNode,
  steps: readonly string[],
  change: (node: DiskNode) => DiskNode | undefined
): DiskNode | undefined {
  if (steps.length === 0) {
    return change(node);
  }
  const children = node.children ?? [];
  const at = children.findIndex((child) => child.name === steps[0]);
  if (at === -1) {
    return node;
  }
  const was = children[at] as DiskNode;
  const now = rebuild(was, steps.slice(1), change);
  if (now === was) {
    return node;
  }
  const next = now === undefined ? children.toSpliced(at, 1) : children.with(at, now);
  return directory(node, next);
}

/**
 * The scan after `path` was deleted: the node gone, every directory above it
 * smaller by what it counted for, and a hard-linked file that was counted under
 * it counted at its next name instead, since deleting one name of a file frees
 * nothing while another remains.
 *
 * @param scan - What the scan found.
 * @param path - What was deleted. The root itself is never removed.
 * @returns The new scan, or the same one where nothing had that path.
 */
export function removePath(scan: Scan, path: string): Scan {
  const steps = stepsTo(scan.root, path);
  if (steps === undefined || steps.length === 0) {
    return scan;
  }
  let root = rebuild(scan.root, steps, () => undefined) as DiskNode;
  if (root === scan.root) {
    return scan;
  }
  const links = new Map(scan.links);
  for (const [key, paths] of scan.links) {
    const kept = paths.filter((p) => !isInside(p, path));
    if (kept.length === paths.length) {
      continue;
    }
    if (kept.length === 0) {
      links.delete(key);
      continue;
    }
    links.set(key, kept);
    const next = kept[0] as string;
    if (next !== paths[0]) {
      const at = stepsTo(root, next);
      if (at !== undefined) {
        root = rebuild(root, at, (node) => ({ ...node, bytes: node.size })) as DiskNode;
      }
    }
  }
  return { errors: scan.errors, links, root };
}

/**
 * The path a node is shown as: under the root, with the root's own name first,
 * so `/home/me/work/src/a.ts` scanned from `/home/me/work` is `work/src/a.ts`.
 *
 * @param root - The root.
 * @param path - Absolute.
 * @returns The path to show.
 */
export function shownPath(root: DiskNode, path: string): string {
  const rel = relative(root.path, path);
  return rel === '' ? root.name : join(root.name, rel);
}
