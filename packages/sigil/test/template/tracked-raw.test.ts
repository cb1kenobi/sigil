/**
 * A `<raw tracked>` is a `trackedRaw()`, in every frontend (SIG-485).
 *
 * SIG-477 made a `raw` repaint when a signal its paint read changes, and a
 * template still built a plain one -- so an app written in templates went on
 * pairing every `<raw>` with an effect calling `invalidatePaint()`. Every case
 * here changes **only** the signal the paint reads, and asks the next frame what
 * is on screen: the frame is the thing a plain `raw` does not repaint for, so
 * `renderToString()` could not tell the two apart and is not used.
 *
 * The compiled path is held against these in `packages/cli/test/emitters.test.ts`.
 */

import { createCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import { createRoot, render } from '../../src/renderer/index.js';
import { createEffects, sinkCount, State } from '../../src/signals/index.js';
import { ui } from '../../src/template/index.js';
import { jsx } from '../../src/template/runtime.js';
import type { Terminal } from '../../src/terminal/index.js';
import { describe, expect, it } from 'vitest';

/** A backend over a canvas, with a count of what it painted. */
function harness(width = 10, height = 1) {
  const canvas = createCanvas({ height, width });
  let painted = 0;
  const terminal = {
    height: 24,
    onResize: () => () => {},
    restore() {},
    width,
  } as unknown as Terminal;
  const backend = {
    active: true,
    canvas,
    done() {},
    get height() {
      return canvas.height;
    },
    isLive: true,
    present() {},
    render(draw: (painter: never) => void) {
      painted++;
      canvas.paint(draw as never);
    },
    resize(w: number, h: number) {
      canvas.resize(w, h);
    },
    stop() {},
    terminal,
    get width() {
      return canvas.width;
    },
    write() {},
  };
  return {
    backend: backend as never,
    get painted() {
      return painted;
    },
    picture() {
      return canvas
        .toString()
        .split('\n')
        .map((row) => row.padEnd(canvas.width, ' ').replaceAll(' ', '.'))
        .join('\n');
    },
    terminal,
  };
}

/** One way to write the same `<raw>`, given the signal its paint reads. */
interface Frontend {
  /** Builds it as `<raw tracked>`, or as a plain `<raw>` when `tracked` is false. */
  build(word: State<string>, tracked: boolean): Element;
  name: string;
}

const measure = () => ({ height: 1, width: 10 });

const frontends: Frontend[] = [
  {
    build: (word, tracked) => {
      const paint = (painter: { text(x: number, y: number, s: string): void }, at: never) => {
        const { x, y } = at as { x: number; y: number };
        painter.text(x, y, word.get());
      };
      return tracked
        ? ui`<raw tracked measure=${measure} paint=${paint} height="1" width="10" />`
        : ui`<raw measure=${measure} paint=${paint} height="1" width="10" />`;
    },
    name: 'the ui tag',
  },
  {
    build: (word, tracked) => {
      const paint = (painter: { text(x: number, y: number, s: string): void }, at: never) => {
        const { x, y } = at as { x: number; y: number };
        painter.text(x, y, word.get());
      };
      return jsx('raw', { height: 1, measure, paint, tracked, width: 10 });
    },
    name: 'JSX',
  },
];

describe.each(frontends)('a <raw tracked> in $name', ({ build }) => {
  it('should repaint when only a signal its paint read has changed', () => {
    const h = harness();
    const word = new State('before');
    const effects = createEffects();
    const view = render(() => box({}, build(word, true)), {
      backend: h.backend,
      effects,
      terminal: h.terminal,
    });
    expect(h.picture()).toBe('before....');

    // nothing but the one signal: no text, no prop, no effect beside the raw
    word.set('after');
    view.frame();

    expect(h.picture()).toBe('after.....');
    view.dispose();
  });

  it('should leave a plain <raw> plain, which is what tracking costs a frame for', () => {
    // the same template without the flag: if it repainted, `tracked` would be
    // doing nothing, and every plain raw would be paying for it
    const h = harness();
    const word = new State('before');
    const view = render(() => box({}, build(word, false)), {
      backend: h.backend,
      effects: createEffects(),
      terminal: h.terminal,
    });

    word.set('after');
    view.frame();

    expect(h.picture()).toBe('before....');
    view.dispose();
  });

  it('should stop listening when the owner it was built under goes', () => {
    const word = new State('x');
    const h = harness();
    createRoot((dispose) => {
      const element = build(word, true);
      render(() => element, {
        backend: h.backend,
        effects: createEffects(),
        terminal: h.terminal,
      }).frame();
      expect(sinkCount(word)).toBeGreaterThan(0);
      dispose();
    });
    expect(sinkCount(word)).toBe(0);
  });
});

describe('the measure of a <raw tracked>', () => {
  // SIG-486 follows the measure too, and the template flag is the same one
  type Paint = (painter: { text(x: number, y: number, s: string): void }, at: never) => void;
  const fill: Paint = (painter, at) => {
    const { width, x, y } = at as { width: number; x: number; y: number };
    painter.text(x, y, '#'.repeat(width));
  };

  it.each([
    [
      'the ui tag',
      (size: State<number>) =>
        ui`<raw tracked measure=${() => ({ height: 1, width: size.get() })} paint=${fill} />`,
    ],
    [
      'JSX',
      (size: State<number>) =>
        jsx('raw', {
          measure: () => ({ height: 1, width: size.get() }),
          paint: fill,
          tracked: true,
        }),
    ],
  ])('should lay out again when only a signal its measure read has changed: %s', (_, make) => {
    const h = harness();
    const size = new State(2);
    const view = render(() => box({}, make(size), text('x')), {
      backend: h.backend,
      effects: createEffects(),
      terminal: h.terminal,
    });
    expect(h.picture()).toBe('##x.......');

    size.set(4);
    view.frame();

    expect(h.picture()).toBe('####x.....');
    view.dispose();
  });
});

describe('what `tracked` may be', () => {
  const paint = () => {};

  it('should be a plain raw for `tracked=${false}`, so a variable can decide', () => {
    const word = new State('before');
    const h = harness();
    const element = ui`<raw tracked=${false} measure=${measure} paint=${(
      painter: { text(x: number, y: number, s: string): void },
      at: { x: number; y: number }
    ) => painter.text(at.x, at.y, word.get())} />`;
    const view = render(() => box({}, element), {
      backend: h.backend,
      effects: createEffects(),
      terminal: h.terminal,
    });
    word.set('after');
    view.frame();
    expect(h.picture()).toBe('before....');
    view.dispose();
  });

  it('should not leave `tracked` behind as a prop on the element', () => {
    const element = ui`<raw tracked measure=${measure} paint=${paint} />`;
    expect(element.props).not.toHaveProperty('tracked');
  });

  it('should refuse a string, which no one would agree the meaning of', () => {
    expect(() => ui`<raw tracked="false" measure=${measure} paint=${paint} />`).toThrow(
      /<raw tracked> is a flag/
    );
  });

  it('should refuse a function, which would look like it follows a signal', () => {
    expect(() => ui`<raw tracked=${() => true} measure=${measure} paint=${paint} />`).toThrow(
      /<raw tracked> is a flag/
    );
    expect(() => jsx('raw', { measure, paint, tracked: () => true })).toThrow(
      /<raw tracked> is a flag/
    );
    expect(() => jsx('raw', { measure, paint, tracked: 'false' })).toThrow(
      /<raw tracked> is a flag/
    );
    expect(() => jsx('raw', { measure, paint, tracked: null })).toThrow(/<raw tracked> is a flag/);
  });
});

describe('a prop a <raw> does not take (SIG-599)', () => {
  const paint = () => {};

  // a misspelled `tracked` was not read as `tracked`, and the cascade refused it
  // only on the first frame, as a style error -- so the template built a plain
  // raw and the app lost the tracking it had asked for
  it.each([
    [
      'the ui tag, capitalized',
      () => ui`<raw Tracked measure=${measure} paint=${paint} />`,
      /<raw> has no prop `Tracked`: write `tracked`/,
    ],
    [
      'the ui tag, misspelled',
      () => ui`<raw trackd measure=${measure} paint=${paint} />`,
      /<raw> has no prop `trackd`/,
    ],
    [
      'JSX, capitalized',
      () => jsx('raw', { Tracked: true, measure, paint }),
      /<raw> has no prop `Tracked`: write `tracked`/,
    ],
    [
      'JSX, misspelled',
      () => jsx('raw', { measure, paint, trackd: true }),
      /<raw> has no prop `trackd`/,
    ],
    [
      'a dash inside an option',
      () => ui`<raw track-ed measure=${measure} paint=${paint} />`,
      /write `tracked`/,
    ],
    [
      'a near miss for a handler, which keeps its own sentence',
      () => ui`<raw onkey=${() => {}} measure=${measure} paint=${paint} />`,
      /not a handler name: write `onKey`/,
    ],
  ])('should be refused when built, naming it: %s', (_, build, message) => {
    expect(build).toThrow(message);
  });

  it('should still take everything a raw takes', () => {
    const element = ui`<raw tracked class="a" id="x" key="k" tabindex="0" focusable
      onKey=${() => {}} ref=${() => {}} width="3" background-color="red" padding="1"
      measure=${measure} paint=${paint} />`;
    expect(element.type).toBe('raw');
    expect(() =>
      jsx('raw', { backgroundColor: 'red', class: 'a', measure, onKey: () => {}, paint, width: 3 })
    ).not.toThrow();
  });
});
