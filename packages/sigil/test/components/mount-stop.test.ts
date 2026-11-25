import { mountLive } from '../../src/components/mount.js';
import { box, text } from '../../src/element/index.js';
import { onCleanup } from '../../src/renderer/index.js';
import { setup } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

/**
 * A mounted component stopped over a terminal whose write fails (SIG-699).
 *
 * `stop()` erases the region and then disposes the renderer, in that order and on
 * purpose. The erase is a write, so a closed stream threw out of the first step
 * and the second never ran: every cleanup in the tree stayed pending.
 */
describe('a mounted component stopped over a terminal whose write fails', () => {
  // `dispose()` finishes a region the erase already failed on, and the renderer
  // reports a write it cannot make where nothing is on the stack: the default
  // report, which is not what this asks about
  let stderr: MockInstance<typeof process.stderr.write> | undefined;
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr?.mockRestore();
    process.exitCode = exitCode;
  });

  /** A mount whose cleanup is observable, and whose stream starts to fail on demand. */
  function mount() {
    const ui = setup({ columns: 20 });
    let failing = false;
    const write = ui.stdout.write.bind(ui.stdout);
    ui.stdout.write = (chunk: string): boolean => {
      if (failing) {
        throw new Error('pipe broke');
      }
      return write(chunk);
    };
    const events: string[] = [];
    const mounted = mountLive(
      () => {
        onCleanup(() => void events.push('disposed'));
        return box({}, text('hello'));
      },
      { terminal: ui.terminal }
    );
    mounted.frame();
    return {
      events,
      fail: () => {
        failing = true;
      },
      mounted,
    };
  }

  it('should dispose the renderer even though the erase threw, and raise what the erase threw', () => {
    const { events, fail, mounted } = mount();
    fail();

    expect(() => mounted.stop()).toThrow('pipe broke');

    expect(events).toEqual(['disposed']);
    // and the renderer, finishing a region the erase failed on, wrote to the dead
    // pipe too and reported it where nothing is on the stack: one dead pipe is
    // said more than once, as a prompt's is, and the throw above is still the one
    expect(String(stderr?.mock.calls.map((call) => call[0]).join(''))).toContain('pipe broke');
  });

  it('should stop cleanly when nothing fails, in the order it always had', () => {
    const { events, mounted } = mount();

    expect(() => mounted.stop()).not.toThrow();

    expect(events).toEqual(['disposed']);
  });
});
