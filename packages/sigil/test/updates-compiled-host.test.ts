import { compiledHost as fromHost } from '../src/updates/host.js';
import { compiledHost } from '../src/updates/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `compiledHost()` is exported for an app that spawns a process of its own, so
// what it answers is now a promise to apps as well as to the update check. The
// update check's own tests reach it only through `check()`; these ask it
// directly, through the entry an app imports.

describe('compiledHost', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should be the function the update check asks, not a copy of it', () => {
    expect(compiledHost).toBe(fromHost);
  });

  it('should answer false in a runtime that was not compiled', async () => {
    expect(await compiledHost()).toBe(false);
  });

  it('should take the build at its word when it baked compiled: true', async () => {
    vi.stubGlobal('__SIGIL_UPDATE_CHECK__', JSON.stringify({ compiled: true }));

    expect(await compiledHost()).toBe(true);
  });

  it('should still probe when the build baked compiled: false', async () => {
    // a `sigil build` bundle somebody compiled themselves: the baked answer is
    // wrong, and the probe is what stops the app spawning itself
    vi.stubGlobal('__SIGIL_UPDATE_CHECK__', JSON.stringify({ compiled: false }));
    vi.stubGlobal('Bun', { main: '/$bunfs/root/my-cli' });

    expect(await compiledHost()).toBe(true);
  });

  it('should read a Bun executable off the virtual filesystem it runs from', async () => {
    vi.stubGlobal('Bun', { main: '/$bunfs/root/my-cli' });
    expect(await compiledHost()).toBe(true);

    vi.stubGlobal('Bun', { main: 'B:\\~BUN\\root\\my-cli.exe' });
    expect(await compiledHost()).toBe(true);

    vi.stubGlobal('Bun', { main: '/home/ada/my-cli/dist/my-cli.mjs' });
    expect(await compiledHost()).toBe(false);
  });

  it('should not throw over a baked value that does not parse', async () => {
    vi.stubGlobal('__SIGIL_UPDATE_CHECK__', '{not json');

    expect(await compiledHost()).toBe(false);
  });
});
