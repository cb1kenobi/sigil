import {
  COMMANDS,
  DEFAULT_PACKAGE_MANAGER,
  PACKAGE_MANAGERS,
  STORAGE_KEY,
  nextTabIndex,
  readStoredManager,
  writeStoredManager,
} from '../src/lib/install-command.ts';
import { createPackageManagerStore } from '../src/lib/package-manager-store.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const throwing = () => {
  throw new DOMException('denied', 'SecurityError');
};

describe('the command table', () => {
  it('lists vlt, pnpm and npm in that order, defaulting to npm', () => {
    assert.deepEqual([...PACKAGE_MANAGERS], ['vlt', 'pnpm', 'npm']);
    assert.equal(DEFAULT_PACKAGE_MANAGER, 'npm');
  });

  it('has the ticket’s command for every manager and package', () => {
    assert.deepEqual(COMMANDS.framework, {
      vlt: 'vlt install @ttylabs/sigil',
      pnpm: 'pnpm add @ttylabs/sigil',
      npm: 'npm install --save @ttylabs/sigil',
    });
    assert.deepEqual(COMMANDS.cli, {
      vlt: 'vlx @ttylabs/cli new my-cli',
      pnpm: 'pnpm dlx @ttylabs/cli new my-cli',
      npm: 'npx @ttylabs/cli new my-cli',
    });
  });

  it('never puts the prompt in a command, since Copy copies what is typed', () => {
    for (const row of Object.values(COMMANDS)) {
      for (const command of Object.values(row)) {
        assert.ok(!command.startsWith('$'));
      }
    }
  });
});

describe('the stored choice', () => {
  it('is read back under sigil:package-manager', () => {
    const storage = memoryStorage();
    assert.equal(
      writeStoredManager(() => storage, 'pnpm'),
      true
    );
    assert.equal(storage.data.get('sigil:package-manager'), 'pnpm');
    assert.equal(STORAGE_KEY, 'sigil:package-manager');
    assert.equal(
      readStoredManager(() => storage),
      'pnpm'
    );
  });

  it('ignores a value that is not one of the three', () => {
    assert.equal(
      readStoredManager(() => memoryStorage({ [STORAGE_KEY]: 'yarn' })),
      undefined
    );
    assert.equal(
      readStoredManager(() => memoryStorage()),
      undefined
    );
  });

  it('survives a localStorage that throws on access', () => {
    assert.equal(readStoredManager(throwing), undefined);
    assert.equal(writeStoredManager(throwing, 'vlt'), false);
  });

  it('survives a localStorage that throws on use', () => {
    const storage = {
      getItem: throwing,
      setItem: throwing,
    };
    assert.equal(
      readStoredManager(() => storage),
      undefined
    );
    assert.equal(
      writeStoredManager(() => storage, 'vlt'),
      false
    );
  });

  it('survives there being no storage at all', () => {
    assert.equal(
      readStoredManager(() => undefined),
      undefined
    );
    assert.equal(
      writeStoredManager(() => undefined, 'vlt'),
      false
    );
  });
});

describe('arrow keys in the tablist', () => {
  it('moves right and left, wrapping at both ends', () => {
    assert.equal(nextTabIndex(0, 'ArrowRight', 3), 1);
    assert.equal(nextTabIndex(2, 'ArrowRight', 3), 0);
    assert.equal(nextTabIndex(1, 'ArrowLeft', 3), 0);
    assert.equal(nextTabIndex(0, 'ArrowLeft', 3), 2);
  });

  it('jumps to the ends with Home and End', () => {
    assert.equal(nextTabIndex(1, 'Home', 3), 0);
    assert.equal(nextTabIndex(1, 'End', 3), 2);
  });

  it('leaves every other key alone', () => {
    for (const key of ['Enter', ' ', 'Tab', 'ArrowDown', 'ArrowUp', 'a']) {
      assert.equal(nextTabIndex(1, key, 3), undefined);
    }
  });
});

describe('the shared selection', () => {
  function setup(initial?: Record<string, string>) {
    const storage = memoryStorage(initial);
    let onStorage: ((key: string | null) => void) | undefined;
    let listeners = 0;
    const store = createPackageManagerStore({
      getStorage: () => storage,
      listen: (callback) => {
        listeners++;
        onStorage = callback;
        return () => {
          listeners--;
          onStorage = undefined;
        };
      },
    });
    return {
      storage,
      store,
      fire: (key: string | null) => onStorage?.(key),
      listeners: () => listeners,
    };
  }

  it('renders npm on the server whatever is stored', () => {
    const { store } = setup({ [STORAGE_KEY]: 'vlt' });
    assert.equal(store.getServerSnapshot(), 'npm');
    assert.equal(store.getSnapshot(), 'vlt');
  });

  it('switches every subscribed box at once and remembers the choice', () => {
    const { store, storage } = setup();
    const seen: string[] = [];
    store.subscribe(() => seen.push('a'));
    store.subscribe(() => seen.push('b'));

    store.select('pnpm');

    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(store.getSnapshot(), 'pnpm');
    assert.equal(storage.data.get(STORAGE_KEY), 'pnpm');
  });

  it('still switches the page when storage is unavailable', () => {
    const store = createPackageManagerStore({ getStorage: throwing, listen: () => () => {} });
    let calls = 0;
    store.subscribe(() => calls++);

    store.select('vlt');

    assert.equal(calls, 1);
    assert.equal(store.getSnapshot(), 'vlt');
  });

  it('follows a change made in another tab, and a cleared storage', () => {
    const { store, storage, fire } = setup();
    let calls = 0;
    store.subscribe(() => calls++);

    storage.data.set(STORAGE_KEY, 'vlt');
    fire(STORAGE_KEY);
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot(), 'vlt');

    fire('some-other-key');
    assert.equal(calls, 1);

    storage.data.clear();
    fire(null);
    assert.equal(calls, 2);
    assert.equal(store.getSnapshot(), 'npm');
  });

  it('listens to storage only while something is subscribed', () => {
    const { store, listeners } = setup();
    const stopA = store.subscribe(() => {});
    const stopB = store.subscribe(() => {});
    assert.equal(listeners(), 1);
    stopA();
    assert.equal(listeners(), 1);
    stopB();
    assert.equal(listeners(), 0);
  });
});
