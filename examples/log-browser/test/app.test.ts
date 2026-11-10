import { EnvironmentContext, type Environment, REAL } from '../src/browser.ts';
import * as jsx from '../src/root.tsx';
import * as tag from '../src/root.ui.ts';
import { type App, runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { ESCAPE_TIMEOUT } from '@ttylabs/sigil/input';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, frame, KEYS, type TestTerminal } from '@ttylabs/sigil/testing';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The browser run by `runApp()` over a test terminal, with the world behind
 * `EnvironmentContext` replaced: a seeded cluster, a short history, and a clock
 * the test turns by hand. Both roots, since the markup is the one thing the twins
 * do not share and a prop dropped from one of them is what this would catch.
 */

interface Mounted {
  app: App;
  press(...keys: string[]): Promise<void>;
  escape(): Promise<void>;
  screen(): string;
  settle(): Promise<void>;
  term: TestTerminal;
  tick(times?: number): Promise<void>;
}

const mounted: Mounted[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const it of mounted.splice(0)) {
    it.app.exit(0);
    await it.app.exited;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function mount(
  root: { App: () => Element; stylesheet: string },
  opts: Partial<Environment> & { columns?: number; mouse?: boolean; rows?: number } = {}
): Promise<Mounted> {
  const term = createTestTerminal({ columns: opts.columns ?? 100, rows: opts.rows ?? 20 });
  let tick: (() => void) | undefined;
  const env: Environment = {
    ...REAL,
    backlog: 500,
    clock: {
      every(_ms, fn) {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
    },
    ...opts,
  };
  const app = runApp(() => provideContext(EnvironmentContext, env, root.App), {
    detect: false,
    gatherStats: true,
    mouse: opts.mouse ?? false,
    sheets: [root.stylesheet],
    terminal: term.terminal,
  });

  // an effect, the frame it asks for, and an effect that frame wakes are each a
  // turn of their own
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await frame(app);
    }
  };
  const it: Mounted = {
    app,
    async escape() {
      await term.press(KEYS.escape);
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
      await settle();
    },
    async press(...keys) {
      for (const key of keys) {
        await term.press(key);
        await settle();
      }
    },
    screen: () => term.viewport.join('\n'),
    settle,
    term,
    async tick(times = 1) {
      for (let i = 0; i < times; i++) {
        tick?.();
      }
      await settle();
    },
  };
  mounted.push(it);
  await settle();
  return it;
}

/** A log line or a table row as drawn, less the scrollbar, whose thumb moves as lines arrive. */
const unbarred = (line: string): string => line.slice(0, -4);

/** The row the cursor is on. */
const cursorRow = (it: Mounted): string =>
  unbarred(it.term.viewport.find((line) => line.includes('❯')) ?? '');

/** The log lines on screen. */
const logLines = (it: Mounted): string[] =>
  it.term.viewport.filter((line) => /\d\d:\d\d:\d\d\.\d{3} /.test(line)).map(unbarred);

/** Every element under one, depth first. */
const walk = (el: Element): Element[] => [el, ...el.children.flatMap(walk)];

/** A wheel notch over a cell, as a terminal reports one in SGR mode. */
const wheel = (direction: 'down' | 'up', x: number, y: number): string =>
  `\u001b[<${direction === 'up' ? 64 : 65};${x};${y}M`;

describe.each([
  ['jsx', jsx],
  ['ui', tag],
])('the log browser, in %s', (_, root) => {
  it('should open on the pods, and go between views with the : bar', async () => {
    const it = await mount(root);
    expect(it.screen()).toMatch(/pods · 18/);
    expect(it.screen()).toMatch(/NAMESPACE +NAME +STATUS/);

    await it.press(':', 's', 'v', 'c');
    expect(it.screen()).toMatch(/:\s+svc\s+→ services/);
    await it.press(KEYS.enter);
    expect(it.screen()).toMatch(/services · 10/);
    expect(it.screen()).toMatch(/CLUSTER-IP/);

    // a fuzzy match, completed with Tab
    await it.press(':', 'd', 'p', 'l', KEYS.tab);
    expect(it.screen()).toMatch(/:\s+deployments/);
    await it.press(KEYS.enter);
    expect(it.screen()).toMatch(/deployments · 10/);

    await it.press(':', 'n', 'o', 'p', 'e', KEYS.enter);
    expect(it.screen()).toMatch(/no command "nope"/);

    // Escape walks back the way it came
    await it.escape();
    expect(it.screen()).toMatch(/services · 10/);
    await it.escape();
    expect(it.screen()).toMatch(/pods · 18/);

    await it.press(':', 'q', KEYS.enter);
    expect(await it.app.exited).toBe(0);
  });

  it('should take a command typed in one read, as a paste or a fast hand sends it', async () => {
    // `:` shows the bar and focuses its field, and the four keys after it arrive
    // before any frame has run: they are the field's, not the table's `l`
    const it = await mount(root);
    await it.press(':logs\r');
    expect(it.screen()).toMatch(/logs · all pods · 500 lines/);
    await it.press(':svc\r');
    expect(it.screen()).toMatch(/services · 10/);
  });

  it('should keep the table live, and draw a pod in trouble in its role', async () => {
    const it = await mount(root, { rows: 30 });
    const before = it.screen();
    // a second at a time until a pod crashes, which the seeded cluster does early
    let crashed: string | undefined;
    for (let s = 0; s < 60 && crashed === undefined; s++) {
      await it.tick(4);
      crashed = it.term.viewport.find((line) => line.includes('CrashLoopBackOff'));
    }
    expect(it.screen()).not.toBe(before);
    const app = /\b([a-z]+)-\S+ +CrashLoopBackOff +1 /.exec(crashed ?? '')?.[1];
    expect(app).toBeDefined();
    const cell = walk(it.app.view.root).find(
      (el) => el.text === 'CrashLoopBackOff' && el.classes.includes('sigil-error')
    );
    expect(cell).toBeDefined();

    // and its deployment is a replica short
    await it.press(':', 'd', 'e', 'p', 'l', 'o', 'y', KEYS.enter);
    const row = it.term.viewport.find((line) => line.includes(` ${app} `)) ?? '';
    const [, ready, desired] = /(\d)\/(\d)/.exec(row) ?? [];
    expect(Number(ready)).toBe(Number(desired) - 1);
  });

  it('should filter a table as the filter is typed, and drop it on Escape', async () => {
    const it = await mount(root);
    await it.press('/', 'w', 'r', 'k');
    expect(it.screen()).toMatch(/pods · 4 of 18/);
    expect(it.term.viewport.filter((line) => /worker-/.test(line))).toHaveLength(4);

    // Enter keeps it and hands the keys back to the table
    await it.press(KEYS.enter);
    expect(it.screen()).toMatch(/pods · 4 of 18 .*\/wrk/);
    await it.press(KEYS.down);
    expect(cursorRow(it)).toMatch(/worker-/);

    // a describe and back is still the filtered table
    await it.press(KEYS.enter);
    expect(it.screen()).toMatch(/describe · pods · worker-/);
    await it.escape();
    expect(it.screen()).toMatch(/pods · 4 of 18 .*\/wrk/);

    await it.escape();
    expect(it.screen()).toMatch(/pods · 18 /);
  });

  it('should describe a row in a pager, search it, and come back to the row', async () => {
    const it = await mount(root);
    await it.press(KEYS.down, KEYS.down);
    const row = cursorRow(it);
    const name = /\b(api-\S+)/.exec(row)?.[1] as string;
    expect(name).toBeDefined();

    await it.press(KEYS.enter);
    expect(it.screen()).toContain(`describe · pods · ${name}`);
    expect(it.screen()).toMatch(/Namespace: +default/);

    // the pager's own search, Enter to run it
    await it.press('/', 'R', 'e', 's', 't', 'a', 'r', 't', KEYS.enter);
    expect(it.screen()).toMatch(/Restart Count: +0/);

    // the first Escape clears the pager's search, the second goes back
    await it.escape();
    await it.escape();
    expect(it.screen()).toMatch(/pods · 18/);
    expect(cursorRow(it)).toContain(name);
    // and the pager goes with its view, rather than waiting under it for the next
    expect(walk(it.app.view.root).some((el) => el.text.includes('Restart Count'))).toBe(false);

    // and the next describe is a pager of its own, the last one gone with its view
    await it.press(KEYS.down, KEYS.enter);
    const next = /\b(web-\S+)/.exec(it.screen())?.[1] as string;
    expect(it.screen()).toMatch(new RegExp(`Name: +${next}`));
    expect(it.screen()).not.toContain(name);
  });

  it("should open the current pod's logs on l, and only that pod's", async () => {
    const it = await mount(root);
    const name = /\b(api-\S+)/.exec(cursorRow(it))?.[1] as string;
    await it.press('l');
    expect(it.screen()).toMatch(new RegExp(`logs · ${name} · \\d+ of 500 lines`));
    const lines = logLines(it);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line).toContain(name);
    }
    await it.escape();
    expect(it.screen()).toMatch(/pods · 18/);
  });

  it('should follow new lines, stop when the cursor leaves the newest, and start again on End', async () => {
    const it = await mount(root);
    await it.press(':', 'l', 'o', 'g', 's', KEYS.enter);
    expect(it.screen()).toMatch(/following/);
    const first = cursorRow(it);
    // the newest line is the last one drawn, and the cursor is on it
    expect(logLines(it).at(-1)).toBe(first);

    await it.tick(4);
    expect(it.screen()).toMatch(/following/);
    const newest = cursorRow(it);
    expect(newest).not.toBe(first);
    expect(logLines(it).at(-1)).toBe(newest);

    // reading history: the next lines arrive under the screen, not on it
    await it.press(KEYS.up);
    expect(it.screen()).toMatch(/paused/);
    const reading = logLines(it);
    const held = cursorRow(it);
    await it.tick(4);
    expect(cursorRow(it)).toBe(held);
    expect(logLines(it)).toStrictEqual(reading);

    await it.press(KEYS.end);
    expect(it.screen()).toMatch(/following/);
    await it.tick(2);
    expect(logLines(it).at(-1)).toBe(cursorRow(it));
    expect(cursorRow(it)).not.toBe(held);

    // and it goes on following while another view is up
    await it.press(':', 'p', 'o', KEYS.enter);
    await it.tick(4);
    await it.press(':', 'l', 'o', 'g', KEYS.enter);
    expect(it.screen()).toMatch(/following/);
    expect(logLines(it).at(-1)).toBe(cursorRow(it));

    // F stops and starts it too
    await it.press('F');
    expect(it.screen()).toMatch(/paused/);
    await it.press('F');
    expect(it.screen()).toMatch(/following/);
  });

  it('should stop following when the wheel scrolls up, rather than pulling the reader back', async () => {
    const it = await mount(root, { mouse: true });
    await it.press(':', 'l', 'o', 'g', 's', KEYS.enter);
    expect(it.screen()).toMatch(/following/);
    await it.press(wheel('up', 20, 8), wheel('up', 20, 8));
    const reading = logLines(it);
    await it.tick(4);
    expect(it.screen()).toMatch(/paused/);
    expect(logLines(it)).toStrictEqual(reading);
  });

  it('should search with /, step with n and N, and filter with &', async () => {
    const it = await mount(root);
    await it.press(':', 'l', 'o', 'g', 's', KEYS.enter);
    await it.press('/', 'u', 'p', 's', 't', 'r', 'e', 'a', 'm', KEYS.enter);
    expect(cursorRow(it)).toMatch(/upstream ledger: connection refused/);
    const found = /^\D*(\S+)/.exec(cursorRow(it))?.[1];
    const status = /\/upstream: line (\d+) of 500, (\d+) lines match/.exec(it.screen());
    expect(status).not.toBeNull();
    const [, at, count] = status as RegExpExecArray;
    expect(Number(count)).toBeGreaterThan(1);

    // n wraps round to the first match, so N comes back to where we were
    await it.press('n');
    expect(cursorRow(it)).toMatch(/upstream/);
    expect(it.screen()).not.toMatch(new RegExp(`line ${at} of`));
    await it.press('N');
    expect(it.screen()).toMatch(new RegExp(`line ${at} of 500`));
    expect(cursorRow(it)).toContain(found);

    // & keeps only the lines that match, case-insensitively until a capital is typed
    await it.press('&', 'u', 'p', 's', 't', 'r', 'e', 'a', 'm', KEYS.enter);
    expect(it.screen()).toMatch(new RegExp(`logs · all pods · ${count} of 500 lines`));
    expect(logLines(it).length).toBeGreaterThan(0);
    for (const line of logLines(it)) {
      expect(line).toContain('upstream');
    }
    expect(it.screen()).toMatch(/&upstream/);
    await it.press('&', KEYS.backspace, KEYS.backspace, KEYS.backspace, KEYS.backspace);
    await it.press(KEYS.backspace, KEYS.backspace, KEYS.backspace, KEYS.backspace);
    await it.press('U', 'p', 's', 't', 'r', 'e', 'a', 'm', KEYS.enter);
    expect(it.screen()).toMatch(/0 of 500 lines/);
    expect(it.screen()).toContain('No lines match');
  });

  it('should show the less urgent levels or not, on L', async () => {
    const it = await mount(root);
    await it.press(':', 'l', 'o', 'g', 's', KEYS.enter);
    await it.press('L', 'L');
    expect(it.screen()).toMatch(/showing warn and worse/);
    expect(logLines(it).length).toBeGreaterThan(0);
    for (const line of logLines(it)) {
      expect(line).toMatch(/ (WARN |ERROR) /);
    }
    await it.press('L', 'L');
    expect(it.screen()).toMatch(/showing every level/);
  });

  it("should draw a line in its level's role, and what the search matched reversed", async () => {
    const it = await mount(root);
    await it.press(
      ':',
      'l',
      'o',
      'g',
      's',
      KEYS.enter,
      '/',
      'u',
      'p',
      's',
      't',
      'r',
      'e',
      'a',
      'm'
    );
    await it.press(KEYS.enter);
    // the screen keeps characters and not their colours, so this reads the tree
    // the colours are drawn from: a role class on the line, `match` on the run
    const lines = walk(it.app.view.root).filter((el) => el.classes.includes('log-line'));
    const error = lines.find((el) => el.children.some((run) => run.text.includes('upstream')));
    expect(error?.classes).toContain('sigil-error');
    const runs = error?.children ?? [];
    expect(
      runs.filter((run) => run.classes.includes('match')).map((run) => run.text)
    ).toStrictEqual(['upstream']);
    // a search redraws the lines already on screen, not only the ones it scrolls
    // to: a line in view is found where it is, and the view does not move
    const time = /\d\d:\d\d:\d\d\.\d{3}/.exec(logLines(it).at(-3) ?? '')?.[0] as string;
    await it.press('/', ...time, KEYS.enter);
    const found = walk(it.app.view.root).find(
      (el) => el.classes.includes('match') && el.text === time
    );
    expect(found).toBeDefined();

    // and every line on screen in its own level's role
    const roles = { DEBUG: 'sigil-muted', ERROR: 'sigil-error', WARN: 'sigil-warn' };
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const text = line.children.map((run) => run.text).join('');
      const level = / (DEBUG|INFO|WARN|ERROR) /.exec(text)?.[1] as string;
      const role = roles[level as keyof typeof roles];
      if (role === undefined) {
        expect(line.classes.filter((name) => name.startsWith('sigil-'))).toStrictEqual([]);
      } else {
        expect(line.classes).toContain(role);
      }
    }
  });
});

describe('a log at its cap', () => {
  it('should let the oldest lines go, from the log and from the view', async () => {
    const it = await mount(tag, { backlog: 500, maxLines: 510 });
    await it.press(':', 'l', 'o', 'g', 's', KEYS.enter);
    await it.press(KEYS.home);
    const first = cursorRow(it);
    await it.tick(12);
    expect(it.screen()).toMatch(/logs · all pods · 510 lines/);
    await it.press(KEYS.home);
    expect(cursorRow(it)).not.toBe(first);
  });
});

describe('a log file', () => {
  it('should be read whole, then followed as it grows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-browser-'));
    dirs.push(dir);
    const file = join(dir, 'app.log');
    writeFileSync(
      file,
      [
        '2026-11-10T09:00:00Z INFO starting',
        '2026-11-10T09:00:01Z WARN disk at 81%',
        '2026-11-10T09:00:02Z ERROR could not reach db',
        '',
      ].join('\n')
    );
    const it = await mount(tag, { file });
    expect(it.screen()).toContain('file: ');
    expect(it.screen()).toMatch(/logs · .*app\.log · 3 lines/);
    expect(cursorRow(it)).toContain('could not reach db');

    // half a line is held until its newline arrives
    appendFileSync(file, '2026-11-10T09:00:03Z INFO recon');
    await it.tick();
    expect(it.screen()).toMatch(/3 lines/);
    appendFileSync(file, 'nected\n');
    await it.tick();
    expect(it.screen()).toMatch(/4 lines/);
    expect(cursorRow(it)).toContain('INFO reconnected');

    await it.press('L', 'L', 'L');
    expect(it.screen()).toMatch(/1 of 4 lines/);
    expect(it.screen()).toContain('could not reach db');
  });
});

describe('fifty thousand lines', () => {
  it('should build only the rows on screen', async () => {
    const it = await mount(tag, { backlog: 50_000 });
    await it.press(':', 'l', 'o', 'g', 's', KEYS.enter);
    expect(it.screen()).toMatch(/50,000 lines/);
    await it.tick(8);
    await it.press(KEYS.pageUp, KEYS.pageUp, KEYS.home);
    const last = it.app.view.stats;
    // the whole tree, three tables and their rows included: a log that built a row
    // per line would be fifty thousand of them
    expect(last?.elements).toBeLessThan(2000);
    expect(it.screen()).toMatch(/50,0\d\d lines/);
  });
});
