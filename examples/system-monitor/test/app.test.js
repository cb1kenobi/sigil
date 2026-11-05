import { App, stylesheet } from '../src/root.js';
import { SystemContext } from '../src/system.js';
import { runApp } from '@ttylabs/sigil/app';
import { ESCAPE_TIMEOUT } from '@ttylabs/sigil/input';
import { provideContext } from '@ttylabs/sigil/renderer';
import { flush } from '@ttylabs/sigil/signals';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';
import { afterEach, describe, expect, it } from 'vitest';

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
  user: 'chris',
});

const mounted = [];

function mount({
  colorLevel = 0,
  columns = 100,
  cores = [0.25, 0.75],
  rows = 30,
  processes = [],
} = {}) {
  const term = createTestTerminal({ colorLevel, columns, rows });
  const data = { processes };
  let n = 0;
  let tick;
  let stopped = false;
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
    kill: (pid) => killed.push(pid),
    sampler: () => ({
      async sample() {
        n++;
        return {
          cores,
          memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3 },
          net: { rx: 1024 * n, tx: 512 * n },
          processes: data.processes,
        };
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
    screen,
    settle,
    step,
    get stopped() {
      return stopped;
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

  it('should keep the selection on the same process when a refresh reorders the table', async () => {
    const app = mount({ processes: [proc(1, 5, 1), proc(2, 90, 2), proc(3, 40, 3)] });
    await app.step();
    await app.press('j'); // proc-3, the second row

    // proc-3 moves from the second row to the third, so keeping the row would
    // pick proc-2 -- the pid is what has to be followed
    app.data.processes = [proc(1, 99, 1), proc(2, 60, 2), proc(3, 50, 3)];
    await app.step();
    await killRow(app, 0);
    expect(app.killed).toEqual([3]);
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
    const app = mount({ colorLevel: 1, processes: [proc(1, 5, 1)] });
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
    // content's height as a minimum unless told otherwise: eighteen cores then
    // pushed the screen past its bottom edge and never wrapped
    const app = mount({ cores: Array.from({ length: 18 }, () => 0.5), rows: 24 });
    await app.step();
    const lines = app.term.viewport;
    expect(lines.at(-1)).toContain('↑/↓ select');
    expect(lines.some((line) => /cpu0 .* cpu9 /.test(line))).toBe(true);
    expect(app.screen()).toContain('─ processes ·');
  });

  it('should stop sampling when it exits', async () => {
    const app = mount();
    await app.step();
    expect(app.stopped).toBe(false);
    app.app.exit();
    await app.app.exited;
    expect(app.stopped).toBe(true);
  });
});
