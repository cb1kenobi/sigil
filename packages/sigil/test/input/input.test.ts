import { box, type Element, resolveStyles, text } from '../../src/element/index.js';
import { createInput, InputError, type KeyEvent } from '../../src/input/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The key router and the focus ring.
 *
 * Driven by feeding bytes rather than by a real keyboard: what a terminal sends
 * is a string, and `decodeKeys()` is already tested against the shapes of one.
 * What is new here is where a decoded key *goes*.
 */

interface Harness {
	feed: (chunk: string) => void;
	out: string[];
	terminal: Terminal;
}

/** A terminal whose stdin is a TTY nothing is typing on. */
function harness(): Harness {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const out: string[] = [];

	const stdin = {
		isTTY: true,
		off(event: string, fn: (...args: unknown[]) => void) {
			listeners.get(event)?.delete(fn);
			return this;
		},
		on(event: string, fn: (...args: unknown[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(fn);
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
		setRawMode() {
			return this;
		},
	};

	const terminal = createTerminal({
		env: {},
		isTTY: true,
		proc: { on() {}, pid: 1, removeListener() {} } as never,
		stdin: stdin as never,
		stdout: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
	});

	return {
		feed(chunk: string) {
			for (const fn of listeners.get('data') ?? []) {
				fn(chunk);
			}
		},
		out,
		terminal,
	};
}

/** A tree of three focusable boxes inside a container that watches them. */
function tree(): { first: Element; root: Element; second: Element; third: Element } {
	const first = box({ focusable: true }, text('one'));
	const second = box({ focusable: true }, text('two'));
	const third = box({ focusable: true }, text('three'));
	const root = box({}, first, second, third);
	return { first, root, second, third };
}

describe('the router', () => {
	it('should refuse to exist where there is nobody to type', () => {
		// `PromptError`'s rule generalized: a prompt with nobody to answer it fails
		// loudly rather than hanging, and a router exists to read keys
		const terminal = createTerminal({
			env: {},
			isTTY: false,
			proc: { on() {}, pid: 1, removeListener() {} } as never,
			stdin: undefined,
			stdout: { write: () => true } as never,
		});

		expect(() => createInput({ terminal })).toThrow(InputError);
	});

	it('should give a key to a binding before anything focused', () => {
		// an app that cannot be quit because a focused input swallowed Ctrl-C is
		// the failure this order exists to prevent
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = () => seen.push('element');
		input.bind((event) => {
			seen.push('binding');
			if (event.key.ctrl && event.key.name === 'c') {
				event.stop();
			}
		});

		feed('a');
		expect(seen).toEqual(['binding', 'element']);

		seen.length = 0;
		feed('');
		expect(seen).toEqual(['binding']);

		input.stop();
	});

	it('should bubble from the focused element up to the root', () => {
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = () => seen.push('first');
		root.onKey = () => seen.push('root');

		feed('x');
		expect(seen).toEqual(['first', 'root']);
		input.stop();
	});

	it('should let a handler stop the event before its ancestors see it', () => {
		// without this a text input's Left is also the list's "previous item", and
		// the only thing that can know the key was meant for the input is the input
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event: KeyEvent) => {
			seen.push('first');
			event.stop();
		};
		root.onKey = () => seen.push('root');

		feed('[D');
		expect(seen).toEqual(['first']);
		input.stop();
	});

	it('should say which element it is asking as the event climbs', () => {
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const asked: (Element | undefined)[] = [];

		input.focus.focus(first);
		first.onKey = (event) => asked.push(event.current);
		root.onKey = (event) => {
			asked.push(event.current);
			expect(event.target).toBe(first);
		};

		feed('x');
		expect(asked).toEqual([first, root]);
		input.stop();
	});

	it('should hold a sequence that arrives split and read it whole', () => {
		// ssh, a pty under load, and a small read buffer all split a chunk, and
		// `ESC [` then `A` decodes as an unknown sequence and a literal `A`
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const names: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => names.push(event.key.name);

		feed('[');
		expect(names).toEqual([]);
		feed('A');
		expect(names).toEqual(['up']);
		input.stop();
	});

	it("should carry the terminal's other event", () => {
		// the thing that owns stdin owns the other event a terminal produces, so an
		// app subscribes in one place for the two halves of one frame. What a
		// resize *means* -- re-evaluate the media queries, re-lay out, repaint whole
		// rather than diff against a grid that described a different screen -- is
		// the renderer's, and is deliberately not decided here
		const { terminal } = harness();
		const input = createInput({ root: box({}), terminal });
		const sizes: { height: number; width: number }[] = [];

		const off = input.onResize((size) => sizes.push(size));
		expect(typeof off).toBe('function');
		input.stop();
	});

	it('should put the stream and the modes back on stop', () => {
		const { out, terminal } = harness();
		const input = createInput({ root: box({}), terminal });

		expect(out.join('')).toContain('[?2004h');
		input.stop();
		expect(out.join('')).toContain('[?2004l');
	});
});

describe('focus', () => {
	it('should move along the ring and wrap', () => {
		const { feed, terminal } = harness();
		const { first, root, second, third } = tree();
		const input = createInput({ root, terminal });

		expect(input.focus.ring()).toEqual([first, second, third]);

		feed('\t');
		expect(input.focus.current.get()).toBe(first);
		feed('\t');
		expect(input.focus.current.get()).toBe(second);
		feed('\t\t');
		expect(input.focus.current.get()).toBe(first);

		// Shift-Tab is `ESC [ Z`, which the decoder names `tab` with shift
		feed('[Z');
		expect(input.focus.current.get()).toBe(third);
		input.stop();
	});

	it('should let a component keep Tab by stopping the event', () => {
		// Tab is the default rather than the first thing tried, so a completion or
		// a grid cell keeps it
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });

		input.focus.focus(first);
		first.onKey = (event) => {
			if (event.key.name === 'tab') {
				event.stop();
			}
		};

		feed('\t');
		expect(input.focus.current.get()).toBe(first);
		input.stop();
	});

	it('should set the state a selector matches', () => {
		// which is what makes an input that highlights when focused zero lines of
		// component code
		const { terminal } = harness();
		const { first, root, second } = tree();
		const input = createInput({ root, terminal });

		input.focus.focus(first);
		expect(first.states).toContain('focus');

		input.focus.focus(second);
		expect(first.states).not.toContain('focus');
		expect(second.states).toContain('focus');
		input.stop();
	});

	it('should follow the tree rather than a list it kept', () => {
		const { terminal } = harness();
		const { first, root, second } = tree();
		const input = createInput({ root, terminal });

		const added = box({ focusable: true });
		root.insertBefore(added, second);
		expect(input.focus.ring()[1]).toBe(added);

		first.remove();
		expect(input.focus.ring()[0]).toBe(added);
		input.stop();
	});

	it('should honour a tabindex over document order', () => {
		const { terminal } = harness();
		const last = box({ focusable: true, tabindex: 2 });
		const early = box({ focusable: true, tabindex: 1 });
		const root = box({}, last, early);
		const input = createInput({ root, terminal });

		expect(input.focus.ring()).toEqual([early, last]);
		input.stop();
	});

	it('should skip a subtree that is not displayed', () => {
		// there is nothing on screen to move the focus to. Read off the *resolved*
		// style rather than the prop, because `display` can come from a sheet --
		// which is why the ring is asked after a resolve, exactly as a frame does
		const { terminal } = harness();
		const hidden = box({ display: 'none' }, box({ focusable: true }));
		const shown = box({ focusable: true });
		const root = box({}, hidden, shown);
		resolveStyles(root);
		const input = createInput({ root, terminal });

		expect(input.focus.ring()).toEqual([shown]);
		input.stop();
	});

	it('should hand focus on when the element holding it is unmounted', () => {
		// dropping it into nothing reads as an app that stopped responding: every
		// key then goes to the bindings and nowhere else
		const { feed, terminal } = harness();
		const { root, second, third } = tree();
		const input = createInput({ root, terminal });

		input.focus.focus(second);
		second.remove();

		feed('x');
		expect(input.focus.current.get()).toBe(third);
		input.stop();
	});
});

describe('paste', () => {
	it('should arrive whole rather than as a burst of keys', () => {
		// a newline in the middle of a pasted address is content, and a text input
		// that read it as Enter would submit half of it
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const pasted: string[] = [];
		const names: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => names.push(event.key.name);
		input.onPaste((event) => {
			pasted.push(event.text);
			event.stop();
		});

		feed('[200~one\ntwo[201~');
		expect(pasted).toEqual(['one\ntwo']);
		expect(names).toEqual([]);
		input.stop();
	});

	it('should hold a paste that arrives in pieces', () => {
		const { feed, terminal } = harness();
		const input = createInput({ root: box({}), terminal });
		const pasted: string[] = [];

		input.onPaste((event) => {
			pasted.push(event.text);
			event.stop();
		});

		feed('[200~one');
		feed(' and two');
		expect(pasted).toEqual([]);
		feed('[201~');
		expect(pasted).toEqual(['one and two']);
		input.stop();
	});

	it('should type it in when nobody wanted it whole', () => {
		// which is what a terminal that cannot bracket a paste sends anyway
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const names: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => names.push(event.key.name);

		feed('[200~ab[201~');
		expect(names).toEqual(['a', 'b']);
		input.stop();
	});

	it('should mark a typed-in paste as one', () => {
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const flags: boolean[] = [];

		input.focus.focus(first);
		first.onKey = (event) => flags.push(event.paste);

		feed('a');
		feed('[200~b[201~');
		expect(flags).toEqual([false, true]);
		input.stop();
	});

	it('should keep the keys either side of a paste', () => {
		const { feed, terminal } = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal });
		const names: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => names.push(event.key.name);
		input.onPaste((event) => event.stop());

		feed('a[200~xyz[201~b');
		expect(names).toEqual(['a', 'b']);
		input.stop();
	});
});
