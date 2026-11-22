import { type MenuEntry, type MenuOptions, openMenu } from '../../src/components/menu.js';
import { Menubar, menubarControl } from '../../src/components/menubar.js';
import { topLayer } from '../../src/components/overlay.js';
import { box, text } from '../../src/element/index.js';
import { createInput, type InputRouter } from '../../src/input/index.js';
import { runApp } from '../../src/renderer/app.js';
import { createRoot } from '../../src/renderer/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { escape, HEIGHT, move, picture, rowOf, surface, WIDTH } from './menu-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A submenu whose `initial`, or whose check or radio mark, throws (SIG-600).
 *
 * The question was whether the session is left stuck, since SIG-463's entry says
 * Escape still closes it. It is not, and these are the proof over a real router and
 * a real renderer. What looked like a stuck session was the harness: a throw out of
 * a `data` listener of the test terminal's stdin, which is a `PassThrough`, wedges
 * that stream, so no later key reaches the router at all -- Down, Escape and every
 * other key included. That is the router without an `onError`, which is the caller's
 * to give one, and a real stdin has no such stream state to wedge: there the same
 * throw is an uncaught exception, which `runApp()` turns into a failed app (SIG-524).
 */

const routers: InputRouter[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  for (const input of routers.splice(0)) {
    input.stop();
  }
});

/** What can throw, and a submenu that holds it. */
const KINDS: Array<[string, (fail: () => boolean) => MenuEntry<string>[]]> = [
  [
    'an initial function',
    (fail) => [
      {
        initial: () => {
          if (fail()) {
            throw new Error('initial threw');
          }
          return 1;
        },
        items: [
          { label: 'Light', value: 'light' },
          { label: 'Dark', value: 'dark' },
        ],
        label: 'Theme',
      },
      { label: 'Quit', value: 'quit' },
    ],
  ],
  [
    'a radio mark',
    (fail) => [
      {
        items: [
          { label: 'Light', radio: false, value: 'light' },
          {
            label: 'Dark',
            radio: () => {
              if (fail()) {
                throw new Error('radio threw');
              }
              return true;
            },
            value: 'dark',
          },
        ],
        label: 'Theme',
      },
      { label: 'Quit', value: 'quit' },
    ],
  ],
  [
    'a check mark',
    (fail) => [
      {
        items: [
          {
            check: () => {
              if (fail()) {
                throw new Error('check threw');
              }
              return true;
            },
            label: 'Light',
            value: 'light',
          },
          { label: 'Dark', value: 'dark' },
        ],
        label: 'Theme',
      },
      { label: 'Quit', value: 'quit' },
    ],
  ],
];

/** A menu on a router that reports what its handlers throw and goes on. */
function scene(items: MenuEntry<string>[]) {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const errors: unknown[] = [];
  const field = text('Field', { focusable: true, id: 'field' });
  const root = box({ height: HEIGHT, position: 'relative', width: WIDTH }, field);
  const input = createInput({
    mouse: { motion: true, surface: surface() },
    onError: (error) => errors.push(error),
    root,
    terminal: term.terminal,
  });
  routers.push(input);
  picture(root);
  input.focus.focus(field);
  const opts: MenuOptions<string> = { ascii: false, at: field, input, items };
  const menu = openMenu<string>(root, opts);
  picture(root);
  return { errors, input, menu, root, term };
}

describe.each(KINDS)('a submenu with %s that throws', (_name, build) => {
  it('should stay on the parent menu when the key opens it, and let Escape close it', async () => {
    let failing = true;
    const s = scene(build(() => failing));
    await s.term.press(KEYS.right);
    expect(s.errors.map(String)).toEqual([expect.stringMatching(/threw/)]);
    expect(s.menu.open).toBe(true);
    // the parent alone: no half-built submenu, and the highlight where it was
    const before = picture(s.root);
    expect(before.some((line) => line.includes('Light'))).toBe(false);
    expect(before.find((line) => line.includes('❯'))).toContain('Theme');

    // the session still has the keys
    await s.term.press(KEYS.down);
    expect(picture(s.root).find((line) => line.includes('❯'))).toContain('Quit');
    await s.term.press(KEYS.up);

    // and what threw not throwing is all it takes to open
    failing = false;
    await s.term.press(KEYS.right);
    expect(s.errors).toHaveLength(1);
    expect(picture(s.root).some((line) => line.includes('Light'))).toBe(true);
    await s.term.press(KEYS.left);

    failing = true;
    await s.term.press(KEYS.right);
    expect(s.errors).toHaveLength(2);
    await escape(s.term);
    expect(s.menu.open).toBe(false);
    expect(await s.menu.result).toBeUndefined();
    expect(topLayer(s.input)).toBeUndefined();
    expect(picture(s.root).filter(Boolean)).toEqual(['Field']);
  });

  it('should stay on the parent menu when the pointer opens it, and let Escape close it', async () => {
    const s = scene(build(() => true));
    await s.term.press(move(6, rowOf(picture(s.root), 'Theme')));
    expect(s.errors.map(String)).toEqual([expect.stringMatching(/threw/)]);
    expect(s.menu.open).toBe(true);
    expect(picture(s.root).some((line) => line.includes('Light'))).toBe(false);
    // the hover moved the highlight to the row that threw, which is where the pointer is
    expect(picture(s.root).find((line) => line.includes('❯'))).toContain('Theme');
    // another row is still reachable by the pointer
    await s.term.press(move(6, rowOf(picture(s.root), 'Quit')));
    expect(picture(s.root).find((line) => line.includes('❯'))).toContain('Quit');
    await escape(s.term);
    expect(s.menu.open).toBe(false);
    expect(topLayer(s.input)).toBeUndefined();
  });

  it('should close on one Escape straight after the pointer hit the throw, with no level left behind', async () => {
    const s = scene(build(() => true));
    await s.term.press(move(6, rowOf(picture(s.root), 'Theme')));
    expect(s.errors).toHaveLength(1);
    await escape(s.term);
    expect(s.menu.open).toBe(false);
  });

  it('should end an app with 1 and give the terminal back, as any handler that throws does', async () => {
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const reports: unknown[] = [];
    const field = text('Field', { focusable: true });
    const app = runApp(() => box({}, field), {
      detect: false,
      onError: (error) => reports.push(error),
      terminal: term.terminal,
    });
    const input = app.input;
    if (input === undefined) {
      throw new Error('no router');
    }
    app.view.frame();
    input.focus.focus(field);
    const menu = openMenu<string>(app.view, {
      ascii: false,
      at: field,
      input,
      items: build(() => true),
    });
    app.view.frame();
    await term.press(KEYS.right);
    expect(await app.exited).toBe(1);
    expect(reports.map(String)).toEqual([expect.stringMatching(/threw/)]);
    // the renderer going closes the menu, so nothing is left holding the input
    expect(menu.open).toBe(false);
    expect(term.screen.alternate).toBe(false);
    expect(term.stdin.rawMode).toBe(false);
    expect(term.stdin.listenerCount('data')).toBe(0);
  });
});

describe('the harness that made a throwing submenu look stuck', () => {
  it('should deliver no later key once a throw has come out of the test terminal stdin', async () => {
    // no `onError`: the throw escapes the router's `data` listener, through the
    // `PassThrough` that is the test terminal's stdin, and that stream does not
    // recover. The menu is untouched -- it never saw the keys that follow
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const field = text('Field', { focusable: true, id: 'field' });
    const root = box({ height: HEIGHT, position: 'relative', width: WIDTH }, field);
    const input = createInput({
      mouse: { motion: true, surface: surface() },
      root,
      terminal: term.terminal,
    });
    routers.push(input);
    picture(root);
    input.focus.focus(field);
    const seen: string[] = [];
    field.onKey = (event) => {
      seen.push(event.key.name);
      if (event.key.name === 'x') {
        throw new Error('handler threw');
      }
    };
    await term.press('a');
    await expect(term.press('x')).rejects.toThrow(/handler threw/);
    await term.press('b');
    expect(seen).toEqual(['a', 'x']);
  });
});

describe('a root menu with a mark that throws', () => {
  it('should throw from openMenu() and leave the input with whoever had it', async () => {
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const field = text('Field', { focusable: true, id: 'field' });
    const root = box({ height: HEIGHT, position: 'relative', width: WIDTH }, field);
    const input = createInput({
      mouse: { motion: true, surface: surface() },
      onError: () => {},
      root,
      terminal: term.terminal,
    });
    routers.push(input);
    picture(root);
    input.focus.focus(field);
    const seen: string[] = [];
    field.onKey = (event) => {
      seen.push(event.key.name);
    };
    expect(() =>
      openMenu<string>(root, {
        ascii: false,
        at: field,
        input,
        items: [
          {
            check: () => {
              throw new Error('check threw');
            },
            label: 'Hidden',
            value: 'hidden',
          },
        ],
      })
    ).toThrow(/check threw/);
    expect(topLayer(input)).toBeUndefined();
    await term.press('a');
    expect(seen).toEqual(['a']);
    expect(picture(root).filter(Boolean)).toEqual(['Field']);
  });
});

describe('a menubar menu with a mark that throws', () => {
  it('should close the bar, and leave the keys with the body, when a key moves to it', async () => {
    // the menu is mixed, so `menuInitial()` never asks its marks and the throw comes
    // from building its rows -- after the menu that was open has been truncated. With
    // no level left Escape has nothing to close, so the session closes itself
    const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
    const errors: unknown[] = [];
    const holder = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH });
    const input = createInput({
      mouse: { motion: true, surface: surface() },
      onError: (error) => errors.push(error),
      root: holder,
      terminal: term.terminal,
    });
    routers.push(input);
    const body = text('Body', { focusable: true });
    const seen: string[] = [];
    body.onKey = (event) => {
      seen.push(event.key.name);
    };
    const bar = createRoot((dispose) => {
      disposers.push(dispose);
      return Menubar<string>({
        ascii: false,
        input,
        menus: [
          { items: [{ label: 'New', value: 'new' }], label: '&File' },
          {
            items: [
              {
                check: () => {
                  throw new Error('check threw');
                },
                label: 'Ruler',
                value: 'ruler',
              },
              { label: 'Plain', value: 'plain' },
            ],
            label: '&View',
          },
        ],
      });
    });
    holder.append(bar, body);
    picture(holder);
    input.focus.focus(body);
    const control = menubarControl(bar);
    control?.open(0);
    picture(holder);
    expect(control?.openIndex).toBe(0);

    await term.press(KEYS.right);
    expect(errors.map(String)).toEqual([expect.stringMatching(/check threw/)]);
    expect(control?.openIndex).toBeUndefined();
    expect(topLayer(input)).toBeUndefined();
    await term.press('a');
    expect(seen).toEqual(['a']);
  });
});
