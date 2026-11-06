import type { PackageManager } from './analytics.ts';
import {
  DEFAULT_PACKAGE_MANAGER,
  STORAGE_KEY,
  readStoredManager,
  writeStoredManager,
  type StorageSource,
} from './install-command.ts';

export interface PackageManagerStoreEnvironment {
  getStorage: StorageSource;
  /** Calls back when another tab changes the stored choice; returns the way to stop. */
  listen: (callback: (key: string | null) => void) => () => void;
}

/**
 * The one selection every install box on a page shares, in the shape
 * `useSyncExternalStore` takes.
 *
 * Storage is the source of truth when it has an answer, so a change made in
 * another tab arrives through the `storage` event and reads straight back. The
 * in-memory `selected` is what keeps the boxes in step when storage is
 * unavailable: a choice that cannot be remembered should still switch every
 * box on the page it was made on.
 *
 * The snapshot is a string, so `getSnapshot` can read storage on every call
 * without ever returning a value React would see as new.
 */
export function createPackageManagerStore({ getStorage, listen }: PackageManagerStoreEnvironment) {
  const listeners = new Set<() => void>();
  let selected: PackageManager | undefined;
  let stopListening: (() => void) | undefined;

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot(): PackageManager {
      return readStoredManager(getStorage) ?? selected ?? DEFAULT_PACKAGE_MANAGER;
    },

    /** The server has no storage, so it always renders the default. */
    getServerSnapshot(): PackageManager {
      return DEFAULT_PACKAGE_MANAGER;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      stopListening ??= listen((key) => {
        // `null` is `localStorage.clear()`.
        if (key === null || key === STORAGE_KEY) {
          emit();
        }
      });

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopListening?.();
          stopListening = undefined;
        }
      };
    },

    select(manager: PackageManager) {
      selected = manager;
      writeStoredManager(getStorage, manager);
      emit();
    },
  };
}

/** The store the page uses: `window.localStorage`, and the `storage` event. */
export const packageManagerStore = createPackageManagerStore({
  getStorage: () => (typeof window === 'undefined' ? undefined : window.localStorage),
  listen: (callback) => {
    const onStorage = (event: StorageEvent) => callback(event.key);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  },
});
