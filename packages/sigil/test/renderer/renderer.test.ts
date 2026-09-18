import { createCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import {
	createContext,
	createEffect,
	createRoot,
	For,
	getOwner,
	onCleanup,
	onMount,
	provideContext,
	render,
	runWithOwner,
	Show,
	useContext,
} from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { State } from '../../src/signals/index.js';
import { Cascade, parseStylesheet } from '../../src/style/index.js';
import type { Terminal } from '../../src/terminal/index.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The renderer.
 *
 * Driven by `frame()` rather than by the clock: the pacing is a `setTimeout` and
 * a test that waits for one is a test that is slow and flaky in equal measure.
 * What the pacing itself promises is asserted separately, by counting frames.
 */

/** A backend over a canvas, with no terminal and a count of what it painted. */
function harness(width = 20, height = 4) {
	const canvas = createCanvas({ height, width });
	const out: string[] = [];
	let painted = 0;
	let presented = 0;

	const resizeListeners = new Set<(size: { height: number; width: number }) => void>();
	const terminal = {
		height: 24,
		onResize(fn: (size: { height: number; width: number }) => void) {
			resizeListeners.add(fn);
			return () => resizeListeners.delete(fn);
		},
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
		present() {
			presented++;
		},
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
		write(line: string) {
			out.push(line);
		},
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
		get presented() {
			return presented;
		},
		resize(w: number, h: number) {
			(terminal as { width: number }).width = w;
			(terminal as { height: number }).height = h;
			for (const fn of resizeListeners) {
				fn({ height: h, width: w });
			}
		},
		terminal,
	};
}

/** Each test gets its own effect scope, so one never inherits another's. */
let effects = createEffects();
beforeEach(() => {
	effects = createEffects();
});

describe('mounting', () => {
	it('should run a component body exactly once, however much it re-renders', () => {
		// the whole reason signals came first: there is no re-render, so the body is
		// not a function of state that runs again -- the effects inside it are
		const h = harness();
		const count = new State(0);
		let bodies = 0;
		let runs = 0;

		const view = render(
			() => {
				bodies++;
				const label = text('');
				createEffect(() => {
					runs++;
					label.setText(`n=${count.get()}`);
				});
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(bodies).toBe(1);
		expect(runs).toBe(1);

		count.set(1);
		view.frame();
		count.set(2);
		view.frame();

		expect(bodies).toBe(1);
		expect(runs).toBe(3);
		expect(h.picture().split('\n')[0]).toBe('n=2.................');
		view.dispose();
	});

	it('should have painted before it returns', () => {
		// a `render()` that comes back with a timer pending and nothing on screen is
		// one every caller has to follow with a wait it cannot name
		const h = harness();
		const view = render(() => box({}, text('hi')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});

		expect(h.painted).toBe(1);
		expect(h.picture().split('\n')[0]).toBe('hi..................');
		view.dispose();
	});

	it('should paint nothing for a frame with nothing to do', () => {
		// nothing dirty means no frame, and the half of that this can see is that a
		// frame which happens anyway does no work
		const h = harness();
		const view = render(() => box({}, text('hi')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});

		expect(h.painted).toBe(1);
		view.frame();
		view.frame();
		expect(h.painted).toBe(1);
		view.dispose();
	});

	it('should coalesce a burst of writes into one frame', () => {
		// which is what the pacing is for: a terminal over ssh cannot absorb a
		// repaint per signal write, and thirty of them here are one frame
		const h = harness();
		const count = new State(0);

		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					label.setText(`n=${count.get()}`);
				});
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		for (let i = 1; i <= 30; i++) {
			count.set(i);
		}
		view.frame();

		expect(h.painted).toBe(2);
		expect(h.picture().split('\n')[0]).toBe('n=30................');
		view.dispose();
	});

	it('should repaint for a mutation no signal made', () => {
		// the tree records it, and what the tree records asks for a frame -- without
		// which an imperative edit from a key handler is invisible until something
		// else happens to draw
		const h = harness();
		let label: Element | undefined;
		const view = render(
			() => {
				label = text('one');
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		label?.setText('two');
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('two.................');
		view.dispose();
	});
});

describe('the cascade', () => {
	it('should re-resolve what a state change made match', () => {
		// the join that did not exist: a restyler kept across frames re-resolves
		// only what it was told about, so without the bridge the sheet matched once
		// and the frame was never asked again
		const h = harness();
		const focused = new State(false);
		const sheet = parseStylesheet(`
			.field { color: gray }
			.field:focus { color: cyan }
		`);

		let field: Element | undefined;
		const view = render(
			() => {
				field = box({ class: 'field' }, text('x'));
				createEffect(() => {
					field?.setState('focus', focused.get());
				});
				return box({}, field);
			},
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			}
		);

		expect(field?.style.color).toBe(8);
		focused.set(true);
		view.frame();
		expect(field?.style.color).toBe(6);
		view.dispose();
	});

	it('should re-match everything when the terminal resized', () => {
		// a rule inside a width media query may now apply or may now not, and which
		// elements those are is exactly what a full re-match answers
		const h = harness(20, 4);
		const sheet = parseStylesheet(`
			box { color: gray }
			@media (min-width: 30) { box { color: cyan } }
		`);

		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			}
		);

		expect(root?.style.color).toBe(8);
		h.resize(40, 24);
		view.frame();
		expect(root?.style.color).toBe(6);
		view.dispose();
	});
});

describe('lifecycle', () => {
	it('should dispose every effect a component created', () => {
		// a long-running CLI that skips this leaks a watcher per mount, and nothing
		// above can see them to clean up
		const h = harness();
		const count = new State(0);
		let runs = 0;

		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					runs++;
					label.setText(String(count.get()));
				});
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(runs).toBe(1);
		view.dispose();

		count.set(1);
		effects.flush();
		expect(runs).toBe(1);
	});

	it('should run cleanups innermost first and in reverse', () => {
		// the order things were built in, undone: a child's cleanup may read what
		// the parent's is about to tear down
		const order: string[] = [];
		createRoot((dispose) => {
			onCleanup(() => order.push('outer-a'));
			onCleanup(() => order.push('outer-b'));
			createEffect(() => {
				onCleanup(() => order.push('inner'));
			});
			dispose();
		}, effects.effect);

		expect(order).toEqual(['inner', 'outer-b', 'outer-a']);
	});

	it('should run every cleanup even when one throws', () => {
		// what is left behind by a teardown that stopped half way is a subscription
		// nobody can reach to cancel
		const ran: string[] = [];
		expect(() =>
			createRoot((dispose) => {
				onCleanup(() => ran.push('first'));
				onCleanup(() => {
					throw new Error('nope');
				});
				onCleanup(() => ran.push('last'));
				dispose();
			}, effects.effect)
		).toThrow('nope');

		expect(ran).toEqual(['last', 'first']);
	});

	it('should run onMount once the element has a box', () => {
		// after a frame rather than at the end of the body, because the useful thing
		// to do here is read where the component landed, and during the body there
		// is no answer
		const h = harness();
		const seen: (number | undefined)[] = [];

		const view = render(
			() => {
				const root = box({ height: '2', width: '5' }, text('x'));
				onMount(() => seen.push(root.box?.width));
				return root;
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(seen).toEqual([5]);
		view.frame();
		expect(seen).toEqual([5]);
		view.dispose();
	});

	it('should let a detached callback borrow an owner', () => {
		// a key handler or a settling promise has no owner of its own, and creating
		// an effect from one would otherwise never be disposed
		const h = harness();
		const count = new State(0);
		let runs = 0;
		let owner: ReturnType<typeof getOwner>;

		const view = render(
			() => {
				owner = getOwner();
				return box({}, text('x'));
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		runWithOwner(owner, () => {
			createEffect(() => {
				runs++;
				count.get();
			});
		});
		expect(runs).toBe(1);

		view.dispose();
		count.set(1);
		effects.flush();
		expect(runs).toBe(1);
	});
});

describe('context', () => {
	it('should read the nearest provided value', () => {
		const theme = createContext('plain');
		let inner = '';
		let outer = '';

		createRoot((dispose) => {
			outer = useContext(theme);
			provideContext(theme, 'dark', () => {
				inner = useContext(theme);
			});
			dispose();
		}, effects.effect);

		expect(outer).toBe('plain');
		expect(inner).toBe('dark');
	});

	it('should be readable from inside an effect body', () => {
		// the body runs with the creating owner current, so `useContext()` means
		// inside it what it meant outside
		const theme = createContext('plain');
		let seen = '';

		createRoot((dispose) => {
			provideContext(theme, 'dark', () => {
				createEffect(() => {
					seen = useContext(theme);
				});
			});
			dispose();
		}, effects.effect);

		expect(seen).toBe('dark');
	});
});

describe('Show', () => {
	it('should mount and dispose a branch as the condition turns', () => {
		const h = harness();
		const on = new State(false);
		const events: string[] = [];

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							onCleanup(() => events.push('gone'));
							events.push('built');
							return text('yes');
						},
						fallback: () => text('no'),
						when: () => on.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(h.picture().split('\n')[0]).toBe('no..................');
		expect(events).toEqual([]);

		on.set(true);
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('yes.................');
		expect(events).toEqual(['built']);

		on.set(false);
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('no..................');
		expect(events).toEqual(['built', 'gone']);
		view.dispose();
	});

	it('should not rebuild a branch while presence did not change', () => {
		// a `when` that reads a counter would otherwise tear its branch down and
		// build it again on every tick, losing whatever state the branch held
		const h = harness();
		const count = new State(1);
		let builds = 0;

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							builds++;
							return text('on');
						},
						when: () => count.get() > 0,
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(builds).toBe(1);
		count.set(2);
		view.frame();
		count.set(3);
		view.frame();
		expect(builds).toBe(1);
		view.dispose();
	});
});

describe('For', () => {
	it('should keep a row that moved rather than rebuilding it', () => {
		// keyed by identity: position keying rebuilds every row after the first
		// change, which for a terminal means the focus ring moves under whoever was
		// typing
		const h = harness();
		const a = { name: 'a' };
		const b = { name: 'b' };
		const items = new State<readonly { name: string }[]>([a, b]);
		const built: string[] = [];
		const made = new Map<{ name: string }, Element>();

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item) => {
							built.push(item.name);
							const element = text(item.name);
							made.set(item, element);
							return element;
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(built).toEqual(['a', 'b']);
		const firstA = made.get(a);

		items.set([b, a]);
		view.frame();

		expect(built).toEqual(['a', 'b']);
		expect(made.get(a)).toBe(firstA);
		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'b...................',
			'a...................',
		]);
		view.dispose();
	});

	it('should dispose a row that left', () => {
		const h = harness();
		const a = { n: 1 };
		const b = { n: 2 };
		const items = new State<readonly { n: number }[]>([a, b]);
		const gone: number[] = [];

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item) => {
							onCleanup(() => gone.push(item.n));
							return text(String(item.n));
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		items.set([a]);
		view.frame();
		expect(gone).toEqual([2]);
		view.dispose();
	});

	it('should give a moved row its new index', () => {
		// an accessor rather than a number, because the row that moved is the same
		// row and rebuilding it to tell it where it sits throws away what keying
		// exists to keep
		const h = harness();
		const a = { n: 'a' };
		const b = { n: 'b' };
		const items = new State<readonly { n: string }[]>([a, b]);

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item, index) => {
							const label = text('');
							createEffect(() => {
								label.setText(`${index()}${item.n}`);
							});
							return label;
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'0a..................',
			'1b..................',
		]);

		items.set([b, a]);
		view.frame();
		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'0b..................',
			'1a..................',
		]);
		view.dispose();
	});

	it('should hold two rows for an item that appears twice', () => {
		// two equal primitives in a list are a list with two entries in it, not a
		// bug to refuse
		const h = harness();
		const items = new State<readonly string[]>(['x', 'x', 'y']);
		let builds = 0;

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item) => {
							builds++;
							return text(item);
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(builds).toBe(3);
		expect(h.picture().split('\n').slice(0, 3)).toEqual([
			'x...................',
			'x...................',
			'y...................',
		]);
		view.dispose();
	});

	it('should show a fallback while the list is empty', () => {
		const h = harness();
		const items = new State<readonly string[]>([]);

		const view = render(
			() =>
				box(
					{},
					For({
						children: (item) => text(item),
						each: () => items.get(),
						fallback: () => text('empty'),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(h.picture().split('\n')[0]).toBe('empty...............');
		items.set(['a']);
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('a...................');
		view.dispose();
	});
});

describe('errors', () => {
	it('should put the terminal back before reporting', () => {
		// a CLI that dies on the alternate buffer with the cursor hidden has eaten
		// the user's shell, and a message printed into a half-drawn frame is
		// unreadable anyway
		const h = harness();
		const order: string[] = [];
		const seen: unknown[] = [];
		(h.terminal as unknown as { restore: () => void }).restore = () => order.push('restored');

		const count = new State(0);
		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					if (count.get() > 0) {
						throw new Error('boom');
					}
					label.setText('ok');
				});
				return box({}, label);
			},
			{
				backend: h.backend,
				effects,
				onError(error) {
					order.push('reported');
					seen.push(error);
				},
				terminal: h.terminal,
			}
		);

		count.set(1);
		view.frame();

		expect(order).toEqual(['restored', 'reported']);
		expect((seen[0] as Error).message).toBe('boom');
		expect(view.mounted).toBe(false);
	});

	it('should stop rather than throwing the same frame away forever', () => {
		const h = harness();
		let reports = 0;
		const count = new State(0);

		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					if (count.get() > 0) {
						throw new Error('boom');
					}
					label.setText('ok');
				});
				return box({}, label);
			},
			{
				backend: h.backend,
				effects,
				onError: () => void reports++,
				terminal: h.terminal,
			}
		);

		count.set(1);
		view.frame();
		view.frame();
		view.frame();
		expect(reports).toBe(1);
	});
});

describe('a frame that failed part way', () => {
	it('should stop the frame it failed in rather than finishing it', () => {
		// an effect that throws is *reported* by the scope's handler rather than
		// thrown through it, so the flush returns normally -- and the rest of the
		// frame would then paint onto a terminal the failure had already given back
		// and drain mount callbacks against an owner whose cleanups had all run
		const h = harness();
		const count = new State(0);
		const mounted: string[] = [];

		const view = render(
			() => {
				const first = text('');
				const second = text('');
				// the first effect gives the frame something to paint, so that a frame
				// which carried on past the failure would be visible as a paint after
				// the screen was handed back
				createEffect(() => {
					first.setText(`n=${count.get()}`);
				});
				createEffect(() => {
					if (count.get() > 0) {
						throw new Error('boom');
					}
					second.setText('ok');
				});
				onMount(() => mounted.push('one'));
				return box({ 'flex-direction': 'column' }, first, second);
			},
			{ backend: h.backend, effects, onError: () => {}, terminal: h.terminal }
		);

		const paintedBefore = h.painted;
		expect(mounted).toEqual(['one']);

		count.set(1);
		view.frame();

		// nothing was drawn after the screen was given back, though the tree had
		// changed and the frame had every reason to draw
		expect(h.painted).toBe(paintedBefore);
		expect(view.mounted).toBe(false);
	});

	it('should hand a throw from the body to its caller rather than reporting it', () => {
		// `render()` is still on the stack, so there is somebody to hand it to, and
		// reporting it as well is the same failure said twice
		const h = harness();
		const reports: unknown[] = [];

		expect(() =>
			render(
				() => {
					throw new Error('during mount');
				},
				{ backend: h.backend, effects, onError: (e) => void reports.push(e), terminal: h.terminal }
			)
		).toThrow('during mount');

		expect(reports).toEqual([]);
	});
});

describe('independence', () => {
	it("should not install its frame loop over another renderer's", () => {
		// a scope holds one scheduler and one error handler, so sharing the module's
		// meant a second `render()` stopped the first painting, and an effect that
		// threw in either tore down whichever had installed last
		const a = harness();
		const b = harness();
		const one = new State(0);
		const two = new State(0);

		const first = render(
			() => {
				const label = text('');
				createEffect(() => {
					label.setText(`a=${one.get()}`);
				});
				return box({}, label);
			},
			{ backend: a.backend, terminal: a.terminal }
		);
		const second = render(
			() => {
				const label = text('');
				createEffect(() => {
					label.setText(`b=${two.get()}`);
				});
				return box({}, label);
			},
			{ backend: b.backend, terminal: b.terminal }
		);

		one.set(1);
		two.set(1);
		first.frame();
		second.frame();

		expect(a.picture().split('\n')[0]).toBe('a=1.................');
		expect(b.picture().split('\n')[0]).toBe('b=1.................');

		// and disposing one leaves the other painting
		first.dispose();
		two.set(2);
		second.frame();
		expect(b.picture().split('\n')[0]).toBe('b=2.................');
		second.dispose();
	});

	it('should fail the renderer whose effect threw, and only that one', () => {
		// a shared scope holds one error handler, so a throw in either tore down
		// whichever had installed last -- restoring the terminal out from under the
		// one that was still running
		const a = harness();
		const b = harness();
		const boom = new State(0);
		const restored: string[] = [];
		(a.terminal as unknown as { restore: () => void }).restore = () => restored.push('a');
		(b.terminal as unknown as { restore: () => void }).restore = () => restored.push('b');

		const first = render(
			() => {
				const label = text('');
				createEffect(() => {
					if (boom.get() > 0) {
						throw new Error('boom');
					}
					label.setText('a');
				});
				return box({}, label);
			},
			{ backend: a.backend, onError: () => {}, terminal: a.terminal }
		);
		const second = render(() => box({}, text('b')), {
			backend: b.backend,
			onError: () => {},
			terminal: b.terminal,
		});

		boom.set(1);
		first.frame();

		expect(first.mounted).toBe(false);
		expect(second.mounted).toBe(true);
		expect(restored).toEqual(['a']);
		second.dispose();
	});
});

describe('a builder that throws', () => {
	it('should leave Show able to try again', () => {
		// presence is committed after the branch exists. Committed first, an effect
		// caches what it threw and goes clean -- so the next truthy `when()` matched
		// the recorded presence, returned early, and the host stayed empty for good
		const which = new State(0);
		let explode = true;
		const thrown: unknown[] = [];
		effects.setErrorHandler((error) => void thrown.push(error));

		let host: Element | undefined;
		createRoot(() => {
			host = Show({
				children: (n) => {
					if (explode) {
						throw new Error('nope');
					}
					return text(`v${n}`);
				},
				when: () => which.get() || false,
			});
		}, effects.effect);

		which.set(1);
		effects.flush();
		expect((thrown[0] as Error).message).toBe('nope');
		expect(host?.children.length).toBe(0);

		// a different truthy value: presence did not change, so only a `showing`
		// that was never committed lets this build
		explode = false;
		which.set(2);
		effects.flush();
		expect(host?.children[0]?.text).toBe('v2');
	});

	it('should leave For describing what is still on screen', () => {
		// the rows built before the throw were owned by nothing -- `rows` never took
		// them, and an effect caches what it threw, so the next reconcile started
		// from the stale list and those branches ran for the life of the `For`
		const a = { n: 'a' };
		const bad = { n: 'bad' };
		const items = new State<readonly { n: string }[]>([a]);
		let live = 0;
		const thrown: unknown[] = [];
		effects.setErrorHandler((error) => void thrown.push(error));

		createRoot(() => {
			For({
				children: (item) => {
					if (item === bad) {
						throw new Error('nope');
					}
					live++;
					onCleanup(() => live--);
					return text(item.n);
				},
				each: () => items.get(),
			});
		}, effects.effect);

		expect(live).toBe(1);

		// `bad` is second, so the row before it is built and then has to be undone
		items.set([{ n: 'c' }, bad]);
		effects.flush();
		expect((thrown[0] as Error).message).toBe('nope');
		expect(live).toBe(1);

		// and the next reconcile starts from what is still there rather than from a
		// list holding a row nothing owns
		items.set([a]);
		effects.flush();
		expect(live).toBe(1);
	});
});

describe('unmounting', () => {
	it('should let the restyler forget a subtree that left', () => {
		// `Restyler` keys its caches by element identity, so a panel shown and
		// hidden for an hour leaves an entry per node per mount with nothing to
		// point at
		const h = harness();
		const on = new State(true);
		let gone: Element | undefined;

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							gone = box({ class: 'x' }, text('here'));
							return gone;
						},
						when: () => on.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(gone?.tree).toBeDefined();
		expect(view.restyler.styleOf(gone as Element)).toBeDefined();

		on.set(false);
		view.frame();

		// detached, and the frame that saw it leave is what told the restyler --
		// which keys by element identity and would otherwise hold every node of
		// every branch ever shown, for the life of the renderer
		expect(gone?.tree).toBeUndefined();
		expect(view.restyler.styleOf(gone as Element)).toBeUndefined();
		expect(view.restyler.styleOf(gone?.children[0] as Element)).toBeUndefined();
		view.dispose();
	});

	it('should keep the style of a row that only moved', () => {
		// a move is a removal and an insertion, so forgetting everything that was
		// removed would throw away the style of every row a `For` reordered
		const h = harness();
		const a = { n: 'a' };
		const b = { n: 'b' };
		const items = new State<readonly { n: string }[]>([a, b]);
		const sheet = parseStylesheet(`.row { color: cyan }`);
		const made = new Map<{ n: string }, Element>();

		const view = render(
			() =>
				box(
					{},
					For({
						children: (item) => {
							const element = box({ class: 'row' }, text(item.n));
							made.set(item, element);
							return element;
						},
						each: () => items.get(),
						props: { 'flex-direction': 'column' },
					})
				),
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			}
		);

		expect(made.get(a)?.style.color).toBe(6);
		items.set([b, a]);
		view.frame();
		expect(made.get(a)?.style.color).toBe(6);
		expect(made.get(a)?.tree).toBeDefined();
		view.dispose();
	});

	it('should refuse to start anything new under a disposed owner', () => {
		// a key handler or a promise landing after unmount is exactly what
		// `runWithOwner()` is for, and exactly where the answer is to do nothing:
		// there is no component left to keep up to date and nothing that would
		// ever dispose the effect
		const h = harness();
		const count = new State(0);
		let runs = 0;
		let owner: ReturnType<typeof getOwner>;

		const view = render(
			() => {
				owner = getOwner();
				return box({}, text('x'));
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		view.dispose();
		runWithOwner(owner, () => {
			createEffect(() => {
				runs++;
				count.get();
			});
		});

		expect(runs).toBe(0);
		count.set(1);
		effects.flush();
		expect(runs).toBe(0);
	});

	it('should run a cleanup registered after disposal rather than keeping it', () => {
		const ran: string[] = [];
		let owner: ReturnType<typeof getOwner>;
		createRoot((dispose) => {
			owner = getOwner();
			dispose();
		}, effects.effect);

		runWithOwner(owner, () => onCleanup(() => ran.push('now')));
		expect(ran).toEqual(['now']);
	});

	it('should report what a branch cleanup threw rather than dropping it', () => {
		// `Show` and `For` are not in a position to do anything with a cleanup's
		// throw, and dropping it is how an unmount that failed to unsubscribe
		// something becomes silent
		const h = harness();
		const on = new State(true);
		const reports: unknown[] = [];

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							onCleanup(() => {
								throw new Error('unsubscribe failed');
							});
							return text('here');
						},
						when: () => on.get(),
					})
				),
			{
				backend: h.backend,
				effects,
				onError: (error) => void reports.push(error),
				terminal: h.terminal,
			}
		);

		on.set(false);
		view.frame();

		expect((reports[0] as Error).message).toBe('unsubscribe failed');
		expect(view.mounted).toBe(true);
		view.dispose();
	});

	it('should report an onMount throw and stay mounted', () => {
		// a mount callback is not the frame: it runs after one, its throw says
		// nothing about whether the screen is right, and tearing the app down over
		// it would be a worse answer than saying so
		const h = harness();
		const reports: unknown[] = [];

		const view = render(
			() => {
				onMount(() => {
					throw new Error('mount hook');
				});
				return box({}, text('x'));
			},
			{
				backend: h.backend,
				effects,
				onError: (error) => void reports.push(error),
				terminal: h.terminal,
			}
		);

		expect((reports[0] as Error).message).toBe('mount hook');
		expect(view.mounted).toBe(true);
		view.dispose();
	});
});
