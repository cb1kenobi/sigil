import { page } from '../../src/components/pager.js';
import { text } from '../../src/components/prompt.js';
import { box } from '../../src/element/index.js';
import type { InputOptions, InputRouter } from '../../src/input/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// the routers the built-ins build, kept so that a test can ask the one question the
// ticket is about: what is a Tab stop in a tree that a sheet hides things from
const built: { opts: InputOptions; router: InputRouter }[] = [];

vi.mock('../../src/input/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/input/index.js')>();
  return {
    ...original,
    createInput: (opts?: InputOptions) => {
      const router = original.createInput(opts);
      built.push({ opts: opts ?? {}, router });
      return router;
    },
  };
});

afterEach(() => {
  built.length = 0;
});

/** Long enough for the frame timer to have fired, at `frameMs: 0`. */
const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

const HIDDEN = '.gone { display: none !important }';

describe('the routers the built-ins build', () => {
  it.each([
    [
      'a pager',
      async (ui: ReturnType<typeof createTestTerminal>) => {
        const done = page('one\ntwo', { frameMs: 0, terminal: ui.terminal, theme: HIDDEN });
        await frame();
        return async () => {
          await ui.press('q');
          await done;
        };
      },
    ],
    [
      'a prompt',
      async (ui: ReturnType<typeof createTestTerminal>) => {
        const done = text({
          frameMs: 0,
          message: 'name',
          terminal: ui.terminal,
          theme: HIDDEN,
        });
        await frame();
        return async () => {
          await ui.press(KEYS.enter);
          await done;
        };
      },
    ],
  ])(
    'should not make a box an !important sheet rule hides a Tab stop in %s (SIG-661)',
    async (_, start) => {
      const ui = createTestTerminal({ columns: 30, rows: 8 });
      const stop = await start(ui);
      const { opts, router } = built.at(-1)!;
      // a prop shows the box and a sheet rule that outranks it hides it: the style says
      // `none`, the prop says `flex`, and only the sheet can say which of the two is right
      const hidden = box({ class: 'gone', display: 'flex', focusable: true });
      const shown = box({ class: 'here', display: 'flex', focusable: true });
      opts.root!.append(hidden, shown);
      await frame();

      expect(hidden.style.display).toBe('none');
      expect(router.focus.ring()).toEqual(expect.arrayContaining([shown]));
      expect(router.focus.ring()).not.toContain(hidden);
      await stop();
    }
  );
});
