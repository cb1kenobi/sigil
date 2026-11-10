import { strip } from '../../src/ansi/index.js';
import { box, type Element, renderToLines, renderToString } from '../../src/element/index.js';
import { createInput, type DescribeOptions, type MouseEvent } from '../../src/input/index.js';
import { flush } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';

/**
 * A form for the form controls' tests: the controls in a column under a root that
 * records every key that reaches it, and a real router over a test terminal.
 *
 * Through a real router rather than by calling `onKey` by hand, because most of
 * what these controls promise is about the router's order -- which keys a control
 * claims and which go on to the form, whether Tab reaches it, and whether a
 * disabled one is skipped -- and a handler called by hand is in none of it.
 */

export const ESC: string = String.fromCharCode(0x1b);

export interface Form {
  /** The router. */
  input: ReturnType<typeof createInput>;
  /** Presses keys, then lets the effects they caused run. */
  press(...keys: string[]): Promise<void>;
  /** The form's own column. */
  root: Element;
  /** Every key that reached the form, by name: what no control claimed. */
  seen: string[];
  /** Takes the router off. */
  stop(): void;
}

const stops: Array<() => void> = [];

/** Stops every router a test made, for an `afterEach`. */
export function stopForms(): void {
  for (const stop of stops.splice(0)) {
    stop();
  }
}

/**
 * Puts controls in a form.
 *
 * @param controls - What to put in it, top to bottom.
 * @returns The form.
 */
export function form(...controls: Element[]): Form {
  const term = createTestTerminal({ columns: 40, rows: 12 });
  const seen: string[] = [];
  const root = box({ 'flex-direction': 'column', height: 12, width: 40 }, ...controls);
  root.onKey = (event) => {
    seen.push(event.key.name);
  };
  const input = createInput({ root, terminal: term.terminal });
  const stop = (): void => input.stop();
  stops.push(stop);
  return {
    input,
    async press(...keys: string[]): Promise<void> {
      await term.press(...keys);
      flush();
    },
    root,
    seen,
    stop,
  };
}

/** A control or a form as a reader sees it at colour level 0, right edges and blank rows trimmed. */
export function picture(element: Element, width = 40): string[] {
  const lines = renderToLines(element, { cascade: themedCascade(), colorLevel: 0, width }).map(
    (line) => strip(line).trimEnd()
  );
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

/** A control at colour level 1, where the roles are SGR. */
export function colored(element: Element, width = 40): string {
  return renderToString(element, { cascade: themedCascade(), colorLevel: 1, width });
}

/** A mouse report as the router builds one, with a record of whether it was stopped. */
export function mouse(
  kind: MouseEvent['kind'] = 'click',
  button: MouseEvent['button'] = 'left'
): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button,
    claimed: () => stopped,
    ctrl: false,
    current: undefined,
    kind,
    meta: false,
    shift: false,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
    wheel: kind === 'wheel' ? 'down' : undefined,
    x: 0,
    y: 0,
  };
}

/** A click on an element, bubbled up from it as the router does, then the effects run. */
export function clickOn(
  element: Element,
  kind: MouseEvent['kind'] = 'click',
  button: MouseEvent['button'] = 'left'
): MouseEvent & { claimed: () => boolean } {
  const event = mouse(kind, button);
  for (let at: Element | undefined = element; at && !event.stopped; at = at.parent) {
    at.onMouse?.(event);
  }
  flush();
  return event;
}

/** One description a {@link recorder} was given. */
export interface Described {
  keys: string;
  opts: DescribeOptions;
}

/** A router that records what it was told, for the `describe*()` helpers. */
export function recorder(): {
  live: Described[];
  router: { describe(keys: string, opts: DescribeOptions): () => void };
} {
  const live: Described[] = [];
  const router = {
    describe(keys: string, opts: DescribeOptions): () => void {
      const entry = { keys, opts };
      live.push(entry);
      return () => void live.splice(live.indexOf(entry), 1);
    },
  };
  return { live, router };
}

/** The first element at or under `root` wearing a class. */
export function part(root: Element, name: string): Element {
  const walk = (at: Element): Element | undefined =>
    at.classes.includes(name)
      ? at
      : at.children.reduce<Element | undefined>((hit, child) => hit ?? walk(child), undefined);
  const found = walk(root);
  if (!found) {
    throw new Error(`no ${name}`);
  }
  return found;
}
