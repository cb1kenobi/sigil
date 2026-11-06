import {
  SERVER_SHORTCUT,
  isApplePlatform,
  searchShortcutLabel,
  searchShortcutStore,
} from '../src/lib/search-shortcut.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the search shortcut label', () => {
  it('should be ⌘K on an Apple platform', () => {
    assert.equal(searchShortcutLabel({ platform: 'MacIntel' }), '⌘K');
    assert.equal(searchShortcutLabel({ userAgentData: { platform: 'macOS' } }), '⌘K');
    assert.equal(searchShortcutLabel({ platform: 'iPhone' }), '⌘K');
  });

  it('should be Ctrl K on Windows and Linux', () => {
    assert.equal(searchShortcutLabel({ platform: 'Win32' }), 'Ctrl K');
    assert.equal(searchShortcutLabel({ userAgentData: { platform: 'Windows' } }), 'Ctrl K');
    assert.equal(searchShortcutLabel({ platform: 'Linux x86_64' }), 'Ctrl K');
  });

  it('should prefer userAgentData, which is the one that is not deprecated', () => {
    assert.equal(
      searchShortcutLabel({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }),
      'Ctrl K'
    );
  });

  it('should be Ctrl K where the platform is unknown, since the dialog takes it too', () => {
    assert.equal(searchShortcutLabel(undefined), 'Ctrl K');
    assert.equal(searchShortcutLabel({}), 'Ctrl K');
    assert.equal(isApplePlatform(''), false);
  });
});

describe('the search shortcut store', () => {
  it('should render ⌘K on the server and for the hydration pass, whatever the client is', () => {
    assert.equal(SERVER_SHORTCUT, '⌘K');
    assert.equal(searchShortcutStore.getServerSnapshot(), '⌘K');
  });

  it('should answer with a label whether or not the runtime has a navigator', () => {
    assert.match(searchShortcutStore.getSnapshot(), /^(⌘K|Ctrl K)$/u);
  });

  it('should subscribe to nothing and hand back a function to stop', () => {
    assert.equal(typeof searchShortcutStore.subscribe(), 'function');
  });
});
