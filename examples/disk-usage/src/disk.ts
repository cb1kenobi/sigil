/**
 * The disk, as a context, and the plain rules the rest of the app reads it by.
 *
 * `App()` takes no props -- it is what `runApp()` and the examples' smoke test
 * mount as it is -- so what a test has to replace comes in through a context, the
 * file manager's `FilesContext` again: the directory to scan and the three calls
 * the app makes to the disk. Outside a provider it is the working directory and
 * `node:fs`.
 *
 * Everything that is a decision rather than a call -- how a size is written, what
 * kind of file a name is, whether one path is under another -- is a plain
 * function below, so the tests can ask it without an app.
 */

import { createContext, type Context } from '@ttylabs/sigil/renderer';
import { realpathSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

/** What a name is, read with `lstat`, so a link is a link and never what it points at. */
export type Kind = 'directory' | 'file' | 'link' | 'other';

/** What the scan needs to know about one name. */
export interface Info {
  /**
   * The device it is on, as a string, so a 64-bit number survives. A directory on
   * another device than the root is not entered.
   */
  readonly dev: string;
  /** The inode, as a string for the same reason: with `dev`, what makes two hard links one file. */
  readonly ino: string;
  readonly kind: Kind;
  /** How many names the file has. Above one, it is counted once, however many are found. */
  readonly nlink: number;
  /** Its length in bytes, for a regular file. `0` for anything else. */
  readonly size: number;
}

/** What the app does to the disk, replaceable in a test. */
export interface Disk {
  /** The names in a directory, in no particular order. */
  list(dir: string): Promise<string[]>;
  /** Removes a file, a link, or a directory and everything in it. */
  remove(path: string): Promise<void>;
  /** The directory the app scans: absolute. */
  readonly root: string;
  /** What a name is, without following a link. */
  stat(path: string): Promise<Info>;
}

/**
 * The real disk.
 *
 * @param root - The directory to scan. Defaults to the working directory.
 * @returns The calls the app makes.
 */
export function createDisk(root?: string): Disk {
  return {
    async list(dir) {
      return readdir(dir);
    },
    async remove(path) {
      // `rm()` reads the path with `lstat`, so a link to a directory loses the
      // link and keeps the directory it pointed at
      await rm(path, { force: false, maxRetries: 2, recursive: true });
    },
    root: rootOf(root),
    async stat(path) {
      // bigint, because an inode on NTFS and on some network file systems is
      // past 2^53 and two different files would otherwise compare equal
      const info = await lstat(path, { bigint: true });
      const kind: Kind = info.isSymbolicLink()
        ? 'link'
        : info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : 'other';
      return {
        dev: String(info.dev),
        ino: String(info.ino),
        kind,
        nlink: Number(info.nlink),
        size: kind === 'file' ? Number(info.size) : 0,
      };
    },
  };
}

/**
 * The directory to scan, with its links resolved: the root was named, so a link
 * there is followed once, where nothing under it ever is. A root that cannot be
 * resolved is left as given, and the scan says why it cannot be read.
 */
function rootOf(root: string | undefined): string {
  const path = resolve(root ?? process.cwd());
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Where the app scans, and how it reaches the disk. `provideContext()` another in a test. */
export const DiskContext: Context<Disk> = createContext(createDisk(), 'disk');

// -- the rules ------------------------------------------------------------------

/** The units a size is written in: powers of 1000, as a disk is sold and as Finder counts. */
const UNITS = ['kB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/**
 * A size as a person reads it: bytes under a thousand, then one decimal in powers
 * of 1000 -- `512 B`, `8.2 kB`, `530.1 GB`. Always one decimal past bytes, so a
 * right-aligned column lines its points up.
 *
 * @param bytes - The size.
 * @returns The label.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  let value = bytes;
  for (const [i, unit] of UNITS.entries()) {
    value /= 1000;
    // 999.96 kB rounds to `1000.0 kB`, which is a megabyte said badly
    if (Number(value.toFixed(1)) < 1000 || i === UNITS.length - 1) {
      return `${value.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/** A number with its thousands marked, in one locale whatever the machine's is. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * What kind of thing a file is, by its name: what the map colours it by. Seven
 * kinds and no more, because a colour has to be told from six others at 16
 * colours, where there are six hues to be had.
 */
export type Category = 'archive' | 'binary' | 'code' | 'image' | 'media' | 'other' | 'text';

/** Every category, in the order the legend lists them. */
export const CATEGORIES: readonly Category[] = [
  'code',
  'text',
  'image',
  'media',
  'archive',
  'binary',
  'other',
];

const EXTENSIONS: Readonly<Record<Exclude<Category, 'other'>, readonly string[]>> = {
  archive: [
    '7z',
    'apk',
    'bz2',
    'cab',
    'deb',
    'dmg',
    'gz',
    'iso',
    'jar',
    'pkg',
    'rar',
    'rpm',
    'tar',
    'tgz',
    'whl',
    'xz',
    'zip',
    'zst',
  ],
  binary: [
    'a',
    'bin',
    'class',
    'db',
    'dll',
    'dylib',
    'exe',
    'lib',
    'node',
    'o',
    'obj',
    'pyc',
    'so',
    'sqlite',
    'wasm',
  ],
  code: [
    'c',
    'cc',
    'cjs',
    'cpp',
    'cs',
    'css',
    'go',
    'h',
    'hpp',
    'html',
    'java',
    'js',
    'jsx',
    'kt',
    'lua',
    'map',
    'mjs',
    'mts',
    'php',
    'py',
    'rb',
    'rs',
    'scss',
    'sh',
    'sql',
    'swift',
    'ts',
    'tsx',
    'vue',
    'zig',
  ],
  image: [
    'avif',
    'bmp',
    'gif',
    'heic',
    'ico',
    'jpeg',
    'jpg',
    'png',
    'psd',
    'raw',
    'svg',
    'tif',
    'tiff',
    'webp',
  ],
  media: [
    'aac',
    'avi',
    'flac',
    'm4a',
    'm4v',
    'mkv',
    'mov',
    'mp3',
    'mp4',
    'ogg',
    'wav',
    'webm',
    'wmv',
  ],
  text: [
    'csv',
    'doc',
    'docx',
    'epub',
    'json',
    'jsonc',
    'log',
    'md',
    'pdf',
    'rtf',
    'toml',
    'txt',
    'xls',
    'xlsx',
    'xml',
    'yaml',
    'yml',
  ],
};

/** Each extension's category, built once. */
const BY_EXTENSION: ReadonlyMap<string, Category> = new Map(
  Object.entries(EXTENSIONS).flatMap(([category, exts]) =>
    exts.map((ext) => [ext, category as Category] as const)
  )
);

/**
 * What kind of file a name is, by its extension, case set aside. A name with no
 * extension, or one nobody listed, is `other`; so is a dot file whose only dot is
 * its first character, since `.env` has no extension.
 *
 * @param name - The file's name.
 * @returns Its category.
 */
export function categoryOf(name: string): Category {
  const ext = extname(name).slice(1).toLowerCase();
  return BY_EXTENSION.get(ext) ?? 'other';
}

/**
 * Whether `child` is `parent` or somewhere under it, read off the paths alone.
 * Both are paths the scan built, so they are spelled alike and case is not set
 * aside. A root such as `/` or `C:\` already ends in its separator.
 *
 * @param child - The path that may be inside.
 * @param parent - The directory.
 * @returns Whether it is.
 */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) {
    return true;
  }
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
