import type { PackageManager } from './analytics.ts';

/** The tabs, in the order the box shows them. */
export const PACKAGE_MANAGERS = ['vlt', 'pnpm', 'npm'] as const satisfies readonly PackageManager[];

/** What the server renders, and what a reader with no stored choice sees. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm';

/** The key a choice is remembered under, shared with nothing else on the site. */
export const STORAGE_KEY = 'sigil:package-manager';

/** What an install box installs: the framework as a dependency, or the CLI as a one-off. */
export type InstallPackage = 'framework' | 'cli';

/**
 * Every command the site shows, by what it installs and by manager.
 *
 * The CLI row is `new my-cli` run straight from the registry rather than a
 * global install, to match Getting started, which opens with
 * `npx @ttylabs/cli new my-cli`. The vlt spellings were checked against
 * docs.vlt.io: `vlt install <pkg>` saves to `dependencies`, and `vlx` is the
 * alias for `vlt exec`, which treats a first argument that is not a local bin
 * as the package to run.
 */
export const COMMANDS: Record<InstallPackage, Record<PackageManager, string>> = {
  framework: {
    vlt: 'vlt install @ttylabs/sigil',
    pnpm: 'pnpm add @ttylabs/sigil',
    npm: 'npm install --save @ttylabs/sigil',
  },
  cli: {
    vlt: 'vlx @ttylabs/cli new my-cli',
    pnpm: 'pnpm dlx @ttylabs/cli new my-cli',
    npm: 'npx @ttylabs/cli new my-cli',
  },
};

export function isPackageManager(value: unknown): value is PackageManager {
  return typeof value === 'string' && (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/** Where a choice is kept. Getting one may throw, which is why it is a function. */
export type StorageSource = () => Pick<Storage, 'getItem' | 'setItem'> | undefined;

/**
 * The remembered choice, or `undefined` when there is none, it is not one of
 * the three, or storage is unavailable. Private windows, blocked site data and
 * a sandboxed iframe each make `localStorage` throw on access or on use, and
 * none of them is a reason for an install box to fail.
 */
export function readStoredManager(getStorage: StorageSource): PackageManager | undefined {
  try {
    const value = getStorage()?.getItem(STORAGE_KEY);
    return isPackageManager(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers a choice. Returns whether it was kept; failing is not an error. */
export function writeStoredManager(getStorage: StorageSource, manager: PackageManager): boolean {
  try {
    const storage = getStorage();
    if (!storage) {
      return false;
    }
    storage.setItem(STORAGE_KEY, manager);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where focus goes when `key` is pressed on the tab at `index`, or `undefined`
 * when the key is not one a tablist handles. Left and right wrap, as the ARIA
 * tabs pattern has them, and Home and End jump to the ends.
 */
export function nextTabIndex(index: number, key: string, length: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % length;
    case 'ArrowLeft':
      return (index - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return undefined;
  }
}
