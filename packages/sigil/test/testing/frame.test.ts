import { box, type Element, text } from '../../src/element/index.js';
import { type App, runApp, useApp } from '../../src/renderer/app.js';
import { onMount, render } from '../../src/renderer/index.js';
import { State } from '../../src/signals/index.js';
import { parseStylesheet } from '../../src/style/index.js';
import { Cascade } from '../../src/style/index.js';
import { ui } from '../../src/template/index.js';
import { createTerminal, type OutputStream } from '../../src/terminal/index.js';
import { frame } from '../../src/testing/frame.js';
import { Screen, screenStream } from '../../src/testing/screen.js';
import { createTestTerminal } from '../../src/testing/terminal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `frame()`, which is how a test reads the screen a key left.
 *
 * A frame is drawn on the renderer's clock, so the screen lags a key by a tick of
 * it -- and the first frame is the same, which an `onMount` runs after. Every
 * app here is given a `frameMs` of a minute, so that a test which passes only
 * because the clock happened to fire in time cannot: the renderer would not have
 * painted by itself inside the test's lifetime, and anything on screen is there
 * because `frame()` put it there.
 */

const MINUTE = 60_000;
const apps: App[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const app of apps.splice(0)) {
    app.exit();
    await app.exited;
  }
});

/** An app over a test terminal that would not paint by itself within the test. */
function start(component: () => Element) {
  const term = createTestTerminal({ columns: 30, rows: 6 });
  const app = runApp(component, { detect: false, frameMs: MINUTE, terminal: term.terminal });
  apps.push(app);
  return { app, term };
}

describe('frame()', () => {
  it('should paint the first frame, which a key pressed before it would miss', async () => {
    // `onMount` runs after the first paint, so this is what a key finds when it
    // is pressed too soon: the tree as it was built, before anything the mount
    // set up -- a focused row among them -- is there
    const mounted = new State(false);
    const { app, term } = start(() => {
      onMount(() => void mounted.set(true));
      return ui`<text>${() => (mounted.get() ? 'mounted' : 'building')}</text>`;
    });

    expect(term.viewport[0]).toBe('building');
    await frame(app);

    expect(term.viewport[0]).toBe('mounted');
  });

  it('should show what a key did, where the clock would have made it wait a frame', async () => {
    const pressed = new State(0);
    const { app, term } = start(() => {
      useApp().input?.bind('x', () => pressed.set(pressed.get() + 1));
      return ui`<text>${() => `${pressed.get()} presses`}</text>`;
    });
    await frame(app);
    expect(term.viewport[0]).toBe('0 presses');

    await term.press('x', 'x');
    // the keys have landed and the screen has not moved: this is the lag
    expect(term.viewport[0], 'the screen moved without a frame').toBe('0 presses');

    await frame(app);
    expect(term.viewport[0]).toBe('2 presses');
  });

  it('should settle a renderer from render() as well as an app', async () => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    const count = new State(1);
    const view = render(() => ui`<text>${() => `n=${count.get()}`}</text>`, {
      frameMs: MINUTE,
      terminal: term.terminal,
    });

    await frame(view);
    count.set(2);
    await frame(view);

    expect(term.viewport[0]).toBe('n=2');
    view.dispose();
  });

  it('should do nothing for an app that has gone, rather than throw', async () => {
    const { app } = start(() => text('x'));
    await frame(app);
    app.exit();
    await app.exited;

    await expect(frame(app)).resolves.toBeUndefined();
  });

  it('should do nothing for an app that refused to start, whose view throws when read', async () => {
    const term = createTestTerminal({ isTTY: false });
    const app = runApp(() => text('x'), { onError: () => {}, terminal: term.terminal });

    expect(app.interactive).toBe(false);
    await expect(frame(app)).resolves.toBeUndefined();
  });
});

describe('the colour level of a test terminal', () => {
  const SHEET = 'box { color: gray } @media (color-level: 3) { box { color: cyan } }';

  /** The colour the root resolved to: gray (8) below level 3, cyan (6) at it. */
  function resolved(over: Parameters<typeof render>[1], colorLevel?: 0 | 1 | 2 | 3): number {
    const term = createTestTerminal({ colorLevel });
    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      { cascade: new Cascade([parseStylesheet(SHEET)]), terminal: term.terminal, ...over }
    );
    view.frame();
    const color = root?.style.color as number;
    view.dispose();
    return color;
  }

  it('should reach render() without being said a second time', () => {
    expect(resolved({}, 3)).toBe(6);
    expect(resolved({}, 1)).toBe(8);
  });

  it('should be beaten by a colorLevel named on render()', () => {
    expect(resolved({ colorLevel: 1 }, 3)).toBe(8);
    expect(resolved({ colorLevel: 3 }, 0)).toBe(6);
  });

  it('should leave a terminal that names none to the environment, as it always did', () => {
    // a real terminal does not claim a level, and the renderer asks the
    // environment -- so the carried level changes nothing for anything that is
    // not a fixture
    const stream = screenStream(new Screen(30, 6));
    const real = createTerminal({
      env: {},
      isTTY: true,
      proc: { listenerCount: () => 0, on: () => {}, removeListener: () => {} },
      stderr: stream as unknown as OutputStream,
      stdin: undefined,
      stdout: stream as unknown as OutputStream,
    });
    expect(real.colorLevel).toBeUndefined();

    vi.stubEnv('FORCE_COLOR', '3');
    expect(resolved({ terminal: real })).toBe(6);
    vi.stubEnv('FORCE_COLOR', '1');
    expect(resolved({ terminal: real })).toBe(8);
  });

  it('should reach runApp() too', () => {
    const term = createTestTerminal({ colorLevel: 3 });
    let root: Element | undefined;
    const app = runApp(
      () => {
        root = box({}, text('x'));
        return root;
      },
      { detect: false, sheets: [SHEET], terminal: term.terminal }
    );
    app.view.frame();

    expect(root?.style.color).toBe(6);
    app.exit();
  });
});
