import { type Day, traffic } from '../src/data.ts';
import { compact } from '../src/metrics.ts';
import { App, stylesheet } from '../src/root.tsx';
import { type App as RunningApp, runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { ESCAPE_TIMEOUT } from '@ttylabs/sigil/input';
import { createTestTerminal, ctrl, frame, KEYS } from '@ttylabs/sigil/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard run by `runApp()` over a fake terminal: what `src/index.ts`
 * does, minus the real terminal. Every test drives it with keys and reads the
 * screen, the way somebody using it would.
 */

/** Every app a test started, so a failed assertion still gives its terminal back. */
const running: RunningApp[] = [];

// the borders, the list's pointer and the sidebar's glyphs are drawn from the
// environment, and a Windows runner says ASCII: these say what a terminal that
// draws box characters is, so the screens below are the same on every runner
beforeEach(() => {
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('WT_SESSION', '1');
});
afterEach(() => {
  for (const app of running.splice(0)) {
    app.exit();
  }
  vi.unstubAllEnvs();
});

/**
 * Runs the dashboard over a fake terminal.
 *
 * @param opts - The terminal's size, wide and tall enough by default for every
 *   region to be on screen with the sidebar open, and a colour level for a test
 *   that reads a colour: the test terminal has none, and level 0 drops them all.
 * @returns The app, and ways to press keys and read what is drawn.
 */
function mount({
  colorLevel,
  columns = 120,
  rows = 40,
}: { colorLevel?: 0 | 3; columns?: number; rows?: number } = {}) {
  const term = createTestTerminal({ columns, rows });
  const app = runApp(App, {
    colorLevel,
    detect: false,
    // with motion, as `src/index.ts` asks: the chart's crosshair follows a pointer
    // with no button held
    mouse: { motion: true },
    sheets: [stylesheet],
    terminal: term.terminal,
  });
  running.push(app);

  // a key, the effect it wakes and the frame that effect asks for are each a
  // turn of their own
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await frame(app);
    }
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      await term.press(key);
      await settle();
    }
  };
  const type = async (text: string) => press(...text);
  const screen = () => term.viewport.join('\n');
  /** The first line on screen that holds `text`. */
  const line = (text: string) => term.viewport.find((each) => each.includes(text)) ?? '';
  /** The table's rows on screen, by the project name in each. */
  const rows_ = () =>
    term.viewport
      .map((each) => /[❯ ] [◯◉] ([★ ]*[a-z]+-[a-z]+)/.exec(each)?.[1]?.replace('★ ', ''))
      .filter((name): name is string => name !== undefined);
  const escape = async () => {
    await term.press(KEYS.escape);
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
    await settle();
  };
  /** Tabs from the sidebar to the table: the search, the menu, the range, the table. */
  const toTable = async () => press(KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab);

  return { app, escape, line, press, rows: rows_, screen, settle, term, toTable, type };
}

/** The background the theme gives the app's root, which `System` leaves to the terminal. */
function background(app: RunningApp): unknown {
  const root: Element = app.view.root;
  return root.style.backgroundColor;
}

/** Every element under `root`, and `root`, that wears `name`. */
function withClass(root: Element, name: string): Element[] {
  return [
    ...(root.classes.includes(name) ? [root] : []),
    ...root.children.flatMap((child) => withClass(child, name)),
  ];
}

/** The figure on the last card, which counts the projects that are not paused. */
function active(screen: string): number {
  const figures = screen.split('\n').find((each) => each.includes('$'));
  return Number(/│ (\d+) +│\s*$/.exec(figures ?? '')?.[1]);
}

describe('the dashboard', () => {
  it('should open on the overview: the sidebar focused, four cards, the chart and a page of the table', async () => {
    const s = mount();
    await s.settle();
    const screen = s.screen();
    expect(s.line('Larkspur')).toContain('Overview · production · Nov 16');
    for (const title of ['Revenue', 'Requests', 'Error rate', 'Active projects']) {
      expect(screen).toContain(`─ ${title} ─`);
    }
    expect(screen).toContain('─ Traffic ─');
    expect(screen).toContain('7 days  30 days  90 days');
    expect(screen).toContain('─ Projects ─');
    expect(screen).toContain('46 projects');
    expect(screen).toContain('Page 1 of 5');
    expect(s.rows()).toHaveLength(10);
    // the sidebar has the cursor, so the arrows move between pages
    expect(s.screen()).toMatch(/❯ ◆ Overview/);
  });

  it('should show another page from the sidebar, and come back to the overview', async () => {
    const s = mount();
    await s.press(KEYS.down);
    expect(s.line('Larkspur')).toContain('Analytics · production');
    expect(s.screen()).toContain('Analytics is where an app would put a page of its own');
    expect(s.screen()).not.toContain('─ Traffic ─');
    await s.press(KEYS.up);
    expect(s.screen()).toContain('─ Traffic ─');
  });

  it('should collapse the sidebar to its glyphs on ctrl+b, and bring it back', async () => {
    const s = mount();
    await s.press(ctrl('b'));
    expect(s.screen()).not.toContain('Larkspur');
    expect(s.screen()).not.toContain('Analytics');
    expect(s.screen()).toContain('◔');
    expect(s.screen()).not.toContain('Pro plan usage');
    await s.press(ctrl('b'));
    expect(s.screen()).toContain('Larkspur');
    expect(s.screen()).toContain('◔ Analytics');
    expect(s.screen()).toContain('Pro plan usage');
  });

  it('should start with the sidebar collapsed on a narrow terminal', async () => {
    const s = mount({ columns: 90, rows: 30 });
    await s.settle();
    expect(s.screen()).not.toContain('Larkspur');
    expect(s.screen()).toContain('❯ ◆');
  });

  it('should draw something on the smallest screen the contract tests use', async () => {
    const s = mount({ columns: 60, rows: 16 });
    await s.settle();
    expect(s.screen()).toContain('─ Projects ─');
    expect(s.screen()).toContain('$60,642');
  });
});

describe('the range', () => {
  it('should move the chart and the cards together, from r and from the tab row', async () => {
    const s = mount();
    await s.settle();
    expect(s.screen()).toContain('Requests a day for the last 30 days');
    expect(s.screen()).toContain('vs prior 30d');

    await s.press('r');
    expect(s.screen()).toContain('Requests a day for the last 90 days');
    expect(s.screen()).toContain('vs prior 90d');

    // the tab row is the third stop from the sidebar, and a digit picks a range
    await s.press(KEYS.tab, KEYS.tab, KEYS.tab, '1');
    expect(s.screen()).toContain('Requests a day for the last 7 days');
    expect(s.screen()).toContain('vs prior 7d');
  });

  it("should rewrite each card's badge in place when the range moves", async () => {
    const s = mount();
    await s.settle();
    // level 0 draws a badge in brackets, and the badges share a line with their notes
    const badges = (): string[] => s.line('from ').match(/\[[^\]]+\]/g) ?? [];
    const before = badges();
    expect(before.length).toBe(4);
    const elements = withClass(s.app.view.root, 'sigil-badge');
    expect(elements.length).toBe(4);

    await s.press('r');

    // the same four elements, written to rather than replaced
    expect(withClass(s.app.view.root, 'sigil-badge')).toEqual(elements);

    const after = badges();
    expect(after.length).toBe(4);
    expect(after).not.toEqual(before);
  });

  it('should put the first and last day of the range under the chart', async () => {
    const s = mount();
    await s.press('r', 'r');
    // seven days ending on the fixed last day
    expect(s.screen()).toMatch(/Nov 10 +Nov 16/);
  });
});

describe('the chart', () => {
  it('should shade under both lines', async () => {
    const s = mount();
    await s.settle();
    // a screen of every other dot, which is a braille cell of two dots on its left
    expect(s.screen()).toMatch(/⠅⠅⠅/);
  });

  it("should follow the pointer with a rule and that day's figures", async () => {
    const s = mount();
    await s.press('r', 'r');
    const labels = s.term.viewport.findIndex((each) => /Nov 10 +Nov 16/.test(each));
    const axis = s.term.viewport[labels - 1] ?? '';
    // the last day is at the plot's right edge, which is where its axis ends
    const x = axis.lastIndexOf('─');
    const y = labels - 3;
    // an SGR report counts from one, and 35 is a move with no button held
    await s.press(`\u001b[<35;${x + 1};${y + 1}M`);
    expect(s.term.viewport[labels - 1]?.[x]).toBe('┴');
    const last = traffic().at(-1) as Day;
    expect(s.screen()).toContain(`│ Nov 16`);
    expect(s.screen()).toContain(`API ${compact(last.api)}`);
    expect(s.screen()).toContain(`Web ${compact(last.web)}`);

    // and the rule goes with the pointer, off the chart onto the table
    await s.press(`\u001b[<35;${x + 1};${labels + 6}M`);
    expect(s.term.viewport[labels - 1]).not.toContain('┴');
    expect(s.screen()).not.toContain(`API ${compact(last.api)}`);
  });
});

describe('the table', () => {
  it('should sort every page by a heading digit, and turn pages with ] and [', async () => {
    const s = mount();
    await s.toTable();
    // the first column is the project's name
    await s.press('1');
    const first = s.rows();
    expect(first).toStrictEqual([...first].sort());
    await s.press(']');
    expect(s.screen()).toContain('Page 2 of 5');
    const second = s.rows();
    expect(second).toStrictEqual([...second].sort());
    // the second page carries on from the first, rather than being sorted on its own
    expect((second[0] ?? '') > (first.at(-1) ?? '')).toBe(true);
    await s.press('[');
    expect(s.screen()).toContain('Page 1 of 5');
    expect(s.rows()).toStrictEqual(first);
  });

  it('should keep the ticks across pages and count them under the table', async () => {
    const s = mount();
    await s.toTable();
    await s.press(KEYS.space);
    await s.press(']');
    await s.press(KEYS.space);
    expect(s.screen()).toContain('2 of 46 selected');
    await s.press('[');
    expect(s.line('◉')).not.toBe('');
  });

  it('should hold more rows a page when the dropdown says so', async () => {
    const s = mount({ columns: 120, rows: 50 });
    await s.toTable();
    // past the table are the dropdown and the next button
    await s.press(KEYS.tab, KEYS.enter, KEYS.down, KEYS.enter);
    expect(s.screen()).toContain('Page 1 of 3');
    expect(s.rows()).toHaveLength(20);
  });

  it('should open a menu on a row, and pause the project from it', async () => {
    const s = mount();
    await s.toTable();
    const name = s.rows()[0] ?? '';
    const before = active(s.screen());
    await s.press(KEYS.enter);
    expect(s.screen()).toContain('Pause');
    expect(s.screen()).toContain('Redeploy');
    await s.press('p');
    expect(s.screen()).toContain(`Paused ${name}`);
    expect(s.line(`◯ ${name}`)).toContain('○ Paused');
    expect(active(s.screen())).toBe(before - 1);
  });

  it('should pause the row on p with rows ticked, the ticked rows being a submenu of their own', async () => {
    const s = mount();
    await s.toTable();
    const [first, second] = s.rows();
    await s.press(KEYS.down, KEYS.space, KEYS.up, KEYS.enter);
    expect(s.screen()).toContain('Ticked (1)');
    // one press: a letter two items at one level share only steps between them
    await s.press('p');
    expect(s.screen()).toContain(`Paused ${first}`);
    expect(s.line(`${second}`)).toContain('Healthy');
  });

  it('should bring a degraded project back degraded when it is resumed', async () => {
    const s = mount();
    await s.toTable();
    // the status column, degraded first
    await s.press('2');
    const name = s.rows()[0] ?? '';
    expect(s.line(`◯ ${name}`)).toContain('Degraded');
    await s.press(KEYS.enter, 'p');
    expect(s.line(`◯ ${name}`)).toContain('Paused');
    // a paused project sorts after the degraded ones, so find it by name
    await s.press('/');
    await s.type(name);
    await s.press(KEYS.enter, KEYS.enter, 'r');
    expect(s.screen()).toContain(`Resumed ${name}`);
    expect(s.line(`◯ ${name}`)).toContain('Degraded');
  });

  it('should open the menu under the row that was double-clicked', async () => {
    const s = mount();
    await s.toTable();
    const name = s.rows()[3] ?? '';
    const y = s.term.viewport.findIndex((each) => each.includes(`◯ ${name}`));
    const x = (s.term.viewport[y] ?? '').indexOf(name) + 1;
    const row = (s.term.viewport[y] ?? '').slice(x - 1);
    const click = `\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`;
    // both clicks in one read, as a fast double click arrives: the cursor moves
    // and the row activates before the effect that moves `is-current` has run
    await s.press(click + click);
    // the menu opens under the clicked row, not under the row the cursor was on
    expect(s.term.viewport[y + 1]).toMatch(/╭─+╮/);
    expect(s.term.viewport[y + 2]).toContain('Pause');
    // and leaves the row itself, its name and every figure in it, in view
    expect((s.term.viewport[y] ?? '').slice(x - 1)).toBe(row);
  });

  it('should open the menu above the last row of a page, and leave the row in view', async () => {
    const s = mount({ columns: 120, rows: 30 });
    await s.toTable();
    await s.press(KEYS.end);
    const name = s.rows().at(-1) ?? '';
    const y = s.term.viewport.findIndex((each) => each.includes(`❯ ◯ ${name}`));
    const row = s.term.viewport[y] ?? '';
    await s.press(KEYS.enter);
    // thirty rows leave too few lines under the last row for the menu, so it
    // ends on the line above
    expect(s.term.viewport[y - 1]).toMatch(/╰─+╯/);
    expect(s.screen()).toContain('Redeploy');
    expect(s.term.viewport[y]).toBe(row);
  });

  it('should ask before deleting, take No for an answer, and delete on Yes', async () => {
    const s = mount();
    await s.toTable();
    const name = s.rows()[0] ?? '';
    await s.press(KEYS.enter, 'd');
    expect(s.screen()).toContain('Delete project');
    // the dialog opens on No, so a reflexive Enter loses nothing
    await s.press(KEYS.enter);
    expect(s.screen()).toContain('46 projects');
    expect(s.rows()).toContain(name);

    await s.press(KEYS.enter, 'd', KEYS.tab, KEYS.enter);
    expect(s.screen()).toContain('45 projects');
    expect(s.rows()).not.toContain(name);
    expect(s.screen()).toContain(`Deleted ${name}`);
  });

  it('should offer the ticked rows in the menu, wherever they are', async () => {
    const s = mount();
    await s.toTable();
    await s.press(KEYS.space, KEYS.down, KEYS.space, KEYS.enter);
    expect(s.screen()).toContain('Ticked (2)');
    await s.press('t', 'p');
    expect(s.screen()).toContain('Paused 2 projects');
  });
});

describe('the search', () => {
  it('should filter the table as it is typed, and say when nothing matches', async () => {
    const s = mount();
    await s.press('/');
    await s.type('mara');
    expect(s.screen()).toMatch(/\d+ of 46 match/);
    for (const row of s.term.viewport.filter((each) => /[◯◉] [a-z]+-/.test(each))) {
      expect(row).toContain('mara');
    }
    await s.type(' zzz');
    expect(s.screen()).toContain('No project matches the search');
  });

  it('should keep q as a letter while the search has the focus', async () => {
    const s = mount();
    await s.press('/', 'q');
    expect(s.app.running).toBe(true);
    expect(s.line('mara ▾')).toContain('q');
  });

  it('should clear on Escape, and hand the focus to the table on a second Escape', async () => {
    const s = mount();
    await s.press('/');
    await s.type('kofi');
    await s.escape();
    expect(s.screen()).toContain('46 projects');
    await s.escape();
    // the table has the focus: Space ticks its current row
    await s.press(KEYS.space);
    expect(s.screen()).toContain('1 of 46 selected');
  });
});

describe('the themes', () => {
  it('should paint its own background for light and dark, and none for the terminal’s own', async () => {
    const s = mount({ colorLevel: 3 });
    await s.settle();
    const system = background(s.app);
    await s.press('t');
    const light = background(s.app);
    await s.press('t');
    const dark = background(s.app);
    await s.press('t');
    expect(light).not.toStrictEqual(system);
    expect(dark).not.toStrictEqual(system);
    expect(dark).not.toStrictEqual(light);
    expect(background(s.app)).toStrictEqual(system);
  });

  // the defect: the scheme was read once at start, so a Light theme on a dark
  // terminal could not say it was light and restated what the framework's light half
  // would have drawn. The scheme the cascade is asked about follows the theme now
  it('should resolve against the scheme of the theme in use, and the terminal’s for System', async () => {
    const s = mount({ colorLevel: 3 });
    await s.settle();
    const scheme = (): string => s.app.cascade.media.colorScheme;
    const terminals = scheme();
    await s.press('t');
    expect(scheme()).toBe('light');
    await s.press('t');
    expect(scheme()).toBe('dark');
    await s.press('t');
    expect(scheme(), 'System did not give the choice back').toBe(terminals);
  });

  it('should switch theme from the account menu', async () => {
    const s = mount({ colorLevel: 3 });
    await s.settle();
    const system = background(s.app);
    // the search, then the account menu's button
    await s.press(KEYS.tab, KEYS.tab, KEYS.enter);
    expect(s.screen()).toContain('Theme');
    expect(s.screen()).toContain('Collapse sidebar');
    await s.press('t', 'd');
    expect(background(s.app)).not.toStrictEqual(system);
  });

  it('should open the Theme submenu on the theme in use, not on its first', async () => {
    const s = mount();
    await s.settle();
    // Dark, two presses on from System
    await s.press('t', 't');
    await s.press(KEYS.tab, KEYS.tab, KEYS.enter, KEYS.right);
    expect(s.line('❯ ● Dark')).toBeDefined();
    expect(s.screen()).not.toContain('❯ System');
    // Enter keeps it rather than going back to the first, and the focus is
    // still on the button, so Enter opens the menu again
    await s.press(KEYS.enter);
    await s.press(KEYS.enter, KEYS.right);
    expect(s.line('❯ ● Dark')).toBeDefined();
  });
});
