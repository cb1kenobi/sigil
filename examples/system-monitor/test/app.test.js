import { App, stylesheet } from '../src/root.js';
import { SystemContext } from '../src/system.js';
import { runApp } from '@ttylabs/sigil/app';
import { ESCAPE_TIMEOUT } from '@ttylabs/sigil/input';
import { provideContext } from '@ttylabs/sigil/renderer';
import { flush } from '@ttylabs/sigil/signals';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The monitor run by `runApp()` over a fake terminal, with a fake machine behind
 * `SystemContext`: a sampler, a clock and a kill the test drives. Exactly what
 * `src/ui.js` does, minus the real terminal and the real machine.
 */

const proc = (pid, cpu, mem) => ({
  cpu,
  mem,
  name: `proc-${pid}`,
  pid,
  rss: pid * 1024,
  started: 'at boot',
  user: 'chris',
});

const mounted = [];

function mount({
  colorLevel = 0,
  columns = 100,
  cores = [0.25, 0.75],
  memory = { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3 },
  pid = 99999,
  rows = 30,
  processes = [],
  sample,
} = {}) {
  const term = createTestTerminal({ colorLevel, columns, rows });
  const data = { processes };
  let n = 0;
  let tick;
  /** Lets go of a reading `data.hold` held, with what it read when it began. */
  let release = () => {};
  let stopped = false;
  let samplerStopped = false;
  const killed = [];
  const system = {
    clock: {
      every(_ms, fn) {
        tick = fn;
        return () => {
          stopped = true;
        };
      },
    },
    interval: 1000,
    kill: (it) => killed.push(it),
    pid,
    sampler: () => ({
      sample:
        sample ??
        (async () => {
          n++;
          // a `ps` that failed, once
          if (data.fail) {
            const message = data.fail;
            data.fail = undefined;
            throw new Error(message);
          }
          const snap = {
            cores,
            memory,
            net: { rx: 1024 * n, tx: 512 * n },
            processes: data.processes,
          };
          // a slow `ps`: it read the machine when it began, and answers later
          if (data.hold) {
            data.hold = false;
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          return snap;
        }),
      stop() {
        samplerStopped = true;
      },
    }),
  };
  const app = runApp(() => provideContext(SystemContext, system, App), {
    colorLevel,
    detect: false,
    sheets: [stylesheet],
    terminal: term.terminal,
  });

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      flush();
      if (app.running) {
        app.view.frame();
      }
    }
  };
  const press = async (...keys) => {
    for (const key of keys) {
      await term.press(key);
      await settle();
    }
  };
  const escape = async () => {
    await term.press(KEYS.escape);
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
    await settle();
  };
  const step = async () => {
    await tick();
    await settle();
  };
  const screen = () => term.viewport.join('\n');
  const it = {
    app,
    data,
    escape,
    killed,
    press,
    release: () => release(),
    get samples() {
      return n;
    },
    tick: () => tick(),
    screen,
    settle,
    step,
    get stopped() {
      return stopped;
    },
    get samplerStopped() {
      return samplerStopped;
    },
    term,
  };
  mounted.push(it);
  return it;
}

afterEach(async () => {
  for (const it of mounted.splice(0)) {
    it.app.exit();
    await it.app.exited;
  }
});

/** Selects the process on the row `by` below the top, then kills it through the dialog. */
async function killRow(app, by) {
  for (let i = 0; i < by; i++) {
    await app.press('j');
  }
  await app.press('x');
  // the dialog opens on No, so a destructive answer takes a deliberate move
  await app.press(KEYS.tab, KEYS.enter);
}

describe('the system monitor', () => {
  it('should draw four titled panels and the key-help footer', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 9, 2)] });
    await app.settle();
    await app.step();
    const screen = app.screen();
    expect(screen).toContain('─ cpu · 2 cores ─');
    expect(screen).toContain('─ memory ─');
    expect(screen).toContain('─ network ─');
    expect(screen).toContain('─ processes · 2 of 2 ─');
    expect(screen).toContain('8.0 GiB / 16 GiB');
    expect(screen).toMatch(/cpu1 .* 75%/);
    expect(screen).toMatch(/↑\/↓ select · s sort · \/ filter · x kill · t theme · q quit/);
  });

  it('should sort by cpu first, highest at the top', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();
    const order = app
      .screen()
      .split('\n')
      .flatMap((line) => /proc-(\d+)/.exec(line)?.[1] ?? []);
    expect(order).toEqual(['2', '3', '1']);
  });

  it('should kill the selected process only after the dialog is answered yes', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();

    await app.press('j', 'x');
    expect(app.screen()).toContain('Send SIGTERM to proc-3 (pid 3)?');
    await app.press(KEYS.enter);
    expect(app.killed).toEqual([]);

    await killRow(app, 0);
    expect(app.killed).toEqual([3]);
    expect(app.screen()).toContain('sent SIGTERM to 3');
  });

  it('should send nothing when the pid went to a new process of the same name and user', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();
    await app.press('j', 'x');
    expect(app.screen()).toContain('Send SIGTERM to proc-3 (pid 3)?');

    // proc-3 exits and its pid goes to another proc-3 of the same user before the
    // answer, with no tick in between: only the start time tells them apart, and
    // only a reading taken after Yes can see it
    app.data.processes = [proc(1, 5, 1), proc(2, 90, 2), { ...proc(3, 40, 3), started: 'later' }];
    await app.press(KEYS.tab, KEYS.enter);
    expect(app.killed).toEqual([]);
    expect(app.screen()).toContain('proc-3 (pid 3) has exited: nothing sent');
  });

  it('should wait for the reading in flight, then take one of its own, before it checks the pid', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();
    await app.press('j', 'x');

    // a reading begins while proc-3 is still there, and is slow to answer
    app.data.hold = true;
    app.tick();
    await app.press(KEYS.tab, KEYS.enter);
    expect(app.killed).toEqual([]);

    // proc-3 exits and its pid is reused, and only then does the slow reading
    // answer -- with proc-3 in it, because that is what it saw
    app.data.processes = [proc(1, 5, 1), proc(2, 90, 2), { ...proc(3, 40, 3), started: 'later' }];
    app.release();
    await app.settle();
    expect(app.killed).toEqual([]);
    expect(app.screen()).toContain('proc-3 (pid 3) has exited: nothing sent');
  });

  it('should still send when only the user column changed, from a uid to a name', async () => {
    // /etc/passwd could not be read for the first sample and could for the next
    const app = mount({ processes: [{ ...proc(3, 40, 3), user: '1000' }] });
    await app.step();
    await app.press('x');
    app.data.processes = [proc(3, 40, 3)];
    await app.press(KEYS.tab, KEYS.enter);
    expect(app.killed).toEqual([3]);
  });

  it('should send nothing when the reading after Yes fails, rather than trust the one before it', async () => {
    const app = mount({ processes: [proc(3, 40, 3)] });
    await app.step();
    await app.press('x');

    // the process list cannot be read after the answer, so whether pid 3 is
    // still proc-3 is not known -- and the last reading shown says it is
    app.data.fail = 'ps went away';
    await app.press(KEYS.tab, KEYS.enter);
    expect(app.killed).toEqual([]);
    expect(app.screen()).toContain('pid 3 not checked, nothing sent');
  });

  it('should keep the table when a reading fails, rather than blank it', async () => {
    const app = mount({ processes: [proc(3, 40, 3)] });
    await app.step();
    app.data.fail = 'ps went away';
    await app.step();
    expect(app.screen()).toContain('proc-3');
    expect(app.screen()).toContain('processes · 1 of 1');
  });

  it('should take no reading after quitting while Yes waits for one in flight', async () => {
    const app = mount({ processes: [proc(3, 40, 3)] });
    await app.step();
    await app.press('x');
    app.data.hold = true;
    app.tick();
    await app.press(KEYS.tab, KEYS.enter);
    const before = app.samples;

    // quit while the answer waits on the reading that began before it
    app.app.exit();
    await app.app.exited;
    app.release();
    await app.settle();
    expect(app.samples).toBe(before);
    expect(app.killed).toEqual([]);
  });

  it('should ignore x while a kill is still being checked', async () => {
    const app = mount({ processes: [proc(3, 40, 3)] });
    await app.step();
    await app.press('x');
    app.data.hold = true;
    app.tick();
    await app.press(KEYS.tab, KEYS.enter);
    expect(app.screen()).toContain('checking pid 3...');

    // a second dialog now would be answered while the first answer is pending
    await app.press('x');
    expect(app.screen()).not.toContain('Send SIGTERM');

    app.release();
    await app.settle();
    expect(app.killed).toEqual([3]);
  });

  it('should refuse to kill pid 1 or the monitor itself, without asking', async () => {
    const app = mount({ pid: 2, processes: [proc(1, 90, 1), proc(2, 50, 2)] });
    await app.step();

    await app.press('x');
    expect(app.screen()).not.toContain('Send SIGTERM');
    expect(app.screen()).toContain('pid 1 is init: not sending it SIGTERM');

    await app.press('j', 'x');
    expect(app.screen()).not.toContain('Send SIGTERM');
    expect(app.screen()).toContain('that is this monitor: quit with q');
    expect(app.killed).toEqual([]);
  });

  it('should keep the selection on the same row when a refresh reorders the table', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();
    await app.press('j'); // proc-3, the second row

    // proc-3 moves from the second row to the third and proc-2 takes its place:
    // the highlight stays where the eye left it, on the second row
    app.data.processes = [proc(1, 99, 1), proc(2, 60, 2), proc(3, 50, 3)];
    await app.step();
    await killRow(app, 0);
    expect(app.killed).toEqual([2]);
  });

  it('should draw the selected row in reverse video, and move it with j and k', async () => {
    const app = mount({
      colorLevel: 1,
      processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)],
    });
    await app.step();
    const rowOf = (name) => app.term.viewport.findIndex((line) => line.includes(name));

    await app.press('j');
    expect(app.term.screen.lastInverse?.row).toBe(rowOf('proc-3'));
    await app.press('j');
    expect(app.term.screen.lastInverse?.row).toBe(rowOf('proc-1'));
    await app.press('k', 'k');
    expect(app.term.screen.lastInverse?.row).toBe(rowOf('proc-2'));
  });

  it('should cycle the sort column with s', async () => {
    const app = mount({ processes: [proc(1, 5, 9), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();
    await app.press('s');
    expect(app.screen()).toContain('MEM%▼');
    expect(app.screen()).toContain('sorted by mem');
    const first = /proc-(\d+)/.exec(app.screen().split('PID')[1] ?? '')?.[1];
    expect(first).toBe('1');
  });

  it('should filter on / and keep the filter on Enter', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(22, 90, 2), proc(3, 40, 3)] });
    await app.step();
    await app.press('/', '22', KEYS.enter);
    expect(app.screen()).toContain('processes · 1 of 3');
    expect(app.screen()).not.toContain('proc-3');
  });

  it('should show the whole filter as it is typed, not only its last letter', async () => {
    // a text field with no width is as wide as what it draws, and cuts what it
    // draws to the width it was laid out at -- so with a frame between keys, as
    // a person types, it shrank to the caret and showed only the last letter.
    // One key per frame here: typed in one go, the field never saw a layout
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 9, 2)] });
    await app.step();
    await app.press('/', 'p', 'r', 'o', 'c');
    expect(app.screen()).toMatch(/filter proc/);
  });

  it('should take q as text in the filter, and drop the filter on Escape', async () => {
    const app = mount({ processes: [proc(1, 5, 1)] });
    await app.step();
    await app.press('/', 'q');
    expect(app.app.running).toBe(true);
    expect(app.screen()).toContain('processes · 0 of 1');

    await app.escape();
    expect(app.screen()).toContain('processes · 1 of 1');
    await app.press('q');
    expect(await app.app.exited).toBe(0);
  });

  it('should exit 0 on q and give the terminal back', async () => {
    const app = mount();
    await app.step();
    expect(app.term.screen.alternate).toBe(true);

    await app.press('q');
    expect(await app.app.exited).toBe(0);
    expect(app.term.screen.alternate).toBe(false);
    expect(app.term.stdin.rawMode).toBe(false);
  });

  it('should exit 130 on Ctrl-C, even with the filter focused', async () => {
    const app = mount();
    await app.step();
    await app.press('/', 'ab', ctrl('c'));
    expect(await app.app.exited).toBe(130);
    expect(app.term.screen.alternate).toBe(false);
  });

  it('should switch themes with t', async () => {
    const app = mount();
    await app.step();
    await app.press('t');
    expect(app.screen()).toContain('theme: mono');
  });

  it('should restyle the roles when the theme moves, a dialog included', async () => {
    const ESC = String.fromCharCode(0x1b);
    // not pid 1, which the monitor refuses to kill without opening the dialog
    const app = mount({ colorLevel: 1, processes: [proc(4, 5, 1)] });
    await app.step();
    // the framework's accent is cyan, and violet's is magenta
    expect(app.term.output).toContain(`${ESC}[36m`);
    expect(app.term.output).not.toContain(`${ESC}[35m`);

    await app.press('t', 't');
    expect(app.term.output).toContain(`${ESC}[35mtheme: violet`);

    // a dialog is appended beside the app's root rather than inside it, so the
    // theme has to be on the host for the focused button's accent to follow
    await app.press('x');
    expect(app.term.output).toMatch(new RegExp(`${ESC}\\[35m\\[ No \\]`));
  });

  it('should reflow into a smaller screen', async () => {
    const app = mount({ processes: [proc(1, 5, 1)] });
    await app.step();
    app.term.resize(64, 20);
    await app.settle();
    const lines = app.term.viewport;
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(/^╭─ cpu · 2 cores ─+╮╭─ memory ─+╮$/);
    expect(lines.every((line) => [...line].length <= 64)).toBe(true);
    expect(app.screen()).toContain('proc-1');
  });

  it('should fit the screen however many cores there are, wrapping them into columns', async () => {
    // the root is a flex item of the runner's host, and a flex item keeps its
    // content's height as a minimum unless told otherwise: eighteen cores pushed
    // the screen past its bottom edge and never wrapped until runApp() gave the
    // root `min-height: 0`, which the stylesheet no longer has to say
    const app = mount({ cores: Array.from({ length: 18 }, () => 0.5), rows: 24 });
    await app.step();
    const lines = app.term.viewport;
    expect(lines.at(-1)).toContain('↑/↓ select');
    expect(lines.some((line) => /cpu0 .* cpu9 /.test(line))).toBe(true);
    expect(app.screen()).toContain('─ processes ·');
  });

  it('should stop sampling when it exits, and stop the reading still in flight', async () => {
    const app = mount();
    await app.step();
    expect(app.stopped).toBe(false);
    expect(app.samplerStopped).toBe(false);
    app.app.exit();
    await app.app.exited;
    expect(app.stopped).toBe(true);
    // what kills a `ps` still running, which would otherwise hold the process open
    expect(app.samplerStopped).toBe(true);
  });

  it('should not start a sample while the last one is still being read', async () => {
    let calls = 0;
    /** @type {(snap: object) => void} */
    let finish = () => {};
    const sample = () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const app = mount({ sample });
    await app.settle();
    expect(calls).toBe(1);

    // the clock ticks twice while the first reading is still out
    app.tick();
    app.tick();
    await app.settle();
    expect(calls).toBe(1);

    finish({ cores: [0.5], memory: { total: 2, used: 1 }, net: { rx: 0, tx: 0 }, processes: [] });
    await app.settle();
    app.tick();
    await app.settle();
    expect(calls).toBe(2);
  });

  it('should report a reading that fails, and read again on the next tick', async () => {
    let calls = 0;
    const sample = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('ps went away');
      }
      return { cores: [0.5], memory: { total: 2, used: 1 }, net: { rx: 0, tx: 0 }, processes: [] };
    };
    const app = mount({ sample });
    await app.settle();
    expect(app.screen()).toContain('could not read the system: ps went away');

    // a failed reading is over, so the next tick is not skipped as overlapping it,
    // and the one that lands takes the failure down
    app.tick();
    await app.settle();
    expect(calls).toBe(2);
    expect(app.screen()).not.toContain('could not read the system');
  });

  it('should take down only the failure it put up when a reading lands', async () => {
    const app = mount({ processes: [proc(3, 40, 3)] });
    await app.step();
    app.data.fail = 'ps went away';
    await app.step();
    expect(app.screen()).toContain('could not read the system: ps went away');

    // something else said something since, and that stays
    await app.press('s');
    await app.step();
    expect(app.screen()).toContain('sorted by mem');
  });

  // A chart draws in braille where the terminal can show it and in ASCII where
  // it cannot, and it asks `unicodeSupported()`, which reads the environment --
  // so the glyph set is pinned rather than left to the machine running the
  // suite. Windows without Windows Terminal is ASCII, which is how this test
  // failed on every Windows job while it assumed braille. `TERM` answers on
  // every platform; the rest are what Windows also asks, blanked so the ASCII
  // case is ASCII inside Windows Terminal too
  const GLYPHS = {
    ascii: {
      ConEmuTask: '',
      TERM: 'dumb',
      TERMINAL_EMULATOR: '',
      TERMINUS_SUBLIME: '',
      TERM_PROGRAM: '',
      WT_SESSION: '',
    },
    unicode: { TERM: 'xterm-256color' },
  };

  it.each([
    ['braille', 'unicode', /│ +│ +[⠁-⣿] +│$/m, / 0% ┤ +│$/m],
    ['ASCII', 'ascii', /│ +\| +\* +│$/m, / 0% \+ +│$/m],
  ])(
    'should draw the first memory sample on the history chart rather than a line along its floor, in %s',
    async (_name, glyphs, point, floor) => {
      for (const [key, value] of Object.entries(GLYPHS[glyphs])) {
        vi.stubEnv(key, value);
      }
      try {
        const app = mount();
        await app.step();
        const screen = app.screen();
        // the one reading, 50%, is a point mid-plot, and the row at 0% is empty
        expect(screen).toMatch(point);
        expect(screen).toMatch(floor);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
});
