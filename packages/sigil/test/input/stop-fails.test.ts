import { arrange, box, type Element, resolveStyles } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import {
  DISABLE_MOUSE_MOTION,
  DISABLE_MOUSE_SGR,
  DISABLE_PASTE,
} from '../../src/terminal/sequences.js';
import { describe, expect, it } from 'vitest';

/**
 * A router torn down over a terminal whose write fails (SIG-699).
 *
 * `stop()` is a run of steps -- the paste's end, raw mode, the bracketed-paste
 * reset, the mouse reset, the hover states, the stream's failure -- and a write
 * that threw on a closed stream skipped every step after it. The stream error
 * `stop()` was about to report was lost with them.
 */

const ESC = String.fromCharCode(0x1b);

interface Harness {
  /** Every chunk that reached the stream, including the ones that threw. */
  out: string[];
  raw: () => boolean;
  stdin: { destroyed?: boolean; errored?: Error | null };
  terminal: Terminal;
}

/** A terminal whose stdout throws for the chunks `fails()` names. */
function harness(fails: (chunk: string) => boolean): Harness {
  const out: string[] = [];
  let raw = false;
  const stdin = {
    destroyed: undefined as boolean | undefined,
    errored: undefined as Error | null | undefined,
    isTTY: true,
    off() {
      return this;
    },
    on() {
      return this;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
    setEncoding() {
      return this;
    },
    setRawMode(mode: boolean) {
      raw = mode;
      return this;
    },
  };
  const terminal = createTerminal({
    env: {},
    isTTY: true,
    proc: { on() {}, pid: 1, removeListener() {} } as never,
    stderr: { isTTY: true, write: () => true } as never,
    stdin: stdin as never,
    stdout: {
      isTTY: true,
      write(chunk: string) {
        out.push(chunk);
        if (fails(chunk)) {
          throw new Error(`write failed: ${JSON.stringify(chunk)}`);
        }
        return true;
      },
    } as never,
  });
  return { out, raw: () => raw, stdin, terminal };
}

/** A canvas that knows where it sits, which is all a mouse router asks of one. */
const surface = {
  height: 4,
  async locate() {
    return true;
  },
  origin: { x: 0, y: 0 },
  toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
  width: 4,
};

describe("a router's stop() over a terminal whose write fails", () => {
  it('should reset the mouse, clear the hover states and report the stream, after the paste reset fails', () => {
    const { out, raw, stdin, terminal } = harness((chunk) => chunk.includes(DISABLE_PASTE));
    const hovered: Element = box({ height: 2, id: 'hovered', width: 2 });
    const root = box({ height: 4, id: 'root', width: 4 }, hovered);
    resolveStyles(root);
    arrange(root, { height: 4, width: 4 });
    const input = createInput({ mouse: { motion: true, surface }, root, terminal });
    const told: unknown[] = [];
    input.onEnd((error) => void told.push(error));

    // the pointer is over `hovered`, and the stream failed in the turn before
    input.feed(`${ESC}[<35;1;1M`);
    expect(hovered.states).toEqual(['hover']);
    const failure = new Error('stream destroyed');
    stdin.destroyed = true;
    stdin.errored = failure;

    let thrown: unknown;
    try {
      input.stop();
    } catch (error) {
      thrown = error;
    }

    // what failed is raised, once, and as itself
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('write failed');
    expect((thrown as Error).message).toContain('2004l');
    // and nothing after it was skipped
    expect(raw()).toBe(false);
    const written = out.join('');
    expect(written).toContain(DISABLE_MOUSE_MOTION);
    expect(written).toContain(DISABLE_MOUSE_SGR);
    expect(written.indexOf(DISABLE_PASTE)).toBeLessThan(written.indexOf(DISABLE_MOUSE_SGR));
    expect(hovered.states).toEqual([]);
    expect(input.hovered).toBeUndefined();
    expect(told).toEqual([failure]);
  });

  it('should raise every write that failed, as an AggregateError, with each step still run', () => {
    const { raw, terminal } = harness(
      (chunk) => chunk.includes(DISABLE_PASTE) || chunk.includes(DISABLE_MOUSE_MOTION)
    );
    const input = createInput({ mouse: { motion: true, surface }, terminal });

    let thrown: unknown;
    try {
      input.stop();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect(raw()).toBe(false);
  });

  it('should raise both a failed write and a throwing onEnd handler, flat and once each', () => {
    const { stdin, terminal } = harness((chunk) => chunk.includes(DISABLE_PASTE));
    const input = createInput({ terminal });
    const handler = new Error('onEnd broke');
    input.onEnd(() => {
      throw handler;
    });
    stdin.destroyed = true;
    stdin.errored = new Error('stream destroyed');

    let thrown: unknown;
    try {
      input.stop();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors as Error[];
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain('write failed');
    expect(errors[1]).toBe(handler);
  });

  it('should still stop only once, and say nothing the second time', () => {
    const { terminal } = harness((chunk) => chunk.includes(DISABLE_PASTE));
    const input = createInput({ terminal });

    expect(() => input.stop()).toThrow('write failed');
    expect(() => input.stop()).not.toThrow();
  });
});
